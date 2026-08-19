/**
 * Cross-attempt output-schema determinism tests (Issue #295 W1, Step 1 — Cases and Tests).
 *
 * Verifies the warn-only schema-hash drift check at the checkpoint between
 * compileAgentOutputSchema success and backend.execute:
 *   - A prior attempt's agent.invocation.json carrying `output_schema_sha256`
 *     that differs from the newly compiled hash emits `schema_drift_detected`
 *     (event + system log + console.warn) and execution continues (warn-only,
 *     strategy D1 = A).
 *   - Identical hashes emit no signal.
 *   - No invocation file / no hash field → no evidence → check skipped.
 *   - Resume/reset same-attempt overwrite → the current attempt directory is
 *     read BEFORE backend.execute so the evidence survives the overwrite.
 *   - Multiple prior attempts → backtrack N→1 to the most recent hash-bearing
 *     invocation (a hash-less decoy does not shadow older evidence).
 *
 * Red-phase note (wf-295 Step 1): the drift check does not exist yet — no
 * `schema_drift_detected` event is emitted under the current implementation,
 * so the drift tests (T-295-W1-1/-2/-5/-6) fail until Step 2 ships the
 * checkpoint. The consistent-hash and no-evidence tests (T-295-W1-3/-4) are
 * negative guards that pass in both phases.
 *
 * Reference:
 *   - docs/phases/issue-295-output-schema-determinism/workflows/wf-295/01-cases-and-tests.md
 *   - docs/phases/issue-295-output-schema-determinism/research/schema-drift-policy.md
 *   - docs/agent-output-schema.md ("The schema is written to ... and its
 *     SHA-256 hash is recorded in agent.invocation.json")
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import { runAll } from "../../src/engine/runAll.js";
import type { RunAllSummary } from "../../src/engine/runAll.js";
import type { Clock, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import { loadWorkflowFile } from "../../src/workflow/index.js";
import { compileAgentOutputSchema, outputSchemaHash } from "../../src/agent/index.js";
import type {
  AgentBackend,
  AgentExecuteOptions,
  AgentExecuteResult,
} from "../../src/agent/index.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-27T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/** Always succeeds and writes a minimal valid report envelope. */
class SucceedBackend implements AgentBackend {
  readonly name = "succeed-fake";
  readonly supportsOutputSchema = true;

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    await mkdir(dirname(opts.reportPath), { recursive: true });
    await writeFile(
      opts.reportPath,
      JSON.stringify(
        { outputs: {}, artifacts: [], signals: [], summary: "ok" },
        null,
        2
      ),
      "utf-8"
    );
    return { success: true, reportPath: opts.reportPath };
  }
}

const SIMPLE_AGENT_YAML = `\
name: drift-test
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
`;

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-schema-drift-${randomUUID()}`);
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

  return { projectRoot, zigmaflowDir: projectRoot, runsDir, skillLockPath };
}

/**
 * Create a run (state + run_created/job_ready events) and keep it — the tests
 * then resume it via `runAll({ runId })` after seeding prior-attempt evidence.
 */
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

/** Set the job to "running" at the given step/attempt (simulates a prior execution segment). */
async function setJobRunning(
  runDir: string,
  jobId: string,
  stepId: string,
  attempt: number
): Promise<void> {
  const store = new LocalStateStore();
  await store.updateState(runDir, (cur) => ({
    ...cur,
    jobs: {
      ...cur.jobs,
      [jobId]: {
        ...cur.jobs[jobId]!,
        status: "running",
        current_step: stepId,
        attempt,
      },
    },
  }));
}

/**
 * Write a prior-attempt invocation file. When `hash` is omitted the file is
 * written WITHOUT `output_schema_sha256` (the claude-code catch-path shape —
 * see research E2), acting as a hash-less decoy for the backtrack rule.
 */
async function writePriorInvocation(
  runDir: string,
  jobId: string,
  attempt: number,
  stepId: string,
  hash?: string
): Promise<void> {
  const invocationPath = join(
    runDir,
    "jobs",
    jobId,
    "attempts",
    String(attempt),
    "steps",
    stepId,
    "agent.invocation.json"
  );
  await mkdir(dirname(invocationPath), { recursive: true });
  const meta: Record<string, unknown> = {
    command: "fake",
    args: ["<prompt>"],
    ...(hash === undefined ? {} : { output_schema_sha256: hash }),
  };
  await writeFile(invocationPath, JSON.stringify(meta, null, 2), "utf-8");
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

/** Hash the workflow's compiled schema exactly as the engine will. */
async function expectedSchemaHash(workflowPath: string): Promise<string> {
  const wf = await loadWorkflowFile(workflowPath);
  const step = wf.jobs["intake"]!.steps[0]!;
  return outputSchemaHash(compileAgentOutputSchema(step));
}

async function resumeRun(
  sandbox: Sandbox,
  runId: string,
  workflowPath: string
): Promise<RunAllSummary> {
  return runAll({
    runId,
    workflowPath,
    runsDir: sandbox.runsDir,
    zigmaflowDir: sandbox.zigmaflowDir,
    skillLockPath: sandbox.skillLockPath,
    backendResolver: () => new SucceedBackend(),
    clock: new FakeClock(),
  });
}

// ---------------------------------------------------------------------------
// T-295-W1 — cross-attempt schema-hash drift signal (warn-only)
// ---------------------------------------------------------------------------

describe("runAll — cross-attempt schema-hash drift signal (Issue #295 W1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it(
    "emits schema_drift_detected and continues when the current-attempt directory carries a stale hash (same-attempt overwrite evidence) (T-295-W1-1, UC-295-001)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SIMPLE_AGENT_YAML,
        "drift-same-attempt"
      );
      await setJobRunning(runDir, "intake", "analyze", 1);

      // Prior execution segment (resume/reset reuses attempt 1) left an
      // invocation with an old hash. The check must read this directory
      // BEFORE backend.execute overwrites it.
      const priorHash = "a".repeat(64);
      await writePriorInvocation(runDir, "intake", 1, "analyze", priorHash);

      const expectedHash = await expectedSchemaHash(workflowPath);
      expect(expectedHash).not.toBe(priorHash);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const summary = await resumeRun(sandbox, runId, workflowPath);

      // warn-only: the run still completes under the current contract.
      expect(summary.status).toBe("completed");

      const events = await readEvents(runDir);
      const driftEvents = events.filter((e) => e.type === "schema_drift_detected");
      expect(driftEvents.length).toBe(1);
      expect(driftEvents[0]!.payload).toMatchObject({
        job_id: "intake",
        step_id: "analyze",
        attempt: 1,
        prior_hash: priorHash,
        new_hash: expectedHash,
      });

      // The signal precedes agent_invoked (checkpoint is pre-execution).
      const driftIdx = events.findIndex((e) => e.type === "schema_drift_detected");
      const invokedIdx = events.findIndex((e) => e.type === "agent_invoked");
      expect(driftIdx).toBeGreaterThanOrEqual(0);
      expect(invokedIdx).toBeGreaterThanOrEqual(0);
      expect(driftIdx).toBeLessThan(invokedIdx);

      // System log carries the signal.
      const systemTexts = await readSystemLogTexts(runDir);
      expect(
        systemTexts.some((t) => t.toLowerCase().includes("schema"))
      ).toBe(true);

      // console.warn carries the signal (CLI-visible).
      expect(warnSpy).toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some((c) =>
          String(c[0]).toLowerCase().includes("schema")
        )
      ).toBe(true);
    }
  );

  it(
    "emits schema_drift_detected with the current attempt when a retry attempt compiles a different schema (T-295-W1-2, UC-295-002)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SIMPLE_AGENT_YAML,
        "drift-retry"
      );
      await setJobRunning(runDir, "intake", "analyze", 2);

      // Attempt 1 (previous process, before a workflow edit) recorded a hash.
      const priorHash = "b".repeat(64);
      await writePriorInvocation(runDir, "intake", 1, "analyze", priorHash);

      const expectedHash = await expectedSchemaHash(workflowPath);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const summary = await resumeRun(sandbox, runId, workflowPath);
      expect(summary.status).toBe("completed");

      const events = await readEvents(runDir);
      const driftEvents = events.filter((e) => e.type === "schema_drift_detected");
      expect(driftEvents.length).toBe(1);
      expect(driftEvents[0]!.payload).toMatchObject({
        job_id: "intake",
        step_id: "analyze",
        attempt: 2,
        prior_hash: priorHash,
        new_hash: expectedHash,
      });
      expect(warnSpy).toHaveBeenCalled();
    }
  );

  it(
    "emits no signal when the prior hash equals the newly compiled hash (T-295-W1-3, UC-295-003)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SIMPLE_AGENT_YAML,
        "drift-consistent"
      );
      await setJobRunning(runDir, "intake", "analyze", 2);

      // Seed the REAL current hash — the schema is unchanged since attempt 1.
      const currentHash = await expectedSchemaHash(workflowPath);
      await writePriorInvocation(runDir, "intake", 1, "analyze", currentHash);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const summary = await resumeRun(sandbox, runId, workflowPath);
      expect(summary.status).toBe("completed");

      const events = await readEvents(runDir);
      expect(events.filter((e) => e.type === "schema_drift_detected")).toHaveLength(0);
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).toLowerCase().includes("schema"))
      ).toBe(false);
    }
  );

  it(
    "skips the check when no prior invocation exists (T-295-W1-4, UC-295-004)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SIMPLE_AGENT_YAML,
        "drift-no-evidence"
      );
      await setJobRunning(runDir, "intake", "analyze", 1);
      // No invocation files at all — first execution of this step.

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const summary = await resumeRun(sandbox, runId, workflowPath);
      expect(summary.status).toBe("completed");

      const events = await readEvents(runDir);
      expect(events.filter((e) => e.type === "schema_drift_detected")).toHaveLength(0);
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).toLowerCase().includes("schema"))
      ).toBe(false);
    }
  );

  it(
    "backtracks past a hash-less decoy invocation to the older hash-bearing evidence (T-295-W1-5, UC-295-005)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SIMPLE_AGENT_YAML,
        "drift-backtrack-decoy"
      );
      await setJobRunning(runDir, "intake", "analyze", 3);

      // attempts/1 carries the hash; attempts/2 is a claude-code catch-path
      // shape (invocation WITHOUT output_schema_sha256).
      const priorHash = "c".repeat(64);
      await writePriorInvocation(runDir, "intake", 1, "analyze", priorHash);
      await writePriorInvocation(runDir, "intake", 2, "analyze");

      const expectedHash = await expectedSchemaHash(workflowPath);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const summary = await resumeRun(sandbox, runId, workflowPath);
      expect(summary.status).toBe("completed");

      const events = await readEvents(runDir);
      const driftEvents = events.filter((e) => e.type === "schema_drift_detected");
      expect(driftEvents.length).toBe(1);
      expect(driftEvents[0]!.payload).toMatchObject({
        attempt: 3,
        prior_hash: priorHash,
        new_hash: expectedHash,
      });
      expect(warnSpy).toHaveBeenCalled();
    }
  );

  it(
    "backtracks to the most recent hash-bearing invocation when several prior attempts have hashes (T-295-W1-6, UC-295-006)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SIMPLE_AGENT_YAML,
        "drift-backtrack-nearest"
      );
      await setJobRunning(runDir, "intake", "analyze", 3);

      const olderHash = "d".repeat(64);
      const nearestHash = "e".repeat(64);
      await writePriorInvocation(runDir, "intake", 1, "analyze", olderHash);
      await writePriorInvocation(runDir, "intake", 2, "analyze", nearestHash);

      const expectedHash = await expectedSchemaHash(workflowPath);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const summary = await resumeRun(sandbox, runId, workflowPath);
      expect(summary.status).toBe("completed");

      const events = await readEvents(runDir);
      const driftEvents = events.filter((e) => e.type === "schema_drift_detected");
      expect(driftEvents.length).toBe(1);
      expect(driftEvents[0]!.payload).toMatchObject({
        attempt: 3,
        prior_hash: nearestHash,
        new_hash: expectedHash,
      });
      expect(warnSpy).toHaveBeenCalled();
    }
  );
});
