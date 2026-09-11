/**
 * M3.5 managed bridge unit tests — zigma-workspace CLI provider.
 *
 * The spawn seam (`CliRunner`) and the HEAD-resolution seam are injected, so
 * negotiation and flag mapping are tested without the real workspace CLI.
 * Env-var activation and the default execa runner are exercised against a
 * fake CLI file on disk.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ValidationError } from "../../src/utils/index.js";
import {
  createWorkspaceProviderFromEnv,
  createZigmaWorkspaceCliProvider,
  negotiateManagedContract,
  resolveWorkspaceHead,
  type CliRunner,
} from "../../src/workspace/zigma-workspace-cli-provider.js";
import type {
  PrepareJobWorkspaceInput,
  PrepareRunWorkspaceInput,
  WorkspaceProvider,
} from "../../src/workspace/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function okEnvelope(data: Record<string, unknown>): string {
  return JSON.stringify({ contract_version: 1, ok: true, data });
}

function errEnvelope(code: string, message: string): string {
  return JSON.stringify({ contract_version: 1, ok: false, error: { code, message } });
}

const VALID_CONTRACT = {
  provider: "zigma-workspace",
  package_version: "0.1.5",
  contract_version: 1,
  capabilities: ["workspace-prepare-run-v1", "workspace-prepare-job-v1"],
  managed_supported: true,
  managed_required_capabilities: ["workspace-prepare-run-v1", "workspace-prepare-job-v1"],
};

const PREPARE_RUN_DATA = {
  operation_id: "run:r1:create",
  run_id: "r1",
  workspace_id: "ws-run-1",
  path: join(tmpdir(), "ws-run-1"),
  branch: "flow/r1",
  base_ref: "main",
  base_commit: "a".repeat(40),
  mode: "writable",
  status: "RUNNING",
  created_at: "2026-09-12T00:00:00.000Z",
};

const PREPARE_JOB_DATA = {
  operation_id: "run:r1:job:impl:attempt:1:create",
  run_id: "r1",
  run_workspace_id: "ws-run-1",
  job_id: "impl",
  attempt: 1,
  workspace_id: "ws-job-1",
  path: join(tmpdir(), "ws-job-1"),
  branch: "job/r1/impl/a1",
  base_commit: "b".repeat(40),
  mode: "writable",
  status: "RUNNING",
  created_at: "2026-09-12T00:00:00.000Z",
};

interface RecordedCall {
  args: string[];
  opts?: { cwd?: string; signal?: AbortSignal };
}

type StubResult = { exitCode?: number; stdout: string; stderr?: string };
type StubHandler = (call: RecordedCall) => StubResult;

function recordingRunner(script: StubHandler) {
  const calls: RecordedCall[] = [];
  const runCli: CliRunner = async (args, opts) => {
    calls.push({ args, ...(opts !== undefined ? { opts } : {}) });
    const result = script(calls[calls.length - 1]!);
    return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr ?? "" };
  };
  return { calls, runCli };
}

/**
 * Route stub output by subcommand: negotiation always sees a valid contract
 * unless the test overrides the "contract-info" handler.
 */
function routedRunner(overrides: Record<string, StubResult> = {}) {
  return recordingRunner((call) => {
    const command = call.args[0] ?? "unknown";
    if (overrides[command] !== undefined) return overrides[command]!;
    if (command === "contract-info") return { stdout: okEnvelope(VALID_CONTRACT) };
    if (command === "prepare-run") return { stdout: okEnvelope(PREPARE_RUN_DATA) };
    if (command === "prepare-job") return { stdout: okEnvelope(PREPARE_JOB_DATA) };
    throw new Error(`unexpected CLI subcommand in stub: ${command}`);
  });
}

async function makeProvider(
  runCli: CliRunner,
  resolveHead: (path: string, signal?: AbortSignal) => Promise<string> = async () => "c".repeat(40),
): Promise<WorkspaceProvider> {
  return createZigmaWorkspaceCliProvider({
    cliPath: "Z:\\fake\\dist\\cli\\index.js",
    runCli,
    resolveHead,
  });
}

function expectValidationError(fn: () => Promise<unknown>): Promise<ValidationError> {
  return fn().then(
    () => {
      throw new Error("expected ValidationError");
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      return err as ValidationError;
    },
  );
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zigma-flow-bridge-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// negotiateManagedContract — fail-closed cases
// ---------------------------------------------------------------------------

describe("negotiateManagedContract", () => {
  it("accepts a complete managed contract", async () => {
    const { calls, runCli } = recordingRunner(() => ({ stdout: okEnvelope(VALID_CONTRACT) }));
    const contract = await negotiateManagedContract(runCli);

    expect(calls).toEqual([{ args: ["contract-info", "--json"], opts: undefined }]);
    expect(contract).toMatchObject({
      provider: "zigma-workspace",
      contractVersion: 1,
      managedSupported: true,
    });
  });

  it("fails closed when managed_supported is absent (old CLI)", async () => {
    const { managed_supported: _s, managed_required_capabilities: _r, ...old } = VALID_CONTRACT;
    const { runCli } = recordingRunner(() => ({ stdout: okEnvelope(old) }));
    const err = await expectValidationError(() => negotiateManagedContract(runCli));
    expect(err.message).toContain("managed");
    expect(err.details).toMatchObject({ managedSupported: undefined });
  });

  it("fails closed when the provider reports managed_supported: false", async () => {
    const { runCli } = recordingRunner(() => ({
      stdout: okEnvelope({ ...VALID_CONTRACT, managed_supported: false }),
    }));
    await expectValidationError(() => negotiateManagedContract(runCli));
  });

  it("rejects non-numeric and mismatched contract versions", async () => {
    for (const contract_version of [2, "1", "not-a-number"]) {
      const { runCli } = recordingRunner(() => ({
        stdout: okEnvelope({ ...VALID_CONTRACT, contract_version }),
      }));
      const err = await expectValidationError(() => negotiateManagedContract(runCli));
      expect(err.message).toContain("contract version");
    }
  });

  it("rejects a foreign provider", async () => {
    const { runCli } = recordingRunner(() => ({
      stdout: okEnvelope({ ...VALID_CONTRACT, provider: "other-provider" }),
    }));
    await expectValidationError(() => negotiateManagedContract(runCli));
  });

  it("rejects malformed capability lists even when managed_supported is true", async () => {
    const { runCli } = recordingRunner(() => ({
      stdout: okEnvelope({ ...VALID_CONTRACT, capabilities: "not-an-array" }),
    }));
    await expectValidationError(() => negotiateManagedContract(runCli));
  });

  it("rejects non-JSON stdout with a typed error", async () => {
    const { runCli } = recordingRunner(() => ({ stdout: "not json at all" }));
    const err = await expectValidationError(() => negotiateManagedContract(runCli));
    expect(err.message).toContain("not valid JSON");
  });

  it("rejects an error envelope with the provider code in details", async () => {
    const { runCli } = recordingRunner(() => ({
      exitCode: 1,
      stdout: errEnvelope("CONTRACT_VERSION_UNSUPPORTED", "bad version"),
    }));
    const err = await expectValidationError(() => negotiateManagedContract(runCli));
    expect(err.details).toMatchObject({ providerCode: "CONTRACT_VERSION_UNSUPPORTED", exitCode: 1 });
  });
});

// ---------------------------------------------------------------------------
// Flag mapping and envelope → handle conversion
// ---------------------------------------------------------------------------

describe("ZigmaWorkspaceCliProvider flag mapping", () => {
  it("maps prepareRun flags, resolves repository '.' against projectRoot, and converts the envelope", async () => {
    const root = makeTempDir();
    const { calls, runCli } = routedRunner();
    const provider = await makeProvider(runCli);

    const input: PrepareRunWorkspaceInput = {
      operationId: "run:r1:create",
      runId: "r1",
      projectRoot: root,
      definition: { provider: "zigma-workspace", repository: ".", base: "main" },
    };
    const handle = await provider.prepareRun(input);

    const [, prepareCall] = calls;
    expect(prepareCall?.args).toEqual([
      "prepare-run",
      "--operation-id", "run:r1:create",
      "--run", "r1",
      "--repo", root,
      "--base", "main",
      "--mode", "writable",
      "--json",
    ]);
    expect(handle).toEqual({
      id: "ws-run-1",
      path: PREPARE_RUN_DATA.path,
      branch: "flow/r1",
      baseCommit: "a".repeat(40),
    });
  });

  it("passes a non-'.' repository through unchanged", async () => {
    const { calls, runCli } = routedRunner();
    const provider = await makeProvider(runCli);

    await provider.prepareRun({
      operationId: "run:r1:create",
      runId: "r1",
      projectRoot: makeTempDir(),
      definition: { provider: "zigma-workspace", repository: "https://example.com/x/y.git", base: "main" },
    });

    expect(calls[1]?.args).toContain("https://example.com/x/y.git");
  });

  it("maps prepareJob flags and resolves the expected head from the Run workspace", async () => {
    const root = makeTempDir();
    const runPath = join(root, "run-ws");
    mkdirSync(runPath, { recursive: true });
    const heads: string[] = [];
    const { calls, runCli } = routedRunner();
    const provider = await makeProvider(runCli, async (path) => {
      heads.push(path);
      return "d".repeat(40);
    });

    const input: PrepareJobWorkspaceInput = {
      operationId: "run:r1:job:impl:attempt:1:create",
      runId: "r1",
      jobId: "impl",
      attempt: 1,
      runWorkspace: { id: "ws-run-1", path: runPath },
      definition: { scope: "job", mode: "writable" },
    };
    const handle = await provider.prepareJob(input);

    expect(heads).toEqual([runPath]);
    expect(calls[1]?.args).toEqual([
      "prepare-job",
      "--operation-id", "run:r1:job:impl:attempt:1:create",
      "--run", "r1",
      "--run-workspace", "ws-run-1",
      "--job", "impl",
      "--attempt", "1",
      "--expected-head", "d".repeat(40),
      "--json",
    ]);
    expect(handle).toEqual({
      id: "ws-job-1",
      path: PREPARE_JOB_DATA.path,
      branch: "job/r1/impl/a1",
      baseCommit: "b".repeat(40),
    });
  });

  it("forwards the caller AbortSignal to the spawn", async () => {
    const { calls, runCli } = routedRunner();
    const provider = await makeProvider(runCli);
    const controller = new AbortController();

    await provider.prepareRun({
      operationId: "run:r1:create",
      runId: "r1",
      projectRoot: makeTempDir(),
      definition: { provider: "zigma-workspace", repository: ".", base: "main" },
      signal: controller.signal,
    });

    expect(calls[1]?.opts?.signal).toBe(controller.signal);
  });

  it("surfaces a provider error envelope as a ValidationError with the provider code", async () => {
    const { runCli } = routedRunner({
      "prepare-job": { exitCode: 1, stdout: errEnvelope("WORKSPACE_HEAD_CONFLICT", "Run HEAD moved") },
    });
    const provider = await makeProvider(runCli);

    const err = await expectValidationError(() =>
      provider.prepareJob({
        operationId: "run:r1:job:impl:attempt:1:create",
        runId: "r1",
        jobId: "impl",
        attempt: 1,
        runWorkspace: { id: "ws-run-1", path: makeTempDir() },
        definition: { scope: "job" },
      }),
    );
    expect(err.details).toMatchObject({ operation: "prepare-job", providerCode: "WORKSPACE_HEAD_CONFLICT" });
  });

  it("rejects a success envelope missing required handle fields", async () => {
    const { runCli } = routedRunner({
      "prepare-run": { stdout: okEnvelope({ workspace_id: "ws-run-1" }) }, // path missing
    });
    const provider = await makeProvider(runCli);
    const err = await expectValidationError(() =>
      provider.prepareRun({
        operationId: "run:r1:create",
        runId: "r1",
        projectRoot: makeTempDir(),
        definition: { provider: "zigma-workspace", repository: ".", base: "main" },
      }),
    );
    expect(err.message).toContain('"path"');
  });

  it("fails closed when the caller operationId diverges from the reserved run:<id>:* namespace", async () => {
    const { calls, runCli } = routedRunner();
    const provider = await makeProvider(runCli);

    const err = await expectValidationError(() =>
      provider.prepareRun({
        operationId: "core:workspace:create:r1",
        runId: "r1",
        projectRoot: makeTempDir(),
        definition: { provider: "zigma-workspace", repository: ".", base: "main" },
      }),
    );
    expect(err.details).toMatchObject({ expectedOperationId: "run:r1:create" });
    expect(calls).toHaveLength(1); // negotiation only — no prepare spawn
  });

  it("fails closed when the caller job operationId diverges from the reserved namespace", async () => {
    const { runCli } = routedRunner();
    const provider = await makeProvider(runCli);

    const err = await expectValidationError(() =>
      provider.prepareJob({
        operationId: "run:r1:job:other:attempt:9:create",
        runId: "r1",
        jobId: "impl",
        attempt: 1,
        runWorkspace: { id: "ws-run-1", path: makeTempDir() },
        definition: { scope: "job" },
      }),
    );
    expect(err.details).toMatchObject({
      expectedOperationId: "run:r1:job:impl:attempt:1:create",
    });
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspaceHead (default git-backed implementation)
// ---------------------------------------------------------------------------

describe("resolveWorkspaceHead", () => {
  it("returns the full 40-hex HEAD of a real git repository", async () => {
    const repo = makeTempDir();
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "bridge@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Bridge test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# repo\n", "utf-8");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });

    const head = await resolveWorkspaceHead(repo);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("throws a typed error for a directory that is not a git repository", async () => {
    const dir = makeTempDir();
    const err = await expectValidationError(() => resolveWorkspaceHead(dir));
    expect(err.message).toContain("Run workspace HEAD");
  });
});

// ---------------------------------------------------------------------------
// Env-driven activation over a fake CLI on disk (exercises the execa runner)
// ---------------------------------------------------------------------------

const FAKE_CLI_SOURCE = `
const { appendFileSync } = require("node:fs");
const log = process.env["FAKE_CLI_LOG"];
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
const args = process.argv.slice(2);
const mode = process.env["FAKE_CONTRACT"] ?? "valid";
if (args.includes("contract-info")) {
  const data = mode === "old"
    ? { provider: "zigma-workspace", package_version: "0.1.0", contract_version: 1, capabilities: [] }
    : mode === "unsupported"
      ? { provider: "zigma-workspace", package_version: "0.1.5", contract_version: 1, capabilities: ["workspace-prepare-run-v1"], managed_supported: false, managed_required_capabilities: [] }
      : { provider: "zigma-workspace", package_version: "0.1.5", contract_version: 1, capabilities: ["workspace-prepare-run-v1", "workspace-prepare-job-v1"], managed_supported: true, managed_required_capabilities: ["workspace-prepare-run-v1", "workspace-prepare-job-v1"] };
  console.log(JSON.stringify({ contract_version: 1, ok: true, data }));
  process.exit(0);
}
process.exit(2);
`;

function writeFakeCli(): string {
  const dir = makeTempDir();
  const cliPath = join(dir, "zigma-fake-cli.cjs");
  writeFileSync(cliPath, FAKE_CLI_SOURCE, "utf-8");
  return cliPath;
}

describe("createWorkspaceProviderFromEnv", () => {
  it("returns undefined when ZIGMA_WORKSPACE_CLI_PATH is unset", async () => {
    vi.stubEnv("ZIGMA_WORKSPACE_CLI_PATH", undefined);
    await expect(createWorkspaceProviderFromEnv()).resolves.toBeUndefined();
  });

  it("negotiates and constructs a provider when the env var points at a compatible CLI", async () => {
    vi.stubEnv("ZIGMA_WORKSPACE_CLI_PATH", writeFakeCli());
    const provider = await createWorkspaceProviderFromEnv();
    expect(provider).toBeDefined();
    expect(typeof provider?.prepareRun).toBe("function");
    expect(typeof provider?.prepareJob).toBe("function");
  });

  it("fails closed when the env var points at an old CLI without managed_supported", async () => {
    vi.stubEnv("ZIGMA_WORKSPACE_CLI_PATH", writeFakeCli());
    vi.stubEnv("FAKE_CONTRACT", "old");
    await expect(createWorkspaceProviderFromEnv()).rejects.toBeInstanceOf(ValidationError);
  });

  it("fails closed when the CLI reports managed mode unsupported", async () => {
    vi.stubEnv("ZIGMA_WORKSPACE_CLI_PATH", writeFakeCli());
    vi.stubEnv("FAKE_CONTRACT", "unsupported");
    await expect(createWorkspaceProviderFromEnv()).rejects.toBeInstanceOf(ValidationError);
  });

  it("passes ZIGMA_WORKSPACE_STATE_DIR through as the global --state-dir option", async () => {
    const logPath = join(makeTempDir(), "args.log");
    vi.stubEnv("ZIGMA_WORKSPACE_CLI_PATH", writeFakeCli());
    vi.stubEnv("ZIGMA_WORKSPACE_STATE_DIR", "S:\\state\\dir");
    vi.stubEnv("FAKE_CLI_LOG", logPath);

    await createWorkspaceProviderFromEnv();

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const first = JSON.parse(lines[0]!) as string[];
    expect(first.slice(0, 2)).toEqual(["--state-dir", "S:\\state\\dir"]);
    expect(first[2]).toBe("contract-info");
  });
});
