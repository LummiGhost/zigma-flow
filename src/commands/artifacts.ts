/**
 * artifacts command action handler.
 *
 * Reads artifacts.jsonl from a run directory and prints each artifact
 * in a human-readable tabular format.
 *
 * Format: <id>  <kind>  <path>  <size bytes>
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

export interface ArtifactsOptions {
  runDir?: string;      // absolute path to run dir, OR:
  runsDir?: string;     // absolute path to runs dir
  runId?: string;       // optional — latest if omitted
  latest?: boolean;     // explicit --latest flag (no deprecation warning)
  job?: string;         // --job <id> filter: only show artifacts produced by this job
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// artifactsAction
// ---------------------------------------------------------------------------

/**
 * CLI action: reads artifacts.jsonl from the resolved run directory and
 * prints all artifacts (optionally filtered by job) to stdout.
 */
export async function artifactsAction(opts: ArtifactsOptions): Promise<void> {
  const print = opts.stdout ?? ((line: string) => { console.log(line); });
  const printErr = opts.stderr ?? ((line: string) => { console.error(line); });

  // Deprecation warning: implicit run fallback without --run or --latest
  if (opts.runDir === undefined && opts.runId === undefined && opts.latest !== true) {
    console.warn("[DEPRECATED] Implicit run fallback to latest. Use --run <run-id> or --latest. This will be removed in v1.0.");
  }

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

  // Read artifacts.jsonl — treat missing file as empty index.
  const artifactsPath = join(runDir, "artifacts.jsonl");
  let rawText: string;
  try {
    rawText = await readFile(artifactsPath, "utf-8");
  } catch {
    // Missing artifacts.jsonl is treated as an empty index (exit 0).
    void printErr;
    return;
  }

  // Parse lines.
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (const line of lines) {
    let artifact: {
      id?: unknown;
      kind?: unknown;
      path?: unknown;
      size?: unknown;
      producer?: { job?: unknown; step?: unknown; attempt?: unknown };
    };
    try {
      artifact = JSON.parse(line) as typeof artifact;
    } catch {
      // Skip malformed lines.
      continue;
    }

    // Apply job filter if specified.
    if (opts.job !== undefined) {
      const producerJob = artifact.producer?.job;
      if (producerJob !== opts.job) {
        continue;
      }
    }

    const id = String(artifact.id ?? "");
    const kind = String(artifact.kind ?? "");
    const path = String(artifact.path ?? "");
    const size = String(artifact.size ?? "");

    print(`${id}  ${kind}  ${path}  ${size}`);
  }
}
