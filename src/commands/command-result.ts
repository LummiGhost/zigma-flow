/**
 * Shared structured result type for `abort --json`, `resume --json`, and
 * `inspect --json` commands.
 *
 * Reference: ISSUE #254 — platform integration contract.
 */

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------

export const COMMAND_CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  RUN_ALREADY_TERMINAL: "RUN_ALREADY_TERMINAL",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  STEP_NOT_AWAITING: "STEP_NOT_AWAITING",
  ALREADY_DECIDED: "ALREADY_DECIDED",
  INVALID_INPUT: "INVALID_INPUT",
  STATE_CORRUPT: "STATE_CORRUPT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ---------------------------------------------------------------------------
// CommandJsonResult
// ---------------------------------------------------------------------------

export interface CommandJsonResult {
  contractVersion: number;
  command: string;
  status: "success" | "error";
  runId: string;
  data: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function successResult(
  command: string,
  runId: string,
  data: Record<string, unknown> = {},
): CommandJsonResult {
  return {
    contractVersion: COMMAND_CONTRACT_VERSION,
    command,
    status: "success",
    runId,
    data,
  };
}

export function errorResult(
  command: string,
  runId: string,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): CommandJsonResult {
  return {
    contractVersion: COMMAND_CONTRACT_VERSION,
    command,
    status: "error",
    runId,
    data: {},
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
}
