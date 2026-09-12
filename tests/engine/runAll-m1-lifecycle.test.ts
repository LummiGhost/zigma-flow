/**
 * M1 lifecycle regression coverage.
 *
 * These cases deliberately exercise the boundaries that are unsafe to infer
 * from a recorded run_cancelled event alone: live invocation control, writer
 * failure propagation, and the managed workspace execution context.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentBackend, AgentExecuteOptions, AgentExecuteResult } from "../../src/agent/index.js";
import { createRun, runAll } from "../../src/engine/index.js";
import { requestInvocationCancellation } from "../../src/run/invocationControl.js";
import type { Clock } from "../../src/run/index.js";
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
} from "../../src/workspace/index.js";

const ISO = "2026-09-05T00:00:00.000Z";

class FixedClock implements Clock {
  now(): string {
    return ISO;
  }
}

interface Sandbox {
  projectRoot: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-m1-lifecycle-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const skillLockPath = join(dotZigma, "skill-lock.json");
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(dotZigma, "config.json"), JSON.stringify({ tool_version: "0.8.12" }), "utf-8");
  await writeFile(skillLockPath, JSON.stringify({ skills: {} }), "utf-8");
  return { projectRoot, runsDir, skillLockPath };
}

async function writeWorkflow(sandbox: Sandbox, name: string, body: string): Promise<string> {
  const path = join(sandbox.projectRoot, `${name}.yml`);
  await writeFile(path, body, "utf-8");
  return path;
}

async function waitForSingleRunId(runsDir: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const entries = await readdir(runsDir);
    if (entries.length === 1) return entries[0]!;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a Flow run directory");
}

class AbortAwareBackend implements AgentBackend {
  readonly name = "abort-aware";
  readonly supportsOutputSchema = true;
  readonly started: Promise<void>;
  private signalStarted!: () => void;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.signalStarted = resolve;
    });
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    await mkdir(opts.stepDir, { recursive: true });
    this.signalStarted();
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) {
        resolve();
        return;
      }
      opts.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return { success: false, error: "agent observed cancellation", durationMs: 1 };
  }
}

class CapturingBackend implements AgentBackend {
  readonly name = "capturing";
  readonly supportsOutputSchema = true;
  readonly projectRoots: string[] = [];

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    this.projectRoots.push(opts.projectRoot);
    await mkdir(opts.stepDir, { recursive: true });
    await writeFile(opts.reportPath, JSON.stringify({
      outputs: {}, artifacts: [], signals: [], summary: "ok",
    }), "utf-8");
    return { success: true, reportPath: opts.reportPath, durationMs: 1 };
  }
}

interface TestWorkspaceBehavior {
  /** Job ids whose integrate resolves as a typed merge conflict (M4). */
  conflictForJobIds?: readonly string[];
  publish?: "ok" | "throw";
  /** Row-level retention echoed back by prepareRun (M4). */
  runRetention?: WorkspaceHandle["retention"];
}

class TestWorkspaceProvider implements WorkspaceProvider {
  readonly runInputs: PrepareRunWorkspaceInput[] = [];
  readonly jobInputs: PrepareJobWorkspaceInput[] = [];
  readonly jobPaths = new Map<string, string>();
  readonly commitCalls: CommitJobInput[] = [];
  readonly integrateCalls: IntegrateJobInput[] = [];
  readonly publishCalls: PublishRunInput[] = [];
  readonly reconcileCalls: ReconcileRunInput[] = [];
  readonly cleanupCalls: CleanupRunInput[] = [];
  /** Global call order across the whole lifecycle (M4 teardown ordering). */
  readonly lifecycleOrder: string[] = [];

  constructor(
    private readonly root: string,
    private readonly behavior: TestWorkspaceBehavior = {},
  ) {}

  async prepareRun(input: PrepareRunWorkspaceInput): Promise<WorkspaceHandle> {
    this.runInputs.push(input);
    const path = join(this.root, "run-workspace");
    await mkdir(path, { recursive: true });
    const handle: WorkspaceHandle = { id: "run-workspace", path };
    if (this.behavior.runRetention !== undefined) {
      handle.retention = this.behavior.runRetention;
    }
    return handle;
  }

  async prepareJob(input: PrepareJobWorkspaceInput): Promise<WorkspaceHandle> {
    this.jobInputs.push(input);
    const path = join(this.root, `job-${input.jobId}-attempt-${input.attempt}`);
    await mkdir(path, { recursive: true });
    if (input.jobId === "check") {
      await writeFile(join(path, "check-target.txt"), "present", "utf-8");
    }
    this.jobPaths.set(input.jobId, path);
    return { id: `job-${input.jobId}-${input.attempt}`, path };
  }

  async commitJob(input: CommitJobInput): Promise<CommitJobResult> {
    this.commitCalls.push(input);
    this.lifecycleOrder.push(`commit:${input.jobId}`);
    return {
      operationId: input.operationId,
      workspaceId: input.jobWorkspace.id,
      baseCommit: "base-commit",
      headCommit: "head-commit",
      changedFiles: [],
      evidenceDigest: "sha256:test",
      noOp: false,
    };
  }

  async integrateJob(input: IntegrateJobInput): Promise<IntegrateJobResult> {
    this.integrateCalls.push(input);
    this.lifecycleOrder.push(`integrate:${input.jobId}`);
    if (this.behavior.conflictForJobIds?.includes(input.jobId)) {
      return {
        status: "conflicted",
        operationId: input.operationId,
        sourceWorkspaceId: input.jobWorkspace.id,
        targetWorkspaceId: input.runWorkspace.id,
        conflictFiles: ["conflict.txt"],
        jobCommit: "job-head",
        runHead: "run-head",
        message: "merge conflict",
      };
    }
    return {
      status: "merged",
      operationId: input.operationId,
      sourceWorkspaceId: input.jobWorkspace.id,
      targetWorkspaceId: input.runWorkspace.id,
      sourceCommit: "job-head",
      previousTargetHead: "run-head",
      resultingCommit: "merged-head",
      changedFiles: [],
    };
  }

  async publishRun(input: PublishRunInput): Promise<PublishRunResult> {
    this.publishCalls.push(input);
    this.lifecycleOrder.push("publish");
    if (this.behavior.publish === "throw") {
      throw new Error("publish transport failure");
    }
    return {
      operationId: input.operationId,
      workspaceId: input.workspace.id,
      strategy: input.strategy,
      resultingRef: input.strategy === "branch" ? input.targetRef : null,
      resultingCommit: "published-head",
      previousRef: null,
      changedFiles: [],
    };
  }

  async reconcileRun(input: ReconcileRunInput): Promise<ReconcileRunResult> {
    this.reconcileCalls.push(input);
    this.lifecycleOrder.push("reconcile");
    return {
      workspaceId: input.workspace.id,
      registryStatus: "active",
      directoryExists: true,
      gitHead: "head-commit",
      manifestExists: true,
      reconciledStatus: "complete",
      recommendation: "no action needed",
    };
  }

  async cleanupRun(input: CleanupRunInput): Promise<CleanupRunResult> {
    this.cleanupCalls.push(input);
    this.lifecycleOrder.push(`cleanup:${input.workspace.id}`);
    return {
      operationId: input.operationId,
      workspaceId: input.workspace.id,
      path: input.workspace.path,
      removed: true,
      status: "CLEANED",
      message: "removed",
      blockers: [],
    };
  }
}

describe("M1 invocation lifecycle", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("routes an external cancellation request to the live invoke owner and acknowledges only after settlement", async () => {
    const workflowPath = await writeWorkflow(sandbox, "cancel", `\
name: m1-cancel
version: "1"
jobs:
  agent:
    steps:
      - id: wait
        type: agent
        allow_generic_prompt: true
        uses: zigma/wait
`);
    const backend = new AbortAwareBackend();
    const runPromise = runAll({
      task: "cancel through the owner channel",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => backend,
      clock: new FixedClock(),
      enableInvocationControl: true,
    });

    await backend.started;
    const runId = await waitForSingleRunId(sandbox.runsDir);
    const cancellation = await requestInvocationCancellation(
      join(sandbox.runsDir, runId),
      runId,
      "M1 regression cancellation",
      5_000,
    );
    const summary = await runPromise;

    expect(cancellation.kind).toBe("acknowledged");
    expect(cancellation.acknowledgement).toMatchObject({
      status: "cancelled",
      quiescent: true,
    });
    expect(summary.status).toBe("cancelled");

    const record = JSON.parse(await readFile(
      join(sandbox.runsDir, runId, ".control", "invoke-owner.json"),
      "utf-8",
    )) as { phase: string; quiescent: boolean };
    expect(record).toEqual(expect.objectContaining({ phase: "quiescent", quiescent: true }));
  }, 15_000);

  it("keeps a primary execution failure while surfacing detached log-write failure at teardown", async () => {
    const workflowPath = await writeWorkflow(sandbox, "primary-failure", `\
name: m1-primary-failure
version: "1"
jobs:
  script:
    steps:
      - id: ok
        type: script
        run: "echo ok"
`);
    const created = await createRun({
      workflowPath,
      task: "prepare failure injection",
      runsDir: sandbox.runsDir,
      skillLockPath: sandbox.skillLockPath,
      clock: new FixedClock(),
    });
    const runDir = join(sandbox.runsDir, created.runId);

    // appendFile(run.log.jsonl) now fails asynchronously, while invalid YAML
    // below remains the primary synchronous execution failure.
    await mkdir(join(runDir, "run.log.jsonl"));
    await writeFile(workflowPath, "name: [not-a-workflow", "utf-8");

    let thrown: unknown;
    try {
      await runAll({
        runId: created.runId,
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.projectRoot,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new CapturingBackend(),
        clock: new FixedClock(),
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toBeInstanceOf(Error);
    expect(aggregate.errors[1]).toBeInstanceOf(AggregateError);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
  });

  it("records a managed job provisioning failure through the Engine instead of retrying a rejected promise", async () => {
    const workspaceRoot = join(sandbox.projectRoot, "provider-failure-run");
    await mkdir(workspaceRoot, { recursive: true });
    const provider: WorkspaceProvider = {
      prepareRun: async () => ({ id: "run", path: workspaceRoot }),
      prepareJob: async () => ({ id: "bad-job", path: "relative-path-is-invalid" }),
      commitJob: async (input) => ({
        operationId: input.operationId,
        workspaceId: input.jobWorkspace.id,
        baseCommit: "b",
        headCommit: "h",
        changedFiles: [],
        evidenceDigest: "d",
        noOp: false,
      }),
      integrateJob: async (input) => ({
        status: "merged" as const,
        operationId: input.operationId,
        sourceWorkspaceId: input.jobWorkspace.id,
        targetWorkspaceId: input.runWorkspace.id,
        sourceCommit: "s",
        previousTargetHead: "p",
        resultingCommit: "r",
        changedFiles: [],
      }),
      publishRun: async (input) => ({
        operationId: input.operationId,
        workspaceId: input.workspace.id,
        strategy: input.strategy,
        resultingRef: null,
        resultingCommit: "r",
        previousRef: null,
        changedFiles: [],
      }),
      reconcileRun: async (input) => ({
        workspaceId: input.workspace.id,
        registryStatus: "active",
        directoryExists: true,
        gitHead: null,
        manifestExists: true,
        reconciledStatus: "complete" as const,
        recommendation: "ok",
      }),
      cleanupRun: async (input) => ({
        operationId: input.operationId,
        workspaceId: input.workspace.id,
        path: input.workspace.path,
        removed: true,
        status: "CLEANED" as const,
        message: "",
        blockers: [],
      }),
    };
    const workflowPath = await writeWorkflow(sandbox, "provider-failure", `\
name: provider-failure
version: "1"
workspace:
  provider: zigma-workspace
  repository: .
  base: main
jobs:
  agent:
    steps:
      - id: ask
        type: agent
        allow_generic_prompt: true
        uses: zigma/agent
`);
    const backend = new CapturingBackend();

    const summary = await runAll({
      task: "provider provisioning failure",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => backend,
      clock: new FixedClock(),
      workspaceProvider: provider,
      maxIterations: 5,
    });

    expect(summary.status).toBe("failed");
    expect(summary.iterations).toBe(1);
    expect(summary.jobs).toEqual([expect.objectContaining({ id: "agent", status: "failed" })]);
    expect(backend.projectRoots).toEqual([]);
  });

  it("uses the provider-resolved absolute workspace for agent, script, check, and router jobs", async () => {
    const workspaceRoot = join(sandbox.projectRoot, "managed-workspaces");
    const provider = new TestWorkspaceProvider(workspaceRoot);
    const backend = new CapturingBackend();
    const workflowPath = await writeWorkflow(sandbox, "managed", `\
name: managed-workspace
version: "1"
workspace:
  provider: zigma-workspace
  repository: .
  base: main
jobs:
  agent:
    steps:
      - id: ask
        type: agent
        allow_generic_prompt: true
        uses: zigma/agent
  script:
    steps:
      - id: cwd
        type: script
        run: >-
          "${process.execPath.replace(/\\/g, "/")}" -e "require('node:fs').writeFileSync('script-cwd.txt', process.cwd())"
  check:
    steps:
      - id: target
        type: check
        uses: zigma/file-exists
        with:
          file: check-target.txt
  route:
    steps:
      - id: decide
        type: router
        switch: approved
        cases:
          approved: continue
`);

    const summary = await runAll({
      task: "managed workspace execution context",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => backend,
      clock: new FixedClock(),
      workspaceProvider: provider,
    });

    expect(summary.status).toBe("completed");
    expect(provider.runInputs).toHaveLength(1);
    expect(provider.runInputs[0]?.projectRoot).toBe(sandbox.projectRoot);
    expect(provider.jobInputs.map((input) => input.jobId).sort()).toEqual(["agent", "check", "route", "script"]);
    expect(backend.projectRoots).toEqual([provider.jobPaths.get("agent")]);
    expect(await readFile(join(provider.jobPaths.get("script")!, "script-cwd.txt"), "utf-8"))
      .toBe(provider.jobPaths.get("script"));
  }, 15_000);

  it("M4: surfaces a workspace merge conflict as a typed job failure while the run continues intact", async () => {
    const workspaceRoot = join(sandbox.projectRoot, "m4-conflict");
    const provider = new TestWorkspaceProvider(workspaceRoot, {
      conflictForJobIds: ["conflicted"],
    });
    const workflowPath = await writeWorkflow(sandbox, "m4-conflict", `\
name: m4-conflict
version: "1"
workspace:
  provider: zigma-workspace
  repository: .
  base: main
jobs:
  clean:
    steps:
      - id: ok
        type: script
        run: echo done
  conflicted:
    steps:
      - id: ok
        type: script
        run: echo done
`);

    const summary = await runAll({
      task: "managed conflict surface",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => new CapturingBackend(),
      clock: new FixedClock(),
      workspaceProvider: provider,
    });

    expect(summary.status).toBe("failed");
    expect(summary.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "clean", status: "completed" }),
      expect.objectContaining({ id: "conflicted", status: "failed" }),
    ]));

    // Both attempts were committed and both integrations attempted; the
    // conflict is typed, not thrown — no engine error replaces the run.
    expect(provider.commitCalls.map((c) => c.jobId).sort()).toEqual(["clean", "conflicted"]);
    expect(provider.integrateCalls).toHaveLength(2);

    const runDir = join(sandbox.runsDir, summary.runId);
    const state = JSON.parse(await readFile(join(runDir, "state.json"), "utf-8")) as {
      jobs: Record<string, {
        status: string;
        attempts?: Array<{ status: string; failure_kind?: string; failure_reason?: string }>;
      }>;
    };
    const conflictedAttempt = state.jobs["conflicted"]?.attempts?.[0];
    expect(conflictedAttempt?.status).toBe("failure");
    expect(conflictedAttempt?.failure_kind).toBe("workspace_merge_conflict");
    expect(conflictedAttempt?.failure_reason).toContain("workspace_merge_conflict");
    expect(conflictedAttempt?.failure_reason).toContain("conflict.txt");

    // Completed attempt workspace released; the failed attempt and the Run
    // workspace itself are retained under the default failure policy.
    expect(provider.cleanupCalls.map((c) => c.workspace.id)).toEqual(["job-clean-1"]);
    expect(provider.reconcileCalls).toHaveLength(1);
  }, 15_000);

  it("M4: fails the run with evidence when managed publish fails", async () => {
    const workspaceRoot = join(sandbox.projectRoot, "m4-publish-fail");
    const provider = new TestWorkspaceProvider(workspaceRoot, { publish: "throw" });
    const workflowPath = await writeWorkflow(sandbox, "m4-publish-fail", `\
name: m4-publish-fail
version: "1"
workspace:
  provider: zigma-workspace
  repository: .
  base: main
  publish:
    strategy: branch
jobs:
  agent:
    steps:
      - id: ask
        type: agent
        allow_generic_prompt: true
        uses: zigma/agent
`);

    const summary = await runAll({
      task: "managed publish failure",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => new CapturingBackend(),
      clock: new FixedClock(),
      workspaceProvider: provider,
    });

    expect(summary.status).toBe("failed");
    expect(provider.publishCalls).toHaveLength(1);
    expect(provider.publishCalls[0]).toMatchObject({
      operationId: `run:${summary.runId}:publish`,
      strategy: "branch",
      targetRef: `flow/${summary.runId}`,
    });

    const runDir = join(sandbox.runsDir, summary.runId);
    const state = JSON.parse(await readFile(join(runDir, "state.json"), "utf-8")) as {
      status: string;
    };
    expect(state.status).toBe("failed");

    const events = (await readFile(join(runDir, "events.jsonl"), "utf-8"))
      .split("\n").filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type: string; payload?: Record<string, unknown> });
    const lastEvent = events[events.length - 1];
    expect(lastEvent?.type).toBe("run_failed");
    expect(String(lastEvent?.payload?.reason)).toContain("workspace publish failed");

    // The Run failed: the attempt workspace was released on success, but the
    // Run workspace itself is retained under the default failure policy.
    expect(provider.cleanupCalls.map((c) => c.workspace.id)).toEqual(["job-agent-1"]);
    expect(provider.reconcileCalls).toHaveLength(1);
  }, 15_000);

  it("M4: runs the finalize gate before goto_job seals the source job completed", async () => {
    const workspaceRoot = join(sandbox.projectRoot, "m4-goto");
    const provider = new TestWorkspaceProvider(workspaceRoot);
    const workflowPath = await writeWorkflow(sandbox, "m4-goto", `\
name: m4-goto
version: "1"
workspace:
  provider: zigma-workspace
  repository: .
  base: main
jobs:
  route:
    steps:
      - id: decide
        type: router
        switch: approved
        cases:
          approved:
            goto_job: target
  target:
    needs: [route]
    steps:
      - id: ok
        type: script
        run: echo done
`);

    const summary = await runAll({
      task: "managed goto finalize",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => new CapturingBackend(),
      clock: new FixedClock(),
      workspaceProvider: provider,
    });

    expect(summary.status).toBe("completed");
    expect(summary.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "route", status: "completed" }),
      expect.objectContaining({ id: "target", status: "completed" }),
    ]));

    // The redirect seals "route" completed — the gate must have committed and
    // integrated its attempt workspace first (completed ⇒ finalize succeeded).
    expect(provider.commitCalls.map((c) => c.jobId).sort()).toEqual(["route", "target"]);
    expect(provider.integrateCalls.map((c) => c.jobId).sort()).toEqual(["route", "target"]);

    const runDir = join(sandbox.runsDir, summary.runId);
    const events = (await readFile(join(runDir, "events.jsonl"), "utf-8"))
      .split("\n").filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type: string; job?: string | null });
    expect(events.some((e) => e.type === "job_skipped" && e.job === "route")).toBe(true);
  }, 15_000);

  it("M4: abandons goto_job when the finalize gate fails and leaves the target untouched", async () => {
    const workspaceRoot = join(sandbox.projectRoot, "m4-goto-conflict");
    const provider = new TestWorkspaceProvider(workspaceRoot, {
      conflictForJobIds: ["route"],
    });
    const workflowPath = await writeWorkflow(sandbox, "m4-goto-conflict", `\
name: m4-goto-conflict
version: "1"
workspace:
  provider: zigma-workspace
  repository: .
  base: main
jobs:
  route:
    steps:
      - id: decide
        type: router
        switch: approved
        cases:
          approved:
            goto_job: target
  target:
    needs: [route]
    steps:
      - id: ok
        type: script
        run: echo done
`);

    const summary = await runAll({
      task: "managed goto conflict",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => new CapturingBackend(),
      clock: new FixedClock(),
      workspaceProvider: provider,
    });

    expect(summary.status).toBe("failed");
    expect(summary.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "route", status: "failed" }),
      expect.objectContaining({ id: "target", status: "blocked" }),
    ]));

    const runDir = join(sandbox.runsDir, summary.runId);
    const state = JSON.parse(await readFile(join(runDir, "state.json"), "utf-8")) as {
      jobs: Record<string, {
        status: string;
        attempts?: Array<{ status: string; failure_kind?: string }>;
      }>;
    };
    const routeAttempt = state.jobs["route"]?.attempts?.[0];
    expect(routeAttempt?.status).toBe("failure");
    expect(routeAttempt?.failure_kind).toBe("workspace_merge_conflict");

    // The gate failed, so the redirect never happened: no job_skipped, no
    // commit/integrate for "target" (it never ran), nothing released.
    const events = (await readFile(join(runDir, "events.jsonl"), "utf-8"))
      .split("\n").filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type: string; job?: string | null });
    expect(events.some((e) => e.type === "job_skipped" && e.job === "route")).toBe(false);
    expect(provider.commitCalls.map((c) => c.jobId)).toEqual(["route"]);
    expect(provider.cleanupCalls).toEqual([]);
  }, 15_000);

  it("M4: reconciles then releases the run workspace in teardown, honoring retention", async () => {
    const workspaceRoot = join(sandbox.projectRoot, "m4-retention-cleanup");
    const provider = new TestWorkspaceProvider(workspaceRoot, {
      runRetention: { success: "cleanup" },
    });
    const workflowPath = await writeWorkflow(sandbox, "m4-retention-cleanup", `\
name: m4-retention-cleanup
version: "1"
workspace:
  provider: zigma-workspace
  repository: .
  base: main
  publish:
    strategy: branch
jobs:
  agent:
    steps:
      - id: ask
        type: agent
        allow_generic_prompt: true
        uses: zigma/agent
`);

    const summary = await runAll({
      task: "managed retention cleanup",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => new CapturingBackend(),
      clock: new FixedClock(),
      workspaceProvider: provider,
    });

    expect(summary.status).toBe("completed");

    // Strict lifecycle ordering: commit → integrate → publish, then teardown
    // reconcile → cleanup, with quiescence and resource drains in between.
    const order = provider.lifecycleOrder;
    expect(order.indexOf("commit:agent")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("integrate:agent")).toBeGreaterThan(order.indexOf("commit:agent"));
    expect(order.indexOf("publish")).toBeGreaterThan(order.indexOf("integrate:agent"));
    expect(order.indexOf("reconcile")).toBeGreaterThan(order.indexOf("publish"));
    expect(order.indexOf("cleanup:run-workspace")).toBeGreaterThan(order.indexOf("reconcile"));

    expect(provider.publishCalls[0]).toMatchObject({
      targetRef: `flow/${summary.runId}`,
    });
    expect(provider.reconcileCalls).toHaveLength(1);
    expect(provider.reconcileCalls[0]?.workspace.id).toBe("run-workspace");
    expect(provider.cleanupCalls.map((c) => c.operationId))
      .toContain(`run:${summary.runId}:cleanup`);
  }, 15_000);

  it("M4: retains the run workspace in teardown when per-workspace retention says retain", async () => {
    const workspaceRoot = join(sandbox.projectRoot, "m4-retention-retain");
    const provider = new TestWorkspaceProvider(workspaceRoot, {
      runRetention: { success: "retain" },
    });
    const workflowPath = await writeWorkflow(sandbox, "m4-retention-retain", `\
name: m4-retention-retain
version: "1"
workspace:
  provider: zigma-workspace
  repository: .
  base: main
jobs:
  agent:
    steps:
      - id: ask
        type: agent
        allow_generic_prompt: true
        uses: zigma/agent
`);

    const summary = await runAll({
      task: "managed retention retain",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => new CapturingBackend(),
      clock: new FixedClock(),
      workspaceProvider: provider,
    });

    expect(summary.status).toBe("completed");
    expect(provider.reconcileCalls).toHaveLength(1);
    // The Run workspace is retained; only the attempt workspace is released.
    expect(provider.cleanupCalls.map((c) => c.operationId)).not
      .toContain(`run:${summary.runId}:cleanup`);
    expect(provider.cleanupCalls.map((c) => c.workspace.id))
      .toEqual(["job-agent-1"]);
  }, 15_000);
});
