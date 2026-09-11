/**
 * Managed zigma-workspace bridge — M3.5.
 *
 * Core spawns Flow as a CLI subprocess, so a JS-object provider cannot cross
 * that boundary: the adapter is constructed inside the Flow process and talks
 * to the workspace CLI over spawn boundaries via execa.
 *
 * Activation (composition roots only):
 *   - `ZIGMA_WORKSPACE_CLI_PATH`  — absolute path to the built workspace CLI
 *     (dist/cli/index.js). Absent → no provider is injected and managed
 *     workflows keep failing closed at the Engine port.
 *   - `ZIGMA_WORKSPACE_STATE_DIR` — optional state directory passed through to
 *     every CLI spawn as the global `--state-dir` option.
 *
 * Negotiation is fail-closed and anti-fork: this file hardcodes NO capability
 * list. It only requires the provider's own `contract-info` to report
 * `contract_version === 1`, `provider === "zigma-workspace"` and
 * `managed_supported === true`. A missing `managed_supported` field means an
 * old CLI build and is rejected, as is `managed_supported: false`. There is
 * deliberately no silent fallback to external-directory execution: a broken
 * or downgraded provider must surface as a typed error, not degraded
 * isolation.
 */

import { execa } from "execa";

import { ValidationError } from "../utils/index.js";
import type {
  PrepareJobWorkspaceInput,
  PrepareRunWorkspaceInput,
  WorkspaceHandle,
  WorkspaceProvider,
} from "./provider.js";

const CONTRACT_VERSION = 1;
const EXPECTED_PROVIDER = "zigma-workspace";
const CLI_TIMEOUT_MS = 900_000;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

interface CliEnvelope {
  contract_version?: unknown;
  ok?: unknown;
  data?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** execa timeout flag; the child was killed, exitCode is meaningless. */
  timedOut?: boolean;
  /** execa cancelSignal flag; the caller aborted the invocation. */
  isCanceled?: boolean;
}

/** Spawn seam: stubbed in unit tests, execa-backed in production. */
export type CliRunner = (
  args: string[],
  opts?: { cwd?: string; signal?: AbortSignal },
) => Promise<CliRunResult>;

function defaultCliRunner(cliPath: string, stateDir?: string): CliRunner {
  return async (args, opts) => {
    const fullArgs = [
      ...(stateDir !== undefined ? ["--state-dir", stateDir] : []),
      ...args,
    ];
    const result = await execa(process.execPath, [cliPath, ...fullArgs], {
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.signal !== undefined ? { cancelSignal: opts.signal } : {}),
      timeout: CLI_TIMEOUT_MS,
      reject: false,
      all: true,
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: result.timedOut,
      isCanceled: result.isCanceled,
    };
  };
}

function parseEnvelope<T extends Record<string, unknown>>(
  result: CliRunResult,
  operation: string,
): T {
  const { stdout, exitCode } = result;
  if (result.timedOut === true) {
    throw new ValidationError(`zigma-workspace ${operation}: CLI invocation timed out`, {
      details: { operation, stderrTail: result.stderr.slice(-2_000) },
    });
  }
  if (result.isCanceled === true) {
    throw new ValidationError(`zigma-workspace ${operation}: CLI invocation was cancelled`, {
      details: { operation, stderrTail: result.stderr.slice(-2_000) },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ValidationError(`zigma-workspace ${operation}: stdout is not valid JSON`, {
      details: { operation, exitCode, stdoutTail: stdout.slice(-2_000), stderrTail: result.stderr.slice(-2_000) },
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(`zigma-workspace ${operation}: stdout must be a V1 envelope object`, {
      details: { operation, exitCode, stderrTail: result.stderr.slice(-2_000) },
    });
  }
  const envelope = parsed as CliEnvelope;
  if (envelope.contract_version !== CONTRACT_VERSION) {
    throw new ValidationError(
      `zigma-workspace ${operation}: contract version mismatch (expected ${CONTRACT_VERSION}, got ${String(envelope.contract_version)})`,
      { details: { operation, contractVersion: envelope.contract_version } },
    );
  }
  if (envelope.ok !== true) {
    const error = envelope.error;
    const providerCode = typeof error?.code === "string" && error.code ? error.code : "UNKNOWN";
    const message = typeof error?.message === "string" && error.message
      ? error.message
      : `zigma-workspace ${operation} failed`;
    throw new ValidationError(
      `zigma-workspace ${operation} failed (${providerCode}): ${message}`,
      {
        details: {
          operation,
          exitCode,
          providerCode,
          ...(result.stderr !== "" ? { stderrTail: result.stderr.slice(-2_000) } : {}),
          ...(typeof error?.details === "object" && error.details !== null
            ? { providerDetails: error.details }
            : {}),
        },
      },
    );
  }
  if (exitCode !== 0) {
    throw new ValidationError(`zigma-workspace ${operation}: process failed despite a success envelope`, {
      details: { operation, exitCode },
    });
  }
  if (envelope.data === undefined || typeof envelope.data !== "object" || envelope.data === null) {
    throw new ValidationError(`zigma-workspace ${operation}: success envelope is missing data`, {
      details: { operation },
    });
  }
  return envelope.data as T;
}

function requireStringField(data: Record<string, unknown>, field: string, operation: string): string {
  const value = data[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(
      `zigma-workspace ${operation}: response is missing the required "${field}" field`,
      { details: { operation, field } },
    );
  }
  return value;
}

export interface ManagedContract {
  provider: string;
  packageVersion: string;
  contractVersion: number;
  capabilities: string[];
  managedSupported: true;
  managedRequiredCapabilities: string[];
}

/**
 * Fail-closed managed-mode negotiation over `contract-info --json`.
 *
 * No capability list is hardcoded here (anti-fork): the provider's own
 * `managed_supported` declaration is the gate, so a capability change in
 * zigma-workspace cannot silently desynchronise Flow's bridge.
 */
export async function negotiateManagedContract(
  runCli: CliRunner,
): Promise<ManagedContract> {
  const result = await runCli(["contract-info", "--json"]);
  const data = parseEnvelope<Record<string, unknown>>(result, "contract-info");

  const provider = data["provider"];
  if (provider !== EXPECTED_PROVIDER) {
    throw new ValidationError(
      `zigma-workspace provider mismatch: expected "${EXPECTED_PROVIDER}", got "${String(provider)}"`,
      { details: { provider } },
    );
  }
  const contractVersion = data["contract_version"];
  if (typeof contractVersion !== "number" || !Number.isInteger(contractVersion) || contractVersion !== CONTRACT_VERSION) {
    throw new ValidationError(
      `zigma-workspace contract version mismatch: expected ${CONTRACT_VERSION}, got "${String(contractVersion)}"`,
      { details: { contractVersion } },
    );
  }
  // `managed_supported` is version-1-compatible optional data. Absent field
  // means an old CLI build → fail closed. Never coerce or default it.
  if (data["managed_supported"] !== true) {
    throw new ValidationError(
      "zigma-workspace does not report managed mode supported; refusing managed activation",
      {
        details: { managedSupported: data["managed_supported"] },
        suggestion:
          "Upgrade zigma-workspace (or set ZIGMA_WORKSPACE_CLI_PATH) to a build advertising managed_supported in contract-info.",
      },
    );
  }
  const capabilities = data["capabilities"];
  const managedRequired = data["managed_required_capabilities"];
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((item) => typeof item === "string") ||
    !Array.isArray(managedRequired) ||
    !managedRequired.every((item) => typeof item === "string")
  ) {
    throw new ValidationError("zigma-workspace contract-info capability lists must be string arrays", {
      details: { capabilities, managedRequiredCapabilities: managedRequired },
    });
  }
  const packageVersion = data["package_version"];
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new ValidationError("zigma-workspace contract-info package_version must be a non-empty string", {
      details: { packageVersion },
    });
  }

  return {
    provider,
    packageVersion,
    contractVersion,
    capabilities: capabilities as string[],
    managedSupported: true,
    managedRequiredCapabilities: managedRequired as string[],
  };
}

export async function resolveWorkspaceHead(path: string, signal?: AbortSignal): Promise<string> {
  const result = await execa("git", ["rev-parse", "HEAD"], {
    cwd: path,
    ...(signal !== undefined ? { cancelSignal: signal } : {}),
    reject: false,
  });
  const head = (result.stdout ?? "").trim();
  if (result.exitCode !== 0 || !FULL_SHA_PATTERN.test(head)) {
    throw new ValidationError(
      `zigma-workspace bridge: cannot resolve the Run workspace HEAD at "${path}"`,
      { details: { exitCode: result.exitCode, head: head.slice(0, 64) } },
    );
  }
  return head;
}

type PrepareRunData = {
  workspace_id: string;
  path: string;
  branch: string;
  base_commit: string;
};

type PrepareJobData = {
  workspace_id: string;
  path: string;
  branch: string;
  base_commit: string;
};

function toHandle(data: Record<string, unknown>, operation: string): WorkspaceHandle {
  return {
    id: requireStringField(data, "workspace_id", operation),
    path: requireStringField(data, "path", operation),
    branch: requireStringField(data, "branch", operation),
    baseCommit: requireStringField(data, "base_commit", operation),
  };
}

export class ZigmaWorkspaceCliProvider implements WorkspaceProvider {
  constructor(
    private readonly runCli: CliRunner,
    private readonly resolveHead: (path: string, signal?: AbortSignal) => Promise<string> = resolveWorkspaceHead,
  ) {}

  private async invoke<T extends Record<string, unknown>>(
    args: string[],
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await this.runCli([...args, "--json"], { ...(signal !== undefined ? { signal } : {}) });
    return parseEnvelope<T>(result, args[0] ?? "unknown");
  }

  async prepareRun(input: PrepareRunWorkspaceInput): Promise<WorkspaceHandle> {
    // Operation-id namespace guard: the bridge owns the `run:<runId>:*`
    // reservation. A divergent caller id must fail closed, not be passed
    // through into Core's create/apply or GC id namespaces.
    const operationId = `run:${input.runId}:create`;
    if (input.operationId !== operationId) {
      throw new ValidationError(
        `zigma-workspace bridge: expected operationId "${operationId}", got "${input.operationId}"`,
        { details: { operationId: input.operationId, expectedOperationId: operationId } },
      );
    }
    const repository = input.definition.repository === "."
      ? input.projectRoot
      : input.definition.repository;
    const data = await this.invoke<PrepareRunData>([
      "prepare-run",
      "--operation-id", operationId,
      "--run", input.runId,
      "--repo", repository,
      "--base", input.definition.base,
      "--mode", "writable",
    ], input.signal);
    return toHandle(data, "prepare-run");
  }

  async prepareJob(input: PrepareJobWorkspaceInput): Promise<WorkspaceHandle> {
    const operationId = `run:${input.runId}:job:${input.jobId}:attempt:${input.attempt}:create`;
    if (input.operationId !== operationId) {
      throw new ValidationError(
        `zigma-workspace bridge: expected operationId "${operationId}", got "${input.operationId}"`,
        { details: { operationId: input.operationId, expectedOperationId: operationId } },
      );
    }
    // The attempt must branch from the exact Run HEAD, not whatever the run
    // workspace happens to be on at spawn time — so resolve it first, then
    // let the provider's CAS reject a raced concurrent integration.
    const expectedHead = await this.resolveHead(input.runWorkspace.path, input.signal);
    const data = await this.invoke<PrepareJobData>([
      "prepare-job",
      "--operation-id", operationId,
      "--run", input.runId,
      "--run-workspace", input.runWorkspace.id,
      "--job", input.jobId,
      "--attempt", String(input.attempt),
      "--expected-head", expectedHead,
    ], input.signal);
    return toHandle(data, "prepare-job");
  }
}

export interface ZigmaWorkspaceCliProviderOptions {
  /** Absolute path to the built workspace CLI (dist/cli/index.js). */
  cliPath: string;
  /** Optional state directory passed as the global `--state-dir` option. */
  stateDir?: string;
  /** Spawn seam for tests; defaults to the execa-backed runner. */
  runCli?: CliRunner;
  /** HEAD-resolution seam for tests; defaults to `git rev-parse HEAD`. */
  resolveHead?: (path: string, signal?: AbortSignal) => Promise<string>;
}

/**
 * Negotiate the managed contract and return a provider bound to the CLI.
 * Throws ValidationError (fail closed) when negotiation fails — callers must
 * not catch-and-continue into external-directory execution.
 */
export async function createZigmaWorkspaceCliProvider(
  options: ZigmaWorkspaceCliProviderOptions,
): Promise<WorkspaceProvider> {
  const runCli = options.runCli ?? defaultCliRunner(options.cliPath, options.stateDir);
  await negotiateManagedContract(runCli);
  return options.resolveHead !== undefined
    ? new ZigmaWorkspaceCliProvider(runCli, options.resolveHead)
    : new ZigmaWorkspaceCliProvider(runCli);
}

/**
 * Composition-root helper: reads `ZIGMA_WORKSPACE_CLI_PATH` and
 * `ZIGMA_WORKSPACE_STATE_DIR`. Returns undefined when the env var is unset
 * (managed workflows then fail closed at the Engine port as before); throws
 * the negotiation ValidationError when it is set but the contract fails.
 */
export async function createWorkspaceProviderFromEnv(): Promise<WorkspaceProvider | undefined> {
  const cliPath = process.env["ZIGMA_WORKSPACE_CLI_PATH"]?.trim() ?? "";
  if (cliPath === "") return undefined;
  const stateDir = process.env["ZIGMA_WORKSPACE_STATE_DIR"]?.trim() ?? "";
  return createZigmaWorkspaceCliProvider({
    cliPath,
    ...(stateDir !== "" ? { stateDir } : {}),
  });
}
