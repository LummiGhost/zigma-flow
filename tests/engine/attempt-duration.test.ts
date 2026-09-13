/**
 * Attempt duration tests (Issue #286 Phase 2).
 *
 * Asserts that the attempt_failed / attempt_completed events carry a real
 * wall-clock `duration_ms` (previously hardcoded 0) and that the value
 * equals the sealed attempt's `ended_at − started_at` span from state.json,
 * across every seal site:
 *
 *   - T-DUR-1: full run success      → appendJobCompleted (engine/index.ts)
 *   - T-DUR-2: full run failure      → recordAgentFailure final attempt
 *   - T-DUR-3: direct retryJob       → seal-before-new-attempt + max-exceeded
 *   - T-DUR-4: direct finalizeJobCompletion with failing hook
 *   - T-DUR-5: direct applyRoutingAction retry_job → seal + exhausted
 *
 * Every test shares ONE AdvancingClock instance across createRun and the
 * direct entry-point call — a fresh clock would reset to the base ISO and
 * the defensive attemptDurationMs guard (end < start ⇒ 0) would mask the
 * regression.
 *
 * Helper pattern follows tests/engine/attempt-events.test.ts
 * (createRunAndDir / readStateV7 / findEventsByType).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import { applyRoutingAction } from "../../src/engine/routing.js";
import { retryJob } from "../../src/engine/retryJob.js";
import { finalizeJobCompletion } from "../../src/engine/jobCompletionFinalize.js";
import type { Attempt, Clock, JobState, RunState } from "../../src/run/index.js";
import { JsonlEventWriter, LocalStateStore } from "../../src/run/index.js";
import type {
  AgentBackend,
  AgentBackendConfig,
  AgentExecuteOptions,
  AgentExecuteResult,
} from "../../src/agent/index.js";
import type { StepBackendOverride } from "../../src/agent/config.js";
import type { ZigmaFlowEvent } from "../../src/events/index.js";

// ============================================================================
// Fixtures and helpers
// ============================================================================

const BASE_ISO = "2026-09-13T00:00:00.000Z";

/**
 * Clock whose every now() call advances wall time by stepMs. Sharing one
 * instance across createRun and the direct entry-point call under test
 * guarantees strictly increasing timestamps.
 */
class AdvancingClock implements Clock {
  private currentMs = Date.parse(BASE_ISO);

  constructor(private readonly stepMs = 1000) {}

  now(): string {
    const iso = new Date(this.currentMs).toISOString();
    this.currentMs += this.stepMs;
    return iso;
  }
}

/** Minimal agent backend for full-run tests. */
class StubBackend implements AgentBackend {
  readonly name = "stub-agent";
  readonly supportsOutputSchema = true;
  readonly model: string | undefined;

  constructor(private readonly mode: "success" | "failure", ctorConfig?: AgentBackendConfig) {
    this.model = ctorConfig?.model;
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    await mkdir(opts.stepDir, { recursive: true });
    if (this.mode === "failure") {
      return { success: false, exitCode: 1, error: "stub backend failure" };
    }
    await mkdir(dirname(opts.reportPath), { recursive: true });
    await writeFile(
      opts.reportPath,
      JSON.stringify({ outputs: {}, artifacts: [], signals: [], summary: "ok" }, null, 2),
      "utf-8",
    );
    return { success: true, exitCode: 0, reportPath: opts.reportPath };
  }
}

interface JobStateV7 extends JobState {
  attempts?: Attempt[];
}

interface RunStateV7 extends Omit<RunState, "jobs"> {
  jobs: Record<string, JobStateV7>;
}

async function createRunAndDir(opts: {
  runsDir: string;
  clock: Clock;
  workflowPath: string;
  task: string;
  skillLockPath: string;
}): Promise<string> {
  const result = await createRun({
    runsDir: opts.runsDir,
    clock: opts.clock,
    workflowPath: opts.workflowPath,
    task: opts.task,
    skillLockPath: opts.skillLockPath,
  });
  return join(opts.runsDir, result.runId);
}

async function readEvents(runDir: string): Promise<Array<Record<string, unknown>>> {
  let text: string;
  try {
    text = await readFile(join(runDir, "events.jsonl"), "utf-8");
  } catch {
    return [];
  }
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

async function findEventsByType(
  runDir: string,
  type: string,
): Promise<Array<Record<string, unknown>>> {
  const events = await readEvents(runDir);
  return events.filter((e) => e["type"] === type);
}

async function readStateV7(runDir: string): Promise<RunStateV7> {
  const stateStore = new LocalStateStore();
  const state = await stateStore.readSnapshot(runDir);
  if (state === null) throw new Error("state.json not found");
  return state as unknown as RunStateV7;
}

/** Read the sealed attempt's (ended_at − started_at) span from state, in ms. */
function sealedSpanMs(attempt: Attempt | undefined): number {
  expect(attempt).toBeDefined();
  expect(attempt!.status).toBeDefined();
  expect(attempt!.ended_at).toBeDefined();
  return Date.parse(attempt!.ended_at!) - Date.parse(attempt!.started_at);
}

// --- Full-run (callRunAll) helpers -----------------------------------------

interface RunAllOpts {
  task?: string;
  workflowPath: string;
  runsDir: string;
  zigmaflowDir: string;
  skillLockPath: string;
  backendResolver: (stepBackend?: string | StepBackendOverride) => AgentBackend;
  clock?: Clock;
  maxIterations?: number;
  onEvent?: (e: ZigmaFlowEvent) => void;
}

interface RunAllSummary {
  runId: string;
  status?: string;
  jobs: Array<{ id: string; status: string; attempts: number }>;
  iterations: number;
}

const RUN_ALL_SPECIFIER = "../../src/engine/runAll.js";

async function callRunAll(opts: RunAllOpts): Promise<RunAllSummary> {
  const mod = (await import(/* @vite-ignore */ String(RUN_ALL_SPECIFIER))) as {
    runAll: (o: RunAllOpts) => Promise<RunAllSummary>;
  };
  return mod.runAll(opts);
}

interface Sandbox {
  projectRoot: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-duration-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const skillLockPath = join(dotZigma, "skill-lock.json");

  await mkdir(runsDir, { recursive: true });
  await writeFile(
    join(dotZigma, "config.json"),
    JSON.stringify({ tool_version: "0.1.0", active_run: null }, null, 2),
    "utf-8",
  );
  await writeFile(skillLockPath, JSON.stringify({ skills: {} }, null, 2), "utf-8");

  return { projectRoot, runsDir, skillLockPath };
}

const AGENT_WF_YAML = `\
name: duration-agent
version: "1.0"
jobs:
  main:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
`;

// --- Direct entry-point workflows (script jobs, retryable) -----------------

const RETRYABLE_WF_YAML = `\
name: duration-retryable
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 3
    steps:
      - id: code
        type: script
        run: "echo hello"
`;

const EXHAUSTED_WF_YAML = `\
name: duration-exhausted
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 1
    steps:
      - id: code
        type: script
        run: "echo hello"
`;

// ============================================================================
// T-DUR-1 / T-DUR-2: full run via runAll
// ============================================================================

describe("attempt duration — full run (runAll)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("T-DUR-1: attempt_completed duration equals the sealed attempt span", async () => {
    const workflowPath = join(sandbox.projectRoot, "wf.yml");
    await writeFile(workflowPath, AGENT_WF_YAML, "utf-8");
    const clock = new AdvancingClock();

    const summary = await callRunAll({
      task: "exercise attempt duration success",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => new StubBackend("success"),
      clock,
    });

    expect(summary.status).toBe("completed");

    const runDir = join(sandbox.runsDir, summary.runId);
    const state = await readStateV7(runDir);
    const attempts = state.jobs["main"]!.attempts;
    expect(attempts).toBeDefined();
    const spanMs = sealedSpanMs(attempts!.at(-1));

    const completed = await findEventsByType(runDir, "attempt_completed");
    expect(completed).toHaveLength(1);
    const payload = completed[0]!["payload"] as Record<string, unknown>;
    expect(payload["duration_ms"]).toBeGreaterThan(0);
    expect(payload["duration_ms"]).toBe(spanMs);
  });

  it("T-DUR-2: attempt_failed duration equals the sealed attempt span", async () => {
    const workflowPath = join(sandbox.projectRoot, "wf.yml");
    await writeFile(workflowPath, AGENT_WF_YAML, "utf-8");
    const clock = new AdvancingClock();

    const summary = await callRunAll({
      task: "exercise attempt duration failure",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => new StubBackend("failure"),
      clock,
    });

    const runDir = join(sandbox.runsDir, summary.runId);
    const state = await readStateV7(runDir);
    const attempts = state.jobs["main"]!.attempts;
    expect(attempts).toBeDefined();
    const spanMs = sealedSpanMs(attempts!.at(-1));

    const failed = await findEventsByType(runDir, "attempt_failed");
    expect(failed).toHaveLength(1);
    const payload = failed[0]!["payload"] as Record<string, unknown>;
    expect(payload["duration_ms"]).toBeGreaterThan(0);
    expect(payload["duration_ms"]).toBe(spanMs);
    expect(payload["failure_kind"]).toBe("agent_error");
  });
});

// ============================================================================
// T-DUR-3..T-DUR-5: direct entry points (createRun + retryJob / finalize /
// applyRoutingAction) with ONE shared AdvancingClock per test
// ============================================================================

describe("attempt duration — direct engine entry points", () => {
  let testDir: string;
  let runsDir: string;
  let zigmaDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `zf-attempt-duration-${randomUUID()}`);
    zigmaDir = join(testDir, "repo");
    runsDir = join(zigmaDir, ".zigma-flow", "runs");
    await mkdir(runsDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  it("T-DUR-3a: retryJob seal path duration equals the sealed attempt span", async () => {
    const wfPath = join(testDir, "wf.yaml");
    await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");
    const clock = new AdvancingClock();

    const runDir = await createRunAndDir({
      runsDir,
      clock,
      workflowPath: wfPath,
      task: "test",
      skillLockPath: join(testDir, "skill-lock.json"),
    });

    const stateStore = new LocalStateStore();
    await stateStore.updateState(runDir, (current) => {
      const job = { ...current.jobs["implement"]! };
      job.status = "failed";
      job.attempt = 1;
      return { ...current, jobs: { ...current.jobs, implement: job } };
    });

    await retryJob({
      runDir,
      runId: (await stateStore.readSnapshot(runDir))!.run_id,
      jobId: "implement",
      clock,
      reason: "retry after failure",
    });

    const state = await readStateV7(runDir);
    const attempts = state.jobs["implement"]!.attempts!;
    expect(attempts).toHaveLength(2);
    const spanMs = sealedSpanMs(attempts[0]);

    const failed = await findEventsByType(runDir, "attempt_failed");
    expect(failed).toHaveLength(1);
    const payload = failed[0]!["payload"] as Record<string, unknown>;
    expect(payload["duration_ms"]).toBeGreaterThan(0);
    expect(payload["duration_ms"]).toBe(spanMs);
  });

  it("T-DUR-3b: retryJob max-exceeded path computes duration from the open attempt", async () => {
    const wfPath = join(testDir, "wf.yaml");
    await writeFile(wfPath, EXHAUSTED_WF_YAML, "utf-8");
    const clock = new AdvancingClock();

    const runDir = await createRunAndDir({
      runsDir,
      clock,
      workflowPath: wfPath,
      task: "test",
      skillLockPath: join(testDir, "skill-lock.json"),
    });

    const stateStore = new LocalStateStore();
    await stateStore.updateState(runDir, (current) => {
      const job = { ...current.jobs["implement"]! };
      job.status = "failed";
      job.attempt = 1;
      return { ...current, jobs: { ...current.jobs, implement: job } };
    });

    await retryJob({
      runDir,
      runId: (await stateStore.readSnapshot(runDir))!.run_id,
      jobId: "implement",
      clock,
      reason: "exhausted",
    });

    const state = await readStateV7(runDir);
    const startedAt = state.jobs["implement"]!.attempts![0]!.started_at;

    const failed = await findEventsByType(runDir, "attempt_failed");
    expect(failed).toHaveLength(1);
    const payload = failed[0]!["payload"] as Record<string, unknown>;
    const evt = failed[0]!;
    expect(payload["duration_ms"]).toBeGreaterThan(0);
    // Event timestamp is the sealTime captured for the duration computation.
    expect(payload["duration_ms"]).toBe(
      Date.parse(evt["timestamp"] as string) - Date.parse(startedAt),
    );
  });

  it("T-DUR-4: finalizeJobCompletion failing hook duration equals the sealed attempt span", async () => {
    const wfPath = join(testDir, "wf.yaml");
    await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");
    const clock = new AdvancingClock();

    const runDir = await createRunAndDir({
      runsDir,
      clock,
      workflowPath: wfPath,
      task: "test",
      skillLockPath: join(testDir, "skill-lock.json"),
    });

    const stateStore = new LocalStateStore();
    const before = await readStateV7(runDir);
    const startedAt = before.jobs["implement"]!.attempts![0]!.started_at;

    let eventCounter = 100;
    const ok = await finalizeJobCompletion({
      runDir,
      runId: before.run_id,
      jobId: "implement",
      attempt: 1,
      clock,
      stateStore,
      eventWriter: new JsonlEventWriter(),
      allocateEventId: () => `evt-${String(++eventCounter).padStart(3, "0")}`,
      beforeJobCompleted: async () => ({
        ok: false,
        reason: "finalize failed",
        failureKind: "finalize_error",
      }),
    });

    expect(ok).toBe(false);

    const state = await readStateV7(runDir);
    const attempts = state.jobs["implement"]!.attempts!;
    const spanMs = sealedSpanMs(attempts[0]);

    const failed = await findEventsByType(runDir, "attempt_failed");
    expect(failed).toHaveLength(1);
    const payload = failed[0]!["payload"] as Record<string, unknown>;
    expect(payload["duration_ms"]).toBeGreaterThan(0);
    expect(payload["duration_ms"]).toBe(spanMs);
    expect(spanMs).toBe(Date.parse(attempts[0]!.ended_at!) - Date.parse(startedAt));
  });

  it("T-DUR-5a: applyRoutingAction retry_job seal path duration equals the sealed attempt span", async () => {
    const wfPath = join(testDir, "wf.yaml");
    await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");
    const clock = new AdvancingClock();

    const runDir = await createRunAndDir({
      runsDir,
      clock,
      workflowPath: wfPath,
      task: "test",
      skillLockPath: join(testDir, "skill-lock.json"),
    });

    const stateStore = new LocalStateStore();
    const runId = (await stateStore.readSnapshot(runDir))!.run_id;

    await applyRoutingAction({
      runDir,
      runId,
      sourceJobId: "implement",
      sourceStepId: "code",
      attempt: 1,
      action: { retry_job: "implement" },
      reason: "router triggered retry",
      clock,
    });

    const state = await readStateV7(runDir);
    const attempts = state.jobs["implement"]!.attempts!;
    expect(attempts).toHaveLength(2);
    const spanMs = sealedSpanMs(attempts[0]);

    const failed = await findEventsByType(runDir, "attempt_failed");
    expect(failed).toHaveLength(1);
    const payload = failed[0]!["payload"] as Record<string, unknown>;
    expect(payload["duration_ms"]).toBeGreaterThan(0);
    expect(payload["duration_ms"]).toBe(spanMs);
  });

  it("T-DUR-5b: applyRoutingAction exhausted path seals with a matching duration", async () => {
    const wfPath = join(testDir, "wf.yaml");
    await writeFile(wfPath, EXHAUSTED_WF_YAML, "utf-8");
    const clock = new AdvancingClock();

    const runDir = await createRunAndDir({
      runsDir,
      clock,
      workflowPath: wfPath,
      task: "test",
      skillLockPath: join(testDir, "skill-lock.json"),
    });

    const stateStore = new LocalStateStore();
    const runId = (await stateStore.readSnapshot(runDir))!.run_id;

    await applyRoutingAction({
      runDir,
      runId,
      sourceJobId: "implement",
      sourceStepId: "code",
      attempt: 1,
      action: { retry_job: "implement" },
      reason: "router triggered retry",
      clock,
    });

    const state = await readStateV7(runDir);
    const attempts = state.jobs["implement"]!.attempts!;
    expect(attempts).toHaveLength(1);
    const spanMs = sealedSpanMs(attempts[0]);
    expect(state.jobs["implement"]!.status).toBe("blocked");

    const failed = await findEventsByType(runDir, "attempt_failed");
    expect(failed).toHaveLength(1);
    const payload = failed[0]!["payload"] as Record<string, unknown>;
    expect(payload["duration_ms"]).toBeGreaterThan(0);
    expect(payload["duration_ms"]).toBe(spanMs);
  });
});
