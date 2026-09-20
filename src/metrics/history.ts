/**
 * Model-history aggregation (Issue #286 Phase 3, extended in Phase 4).
 *
 * Scans every runs/<id>/metrics.jsonl under a runs directory (precedent:
 * src/commands/list-runs.ts scans per-run state.json) and aggregates the
 * Phase 2 metrics records into per-task-class, per-model stats consumed by
 * the router's historical ordering (src/agent/model-router.ts).
 *
 * Phase 4 adds the Accepted Artifact Cost proxy accumulators: each folded
 * record contributes `cost_class_weight × duration_ms` proxy cost units
 * (there are no real token costs in the Phase 2 journal). The weights are
 * documented here and consumed by the router's pure AAC helpers.
 *
 * This module imports only TYPES from the router (the same direction as
 * src/metrics/index.ts) — the router never imports metrics at runtime, and
 * this module never imports engine code.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  CostClass,
  ModelHistoryStats,
  TaskClassHistory,
} from "../agent/model-router.js";

/**
 * Phase 4 proxy unit-price weights: a static economics class stands in for
 * the unknown real price per duration unit (low=1, medium=2, high=4).
 * Records whose `cost_class` is absent or unrecognized default to `high`
 * (4) — the same conservative default as the profile schema.
 */
const COST_CLASS_WEIGHT: Record<CostClass, number> = { low: 1, medium: 2, high: 4 };

/** Proxy cost units one record contributes: weight × duration_ms. */
function recordCostUnits(record: Record<string, unknown>): number {
  const costClass = record["cost_class"];
  const weight =
    costClass === "low" || costClass === "medium" || costClass === "high"
      ? COST_CLASS_WEIGHT[costClass]
      : COST_CLASS_WEIGHT.high;
  const duration =
    typeof record["duration_ms"] === "number" && record["duration_ms"] >= 0
      ? record["duration_ms"]
      : 0;
  return weight * duration;
}

/**
 * Full aggregated history keyed by task-class key (see `makeTaskClassKey`).
 */
export type ModelHistory = ReadonlyMap<string, TaskClassHistory>;

const TASK_CLASS_SEPARATOR = "\u0000";

/**
 * Build the aggregation key for one task class. A task class is the
 * (job id, skill) pair; records whose `skill` is absent are excluded from
 * aggregation entirely (binding decision — Phase 3 task class = job + skill).
 */
export function makeTaskClassKey(jobId: string, skill: string): string {
  return `${jobId}${TASK_CLASS_SEPARATOR}${skill}`;
}

/** Shape gate + fold for one parsed JSONL line. */
function foldRecord(
  map: Map<string, Map<string, ModelHistoryStats>>,
  record: unknown,
): void {
  if (typeof record !== "object" || record === null) return;
  const r = record as Record<string, unknown>;

  // Records without job/skill/model, without a valid attempt number or
  // report_accepted flag, and user-cancelled executions (no model-quality
  // signal) are excluded from both numerator and denominator.
  if (
    typeof r["job"] !== "string" || r["job"].length === 0
    || typeof r["skill"] !== "string" || r["skill"].length === 0
    || typeof r["model"] !== "string" || r["model"].length === 0
    || typeof r["attempt"] !== "number" || !(r["attempt"] >= 1)
    || typeof r["report_accepted"] !== "boolean"
    || r["status"] === "cancelled"
  ) {
    return;
  }

  const classKey = makeTaskClassKey(r["job"], r["skill"]);
  let classMap = map.get(classKey);
  if (classMap === undefined) {
    classMap = new Map();
    map.set(classKey, classMap);
  }

  const prev = classMap.get(r["model"]);
  const stats: ModelHistoryStats = prev ?? {
    samples: 0,
    accepted: 0,
    retried: 0,
    execution_cost: 0,
    retry_overhead: 0,
    rework_overhead: 0,
  };
  stats.samples += 1;
  if (r["report_accepted"]) stats.accepted += 1;
  // Retry evidence: each record whose attempt is a post-first attempt
  // counts once. Per-attempt records carry exact per-model attribution, so
  // no cross-attempt grouping is needed.
  if (r["attempt"] > 1) stats.retried += 1;
  // Phase 4 AAC proxy: every record costs weight × duration_ms. A retried
  // record charges that cost AGAIN as retry overhead (its work forced a
  // re-run), and a rejected report charges it AGAIN as rework overhead
  // (review + redo). The three sums feed deliveredCostUnits/AAC in the
  // router; documented in docs/workflow-language.md §3.11.
  const units = recordCostUnits(r);
  stats.execution_cost = (stats.execution_cost ?? 0) + units;
  if (r["attempt"] > 1) stats.retry_overhead = (stats.retry_overhead ?? 0) + units;
  if (!r["report_accepted"]) stats.rework_overhead = (stats.rework_overhead ?? 0) + units;
  classMap.set(r["model"], stats);
}

/**
 * Aggregate one run dir's metrics.jsonl into `map`. Unreadable files,
 * malformed lines, and malformed records are silently skipped (torn-write
 * tolerance on Windows — the final line may be incomplete mid-append).
 */
async function aggregateRunDir(
  map: Map<string, Map<string, ModelHistoryStats>>,
  metricsPath: string,
): Promise<void> {
  let text: string;
  try {
    text = await readFile(metricsPath, "utf-8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    foldRecord(map, record);
  }
}

/**
 * Scan `runsDir` and aggregate every runs/<id>/metrics.jsonl into a
 * `ModelHistory` keyed by task-class key.
 *
 * TOTAL function: never rejects. A missing runsDir, unreadable entries,
 * missing metrics files, and malformed content are all silently skipped so
 * history IO can never fail routing — the worst case is silent degradation
 * to Phase 1 declaration-order behavior.
 */
export async function loadModelHistory(runsDir: string): Promise<ModelHistory> {
  const map = new Map<string, Map<string, ModelHistoryStats>>();
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return map;
  }
  for (const entry of entries) {
    await aggregateRunDir(map, join(runsDir, entry, "metrics.jsonl"));
  }
  return map;
}

/**
 * One aggregated (job, skill, model) row — the display shape consumed by
 * the `zigma-flow model-history` CLI report (Issue #286 Phase 4, inspect /
 * report acceptance criterion).
 */
export interface TaskClassHistoryRow {
  job: string;
  skill: string;
  model: string;
  stats: ModelHistoryStats;
}

/**
 * Phase 4: the same scan as `loadModelHistory`, flattened into per-(job,
 * skill, model) rows for reporting. Reuses the same aggregation (identical
 * counts and cost units); rows are sorted by (job, skill, model) for
 * deterministic output.
 */
export async function loadModelHistoryRows(
  runsDir: string,
): Promise<TaskClassHistoryRow[]> {
  const history = await loadModelHistory(runsDir);
  const rows: TaskClassHistoryRow[] = [];
  for (const [classKey, classMap] of history) {
    const separatorIndex = classKey.indexOf(TASK_CLASS_SEPARATOR);
    const job = classKey.slice(0, separatorIndex);
    const skill = classKey.slice(separatorIndex + TASK_CLASS_SEPARATOR.length);
    for (const [model, stats] of classMap) {
      rows.push({ job, skill, model, stats });
    }
  }
  rows.sort(
    (a, b) =>
      a.job.localeCompare(b.job)
      || a.skill.localeCompare(b.skill)
      || a.model.localeCompare(b.model),
  );
  return rows;
}

/**
 * Per-run lazy, single-flight history store.
 *
 * Cached after the first load; `get(true)` forces a fresh scan (forced
 * loads are single-flight too). The engine forces on retry attempts
 * (`attempt > 1`) — `appendMetricsRecord` is awaited at every terminal
 * outcome before the next attempt starts, so the re-scan sees the prior
 * attempt's record. Records appended by OTHER concurrent CLI processes
 * after the first scan remain invisible until a forced refresh
 * (documented staleness).
 */
export interface ModelHistoryStore {
  get(force?: boolean): Promise<ModelHistory>;
}

export function createModelHistoryStore(runsDir: string): ModelHistoryStore {
  let cached: ModelHistory | undefined;
  let inFlight: Promise<ModelHistory> | undefined;
  let inFlightForced = false;
  // A slow (stale) load finishing after a newer load must not clobber the
  // newer cache; each load carries the generation it started under.
  let generation = 0;

  async function load(): Promise<ModelHistory> {
    const gen = ++generation;
    const history = await loadModelHistory(runsDir);
    if (gen === generation) {
      cached = history;
      inFlight = undefined;
    }
    return history;
  }

  return {
    get(force = false): Promise<ModelHistory> {
      if (force) {
        if (inFlight !== undefined && inFlightForced) {
          return inFlight;
        }
        const p = load();
        inFlight = p;
        inFlightForced = true;
        return p;
      }
      if (cached !== undefined) {
        return Promise.resolve(cached);
      }
      if (inFlight === undefined) {
        const p = load();
        inFlight = p;
        inFlightForced = false;
      }
      return inFlight;
    },
  };
}
