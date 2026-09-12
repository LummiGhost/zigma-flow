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
import type { WorkspaceRetentionDefinition } from "../workflow/index.js";
import type {
  CleanupRunInput,
  CleanupRunResult,
  CommitJobInput,
  CommitJobResult,
  IntegrateJobInput,
  IntegrateJobResult,
  PrepareJobWorkspaceInput,
  PrepareRunWorkspaceInput,
  PublishRunInput,
  PublishRunResult,
  ReconcileRunInput,
  ReconcileRunResult,
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
  retention?: {
    success?: "cleanup" | "retain";
    failure?: "cleanup" | "retain";
    blocked?: "cleanup" | "retain";
  };
};

type PrepareJobData = {
  workspace_id: string;
  path: string;
  branch: string;
  base_commit: string;
};

type CommitData = {
  operation_id: string;
  workspace_id: string;
  base_commit: string;
  head_commit: string;
  changed_files: string[];
  evidence_digest: string;
  no_op: boolean;
};

type IntegrateData = {
  operation_id: string;
  source_workspace_id: string;
  target_workspace_id: string;
  source_commit: string;
  previous_target_head: string;
  resulting_commit: string;
  changed_files: string[];
  merged: boolean;
};

type PublishData = {
  operation_id: string;
  workspace_id: string;
  strategy: "none" | "branch";
  resulting_ref: string | null;
  resulting_commit: string;
  previous_ref: string | null;
  changed_files: string[];
};

type ReconcileData = {
  workspace_id: string;
  registry_status: string;
  directory_exists: boolean;
  git_head: string | null;
  manifest_exists: boolean;
  reconciled_status: "complete" | "incomplete" | "orphaned" | "inconsistent";
  recommendation: string;
};

type CleanupData = {
  operation_id: string;
  workspace_id: string;
  path: string;
  removed: boolean;
  status: "CLEANED" | "CLEANUP_FAILED";
  message: string;
  blockers: string[];
};

function toHandle(data: Record<string, unknown>, operation: string): WorkspaceHandle {
  const retention = data["retention"];
  const handle: WorkspaceHandle = {
    id: requireStringField(data, "workspace_id", operation),
    path: requireStringField(data, "path", operation),
    branch: requireStringField(data, "branch", operation),
    baseCommit: requireStringField(data, "base_commit", operation),
  };
  if (typeof retention === "object" && retention !== null && !Array.isArray(retention)) {
    handle.retention = retention as WorkspaceRetentionDefinition;
  }
  return handle;
}

function requireStringArray(data: Record<string, unknown>, field: string, operation: string): string[] {
  const value = data[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ValidationError(
      `zigma-workspace ${operation}: response field "${field}" must be a string array`,
      { details: { operation, field } },
    );
  }
  return value as string[];
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
    const retention = input.definition.retention;
    const data = await this.invoke<PrepareRunData>([
      "prepare-run",
      "--operation-id", operationId,
      "--run", input.runId,
      "--repo", repository,
      "--base", input.definition.base,
      "--mode", "writable",
      ...(retention?.success !== undefined ? ["--retention-success", retention.success] : []),
      ...(retention?.failure !== undefined ? ["--retention-failure", retention.failure] : []),
      ...(retention?.blocked !== undefined ? ["--retention-blocked", retention.blocked] : []),
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

  private assertOperationId(actual: string | undefined, expected: string): void {
    if (actual !== expected) {
      throw new ValidationError(
        `zigma-workspace bridge: expected operationId "${expected}", got "${actual}"`,
        { details: { operationId: actual, expectedOperationId: expected } },
      );
    }
  }

  async commitJob(input: CommitJobInput): Promise<CommitJobResult> {
    const operationId = `run:${input.runId}:job:${input.jobId}:attempt:${input.attempt}:commit`;
    this.assertOperationId(input.operationId, operationId);
    // CAS: the attempt must still be on the HEAD it branched from (or on a
    // replay, whose cached result is returned before any CAS re-check).
    const expectedHead = await this.resolveHead(input.jobWorkspace.path, input.signal);
    const data = await this.invoke<CommitData>([
      "commit",
      "--operation-id", operationId,
      "--workspace", input.jobWorkspace.id,
      "--expected-head", expectedHead,
      ...(input.message !== undefined ? ["--message", input.message] : []),
      ...(input.expectedState !== undefined ? ["--expected-state", input.expectedState] : []),
    ], input.signal);
    return {
      operationId: requireStringField(data, "operation_id", "commit"),
      workspaceId: requireStringField(data, "workspace_id", "commit"),
      baseCommit: requireStringField(data, "base_commit", "commit"),
      headCommit: requireStringField(data, "head_commit", "commit"),
      changedFiles: requireStringArray(data, "changed_files", "commit"),
      evidenceDigest: requireStringField(data, "evidence_digest", "commit"),
      noOp: data["no_op"] === true,
    };
  }

  async integrateJob(input: IntegrateJobInput): Promise<IntegrateJobResult> {
    const operationId = `run:${input.runId}:job:${input.jobId}:attempt:${input.attempt}:integrate`;
    this.assertOperationId(input.operationId, operationId);
    const expectedHead = input.expectedHead
      ?? await this.resolveHead(input.runWorkspace.path, input.signal);
    let data: IntegrateData;
    try {
      data = await this.invoke<IntegrateData>([
        "integrate",
        "--operation-id", operationId,
        "--source", input.jobWorkspace.id,
        "--target", input.runWorkspace.id,
        "--lock-owner", `flow-run:${input.runId}`,
        "--expected-head", expectedHead,
      ], input.signal);
    } catch (error: unknown) {
      const providerDetails = this.providerErrorDetails(error, "integrate");
      if (providerDetails?.code === "WORKSPACE_INTEGRATION_CONFLICT") {
        const details = providerDetails.details as Record<string, unknown> | undefined;
        const conflictFiles = Array.isArray(details?.["conflict_files"])
          ? (details!["conflict_files"] as string[])
          : [];
        const jobCommit = typeof details?.["source_commit"] === "string" ? details["source_commit"] : "";
        const runHead = typeof details?.["previous_target_head"] === "string"
          ? details["previous_target_head"]
          : "";
        return {
          status: "conflicted",
          operationId,
          sourceWorkspaceId: input.jobWorkspace.id,
          targetWorkspaceId: input.runWorkspace.id,
          conflictFiles,
          jobCommit,
          runHead,
          message: providerDetails.message ?? "integration conflict",
        };
      }
      throw error;
    }
    const common = {
      operationId: requireStringField(data, "operation_id", "integrate"),
      sourceWorkspaceId: requireStringField(data, "source_workspace_id", "integrate"),
      targetWorkspaceId: requireStringField(data, "target_workspace_id", "integrate"),
      sourceCommit: requireStringField(data, "source_commit", "integrate"),
      previousTargetHead: requireStringField(data, "previous_target_head", "integrate"),
    };
    if (data["merged"] !== true) {
      return { status: "no-op", ...common };
    }
    return {
      status: "merged",
      ...common,
      resultingCommit: requireStringField(data, "resulting_commit", "integrate"),
      changedFiles: requireStringArray(data, "changed_files", "integrate"),
    };
  }

  async publishRun(input: PublishRunInput): Promise<PublishRunResult> {
    const operationId = `run:${input.runId}:publish`;
    this.assertOperationId(input.operationId, operationId);
    if (input.strategy !== "none" && input.strategy !== "branch") {
      throw new ValidationError(
        `zigma-workspace bridge: unsupported publish strategy "${input.strategy}"`,
        { details: { operationId, strategy: input.strategy } },
      );
    }
    const expectedHead = input.expectedHead
      ?? await this.resolveHead(input.workspace.path, input.signal);
    const data = await this.invoke<PublishData>([
      "publish",
      "--operation-id", operationId,
      "--workspace", input.workspace.id,
      "--strategy", input.strategy,
      "--target-ref", input.targetRef,
      "--expected-head", expectedHead,
    ], input.signal);
    return {
      operationId: requireStringField(data, "operation_id", "publish"),
      workspaceId: requireStringField(data, "workspace_id", "publish"),
      strategy: input.strategy,
      resultingRef: typeof data["resulting_ref"] === "string" ? data["resulting_ref"] : null,
      resultingCommit: requireStringField(data, "resulting_commit", "publish"),
      previousRef: typeof data["previous_ref"] === "string" ? data["previous_ref"] : null,
      changedFiles: requireStringArray(data, "changed_files", "publish"),
    };
  }

  async reconcileRun(input: ReconcileRunInput): Promise<ReconcileRunResult> {
    const data = await this.invoke<ReconcileData>([
      "reconcile",
      "--workspace", input.workspace.id,
    ], input.signal);
    const reconciledStatus = data["reconciled_status"];
    if (
      reconciledStatus !== "complete"
      && reconciledStatus !== "incomplete"
      && reconciledStatus !== "orphaned"
      && reconciledStatus !== "inconsistent"
    ) {
      throw new ValidationError(
        `zigma-workspace reconcile: unexpected reconciled_status "${String(reconciledStatus)}"`,
        { details: { reconciledStatus } },
      );
    }
    return {
      workspaceId: requireStringField(data, "workspace_id", "reconcile"),
      registryStatus: requireStringField(data, "registry_status", "reconcile"),
      directoryExists: data["directory_exists"] === true,
      gitHead: typeof data["git_head"] === "string" ? data["git_head"] : null,
      manifestExists: data["manifest_exists"] === true,
      reconciledStatus,
      recommendation: requireStringField(data, "recommendation", "reconcile"),
    };
  }

  async cleanupRun(input: CleanupRunInput): Promise<CleanupRunResult> {
    const operationId = input.operationId;
    let data: CleanupData;
    try {
      data = await this.invoke<CleanupData>([
        "cleanup",
        "--operation-id", operationId,
        "--workspace", input.workspace.id,
        "--strict",
      ], input.signal);
    } catch (error: unknown) {
      // A blocked strict cleanup is a business outcome (the workspace is
      // retained for the GC/retention path), not a transport failure.
      const providerDetails = this.providerErrorDetails(error, "cleanup");
      if (providerDetails?.code === "WORKSPACE_CLEANUP_FAILED") {
        const details = providerDetails.details as Record<string, unknown> | undefined;
        return {
          operationId,
          workspaceId: input.workspace.id,
          path: typeof details?.["path"] === "string" ? details["path"] : input.workspace.path,
          removed: details?.["removed"] === true,
          status: "CLEANUP_FAILED",
          message: providerDetails.message ?? "cleanup failed",
          blockers: Array.isArray(details?.["blockers"])
            ? (details["blockers"] as string[])
            : [],
        };
      }
      throw error;
    }
    return {
      operationId: requireStringField(data, "operation_id", "cleanup"),
      workspaceId: requireStringField(data, "workspace_id", "cleanup"),
      path: requireStringField(data, "path", "cleanup"),
      removed: data["removed"] === true,
      status: data["status"] === "CLEANUP_FAILED" ? "CLEANUP_FAILED" : "CLEANED",
      message: requireStringField(data, "message", "cleanup"),
      blockers: requireStringArray(data, "blockers", "cleanup"),
    };
  }

  /** Extract the provider error envelope from a ValidationError thrown by invoke. */
  private providerErrorDetails(
    error: unknown,
    operation: string,
  ): { code: string; message: string; details?: unknown } | undefined {
    if (!(error instanceof ValidationError)) return undefined;
    const details = error.details as Record<string, unknown> | undefined;
    if (details?.["operation"] !== operation) return undefined;
    const code = details?.["providerCode"];
    if (typeof code !== "string") return undefined;
    return {
      code,
      message: error.message,
      details: details?.["providerDetails"],
    };
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
