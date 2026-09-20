/**
 * Model-routing AAC engine integration tests (Issue #286 Phase 4).
 *
 * Exercises the runAll engine path end-to-end with seeded metrics history
 * under `routing_policy.objective: accepted_artifact_cost`:
 *
 *   - AAC ordering overrides the Phase 3 acceptance-first preference
 *   - routing_reason carries the `aac-ranked ...` basis
 *   - the full scoring breakdown is preserved in run.log.jsonl via
 *     writeSystemDetached (`aac-ranked model candidates ...`)
 *   - no declared policy → byte-identical Phase 3 behavior
 *   - hard constraints filter before scoring
 *   - same-run retry refresh: attempt 2 re-scans and re-scores with
 *     attempt 1's metrics record
 *
 * Fixture pattern mirrors tests/engine/model-routing-history.test.ts;
 * history seeding mirrors tests/commands/list-runs.test.ts seedRun.
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
 * succeeds. Reports a fixed durationMs so the engine-written metrics
 * record contributes deterministic proxy cost units (low × duration).
 */
class AacBackend implements AgentBackend {
  readonly name = "fake-aac";
  readonly supportsOutputSchema = true;
  readonly model: string | undefined;
  private calls = 0;

  constructor(
    config: AgentBackendConfig,
    private readonly failFirst = false,
    private readonly durationMs = 1000,
  ) {
    this.model = config.model;
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    this.calls += 1;
    if (this.failFirst && this.calls === 1) {
      return {
        success: false,
        exitCode: 1,
        error: "forced failure",
        durationMs: this.durationMs,
      };
    }
    await mkdir(dirname(opts.reportPath), { recursive: true });
    await writeFile(
      opts.reportPath,
      JSON.stringify({ outputs: {}, artifacts: [], signals: [], summary: "ok" }, null, 2),
      "utf-8",
    );
    return {
      success: true,
      exitCode: 0,
      reportPath: opts.reportPath,
      durationMs: this.durationMs,
    };
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
  const projectRoot = join(tmpdir(), `zigma-routing-aac-${randomUUID()}`);
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

interface SeedEntry {
  model: string;
  attempt?: number;
  report_accepted?: boolean;
  status?: "completed" | "failed" | "timed_out" | "cancelled";
  skill?: string;
  cost_class?: "low" | "medium" | "high";
  duration_ms?: number;
}

/**
 * Seed one run directory with a metrics.jsonl file whose records all share
 * the fixture's task class: job "main", skill "zigma/analyze-skill".
 */
async function seedHistoryRun(
  runsDir: string,
  runId: string,
  entries: ReadonlyArray<SeedEntry>,
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
    cost_class: e.cost_class ?? "low",
    duration_ms: e.duration_ms ?? 1000,
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
function acceptedRecords(
  model: string,
  n: number,
  durationMs = 1000,
): SeedEntry[] {
  return Array.from({ length: n }, () => ({ model, report_accepted: true, duration_ms: durationMs }));
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

/** System log lines (stream: "system") from run.log.jsonl. */
async function readSystemLogTexts(runDir: string): Promise<string[]> {
  try {
    const text = await readFile(join(runDir, "run.log.jsonl"), "utf-8");
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { stream?: string; text?: string })
      .filter((r) => r.stream === "system")
      .map((r) => r.text ?? "");
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Workflow fixtures
// ---------------------------------------------------------------------------

// AAC policy declared; both profiles satisfy max_cost_class: low.
const AAC_POLICY_YAML = `\
name: routing-aac
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
          routing_policy:
            objective: accepted_artifact_cost
`;

// Same registry without any routing_policy — the Phase 3 control fixture.
const NO_POLICY_YAML = `\
name: routing-aac-no-policy
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

// Only alpha satisfies max_cost_class: low → single match under AAC policy.
const SINGLE_MATCH_YAML = `\
name: routing-aac-single
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
          routing_policy:
            objective: accepted_artifact_cost
`;

const RETRY_YAML = `\
name: routing-aac-retry
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
          routing_policy:
            objective: accepted_artifact_cost
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAll — Accepted Artifact Cost model routing (Issue #286 Phase 4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  function makeResolver(
    resolvedModels: string[],
    failModels: ReadonlySet<string> = new Set(),
  ) {
    return (stepBackend?: string | StepBackendOverride) => {
      const model =
        typeof stepBackend === "object" && stepBackend.model !== undefined
          ? stepBackend.model
          : undefined;
      if (model !== undefined) resolvedModels.push(model);
      return new AacBackend(
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
      task: "exercise aac routing",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: makeResolver(resolvedModels, failModels),
      clock: new FakeClock(),
    });
  }

  it("orders by AAC over the Phase 3 acceptance preference and carries the basis in routing_reason", async () => {
    // alpha: 10/10 accepted, 1000 units each → AAC 1000.
    // beta: 5/10 accepted, 100 units each + rework on the 5 rejects →
    // delivered 10×100 + 5×100 = 1500 → AAC 300. Phase 3 would pick alpha.
    await seedHistoryRun(sandbox.runsDir, "seed-a", [
      ...acceptedRecords("claude-haiku-4-5", 10, 1000),
      ...acceptedRecords("claude-sonnet-4-6", 5, 100),
      ...Array.from({ length: 5 }, () => ({
        model: "claude-sonnet-4-6",
        report_accepted: false,
        duration_ms: 100,
      })),
    ]);
    const workflowPath = await writeWorkflow(sandbox, "aac", AAC_POLICY_YAML);
    const resolvedModels: string[] = [];

    const summary = await runWith(workflowPath, resolvedModels);

    expect(summary.status).toBe("completed");
    expect(resolvedModels).toEqual(["claude-sonnet-4-6"]);

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const invoked = events.find((e) => e.type === "agent_invoked");
    expect(invoked).toBeDefined();
    expect(invoked!.payload.model).toBe("claude-sonnet-4-6");
    expect(invoked!.payload.routing_reason).toBe(
      'matched profile "beta" (aac-ranked 1 of 2 candidate(s) satisfying constraints; aac 300.00 cost-units per accepted artifact, accepted 5/10)',
    );
  });

  it("preserves the full scoring breakdown in the run log via writeSystemDetached", async () => {
    await seedHistoryRun(sandbox.runsDir, "seed-a", [
      ...acceptedRecords("claude-haiku-4-5", 10, 1000),
      ...acceptedRecords("claude-sonnet-4-6", 5, 100),
      ...Array.from({ length: 5 }, () => ({
        model: "claude-sonnet-4-6",
        report_accepted: false,
        duration_ms: 100,
      })),
    ]);
    const workflowPath = await writeWorkflow(sandbox, "aac-log", AAC_POLICY_YAML);
    const resolvedModels: string[] = [];

    const summary = await runWith(workflowPath, resolvedModels);

    const systemLines = await readSystemLogTexts(join(sandbox.runsDir, summary.runId));
    const aacLine = systemLines.find((l) => l.startsWith("aac-ranked model candidates"));
    expect(aacLine).toBeDefined();
    const json = JSON.parse(aacLine!.slice(aacLine!.indexOf(":") + 1)) as Array<Record<string, unknown>>;
    expect(json).toHaveLength(2);
    expect(json[0]).toMatchObject({
      name: "beta",
      model: "claude-sonnet-4-6",
      samples: 10,
      accepted: 5,
      aac: 300,
      delivered_cost: 1500,
      execution_cost: 1000,
      retry_overhead: 0,
      rework_overhead: 500,
    });
    expect(json[1]).toMatchObject({
      name: "alpha",
      model: "claude-haiku-4-5",
      aac: 1000,
      delivered_cost: 10000,
    });
  });

  it("keeps the exact Phase 3 behavior when no policy is declared", async () => {
    // The same history that flips under the AAC policy: alpha 10/10 at
    // 1000 units, beta 5/10 at 100 units. Without a policy, acceptance
    // first → alpha wins with the exact Phase 3 reason.
    await seedHistoryRun(sandbox.runsDir, "seed-a", [
      ...acceptedRecords("claude-haiku-4-5", 10, 1000),
      ...acceptedRecords("claude-sonnet-4-6", 5, 100),
      ...Array.from({ length: 5 }, () => ({
        model: "claude-sonnet-4-6",
        report_accepted: false,
        duration_ms: 100,
      })),
    ]);
    const workflowPath = await writeWorkflow(sandbox, "no-policy", NO_POLICY_YAML);
    const resolvedModels: string[] = [];

    const summary = await runWith(workflowPath, resolvedModels);

    expect(summary.status).toBe("completed");
    expect(resolvedModels).toEqual(["claude-haiku-4-5"]);

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const invoked = events.find((e) => e.type === "agent_invoked");
    expect(invoked!.payload.routing_reason).toBe(
      'matched profile "alpha" (history-ranked 1 of 2 candidate(s) satisfying constraints; acceptance 10/10, retry 0/10)',
    );

    const systemLines = await readSystemLogTexts(join(sandbox.runsDir, summary.runId));
    expect(systemLines.some((l) => l.startsWith("history-ranked model candidates"))).toBe(true);
    expect(systemLines.some((l) => l.startsWith("aac-ranked model candidates"))).toBe(false);
  });

  it("filters by constraints first — a cheap-but-violating profile never wins under the AAC policy", async () => {
    // beta has a stellar AAC but violates max_cost_class: low (cost_class
    // high) → the single-match Phase 1 path applies.
    await seedHistoryRun(sandbox.runsDir, "seed-a", [
      ...acceptedRecords("claude-sonnet-4-6", 10, 10),
      { model: "claude-haiku-4-5", report_accepted: false },
    ]);
    const workflowPath = await writeWorkflow(sandbox, "single", SINGLE_MATCH_YAML);
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

  it("falls back to the Phase 3 zero-sample reason under the AAC policy", async () => {
    await seedHistoryRun(sandbox.runsDir, "seed-a", [
      { model: "claude-other-model", report_accepted: true },
    ]);
    const workflowPath = await writeWorkflow(sandbox, "zero-sample", AAC_POLICY_YAML);
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

  it("re-scores on retry — attempt 2 sees attempt 1's failed record and routes to the other model", async () => {
    // Seeded: alpha AAC 1000 (10×1000/10), beta AAC 1100 (10×1100/10) →
    // alpha on attempt 1. Alpha fails (engine record: low × 1000 ms exec +
    // rework 1000, accepted stays 10) → alpha AAC (11000+1000)/10 = 1200.
    // Attempt 2 forced re-scan: beta (1100) < alpha (1200) → beta.
    await seedHistoryRun(sandbox.runsDir, "seed-a", [
      ...acceptedRecords("claude-haiku-4-5", 10, 1000),
      ...acceptedRecords("claude-sonnet-4-6", 10, 1100),
    ]);
    const workflowPath = await writeWorkflow(sandbox, "retry", RETRY_YAML);
    const resolvedModels: string[] = [];

    const summary = await runWith(
      workflowPath,
      resolvedModels,
      new Set(["claude-haiku-4-5"]),
    );

    expect(summary.status).toBe("completed");
    expect(resolvedModels).toEqual(["claude-haiku-4-5", "claude-sonnet-4-6"]);

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const invoked = events.filter((e) => e.type === "agent_invoked");
    expect(invoked).toHaveLength(2);
    expect(invoked[1]!.payload.model).toBe("claude-sonnet-4-6");
    expect(invoked[1]!.payload.routing_reason).toContain("aac-ranked 1 of 2");
    expect(invoked[1]!.payload.routing_reason).toContain("accepted 10/10");
  });
});
