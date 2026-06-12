/**
 * `zigma-flow show [<run-id>]` command handler.
 *
 * Resolves the run id (positional arg or active_run), reads run.yml,
 * state.json, and the last 5 events from events.jsonl, then renders the result.
 *
 * Reference:
 *   - docs/phases/p9p10-cli-admin-commands/workflows/wf-cli-commands/
 *   - docs/prd.md §17
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { readActiveRun, LocalStateStore } from "../run/index.js";
import type { RunState } from "../run/index.js";
import { ConfigError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// showAction options
// ---------------------------------------------------------------------------

export interface ShowActionOpts {
  /** Project root directory (parent of .zigma-flow/). */
  zigmaflowDir: string;
  /** Optional explicit run id; if absent, falls back to active_run. */
  runId?: string;
  /** Optional stdout function for testing; defaults to console.log. */
  stdout?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Internal: event envelope shape (minimal)
// ---------------------------------------------------------------------------

interface EventEnvelope {
  id: string;
  type: string;
  run_id: string;
  timestamp: string;
  producer?: string;
  job?: string | null;
  step?: string | null;
  attempt?: number | null;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// showAction
// ---------------------------------------------------------------------------

export async function showAction(opts: ShowActionOpts): Promise<void> {
  const { zigmaflowDir, stdout = console.log } = opts;

  const runsDir = join(zigmaflowDir, ".zigma-flow", "runs");

  // 1. Resolve run id
  let runId = opts.runId;
  if (runId === undefined) {
    const activeRunId = await readActiveRun(zigmaflowDir);
    if (activeRunId === null) {
      throw new ConfigError(
        "No run id provided and no active run found.",
        { details: { zigmaflowDir } }
      );
    }
    runId = activeRunId;
  }

  const runDir = join(runsDir, runId);

  // 2. Read run.yml
  let runYml: Record<string, unknown> = {};
  try {
    const runYmlText = await readFile(join(runDir, "run.yml"), "utf-8");
    runYml = parseYaml(runYmlText) as Record<string, unknown>;
  } catch (e: unknown) {
    const isEnoent =
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as Record<string, unknown>)["code"] === "ENOENT";
    if (isEnoent) {
      throw new ConfigError(
        `Run "${runId}" not found (run.yml missing at ${runDir})`,
        { details: { runId, runDir } }
      );
    }
    throw e;
  }

  // 3. Read state.json
  const stateStore = new LocalStateStore();
  let state: RunState | null;
  try {
    state = await stateStore.readSnapshot(runDir);
  } catch {
    throw new ConfigError(
      `Run "${runId}" state.json is unreadable at ${runDir}`,
      { details: { runId, runDir } }
    );
  }

  if (state === null) {
    throw new ConfigError(
      `Run "${runId}" not found (state.json missing at ${runDir})`,
      { details: { runId, runDir } }
    );
  }

  // 4. Read last 5 events from events.jsonl
  let lastEvents: EventEnvelope[] = [];
  try {
    const eventsText = await readFile(join(runDir, "events.jsonl"), "utf-8");
    const allEvents = eventsText
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as EventEnvelope);
    lastEvents = allEvents.slice(-5);
  } catch {
    // events.jsonl missing or unreadable — show empty
  }

  // 5. Render output
  const wf = runYml["workflow"] as Record<string, unknown> | undefined;
  const workflowName =
    (wf !== undefined && typeof wf["name"] === "string" ? wf["name"] : null) ??
    state.workflow ??
    "[unknown]";
  const createdAt =
    (typeof runYml["created_at"] === "string" ? runYml["created_at"] : null) ??
    state.created_at;
  const task =
    (typeof runYml["task"] === "string" ? runYml["task"] : null) ?? state.task;
  const status = state.status ?? "unknown";

  stdout(`Run:      ${runId}`);
  stdout(`Workflow: ${workflowName}`);
  stdout(`Task:     ${task}`);
  stdout(`Created:  ${createdAt}`);
  stdout(`Status:   ${status}`);
  stdout(``);
  stdout(`Jobs:`);

  for (const [jobId, jobState] of Object.entries(state.jobs)) {
    const attempt = jobState.attempt !== undefined ? `  attempt: ${jobState.attempt}` : "";
    stdout(`  ${jobId.padEnd(20)}${jobState.status}${attempt}`);
  }

  stdout(``);
  stdout(`Last events:`);

  for (const event of lastEvents) {
    const job = event.job !== null && event.job !== undefined ? `  job: ${event.job}` : "";
    stdout(`  ${event.id}  ${event.type}${job}`);
  }
}
