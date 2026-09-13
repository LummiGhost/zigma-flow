/**
 * Runtime metrics journal (Issue #286 Phase 2).
 *
 * One record per agent-backend invocation that reached a terminal outcome,
 * appended to runs/<id>/metrics.jsonl. Phase 3 aggregates history by scanning
 * run dirs (precedent: src/commands/list-runs.ts scans per-run state.json).
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import type { CostClass } from "../agent/model-router.js";
import { AsyncQueue } from "../run/asyncQueue.js";

export type MetricsStatus = "completed" | "failed" | "timed_out" | "cancelled";

export interface MetricsRecord {
  /** ISO 8601, same clock as events. */
  timestamp: string;
  run_id: string;
  /** Workflow name (wf.name). */
  workflow: string;
  job: string;
  step: string;
  attempt: number;
  /** stepDef.uses skill id (e.g. "zigma/analyze-skill"). Omitted when the step has no uses. */
  skill?: string;
  /** Resolved backend name (backend.name). */
  backend: string;
  /** Actually-selected model (backend.model). Omitted when the backend carries none. */
  model?: string;
  /**
   * Static economics class of the routed profile (low|medium|high; omitted = "high").
   * Omitted entirely when routing did not select a profile.
   */
  cost_class?: CostClass;
  /** result.durationMs ?? 0. */
  duration_ms: number;
  status: MetricsStatus;
  /** classifyFailureKind(errorType) for failed; "cancelled"/"timeout" on those paths. */
  failure_kind?: string;
  /** Exit code only when the failure path carries one. */
  exit_code?: number;
  /** True only when agent_report_accepted was emitted for this invocation. */
  report_accepted: boolean;
  /** id of this execution's agent_invoked event (join-back key). */
  invocation_id: string;
}

const metricsQueues = new Map<string, AsyncQueue>();

function getMetricsQueue(runDir: string): AsyncQueue {
  let queue = metricsQueues.get(runDir);
  if (!queue) {
    queue = new AsyncQueue();
    metricsQueues.set(runDir, queue);
  }
  return queue;
}

/** Append one metrics record, serialized per-runDir (AD-P14-003 pattern). */
export async function appendMetricsRecord(runDir: string, record: MetricsRecord): Promise<void> {
  return getMetricsQueue(runDir).run(async () => {
    await appendFile(join(runDir, "metrics.jsonl"), JSON.stringify(record) + "\n", "utf-8");
  });
}

/** Wait for all metrics appends currently queued for a run. */
export async function drainMetricsWrites(runDir: string): Promise<void> {
  await metricsQueues.get(runDir)?.drain();
}

/** Drain and release the per-run metrics queue. */
export async function disposeMetricsWriter(runDir: string): Promise<void> {
  const queue = metricsQueues.get(runDir);
  if (queue === undefined) return;
  try {
    await queue.drain();
  } finally {
    if (metricsQueues.get(runDir) === queue) {
      metricsQueues.delete(runDir);
    }
  }
}
