/**
 * `zigma-flow logs` command handler.
 *
 * Read-only command to view historical log records and follow new ones for
 * a workflow run. Designed for observing runs started by another process
 * (e.g. a background invoke). The --follow mode is a passive observer:
 * it does NOT hold the Engine lock, advance state, or affect execution.
 *
 * Reference: Issue #280 — invoke real-time log forwarding and resumable log tracking.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { RunLogReader } from "../logs/runLogReader.js";
import type { RunLogRecord } from "../logs/types.js";
import { FilesystemError, UserInputError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// LogsOptions
// ---------------------------------------------------------------------------

export interface LogsOptions {
  /** Absolute path to .zigma-flow/runs/ directory. */
  runsDir: string;
  /** Specific run ID to view logs for. */
  run?: string;
  /** Use the most recently created run. */
  latest?: boolean;
  /** Filter to a specific job. */
  job?: string;
  /** Filter to a specific step (requires --job). */
  step?: string;
  /** Keep following new records until the run terminates. */
  follow?: boolean;
  /** Interval in ms for polling new records in follow mode (default 250). */
  pollMs?: number;
  /** Injectable stdout function for testing. */
  stdout?: (line: string) => void;
  /** Injectable stderr function for testing. */
  stderr?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Internal: resolveRunDir
// ---------------------------------------------------------------------------

async function resolveRunDir(runsDir: string, runId?: string, latest?: boolean): Promise<{ runDir: string; runId: string }> {
  if (runId !== undefined) {
    const runDir = join(runsDir, runId);
    try {
      await readdir(runDir);
    } catch {
      throw new FilesystemError(`Run not found: ${runId}`, {
        details: { runId, runsDir },
      });
    }
    return { runDir, runId };
  }

  if (latest) {
    let entries: string[];
    try {
      entries = await readdir(runsDir);
    } catch {
      throw new FilesystemError(`Cannot read runs directory: ${runsDir}`);
    }

    const dirs: string[] = [];
    for (const entry of entries) {
      try {
        await stat(join(runsDir, entry));
        dirs.push(entry);
      } catch {
        // Not a directory
      }
    }

    if (dirs.length === 0) {
      throw new UserInputError("No runs found. Run a workflow first with 'zigma-flow invoke'.");
    }

    dirs.sort((a, b) => b.localeCompare(a));
    const latestId = dirs[0]!;
    return { runDir: join(runsDir, latestId), runId: latestId };
  }

  throw new UserInputError(
    "Either --run <run-id> or --latest is required.",
    { suggestion: "Usage: zigma-flow logs --run <run-id> [--follow]" },
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatStreamPrefix(record: RunLogRecord): string {
  if (record.stream === "system") return "[system]";
  const parts: string[] = [];
  if (record.job_id) parts.push(`job=${record.job_id}`);
  if (record.step_id) parts.push(`step=${record.step_id}`);
  if (record.attempt) parts.push(`attempt=${record.attempt}`);
  const suffix = parts.length > 0 ? ` ${parts.join(" ")}` : "";
  if (record.stream === "stdout") return `[stdout${suffix}]`;
  if (record.stream === "stderr") return `[stderr${suffix}]`;
  return `[${record.stream}${suffix}]`;
}

function toLocalTime(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// logsAction
// ---------------------------------------------------------------------------

export async function logsAction(options: LogsOptions): Promise<void> {
  const print = options.stdout ?? ((line: string) => { console.log(line); });
  const printErr = options.stderr ?? ((line: string) => { console.error(line); });

  // ── Validate step filter requires job filter ──────────────────────────────

  if (options.step !== undefined && options.job === undefined) {
    throw new UserInputError(
      "--step filter requires --job to be specified.",
      { suggestion: "Usage: zigma-flow logs --run <id> --job <job-id> --step <step-id> --follow" },
    );
  }

  // ── Resolve run directory ─────────────────────────────────────────────────

  const { runDir, runId } = await resolveRunDir(options.runsDir, options.run, options.latest);

  // ── Create reader ─────────────────────────────────────────────────────────

  const reader = new RunLogReader({
    runDir,
    runId,
    ...(options.job !== undefined ? { jobId: options.job } : {}),
    ...(options.step !== undefined ? { stepId: options.step } : {}),
  });

  // ── Follow mode ───────────────────────────────────────────────────────────

  if (options.follow) {
    printErr(`Following logs for run ${runId}... (Ctrl-C to stop observing)`);

    // Forward SIGINT handling: let the process exit on Ctrl-C
    let aborted = false;
    const onSigint = (): void => {
      aborted = true;
    };
    process.on("SIGINT", onSigint);

    const signal = {
      get aborted() { return aborted; },
    };

    try {
      await reader.follow(
        (record) => {
          if (record.stream === "system") {
            const time = toLocalTime(record.occurred_at);
            printErr(`${time} ${record.text}`);
          } else {
            // Forward stdout/stderr without extra prefix decoration
            // to preserve the raw output format
            print(record.text);
          }
        },
        {
          signal: signal as AbortSignal,
          pollMs: options.pollMs ?? 250,
          onTerminal: (status) => {
            printErr(`\nRun ${runId} entered terminal state: ${status}. Exiting.`);
          },
        },
      );
    } finally {
      process.off("SIGINT", onSigint);
    }

    return;
  }

  // ── One-shot read mode ──────────────────────────────────────────────────

  const result = await reader.readNext();

  if (result.records.length === 0) {
    printErr(`No log records yet for run ${runId}.`);
    return;
  }

  for (const record of result.records) {
    const time = toLocalTime(record.occurred_at);

    if (record.stream === "system") {
      printErr(`${time} ${record.text}`);
    } else {
      const prefix = formatStreamPrefix(record);
      print(`${time} ${prefix} ${record.text}`);
    }
  }
}
