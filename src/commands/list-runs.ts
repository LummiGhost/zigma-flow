/**
 * `zigma-flow list-runs` command handler.
 *
 * Scans .zigma-flow/runs/ and prints one row per run with run_id, workflow,
 * status, and created_at — sorted by created_at descending. Corrupted runs
 * are marked [unreadable].
 *
 * Reference:
 *   - docs/phases/p9p10-cli-admin-commands/workflows/wf-cli-commands/
 *   - docs/prd.md §17
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// listRunsAction options
// ---------------------------------------------------------------------------

export interface ListRunsActionOpts {
  /** Project root directory (parent of .zigma-flow/). */
  zigmaflowDir: string;
  /** Optional stdout function for testing; defaults to console.log. */
  stdout?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Internal: run row shape
// ---------------------------------------------------------------------------

interface RunRow {
  runId: string;
  workflow: string;
  status: string;
  createdAt: string;
  unreadable: boolean;
}

// ---------------------------------------------------------------------------
// listRunsAction
// ---------------------------------------------------------------------------

export async function listRunsAction(opts: ListRunsActionOpts): Promise<void> {
  const { zigmaflowDir, stdout = console.log } = opts;

  const runsDir = join(zigmaflowDir, ".zigma-flow", "runs");

  // 1. Read runs directory entries — gracefully handle missing dir
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    stdout("No runs found.");
    return;
  }

  // Filter to subdirectories only
  const dirEntries: string[] = [];
  for (const entry of entries) {
    try {
      await readdir(join(runsDir, entry));
      dirEntries.push(entry);
    } catch {
      // Not a directory — skip
    }
  }

  if (dirEntries.length === 0) {
    stdout("No runs found.");
    return;
  }

  // 2. Read run metadata for each entry
  const rows: RunRow[] = await Promise.all(
    dirEntries.map(async (runId): Promise<RunRow> => {
      const runDir = join(runsDir, runId);
      try {
        // Read state.json for status and created_at
        const stateText = await readFile(join(runDir, "state.json"), "utf-8");
        const state = JSON.parse(stateText) as Record<string, unknown>;

        // Read run.yml for workflow name (fallback to state.workflow)
        let workflowName: string = typeof state["workflow"] === "string" ? state["workflow"] : "[unknown]";
        try {
          const runYmlText = await readFile(join(runDir, "run.yml"), "utf-8");
          const runYml = parseYaml(runYmlText) as Record<string, unknown>;
          const wf = runYml["workflow"] as Record<string, unknown> | undefined;
          if (wf !== undefined && typeof wf["name"] === "string") {
            workflowName = wf["name"];
          }
        } catch {
          // run.yml unreadable — use state.workflow fallback
        }

        const status =
          typeof state["status"] === "string" ? state["status"] : "unknown";
        const createdAt =
          typeof state["created_at"] === "string" ? state["created_at"] : "";

        return { runId, workflow: workflowName, status, createdAt, unreadable: false };
      } catch {
        return {
          runId,
          workflow: "[unreadable]",
          status: "[unreadable]",
          createdAt: "",
          unreadable: true,
        };
      }
    })
  );

  // 3. Sort by createdAt descending (readable runs first by date; unreadable at end)
  rows.sort((a, b) => {
    if (a.unreadable && !b.unreadable) return 1;
    if (!a.unreadable && b.unreadable) return -1;
    // Both readable or both unreadable: sort by createdAt descending
    return b.createdAt.localeCompare(a.createdAt);
  });

  // 4. Print rows
  for (const row of rows) {
    if (row.unreadable) {
      stdout(`${row.runId}  [unreadable]`);
    } else {
      stdout(`${row.runId}  ${row.workflow}  ${row.status}  ${row.createdAt}`);
    }
  }
}
