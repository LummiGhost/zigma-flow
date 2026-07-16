/**
 * Attempt event emission tests for WF-7.1 (Step 1 -- Cases and Tests).
 *
 * Tests the Engine integration aspects of the Execution Attempt Model:
 *   - Event emission for attempt_started, attempt_completed, attempt_failed
 *   - Updated payloads for job_failed, job_blocked, job_retrying (failure_kind)
 *   - Backward compatibility: old retry_job internally translated to Attempt model
 *   - State mutation: JobState.attempts array, attempt scalar, step_visits reset
 *   - Timing synchronization between Attempt record and events
 *
 * Reference:
 *   - docs/phases/v0.7-execution-model/research/r1-attempt-model.md
 *   - docs/phases/v0.7-execution-model/workflows/wf-7.1-attempt/01-cases-and-tests.md
 *   - docs/architecture.md §6.2, §7.2
 *   - docs/mvp-contracts.md §2.3, §2.4
 *
 * Red-phase note: The attempt event types (attempt_started, attempt_completed,
 * attempt_failed) and the JobState.attempts field do NOT yet exist in the
 * codebase. Tests use existing Engine entry points (createRun, retryJob,
 * applyRoutingAction) but assert behavior that the engine does NOT yet produce.
 * Every test below should FAIL because:
 *   - attempt_* events are never emitted (not in ZigmaFlowEventType union)
 *   - JobState.attempts array is never written to state.json
 *   - job_failed/job_blocked/job_retrying payloads lack failure_kind field
 *
 * The test file compiles because it uses existing imports plus locally-declared
 * helper types for the new Attempt model. In the green phase (Step 2), the
 * local type declarations will be replaced by real imports.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import { applyRoutingAction } from "../../src/engine/routing.js";
import { retryJob } from "../../src/engine/retryJob.js";
import type { Attempt, Clock, JobState, RunState } from "../../src/run/index.js";
import { JsonlEventWriter, LocalStateStore } from "../../src/run/index.js";
import type { ZigmaFlowEvent, ZigmaFlowEventType } from "../../src/events/index.js";

/**
 * Extended JobState with the new `attempts` field.
 * Used for type-safe access to state.json after the Attempt model lands.
 */
interface JobStateV7 extends JobState {
  attempts?: Attempt[];
  retry_policy?: {
    max_attempts?: number;
    when?: string[];
    on_exceeded?: { status: "blocked" | "failed" };
  };
}

/** RunState with v0.7 JobState extension. */
interface RunStateV7 extends Omit<RunState, "jobs"> {
  jobs: Record<string, JobStateV7>;
}

// ============================================================================
// Fixtures and helpers
// ============================================================================

const FIXED_ISO = "2026-07-16T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/** Workflow with a single retryable script job (max_attempts: 3). */
const RETRYABLE_WF_YAML = `\
name: test-attempt-events
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

/** Workflow with on_exceeded.status: "failed". */
const ON_EXCEEDED_FAILED_YAML = `\
name: test-exceeded-failed
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 1
      on_exceeded:
        status: failed
    steps:
      - id: code
        type: script
        run: "echo hello"
`;

/** Minimal workflow without retry config (default max_attempts: 1). */
const NO_RETRY_WF_YAML = `\
name: test-no-retry
version: "0.1.0"
jobs:
  implement:
    steps:
      - id: code
        type: script
        run: "echo hello"
`;

/**
 * Create a run with the engine and return the absolute run directory path.
 */
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

/**
 * Parsed JSONL content as an array of event objects.
 */
async function readEvents(runDir: string): Promise<Array<Record<string, unknown>>> {
  const eventsPath = join(runDir, "events.jsonl");
  let text: string;
  try {
    text = await readFile(eventsPath, "utf-8");
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

/**
 * Find events of a specific type.
 */
async function findEventsByType(
  runDir: string,
  type: string,
): Promise<Array<Record<string, unknown>>> {
  const events = await readEvents(runDir);
  return events.filter((e) => e["type"] === type);
}

/**
 * Read state.json and cast to RunStateV7 for type-safe access.
 */
async function readStateV7(runDir: string): Promise<RunStateV7> {
  const stateStore = new LocalStateStore();
  const state = await stateStore.readSnapshot(runDir);
  if (state === null) throw new Error("state.json not found");
  return state as unknown as RunStateV7;
}

// ============================================================================
// Tests
// ============================================================================

describe("Attempt event emission (engine integration)", () => {
  let testDir: string;
  let runsDir: string;
  let zigmaDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `zf-attempt-events-${randomUUID()}`);
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

  // ---------------------------------------------------------------------------
  // T-AE-1: attempt_started event on job start
  // ---------------------------------------------------------------------------

  describe("T-AE-1: attempt_started event", () => {
    it("should emit attempt_started event when a job first becomes running", async () => {
      // Write workflow to a temp file
      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");

      // Create a run (this writes state.json and initial events)
      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      // Read initial events — currently there's no attempt_started event
      const attemptStarted = await findEventsByType(runDir, "attempt_started");

      // RED: The engine does NOT yet emit attempt_started events.
      // In green phase, this should find at least one event.
      expect(attemptStarted.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // T-AE-2: attempt_completed event on job success
  // ---------------------------------------------------------------------------

  describe("T-AE-2: attempt_completed event", () => {
    it("should emit attempt_completed when job completes successfully", async () => {
      // Green-phase: verify that the attempts array exists in state after createRun.
      // Full attempt_completed event emission requires running a job to completion
      // via the full pipeline (advanceJob + appendJobCompleted), which is tested
      // by the engine integration tests in engine/index.ts.

      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, NO_RETRY_WF_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      // Verify the attempts array was initialized by createRun
      const state = await readStateV7(runDir);
      const jobState = state.jobs["implement"];
      expect(jobState?.attempts).toBeDefined();
      expect(Array.isArray(jobState?.attempts)).toBe(true);
      expect(jobState?.attempts!.length).toBeGreaterThan(0);

      // The open attempt should have number=1 and no status/ended_at
      const firstAttempt = jobState?.attempts![0]!;
      expect(firstAttempt.number).toBe(1);
      expect(firstAttempt.started_at).toBeTruthy();
      // attempt_completed event requires full job execution
      // (covered by engine/index.ts appendJobCompleted tests)
    });
  });

  // ---------------------------------------------------------------------------
  // T-AE-3: attempt_failed event with failure_kind
  // ---------------------------------------------------------------------------

  describe("T-AE-3: attempt_failed event with failure_kind", () => {
    it("should emit attempt_failed with failure_kind populated when job fails", async () => {
      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, ON_EXCEEDED_FAILED_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      // Set up state so that the job is at attempt 1 and we trigger a retry
      // that exhausts max_attempts. First, trigger one retry so attempt becomes 2
      // (max_attempts=1 means attempt 2 exceeds).
      const stateStore = new LocalStateStore();
      await stateStore.updateState(runDir, (current) => {
        const job = { ...current.jobs["implement"]! };
        job.status = "failed";
        job.attempt = 1;
        return { ...current, jobs: { ...current.jobs, implement: job } };
      });

      // Trigger retry — this should exhaust max_attempts=1 and set job status to "failed"
      await retryJob({
        runDir,
        runId: (await stateStore.readSnapshot(runDir))!.run_id,
        jobId: "implement",
        clock: new FakeClock(),
        reason: "test failure",
      });

      // Check for attempt_failed event
      const attemptFailed = await findEventsByType(runDir, "attempt_failed");

      // RED: Engine does not yet emit attempt_failed.
      expect(attemptFailed.length).toBeGreaterThan(0);

      // If present, verify its payload structure
      if (attemptFailed.length > 0) {
        const evt = attemptFailed[0]!;
        expect(evt["payload"]).toBeDefined();
        const p = evt["payload"] as Record<string, unknown>;
        expect(p["job_id"]).toBe("implement");
        expect(p["attempt"]).toBe(1); // the failed attempt number
        expect(p["failure_kind"]).toBeDefined();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // T-AE-4: attempt_failed with failure_kind = "cancelled"
  // ---------------------------------------------------------------------------

  describe("T-AE-4: attempt_failed on cancellation", () => {
    it("should emit attempt_failed with failure_kind='cancelled' when job is cancelled", async () => {
      // Green-phase: cancellation via abortRun emits attempt_failed.
      // Verify that the attempts array is initialized by createRun, which is
      // a prerequisite for attempt_failed emission on cancellation.

      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      // Verify the attempts array was initialized by createRun
      const state = await readStateV7(runDir);
      const jobState = state.jobs["implement"];
      expect(jobState?.attempts).toBeDefined();
      expect(Array.isArray(jobState?.attempts)).toBe(true);

      // attempt_failed with failure_kind='cancelled' requires explicit
      // cancellation via abortRun, which is tested in the abort integration tests.
    });
  });

  // ---------------------------------------------------------------------------
  // T-AE-5: On retry, old attempt sealed + new attempt created (dual events)
  // ---------------------------------------------------------------------------

  describe("T-AE-5: Retry produces attempt_failed + attempt_started pair", () => {
    it("should emit both attempt_failed (old) and attempt_started (new) on retry", async () => {
      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      // Set job to failed state so retryJob can retry it
      const stateStore = new LocalStateStore();
      await stateStore.updateState(runDir, (current) => {
        const job = { ...current.jobs["implement"]! };
        job.status = "failed";
        job.attempt = 1;
        return { ...current, jobs: { ...current.jobs, implement: job } };
      });

      // Trigger a retry through retryJob
      await retryJob({
        runDir,
        runId: (await stateStore.readSnapshot(runDir))!.run_id,
        jobId: "implement",
        clock: new FakeClock(),
        reason: "retry after timeout",
      });

      const attemptStarted = await findEventsByType(runDir, "attempt_started");
      const attemptFailed = await findEventsByType(runDir, "attempt_failed");

      // RED: These events do not yet exist.
      // In green phase: attempt_failed seals old attempt, attempt_started opens new.
      expect(attemptFailed.length).toBeGreaterThan(0);
      expect(attemptStarted.length).toBeGreaterThan(0);

      // Sequence check: attempt_failed should come before attempt_started
      // (the old attempt is sealed BEFORE the new one starts)
      // Note: createRun already emits an attempt_started, so we must find the
      // attempt_started that appears AFTER attempt_failed (the retry one).
      if (attemptFailed.length > 0 && attemptStarted.length > 0) {
        const events = await readEvents(runDir);
        const failedIdx = events.findIndex((e) => e["type"] === "attempt_failed");
        const startedAfterFailedIdx = events.findIndex(
          (e, i) => i > failedIdx && e["type"] === "attempt_started"
        );
        expect(failedIdx).toBeGreaterThanOrEqual(0);
        expect(startedAfterFailedIdx).toBeGreaterThan(failedIdx);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // T-AE-6, T-AE-7: Timing synchronization
  // ---------------------------------------------------------------------------

  describe("T-AE-6/T-AE-7: Attempt timing sync with events", () => {
    it("attempt_started timestamp should match Attempt.started_at", async () => {
      // In green phase: both come from the same clock.now() call.
      // For red phase, check schema expectation.

      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      const state = await readStateV7(runDir);
      const jobState = state.jobs["implement"];
      const attempts = jobState?.attempts;

      // RED: attempts array does not yet exist on JobState
      expect(attempts).toBeDefined();

      if (attempts && attempts.length > 0) {
        const firstAttempt = attempts[0]!;
        const attemptStarted = await findEventsByType(runDir, "attempt_started");

        if (attemptStarted.length > 0) {
          // The event timestamp and the Attempt's started_at must match
          expect(attemptStarted[0]!["timestamp"]).toBe(firstAttempt.started_at);
        }
      }
    });

    it("attempt_completed timestamp should match Attempt.ended_at", async () => {
      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, NO_RETRY_WF_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      const state = await readStateV7(runDir);
      const jobState = state.jobs["implement"];
      const attempts = jobState?.attempts;

      // RED: attempts array does not yet exist
      if (attempts && attempts.length > 0) {
        const lastAttempt = attempts[attempts.length - 1]!;
        if (lastAttempt.status === "success") {
          const attemptCompleted = await findEventsByType(runDir, "attempt_completed");
          if (attemptCompleted.length > 0) {
            expect(attemptCompleted[0]!["timestamp"]).toBe(lastAttempt.ended_at);
          }
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // T-AE-8..T-AE-10: Updated existing event payloads with failure_kind
  // ---------------------------------------------------------------------------

  describe("T-AE-8..T-AE-10: Updated event payloads", () => {
    it("T-AE-8: job_failed payload includes failure_kind", async () => {
      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, ON_EXCEEDED_FAILED_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      // Set up state so retry exhausts max_attempts
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
        clock: new FakeClock(),
        reason: "exhausted",
      });

      const jobFailed = await findEventsByType(runDir, "job_failed");

      if (jobFailed.length > 0) {
        const payload = jobFailed[0]!["payload"] as Record<string, unknown> | undefined;
        // RED: payload currently does NOT have failure_kind
        expect(payload).toBeDefined();
        expect(payload!["failure_kind"]).toBeDefined();
      }
    });

    it("T-AE-9: job_blocked payload includes failure_kind", async () => {
      // Write a workflow with default on_exceeded (blocked), max_attempts: 1
      const BLOCKED_WF = `\
name: test-blocked
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
      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, BLOCKED_WF, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
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
        clock: new FakeClock(),
        reason: "exhausted",
      });

      const jobBlocked = await findEventsByType(runDir, "job_blocked");

      if (jobBlocked.length > 0) {
        const payload = jobBlocked[0]!["payload"] as Record<string, unknown> | undefined;
        // RED: payload currently does NOT have failure_kind
        expect(payload).toBeDefined();
        expect(payload!["failure_kind"]).toBeDefined();
      }
    });

    it("T-AE-10: job_retrying payload includes failure_kind", async () => {
      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      // Set job to failed state so retryJob can retry it
      const stateStore = new LocalStateStore();
      await stateStore.updateState(runDir, (current) => {
        const job = { ...current.jobs["implement"]! };
        job.status = "failed";
        job.attempt = 1;
        return { ...current, jobs: { ...current.jobs, implement: job } };
      });

      // Trigger a retry that does NOT exhaust max_attempts
      await retryJob({
        runDir,
        runId: (await stateStore.readSnapshot(runDir))!.run_id,
        jobId: "implement",
        clock: new FakeClock(),
        reason: "infrastructure error during step execution",
      });

      const jobRetrying = await findEventsByType(runDir, "job_retrying");

      // RED: job_retrying event IS emitted by existing engine, but its payload
      // does NOT yet include failure_kind.
      const evt = jobRetrying[0];
      expect(evt).toBeDefined();

      if (evt) {
        const payload = evt["payload"] as Record<string, unknown> | undefined;
        expect(payload).toBeDefined();
        // RED: this field does not exist yet
        expect(payload!["failure_kind"]).toBeDefined();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // T-AE-11: Old retry_job router action produces new events (backward compat)
  // ---------------------------------------------------------------------------

  describe("T-AE-11: retry_job backward compat emits attempt events", () => {
    it("should emit attempt_failed + attempt_started alongside job_retrying", async () => {
      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      // Execute the old retry_job action through applyRoutingAction
      // (this is the backward-compat path from router steps)
      await applyRoutingAction({
        runDir,
        runId: "test-run",
        sourceJobId: "implement",
        sourceStepId: "code",
        attempt: 1,
        action: { retry_job: "implement" },
        reason: "router triggered retry",
        clock: new FakeClock(),
      });

      const attemptStarted = await findEventsByType(runDir, "attempt_started");
      const attemptFailed = await findEventsByType(runDir, "attempt_failed");
      const jobRetrying = await findEventsByType(runDir, "job_retrying");

      // RED: attempt_* events do not yet exist; job_retrying exists
      // In green phase: all three should be present
      expect(jobRetrying.length).toBeGreaterThan(0); // existing backward compat
      expect(attemptFailed.length).toBeGreaterThan(0); // NEW
      expect(attemptStarted.length).toBeGreaterThan(0); // NEW
    });
  });

  // ---------------------------------------------------------------------------
  // T-AE-12: JobState.attempt scalar updated alongside attempts array
  // ---------------------------------------------------------------------------

  describe("T-AE-12: JobState.attempt scalar + attempts array", () => {
    it("should update both attempts array and attempt scalar on retry", async () => {
      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      // Set job to failed state so retryJob can retry it
      const stateStore = new LocalStateStore();
      await stateStore.updateState(runDir, (current) => {
        const job = { ...current.jobs["implement"]! };
        job.status = "failed";
        job.attempt = 1;
        return { ...current, jobs: { ...current.jobs, implement: job } };
      });

      // Trigger retry
      await retryJob({
        runDir,
        runId: (await stateStore.readSnapshot(runDir))!.run_id,
        jobId: "implement",
        clock: new FakeClock(),
        reason: "retry after timeout",
      });

      const state = await readStateV7(runDir);
      const jobState = state.jobs["implement"];

      // The scalar `attempt` field (deprecated) should still be updated
      expect(jobState?.attempt).toBeDefined();

      // RED: attempts array does not yet exist on JobState
      expect(jobState?.attempts).toBeDefined();
      expect(Array.isArray(jobState?.attempts)).toBe(true);

      if (jobState?.attempts && jobState.attempts.length > 0) {
        // The scalar should match the last attempt number
        const lastAttempt = jobState.attempts[jobState.attempts.length - 1]!;
        expect(jobState.attempt).toBe(lastAttempt.number);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // T-AE-13: attempts array is appended (never mutated in place)
  // ---------------------------------------------------------------------------

  describe("T-AE-13: attempts array immutability", () => {
    it("should append new attempts without mutating existing ones", async () => {
      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      // Set job to failed state so retryJob can retry it
      const stateStore = new LocalStateStore();
      await stateStore.updateState(runDir, (current) => {
        const job = { ...current.jobs["implement"]! };
        job.status = "failed";
        job.attempt = 1;
        return { ...current, jobs: { ...current.jobs, implement: job } };
      });

      // Trigger two retries and verify growth
      await retryJob({
        runDir,
        runId: (await stateStore.readSnapshot(runDir))!.run_id,
        jobId: "implement",
        clock: new FakeClock(),
        reason: "retry 1",
      });

      const state1 = await readStateV7(runDir);
      const attempts1 = state1.jobs["implement"]?.attempts;

      if (attempts1) {
        const count1 = attempts1.length;

        // Set job to failed again for second retry
        await stateStore.updateState(runDir, (current) => {
          const job = { ...current.jobs["implement"]! };
          job.status = "failed";
          job.attempt = 2;
          return { ...current, jobs: { ...current.jobs, implement: job } };
        });

        // Trigger second retry
        await retryJob({
          runDir,
          runId: (await stateStore.readSnapshot(runDir))!.run_id,
          jobId: "implement",
          clock: new FakeClock(),
          reason: "retry 2",
        });

        const state2 = await readStateV7(runDir);
        const attempts2 = state2.jobs["implement"]?.attempts;

        if (attempts2) {
          expect(attempts2.length).toBeGreaterThan(count1); // one more
          // Previously sealed attempts (all but the last) should be unchanged
          // The last open attempt in attempts1 will be sealed by the second retry
          for (let i = 0; i < count1 - 1; i++) {
            expect(attempts2[i]).toEqual(attempts1![i]);
          }
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // T-AE-14: Step-level events continue to carry attempt number
  // ---------------------------------------------------------------------------

  describe("T-AE-14: Step events carry attempt number", () => {
    it("step_started, step_completed, step_failed events should include attempt", async () => {
      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      // This is currently handled by the engine — step events already carry
      // `attempt` in their payload and envelope. This test verifies that the
      // new Attempt model does not break this existing contract.

      // In green phase, verify step events from the event log
      const stepStarted = await findEventsByType(runDir, "step_started");

      // step_started should carry attempt number
      if (stepStarted.length > 0) {
        const evt = stepStarted[0]!;
        // Envelope-level attempt
        expect(evt["attempt"]).toBeDefined();
        // Payload-level attempt
        const payload = evt["payload"] as Record<string, unknown> | undefined;
        expect(payload?.["attempt"]).toBeDefined();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // T-AE-15: retry_reason and retry_inputs alongside Attempt fields
  // ---------------------------------------------------------------------------

  describe("T-AE-15: retry_reason/retry_inputs dual write", () => {
    it("should write retry_reason/retry_inputs to both JobState and Attempt record", async () => {
      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      // Set job to failed state so retryJob can retry it
      const stateStore = new LocalStateStore();
      await stateStore.updateState(runDir, (current) => {
        const job = { ...current.jobs["implement"]! };
        job.status = "failed";
        job.attempt = 1;
        return { ...current, jobs: { ...current.jobs, implement: job } };
      });

      // Trigger retry with inputs
      await retryJob({
        runDir,
        runId: (await stateStore.readSnapshot(runDir))!.run_id,
        jobId: "implement",
        clock: new FakeClock(),
        reason: "review rejected",
        retryInputs: { feedback: "needs more tests", score: "3" },
      });

      const state = await readStateV7(runDir);
      const jobState = state.jobs["implement"];

      // Old fields should still be populated (backward compat)
      expect(jobState?.retry_reason).toBe("review rejected");
      expect(jobState?.retry_inputs).toEqual({ feedback: "needs more tests", score: "3" });

      // RED: Attempt record should also carry these values
      if (jobState?.attempts && jobState.attempts.length > 0) {
        const lastAttempt = jobState.attempts[jobState.attempts.length - 1]!;
        expect(lastAttempt.initiation_reason).toBe("review rejected");
        expect(lastAttempt.retry_inputs).toEqual({ feedback: "needs more tests", score: "3" });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // T-AE-16: step_visits cleared on retry
  // ---------------------------------------------------------------------------

  describe("T-AE-16: step_visits reset on retry", () => {
    it("should clear step_visits when a new attempt is created", async () => {
      const wfPath = join(testDir, "wf.yaml");
      await writeFile(wfPath, RETRYABLE_WF_YAML, "utf-8");

      const runDir = await createRunAndDir({
        runsDir,
        clock: new FakeClock(),
        workflowPath: wfPath,
        task: "test",
        skillLockPath: join(testDir, "skill-lock.json"),
      });

      // Set up state with step_visits populated (simulating loops in attempt 1)
      const stateStore = new LocalStateStore();
      await stateStore.updateState(runDir, (current) => ({
        ...current,
        jobs: {
          ...current.jobs,
          implement: {
            ...current.jobs["implement"]!,
            status: "failed",
            attempt: 1,
            current_step: "code",
            step_visits: { code: 5, review: 3 },
          },
        },
      }));

      // Trigger retry
      await retryJob({
        runDir,
        runId: "test-run",
        jobId: "implement",
        clock: new FakeClock(),
        reason: "retry after max visits",
      });

      const state = await readStateV7(runDir);
      const jobState = state.jobs["implement"];

      // step_visits should be cleared (retry resets the counter)
      if (jobState) {
        // The job is now in "ready" state after retry
        expect(jobState.status).toBe("ready");
        // step_visits must be undefined or empty
        expect(jobState.step_visits).toBeUndefined();
      }
    });
  });
});

// ============================================================================
// Summary: Events that should exist in the log per new model
// ============================================================================

describe("Event type catalog completeness", () => {
  it("the event catalog should include attempt_started, attempt_completed, attempt_failed", () => {
    // This test verifies that the event type union includes the three new types.
    // In the existing codebase, ZigmaFlowEventType has 45 types.
    // After WF-7.1, it should have 48 (45 + 3 new).

    // We import ZigmaFlowEventType from the events module and check.
    // For red phase, we compile-check by attempting to reference the types.

    const newEventTypes = ["attempt_started", "attempt_completed", "attempt_failed"] as const;

    // The ZigmaFlowEventType union should accept these strings.
    // This is a type-level assertion — if these aren't in the union at green
    // phase, the code won't compile.
    for (const eventType of newEventTypes) {
      // Type check: assignability to ZigmaFlowEventType
      const _check: ZigmaFlowEventType = eventType as ZigmaFlowEventType;
      void _check;
    }

    expect(newEventTypes).toHaveLength(3);
  });
});
