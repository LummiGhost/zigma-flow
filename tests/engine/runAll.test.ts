/**
 * `runAll` tests for WF-P13-ENGINE-RUNALL (Step 1 — Cases and Tests).
 *
 * Exercises the new Engine entry point that replaces the main loop in
 * `src/commands/run-all.ts`. `runAll(opts: RunAllOpts): Promise<RunAllSummary>`
 * is the sole place where the run-state transition loop lives, making it
 * callable directly from tests without CLI dependencies.
 *
 * Covers:
 *   - T-RUNALL-1:  Happy path — single agent job (no-signal report)
 *                  completes via fake backend; summary has status=completed.
 *   - T-RUNALL-2:  Empty job list — workflow with activation-only jobs
 *                  terminates cleanly; summary has 0 iterations.
 *   - T-RUNALL-3:  MAX_ITERATIONS guard — loop exits after reaching
 *                  maxIterations; status is undefined (not terminal).
 *   - T-RUNALL-4:  Injectable clock — FakeClock timestamps appear in
 *                  events and state.
 *   - T-RUNALL-5:  Summary shape — returned value has correct
 *                  RunAllSummary fields (runId, status, jobs, iterations).
 *   - T-RUNALL-6:  Resume via runId — loop reads existing state, does
 *                  not call createRun, completes remaining work.
 *   - T-RUNALL-7:  Backend resolver — mock resolver receives step-level
 *                  backend name when specified.
 *   - T-RUNALL-8:  Script step delegation — script job completes via
 *                  executeCurrentStep through the runAll loop.
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-engine-runall/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md §5
 *   - docs/prd.md §24
 *   - docs/mvp-contracts.md §2.3, §2.4
 *
 * Red-phase note: `src/engine/runAll.ts` does not yet exist. The lazy
 * import wrapper below catches the dynamic-import failure and re-throws
 * a descriptive Error so the test file compiles and every test in this
 * file fails for the same diagnostic reason until WF-P13-ENGINE-RUNALL
 * Step 2 ships the module.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { JsonlEventWriter, LocalStateStore } from "../../src/run/index.js";
import type { AgentBackend, AgentBackendConfig, AgentExecuteOptions, AgentExecuteResult } from "../../src/agent/index.js";
import type { ZigmaFlowEvent } from "../../src/events/index.js";

// ---------------------------------------------------------------------------
// Types for the module under design (src/engine/runAll.ts)
// ---------------------------------------------------------------------------

export interface RunAllOpts {
  task?: string;
  runId?: string;
  workflowPath: string;
  runsDir: string;
  zigmaflowDir: string;
  skillLockPath: string;
  backendResolver: (stepBackendName?: string) => AgentBackend;
  clock?: Clock;
  signal?: AbortSignal;
  maxIterations?: number;
  onEvent?: (e: ZigmaFlowEvent) => void;
}

export interface RunAllSummary {
  runId: string;
  status?: string;
  jobs: Array<{ id: string; status: string; attempts: number }>;
  iterations: number;
}

// ---------------------------------------------------------------------------
// Lazy import — red-phase wrapper
// ---------------------------------------------------------------------------

const RUN_ALL_SPECIFIER = "../../src/engine/runAll.js";

async function callRunAll(opts: RunAllOpts): Promise<RunAllSummary> {
  let mod: { runAll?: (o: RunAllOpts) => Promise<RunAllSummary> };
  try {
    mod = (await import(/* @vite-ignore */ String(RUN_ALL_SPECIFIER))) as {
      runAll?: (o: RunAllOpts) => Promise<RunAllSummary>;
    };
  } catch (e: unknown) {
    throw new Error(
      `runAll is not yet implemented — src/engine/runAll.ts does not exist (WF-P13-ENGINE-RUNALL Step 2 has not yet shipped). Underlying: ${String(e)}`
    );
  }
  if (typeof mod.runAll !== "function") {
    throw new Error(
      "runAll is not exported from src/engine/runAll.ts — WF-P13-ENGINE-RUNALL Step 2 has not yet shipped the implementation."
    );
  }
  return mod.runAll(opts);
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-27T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * A fake AgentBackend that writes a valid no-signal report.json and
 * returns success. Records calls for assertion.
 */
class FakeBackend implements AgentBackend {
  readonly name = "fake-runall";
  static calls: AgentExecuteOptions[] = [];

  constructor(_config: AgentBackendConfig) {}

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    FakeBackend.calls.push(opts);
    await mkdir(dirname(opts.reportPath), { recursive: true });
    await writeFile(
      opts.reportPath,
      JSON.stringify(
        {
          outputs: { completed: true },
          artifacts: [],
          signals: [],
          summary: "fake backend executed successfully",
        },
        null,
        2
      ),
      "utf-8"
    );
    return { success: true, reportPath: opts.reportPath };
  }
}

/**
 * A stale FakeBackend — does NOT advance the job. Used by MAX_ITERATIONS
 * tests to keep the job in "ready" state across loop iterations.
 */
class StaleFakeBackend implements AgentBackend {
  readonly name = "fake-stale";
  static calls: AgentExecuteOptions[] = [];

  constructor(_config: AgentBackendConfig) {}

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    StaleFakeBackend.calls.push(opts);
    // Write a report that does NOT signal completion — the job stays ready.
    await mkdir(dirname(opts.reportPath), { recursive: true });
    await writeFile(
      opts.reportPath,
      JSON.stringify(
        {
          outputs: { still_running: true },
          artifacts: [],
          signals: [],
          summary: "fake backend executed but job not done",
        },
        null,
        2
      ),
      "utf-8"
    );
    return { success: true, reportPath: opts.reportPath };
  }
}

// ---------------------------------------------------------------------------
// Workflow YAML fixtures
// ---------------------------------------------------------------------------

/** Single agent job with one agent step. The happy-path fixture. */
const SINGLE_AGENT_YAML = `\
name: runall-single-agent
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: analyze
        type: agent
        uses: zigma/analyze-skill
`;

/** Single script job — exercises the non-agent delegation path. */
const SINGLE_SCRIPT_YAML = `\
name: runall-single-script
version: "0.1.0"
jobs:
  build:
    steps:
      - id: compile
        type: script
        run: "echo hello"
`;

/** All jobs have activation — no job is initially ready. */
const ALL_INACTIVE_YAML = `\
name: runall-all-inactive
version: "0.1.0"
jobs:
  lint:
    activation: manual
    steps:
      - id: lint-step
        type: agent
        uses: zigma/lint-skill
  deploy:
    activation: manual
    steps:
      - id: deploy-step
        type: agent
        uses: zigma/deploy-skill
`;

/** Multi-step job with agent → script → router flow. */
const AGENT_SCRIPT_ROUTER_YAML = `\
name: runall-multi-step
version: "0.1.0"
jobs:
  pipeline:
    steps:
      - id: plan
        type: agent
        uses: zigma/plan-skill
      - id: build
        type: script
        run: "echo build"
      - id: route
        type: router
        switch: "\${{ steps.build.outputs.exit_code }}"
        cases:
          "0": continue
          default: fail
`;

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  dotZigma: string;
  configPath: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-runall-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const configPath = join(dotZigma, "config.json");
  const skillLockPath = join(dotZigma, "skill-lock.json");

  await mkdir(runsDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ tool_version: "0.1.0", active_run: null }, null, 2),
    "utf-8"
  );
  await writeFile(skillLockPath, JSON.stringify({ skills: {} }, null, 2), "utf-8");

  return {
    projectRoot,
    zigmaflowDir: projectRoot,
    dotZigma,
    configPath,
    runsDir,
    skillLockPath,
  };
}

async function bootstrapRun(
  sandbox: Sandbox,
  yamlBody: string,
  workflowName: string,
  task: string = `exercise ${workflowName}`
): Promise<{ runId: string; runDir: string; workflowPath: string }> {
  const workflowPath = join(sandbox.projectRoot, `${workflowName}.yml`);
  await writeFile(workflowPath, yamlBody, "utf-8");

  const { runId } = await createRun({
    workflowPath,
    task,
    runsDir: sandbox.runsDir,
    skillLockPath: sandbox.skillLockPath,
    clock: new FakeClock(),
  });
  const runDir = join(sandbox.runsDir, runId);
  return { runId, runDir, workflowPath };
}

interface EventRecord {
  id: string;
  type: string;
  run_id: string;
  job: string | null;
  step: string | null;
  attempt: number | null;
  timestamp: string;
  payload: Record<string, unknown>;
}

async function readEvents(runDir: string): Promise<EventRecord[]> {
  try {
    const text = await readFile(join(runDir, "events.jsonl"), "utf-8");
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as EventRecord);
  } catch {
    return [];
  }
}

async function readStateSnapshot(runDir: string): Promise<RunState> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) {
    throw new Error(`state.json missing at ${runDir}`);
  }
  return snap;
}

// ---------------------------------------------------------------------------
// T-RUNALL-1: Happy path — single agent job completes
// ---------------------------------------------------------------------------

describe("runAll — happy path (T-RUNALL-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.calls = [];
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "completes a single-agent-job workflow and returns summary with status=completed (T-RUNALL-1, UC-RUNALL-001, UC-RUNALL-002, FP-RUNALL-HAPPY)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, SINGLE_AGENT_YAML, "runall-single-agent");

      // Clean up the precreated run directory so runAll creates its own.
      await rm(_precreatedRunDir, { recursive: true, force: true });

      const summary = await callRunAll({
        task: "exercise single agent",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
      });

      // Summary checks
      expect(summary.runId).toBeTruthy();
      expect(summary.status).toBe("completed");
      expect(summary.jobs).toHaveLength(1);
      expect(summary.jobs[0]!.id).toBe("intake");
      expect(summary.jobs[0]!.status).toBe("completed");
      expect(summary.jobs[0]!.attempts).toBe(1);
      expect(summary.iterations).toBeGreaterThan(0);

      // Backend was called
      expect(FakeBackend.calls).toHaveLength(1);
      expect(FakeBackend.calls[0]!.prompt).toContain("agent");

      // Verify events
      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("run_created");
      expect(eventTypes).toContain("job_ready");
      expect(eventTypes).toContain("prompt_generated");

      // Verify state
      const state = await readStateSnapshot(runDir);
      expect(state.status).toBe("completed");
      expect(state.jobs["intake"]!.status).toBe("completed");
    }
  );
});

// ---------------------------------------------------------------------------
// T-RUNALL-2: Empty job list — no ready jobs terminates cleanly
// ---------------------------------------------------------------------------

describe("runAll — empty ready jobs (T-RUNALL-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.calls = [];
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "terminates cleanly when all jobs are inactive; summary has 0 iterations (T-RUNALL-2, UC-RUNALL-004, FP-RUNALL-EMPTY)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, ALL_INACTIVE_YAML, "runall-all-inactive");

      // Clean up the precreated run directory so runAll creates its own.
      await rm(_precreatedRunDir, { recursive: true, force: true });

      const summary = await callRunAll({
        task: "exercise all inactive",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
      });

      expect(summary.runId).toBeTruthy();
      // No terminal status — the loop exits because no jobs are ready
      expect(summary.status).toBeUndefined();
      expect(summary.iterations).toBe(0);

      // Backend was never called (no ready jobs)
      expect(FakeBackend.calls).toHaveLength(0);

      // State has all jobs as inactive
      const runDir = join(sandbox.runsDir, summary.runId);
      const state = await readStateSnapshot(runDir);
      expect(state.jobs["lint"]!.status).toBe("inactive");
      expect(state.jobs["deploy"]!.status).toBe("inactive");
    }
  );
});

// ---------------------------------------------------------------------------
// T-RUNALL-3: MAX_ITERATIONS guard
// ---------------------------------------------------------------------------

describe("runAll — MAX_ITERATIONS guard (T-RUNALL-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    StaleFakeBackend.calls = [];
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "exits loop after maxIterations and returns summary with iterations===maxIterations (T-RUNALL-3, UC-RUNALL-005, FP-RUNALL-MAX-ITER)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, SINGLE_AGENT_YAML, "runall-single-agent");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const maxIterations = 3;

      const summary = await callRunAll({
        task: "exercise max iter",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new StaleFakeBackend({ command: "fake" }),
        clock: new FakeClock(),
        maxIterations,
      });

      expect(summary.runId).toBeTruthy();
      // Loop was exhausted, not a terminal state
      expect(summary.status).toBeUndefined();
      expect(summary.iterations).toBe(maxIterations);

      // Backend was called exactly maxIterations times
      expect(StaleFakeBackend.calls).toHaveLength(maxIterations);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RUNALL-4: Injectable clock
// ---------------------------------------------------------------------------

describe("runAll — injectable clock (T-RUNALL-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.calls = [];
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "uses FakeClock timestamps in events (T-RUNALL-4, UC-RUNALL-007, FP-RUNALL-INJECT)",
    async () => {
      const customIso = "2026-07-04T12:00:00.000Z";
      const clock = new FakeClock(customIso);

      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, SINGLE_AGENT_YAML, "runall-single-agent");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const summary = await callRunAll({
        task: "exercise clock injection",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock,
      });

      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.timestamp).toBe(customIso);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-RUNALL-5: Summary shape
// ---------------------------------------------------------------------------

describe("runAll — summary shape (T-RUNALL-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.calls = [];
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "returns RunAllSummary with correct fields (T-RUNALL-5, UC-RUNALL-006, FP-RUNALL-SUMMARY)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, SINGLE_AGENT_YAML, "runall-single-agent");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const summary = await callRunAll({
        task: "exercise summary shape",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
      });

      // Structural assertions
      expect(typeof summary.runId).toBe("string");
      expect(summary.runId.length).toBeGreaterThan(0);
      expect(["completed", undefined]).toContain(summary.status);
      expect(Array.isArray(summary.jobs)).toBe(true);
      expect(typeof summary.iterations).toBe("number");

      // Each job entry shape
      for (const job of summary.jobs) {
        expect(typeof job.id).toBe("string");
        expect(typeof job.status).toBe("string");
        expect(typeof job.attempts).toBe("number");
        expect(job.attempts).toBeGreaterThan(0);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-RUNALL-6: Resume via runId
// ---------------------------------------------------------------------------

describe("runAll — resume via runId (T-RUNALL-6)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.calls = [];
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "resumes from an existing run via runId without emitting run_created (T-RUNALL-6, UC-RUNALL-003, FP-RUNALL-IDEMPOTENT)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SINGLE_AGENT_YAML,
        "runall-resume"
      );

      // Count events before resume (run_created + job_ready)
      const eventsBefore = await readEvents(runDir);
      const typesBefore = eventsBefore.map((e) => e.type);
      expect(typesBefore).toContain("run_created");
      expect(typesBefore).toContain("job_ready");

      const summary = await callRunAll({
        runId,
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
      });

      expect(summary.runId).toBe(runId);

      // No second run_created
      const eventsAfter = await readEvents(runDir);
      const runCreatedCount = eventsAfter.filter((e) => e.type === "run_created").length;
      expect(runCreatedCount).toBe(1);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RUNALL-7: Backend resolver receives step backend name
// ---------------------------------------------------------------------------

describe("runAll — backend resolver (T-RUNALL-7)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.calls = [];
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "calls backendResolver with undefined for default backend (T-RUNALL-7, UC-RUNALL-009, FP-RUNALL-BACKEND)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, SINGLE_AGENT_YAML, "runall-single-agent");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const resolverCalls: Array<string | undefined> = [];
      const backend = new FakeBackend({ command: "fake" });

      await callRunAll({
        task: "exercise resolver",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: (name?: string) => {
          resolverCalls.push(name);
          return backend;
        },
        clock: new FakeClock(),
      });

      // For a workflow with no step-level backend, resolver is called
      // with undefined (use default).
      expect(resolverCalls.length).toBeGreaterThan(0);
      expect(resolverCalls[0]).toBeUndefined();
    }
  );
});

// ---------------------------------------------------------------------------
// T-RUNALL-8: Script step delegation
// ---------------------------------------------------------------------------

describe("runAll — script step delegation (T-RUNALL-8)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "completes a single-script-job workflow via executeCurrentStep delegation (T-RUNALL-8, UC-RUNALL-010, FP-RUNALL-DELEGATE)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, SINGLE_SCRIPT_YAML, "runall-single-script");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const summary = await callRunAll({
        task: "exercise script delegation",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
      });

      expect(summary.runId).toBeTruthy();
      // Script-only workflow: job completes, run completes
      expect(summary.status).toBe("completed");
      expect(summary.jobs).toHaveLength(1);
      expect(summary.jobs[0]!.id).toBe("build");
      expect(summary.jobs[0]!.status).toBe("completed");

      // Verify events include script_completed
      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("script_completed");
      expect(eventTypes).toContain("job_completed");
      expect(eventTypes).toContain("run_completed");
    }
  );
});
