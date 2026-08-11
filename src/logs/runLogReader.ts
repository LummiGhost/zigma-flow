/**
 * RunLogReader — poll-based reader for run.log.jsonl.
 *
 * Supports:
 *   - Reading historical records from a given byte offset.
 *   - Following new records as they are written (--follow).
 *   - Filtering by job and/or step.
 *   - Graceful handling of missing files, empty files, partial last lines,
 *     and concurrent appends.
 *
 * Reference: Issue #280.
 */

import { stat, readFile } from "node:fs/promises";

import type { RunLogRecord } from "./types.js";

// ---------------------------------------------------------------------------
// RunLogReaderOptions
// ---------------------------------------------------------------------------

export interface RunLogReaderOptions {
  /** Absolute path to the run directory. */
  runDir: string;
  /** Run identifier. */
  runId: string;
  /** Byte offset to start reading from (0 = beginning). */
  offset?: number;
  /** Optional filter: only return records matching this job. */
  jobId?: string;
  /** Optional filter: only return records matching this step. */
  stepId?: string;
}

// ---------------------------------------------------------------------------
// Read result
// ---------------------------------------------------------------------------

export interface ReadChunkResult {
  records: RunLogRecord[];
  /** New byte offset for the next read call. */
  offset: number;
  /** True if the end of file was reached (may have more later). */
  reachedEnd: boolean;
}

// ---------------------------------------------------------------------------
// isTerminalStatus
// ---------------------------------------------------------------------------

/** Run statuses that indicate no more log records will be produced. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function isRunTerminal(runStatus: string | undefined): boolean {
  return runStatus !== undefined && TERMINAL_STATUSES.has(runStatus);
}

// ---------------------------------------------------------------------------
// RunLogReader
// ---------------------------------------------------------------------------

export class RunLogReader {
  private readonly runDir: string;
  private readonly logPath: string;
  private readonly filterJob: string | undefined;
  private readonly filterStep: string | undefined;
  private currentOffset: number;

  constructor(opts: RunLogReaderOptions) {
    this.runDir = opts.runDir;
    this.logPath = `${opts.runDir}/run.log.jsonl`;
    this.filterJob = opts.jobId;
    this.filterStep = opts.stepId;
    this.currentOffset = opts.offset ?? 0;
  }

  /** Current byte offset (for resumption tracking). */
  get offset(): number {
    return this.currentOffset;
  }

  /**
   * Read the next batch of log records from the current offset.
   *
   * Handles:
   * - File not created yet (returns empty, keeps offset)
   * - Partial last line (holds offset at start of partial line for next read)
   * - Normal reads (advances offset past complete lines)
   */
  async readNext(): Promise<ReadChunkResult> {
    let fileSize: number;
    try {
      const s = await stat(this.logPath);
      fileSize = s.size;
    } catch {
      // File doesn't exist yet — writer hasn't created it
      return { records: [], offset: this.currentOffset, reachedEnd: true };
    }

    if (fileSize <= this.currentOffset) {
      return { records: [], offset: this.currentOffset, reachedEnd: fileSize === 0 };
    }

    // Read from current offset to end
    const length = fileSize - this.currentOffset;
    let buf: Buffer;
    try {
      const fd = await (await import("node:fs/promises")).open(this.logPath, "r");
      buf = Buffer.alloc(length);
      await fd.read(buf, 0, length, this.currentOffset);
      await fd.close();
    } catch {
      return { records: [], offset: this.currentOffset, reachedEnd: true };
    }

    const text = buf.toString("utf-8");

    // Split into lines; the last line may be partial
    const lines = text.split("\n");
    // If the last line is non-empty and the file ends with a complete line,
    // split produces an empty string at the end. Otherwise, the last element
    // is a partial line.
    const completeLines = text.endsWith("\n") ? lines.slice(0, -1) : lines.slice(0, -1);
    const partialLine = text.endsWith("\n") ? "" : (lines[lines.length - 1] ?? "");

    const records: RunLogRecord[] = [];
    let consumedBytes = 0;

    for (const line of completeLines) {
      consumedBytes += Buffer.byteLength(line + "\n", "utf-8");
      if (line.trim().length === 0) continue;

      let record: RunLogRecord;
      try {
        record = JSON.parse(line) as RunLogRecord;
      } catch {
        // Corrupt record — skip
        continue;
      }

      if (!this.matchesFilter(record)) continue;
      records.push(record);
    }

    // Advance offset past complete lines; partial line stays for next read
    if (partialLine.length > 0) {
      // Don't consume the partial line — it will be re-read next time
      // (when the writer completes it with a newline)
    } else {
      this.currentOffset += consumedBytes;
    }

    return { records, offset: this.currentOffset, reachedEnd: true };
  }

  /**
   * Follow mode: read existing records, then poll for new ones.
   *
   * Continuously calls `readNext()` and invokes `onRecord` for each new
   * record. Stops when:
   *   - The run enters a terminal status (completed/failed/cancelled).
   *   - The `signal` is aborted (e.g. SIGINT).
   *
   * For `awaiting_human` status, following continues (the run may resume).
   *
   * @param onRecord Called for each record as it becomes available.
   * @param options.signal Optional AbortSignal for cancellation.
   * @param options.pollMs Polling interval in ms (default 250).
   * @param options.onTerminal Called when following stops due to terminal state.
   */
  async follow(
    onRecord: (record: RunLogRecord) => void,
    options?: {
      signal?: AbortSignal;
      pollMs?: number;
      onTerminal?: (status: string) => void;
    },
  ): Promise<void> {
    const pollMs = options?.pollMs ?? 250;
    const signal = options?.signal;

    // Exponential backoff for file creation wait
    let missingFileWaitMs = 100;
    const maxMissingFileWaitMs = 2000;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal?.aborted) return;

      // Check run status
      const runStatus = await this.readRunStatus();
      const terminal = isRunTerminal(runStatus);

      const result = await this.readNext();

      for (const record of result.records) {
        onRecord(record);
      }

      if (terminal && result.reachedEnd) {
        options?.onTerminal?.(runStatus ?? "completed");
        return;
      }

      if (result.records.length === 0) {
        // Check if file exists at all
        let fileExists = false;
        try {
          await stat(this.logPath);
          fileExists = true;
        } catch {
          // File not created yet
        }

        if (!fileExists) {
          await this.sleep(Math.min(missingFileWaitMs, maxMissingFileWaitMs));
          missingFileWaitMs = Math.min(missingFileWaitMs * 2, maxMissingFileWaitMs);
        } else {
          missingFileWaitMs = 100; // reset backoff
          await this.sleep(pollMs);
        }

        // Re-check terminal after waiting
        if (terminal) {
          // Drain any last records
          const final = await this.readNext();
          for (const record of final.records) {
            onRecord(record);
          }
          options?.onTerminal?.(runStatus ?? "completed");
          return;
        }
      } else {
        missingFileWaitMs = 100; // reset on progress
        // Don't sleep after getting records — check immediately for more
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private matchesFilter(record: RunLogRecord): boolean {
    if (this.filterJob !== undefined && record.job_id !== this.filterJob) {
      return false;
    }
    if (this.filterStep !== undefined && record.step_id !== this.filterStep) {
      return false;
    }
    return true;
  }

  private async readRunStatus(): Promise<string | undefined> {
    try {
      const statePath = `${this.runDir}/state.json`;
      const raw = await readFile(statePath, "utf-8");
      const state = JSON.parse(raw) as { status?: string };
      return state.status;
    } catch {
      return undefined;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
