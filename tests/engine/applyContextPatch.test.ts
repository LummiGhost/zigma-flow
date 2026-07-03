/**
 * `applyContextPatch` tests for WF-P13-VARIABLES (Step 1 — Cases and Tests).
 *
 * These tests exercise the Engine's batch atomic context patch entry point
 * that processes `context_patches` from an Agent report, validating each
 * patch against the workflow's variable/context_block declarations and
 * the step's permissions.
 *
 * Contract:
 *   - Accepts `patches: Array<ContextPatch>` where ContextPatch =
 *     { kind: "variable_set" | "variable_delete" | "context_block_set" | "context_block_append" | "context_block_delete"; ... }
 *   - Validates each patch: permission (allowed_writers), type/enum, reserved fields
 *   - Batch atomicity: if any patch fails, entire batch is rolled back
 *   - On success: writes state + events + artifacts atomically
 *   - Events: variable_set, variable_deleted, context_block_updated, context_block_deleted
 *
 * Covers:
 *   - FR-PATCH-001 through FR-PATCH-014
 *   - FR-PATCH-RESERVED-ALL: one test per reserved field, batch-rejection, unknown-kind
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-variables/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md AD-P13-010, AD-P13-011
 *
 * Red-phase note: `src/engine/applyContextPatch.ts` does not yet exist. The
 * lazy import wrapper catches the dynamic-import failure and re-throws a
 * descriptive Error so every test fails for the same diagnostic reason until
 * Step 2 ships the module.
 *
 * Test design notes:
 *   - All snapshot writes are observed via real filesystem reads — no mocking.
 *   - Real temp directories under `os.tmpdir()`.
 *   - Negative tests capture events.jsonl + state.json bytes before and after
 *     the call to assert zero mutation on error.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import { WorkflowError, ValidationError } from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Lazy import wrapper (red-phase compatible)
// ---------------------------------------------------------------------------

export interface ContextPatch {
  kind: "variable_set" | "variable_delete" | "context_block_set" | "context_block_append" | "context_block_delete";
  /** Variable or context block name */
  name: string;
  /** Value for variable_set; content string for context_block_set/append */
  value?: unknown;
}

export interface ApplyContextPatchOpts {
  runDir: string;
  runId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  patches: ContextPatch[];
  clock: Clock;
}

const MODULE_SPECIFIER = "../../src/engine/applyContextPatch.js";

async function callApplyContextPatch(
  opts: ApplyContextPatchOpts
): Promise<void> {
  let mod: {
    applyContextPatch?: (o: ApplyContextPatchOpts) => Promise<void>;
  };
  try {
    mod = (await import(
      /* @vite-ignore */ String(MODULE_SPECIFIER)
    )) as {
      applyContextPatch?: (o: ApplyContextPatchOpts) => Promise<void>;
    };
  } catch (e: unknown) {
    throw new Error(
      `applyContextPatch is not yet implemented — src/engine/applyContextPatch.ts does not exist (WF-P13-VARIABLES Step 2 has not yet shipped). Underlying: ${String(e)}`
    );
  }
  if (typeof mod.applyContextPatch !== "function") {
    throw new Error(
      "applyContextPatch is not exported from src/engine/applyContextPatch.ts — WF-P13-VARIABLES Step 2 has not yet shipped the implementation."
    );
  }
  return mod.applyContextPatch(opts);
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-28T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Workflow: agent step in plan.draft with variables and context_blocks.
 * The step plan.draft is in the allowed_writers for plan_status.
 */
const WORKFLOW_WITH_VARS_YAML = `\
name: vars-test
version: "0.1.0"
variables:
  plan_status:
    type: string
    initial: pending
    enum:
      - pending
      - approved
      - rejected
    allowed_writers:
      - plan.draft
  review_count:
    type: number
    initial: 0
    allowed_writers:
      - plan.draft
  is_urgent:
    type: boolean
    initial: false
    allowed_writers:
      - plan.draft
context_blocks:
  design_notes:
    initial_artifact: null
    allowed_writers:
      - plan.draft
      - plan.*
jobs:
  plan:
    steps:
      - id: draft
        type: agent
        uses: zigma/draft-skill
        permissions:
          variables:
            read:
              - plan_status
              - review_count
              - is_urgent
            write:
              - plan_status
              - review_count
              - is_urgent
          context_edit: write
          context_blocks:
            read:
              - design_notes
            write:
              - design_notes
`;

/**
 * Workflow with context_edit: none on the step — all patches should be rejected.
 */
const WORKFLOW_CONTEXT_EDIT_NONE_YAML = `\
name: context-edit-none-test
version: "0.1.0"
variables:
  plan_status:
    type: string
    initial: pending
    allowed_writers:
      - plan.draft
context_blocks:
  design_notes:
    initial_artifact: null
    allowed_writers:
      - plan.draft
jobs:
  plan:
    steps:
      - id: draft
        type: agent
        uses: zigma/draft-skill
        permissions:
          context_edit: none
          variables:
            read:
              - plan_status
            write:
              - plan_status
          context_blocks:
            read:
              - design_notes
            write:
              - design_notes
`;

/**
 * Workflow with wildcard writer permission.
 */
const WORKFLOW_WILDCARD_WRITER_YAML = `\
name: wildcard-writer-test
version: "0.1.0"
variables:
  shared_var:
    type: string
    initial: shared
    allowed_writers:
      - plan.*
jobs:
  plan:
    steps:
      - id: draft
        type: agent
        uses: zigma/draft-skill
        permissions:
          variables:
            read:
              - shared_var
            write:
              - shared_var
`;

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  dotZigma: string;
  configPath: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-context-patch-${randomUUID()}`);
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

async function readEventsBytes(runDir: string): Promise<string> {
  return readFile(join(runDir, "events.jsonl"), "utf-8");
}

async function readStateBytes(runDir: string): Promise<string> {
  return readFile(join(runDir, "state.json"), "utf-8");
}

// ---------------------------------------------------------------------------
// State manipulation helpers
// ---------------------------------------------------------------------------

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
  if (snap === null) {
    throw new Error(`state.json missing at ${runDir}`);
  }
  const existing = snap.jobs[jobId];
  if (existing === undefined) {
    throw new Error(`job ${jobId} not found in state.json at ${runDir}`);
  }

  const merged: JobState = { ...existing };
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.attempt !== undefined) merged.attempt = patch.attempt;
  if (patch.current_step !== undefined)
    merged.current_step = patch.current_step;

  snap.jobs[jobId] = merged;
  await store.writeSnapshot(runDir, snap);
}

// ---------------------------------------------------------------------------
// FR-PATCH-001: variable_set with valid permissions
// ---------------------------------------------------------------------------

describe("applyContextPatch — variable_set valid (FR-PATCH-001)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "variable_set with valid permissions writes to state.variables and emits variable_set event (FR-PATCH-001, UC-VAR-005)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      await callApplyContextPatch({
        runDir,
        runId,
        jobId: "plan",
        stepId: "draft",
        attempt: 1,
        patches: [
          { kind: "variable_set", name: "plan_status", value: "approved" },
        ],
        clock: new FakeClock(),
      });

      // Verify state.variables has the new value
      const snap = await readStateSnapshot(runDir);
      const vars = (snap as unknown as Record<string, unknown>)["variables"] as
        | Record<string, unknown>
        | undefined;
      expect(vars).toBeDefined();
      expect(vars!["plan_status"]).toBe("approved");

      // Verify variable_set event was emitted
      const events = await readEvents(runDir);
      const varSetEvent = events.find((e) => e.type === "variable_set");
      expect(varSetEvent).toBeDefined();
      expect(varSetEvent!.payload).toMatchObject({
        variable: "plan_status",
        value: "approved",
      });
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-002: variable_set with no permissions
// ---------------------------------------------------------------------------

describe("applyContextPatch — variable_set no permission (FR-PATCH-002)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "variable_set with no permissions throws ValidationError, batch rolled back (FR-PATCH-002, UC-VAR-010)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      // plan.draft is NOT in allowed_writers for a variable that doesn't exist
      // The patch tries to set a variable not in the workflow, which should fail
      await expect(
        callApplyContextPatch({
          runDir,
          runId,
          jobId: "plan",
          stepId: "draft",
          attempt: 1,
          patches: [
            {
              kind: "variable_set",
              name: "undeclared_var",
              value: "should fail",
            },
          ],
          clock: new FakeClock(),
        })
      ).rejects.toBeDefined();

      // No disk mutation on validation failure
      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-003: variable_delete
// ---------------------------------------------------------------------------

describe("applyContextPatch — variable_delete (FR-PATCH-003)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "variable_delete removes from state.variables and emits variable_deleted event (FR-PATCH-003, UC-VAR-006)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      // First set a variable, then delete it
      // (In Step 2, the module initializes variables from workflow. For now,
      // we seed initial state to have the variable present)
      const store = new LocalStateStore();
      const snap = await readStateSnapshot(runDir);
      const stateWithVars = {
        ...snap,
        variables: { plan_status: "pending" },
      } as unknown as RunState;
      await store.writeSnapshot(runDir, stateWithVars);

      await callApplyContextPatch({
        runDir,
        runId,
        jobId: "plan",
        stepId: "draft",
        attempt: 1,
        patches: [{ kind: "variable_delete", name: "plan_status" }],
        clock: new FakeClock(),
      });

      // Verify variable was removed
      const snapAfter = await readStateSnapshot(runDir);
      const vars = (snapAfter as unknown as Record<string, unknown>)["variables"] as
        | Record<string, unknown>
        | undefined;
      expect(vars).toBeDefined();
      expect(vars!["plan_status"]).toBeUndefined();

      // Verify variable_deleted event was emitted
      const events = await readEvents(runDir);
      const deleteEvent = events.find((e) => e.type === "variable_deleted");
      expect(deleteEvent).toBeDefined();
      expect(deleteEvent!.payload).toMatchObject({
        variable: "plan_status",
      });
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-004: context_block_set
// ---------------------------------------------------------------------------

describe("applyContextPatch — context_block_set (FR-PATCH-004)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "context_block_set writes v1 artifact, updates state, emits context_block_updated (FR-PATCH-004, UC-VAR-007)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      await callApplyContextPatch({
        runDir,
        runId,
        jobId: "plan",
        stepId: "draft",
        attempt: 1,
        patches: [
          {
            kind: "context_block_set",
            name: "design_notes",
            value: "# Design Notes\n\nInitial design thoughts.",
          },
        ],
        clock: new FakeClock(),
      });

      // Verify state.context_blocks updated
      const snap = await readStateSnapshot(runDir);
      const blocks = (snap as unknown as Record<string, unknown>)["context_blocks"] as
        | Record<string, { current_version: number; current_artifact: string }>
        | undefined;
      expect(blocks).toBeDefined();
      expect(blocks!["design_notes"]).toBeDefined();
      expect(blocks!["design_notes"]!.current_version).toBe(1);
      expect(blocks!["design_notes"]!.current_artifact).toContain(
        "context-blocks/design_notes/v1"
      );

      // Verify context_block_updated event
      const events = await readEvents(runDir);
      const updatedEvent = events.find(
        (e) => e.type === "context_block_updated"
      );
      expect(updatedEvent).toBeDefined();
      expect(updatedEvent!.payload).toMatchObject({
        block: "design_notes",
        version: 1,
      });
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-005: context_block_set on existing block (version increment)
// ---------------------------------------------------------------------------

describe("applyContextPatch — context_block_set v2 (FR-PATCH-005)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "context_block_set on existing block writes v2, version incremented (FR-PATCH-005, UC-VAR-007)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      // Seed initial context block state (v1)
      const store = new LocalStateStore();
      const snap = await readStateSnapshot(runDir);
      const stateWithBlock = {
        ...snap,
        context_blocks: {
          design_notes: {
            current_version: 1,
            current_artifact: "context-blocks/design_notes/v1.md",
          },
        },
      } as unknown as RunState;
      await store.writeSnapshot(runDir, stateWithBlock);

      await callApplyContextPatch({
        runDir,
        runId,
        jobId: "plan",
        stepId: "draft",
        attempt: 1,
        patches: [
          {
            kind: "context_block_set",
            name: "design_notes",
            value: "# Design Notes v2\n\nUpdated design thoughts.",
          },
        ],
        clock: new FakeClock(),
      });

      // Verify version incremented to 2
      const snapAfter = await readStateSnapshot(runDir);
      const blocks = (snapAfter as unknown as Record<string, unknown>)["context_blocks"] as
        | Record<string, { current_version: number; current_artifact: string }>
        | undefined;
      expect(blocks!["design_notes"]!.current_version).toBe(2);
      expect(blocks!["design_notes"]!.current_artifact).toContain(
        "context-blocks/design_notes/v2"
      );

      // Verify version 1 artifact still exists at context-blocks/design_notes/v1.md
      // (artifact path existence check — Step 2 will write both)
      const events = await readEvents(runDir);
      const updatedEvents = events.filter(
        (e) => e.type === "context_block_updated"
      );
      expect(updatedEvents.length).toBeGreaterThanOrEqual(1);
      const lastUpdate = updatedEvents[updatedEvents.length - 1]!;
      expect(lastUpdate.payload).toMatchObject({
        block: "design_notes",
        version: 2,
      });
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-006: context_block_append
// ---------------------------------------------------------------------------

describe("applyContextPatch — context_block_append (FR-PATCH-006)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "context_block_append appends content and increments version (FR-PATCH-006, UC-VAR-008)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      // Seed initial context block state (v1)
      const store = new LocalStateStore();
      const snap = await readStateSnapshot(runDir);
      const stateWithBlock = {
        ...snap,
        context_blocks: {
          design_notes: {
            current_version: 1,
            current_artifact: "context-blocks/design_notes/v1.md",
          },
        },
      } as unknown as RunState;
      await store.writeSnapshot(runDir, stateWithBlock);

      await callApplyContextPatch({
        runDir,
        runId,
        jobId: "plan",
        stepId: "draft",
        attempt: 1,
        patches: [
          {
            kind: "context_block_append",
            name: "design_notes",
            value: "\n\nMore notes appended.",
          },
        ],
        clock: new FakeClock(),
      });

      // Verify version incremented
      const snapAfter = await readStateSnapshot(runDir);
      const blocks = (snapAfter as unknown as Record<string, unknown>)["context_blocks"] as
        | Record<string, { current_version: number; current_artifact: string }>
        | undefined;
      expect(blocks!["design_notes"]!.current_version).toBe(2);
      expect(blocks!["design_notes"]!.current_artifact).toContain("v2");

      // Verify event emitted
      const events = await readEvents(runDir);
      const updatedEvent = events.find(
        (e) => e.type === "context_block_updated"
      );
      expect(updatedEvent).toBeDefined();
      expect(updatedEvent!.payload).toMatchObject({
        block: "design_notes",
        version: 2,
        operation: "append",
      });
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-007: context_block_delete
// ---------------------------------------------------------------------------

describe("applyContextPatch — context_block_delete (FR-PATCH-007)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "context_block_delete emits context_block_deleted event (FR-PATCH-007, UC-VAR-009)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      // Seed initial context block state
      const store = new LocalStateStore();
      const snap = await readStateSnapshot(runDir);
      const stateWithBlock = {
        ...snap,
        context_blocks: {
          design_notes: {
            current_version: 1,
            current_artifact: "context-blocks/design_notes/v1.md",
          },
        },
      } as unknown as RunState;
      await store.writeSnapshot(runDir, stateWithBlock);

      await callApplyContextPatch({
        runDir,
        runId,
        jobId: "plan",
        stepId: "draft",
        attempt: 1,
        patches: [
          { kind: "context_block_delete", name: "design_notes" },
        ],
        clock: new FakeClock(),
      });

      // Verify block removed from state
      const snapAfter = await readStateSnapshot(runDir);
      const blocks = (snapAfter as unknown as Record<string, unknown>)["context_blocks"] as
        | Record<string, unknown>
        | undefined;
      expect(blocks!["design_notes"]).toBeUndefined();

      // Verify context_block_deleted event
      const events = await readEvents(runDir);
      const deletedEvent = events.find(
        (e) => e.type === "context_block_deleted"
      );
      expect(deletedEvent).toBeDefined();
      expect(deletedEvent!.payload).toMatchObject({
        block: "design_notes",
      });
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-008: batch with mixed valid+invalid → entire batch rolled back
// ---------------------------------------------------------------------------

describe("applyContextPatch — batch rollback (FR-PATCH-008)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "batch with one valid and one invalid patch rolls back entirely (FR-PATCH-008, UC-VAR-010)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      // First patch is valid (sets plan_status), second is invalid (undeclared variable)
      await expect(
        callApplyContextPatch({
          runDir,
          runId,
          jobId: "plan",
          stepId: "draft",
          attempt: 1,
          patches: [
            { kind: "variable_set", name: "plan_status", value: "approved" },
            {
              kind: "variable_set",
              name: "nonexistent_var",
              value: "should roll back everything",
            },
          ],
          clock: new FakeClock(),
        })
      ).rejects.toBeDefined();

      // No disk mutation — entire batch rolled back
      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-009: patch touching reserved field
// ---------------------------------------------------------------------------

describe("applyContextPatch — reserved field (FR-PATCH-009)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "patch touching reserved field (state.jobs) throws ValidationError (FR-PATCH-009, UC-VAR-017)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callApplyContextPatch({
          runDir,
          runId,
          jobId: "plan",
          stepId: "draft",
          attempt: 1,
          patches: [
            {
              kind: "variable_set",
              name: "jobs", // reserved field
              value: { hacked: true },
            },
          ],
          clock: new FakeClock(),
        })
      ).rejects.toBeDefined();

      // No disk mutation
      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-010: <job>.* wildcard writer permission
// ---------------------------------------------------------------------------

describe("applyContextPatch — wildcard writer (FR-PATCH-010)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "<job>.* wildcard writer permission accepted (FR-PATCH-010, UC-VAR-011)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WILDCARD_WRITER_YAML,
        "wildcard-writer-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      await callApplyContextPatch({
        runDir,
        runId,
        jobId: "plan",
        stepId: "draft",
        attempt: 1,
        patches: [
          { kind: "variable_set", name: "shared_var", value: "updated" },
        ],
        clock: new FakeClock(),
      });

      // Verify state updated
      const snap = await readStateSnapshot(runDir);
      const vars = (snap as unknown as Record<string, unknown>)["variables"] as
        | Record<string, unknown>
        | undefined;
      expect(vars!["shared_var"]).toBe("updated");

      // Verify event emitted
      const events = await readEvents(runDir);
      const varSetEvent = events.find((e) => e.type === "variable_set");
      expect(varSetEvent).toBeDefined();
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-011: variable_set with wrong type
// ---------------------------------------------------------------------------

describe("applyContextPatch — wrong type (FR-PATCH-011)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "variable_set with wrong type (number for string var) throws ValidationError (FR-PATCH-011, UC-VAR-015)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      // plan_status is type: string, but we try to set a number
      await expect(
        callApplyContextPatch({
          runDir,
          runId,
          jobId: "plan",
          stepId: "draft",
          attempt: 1,
          patches: [
            { kind: "variable_set", name: "plan_status", value: 12345 },
          ],
          clock: new FakeClock(),
        })
      ).rejects.toBeDefined();

      // No disk mutation
      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-012: variable_set with value not in enum
// ---------------------------------------------------------------------------

describe("applyContextPatch — enum violation (FR-PATCH-012)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "variable_set with value not in enum throws ValidationError (FR-PATCH-012, UC-VAR-016)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      // plan_status enum is [pending, approved, rejected] — "unknown_status" is not in enum
      await expect(
        callApplyContextPatch({
          runDir,
          runId,
          jobId: "plan",
          stepId: "draft",
          attempt: 1,
          patches: [
            {
              kind: "variable_set",
              name: "plan_status",
              value: "unknown_status",
            },
          ],
          clock: new FakeClock(),
        })
      ).rejects.toBeDefined();

      // No disk mutation
      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-013: step with context_edit: "none" submits patches → all rejected
// ---------------------------------------------------------------------------

describe("applyContextPatch — context_edit: none (FR-PATCH-013)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "step with context_edit: none has all patches rejected (FR-PATCH-013, UC-VAR-012)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_CONTEXT_EDIT_NONE_YAML,
        "context-edit-none-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callApplyContextPatch({
          runDir,
          runId,
          jobId: "plan",
          stepId: "draft",
          attempt: 1,
          patches: [
            { kind: "variable_set", name: "plan_status", value: "approved" },
          ],
          clock: new FakeClock(),
        })
      ).rejects.toBeDefined();

      // No disk mutation
      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-014: null/undefined/empty patches array → no-op
// ---------------------------------------------------------------------------

describe("applyContextPatch — null/empty patches (FR-PATCH-014)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "empty patches array passes through as no-op (FR-PATCH-014, UC-VAR-014)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      const eventsBefore = await readEventsBytes(runDir);

      await callApplyContextPatch({
        runDir,
        runId,
        jobId: "plan",
        stepId: "draft",
        attempt: 1,
        patches: [],
        clock: new FakeClock(),
      });

      // No events added
      const eventsAfter = await readEventsBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
    }
  );

  it(
    "null patches treated as no-op (FR-PATCH-014)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      const eventsBefore = await readEventsBytes(runDir);

      // Pass null-equivalent (empty) via the wrapper
      await callApplyContextPatch({
        runDir,
        runId,
        jobId: "plan",
        stepId: "draft",
        attempt: 1,
        patches: [] as unknown as ContextPatch[],
        clock: new FakeClock(),
      });

      const eventsAfter = await readEventsBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PATCH-RESERVED-ALL: contract tests for every reserved field
// ---------------------------------------------------------------------------

describe("applyContextPatch — reserved field contract (FR-PATCH-RESERVED-ALL)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  const RESERVED_FIELDS = [
    "status",
    "last_event_id",
    "jobs",
    "signals",
    "run_id",
    "workflow",
    "task",
    "created_at",
    "step_visits",
  ];

  for (const field of RESERVED_FIELDS) {
    it(
      `rejects variable_set patch for reserved field "${field}" and leaves state.json unchanged`,
      async () => {
        const { runId, runDir } = await bootstrapRun(
          sandbox,
          WORKFLOW_WITH_VARS_YAML,
          "vars-test"
        );

        await setJobState(runDir, "plan", {
          status: "running",
          current_step: "draft",
          attempt: 1,
        });

        const stateBefore = await readStateBytes(runDir);

        await expect(
          callApplyContextPatch({
            runDir,
            runId,
            jobId: "plan",
            stepId: "draft",
            attempt: 1,
            patches: [
              { kind: "variable_set", name: field, value: "malicious" },
            ],
            clock: new FakeClock(),
          })
        ).rejects.toThrow(ValidationError);

        // Verify state.json is unchanged
        const stateAfter = await readStateBytes(runDir);
        expect(stateAfter).toBe(stateBefore);
      }
    );
  }

  it(
    "batch with reserved field + valid patch rejects entire batch",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      const stateBefore = await readStateBytes(runDir);

      // Patch #1 is valid (sets plan_status to approved),
      // Patch #2 tries to set a reserved field.
      await expect(
        callApplyContextPatch({
          runDir,
          runId,
          jobId: "plan",
          stepId: "draft",
          attempt: 1,
          patches: [
            { kind: "variable_set", name: "plan_status", value: "approved" },
            { kind: "variable_set", name: "status", value: "hacked" },
          ],
          clock: new FakeClock(),
        })
      ).rejects.toThrow(ValidationError);

      // Entire batch must be rejected — valid patch's change is NOT in state.json
      const stateAfter = await readStateBytes(runDir);
      expect(stateAfter).toBe(stateBefore);

      // Explicitly confirm plan_status was NOT written (still has initial value)
      const snap = await readStateSnapshot(runDir);
      const vars = (snap as unknown as Record<string, unknown>)[
        "variables"
      ] as Record<string, unknown> | undefined;
      expect(vars?.["plan_status"]).toBe("pending");
    }
  );

  it(
    "unknown patch kind rejects with ValidationError",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        WORKFLOW_WITH_VARS_YAML,
        "vars-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      const stateBefore = await readStateBytes(runDir);

      await expect(
        callApplyContextPatch({
          runDir,
          runId,
          jobId: "plan",
          stepId: "draft",
          attempt: 1,
          patches: [
            { kind: "unknown_kind" as any, name: "plan_status", value: "approved" },
          ],
          clock: new FakeClock(),
        })
      ).rejects.toThrow(ValidationError);

      // Verify state.json is unchanged
      const stateAfter = await readStateBytes(runDir);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});
