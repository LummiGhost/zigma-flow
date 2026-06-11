/**
 * WF-P10-DOGFOOD — End-to-end integration test for the code-change workflow.
 *
 * Validates that the complete 10-job code-change workflow can be driven
 * from start to finish using the TypeScript engine API, the same pattern
 * as existing tests in tests/engine/*.
 *
 * Test cases:
 *   TC-DOGFOOD-1: runInit creates all scaffold files successfully.
 *   TC-DOGFOOD-2: Workflow YAML is valid (loadWorkflow passes).
 *   TC-DOGFOOD-3: Full happy-path run — all 10 jobs reach "completed"
 *                 (architecture-design stays "inactive").
 *   TC-DOGFOOD-4: review_rejected signal — implement retries (attempt 2)
 *                 when review emits signal.
 *
 * Design notes:
 *   - All state writes and reads go through the real LocalStateStore.
 *   - Agent jobs: set state to "running" + current_step, write report.json,
 *     call acceptAgentReport.
 *   - Script jobs: call executeCurrentStep with a mock ProcessRunner that
 *     returns exit code 0.
 *   - Check job (risk-scan): call executeCurrentStep with a mock CheckRunner
 *     that returns passed=true, matching what the real zigma/file-exists
 *     check would do for path ".".
 *   - After each job completes, dependent "waiting" jobs that now have all
 *     deps completed are promoted to "ready" via LocalStateStore.
 *   - architecture-design is activation: "manual" — never promoted, stays
 *     "inactive".
 *
 * Reference:
 *   - docs/phases/p10-code-change-workflow/workflows/wf-p10-dogfood/
 *   - docs/mvp-contracts.md §2.3, §2.4, §2.6
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { runInit } from "../../src/init/index.js";
import { loadWorkflow } from "../../src/workflow/index.js";
import { createRun, executeCurrentStep } from "../../src/engine/index.js";
import { acceptAgentReport } from "../../src/engine/accept.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import { artifactStepDir } from "../../src/artifact/artifactPaths.js";
import type { ProcessRunner, RunCommandOptions, ScriptRunResult } from "../../src/script/index.js";
import type { CheckRunner, CheckResult, CheckRunnerRunOpts } from "../../src/check/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-11T00:00:00.000Z";

class FakeClock implements Clock {
  now(): string {
    return FIXED_ISO;
  }
}

/**
 * MockProcessRunner: always returns exit code 0 (success), empty stdout/stderr.
 */
class MockProcessRunner implements ProcessRunner {
  async run(_opts: RunCommandOptions): Promise<ScriptRunResult> {
    return {
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      startedAt: FIXED_ISO,
      endedAt: FIXED_ISO,
    };
  }
}

/**
 * MockCheckRunner: always returns passed=true (simulates zigma/file-exists
 * against path "." which always exists).
 */
class MockCheckRunner implements CheckRunner {
  async resolveKind(_checkId: string): Promise<void> {
    // All check kinds accepted.
    return Promise.resolve();
  }

  async run(opts: CheckRunnerRunOpts): Promise<CheckResult> {
    return {
      passed: true,
      check_id: opts.checkId,
      failures: [],
      artifacts: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Sandbox {
  projectDir: string;
  dotZigma: string;
  runsDir: string;
  workflowPath: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectDir = join(tmpdir(), `zigma-dogfood-${randomUUID()}`);
  const dotZigma = join(projectDir, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const workflowPath = join(dotZigma, "workflows", "code-change.yml");
  const skillLockPath = join(dotZigma, "skill-lock.json");
  await mkdir(projectDir, { recursive: true });
  return { projectDir, dotZigma, runsDir, workflowPath, skillLockPath };
}

async function readStateSnapshot(runDir: string): Promise<RunState> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) throw new Error(`state.json missing at ${runDir}`);
  return snap;
}

// Simple DAG job descriptor — using concrete types for exactOptionalPropertyTypes
interface WfJobDesc {
  needs: string[];
  activation: string | null;
}

/**
 * Promote "waiting" jobs to "ready" when all their required deps are
 * "completed" (ignoring optional_needs and inactive jobs).
 *
 * This mimics what a real user would observe after running `zigma-flow status`:
 * dependent jobs become ready once prerequisites complete.
 *
 * architecture-design is skipped — it has activation: "manual" and is never
 * auto-promoted.
 */
async function promoteReadyJobs(
  runDir: string,
  wfJobs: Record<string, WfJobDesc>
): Promise<void> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) throw new Error(`state.json missing at ${runDir}`);

  let mutated = false;
  for (const [jobId, jobDef] of Object.entries(wfJobs)) {
    const jobState = snap.jobs[jobId];
    if (!jobState || jobState.status !== "waiting") continue;
    if (jobDef.activation !== null) continue; // leave inactive/manual jobs alone

    const needs = jobDef.needs;
    const allDepsDone = needs.every((depId) => {
      const depState = snap.jobs[depId];
      return depState?.status === "completed";
    });

    if (allDepsDone) {
      snap.jobs[jobId] = { ...jobState, status: "ready" };
      mutated = true;
    }
  }

  if (mutated) {
    await store.writeSnapshot(runDir, snap);
  }
}

/**
 * Patch a job's state fields via LocalStateStore. Used to set
 * status + current_step + attempt before calling acceptAgentReport.
 */
async function patchJobState(
  runDir: string,
  jobId: string,
  patch: Partial<JobState>
): Promise<void> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) throw new Error(`state.json missing at ${runDir}`);
  const existing = snap.jobs[jobId];
  if (existing === undefined) throw new Error(`job ${jobId} not found`);
  snap.jobs[jobId] = { ...existing, ...patch };
  await store.writeSnapshot(runDir, snap);
}

/**
 * Write a valid minimal report.json at the canonical artifact location for
 * an agent step. Creates the directory if needed.
 */
async function writeAgentReport(
  runDir: string,
  jobId: string,
  attempt: number,
  stepId: string,
  signals: Array<{ type: string; reason?: string }> = []
): Promise<void> {
  const dir = artifactStepDir(runDir, jobId, attempt, stepId);
  await mkdir(dir, { recursive: true });
  const report = {
    outputs: { summary: `${jobId} completed` },
    artifacts: [],
    signals,
    summary: `${jobId} step done`,
  };
  await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2), "utf-8");
}

/**
 * Run a single agent job end-to-end:
 * 1. Promote waiting deps to ready (if needed).
 * 2. Set job to running with correct current_step.
 * 3. Write a minimal report.json.
 * 4. Call acceptAgentReport.
 */
async function runAgentJob(
  runDir: string,
  runId: string,
  jobId: string,
  stepId: string,
  wfJobs: Record<string, WfJobDesc>,
  clock: Clock,
  signals: Array<{ type: string; reason?: string }> = []
): Promise<void> {
  await promoteReadyJobs(runDir, wfJobs);

  const attempt = 1;
  await patchJobState(runDir, jobId, {
    status: "running",
    current_step: stepId,
    attempt,
  });

  await writeAgentReport(runDir, jobId, attempt, stepId, signals);

  await acceptAgentReport({ runDir, runId, jobId, clock });
}

/**
 * Run a single agent job at a specific attempt (for retry scenarios).
 */
async function runAgentJobAttempt(
  runDir: string,
  runId: string,
  jobId: string,
  stepId: string,
  attempt: number,
  clock: Clock,
  signals: Array<{ type: string; reason?: string }> = []
): Promise<void> {
  await patchJobState(runDir, jobId, {
    status: "running",
    current_step: stepId,
    attempt,
  });

  await writeAgentReport(runDir, jobId, attempt, stepId, signals);

  await acceptAgentReport({ runDir, runId, jobId, clock });
}

/**
 * Run a single script or check job:
 * 1. Promote waiting deps to ready.
 * 2. Call executeCurrentStep (the job must already be "ready").
 */
async function runExecutedJob(
  runDir: string,
  runId: string,
  jobId: string,
  wfJobs: Record<string, WfJobDesc>,
  projectRoot: string,
  clock: Clock,
  runner: ProcessRunner | MockCheckRunner
): Promise<void> {
  await promoteReadyJobs(runDir, wfJobs);

  await executeCurrentStep({
    runDir,
    zigmaflowDir: projectRoot,
    runId,
    jobId,
    clock,
    runner,
  });
}

// ---------------------------------------------------------------------------
// TC-DOGFOOD-1 — runInit creates all scaffold files
// ---------------------------------------------------------------------------

describe("TC-DOGFOOD-1: runInit scaffold", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectDir, { recursive: true, force: true });
  });

  it("runInit creates the full .zigma-flow layout (TC-DOGFOOD-1)", async () => {
    const summary = await runInit({ cwd: sandbox.projectDir });

    expect(summary.alreadyInitialized).toBe(false);
    expect(summary.files.length).toBeGreaterThan(0);
    for (const f of summary.files) {
      expect(f.status).toBe("created");
    }

    // Spot-check key files
    const expectedFiles = [
      join(sandbox.dotZigma, "config.json"),
      join(sandbox.dotZigma, "skill-lock.json"),
      join(sandbox.dotZigma, "workflows", "code-change.yml"),
      join(sandbox.dotZigma, "skills", "code-change", "skill.yml"),
      join(sandbox.dotZigma, "skills", "code-change", "prompts", "intake.md"),
      join(sandbox.dotZigma, "skills", "code-change", "prompts", "review.md"),
    ];

    for (const filePath of expectedFiles) {
      const content = await readFile(filePath, "utf-8");
      expect(content.length, `file missing or empty: ${filePath}`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// TC-DOGFOOD-2 — Workflow YAML is valid
// ---------------------------------------------------------------------------

describe("TC-DOGFOOD-2: workflow YAML validity", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectDir, { recursive: true, force: true });
  });

  it("generated code-change.yml passes loadWorkflow() (TC-DOGFOOD-2)", async () => {
    await runInit({ cwd: sandbox.projectDir });

    const yml = await readFile(sandbox.workflowPath, "utf-8");
    const wf = loadWorkflow(yml);

    expect(wf.name).toBe("code-change");

    // All 10 jobs present
    const jobIds = Object.keys(wf.jobs).sort();
    expect(jobIds).toEqual(
      [
        "architecture-design",
        "code-map",
        "implement",
        "intake",
        "plan",
        "review",
        "risk-scan",
        "static-check",
        "summarize",
        "unit-test",
      ].sort()
    );

    // Signals declared
    expect(wf.signals?.["review_rejected"]).toBeDefined();
    expect(wf.signals?.["needs_architecture_design"]).toBeDefined();

    // architecture-design is manual activation
    expect(wf.jobs["architecture-design"]?.activation).toBe("manual");

    // implement has retry config
    const retry = wf.jobs["implement"]?.retry as Record<string, unknown> | undefined;
    expect(retry?.["max_attempts"]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// TC-DOGFOOD-3 — Full happy-path run
// ---------------------------------------------------------------------------

describe("TC-DOGFOOD-3: full happy-path run", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectDir, { recursive: true, force: true });
  });

  it(
    "all 10 jobs complete in DAG order; architecture-design stays inactive (TC-DOGFOOD-3)",
    async () => {
      // Step 1: runInit
      await runInit({ cwd: sandbox.projectDir });

      const clock = new FakeClock();

      // Step 2: createRun
      const { runId } = await createRun({
        workflowPath: sandbox.workflowPath,
        task: "dogfood integration test",
        runsDir: sandbox.runsDir,
        skillLockPath: sandbox.skillLockPath,
        clock,
      });
      const runDir = join(sandbox.runsDir, runId);

      // Load workflow definition for DAG helpers
      const yml = await readFile(sandbox.workflowPath, "utf-8");
      const wf = loadWorkflow(yml);
      const wfJobs: Record<string, WfJobDesc> = Object.fromEntries(
        Object.entries(wf.jobs).map(([id, def]) => [
          id,
          { needs: def.needs ?? [], activation: def.activation ?? null },
        ])
      );

      const mockRunner = new MockProcessRunner();
      const mockCheckRunner = new MockCheckRunner();

      // Verify initial state: intake ready, others waiting/inactive
      const initialState = await readStateSnapshot(runDir);
      expect(initialState.jobs["intake"]!.status).toBe("ready");
      expect(initialState.jobs["architecture-design"]!.status).toBe("inactive");

      // Step 3: Run jobs in DAG order

      // 1. intake (no deps) — agent step id: "analyze"
      await runAgentJob(runDir, runId, "intake", "analyze", wfJobs, clock);
      expect((await readStateSnapshot(runDir)).jobs["intake"]!.status).toBe("completed");

      // 2. code-map (needs: intake) — agent step id: "map"
      await runAgentJob(runDir, runId, "code-map", "map", wfJobs, clock);
      expect((await readStateSnapshot(runDir)).jobs["code-map"]!.status).toBe("completed");

      // 3. risk-scan (needs: code-map) — check step id: "validate"
      //    Uses real MockCheckRunner returning passed=true
      await runExecutedJob(runDir, runId, "risk-scan", wfJobs, sandbox.projectDir, clock, mockCheckRunner);
      expect((await readStateSnapshot(runDir)).jobs["risk-scan"]!.status).toBe("completed");

      // 4. plan (needs: risk-scan) — agent step id: "plan"
      await runAgentJob(runDir, runId, "plan", "plan", wfJobs, clock);
      expect((await readStateSnapshot(runDir)).jobs["plan"]!.status).toBe("completed");

      // 5. architecture-design stays inactive (activation: "manual", not triggered)
      expect((await readStateSnapshot(runDir)).jobs["architecture-design"]!.status).toBe("inactive");

      // 6. implement (needs: plan; optional_needs: architecture-design)
      //    architecture-design is inactive → implement can proceed once plan completes
      //    agent step id: "implement"
      await runAgentJob(runDir, runId, "implement", "implement", wfJobs, clock);
      expect((await readStateSnapshot(runDir)).jobs["implement"]!.status).toBe("completed");

      // 7. static-check (needs: implement) — script step id: "check"
      await runExecutedJob(runDir, runId, "static-check", wfJobs, sandbox.projectDir, clock, mockRunner);
      expect((await readStateSnapshot(runDir)).jobs["static-check"]!.status).toBe("completed");

      // 8. unit-test (needs: implement) — script step id: "test"
      await runExecutedJob(runDir, runId, "unit-test", wfJobs, sandbox.projectDir, clock, mockRunner);
      expect((await readStateSnapshot(runDir)).jobs["unit-test"]!.status).toBe("completed");

      // 9. review (needs: static-check, unit-test) — agent step id: "review"
      await runAgentJob(runDir, runId, "review", "review", wfJobs, clock);
      expect((await readStateSnapshot(runDir)).jobs["review"]!.status).toBe("completed");

      // 10. summarize (needs: review) — agent step id: "summarize"
      await runAgentJob(runDir, runId, "summarize", "summarize", wfJobs, clock);
      expect((await readStateSnapshot(runDir)).jobs["summarize"]!.status).toBe("completed");

      // Final assertions: all jobs except architecture-design are "completed"
      const finalState = await readStateSnapshot(runDir);
      const completedJobs = [
        "intake",
        "code-map",
        "risk-scan",
        "plan",
        "implement",
        "static-check",
        "unit-test",
        "review",
        "summarize",
      ];
      for (const jobId of completedJobs) {
        expect(finalState.jobs[jobId]!.status, `job ${jobId} should be completed`).toBe(
          "completed"
        );
      }

      // architecture-design was never activated — stays inactive
      expect(finalState.jobs["architecture-design"]!.status).toBe("inactive");
    }
  );
});

// ---------------------------------------------------------------------------
// TC-DOGFOOD-4 — review_rejected signal path
// ---------------------------------------------------------------------------

describe("TC-DOGFOOD-4: review_rejected signal path", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectDir, { recursive: true, force: true });
  });

  it(
    "implement retries (attempt 2) when review emits review_rejected signal (TC-DOGFOOD-4)",
    async () => {
      // Step 1: runInit
      await runInit({ cwd: sandbox.projectDir });

      const clock = new FakeClock();

      // Step 2: createRun
      const { runId } = await createRun({
        workflowPath: sandbox.workflowPath,
        task: "dogfood signal test",
        runsDir: sandbox.runsDir,
        skillLockPath: sandbox.skillLockPath,
        clock,
      });
      const runDir = join(sandbox.runsDir, runId);

      const yml = await readFile(sandbox.workflowPath, "utf-8");
      const wf = loadWorkflow(yml);
      const wfJobs: Record<string, WfJobDesc> = Object.fromEntries(
        Object.entries(wf.jobs).map(([id, def]) => [
          id,
          { needs: def.needs ?? [], activation: def.activation ?? null },
        ])
      );

      const mockRunner = new MockProcessRunner();
      const mockCheckRunner = new MockCheckRunner();

      // Run through the DAG until review

      // 1. intake
      await runAgentJob(runDir, runId, "intake", "analyze", wfJobs, clock);
      // 2. code-map
      await runAgentJob(runDir, runId, "code-map", "map", wfJobs, clock);
      // 3. risk-scan
      await runExecutedJob(runDir, runId, "risk-scan", wfJobs, sandbox.projectDir, clock, mockCheckRunner);
      // 4. plan
      await runAgentJob(runDir, runId, "plan", "plan", wfJobs, clock);
      // 5. implement (attempt 1)
      await runAgentJob(runDir, runId, "implement", "implement", wfJobs, clock);
      // 6. static-check
      await runExecutedJob(runDir, runId, "static-check", wfJobs, sandbox.projectDir, clock, mockRunner);
      // 7. unit-test
      await runExecutedJob(runDir, runId, "unit-test", wfJobs, sandbox.projectDir, clock, mockRunner);

      // Confirm implement is completed at attempt 1 before review runs
      const preReviewState = await readStateSnapshot(runDir);
      expect(preReviewState.jobs["implement"]!.status).toBe("completed");
      expect(preReviewState.jobs["implement"]!.attempt ?? 1).toBe(1);

      // 8. review — emits review_rejected signal
      //    This triggers applyRoutingAction({ retry_job: "implement" }),
      //    which resets implement to ready at attempt 2.
      await runAgentJob(runDir, runId, "review", "review", wfJobs, clock, [
        { type: "review_rejected", reason: "tests are insufficient" },
      ]);

      // After the signal: review should be completed, implement should be ready at attempt 2
      const postSignalState = await readStateSnapshot(runDir);

      // review completes (source job advances to completed after signal dispatch)
      expect(postSignalState.jobs["review"]!.status).toBe("completed");

      // implement is reset to "ready" with attempt 2
      expect(postSignalState.jobs["implement"]!.status).toBe("ready");
      expect(postSignalState.jobs["implement"]!.attempt).toBe(2);

      // Events should include signal_received, job_retrying, and job_completed (review)
      const eventsText = await readFile(join(runDir, "events.jsonl"), "utf-8");
      const events = eventsText
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { type: string; job: string | null; payload: Record<string, unknown> });

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("signal_received");
      expect(eventTypes).toContain("job_retrying");
      expect(eventTypes).toContain("job_completed");

      // signal_received should carry review_rejected from review job
      const sigEvent = events.find((e) => e.type === "signal_received");
      expect(sigEvent?.payload?.["signal"]).toBe("review_rejected");
      expect(sigEvent?.payload?.["from_job"]).toBe("review");

      // job_retrying should reference implement
      const retryEvent = events.find((e) => e.type === "job_retrying");
      expect(retryEvent?.payload?.["job_id"]).toBe("implement");
      expect(retryEvent?.payload?.["attempt"]).toBe(2);

      // job_completed should reference review (the source job that was advanced)
      const completedEvents = events.filter((e) => e.type === "job_completed");
      const reviewCompleted = completedEvents.find((e) => e.job === "review");
      expect(reviewCompleted).toBeDefined();

      // Now run implement attempt 2 through to completion (verify retry works)
      // implement is already at ready/attempt 2 — just need to run it
      await runAgentJobAttempt(runDir, runId, "implement", "implement", 2, clock);
      expect((await readStateSnapshot(runDir)).jobs["implement"]!.status).toBe("completed");

      // Then run static-check and unit-test again (they need re-running after retry)
      // but they may still be "completed" from attempt 1 — check and promote if needed
      // For the signal test we only need to confirm implement retried successfully.
      // The full post-retry run is out of scope for this test case.
    }
  );
});
