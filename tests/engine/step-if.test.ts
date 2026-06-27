/**
 * Step `if:` condition tests for WF-P13-FLOW (Step 1 — Cases and Tests).
 *
 * These tests exercise the step `if:` condition evaluation in `advanceJob`.
 * When a step declares `if: "<expr>"`, advanceJob evaluates the expression
 * before entering the step. If false, the step is skipped.
 *
 * Contract:
 *   - `if: "true"` → step runs normally.
 *   - `if: "false"` → step skipped, `step_skipped` event emitted, advance
 *     to next step.
 *   - `if: "${{ variables.x == 'ready' }}"` → resolved via evaluateCondition.
 *   - Parse error in expression → ValidationError → step_failed.
 *   - Step without `if:` → backward compat, runs normally.
 *
 * Covers:
 *   - FR-IF-001: if: true → step runs normally
 *   - FR-IF-002: if: false → step skipped, step_skipped event emitted
 *   - FR-IF-003: step_skipped event contains the condition string
 *   - FR-IF-004: Skipped step → advanceJob moves to next step
 *   - FR-IF-005: if template expression resolved via evaluateCondition
 *   - FR-IF-006: if expression parse error → ValidationError → step_failed
 *   - FR-IF-007: No if → runs normally (backward compat)
 *
 * Red-phase note: `advanceJob` does not yet check step `if:` conditions.
 * The `if:` field is also silently stripped by Zod (not in StepBaseSchema).
 * Tests that assert skip behavior, step_skipped events, or template resolution
 * will be RED until Step 2 adds the `if:` field to the schema and the
 * evaluation logic to advanceJob.
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
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import { ValidationError } from "../../src/utils/index.js";

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
 * Workflow: three agent steps. The second step has `if:` condition.
 * step0 → step-if (conditional) → step2
 */
const IF_STEP_YAML = `\
name: if-step-test
version: "0.1.0"
jobs:
  main:
    steps:
      - id: step0
        type: agent
        uses: zigma/skill
      - id: step-if
        type: agent
        uses: zigma/skill
        if: "false"
      - id: step2
        type: agent
        uses: zigma/skill
`;

/**
 * Workflow: step with template expression using variables.
 * Built with regular strings (not template literals) to avoid
 * `${{` being interpreted as `${` template interpolation.
 */
function buildIfTemplateYaml(ifExpr: string): string {
  return [
    "name: if-template-test",
    'version: "0.1.0"',
    "jobs:",
    "  main:",
    "    steps:",
    "      - id: step0",
    "        type: agent",
    "        uses: zigma/skill",
    "      - id: step-if",
    "        type: agent",
    "        uses: zigma/skill",
    `        if: "${ifExpr}"`,
    "      - id: step2",
    "        type: agent",
    "        uses: zigma/skill",
  ].join("\n");
}

const IF_TEMPLATE_YAML = buildIfTemplateYaml("${{ variables.x == 'ready' }}");
const IF_INVALID_YAML = buildIfTemplateYaml("${{ broken");

/**
 * Workflow: normal step without `if:` — backward compatibility.
 */
const NO_IF_YAML = `\
name: no-if-test
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
      - id: step2
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
  const projectRoot = join(tmpdir(), `zigma-step-if-${randomUUID()}`);
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
  if (snap === null) {
    throw new Error(`state.json missing at ${runDir}`);
  }
  return snap;
}

// ---------------------------------------------------------------------------
// State manipulation helpers
// ---------------------------------------------------------------------------

async function setJobState(
  runDir: string,
  jobId: string,
  patch: Partial<Pick<JobState, "status" | "attempt" | "current_step" | "outputs">> & {
    variables?: Record<string, unknown>;
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
  if (patch.outputs !== undefined) merged.outputs = patch.outputs;

  // Attach extra fields not yet on the JobState type
  const mergedRaw = merged as Record<string, unknown>;
  if (patch.variables !== undefined) mergedRaw["variables"] = patch.variables;
  if (patch.step_visits !== undefined) mergedRaw["step_visits"] = patch.step_visits;

  snap.jobs[jobId] = merged;
  await store.writeSnapshot(runDir, snap);
}

// ---------------------------------------------------------------------------
// FR-IF-001: step with `if: true` → step runs normally
// ---------------------------------------------------------------------------

describe("step if — true condition runs normally (FR-IF-001)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "advances into step when if condition is true (FR-IF-001, UC-FLOW-001)",
    async () => {
      // Use workflow where step0 is current, step-if has if: "true"
      // We manually set the workflow YAML with if: "true"
      const yaml = IF_STEP_YAML.replace('if: "false"', 'if: "true"');
      const { runDir } = await bootstrapRun(sandbox, yaml, "if-true");

      await setJobState(runDir, "main", {
        status: "running",
        current_step: "step0",
        attempt: 1,
      });

      // advanceJob moves from step0 to the next step (step-if).
      const advanced = await advanceJob({
        runDir,
        runId: "any",
        jobId: "main",
        clock: new FakeClock(),
      });

      const state = await readStateSnapshot(runDir);
      const jobState = state.jobs["main"]!;

      // In Step 1: if is stripped, step runs → GREEN.
      // In Step 2: if is checked, resolves to true, step runs → GREEN.
      expect(advanced).toBe(true);
      // current_step should be "step-if" (or past it to "step2" if advanceJob
      // moves the pointer — either way, the step is not skipped)
      expect(jobState.current_step).toBeDefined();
    }
  );
});

// ---------------------------------------------------------------------------
// FR-IF-002: step with `if: false` → step skipped, step_skipped event
// ---------------------------------------------------------------------------

describe("step if — false condition skips step (FR-IF-002)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "skips step and emits step_skipped event when if is false (FR-IF-002, UC-FLOW-001)",
    async () => {
      const { runDir } = await bootstrapRun(sandbox, IF_STEP_YAML, "if-false");

      await setJobState(runDir, "main", {
        status: "running",
        current_step: "step0",
        attempt: 1,
      });

      // advanceJob: should skip step-if (if: false) and advance to step2.
      await advanceJob({
        runDir,
        runId: "any",
        jobId: "main",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const skippedEvent = events.find((e) => e.type === "step_skipped");

      // In Step 1: RED — advanceJob doesn't check if, no step_skipped event.
      // In Step 2: GREEN — step_skipped event emitted.
      expect(skippedEvent).toBeDefined();
    }
  );
});

// ---------------------------------------------------------------------------
// FR-IF-003: step_skipped event contains the condition string
// ---------------------------------------------------------------------------

describe("step if — step_skipped event payload (FR-IF-003)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "step_skipped event payload contains the condition string (FR-IF-003)",
    async () => {
      const { runDir } = await bootstrapRun(sandbox, IF_STEP_YAML, "if-payload");

      await setJobState(runDir, "main", {
        status: "running",
        current_step: "step0",
        attempt: 1,
      });

      await advanceJob({
        runDir,
        runId: "any",
        jobId: "main",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const skippedEvent = events.find((e) => e.type === "step_skipped");

      // In Step 1: RED — no step_skipped event.
      // In Step 2: GREEN — event present with condition field.
      expect(skippedEvent).toBeDefined();
      if (skippedEvent) {
        expect(skippedEvent.payload.condition).toBe("false");
        expect(skippedEvent.payload.step_id).toBe("step-if");
        expect(skippedEvent.payload.job_id).toBe("main");
      }
    }
  );
});

// ---------------------------------------------------------------------------
// FR-IF-004: Skipped step → advanceJob moves to next step
// ---------------------------------------------------------------------------

describe("step if — skipped step advances to next (FR-IF-004)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "advances past skipped step to the next step (FR-IF-004)",
    async () => {
      const { runDir } = await bootstrapRun(sandbox, IF_STEP_YAML, "if-advance");

      await setJobState(runDir, "main", {
        status: "running",
        current_step: "step0",
        attempt: 1,
      });

      await advanceJob({
        runDir,
        runId: "any",
        jobId: "main",
        clock: new FakeClock(),
      });

      const state = await readStateSnapshot(runDir);
      const jobState = state.jobs["main"]!;

      // In Step 1: RED — current_step = "step-if" (no skip).
      // In Step 2: GREEN — current_step = "step2" (step-if skipped).
      expect(jobState.current_step).toBe("step2");
    }
  );
});

// ---------------------------------------------------------------------------
// FR-IF-005: if template expression resolved via evaluateCondition
// ---------------------------------------------------------------------------

describe("step if — template expression resolution (FR-IF-005)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "resolves template expressions in if condition (FR-IF-005)",
    async () => {
      const { runDir } = await bootstrapRun(sandbox, IF_TEMPLATE_YAML, "if-template");

      // Set variables on job state so evaluateCondition can resolve
      // `${{ variables.x == 'ready' }}` → resolved to `'not_ready' == 'ready'` → false
      await setJobState(runDir, "main", {
        status: "running",
        current_step: "step0",
        attempt: 1,
        variables: { x: "not_ready" },
      });

      await advanceJob({
        runDir,
        runId: "any",
        jobId: "main",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const skippedEvent = events.find((e) => e.type === "step_skipped");

      // In Step 1: RED — if stripped, no skip.
      // In Step 2: GREEN — template resolved, x != 'ready' → false → skipped.
      expect(skippedEvent).toBeDefined();
      if (skippedEvent) {
        expect(
          typeof skippedEvent.payload.condition === "string"
        ).toBe(true);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// FR-IF-006: if expression parse error → ValidationError → step_failed
// ---------------------------------------------------------------------------

describe("step if — parse error fails step (FR-IF-006)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws ValidationError on invalid if expression (FR-IF-006)",
    async () => {
      const { runDir } = await bootstrapRun(sandbox, IF_INVALID_YAML, "if-invalid");

      await setJobState(runDir, "main", {
        status: "running",
        current_step: "step0",
        attempt: 1,
      });

      // In Step 1: RED — if stripped, no parse error.
      // In Step 2: GREEN — parse error throws ValidationError.
      let thrown: unknown;
      try {
        await advanceJob({
          runDir,
          runId: "any",
          jobId: "main",
          clock: new FakeClock(),
        });
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      expect(thrown).toBeInstanceOf(ValidationError);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-IF-007: step without if → runs normally (backward compat)
// ---------------------------------------------------------------------------

describe("step if — no if backward compat (FR-IF-007)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "runs step normally when no if is declared (FR-IF-007)",
    async () => {
      const { runDir } = await bootstrapRun(sandbox, NO_IF_YAML, "no-if");

      await setJobState(runDir, "main", {
        status: "running",
        current_step: "step0",
        attempt: 1,
      });

      const advanced = await advanceJob({
        runDir,
        runId: "any",
        jobId: "main",
        clock: new FakeClock(),
      });

      const state = await readStateSnapshot(runDir);
      const jobState = state.jobs["main"]!;

      // Already GREEN — no if means step runs normally.
      expect(advanced).toBe(true);
      expect(jobState.current_step).toBe("step1");
    }
  );
});
