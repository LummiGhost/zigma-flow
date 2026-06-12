/**
 * `show` CLI command tests for WF-CLI-COMMANDS
 * (Step 1 — Cases and Tests).
 *
 * Exercises the new CLI handler that powers `zigma-flow show [<run-id>]`.
 * It resolves the run id (positional arg or active_run), reads
 * `run.yml`, `state.json`, and the last 5 events from `events.jsonl`,
 * then renders the result.
 *
 * Covers:
 *   - T-SHOW-1: show <run-id> prints run info + each job + last 5 events.
 *   - T-SHOW-2: omitting <run-id> falls back to active_run.
 *   - T-SHOW-3: nonexistent run id → ConfigError.
 *
 * Reference:
 *   - docs/phases/p9p10-cli-admin-commands/workflows/wf-cli-commands/01-cases-and-tests.md
 *   - docs/prd.md §17
 *
 * Red-phase note: `src/commands/show.ts` does not yet exist; tests
 * will fail to compile until WF-CLI-COMMANDS Step 2 ships the module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { showAction } from "../../src/commands/show.js";
import { ConfigError } from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  dotZigma: string;
  configPath: string;
  runsDir: string;
}

async function makeSandbox(activeRun: string | null = null): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-show-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const configPath = join(dotZigma, "config.json");

  await mkdir(runsDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ tool_version: "0.1.0", active_run: activeRun }, null, 2),
    "utf-8"
  );

  return { projectRoot, zigmaflowDir: projectRoot, dotZigma, configPath, runsDir };
}

interface JobSeed {
  status: string;
  attempt?: number;
}

interface SeedRunInputs {
  runsDir: string;
  runId: string;
  workflowName: string;
  task: string;
  createdAt: string;
  status?: string;
  jobs: Record<string, JobSeed>;
  events: Array<{
    id: string;
    type: string;
    job?: string | null;
    payload?: Record<string, unknown>;
  }>;
}

async function seedRun(inputs: SeedRunInputs): Promise<string> {
  const runDir = join(inputs.runsDir, inputs.runId);
  await mkdir(runDir, { recursive: true });

  const runYml = [
    `task: ${JSON.stringify(inputs.task)}`,
    `workflow:`,
    `  name: ${inputs.workflowName}`,
    `  path: ./${inputs.workflowName}.yml`,
    `created_at: ${inputs.createdAt}`,
    `skill_lock_snapshot: skill-lock.snapshot.json`,
  ].join("\n");
  await writeFile(join(runDir, "run.yml"), runYml, "utf-8");

  const jobsObj: Record<string, Record<string, unknown>> = {};
  for (const [jobId, seed] of Object.entries(inputs.jobs)) {
    const js: Record<string, unknown> = { status: seed.status };
    if (seed.attempt !== undefined) js["attempt"] = seed.attempt;
    jobsObj[jobId] = js;
  }

  const lastEventId =
    inputs.events.length > 0 ? inputs.events[inputs.events.length - 1]!.id : "evt-001";

  const state: Record<string, unknown> = {
    run_id: inputs.runId,
    workflow: inputs.workflowName,
    task: inputs.task,
    created_at: inputs.createdAt,
    last_event_id: lastEventId,
    jobs: jobsObj,
  };
  if (inputs.status !== undefined) state["status"] = inputs.status;
  await writeFile(join(runDir, "state.json"), JSON.stringify(state), "utf-8");

  // events.jsonl
  for (const e of inputs.events) {
    const envelope = {
      id: e.id,
      run_id: inputs.runId,
      type: e.type,
      timestamp: inputs.createdAt,
      producer: "engine",
      job: e.job ?? null,
      step: null,
      attempt: null,
      payload: e.payload ?? {},
    };
    await appendFile(join(runDir, "events.jsonl"), JSON.stringify(envelope) + "\n", "utf-8");
  }

  return runDir;
}

// ---------------------------------------------------------------------------
// T-SHOW-1: show <run-id> prints run info + jobs + last 5 events
// ---------------------------------------------------------------------------

describe("showAction — show by explicit run-id (T-SHOW-1)", () => {
  let sandbox: Sandbox;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "renders run header, each job row, and the last 5 events (T-SHOW-1, UC-SHOW-1, FP-SHOW-1/3)",
    async () => {
      const runId = "20260612-0001";
      await seedRun({
        runsDir: sandbox.runsDir,
        runId,
        workflowName: "code-change",
        task: "fix the encoding bug",
        createdAt: "2026-06-12T08:00:00.000Z",
        status: "running",
        jobs: {
          intake: { status: "completed", attempt: 1 },
          implement: { status: "running", attempt: 2 },
          review: { status: "waiting" },
        },
        events: [
          { id: "evt-001", type: "run_created" },
          { id: "evt-002", type: "job_ready", job: "intake" },
          { id: "evt-003", type: "step_started", job: "intake" },
          { id: "evt-004", type: "step_completed", job: "intake" },
          { id: "evt-005", type: "job_completed", job: "intake" },
          { id: "evt-006", type: "job_ready", job: "implement" },
        ],
      });

      await showAction({ zigmaflowDir: sandbox.zigmaflowDir, runId });

      const printed = logSpy.mock.calls
        .map((c: unknown[]) => String(c[0] ?? ""))
        .join("\n");

      // Run header.
      expect(printed).toContain(runId);
      expect(printed).toContain("code-change");
      expect(printed).toContain("fix the encoding bug");
      expect(printed).toContain("2026-06-12T08:00:00.000Z");
      expect(printed).toContain("running");

      // Each job appears with status.
      expect(printed).toContain("intake");
      expect(printed).toContain("implement");
      expect(printed).toContain("review");
      expect(printed).toContain("completed");
      expect(printed).toContain("waiting");
      // Attempts on the running job.
      expect(printed).toContain("2");

      // Last 5 events present; the 6 events seeded means evt-001 must be
      // dropped from the tail-5 window, but evt-002..006 must appear.
      expect(printed).toContain("evt-002");
      expect(printed).toContain("evt-003");
      expect(printed).toContain("evt-004");
      expect(printed).toContain("evt-005");
      expect(printed).toContain("evt-006");
      expect(printed).not.toContain("evt-001");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SHOW-2: omitting <run-id> falls back to active_run
// ---------------------------------------------------------------------------

describe("showAction — falls back to active_run when run-id omitted (T-SHOW-2)", () => {
  let sandbox: Sandbox;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const runId = "20260612-0002";
    sandbox = await makeSandbox(runId);
    await seedRun({
      runsDir: sandbox.runsDir,
      runId,
      workflowName: "code-change",
      task: "active task",
      createdAt: "2026-06-12T09:00:00.000Z",
      status: "running",
      jobs: { plan: { status: "running" } },
      events: [{ id: "evt-001", type: "run_created" }],
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "when no runId passed, reads active_run from config.json and renders that run (T-SHOW-2, UC-SHOW-2, FP-SHOW-1)",
    async () => {
      await showAction({ zigmaflowDir: sandbox.zigmaflowDir });

      const printed = logSpy.mock.calls
        .map((c: unknown[]) => String(c[0] ?? ""))
        .join("\n");
      expect(printed).toContain("20260612-0002");
      expect(printed).toContain("active task");
      expect(printed).toContain("plan");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SHOW-3: nonexistent run id → ConfigError
// ---------------------------------------------------------------------------

describe("showAction — unknown run id throws ConfigError (T-SHOW-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws ConfigError when the requested run id does not exist (T-SHOW-3, UC-SHOW-3, FP-SHOW-2)",
    async () => {
      await expect(
        showAction({ zigmaflowDir: sandbox.zigmaflowDir, runId: "does-not-exist" })
      ).rejects.toBeInstanceOf(ConfigError);
    }
  );

  it(
    "throws ConfigError when active_run is null and no run id supplied (T-SHOW-3b, UC-SHOW-3, FP-SHOW-2)",
    async () => {
      await expect(
        showAction({ zigmaflowDir: sandbox.zigmaflowDir })
      ).rejects.toBeInstanceOf(ConfigError);
    }
  );
});
