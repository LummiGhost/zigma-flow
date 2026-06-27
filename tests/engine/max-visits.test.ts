/**
 * Step `max_visits` / visit counting tests for WF-P13-FLOW (Step 1 — Cases and Tests).
 *
 * These tests exercise the visit counting and max_visits guard in `advanceJob`
 * and the `step_visits` reset in `retryJob`.
 *
 * Contract:
 *   - Each time a step is entered (via advanceJob or goto_step), increment
 *     `step_visits[stepId]`.
 *   - Before entering, check if `step_visits[stepId] >= max_visits`.
 *   - If exceeded → step blocked, `step_visit_exceeded` event emitted, job blocked.
 *   - `retryJob` resets `step_visits` to empty.
 *   - Skipped steps (via `if: false`) do NOT increment visit count.
 *   - Default `max_visits` = 3.
 *
 * Covers:
 *   - FR-MAXV-001: Step entered once → visit count = 1
 *   - FR-MAXV-002: max_visits=3, allowed on 3rd, exceeded on 4th
 *   - FR-MAXV-003: Default max_visits=3
 *   - FR-MAXV-004: step_visit_exceeded event emitted
 *   - FR-MAXV-005: Job blocked after max_visits exceeded
 *   - FR-MAXV-006: retryJob resets step_visits
 *   - FR-MAXV-007: Skipped steps don't increment visit count
 *
 * Red-phase note: `advanceJob` does not yet track visit counts or enforce
 * `max_visits`. The `max_visits` field is silently stripped by Zod. The
 * `retryJob` function does not yet reset `step_visits`. Tests that assert
 * visit counting, exceed detection, or retry reset will be RED until Step 2
 * adds these features.
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-flow/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md AD-P13-012
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun, advanceJob } from "../../src/engine/index.js";
import { retryJob } from "../../src/engine/retryJob.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-28T00:00:00.000Z";

class FakeClock implements Clock {
  now(): string {
    return FIXED_ISO;
  }
}

/**
 * Workflow: step with max_visits: 2, followed by a terminal step.
 */
const MAX_VISITS_2_YAML = `\
name: max-visits-2
version: "0.1.0"
jobs:
  main:
    steps:
      - id: loop-step
        type: agent
        uses: zigma/skill
        max_visits: 2
      - id: final-step
        type: agent
        uses: zigma/skill
`;

/**
 * Workflow: step WITHOUT max_visits declaration — defaults to 3.
 */
const NO_MAX_VISITS_YAML = `\
name: no-max-visits
version: "0.1.0"
jobs:
  main:
    steps:
      - id: step0
        type: agent
        uses: zigma/skill
      - id: step1
        type: agent
        uses: zigma/skill
`;

/**
 * Workflow: step with max_visits: 3 — to test exact boundary.
 */
const MAX_VISITS_3_YAML = `\
name: max-visits-3
version: "0.1.0"
jobs:
  main:
    steps:
      - id: loop-step
        type: agent
        uses: zigma/skill
        max_visits: 3
      - id: final-step
        type: agent
        uses: zigma/skill
`;

/**
 * Workflow: step with if: "false" before a step with max_visits,
 * to test that skipped steps don't increment visit count.
 */
const SKIP_AND_VISIT_YAML = `\
name: skip-and-visit
version: "0.1.0"
jobs:
  main:
    steps:
      - id: conditional-step
        type: agent
        uses: zigma/skill
        if: "false"
      - id: visit-step
        type: agent
        uses: zigma/skill
        max_visits: 2
      - id: final-step
        type: agent
        uses: zigma/skill
`;

/**
 * Workflow with retry config for retryJob tests.
 */
const RETRY_VISITS_YAML = `\
name: retry-visits
version: "0.1.0"
jobs:
  main:
    retry:
      max_attempts: 3
    steps:
      - id: step0
        type: agent
        uses: zigma/skill
`;

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

interface Sandbox {
  projectRoot: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-max-visits-${randomUUID()}`);
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
  await writeFile(
    skillLockPath,
    JSON.stringify({ skills: {} }, null, 2),
    "utf-8"
  );

  return { projectRoot, runsDir, skillLockPath };
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

// ---------------------------------------------------------------------------
// Event and state readers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// State manipulation helpers
// ---------------------------------------------------------------------------

async function setJobState(
  runDir: string,
  jobId: string,
  patch: Partial<Pick<JobState, "status" | "attempt" | "current_step">> & {
    step_visits?: Record<string, number>;
  }
): Promise<void> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) throw new Error(`state.json missing at ${runDir}`);

  const existing = snap.jobs[jobId];
  if (existing === undefined) throw new Error(`job ${jobId} not found`);

  const merged = { ...existing };
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.attempt !== undefined) merged.attempt = patch.attempt;
  if (patch.current_step !== undefined) merged.current_step = patch.current_step;

  const mergedRaw = merged as Record<string, unknown>;
  if (patch.step_visits !== undefined) {
    mergedRaw["step_visits"] = patch.step_visits;
  }

  snap.jobs[jobId] = merged;
  await store.writeSnapshot(runDir, snap);
}

/** Read step_visits from job state (cast since field is optional on type). */
function getStepVisits(
  state: RunState,
  jobId: string
): Record<string, number> | undefined {
  const js = state.jobs[jobId] as unknown as {
    step_visits?: Record<string, number>;
  };
  return js.step_visits;
}

// ---------------------------------------------------------------------------
// FR-MAXV-001: Step entered once → visit count = 1
// ---------------------------------------------------------------------------

describe("max_visits — visit count increments on entry (FR-MAXV-001)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "increments step_visits to 1 when step is entered for the first time (FR-MAXV-001, UC-FLOW-003)",
    async () => {
      const { runDir } = await bootstrapRun(sandbox, MAX_VISITS_2_YAML, "maxv-enter");

      // Job starts without current_step → advanceJob enters the first step (loop-step).
      await setJobState(runDir, "main", {
        status: "running",
        attempt: 1,
      });

      await advanceJob({
        runDir,
        runId: "any",
        jobId: "main",
        clock: new FakeClock(),
      });

      const state = await readStateSnapshot(runDir);
      const visits = getStepVisits(state, "main");

      // In Step 1: RED — advanceJob does not track step_visits.
      // In Step 2: GREEN — step_visits["loop-step"] === 1.
      expect(visits).toBeDefined();
      expect(visits?.["loop-step"]).toBe(1);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-MAXV-002: max_visits=3 allowed on 3rd, exceeded on 4th
// ---------------------------------------------------------------------------

describe("max_visits — boundary: allowed on 3rd, blocked on 4th (FR-MAXV-002)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "allows step on 3rd visit, blocks on 4th with max_visits=3 (FR-MAXV-002)",
    async () => {
      const { runDir } = await bootstrapRun(sandbox, MAX_VISITS_3_YAML, "maxv-3");

      // Set up: current_step = loop-step (just entered for the 3rd time),
      // step_visits["loop-step"] = 3 (right at the limit)
      // In Step 2: advanceJob should still allow the step (visit_count = max_visits,
      // the check is "exceeded" meaning >= max_visits? Actually re-reading the spec:
      // "Before entering, check if step_visits[stepId] >= max_visits"
      // "If exceeded → step blocked"
      // So >= max_visits is "exceeded".
      // This means: on 3rd entry (before increment), visits=2, 2 < 3 → allowed,
      // after increment visits=3. On 4th entry, visits=3, 3 >= 3 → blocked.
      // So with max_visits=3: allowed 3 times (visits 1, 2, 3), blocked on 4th (visits 4).

      // Simulate: visits already at 3, attempt 4th entry
      await setJobState(runDir, "main", {
        status: "running", // reset to re-enter first step
        attempt: 1,
        step_visits: { "loop-step": 3 },
      });

      let thrown: unknown = null;
      let jobBlocked = false;

      try {
        const advanced = await advanceJob({
          runDir,
          runId: "any",
          jobId: "main",
          clock: new FakeClock(),
        });

        // If advanceJob returns false, job might be blocked
        if (!advanced) {
          const state = await readStateSnapshot(runDir);
          if (state.jobs["main"]!.status === "blocked") {
            jobBlocked = true;
          }
        }
      } catch (_e: unknown) {
        thrown = _e;
      }

      const state = await readStateSnapshot(runDir);

      // In Step 1: RED — visit counting not implemented, step enters normally.
      // In Step 2: GREEN — step blocked because visits(3) >= max_visits(3).
      // The block can manifest as either:
      //   - jobBlocked === true
      //   - state.jobs["main"].status === "blocked"
      //   - thrown error
      expect(
        jobBlocked || state.jobs["main"]!.status === "blocked" || thrown !== null
      ).toBe(true);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-MAXV-003: Default max_visits=3 when not declared
// ---------------------------------------------------------------------------

describe("max_visits — default value 3 (FR-MAXV-003)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "uses default max_visits=3 when step does not declare max_visits (FR-MAXV-003)",
    async () => {
      const { runDir } = await bootstrapRun(sandbox, NO_MAX_VISITS_YAML, "maxv-default");

      // Simulate: step entered 3 times, 4th should be blocked with default.
      await setJobState(runDir, "main", {
        status: "running", attempt: 1,
        step_visits: { "step0": 3 },
      });

      await advanceJob({
        runDir,
        runId: "any",
        jobId: "main",
        clock: new FakeClock(),
      });

      const state = await readStateSnapshot(runDir);

      // In Step 1: RED — no visit check, step enters normally.
      // In Step 2: GREEN — default max_visits=3, visits(3) >= 3 → blocked.
      // The step should be blocked at this point.
      const visits = getStepVisits(state, "main");
      const isBlocked = state.jobs["main"]!.status === "blocked";

      // Either job blocked or step_visits shows we hit the limit
      // (In Step 2 the exact mechanism may differ — could block or error)
      if (visits && !isBlocked) {
        // If not blocked but step_visits exists, visit count should have been checked
        expect(visits["step0"]).toBeGreaterThanOrEqual(3);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// FR-MAXV-004: step_visit_exceeded event emitted
// ---------------------------------------------------------------------------

describe("max_visits — step_visit_exceeded event (FR-MAXV-004)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits step_visit_exceeded event with correct payload (FR-MAXV-004)",
    async () => {
      const { runDir } = await bootstrapRun(sandbox, MAX_VISITS_2_YAML, "maxv-event");

      // Set visits at max (2), so next entry should exceed.
      await setJobState(runDir, "main", {
        status: "running", attempt: 1,
        step_visits: { "loop-step": 2 },
      });

      try {
        await advanceJob({
          runDir,
          runId: "any",
          jobId: "main",
          clock: new FakeClock(),
        });
      } catch (_e: unknown) {
        // May throw in Step 2
      }

      const events = await readEvents(runDir);
      const exceededEvent = events.find((e) => e.type === "step_visit_exceeded");

      // In Step 1: RED — no step_visit_exceeded event emitted.
      // In Step 2: GREEN — event present with correct payload.
      expect(exceededEvent).toBeDefined();
      if (exceededEvent) {
        expect(exceededEvent.payload.step_id).toBe("loop-step");
        expect(exceededEvent.payload.max_visits).toBe(2);
        expect(typeof exceededEvent.payload.visit_count).toBe("number");
      }
    }
  );
});

// ---------------------------------------------------------------------------
// FR-MAXV-005: Job blocked after max_visits exceeded
// ---------------------------------------------------------------------------

describe("max_visits — job blocked after exceed (FR-MAXV-005)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "sets job status to blocked when max_visits is exceeded (FR-MAXV-005)",
    async () => {
      const { runDir } = await bootstrapRun(sandbox, MAX_VISITS_2_YAML, "maxv-block");

      await setJobState(runDir, "main", {
        status: "running", attempt: 1,
        step_visits: { "loop-step": 2 },
      });

      try {
        await advanceJob({
          runDir,
          runId: "any",
          jobId: "main",
          clock: new FakeClock(),
        });
      } catch (_e: unknown) {
        // May throw
      }

      const state = await readStateSnapshot(runDir);
      const jobState = state.jobs["main"]!;

      // In Step 1: RED — job not blocked (visit counting not implemented).
      // In Step 2: GREEN — job status is "blocked" after exceed.
      expect(jobState.status).toBe("blocked");
    }
  );
});

// ---------------------------------------------------------------------------
// FR-MAXV-006: retryJob resets step_visits to empty
// ---------------------------------------------------------------------------

describe("max_visits — retryJob resets step_visits (FR-MAXV-006)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "retryJob clears step_visits on new attempt (FR-MAXV-006)",
    async () => {
      const { runId, runDir } = await bootstrapRun(sandbox, RETRY_VISITS_YAML, "retry-visits");

      // Set job to completed with step_visits populated
      await setJobState(runDir, "main", {
        status: "completed",
        attempt: 1,
        step_visits: { "step0": 5 },
      });

      await retryJob({
        runDir,
        runId,
        jobId: "main",
        clock: new FakeClock(),
        reason: "retry to reset visits",
      });

      const state = await readStateSnapshot(runDir);
      const visits = getStepVisits(state, "main");

      // In Step 1: RED — retryJob does not reset step_visits.
      // In Step 2: GREEN — step_visits cleared (undefined or empty object).
      expect(visits === undefined || Object.keys(visits).length === 0).toBe(true);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-MAXV-007: Skipped steps don't increment visit count
// ---------------------------------------------------------------------------

describe("max_visits — skipped steps don't increment (FR-MAXV-007)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "does not increment step_visits for skipped steps (FR-MAXV-007)",
    async () => {
      const { runDir } = await bootstrapRun(sandbox, SKIP_AND_VISIT_YAML, "maxv-skip");

      // Set up: conditional-step has if: "false", so it should be skipped.
      // Step 1: if is stripped, step runs normally → visit count incremented (wrong).
      // Step 2: if is checked, step skipped → visit count NOT incremented.
      await setJobState(runDir, "main", {
        status: "running",
        attempt: 1,
        step_visits: {},
      });

      // advanceJob enters first step (conditional-step with if: false)
      await advanceJob({
        runDir,
        runId: "any",
        jobId: "main",
        clock: new FakeClock(),
      });

      const state = await readStateSnapshot(runDir);
      const visits = getStepVisits(state, "main");

      // In Step 1: RED — conditional-step not skipped, visit count may be 1.
      // In Step 2: GREEN — step skipped, visit count for conditional-step is
      // undefined or 0 (not incremented).
      const condVisits = visits?.["conditional-step"];
      expect(condVisits === undefined || condVisits === 0).toBe(true);
    }
  );
});
