/** Provider reconciliation V1 contract tests (ISSUE #311). */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectAction } from "../../src/commands/inspect.js";

interface Fixture {
  projectRoot: string;
  runId: string;
  runDir: string;
}

async function makeFixture(): Promise<Fixture> {
  const projectRoot = await mkdtemp(join(tmpdir(), "zigma-provider-reconciliation-"));
  const runId = "runtime-run-311";
  const runDir = join(projectRoot, ".zigma-flow", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "state.json"), JSON.stringify({
    run_id: runId,
    workflow: "reconcile-workflow",
    task: "reconcile an ambiguous provider invocation",
    created_at: "2026-09-05T00:00:00.000Z",
    status: "cancelled",
    last_event_id: "evt-001",
    jobs: {},
  }), "utf8");
  await writeFile(join(runDir, "caller-context.json"), JSON.stringify({
    frozenAt: "2026-09-05T00:00:00.000Z",
    runId,
    callerContext: {
      contractVersion: 1,
      actor: { type: "service", id: "zigma-core" },
      capabilities: ["task:start"],
      constraints: { repositoryIds: [], workflowRefs: [], toolNames: [], branchPatterns: [] },
      source: { kind: "api", metadata: {} },
      taskId: "task-311",
      flowRunId: "core-flow-run-311",
      projectId: "project-311",
      permissionSnapshotId: "permission-311",
      integrityHash: "sha256:311",
      operationId: "operation-311",
      callbackCorrelationId: "callback-311",
    },
  }), "utf8");
  return { projectRoot, runId, runDir };
}

describe("inspect --json provider reconciliation V1", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  });

  it("returns terminal truth, quiescence evidence, and frozen Core correlation without credentials", async () => {
    const controlDir = join(fixture.runDir, ".control");
    const controlPath = join(controlDir, "invoke-owner.json");
    await mkdir(controlDir);
    await writeFile(controlPath, JSON.stringify({
      version: 1,
      phase: "quiescent",
      runId: fixture.runId,
      invocationId: "invocation-311",
      pid: process.pid,
      host: "127.0.0.1",
      port: 12345,
      token: "must-never-be-projected",
      startedAt: "2026-09-05T00:00:00.000Z",
      finishedAt: "2026-09-05T00:01:00.000Z",
      status: "cancelled",
      quiescent: true,
      cleanupErrors: [],
    }), "utf8");
    const before = await readFile(controlPath, "utf8");
    const stdout: string[] = [];

    const result = await inspectAction({
      projectRoot: fixture.projectRoot,
      runId: fixture.runId,
      json: true,
      stdout: (line) => stdout.push(line),
    });

    expect(await readFile(controlPath, "utf8")).toBe(before);
    expect(stdout).toHaveLength(1);
    expect(result.jsonResult).toMatchObject({
      contractVersion: 1,
      command: "inspect",
      status: "success",
      runId: fixture.runId,
      data: {
        reconciliation: {
          contractVersion: 1,
          externalRunId: fixture.runId,
          lifecycle: { status: "cancelled", terminal: true },
          invocation: {
            state: "quiescent",
            invocationId: "invocation-311",
            quiescent: true,
            status: "cancelled",
          },
          callerContext: {
            state: "accepted",
            operationId: "operation-311",
            callbackCorrelationId: "callback-311",
            taskId: "task-311",
            flowRunId: "core-flow-run-311",
            projectId: "project-311",
          },
        },
      },
    });
    expect(stdout[0]).not.toContain("must-never-be-projected");
    expect(stdout[0]).not.toContain('"port"');
  });

  it("reports active, stale, and invalid control evidence without treating it as terminal truth", async () => {
    const controlDir = join(fixture.runDir, ".control");
    const controlPath = join(controlDir, "invoke-owner.json");
    await mkdir(controlDir);
    const active = {
      version: 1,
      phase: "active",
      runId: fixture.runId,
      invocationId: "active-311",
      pid: process.pid,
      host: "127.0.0.1",
      port: 1,
      token: "secret",
      startedAt: "2026-09-05T00:00:00.000Z",
    };
    await writeFile(controlPath, JSON.stringify(active), "utf8");
    await writeFile(join(fixture.runDir, "state.json"), JSON.stringify({
      run_id: fixture.runId,
      workflow: "reconcile-workflow",
      task: "active run",
      created_at: "2026-09-05T00:00:00.000Z",
      status: "running",
      last_event_id: "evt-001",
      jobs: {},
    }), "utf8");

    const activeResult = await inspectAction({ projectRoot: fixture.projectRoot, runId: fixture.runId, json: true, stdout: () => {} });
    expect((activeResult.jsonResult!.data["reconciliation"] as { invocation: unknown; lifecycle: unknown })).toMatchObject({
      invocation: { state: "active", ownerPid: process.pid },
      lifecycle: { status: "running", terminal: false },
    });

    await writeFile(controlPath, JSON.stringify({ ...active, pid: 999_999_999 }), "utf8");
    const staleResult = await inspectAction({ projectRoot: fixture.projectRoot, runId: fixture.runId, json: true, stdout: () => {} });
    expect(staleResult.jsonResult!.data["reconciliation"]).toMatchObject({ invocation: { state: "stale" } });

    await writeFile(controlPath, "not-json", "utf8");
    const invalidResult = await inspectAction({ projectRoot: fixture.projectRoot, runId: fixture.runId, json: true, stdout: () => {} });
    expect(invalidResult.jsonResult!.data["reconciliation"]).toMatchObject({ invocation: { state: "invalid" } });

    await writeFile(controlPath, JSON.stringify({ ...active, host: "192.0.2.1" }), "utf8");
    const unsafeEndpointResult = await inspectAction({ projectRoot: fixture.projectRoot, runId: fixture.runId, json: true, stdout: () => {} });
    expect(unsafeEndpointResult.jsonResult!.data["reconciliation"]).toMatchObject({ invocation: { state: "invalid" } });
  });

  it("does not trust a valid-looking caller context outside a complete frozen snapshot", async () => {
    await writeFile(join(fixture.runDir, "caller-context.json"), JSON.stringify({
      runId: fixture.runId,
      callerContext: {
        contractVersion: 1,
        actor: { type: "service", id: "zigma-core" },
        capabilities: ["task:start"],
        constraints: { repositoryIds: [], workflowRefs: [], toolNames: [], branchPatterns: [] },
        source: { kind: "api", metadata: {} },
        taskId: "task-311",
        flowRunId: "core-flow-run-311",
        projectId: "project-311",
        permissionSnapshotId: "permission-311",
        integrityHash: "sha256:311",
      },
    }), "utf8");

    const result = await inspectAction({ projectRoot: fixture.projectRoot, runId: fixture.runId, json: true, stdout: () => {} });
    expect(result.jsonResult!.data["reconciliation"]).toMatchObject({ callerContext: { state: "invalid" } });
  });

  it("contains missing and invalid run requests in classified V1 envelopes", async () => {
    const missing = await inspectAction({
      projectRoot: fixture.projectRoot,
      runId: "missing-311",
      json: true,
      stdout: () => {},
    });
    expect(missing.jsonResult).toMatchObject({
      contractVersion: 1,
      command: "inspect",
      status: "error",
      runId: "missing-311",
      error: { code: "RUN_NOT_FOUND" },
    });

    const invalid = await inspectAction({
      projectRoot: fixture.projectRoot,
      runId: "..",
      json: true,
      stdout: () => {},
    });
    expect(invalid.jsonResult).toMatchObject({
      status: "error",
      runId: "..",
      error: { code: "INVALID_INPUT" },
    });

    await writeFile(join(fixture.runDir, "state.json"), JSON.stringify({
      run_id: "other-runtime-run",
      workflow: "reconcile-workflow",
      task: "mismatched state",
      created_at: "2026-09-05T00:00:00.000Z",
      last_event_id: "evt-001",
      jobs: {},
    }), "utf8");
    const corrupt = await inspectAction({
      projectRoot: fixture.projectRoot,
      runId: fixture.runId,
      json: true,
      stdout: () => {},
    });
    expect(corrupt.jsonResult).toMatchObject({
      status: "error",
      runId: fixture.runId,
      error: { code: "STATE_CORRUPT" },
    });
  });
});
