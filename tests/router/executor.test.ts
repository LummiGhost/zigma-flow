/**
 * `executeRouterStep` tests for WF-P8-ROUTER (Step 1 — Cases and Tests).
 *
 * These tests exercise the deterministic router-step execution pipeline
 * against real temp directories under `os.tmpdir()`. Unlike the P6 / P7
 * executors there is no external port to inject — the router consumes
 * `step.switch` and `step.cases` from the workflow definition and emits
 * a `router_decided` event plus (for literal actions on a single-step
 * job) the corresponding terminal events.
 *
 * Covers:
 *   - T-ROUTER-1: continue action → step_started → router_decided
 *                 (action:"continue") → step_completed → job_completed;
 *                 job status → "completed".
 *   - T-ROUTER-2: fail action → step_failed; job status → "failed".
 *   - T-ROUTER-3: block action → step_failed; job status → "blocked".
 *   - T-ROUTER-4: retry_job action → router_decided only; job status
 *                 remains "running" (transition deferred to WF-P8-SIGNALS).
 *   - T-ROUTER-5: activate_job action → router_decided only; job status
 *                 remains "running".
 *   - T-ROUTER-6: goto_job action → router_decided only; job status
 *                 remains "running".
 *   - T-ROUTER-7: no matching case + no default → RouterError BEFORE any
 *                 event is appended; state.json unchanged.
 *   - T-ROUTER-7b: missing switch field → RouterError BEFORE any event
 *                 is appended; state.json unchanged.
 *
 * Reference:
 *   - docs/phases/p8-router-and-signals/workflows/wf-p8-router/01-cases-and-tests.md
 *   - docs/prd.md FR-009
 *   - docs/architecture.md §7.1, §7.2, §7.3, §9.4, §12.3, §13 phase 8
 *   - docs/mvp-contracts.md §2.1, §2.4, §7
 *
 * Red-phase note: `src/router/executor.ts` does not exist yet; tests
 * fail at module resolution. `RouterError` does not yet exist in
 * `src/utils/errors.ts`; the `CheckError`-style import fails until
 * WF-P8-ROUTER Step 2 adds the class. WF-P8-ROUTER Step 2 creates the
 * executor and turns the tests green.
 *
 * Interface convention: the router executor has no injectable port —
 * all test variability is driven by workflow YAML fixtures embedded
 * inline. The shared sandbox / `createRun` bootstrap pattern mirrors
 * `tests/check/executor.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock } from "../../src/run/index.js";

// ── Red-phase imports ───────────────────────────────────────────────────────
// `executeRouterStep` and `RouterError` are introduced in WF-P8-ROUTER Step 2.
// These imports are expected to fail until that workflow ships the source.
import { executeRouterStep } from "../../src/router/executor.js";
import { RouterError } from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-10T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  dotZigma: string;
  configPath: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(
  opts: { activeRun?: string | null } = {}
): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-router-exec-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const configPath = join(dotZigma, "config.json");
  const skillLockPath = join(dotZigma, "skill-lock.json");

  await mkdir(runsDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(
      { tool_version: "0.1.0", active_run: opts.activeRun ?? null },
      null,
      2
    ),
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

/**
 * Bootstrap a run for the router-step tests. Writes the workflow YAML,
 * calls `createRun`, and returns the resolved `runId` + run directory
 * path. Mirrors the WF-P7-CHECK test bootstrap.
 */
async function bootstrapRouterRun(
  sandbox: Sandbox,
  yamlBody: string
): Promise<{ runId: string; runDir: string; workflowPath: string }> {
  const workflowPath = join(sandbox.projectRoot, "code-change.yml");
  await writeFile(workflowPath, yamlBody, "utf-8");

  const { runId } = await createRun({
    workflowPath,
    task: "exercise router step",
    runsDir: sandbox.runsDir,
    skillLockPath: sandbox.skillLockPath,
    clock: new FakeClock(),
  });
  const runDir = join(sandbox.runsDir, runId);
  return { runId, runDir, workflowPath };
}

/**
 * Read events.jsonl as an array of parsed event objects. Drops blank
 * lines.
 */
async function readEvents(runDir: string): Promise<
  Array<{
    id: string;
    type: string;
    payload: Record<string, unknown>;
  }>
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

/**
 * Read state.json as a typed snapshot. Required fields only.
 */
async function readStateSnapshot(runDir: string): Promise<{
  last_event_id: string;
  jobs: Record<string, { status: string }>;
}> {
  const text = await readFile(join(runDir, "state.json"), "utf-8");
  return JSON.parse(text) as {
    last_event_id: string;
    jobs: Record<string, { status: string }>;
  };
}

/**
 * Build the canonical opts object for `executeRouterStep`. No `runner`
 * field — see Architecture Decision §8.1 in the cases-and-tests
 * document.
 */
function makeExecutorOpts(args: {
  runDir: string;
  zigmaflowDir: string;
  runId: string;
  jobId: string;
  clock?: Clock;
}): {
  runDir: string;
  zigmaflowDir: string;
  runId: string;
  jobId: string;
  clock: Clock;
} {
  const clock: Clock = args.clock ?? new FakeClock();
  return {
    runDir: args.runDir,
    zigmaflowDir: args.zigmaflowDir,
    runId: args.runId,
    jobId: args.jobId,
    clock,
  };
}

// ---------------------------------------------------------------------------
// Workflow YAML fixtures — one per test ID, varying only switch + cases
// ---------------------------------------------------------------------------

/** Continue action — switch "approved" matches { approved: continue }. */
const ROUTER_WORKFLOW_CONTINUE_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  review:
    steps:
      - id: route-decision
        type: router
        switch: approved
        cases:
          approved: continue
`;

/** Fail action — switch "rejected" matches { rejected: fail }. */
const ROUTER_WORKFLOW_FAIL_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  review:
    steps:
      - id: route-decision
        type: router
        switch: rejected
        cases:
          rejected: fail
`;

/** Block action — switch "blocked_path" matches { blocked_path: block }. */
const ROUTER_WORKFLOW_BLOCK_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  review:
    steps:
      - id: route-decision
        type: router
        switch: blocked_path
        cases:
          blocked_path: block
`;

/** retry_job object form — switch "rejected" → { retry_job: implement }. */
const ROUTER_WORKFLOW_RETRY_JOB_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 3
    steps:
      - id: build
        type: script
        run: "echo build"
  review:
    needs:
      - implement
    steps:
      - id: route-decision
        type: router
        switch: rejected
        cases:
          rejected:
            retry_job: implement
`;

/** activate_job object form. */
const ROUTER_WORKFLOW_ACTIVATE_JOB_YAML = `\
name: code-change
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
      - id: route-decision
        type: router
        switch: needs_architecture_design
        cases:
          needs_architecture_design:
            activate_job: architecture-design
`;

/** goto_job object form. */
const ROUTER_WORKFLOW_GOTO_JOB_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  review:
    steps:
      - id: route-decision
        type: router
        switch: stop
        cases:
          stop:
            goto_job: cleanup
  cleanup:
    needs:
      - review
    steps:
      - id: cleanup-step
        type: script
        run: "echo cleanup"
`;

/**
 * No matching case + no default — switch "unmatched" misses cases
 * { foo: continue }. T-ROUTER-7.
 */
const ROUTER_WORKFLOW_NO_MATCH_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  review:
    steps:
      - id: route-decision
        type: router
        switch: unmatched
        cases:
          foo: continue
`;

/**
 * Missing switch field entirely — only `type: router` and `cases`.
 * T-ROUTER-7b.
 */
const ROUTER_WORKFLOW_MISSING_SWITCH_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  review:
    steps:
      - id: route-decision
        type: router
        cases:
          approved: continue
`;

// ---------------------------------------------------------------------------
// T-ROUTER-1: continue action — happy path
// ---------------------------------------------------------------------------

describe("executeRouterStep — continue action (T-ROUTER-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits step_started → router_decided(action:\"continue\") → step_completed → job_completed and transitions job to completed (T-ROUTER-1, UC-ROUTER-1)",
    async () => {
      const { runId, runDir } = await bootstrapRouterRun(
        sandbox,
        ROUTER_WORKFLOW_CONTINUE_YAML
      );
      const opts = makeExecutorOpts({
        runDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        runId,
        jobId: "review",
      });

      await executeRouterStep(opts);

      const events = await readEvents(runDir);
      const state = await readStateSnapshot(runDir);

      // (a) events.jsonl contains step_started, router_decided,
      //     step_completed, job_completed in order
      const types = events.map((e) => e.type);
      const stepStartedIdx = types.indexOf("step_started");
      const routerDecidedIdx = types.indexOf("router_decided");
      const stepCompletedIdx = types.indexOf("step_completed");
      const jobCompletedIdx = types.indexOf("job_completed");

      expect(stepStartedIdx).toBeGreaterThanOrEqual(0);
      expect(routerDecidedIdx).toBeGreaterThan(stepStartedIdx);
      expect(stepCompletedIdx).toBeGreaterThan(routerDecidedIdx);
      expect(jobCompletedIdx).toBeGreaterThan(stepCompletedIdx);

      // (b) router_decided.payload.action === "continue"
      const routerDecidedEvent = events[routerDecidedIdx]!;
      expect(routerDecidedEvent.payload["action"]).toBe("continue");

      // (c) router_decided.payload.target is absent
      expect(routerDecidedEvent.payload).not.toHaveProperty("target");

      // (d) state.jobs.review.status === "completed"
      expect(state.jobs["review"]?.status).toBe("completed");

      // (e) state.last_event_id === tail event id of events.jsonl
      const tailEvent = events[events.length - 1]!;
      expect(state.last_event_id).toBe(tailEvent.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ROUTER-2: fail action — step_failed + status failed
// ---------------------------------------------------------------------------

describe("executeRouterStep — fail action (T-ROUTER-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "appends step_failed and transitions job to failed; router_decided payload carries action \"fail\" (T-ROUTER-2, UC-ROUTER-2)",
    async () => {
      const { runId, runDir } = await bootstrapRouterRun(
        sandbox,
        ROUTER_WORKFLOW_FAIL_YAML
      );
      const opts = makeExecutorOpts({
        runDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        runId,
        jobId: "review",
      });

      await executeRouterStep(opts);

      const events = await readEvents(runDir);
      const state = await readStateSnapshot(runDir);
      const types = events.map((e) => e.type);

      // (a) events contain step_started, router_decided(action:"fail"), step_failed
      expect(types).toContain("step_started");
      expect(types).toContain("router_decided");
      expect(types).toContain("step_failed");

      // no step_completed / job_completed
      expect(types).not.toContain("step_completed");
      expect(types).not.toContain("job_completed");

      // router_decided.payload.action === "fail"
      const routerDecidedEvent = events.find((e) => e.type === "router_decided")!;
      expect(routerDecidedEvent.payload["action"]).toBe("fail");

      // (b) step_failed.payload.reason contains "router decided: fail"
      const stepFailedEvent = events.find((e) => e.type === "step_failed")!;
      expect(String(stepFailedEvent.payload["reason"])).toContain("router decided: fail");

      // (c) state.jobs.review.status === "failed"
      expect(state.jobs["review"]?.status).toBe("failed");

      // state.last_event_id matches tail
      const tailEvent = events[events.length - 1]!;
      expect(state.last_event_id).toBe(tailEvent.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ROUTER-3: block action — step_failed + status blocked
// ---------------------------------------------------------------------------

describe("executeRouterStep — block action (T-ROUTER-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "appends step_failed and transitions job to blocked; router_decided payload carries action \"block\" (T-ROUTER-3, UC-ROUTER-3)",
    async () => {
      const { runId, runDir } = await bootstrapRouterRun(
        sandbox,
        ROUTER_WORKFLOW_BLOCK_YAML
      );
      const opts = makeExecutorOpts({
        runDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        runId,
        jobId: "review",
      });

      await executeRouterStep(opts);

      const events = await readEvents(runDir);
      const state = await readStateSnapshot(runDir);
      const types = events.map((e) => e.type);

      // (a) events contain step_started, router_decided(action:"block"), step_failed
      expect(types).toContain("step_started");
      expect(types).toContain("router_decided");
      expect(types).toContain("step_failed");

      // no step_completed / job_completed
      expect(types).not.toContain("step_completed");
      expect(types).not.toContain("job_completed");

      // router_decided.payload.action === "block"
      const routerDecidedEvent = events.find((e) => e.type === "router_decided")!;
      expect(routerDecidedEvent.payload["action"]).toBe("block");

      // (b) step_failed.payload.reason contains "router decided: block"
      const stepFailedEvent = events.find((e) => e.type === "step_failed")!;
      expect(String(stepFailedEvent.payload["reason"])).toContain("router decided: block");

      // (c) state.jobs.review.status === "blocked"
      expect(state.jobs["review"]?.status).toBe("blocked");

      // state.last_event_id matches tail
      const tailEvent = events[events.length - 1]!;
      expect(state.last_event_id).toBe(tailEvent.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ROUTER-4: retry_job — router delegates to applyRoutingAction (WF-P8-SIGNALS)
// ---------------------------------------------------------------------------

describe("executeRouterStep — retry_job action (T-ROUTER-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits step_started → router_decided(action:\"retry_job\") → signal_received → job_retrying; implement transitions to ready with attempt=2 (T-ROUTER-4, UC-ROUTER-4)",
    async () => {
      const { runId, runDir } = await bootstrapRouterRun(
        sandbox,
        ROUTER_WORKFLOW_RETRY_JOB_YAML
      );
      const opts = makeExecutorOpts({
        runDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        runId,
        jobId: "review",
      });

      await executeRouterStep(opts);

      const events = await readEvents(runDir);
      const state = await readStateSnapshot(runDir);
      const types = events.map((e) => e.type);

      // (a) events contain step_started, router_decided, signal_received, job_retrying
      expect(types).toContain("step_started");
      expect(types).toContain("router_decided");
      expect(types).toContain("signal_received");
      expect(types).toContain("job_retrying");

      // (b) router_decided.payload.action === "retry_job"
      const routerDecidedEvent = events.find((e) => e.type === "router_decided")!;
      expect(routerDecidedEvent.payload["action"]).toBe("retry_job");
      expect(routerDecidedEvent.payload["target"]).toBe("implement");

      // (c) ordering: step_started < router_decided < signal_received < job_retrying
      const stepStartedIdx = types.indexOf("step_started");
      const routerDecidedIdx = types.indexOf("router_decided");
      const signalIdx = types.indexOf("signal_received");
      const retryIdx = types.indexOf("job_retrying");
      expect(routerDecidedIdx).toBeGreaterThan(stepStartedIdx);
      expect(signalIdx).toBeGreaterThan(routerDecidedIdx);
      expect(retryIdx).toBeGreaterThan(signalIdx);

      // (d) implement transitions to ready with attempt=2
      expect(state.jobs["implement"]?.status).toBe("ready");
      expect((state.jobs["implement"] as Record<string, unknown>)["attempt"]).toBe(2);

      // (e) state.last_event_id === tail event id
      const tailEvent = events[events.length - 1]!;
      expect(state.last_event_id).toBe(tailEvent.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ROUTER-5: activate_job — router delegates to applyRoutingAction (WF-P8-SIGNALS)
// ---------------------------------------------------------------------------

describe("executeRouterStep — activate_job action (T-ROUTER-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits step_started → router_decided(action:\"activate_job\") → signal_received → job_activated; architecture-design transitions to ready (T-ROUTER-5, UC-ROUTER-5)",
    async () => {
      const { runId, runDir } = await bootstrapRouterRun(
        sandbox,
        ROUTER_WORKFLOW_ACTIVATE_JOB_YAML
      );
      const opts = makeExecutorOpts({
        runDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        runId,
        jobId: "review",
      });

      await executeRouterStep(opts);

      const events = await readEvents(runDir);
      const state = await readStateSnapshot(runDir);
      const types = events.map((e) => e.type);

      // events contain step_started, router_decided, signal_received, job_activated
      expect(types).toContain("step_started");
      expect(types).toContain("router_decided");
      expect(types).toContain("signal_received");
      expect(types).toContain("job_activated");

      // router_decided.payload
      const routerDecidedEvent = events.find((e) => e.type === "router_decided")!;
      expect(routerDecidedEvent.payload["action"]).toBe("activate_job");
      expect(routerDecidedEvent.payload["target"]).toBe("architecture-design");

      // ordering: router_decided < signal_received < job_activated
      const routerDecidedIdx = types.indexOf("router_decided");
      const signalIdx = types.indexOf("signal_received");
      const activatedIdx = types.indexOf("job_activated");
      expect(signalIdx).toBeGreaterThan(routerDecidedIdx);
      expect(activatedIdx).toBeGreaterThan(signalIdx);

      // architecture-design transitions from inactive to ready
      expect(state.jobs["architecture-design"]?.status).toBe("ready");

      // state.last_event_id === tail event id
      const tailEvent = events[events.length - 1]!;
      expect(state.last_event_id).toBe(tailEvent.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ROUTER-6: goto_job — router delegates to applyRoutingAction (WF-P8-SIGNALS)
// ---------------------------------------------------------------------------

describe("executeRouterStep — goto_job action (T-ROUTER-6)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits step_started → router_decided(action:\"goto_job\") → signal_received → job_skipped; review completes; cleanup transitions to ready (T-ROUTER-6, UC-ROUTER-6)",
    async () => {
      const { runId, runDir } = await bootstrapRouterRun(
        sandbox,
        ROUTER_WORKFLOW_GOTO_JOB_YAML
      );
      const opts = makeExecutorOpts({
        runDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        runId,
        jobId: "review",
      });

      await executeRouterStep(opts);

      const events = await readEvents(runDir);
      const state = await readStateSnapshot(runDir);
      const types = events.map((e) => e.type);

      // events contain step_started, router_decided, signal_received, job_skipped
      expect(types).toContain("step_started");
      expect(types).toContain("router_decided");
      expect(types).toContain("signal_received");
      expect(types).toContain("job_skipped");

      // router_decided.payload
      const routerDecidedEvent = events.find((e) => e.type === "router_decided")!;
      expect(routerDecidedEvent.payload["action"]).toBe("goto_job");
      expect(routerDecidedEvent.payload["target"]).toBe("cleanup");

      // ordering: router_decided < signal_received < job_skipped
      const routerDecidedIdx = types.indexOf("router_decided");
      const signalIdx = types.indexOf("signal_received");
      const skippedIdx = types.indexOf("job_skipped");
      expect(signalIdx).toBeGreaterThan(routerDecidedIdx);
      expect(skippedIdx).toBeGreaterThan(signalIdx);

      // review completes; cleanup transitions to ready
      expect(state.jobs["review"]?.status).toBe("completed");
      expect(state.jobs["cleanup"]?.status).toBe("ready");

      // state.last_event_id === tail event id
      const tailEvent = events[events.length - 1]!;
      expect(state.last_event_id).toBe(tailEvent.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ROUTER-7: no matching case + no default → RouterError pre-event
// ---------------------------------------------------------------------------

describe("executeRouterStep — no matching case (T-ROUTER-7)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws RouterError BEFORE any events are appended when switch does not match any case and no default is defined (T-ROUTER-7, UC-ROUTER-7)",
    async () => {
      const { runId, runDir } = await bootstrapRouterRun(
        sandbox,
        ROUTER_WORKFLOW_NO_MATCH_YAML
      );
      const opts = makeExecutorOpts({
        runDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        runId,
        jobId: "review",
      });

      // Snapshot events + state BEFORE calling the executor
      const eventsBefore = await readEvents(runDir);
      const stateBefore = await readStateSnapshot(runDir);

      // (a) + (b) throws RouterError
      await expect(executeRouterStep(opts)).rejects.toThrow(RouterError);

      // Verify the thrown error shape
      let caughtError: unknown;
      try {
        await executeRouterStep(opts);
      } catch (e) {
        caughtError = e;
      }
      expect(caughtError).toBeInstanceOf(RouterError);
      // (c) error.kind === "RouterError"; error.exitCode === 1
      expect((caughtError as RouterError).kind).toBe("RouterError");
      expect((caughtError as RouterError).exitCode).toBe(23);

      // (d) events.jsonl size unchanged (still only the bootstrap events)
      const eventsAfter = await readEvents(runDir);
      expect(eventsAfter.length).toBe(eventsBefore.length);

      // (e) state.json contents unchanged
      const stateAfter = await readStateSnapshot(runDir);
      expect(JSON.stringify(stateAfter)).toBe(JSON.stringify(stateBefore));
    }
  );
});

// ---------------------------------------------------------------------------
// T-ROUTER-7b: missing switch field → RouterError pre-event
// ---------------------------------------------------------------------------

describe("executeRouterStep — missing switch field (T-ROUTER-7b)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws RouterError BEFORE any events are appended when the router step lacks the switch field (T-ROUTER-7b, UC-ROUTER-8)",
    async () => {
      const { runId, runDir } = await bootstrapRouterRun(
        sandbox,
        ROUTER_WORKFLOW_MISSING_SWITCH_YAML
      );
      const opts = makeExecutorOpts({
        runDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        runId,
        jobId: "review",
      });

      // Snapshot events + state BEFORE calling the executor
      const eventsBefore = await readEvents(runDir);
      const stateBefore = await readStateSnapshot(runDir);

      // throws RouterError
      await expect(executeRouterStep(opts)).rejects.toThrow(RouterError);

      let caughtError: unknown;
      try {
        await executeRouterStep(opts);
      } catch (e) {
        caughtError = e;
      }
      expect(caughtError).toBeInstanceOf(RouterError);
      expect((caughtError as RouterError).kind).toBe("RouterError");
      expect((caughtError as RouterError).exitCode).toBe(23);

      // events.jsonl size unchanged
      const eventsAfter = await readEvents(runDir);
      expect(eventsAfter.length).toBe(eventsBefore.length);

      // state.json contents unchanged
      const stateAfter = await readStateSnapshot(runDir);
      expect(JSON.stringify(stateAfter)).toBe(JSON.stringify(stateBefore));
    }
  );
});
