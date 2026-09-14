/**
 * Model-routing history engine integration tests (Issue #286 Phase 3).
 *
 * Exercises the runAll engine path end-to-end with seeded metrics history:
 *
 *   - cold start → Phase 1 declaration-order behavior preserved exactly
 *   - acceptance-first / retry-rate / sample-count ordering across runs
 *   - zero-sample placement (sampled first; all-zero-sample → declaration)
 *   - task-class gate (no skill → no history; constraint filtering first)
 *   - same-run retry refresh: attempt 2 re-scans and sees attempt 1's record
 *   - traceability: routing_reason carries the history basis
 *
 * Fixture pattern mirrors tests/engine/model-routing.test.ts; history
 * seeding mirrors tests/commands/list-runs.test.ts seedRun.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { Clock } from "../../src/run/index.js";
import type {
  AgentBackend,
  AgentBackendConfig,
  AgentExecuteOptions,
  AgentExecuteResult,
} from "../../src/agent/index.js";
import type { StepBackendOverride } from "../../src/agent/config.js";
import type { ZigmaFlowEvent } from "../../src/events/index.js";

const FIXED_ISO = "2026-09-14T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Backend that fails its first execution when `failFirst` is set, then
 * succeeds. The engine's backendCache re-resolves per effective backend,
 * so a retry that routes to a different model gets a fresh instance.
 */
class HistoryBackend implements AgentBackend {
  readonly name = "fake-history";
  readonly supportsOutputSchema = true;
  readonly model: string | undefined;
  private calls = 0;

  constructor(config: AgentBackendConfig, private readonly failFirst = false) {
    this.model = config.model;
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    this.calls += 1;
    if (this.failFirst && this.calls === 1) {
      return { success: false, exitCode: 1, error: "forced failure" };
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
  const projectRoot = join(tmpdir(), `zigma-routing-history-${randomUUID()}`);
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

async function writeWorkflow(sandbox: Sandbox, name: string, yamlBody: string): Promise<string> {
  const workflowPath = join(sandbox.projectRoot, `${name}.yml`);
  await writeFile(workflowPath, yamlBody, "utf-8");
  return workflowPath;
}

// ---------------------------------------------------------------------------
// History seeding
// ---------------------------------------------------------------------------

/**
 * Seed one run directory with a metrics.jsonl file whose records all share
 * the fixture's task class: job "main", skill "zigma/analyze-skill".
 */
async function seedHistoryRun(
  runsDir: string,
  runId: string,
  entries: ReadonlyArray<{
    model: string;
    attempt?: number;
    report_accepted?: boolean;
    status?: "completed" | "failed" | "timed_out" | "cancelled";
    skill?: string;
  }>,
): Promise<void> {
  const runDir = join(runsDir, runId);
  await mkdir(runDir, { recursive: true });
  const lines = entries.map((e, i) => ({
    timestamp: "2026-09-13T00:00:00.000Z",
    run_id: runId,
    workflow: "seeded",
    job: "main",
    step: "analyze",
    attempt: e.attempt ?? 1,
    ...(e.skill !== undefined ? { skill: e.skill } : { skill: "zigma/analyze-skill" }),
    backend: "fake",
    model: e.model,
    cost_class: "low",
    duration_ms: 1000,
    status: e.status ?? "completed",
    report_accepted: e.report_accepted ?? true,
    invocation_id: `${runId}-evt-${i}`,
  }));
  await writeFile(
    join(runDir, "metrics.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

/** N identical accepted records for one model. */
function acceptedRecords(model: string, n: number) {
  return Array.from({ length: n }, () => ({ model, report_accepted: true }));
}

async function readMetrics(runDir: string): Promise<Array<Record<string, unknown>>> {
  let text: string;
  try {
    text = await readFile(join(runDir, "metrics.jsonl"), "utf-8");
  } catch {
    return [];
  }
  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

interface EventRecord {
  type: string;
  payload: Record<string, unknown>;
}

async function readEvents(runDir: string): Promise<EventRecord[]> {
  try {
    const text = await readFile(join(runDir, "events.jsonl"), "utf-8");
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as EventRecord);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Workflow fixtures
// ---------------------------------------------------------------------------

// Both profiles satisfy max_cost_class: low → the matched set has 2 entries.
const TWO_MATCH_YAML = `\
name: routing-history
version: "1.0"
models:
  alpha:
    model: claude-haiku-4-5
    cost_class: low
  beta:
    model: claude-sonnet-4-6
    cost_class: low
jobs:
  main:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
        constraints:
          max_cost_class: low
`;

// Only alpha satisfies max_cost_class: low → single match.
const SINGLE_MATCH_YAML = `\
name: routing-history-single
version: "1.0"
models:
  alpha:
    model: claude-haiku-4-5
    cost_class: low
  beta:
    model: claude-sonnet-4-6
    cost_class: high
jobs:
  main:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
        constraints:
          max_cost_class: low
`;

const RETRY_YAML = `\
name: routing-history-retry
version: "1.0"
models:
  alpha:
    model: claude-haiku-4-5
    cost_class: low
  beta:
    model: claude-sonnet-4-6
    cost_class: low
jobs:
  main:
    retry:
      max_attempts: 2
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
        constraints:
          max_cost_class: low
`;

const PHASE_1_REASON =
  'matched profile "alpha" (first of 2 candidate(s) satisfying constraints)';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAll — historical model routing (Issue #286 Phase 3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  function makeResolver(resolvedModels: string[], failModels: ReadonlySet<string> = new Set()) {
    return (stepBackend?: string | StepBackendOverride) => {
      const model =
        typeof stepBackend === "object" && stepBackend.model !== undefined
          ? stepBackend.model
          : undefined;
      if (model !== undefined) resolvedModels.push(model);
      return new HistoryBackend(
        {
          command: "fake",
          ...(model !== undefined ? { model } : {}),
        },
        model !== undefined && failModels.has(model),
      );
    };
  }

  async function runWith(
    workflowPath: string,
    resolvedModels: string[],
    failModels?: ReadonlySet<string>,
  ): Promise<RunAllSummary> {
    return callRunAll({
      task: "exercise history routing",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: makeResolver(resolvedModels, failModels),
      clock: new FakeClock(),
    });
  }

  it("cold start (no history) keeps the Phase 1 declaration-order behavior exactly", async () => {
    const workflowPath = await writeWorkflow(sandbox, "cold", TWO_MATCH_YAML);
    const resolvedModels: string[] = [];

    const summary = await runWith(workflowPath, resolvedModels);

    expect(summary.status).toBe("completed");
    expect(resolvedModels).toEqual(["claude-haiku-4-5"]);

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const invoked = events.find((e) => e.type === "agent_invoked");
    expect(invoked).toBeDefined();
    expect(invoked!.payload.model).toBe("claude-haiku-4-5");
    expect(invoked!.payload.routing_reason).toBe(PHASE_1_REASON);
  });

  it("reorders to the better-acceptance profile and carries the history basis in routing_reason", async () => {
    await seedHistoryRun(sandbox.runsDir, "seed-a", [
      ...acceptedRecords("claude-haiku-4-5", 1),
      { model: "claude-haiku-4-5", report_accepted: false },
      { model: "claude-haiku-4-5", report_accepted: false },
      ...acceptedRecords("claude-sonnet-4-6", 10),
    ]);
    const workflowPath = await writeWorkflow(sandbox, "reorder", TWO_MATCH_YAML);
    const resolvedModels: string[] = [];

    const summary = await runWith(workflowPath, resolvedModels);

    expect(summary.status).toBe("completed");
    expect(resolvedModels).toEqual(["claude-sonnet-4-6"]);

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const invoked = events.find((e) => e.type === "agent_invoked");
    expect(invoked).toBeDefined();
    expect(invoked!.payload.model).toBe("claude-sonnet-4-6");
    expect(invoked!.payload.routing_reason).toBe(
      'matched profile "beta" (history-ranked 1 of 2 candidate(s) satisfying constraints; acceptance 10/10, retry 0/10)',
    );
  });

  it("ranks a sampled profile before a zero-sample profile", async () => {
    await seedHistoryRun(sandbox.runsDir, "seed-a", [
      // alpha sampled but weak (1/10); beta has no samples at all.
      ...acceptedRecords("claude-haiku-4-5", 1),
      ...Array.from({ length: 9 }, () => ({
        model: "claude-haiku-4-5",
        report_accepted: false,
      })),
    ]);
    const workflowPath = await writeWorkflow(sandbox, "zero-sample", TWO_MATCH_YAML);
    const resolvedModels: string[] = [];

    const summary = await runWith(workflowPath, resolvedModels);

    expect(summary.status).toBe("completed");
    expect(resolvedModels).toEqual(["claude-haiku-4-5"]);
  });

  it("falls back to declaration order when every matched candidate is zero-sample", async () => {
    // The class exists in history, but only for a model NOT among the
    // candidates — every matched profile is zero-sample.
    await seedHistoryRun(sandbox.runsDir, "seed-a", [
      { model: "claude-other-model", report_accepted: true },
    ]);
    const workflowPath = await writeWorkflow(sandbox, "all-zero", TWO_MATCH_YAML);
    const resolvedModels: string[] = [];

    const summary = await runWith(workflowPath, resolvedModels);

    expect(summary.status).toBe("completed");
    expect(resolvedModels).toEqual(["claude-haiku-4-5"]);

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const invoked = events.find((e) => e.type === "agent_invoked");
    expect(invoked!.payload.routing_reason).toContain(
      "no historical samples for any candidate",
    );
  });

  it("breaks equal acceptance by lower retry rate", async () => {
    await seedHistoryRun(sandbox.runsDir, "seed-a", [
      // alpha: 10 samples, 8 accepted, 5 retried (attempt > 1 records).
      ...acceptedRecords("claude-haiku-4-5", 3),
      ...Array.from({ length: 2 }, () => ({
        model: "claude-haiku-4-5",
        report_accepted: false,
      })),
      ...Array.from({ length: 5 }, () => ({
        model: "claude-haiku-4-5",
        report_accepted: true,
        attempt: 2,
      })),
      // beta: 10 samples, 8 accepted, 2 retried.
      ...acceptedRecords("claude-sonnet-4-6", 6),
      ...Array.from({ length: 2 }, () => ({
        model: "claude-sonnet-4-6",
        report_accepted: false,
      })),
      ...Array.from({ length: 2 }, () => ({
        model: "claude-sonnet-4-6",
        report_accepted: true,
        attempt: 2,
      })),
    ]);
    const workflowPath = await writeWorkflow(sandbox, "retry-order", TWO_MATCH_YAML);
    const resolvedModels: string[] = [];

    const summary = await runWith(workflowPath, resolvedModels);

    expect(summary.status).toBe("completed");
    expect(resolvedModels).toEqual(["claude-sonnet-4-6"]);
  });

  it("breaks equal acceptance and retry by higher sample count", async () => {
    await seedHistoryRun(sandbox.runsDir, "seed-a", [
      ...acceptedRecords("claude-haiku-4-5", 4),
      { model: "claude-haiku-4-5", report_accepted: false },
      ...acceptedRecords("claude-sonnet-4-6", 16),
      ...Array.from({ length: 4 }, () => ({
        model: "claude-sonnet-4-6",
        report_accepted: false,
      })),
    ]);
    const workflowPath = await writeWorkflow(sandbox, "sample-order", TWO_MATCH_YAML);
    const resolvedModels: string[] = [];

    const summary = await runWith(workflowPath, resolvedModels);

    expect(summary.status).toBe("completed");
    expect(resolvedModels).toEqual(["claude-sonnet-4-6"]);
  });

  it("ignores seeded records without a skill (no task class)", async () => {
    // Records without a `skill` key are excluded from aggregation, so the
    // class (main, zigma/analyze-skill) has no history at all.
    const runDir = join(sandbox.runsDir, "seed-a");
    await mkdir(runDir, { recursive: true });
    const rec = {
      timestamp: "2026-09-13T00:00:00.000Z",
      run_id: "seed-a",
      workflow: "seeded",
      job: "main",
      step: "analyze",
      attempt: 1,
      backend: "fake",
      model: "claude-sonnet-4-6",
      cost_class: "low",
      duration_ms: 1000,
      status: "completed",
      report_accepted: true,
      invocation_id: "seed-a-evt-0",
    };
    await writeFile(
      join(runDir, "metrics.jsonl"),
      JSON.stringify(rec) + "\n",
      "utf-8",
    );

    const workflowPath = await writeWorkflow(sandbox, "no-skill", TWO_MATCH_YAML);
    const resolvedModels: string[] = [];

    const summary = await runWith(workflowPath, resolvedModels);

    expect(summary.status).toBe("completed");
    expect(resolvedModels).toEqual(["claude-haiku-4-5"]);

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const invoked = events.find((e) => e.type === "agent_invoked");
    expect(invoked!.payload.routing_reason).toBe(PHASE_1_REASON);
  });

  it("filters by constraints first — a history-perfect profile that violates constraints never wins", async () => {
    await seedHistoryRun(sandbox.runsDir, "seed-a", [
      ...acceptedRecords("claude-sonnet-4-6", 10),
      { model: "claude-haiku-4-5", report_accepted: false },
    ]);
    const workflowPath = await writeWorkflow(sandbox, "single-match", SINGLE_MATCH_YAML);
    const resolvedModels: string[] = [];

    const summary = await runWith(workflowPath, resolvedModels);

    expect(summary.status).toBe("completed");
    expect(resolvedModels).toEqual(["claude-haiku-4-5"]);

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const invoked = events.find((e) => e.type === "agent_invoked");
    expect(invoked!.payload.routing_reason).toBe(
      'matched profile "alpha" (first of 1 candidate(s) satisfying constraints)',
    );
  });

  it("re-scans history on retry — attempt 2 sees attempt 1's failure and routes to the other model", async () => {
    // Equal stats (10/10 each) → declaration order → alpha on attempt 1.
    await seedHistoryRun(sandbox.runsDir, "seed-a", [
      ...acceptedRecords("claude-haiku-4-5", 10),
      ...acceptedRecords("claude-sonnet-4-6", 10),
    ]);
    const workflowPath = await writeWorkflow(sandbox, "retry-refresh", RETRY_YAML);
    const resolvedModels: string[] = [];

    const summary = await runWith(
      workflowPath,
      resolvedModels,
      new Set(["claude-haiku-4-5"]),
    );

    expect(summary.status).toBe("completed");
    // Attempt 1: alpha. Attempt 2 (forced re-scan): alpha is now 10/11
    // accepted → beta (10/10) wins.
    expect(resolvedModels).toEqual(["claude-haiku-4-5", "claude-sonnet-4-6"]);

    const runDir = join(sandbox.runsDir, summary.runId);
    const metrics = await readMetrics(runDir);
    expect(metrics).toHaveLength(2);
    expect(metrics[0]!["model"]).toBe("claude-haiku-4-5");
    expect(metrics[0]!["report_accepted"]).toBe(false);
    expect(metrics[0]!["attempt"]).toBe(1);
    expect(metrics[1]!["model"]).toBe("claude-sonnet-4-6");
    expect(metrics[1]!["report_accepted"]).toBe(true);
    expect(metrics[1]!["attempt"]).toBe(2);

    const events = await readEvents(runDir);
    const invoked = events.filter((e) => e.type === "agent_invoked");
    expect(invoked).toHaveLength(2);
    expect(invoked[0]!.payload.model).toBe("claude-haiku-4-5");
    expect(invoked[1]!.payload.model).toBe("claude-sonnet-4-6");
    expect(invoked[1]!.payload.routing_reason).toContain("history-ranked 1 of 2");
    expect(invoked[1]!.payload.routing_reason).toContain("acceptance 10/10");
  });
});
