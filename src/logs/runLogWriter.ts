/**
 * RunLogWriter — thread-safe append-only writer for run.log.jsonl.
 *
 * Each write is serialized through a per-runDir AsyncQueue so concurrent
 * jobs writing to the same run log do not interleave or corrupt records.
 *
 * Reference: Issue #280.
 */

import { appendFile, mkdir } from "node:fs/promises";

import { AsyncQueue } from "../run/asyncQueue.js";
import type { RunLogStream } from "./types.js";

// ---------------------------------------------------------------------------
// Per-runDir writer instances — module-level singleton map
// ---------------------------------------------------------------------------

const writers = new Map<string, RunLogWriter>();

// ---------------------------------------------------------------------------
// RunLogWriter
// ---------------------------------------------------------------------------

export class RunLogWriter {
  private readonly queue = new AsyncQueue();
  private counter = 0;
  private readonly runDir: string;
  private readonly runId: string;
  private readonly logPath: string;

  private constructor(runDir: string, runId: string) {
    this.runDir = runDir;
    this.runId = runId;
    this.logPath = `${runDir}/run.log.jsonl`;
  }

  /** Get or create the singleton writer for a given run directory. */
  static forRun(runDir: string, runId: string): RunLogWriter {
    let writer = writers.get(runDir);
    if (writer === undefined) {
      writer = new RunLogWriter(runDir, runId);
      writers.set(runDir, writer);
    }
    return writer;
  }

  /** Drain pending writes, then remove the singleton writer. */
  static async dispose(runDir: string): Promise<void> {
    const writer = writers.get(runDir);
    if (writer === undefined) return;
    await writer.drain();
    if (writers.get(runDir) === writer) {
      writers.delete(runDir);
    }
  }

  /** Current counter value (last written id). */
  get lastId(): number {
    return this.counter;
  }

  /** Wait until all writes queued so far have settled. */
  async drain(): Promise<void> {
    await this.queue.drain();
  }

  /**
   * Append a log record to run.log.jsonl.
   *
   * The record is serialized as a single NDJSON line. Writes are queued
   * per-runDir to guarantee atomic append order.
   *
   * @returns The assigned record id.
   */
  async write(entry: {
    job_id?: string | null;
    step_id?: string | null;
    attempt?: number | null;
    stream: RunLogStream;
    text: string;
  }): Promise<number> {
    return this.queue.run(async () => {
      // Ensure the run directory exists (it may be created lazily by
      // createRun, which itself creates the run dir before the first
      // call to WriteSystem).
      await mkdir(this.runDir, { recursive: true });
      this.counter += 1;
      const id = this.counter;
      const record = {
        id,
        occurred_at: new Date().toISOString(),
        run_id: this.runId,
        job_id: entry.job_id ?? null,
        step_id: entry.step_id ?? null,
        attempt: entry.attempt ?? null,
        stream: entry.stream,
        text: entry.text,
      };
      await appendFile(this.logPath, JSON.stringify(record) + "\n", "utf-8");
      return id;
    });
  }

  /** Convenience: write a system-level progress message. */
  async writeSystem(text: string, opts?: {
    job_id?: string;
    step_id?: string;
    attempt?: number;
  }): Promise<number> {
    return this.write({
      stream: "system",
      text,
      ...opts,
    });
  }
}
