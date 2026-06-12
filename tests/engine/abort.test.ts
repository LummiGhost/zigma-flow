/**
 * `abortRun` tests for WF-CLI-COMMANDS (Step 1 — Cases and Tests).
 *
 * Exercises the new Engine entry point that powers
 * `zigma-flow abort`. The function is invoked by the CLI to cancel
 * an active run without deleting any artifacts.
 *
 * Covers:
 *   - T-ABORT-1: normal abort → state.status = "cancelled",
 *                run_cancelled event appended.
 *   - T-ABORT-2: already-terminal run (completed/cancelled/failed)
 *                → StateError; no disk mutation.
 *   - T-ABORT-3: run_cancelled event payload includes the reason
 *                and envelope fields are correct.
 *   - T-ABORT-4: run directory and artifacts are preserved; job
 *                statuses are NOT modified.
 *
 * Reference:
 *   - docs/phases/p9p10-cli-admin-commands/workflows/wf-cli-commands/01-cases-and-tests.md
 *   - docs/prd.md §17, §18
 *   - docs/mvp-contracts.md §2.3, §2.4
 *
 * Red-phase note: `src/engine/abort.ts` does not yet exist; tests
 * will fail to compile until WF-CLI-COMMANDS Step 2 ships the module.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import { abortRun } from "../../src/engine/abort.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-12T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Minimal workflow with two jobs, one already running and one waiting.
 * abortRun should leave both job statuses untouched (MVP §18 semantics).
 */
const TWO_JOB_YAML = `\
name: abort-fixture
version: "0.1.0"
jobs:
  plan:
    steps:
      - id: plan-step
        type: script
        run: "echo plan"
  review:
    needs:
      - plan
    steps:
      - id: review-step
        type: script
        run: "echo review"
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
  const projectRoot = join(tmpdir(), `zigma-abort-${randomUUID()}`);
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
): Promise<{ runId: string; runDir: string }> {
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
  return { runId, runDir };
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

/**
 * Set state.status by reading/writing through LocalStateStore. createRun
 * does not currently set state.status to anything (it leaves the field
 * undefined per mvp-contracts §2.3). Tests that need a specific value
 * use this helper.
 */
async function setRunStatus(
  runDir: string,
  status: RunState["status"]
): Promise<void> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) throw new Error(`state.json missing at ${runDir}`);
  const next: RunState = { ...snap };
  if (status === undefined) {
    delete (next as { status?: RunState["status"] }).status;
  } else {
    next.status = status;
  }
  await store.writeSnapshot(runDir, next);
}

async function setJobStatus(
  runDir: string,
  jobId: string,
  status: JobState["status"]
): Promise<void> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) throw new Error(`state.json missing at ${runDir}`);
  const existing = snap.jobs[jobId];
  if (existing === undefined) {
    throw new Error(`job ${jobId} not found at ${runDir}`);
  }
  snap.jobs[jobId] = { ...existing, status };
  await store.writeSnapshot(runDir, snap);
}

// ---------------------------------------------------------------------------
// T-ABORT-1: normal abort → state.status = "cancelled"
// ---------------------------------------------------------------------------

describe("abortRun — normal active run becomes cancelled (T-ABORT-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "sets state.status to cancelled, appends run_cancelled, updates last_event_id (T-ABORT-1, UC-ABORT-1, FP-ABORT-ENG-2/4)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        TWO_JOB_YAML,
        "abort-fixture"
      );

      await abortRun({
        runDir,
        runId,
        clock: new FakeClock(),
        reason: "user abort",
      });

      const snap = await readStateSnapshot(runDir);
      expect(snap.status).toBe("cancelled");

      const events = await readEvents(runDir);
      const tail = events[events.length - 1]!;
      expect(tail.type).toBe("run_cancelled");
      expect(tail.run_id).toBe(runId);
      expect(snap.last_event_id).toBe(tail.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ABORT-2: already-terminal run → StateError; no disk mutation
// ---------------------------------------------------------------------------

describe("abortRun — terminal run rejects with StateError (T-ABORT-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws StateError when run.status is already terminal; bytes unchanged (T-ABORT-2, UC-ABORT-2, FP-ABORT-ENG-1)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        TWO_JOB_YAML,
        "abort-fixture"
      );

      // Force the run into a terminal state.
      await setRunStatus(runDir, "completed");

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        abortRun({
          runDir,
          runId,
          clock: new FakeClock(),
        })
      ).rejects.toMatchObject({ kind: "StateError" });

      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ABORT-3: run_cancelled payload has reason and envelope fields
// ---------------------------------------------------------------------------

describe("abortRun — run_cancelled event payload (T-ABORT-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "run_cancelled carries reason in payload and envelope run_id (T-ABORT-3, UC-ABORT-3, FP-ABORT-ENG-2)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        TWO_JOB_YAML,
        "abort-fixture"
      );

      await abortRun({
        runDir,
        runId,
        clock: new FakeClock(),
        reason: "ctrl-c",
      });

      const events = await readEvents(runDir);
      const cancelled = events.find((e) => e.type === "run_cancelled");
      expect(cancelled).toBeDefined();
      expect(cancelled!.run_id).toBe(runId);
      // Producer + envelope basics.
      expect(cancelled!.job).toBeNull();
      expect(cancelled!.step).toBeNull();
      expect(cancelled!.payload).toMatchObject({ reason: "ctrl-c" });
    }
  );
});

// ---------------------------------------------------------------------------
// T-ABORT-4: run directory preserved; job statuses NOT modified
// ---------------------------------------------------------------------------

describe("abortRun — run directory and job statuses preserved (T-ABORT-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "run.yml + state.json + events.jsonl + arbitrary artifact all remain; job statuses are unchanged (T-ABORT-4, UC-ABORT-4, FP-ABORT-ENG-3)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        TWO_JOB_YAML,
        "abort-fixture"
      );

      // Force one job to running so we can verify abortRun does NOT
      // rewrite it to cancelled.
      await setJobStatus(runDir, "plan", "running");

      // Drop an artifact file under the run directory.
      const artifactPath = join(runDir, "artifact-evidence.txt");
      await writeFile(artifactPath, "do not delete me", "utf-8");

      await abortRun({
        runDir,
        runId,
        clock: new FakeClock(),
        reason: "preserve test",
      });

      // Run directory still readable.
      const dirStat = await stat(runDir);
      expect(dirStat.isDirectory()).toBe(true);

      // Artifact still present.
      const artifactBody = await readFile(artifactPath, "utf-8");
      expect(artifactBody).toBe("do not delete me");

      // run.yml + state.json + events.jsonl all readable.
      await readFile(join(runDir, "run.yml"), "utf-8");
      await readFile(join(runDir, "events.jsonl"), "utf-8");

      const snap = await readStateSnapshot(runDir);
      expect(snap.status).toBe("cancelled");

      // Job statuses untouched — plan was set to "running"; abort does
      // NOT downgrade individual jobs in MVP.
      const plan = snap.jobs["plan"]!;
      expect(plan.status).toBe("running");
    }
  );
});
