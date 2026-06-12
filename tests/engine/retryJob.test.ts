/**
 * `retryJob` tests for WF-CLI-COMMANDS (Step 1 — Cases and Tests).
 *
 * Exercises the new Engine entry point that powers
 * `zigma-flow retry --job <id>`. The function is invoked by the CLI
 * after the user explicitly asks to retry a job that is in a terminal
 * state (`completed`, `failed`, or `blocked`).
 *
 * Covers:
 *   - T-RETRY-1: failed job → ready, attempt++, job_retrying event.
 *   - T-RETRY-2: completed job is also retryable.
 *   - T-RETRY-3: running job → UserInputError; no disk mutation.
 *   - T-RETRY-4: max_attempts exceeded + on_exceeded.status="failed"
 *                → status="failed", emits job_failed, no job_retrying.
 *   - T-RETRY-5: max_attempts exceeded + on_exceeded default
 *                → status="blocked", emits job_blocked.
 *   - T-RETRY-6: retryInputs are persisted as state.jobs[id].retry_inputs.
 *
 * Reference:
 *   - docs/phases/p9p10-cli-admin-commands/workflows/wf-cli-commands/01-cases-and-tests.md
 *   - docs/prd.md §17
 *   - docs/mvp-contracts.md §2.3, §2.4
 *
 * Red-phase note: `src/engine/retryJob.ts` does not yet exist; tests
 * will fail to compile until WF-CLI-COMMANDS Step 2 ships the module.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import { retryJob } from "../../src/engine/retryJob.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-12T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Workflow with one retryable script job. `max_attempts: 3` gives
 * headroom to exercise multi-retry behavior without tripping the guard.
 */
const RETRY_HEADROOM_YAML = `\
name: retry-headroom
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 3
    steps:
      - id: code
        type: script
        run: "echo implement"
`;

/**
 * Workflow with `on_exceeded.status: "failed"` — exhausting attempts
 * should set status to "failed", not the default "blocked".
 */
const ON_EXCEEDED_FAILED_YAML = `\
name: retry-on-exceeded-failed
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 2
      on_exceeded:
        status: failed
    steps:
      - id: code
        type: script
        run: "echo implement"
`;

/**
 * Workflow without `on_exceeded` — backward-compat default is "blocked".
 */
const ON_EXCEEDED_DEFAULT_YAML = `\
name: retry-on-exceeded-default
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 1
    steps:
      - id: code
        type: script
        run: "echo implement"
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
  const projectRoot = join(tmpdir(), `zigma-retryjob-${randomUUID()}`);
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
  workflowName: string
): Promise<{ runId: string; runDir: string; workflowPath: string }> {
  const workflowPath = join(sandbox.projectRoot, `${workflowName}.yml`);
  await writeFile(workflowPath, yamlBody, "utf-8");

  const { runId } = await createRun({
    workflowPath,
    task: `exercise ${workflowName}`,
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
  payload: Record<string, unknown>;
}

async function readEvents(runDir: string): Promise<EventRecord[]> {
  const text = await readFile(join(runDir, "events.jsonl"), "utf-8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as EventRecord);
}

async function readStateSnapshot(runDir: string): Promise<RunState> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) throw new Error(`state.json missing at ${runDir}`);
  return snap;
}

async function readEventsBytes(runDir: string): Promise<string> {
  return readFile(join(runDir, "events.jsonl"), "utf-8");
}

async function readStateBytes(runDir: string): Promise<string> {
  return readFile(join(runDir, "state.json"), "utf-8");
}

interface JobStatePatch {
  status?: JobState["status"];
  attempt?: number;
  current_step?: string;
}

async function setJobState(
  runDir: string,
  jobId: string,
  patch: JobStatePatch
): Promise<void> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) throw new Error(`state.json missing at ${runDir}`);
  const existing = snap.jobs[jobId];
  if (existing === undefined) {
    throw new Error(`job ${jobId} not found in state.json at ${runDir}`);
  }
  const merged: JobState = { ...existing };
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.attempt !== undefined) merged.attempt = patch.attempt;
  if (patch.current_step !== undefined) merged.current_step = patch.current_step;
  snap.jobs[jobId] = merged;
  await store.writeSnapshot(runDir, snap);
}

/**
 * Helper to read `JobState.retry_inputs` even though field availability
 * depends on Step 2 of WF-P9-RETRY which already shipped. We still cast
 * defensively so the test remains compile-stable.
 */
function readRetryInputs(
  snap: RunState,
  jobId: string
): Record<string, string> | undefined {
  const js = snap.jobs[jobId] as unknown as {
    retry_inputs?: Record<string, string>;
  };
  return js?.retry_inputs;
}

// ---------------------------------------------------------------------------
// T-RETRY-1: failed job → ready, attempt++, job_retrying event
// ---------------------------------------------------------------------------

describe("retryJob — failed job becomes ready with attempt++ (T-RETRY-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "transitions failed → ready, increments attempt, clears current_step, emits job_retrying (T-RETRY-1, UC-RETRY-1, FP-RETRY-ENG-1/2/3/6)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETRY_HEADROOM_YAML,
        "retry-headroom"
      );

      await setJobState(runDir, "implement", {
        status: "failed",
        attempt: 1,
        current_step: "code",
      });

      await retryJob({
        runDir,
        runId,
        jobId: "implement",
        clock: new FakeClock(),
        reason: "manual retry from test",
      });

      const snap = await readStateSnapshot(runDir);
      const job = snap.jobs["implement"]!;
      expect(job.status).toBe("ready");
      expect(job.attempt).toBe(2);
      expect(job.current_step).toBeUndefined();

      const events = await readEvents(runDir);
      const tail = events[events.length - 1]!;
      expect(tail.type).toBe("job_retrying");
      expect(tail.payload).toMatchObject({
        job_id: "implement",
        attempt: 2,
        reason: "manual retry from test",
      });
      expect(snap.last_event_id).toBe(tail.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRY-2: completed job is also retryable
// ---------------------------------------------------------------------------

describe("retryJob — completed job is retryable (T-RETRY-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "transitions completed → ready and increments attempt (T-RETRY-2, UC-RETRY-2, FP-RETRY-ENG-1/2)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETRY_HEADROOM_YAML,
        "retry-headroom"
      );

      await setJobState(runDir, "implement", {
        status: "completed",
        attempt: 1,
      });

      await retryJob({
        runDir,
        runId,
        jobId: "implement",
        clock: new FakeClock(),
      });

      const snap = await readStateSnapshot(runDir);
      const job = snap.jobs["implement"]!;
      expect(job.status).toBe("ready");
      expect(job.attempt).toBe(2);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRY-3: running job → UserInputError; no disk mutation
// ---------------------------------------------------------------------------

describe("retryJob — running job rejected with UserInputError (T-RETRY-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws UserInputError for a running job; events.jsonl and state.json bytes are unchanged (T-RETRY-3, UC-RETRY-3, FP-RETRY-ENG-1)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETRY_HEADROOM_YAML,
        "retry-headroom"
      );

      await setJobState(runDir, "implement", {
        status: "running",
        attempt: 1,
        current_step: "code",
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        retryJob({
          runDir,
          runId,
          jobId: "implement",
          clock: new FakeClock(),
        })
      ).rejects.toMatchObject({ kind: "UserInputError" });

      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRY-4: max_attempts exceeded + on_exceeded.status="failed"
//           → status="failed", emits job_failed, no job_retrying
// ---------------------------------------------------------------------------

describe("retryJob — max_attempts exceeded with on_exceeded.status=failed (T-RETRY-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "writes job_failed (not job_retrying) and sets status to failed when attempts exhaust (T-RETRY-4, UC-RETRY-4, FP-RETRY-ENG-4)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        ON_EXCEEDED_FAILED_YAML,
        "retry-on-exceeded-failed"
      );

      await setJobState(runDir, "implement", {
        status: "failed",
        attempt: 2, // next would be 3 — exceeds max_attempts=2
      });

      await retryJob({
        runDir,
        runId,
        jobId: "implement",
        clock: new FakeClock(),
      });

      const snap = await readStateSnapshot(runDir);
      const job = snap.jobs["implement"]!;
      expect(job.status).toBe("failed");

      const events = await readEvents(runDir);
      const tail = events[events.length - 1]!;
      expect(tail.type).toBe("job_failed");
      expect(events.filter((e) => e.type === "job_retrying")).toHaveLength(0);
      expect(snap.last_event_id).toBe(tail.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRY-5: max_attempts exceeded with default on_exceeded → "blocked"
// ---------------------------------------------------------------------------

describe("retryJob — max_attempts exceeded default behavior (T-RETRY-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "without on_exceeded, exhausted retry defaults to blocked + emits job_blocked (T-RETRY-5, UC-RETRY-5, FP-RETRY-ENG-4)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        ON_EXCEEDED_DEFAULT_YAML,
        "retry-on-exceeded-default"
      );

      await setJobState(runDir, "implement", {
        status: "failed",
        attempt: 1, // next would be 2 — exceeds max_attempts=1
      });

      await retryJob({
        runDir,
        runId,
        jobId: "implement",
        clock: new FakeClock(),
      });

      const snap = await readStateSnapshot(runDir);
      const job = snap.jobs["implement"]!;
      expect(job.status).toBe("blocked");

      const events = await readEvents(runDir);
      const tail = events[events.length - 1]!;
      expect(tail.type).toBe("job_blocked");
      expect(events.filter((e) => e.type === "job_retrying")).toHaveLength(0);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRY-6: retryInputs are persisted as retry_inputs
// ---------------------------------------------------------------------------

describe("retryJob — retry_inputs persistence (T-RETRY-6)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "writes retryInputs verbatim into state.jobs[id].retry_inputs (T-RETRY-6, UC-RETRY-6, FP-RETRY-ENG-2/5)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETRY_HEADROOM_YAML,
        "retry-headroom"
      );

      await setJobState(runDir, "implement", {
        status: "failed",
        attempt: 1,
      });

      const inputs = { review_comments: "fix edge cases" };
      await retryJob({
        runDir,
        runId,
        jobId: "implement",
        clock: new FakeClock(),
        retryInputs: inputs,
      });

      const snap = await readStateSnapshot(runDir);
      const persisted = readRetryInputs(snap, "implement");
      expect(persisted).toEqual(inputs);
      expect(snap.jobs["implement"]!.status).toBe("ready");
      expect(snap.jobs["implement"]!.attempt).toBe(2);
    }
  );
});
