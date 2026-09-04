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
  PrepareJobWorkspaceInput,
  PrepareRunWorkspaceInput,
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

class TestWorkspaceProvider implements WorkspaceProvider {
  readonly runInputs: PrepareRunWorkspaceInput[] = [];
  readonly jobInputs: PrepareJobWorkspaceInput[] = [];
  readonly jobPaths = new Map<string, string>();

  constructor(private readonly root: string) {}

  async prepareRun(input: PrepareRunWorkspaceInput): Promise<WorkspaceHandle> {
    this.runInputs.push(input);
    const path = join(this.root, "run-workspace");
    await mkdir(path, { recursive: true });
    return { id: "run-workspace", path };
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

  it("uses the provider-resolved absolute workspace for agent, script, and check jobs", async () => {
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
    expect(provider.jobInputs.map((input) => input.jobId).sort()).toEqual(["agent", "check", "script"]);
    expect(backend.projectRoots).toEqual([provider.jobPaths.get("agent")]);
    expect(await readFile(join(provider.jobPaths.get("script")!, "script-cwd.txt"), "utf-8"))
      .toBe(provider.jobPaths.get("script"));
  }, 15_000);
});
