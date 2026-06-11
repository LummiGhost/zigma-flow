/**
 * Retry data-flow tests for WF-P9-RETRY (Step 1 — Cases and Tests).
 *
 * These tests exercise the three pieces of P8 technical debt now being
 * cleared in P9:
 *
 *   - TD-P8-007: `applyRoutingAction` MUST read
 *                `workflow.jobs[targetJobId].retry.on_exceeded.status`
 *                instead of hard-coding `"blocked"` when retry attempts
 *                exhaust.
 *   - TD-P8-008: `RouterAction.retry_job` MUST accept an optional
 *                `retry_with: Record<string, string>` payload and the
 *                Engine MUST persist it as `state.jobs[<target>].retry_inputs`.
 *   - TD-P8-006: `applyRoutingAction` MUST be idempotent for `activate_job`
 *                when the target job has already been activated.
 *
 * It also adds expression-resolver coverage for `${{ retry.inputs.<key> }}`
 * (new in P9 — required so the next attempt's prompt can read the
 * previous review feedback).
 *
 * Reference:
 *   - docs/phases/p9-agent-report-retry/workflows/wf-p9-retry/01-cases-and-tests.md
 *   - docs/phases/p9-agent-report-retry/02-development-plan.md §3 WF-P9-RETRY
 *   - docs/mvp-contracts.md §2.3 (state.jobs.<id> retry_reason + retry_inputs)
 *   - docs/architecture.md §7.3
 *
 * Red-phase note: Step 1 commits these tests. Every test below should
 * fail for a structural reason (missing field write, hard-coded status,
 * unknown expression token) — NOT for an import or syntax error.
 *
 * Test design notes:
 *   - Tests use real temporary directories under `os.tmpdir()` and
 *     observe real filesystem writes, mirroring the pattern used in
 *     tests/engine/signals.test.ts.
 *   - The `ExpressionContext` type currently has no `retry` field. We
 *     cast through `unknown` so the test file compiles in red phase;
 *     Step 2 (green) widens the type and the cast becomes a no-op.
 *   - Some tests (e.g. T-RETRY-6) may pass already against the P8
 *     implementation. They are kept as guard tests so future regressions
 *     to `activate_job` idempotency are caught.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import { applyRoutingAction } from "../../src/engine/routing.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import { loadWorkflow } from "../../src/workflow/index.js";
import {
  resolveExpression,
  type ExpressionContext,
} from "../../src/expression/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-11T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Workflow used by T-RETRY-1, T-RETRY-8 — `implement` retryable up to 5
 * attempts. Plenty of headroom to exercise multi-retry behavior without
 * tripping the max_attempts guard.
 */
const RETRY_HEADROOM_YAML = `\
name: retry-headroom
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 5
    steps:
      - id: code
        type: script
        run: "echo implement"
`;

/**
 * Workflow used by T-RETRY-2 — on_exceeded.status: "failed".
 * max_attempts: 2; we'll preset attempt=2 so the next retry exhausts.
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
 * Workflow used by T-RETRY-3 — no on_exceeded; backward-compat default
 * is `blocked`. max_attempts: 1; attempt=1 → next exhausts.
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

/**
 * Workflow used by T-RETRY-6 — optional `architecture-design` job.
 * `review` is the source.
 */
const OPTIONAL_YAML = `\
name: retry-optional
version: "0.1.0"
jobs:
  architecture-design:
    activation: optional
    steps:
      - id: design
        type: script
        run: "echo design"
  review:
    steps:
      - id: route
        type: script
        run: "echo route"
`;

/**
 * Workflow used by T-RETRY-7 — exercises the workflow schema directly.
 * `review.route` is a router-shaped script step with `cases.rejected`
 * declaring `retry_with`. We invoke `loadWorkflow` and assert that the
 * `retry_with` subfield survives schema validation.
 */
const RETRY_WITH_SCHEMA_YAML = `\
name: retry-with-schema
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 3
    steps:
      - id: code
        type: script
        run: "echo implement"
  review:
    needs:
      - implement
    steps:
      - id: route
        type: router
        switch: "rejected"
        cases:
          rejected:
            retry_job: implement
            retry_with:
              review_comments: "\${{ inputs.comments }}"
`;

interface Sandbox {
  projectRoot: string;
  dotZigma: string;
  configPath: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-retry-${randomUUID()}`);
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

  return { projectRoot, dotZigma, configPath, runsDir, skillLockPath };
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

async function readEvents(runDir: string): Promise<
  Array<{ id: string; type: string; payload: Record<string, unknown> }>
> {
  const text = await readFile(join(runDir, "events.jsonl"), "utf-8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map(
      (l) =>
        JSON.parse(l) as {
          id: string;
          type: string;
          payload: Record<string, unknown>;
        }
    );
}

async function readStateSnapshot(runDir: string): Promise<RunState> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) {
    throw new Error(`state.json missing at ${runDir}`);
  }
  return snap;
}

/**
 * Mutate `state.jobs[jobId]` via the State Store. Mirrors the helper
 * used in signals.test.ts. Patch fields not listed below are not touched.
 */
interface JobStatePatch {
  status?: JobState["status"];
  attempt?: number;
  current_step?: string | "__clear__";
  retry_inputs?: Record<string, string>;
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

  const merged = { ...existing } as JobState & {
    retry_inputs?: Record<string, string>;
  };
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.attempt !== undefined) merged.attempt = patch.attempt;
  if (patch.current_step === "__clear__") {
    delete merged.current_step;
  } else if (typeof patch.current_step === "string") {
    merged.current_step = patch.current_step;
  }
  if (patch.retry_inputs !== undefined) {
    merged.retry_inputs = patch.retry_inputs;
  }

  snap.jobs[jobId] = merged;
  await store.writeSnapshot(runDir, snap);
}

/**
 * Reads `state.jobs[jobId].retry_inputs` via a defensive cast.
 * Returns `undefined` if the field is not present. P8 `JobState` does
 * not yet declare `retry_inputs`; this helper avoids requiring a type
 * extension solely for the test file.
 */
function readRetryInputs(
  state: RunState,
  jobId: string
): Record<string, string> | undefined {
  const js = state.jobs[jobId] as
    | (JobState & { retry_inputs?: Record<string, string> })
    | undefined;
  return js?.retry_inputs;
}

// ---------------------------------------------------------------------------
// T-RETRY-1: retry_with payload is persisted into state.jobs.<id>.retry_inputs
// ---------------------------------------------------------------------------

describe("applyRoutingAction — retry_with writes retry_inputs (T-RETRY-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "persists action.retry_with verbatim into state.jobs[target].retry_inputs (T-RETRY-1, UC-RETRY-1, FP-RETRY-INPUTS-1, FP-RETRY-INPUTS-2)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETRY_HEADROOM_YAML,
        "retry-headroom"
      );

      await setJobState(runDir, "implement", {
        status: "running",
        current_step: "code",
        attempt: 1,
      });

      // The retry_with field is new in P9; cast through unknown so the
      // test file compiles before src/workflow/index.ts widens RouterAction.
      const action = {
        retry_job: "implement",
        retry_with: { review_comments: "too few tests" },
      } as unknown as Parameters<typeof applyRoutingAction>[0]["action"];

      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: "implement",
        sourceStepId: "code",
        attempt: 1,
        action,
        reason: "review rejected: too few tests",
        clock: new FakeClock(),
      });

      const snap = await readStateSnapshot(runDir);
      const inputs = readRetryInputs(snap, "implement");
      expect(inputs).toEqual({ review_comments: "too few tests" });

      const implement = snap.jobs["implement"]!;
      expect(implement.status).toBe("ready");
      expect(implement.attempt).toBe(2);

      const events = await readEvents(runDir);
      expect(snap.last_event_id).toBe(events[events.length - 1]!.id);
      expect(events.filter((e) => e.type === "job_retrying")).toHaveLength(1);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRY-2: on_exceeded.status = "failed" routes to failed (not blocked)
// ---------------------------------------------------------------------------

describe("applyRoutingAction — on_exceeded.status: failed (T-RETRY-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "sets target job status to failed (not blocked) when retry exhausts and workflow declares on_exceeded.status: failed (T-RETRY-2, UC-RETRY-2, FP-ON-EXCEEDED-1)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        ON_EXCEEDED_FAILED_YAML,
        "retry-on-exceeded-failed"
      );

      // attempt is at max (2); next attempt would be 3 > max_attempts.
      await setJobState(runDir, "implement", {
        status: "running",
        current_step: "code",
        attempt: 2,
      });

      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: "implement",
        sourceStepId: "code",
        attempt: 2,
        action: { retry_job: "implement" },
        reason: "exhausted",
        clock: new FakeClock(),
      });

      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["implement"]!.status).toBe("failed");
      expect(snap.jobs["implement"]!.attempt).toBe(2);

      const events = await readEvents(runDir);
      expect(events.filter((e) => e.type === "job_retrying")).toHaveLength(0);
      expect(events.filter((e) => e.type === "signal_received").length).toBeGreaterThanOrEqual(1);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRY-3: on_exceeded omitted → default blocked (back-compat guard)
// ---------------------------------------------------------------------------

describe("applyRoutingAction — on_exceeded default to blocked (T-RETRY-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "sets target job status to blocked when retry exhausts and workflow declares no on_exceeded (T-RETRY-3, UC-RETRY-3, FP-ON-EXCEEDED-2)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        ON_EXCEEDED_DEFAULT_YAML,
        "retry-on-exceeded-default"
      );

      await setJobState(runDir, "implement", {
        status: "running",
        current_step: "code",
        attempt: 1,
      });

      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: "implement",
        sourceStepId: "code",
        attempt: 1,
        action: { retry_job: "implement" },
        reason: "exhausted (no on_exceeded)",
        clock: new FakeClock(),
      });

      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["implement"]!.status).toBe("blocked");
      expect(snap.jobs["implement"]!.attempt).toBe(1);

      const events = await readEvents(runDir);
      expect(events.filter((e) => e.type === "job_retrying")).toHaveLength(0);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRY-4: ${{ retry.inputs.<key> }} resolves from ExpressionContext.retry
// ---------------------------------------------------------------------------

describe("resolveExpression — retry.inputs.<key> (T-RETRY-4)", () => {
  it(
    "substitutes ${{ retry.inputs.review_comments }} with ctx.retry.inputs.review_comments (T-RETRY-4, UC-RETRY-4, FP-EXPR-RETRY-1, FP-EXPR-RETRY-2)",
    () => {
      // ExpressionContext does not yet declare `retry` (P9 adds it).
      // Cast through unknown so the file compiles in red phase; once
      // Step 2 widens the type, the cast becomes a structural no-op.
      const ctx = {
        inputs: {},
        run: { id: "r1", workflow: "w" },
        retry: { inputs: { review_comments: "fix edge cases" } },
      } as unknown as ExpressionContext;

      const out = resolveExpression(
        "${{ retry.inputs.review_comments }}",
        ctx
      );
      expect(out).toBe("fix edge cases");
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRY-5: ${{ retry.inputs.<missing> }} passthrough (no throw)
// ---------------------------------------------------------------------------

describe("resolveExpression — retry.inputs.<missing> passthrough (T-RETRY-5)", () => {
  it(
    "leaves the token unchanged when retry context or key is missing (T-RETRY-5, UC-RETRY-5, FP-EXPR-RETRY-3)",
    () => {
      // ctx provides no retry field at all
      const ctxNoRetry: ExpressionContext = {
        inputs: {},
        run: { id: "r1", workflow: "w" },
      };
      expect(
        resolveExpression("${{ retry.inputs.review_comments }}", ctxNoRetry)
      ).toBe("${{ retry.inputs.review_comments }}");

      // ctx provides retry.inputs but no `review_comments` key
      const ctxNoKey = {
        inputs: {},
        run: { id: "r1", workflow: "w" },
        retry: { inputs: { other: "x" } },
      } as unknown as ExpressionContext;
      expect(
        resolveExpression("${{ retry.inputs.review_comments }}", ctxNoKey)
      ).toBe("${{ retry.inputs.review_comments }}");
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRY-6: activate_job idempotency on already-activated target
// ---------------------------------------------------------------------------

describe("applyRoutingAction — activate_job idempotency (T-RETRY-6, TD-P8-006)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "does not throw and does not emit job_activated when target is already past inactive (T-RETRY-6, UC-RETRY-6, FP-ACTIVATE-IDEM-1)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        OPTIONAL_YAML,
        "retry-optional"
      );

      // Simulate "previously activated": flip the target out of inactive
      // (the path the idempotency guard checks for).
      await setJobState(runDir, "architecture-design", { status: "waiting" });

      // Source: review is running; its router step decides to (re)activate.
      await setJobState(runDir, "review", {
        status: "running",
        current_step: "route",
      });

      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: "review",
        sourceStepId: "route",
        attempt: 1,
        action: { activate_job: "architecture-design" },
        reason: "router decided: activate_job (idempotent retry)",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      // No new job_activated event — guard short-circuits to idempotent path.
      expect(events.filter((e) => e.type === "job_activated")).toHaveLength(0);
      // signal_received MUST still be appended so the audit trail records
      // the inbound signal even when it's a no-op.
      expect(events.filter((e) => e.type === "signal_received").length).toBeGreaterThanOrEqual(1);

      const snap = await readStateSnapshot(runDir);
      // Target stays at waiting (the pre-existing post-activation state).
      expect(snap.jobs["architecture-design"]!.status).toBe("waiting");
      // last_event_id must point at the tail (the signal_received we just appended).
      expect(snap.last_event_id).toBe(events[events.length - 1]!.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRY-7: workflow schema accepts retry_with subfield
// ---------------------------------------------------------------------------

describe("loadWorkflow — retry_with schema (T-RETRY-7)", () => {
  it(
    "preserves the retry_with subfield on a router case (T-RETRY-7, UC-RETRY-7, FP-RETRY-WITH-1, FP-RETRY-WITH-2)",
    () => {
      const wf = loadWorkflow(RETRY_WITH_SCHEMA_YAML);

      const reviewJob = wf.jobs["review"];
      expect(reviewJob).toBeDefined();
      const routeStep = reviewJob!.steps[0]!;
      expect(routeStep.cases).toBeDefined();

      const rejected = routeStep.cases!["rejected"];
      expect(rejected).toBeDefined();

      // The action is an object form: { retry_job, retry_with }.
      // We dig in via `unknown` to avoid coupling the test to the P8
      // RouterAction union (which does not yet declare retry_with).
      const asRecord = rejected as unknown as Record<string, unknown>;
      expect(asRecord["retry_job"]).toBe("implement");
      expect(asRecord["retry_with"]).toEqual({
        review_comments: "${{ inputs.comments }}",
      });
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRY-8: retry_inputs is replaced (not merged) across successive retries
// ---------------------------------------------------------------------------

describe("applyRoutingAction — retry_inputs replaced on re-retry (T-RETRY-8)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "second retry replaces retry_inputs wholesale (no merge with previous payload) (T-RETRY-8, UC-RETRY-8, FP-RETRY-INPUTS-3)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETRY_HEADROOM_YAML,
        "retry-headroom"
      );

      // First retry: write { a: "1" }
      await setJobState(runDir, "implement", {
        status: "running",
        current_step: "code",
        attempt: 1,
      });
      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: "implement",
        sourceStepId: "code",
        attempt: 1,
        action: {
          retry_job: "implement",
          retry_with: { a: "1" },
        } as unknown as Parameters<typeof applyRoutingAction>[0]["action"],
        reason: "first retry",
        clock: new FakeClock(),
      });
      const snap1 = await readStateSnapshot(runDir);
      expect(readRetryInputs(snap1, "implement")).toEqual({ a: "1" });
      expect(snap1.jobs["implement"]!.attempt).toBe(2);

      // Simulate the next attempt running, then second retry with new payload.
      await setJobState(runDir, "implement", {
        status: "running",
        current_step: "code",
        attempt: 2,
      });
      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: "implement",
        sourceStepId: "code",
        attempt: 2,
        action: {
          retry_job: "implement",
          retry_with: { a: "2", b: "3" },
        } as unknown as Parameters<typeof applyRoutingAction>[0]["action"],
        reason: "second retry",
        clock: new FakeClock(),
      });

      const snap2 = await readStateSnapshot(runDir);
      // Wholesale replacement: no stray keys carried over, new keys all present.
      expect(readRetryInputs(snap2, "implement")).toEqual({ a: "2", b: "3" });
      expect(snap2.jobs["implement"]!.attempt).toBe(3);
    }
  );
});
