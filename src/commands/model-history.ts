/**
 * `zigma-flow model-history` command handler.
 *
 * Issue #286 Phase 4 — the inspect/report acceptance criterion: report
 * per-task-class, per-model acceptance and Accepted Artifact Cost stats
 * aggregated from every runs/<id>/metrics.jsonl under .zigma-flow/runs/.
 *
 * Reuses the same aggregation as the routing history
 * (src/metrics/history.ts `loadModelHistoryRows`) and the same pure AAC
 * helpers as the router (src/agent/model-router.ts), so the figures shown
 * here are exactly the figures routing ordered by.
 */

import { join } from "node:path";

import { acceptedArtifactCost, deliveredCostUnits } from "../agent/model-router.js";
import { loadModelHistoryRows } from "../metrics/history.js";

// ---------------------------------------------------------------------------
// modelHistoryAction options
// ---------------------------------------------------------------------------

export interface ModelHistoryActionOpts {
  /** Project root directory (parent of .zigma-flow/). */
  zigmaflowDir: string;
  /** Machine-readable JSON output. */
  json?: boolean;
  /** Optional stdout function for testing; defaults to console.log. */
  stdout?: (line: string) => void;
}

/** One report row — the public shape of the JSON output contract. */
export interface ModelHistoryReportRow {
  job: string;
  skill: string;
  model: string;
  samples: number;
  accepted: number;
  retried: number;
  /** Proxy cost units (cost_class weight × duration_ms), Σ all records. */
  execution_cost: number;
  /** Proxy cost units over attempt > 1 records. */
  retry_overhead: number;
  /** Proxy cost units over rejected-report records. */
  rework_overhead: number;
  /** execution + retry + rework proxy cost units. */
  delivered_cost: number;
  /** delivered_cost / max(accepted, 1) — expected cost per accepted artifact. */
  aac: number;
}

function toRow(row: {
  job: string;
  skill: string;
  model: string;
  stats: { samples: number; accepted: number; retried: number; execution_cost?: number; retry_overhead?: number; rework_overhead?: number };
}): ModelHistoryReportRow {
  const delivered = deliveredCostUnits(row.stats);
  return {
    job: row.job,
    skill: row.skill,
    model: row.model,
    samples: row.stats.samples,
    accepted: row.stats.accepted,
    retried: row.stats.retried,
    execution_cost: row.stats.execution_cost ?? 0,
    retry_overhead: row.stats.retry_overhead ?? 0,
    rework_overhead: row.stats.rework_overhead ?? 0,
    delivered_cost: delivered,
    aac: acceptedArtifactCost(row.stats),
  };
}

// ---------------------------------------------------------------------------
// modelHistoryAction
// ---------------------------------------------------------------------------

export async function modelHistoryAction(
  opts: ModelHistoryActionOpts,
): Promise<ModelHistoryReportRow[]> {
  const { zigmaflowDir, json = false, stdout = console.log } = opts;

  const runsDir = join(zigmaflowDir, ".zigma-flow", "runs");
  // TOTAL scan: a missing runsDir or malformed content yields no rows —
  // the report degrades to "no data" instead of failing.
  const rows = (await loadModelHistoryRows(runsDir)).map(toRow);

  if (json) {
    stdout(
      JSON.stringify({
        contractVersion: 1,
        command: "model-history",
        rows,
      }),
    );
    return rows;
  }

  if (rows.length === 0) {
    stdout("No metrics history found.");
    return rows;
  }

  let lastClass = "";
  for (const row of rows) {
    const classLabel = `${row.job} / ${row.skill}`;
    if (classLabel !== lastClass) {
      stdout(`Task class: ${row.job} / ${row.skill}`);
      lastClass = classLabel;
    }
    const pct = row.samples === 0 ? 0 : (row.accepted / row.samples) * 100;
    stdout(
      `  ${row.model}  samples=${row.samples}  accepted=${row.accepted} (${pct.toFixed(1)}%)  retried=${row.retried}  aac=${row.aac.toFixed(2)}  delivered-cost=${row.delivered_cost.toFixed(2)}  exec=${row.execution_cost.toFixed(2)}  retry-ovh=${row.retry_overhead.toFixed(2)}  rework-ovh=${row.rework_overhead.toFixed(2)}`,
    );
  }
  stdout("");
  stdout("Cost figures are proxy cost-units (cost_class weight × duration_ms) — no real token costs are recorded.");
  return rows;
}
