/**
 * `zigma-flow abort` command handler.
 *
 * Cancels the active run without deleting any artifacts.
 *
 * Pipeline:
 *   1. Read active_run from .zigma-flow/config.json → ConfigError if absent.
 *   2. Resolve run directory from active run id.
 *   3. Call abortRun({ runDir, runId, clock }).
 *   4. Print a success message.
 *
 * v0.7 (ISSUE #254): Added --json mode with stable error codes.
 *
 * Reference:
 *   - docs/phases/p9p10-cli-admin-commands/workflows/wf-cli-commands/
 */

import { join } from "node:path";

import { abortRun } from "../engine/abort.js";
import { resolveRunId } from "../run/index.js";
import type { Clock } from "../run/index.js";
import {
  ConfigError,
  StateError,
  ZigmaFlowError,
} from "../utils/index.js";
import {
  COMMAND_CONTRACT_VERSION,
  successResult,
  errorResult,
  type CommandJsonResult,
  type ErrorCode,
} from "./command-result.js";

// ---------------------------------------------------------------------------
// abortAction options
// ---------------------------------------------------------------------------

export interface AbortActionOpts {
  /** Project root directory (parent of .zigma-flow/). */
  zigmaflowDir: string;
  /** Clock for timestamping events. */
  clock: Clock;
  /** Optional human-readable reason for the abort. */
  reason?: string;
  /** Optional explicit run id (from --run flag). */
  runId?: string;
  /** Use the most recently created run (from --latest flag, explicit). */
  latest?: boolean;
  /** JSON mode: machine-readable output to stdout (ISSUE #254). */
  json?: boolean;
  /** Injectable stdout function for testing. */
  stdout?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Error code mapping
// ---------------------------------------------------------------------------

function mapErrorToCode(err: unknown): ErrorCode {
  if (err instanceof ConfigError) return "RUN_NOT_FOUND";
  if (err instanceof StateError) return "RUN_ALREADY_TERMINAL";
  if (err instanceof ZigmaFlowError) return "INTERNAL_ERROR";
  return "INTERNAL_ERROR";
}

// ---------------------------------------------------------------------------
// abortAction
// ---------------------------------------------------------------------------

export async function abortAction(opts: AbortActionOpts): Promise<CommandJsonResult> {
  const { zigmaflowDir, clock, reason, runId, json: isJson } = opts;
  const print = opts.stdout ?? ((line: string) => { console.log(line); });

  try {
    // 1. Resolve run id (explicit --run, --latest, or deprecated fallback from config)
    const activeRunId = await resolveRunId(zigmaflowDir, runId, opts.latest !== undefined ? { latest: opts.latest } : undefined);

    const runsDir = join(zigmaflowDir, ".zigma-flow", "runs");
    const runDir = join(runsDir, activeRunId);

    // 2. Abort the run (Engine owns all state transitions)
    await abortRun({
      runDir,
      runId: activeRunId,
      clock,
      ...(reason !== undefined ? { reason } : {}),
    });

    const result = successResult("abort", activeRunId, {
      ...(reason !== undefined ? { reason } : {}),
    });

    if (isJson) {
      print(JSON.stringify(result));
    } else {
      console.log(`Run ${activeRunId} cancelled.`);
    }

    return result;
  } catch (err: unknown) {
    const code = mapErrorToCode(err);
    const message = err instanceof Error ? err.message : String(err);
    const errorRunId = runId ?? "(unknown)";

    const result = errorResult("abort", errorRunId, code, message);

    if (isJson) {
      print(JSON.stringify(result));
      return result;
    }
    throw err;
  }
}
