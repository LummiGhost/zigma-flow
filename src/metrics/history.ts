/**
 * Model-history aggregation (Issue #286 Phase 3).
 *
 * Scans every runs/<id>/metrics.jsonl under a runs directory (precedent:
 * src/commands/list-runs.ts scans per-run state.json) and aggregates the
 * Phase 2 metrics records into per-task-class, per-model stats consumed by
 * the router's historical ordering (src/agent/model-router.ts).
 *
 * This module imports only TYPES from the router (the same direction as
 * src/metrics/index.ts) — the router never imports metrics at runtime, and
 * this module never imports engine code.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ModelHistoryStats,
  TaskClassHistory,
} from "../agent/model-router.js";

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
  };
  stats.samples += 1;
  if (r["report_accepted"]) stats.accepted += 1;
  // Retry evidence: each record whose attempt is a post-first attempt
  // counts once. Per-attempt records carry exact per-model attribution, so
  // no cross-attempt grouping is needed.
  if (r["attempt"] > 1) stats.retried += 1;
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
