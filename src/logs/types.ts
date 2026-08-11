/**
 * RunLog types — the persistent, incrementally-readable run log system.
 *
 * The run log is stored at <runDir>/run.log.jsonl as append-only NDJSON.
 * Each record has a monotonic id, stream classification, and source attribution
 * (run/job/step/attempt). It is separate from the Engine event stream:
 * events own state transitions and audit, the run log owns high-frequency
 * text output (stdout/stderr forwarding and system progress messages).
 *
 * Reference: Issue #280 — invoke real-time log forwarding and resumable log tracking.
 */

export type RunLogStream = "system" | "stdout" | "stderr";

export interface RunLogRecord {
  /** Monotonically increasing record number (1-based). */
  id: number;
  /** ISO 8601 timestamp of when this record was written. */
  occurred_at: string;
  /** Run identifier. */
  run_id: string;
  /** Job identifier (null for run-level system messages). */
  job_id: string | null;
  /** Step identifier (null for job-level or run-level messages). */
  step_id: string | null;
  /** Attempt number (null for run-level messages). */
  attempt: number | null;
  /** Stream classification: system, stdout, or stderr. */
  stream: RunLogStream;
  /** Raw text chunk. */
  text: string;
}
