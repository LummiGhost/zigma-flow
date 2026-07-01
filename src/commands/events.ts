/**
 * events command action handler.
 *
 * Reads events.jsonl from a run directory and prints the last N events
 * in a human-readable one-line-per-event format.
 *
 * Format: <id>  <timestamp>  <type>  <job>/<step>
 *
 * Reference: docs/phases/v0.2.2-runtime-reliability/workflows/wf-v022-diagnostic/
 * WF-V022-DIAGNOSTIC Step 2.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { FilesystemError, UserInputError } from "../utils/index.js";
import { findRun } from "./status.js";

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface EventsOptions {
  runDir?: string;     // absolute path to run dir, OR:
  runsDir?: string;    // absolute path to runs dir
  runId?: string;      // optional — latest if omitted
  limit?: number;      // default 20
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// eventsAction
// ---------------------------------------------------------------------------

/**
 * CLI action: reads events.jsonl from the resolved run directory and
 * prints the last `limit` events (default 20) to stdout.
 */
export async function eventsAction(opts: EventsOptions): Promise<void> {
  const print = opts.stdout ?? ((line: string) => { console.log(line); });
  const printErr = opts.stderr ?? ((line: string) => { console.error(line); });
  const limit = opts.limit ?? 20;

  // Resolve run directory.
  let runDir: string;
  if (opts.runDir !== undefined) {
    runDir = opts.runDir;
  } else if (opts.runsDir !== undefined) {
    runDir = await findRun(opts.runsDir, opts.runId);
  } else {
    throw new UserInputError("Either runDir or runsDir must be provided.");
  }

  // Verify run directory exists.
  try {
    await stat(runDir);
  } catch (e: unknown) {
    throw new FilesystemError(`Run directory not found: ${runDir}`, { cause: e });
  }

  // Read events.jsonl — treat missing file as empty log.
  const eventsPath = join(runDir, "events.jsonl");
  let rawText: string;
  try {
    rawText = await readFile(eventsPath, "utf-8");
  } catch {
    // Missing events.jsonl is treated as an empty log (exit 0).
    void printErr;
    return;
  }

  // Parse lines.
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Apply limit — take last N.
  const kept = limit === 0 ? [] : lines.slice(-limit);

  // Print each event.
  for (const line of kept) {
    let event: {
      id?: unknown;
      timestamp?: unknown;
      type?: unknown;
      job?: unknown;
      step?: unknown;
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      // Skip malformed lines.
      continue;
    }

    const id = String(event.id ?? "");
    const timestamp = String(event.timestamp ?? "");
    const type = String(event.type ?? "");
    const job = event.job != null ? String(event.job) : "-";
    const step = event.step != null ? String(event.step) : "-";

    print(`${id}  ${timestamp}  ${type}  ${job}/${step}`);
  }
}
