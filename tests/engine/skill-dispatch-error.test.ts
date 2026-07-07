/**
 * Skill dispatch error surface tests — Issue #142, Problem 1.
 *
 * Verifies that when buildContext throws a SkillPackError (skill not in
 * skill-lock.json), runAll correctly fails the job with an informative
 * error reason rather than silently looping until maxIterations.
 *
 * Covers:
 *   - T-SKILL-ERR-1: Missing skill in skill-lock.json causes job to fail
 *                    with status="failed" and a descriptive reason, not
 *                    max-iterations exhaustion.
 *   - T-SKILL-ERR-2: The run status is "failed" (not undefined/running).
 *   - T-SKILL-ERR-3: A step_failed event is written with the context build
 *                    error message.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { runAll } from "../../src/engine/runAll.js";
import type { AgentBackend, AgentBackendConfig, AgentExecuteOptions, AgentExecuteResult } from "../../src/agent/index.js";
import type { Clock } from "../../src/run/index.js";
import { JsonlEventWriter, LocalStateStore } from "../../src/run/index.js";

// ---------------------------------------------------------------------------
// FakeClock
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-07-07T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

// ---------------------------------------------------------------------------
// FakeBackend — should never be called in these tests (context build fails
// before the backend is invoked), but is required by the interface.
// ---------------------------------------------------------------------------

class FakeBackend implements AgentBackend {
  readonly name = "fake-skill-err";
  static calls: AgentExecuteOptions[] = [];

  constructor(_config: AgentBackendConfig) {}

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    FakeBackend.calls.push(opts);
    await mkdir(dirname(opts.reportPath), { recursive: true });
    await writeFile(
      opts.reportPath,
      JSON.stringify({ outputs: { completed: true }, signals: [], artifacts: [] }, null, 2),
      "utf-8",
    );
    return { success: true, reportPath: opts.reportPath };
  }
}

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  dotZigma: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-skill-err-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const configPath = join(dotZigma, "config.json");
  const skillLockPath = join(dotZigma, "skill-lock.json");

  await mkdir(runsDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ tool_version: "0.1.0", active_run: null }, null, 2),
    "utf-8",
  );

  // skill-lock.json intentionally has NO skills registered
  await writeFile(skillLockPath, JSON.stringify({ skills: {} }, null, 2), "utf-8");

  return {
    projectRoot,
    zigmaflowDir: projectRoot,
    dotZigma,
    runsDir,
    skillLockPath,
  };
}

interface EventRecord {
  id: string;
  type: string;
  run_id: string;
  job?: string;
  step?: string;
  payload?: Record<string, unknown>;
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
// Workflow fixture — agent step that exposes a skill NOT in skill-lock.json
// ---------------------------------------------------------------------------

/**
 * Workflow with an agent step that exposes "my-skill" alias, which maps to
 * "zigma.missing-skill" in the skills map. Since skill-lock.json is empty,
 * buildContext will call resolveSkillLock and throw a SkillPackError.
 */
const WORKFLOW_WITH_MISSING_SKILL = `\
name: skill-err-test
version: "0.1.0"
skills:
  my-skill: zigma.missing-skill
jobs:
  analyze:
    steps:
      - id: run-analysis
        type: agent
        expose:
          skills:
            - my-skill
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAll — skill dispatch error (Issue #142 Problem 1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.calls = [];
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "fails the job with an informative error when the skill is missing from skill-lock.json (T-SKILL-ERR-1, T-SKILL-ERR-2)",
    async () => {
      const workflowPath = join(sandbox.projectRoot, "workflow.yml");
      await writeFile(workflowPath, WORKFLOW_WITH_MISSING_SKILL, "utf-8");

      const stateStore = new LocalStateStore();
      const eventWriter = new JsonlEventWriter();

      const summary = await runAll({
        task: "test skill dispatch error",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
        maxIterations: 10,
        stateStore,
        eventWriter,
      });

      // The backend should NOT have been called (error occurs before invocation)
      expect(FakeBackend.calls).toHaveLength(0);

      // The run should exit with a failed status, not exhaust iterations
      expect(summary.status).toBe("failed");
      expect(summary.iterations).toBeLessThan(10);

      // The job should be in "failed" status
      const analyzeJob = summary.jobs.find((j) => j.id === "analyze");
      expect(analyzeJob).toBeDefined();
      expect(analyzeJob!.status).toBe("failed");
    },
  );

  it(
    "writes a step_failed event with the context build error message (T-SKILL-ERR-3)",
    async () => {
      const workflowPath = join(sandbox.projectRoot, "workflow.yml");
      await writeFile(workflowPath, WORKFLOW_WITH_MISSING_SKILL, "utf-8");

      const stateStore = new LocalStateStore();
      const eventWriter = new JsonlEventWriter();

      const summary = await runAll({
        task: "test skill dispatch error events",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
        maxIterations: 10,
        stateStore,
        eventWriter,
      });

      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);
      const eventTypes = events.map((e) => e.type);

      // A step_failed event must be present
      expect(eventTypes).toContain("step_failed");

      // The step_failed event must contain the context build error message
      const stepFailedEvent = events.find((e) => e.type === "step_failed");
      expect(stepFailedEvent).toBeDefined();
      const reason = stepFailedEvent!.payload?.["reason"];
      expect(typeof reason).toBe("string");
      expect((reason as string).toLowerCase()).toContain("context build failed");

      // A run_failed event must also be present (config error → immediate run failure)
      expect(eventTypes).toContain("run_failed");
    },
  );
});
