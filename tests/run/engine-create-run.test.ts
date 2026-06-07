/**
 * Integration tests for engine.createRun (WF-P3-RUN Step 1 — Cases and Tests).
 *
 * Uses real os.tmpdir() directories; no filesystem mocks.
 * Tests will not compile until Step 2 implements:
 *   - src/run/index.ts (infrastructure adapters + types)
 *   - src/engine/index.ts (createRun)
 *
 * Reference:
 *   - docs/phases/p3-run/workflows/wf-p3-run/01-cases-and-tests.md
 *   - docs/mvp-contracts.md §2.3, §2.4
 *   - docs/prd.md FR-004
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { Clock, RunState, WorkflowEvent } from "../../src/run/index.js";
import { createRun } from "../../src/engine/index.js";
import type { CreateRunInputs } from "../../src/engine/index.js";

class FakeClock implements Clock {
  constructor(private readonly iso: string) {}
  now(): string {
    return this.iso;
  }
}

const FIXED_ISO = "2026-06-07T00:00:00.000Z";

// Minimal workflow with: intake (ready), code-map (waiting on intake), review (inactive/optional).
const WORKFLOW_YAML = `\
name: code-change
version: "1.0.0"
jobs:
  intake:
    steps:
      - id: run-intake
        type: agent
  code-map:
    needs: [intake]
    steps:
      - id: run-code-map
        type: agent
  review:
    activation: optional
    steps:
      - id: run-review
        type: agent
`;

// Workflow with two no-dependency jobs (both ready) for event-count assertions.
const TWO_READY_WORKFLOW_YAML = `\
name: two-ready
version: "1.0.0"
jobs:
  job-a:
    steps:
      - id: step-a
        type: agent
  job-b:
    steps:
      - id: step-b
        type: agent
`;

describe("engine.createRun", () => {
  let tmpDir: string;
  let runsDir: string;
  let skillLockPath: string;
  let workflowPath: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-engine-test-${randomUUID()}`);
    runsDir = join(tmpDir, "runs");
    skillLockPath = join(tmpDir, "skill-lock.json");
    workflowPath = join(tmpDir, "code-change.yml");
    await mkdir(runsDir, { recursive: true });
    await writeFile(skillLockPath, JSON.stringify({ version: "1.0.0", skills: {} }), "utf-8");
    await writeFile(workflowPath, WORKFLOW_YAML, "utf-8");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates run directory with run.yml, state.json, events.jsonl, skill-lock.snapshot.json (T-ENG-1, UC-ENG-1)", async () => {
    const inputs: CreateRunInputs = {
      workflowPath,
      task: "fix the bug",
      runsDir,
      skillLockPath,
      clock: new FakeClock(FIXED_ISO),
    };
    const { runId } = await createRun(inputs);
    const runDir = join(runsDir, runId);
    const [runYml, stateJson, eventsJsonl, skillLock] = await Promise.all([
      stat(join(runDir, "run.yml")),
      stat(join(runDir, "state.json")),
      stat(join(runDir, "events.jsonl")),
      stat(join(runDir, "skill-lock.snapshot.json")),
    ]);
    expect(runYml.isFile()).toBe(true);
    expect(stateJson.isFile()).toBe(true);
    expect(eventsJsonl.isFile()).toBe(true);
    expect(skillLock.isFile()).toBe(true);
  });

  it("returns a YYYYMMDD-NNNN run id matching state.run_id; first id is 20260607-0001 (T-ENG-2, UC-ENG-1, UC-ENG-7)", async () => {
    const inputs: CreateRunInputs = {
      workflowPath,
      task: "deterministic id test",
      runsDir,
      skillLockPath,
      clock: new FakeClock(FIXED_ISO),
    };
    const { runId } = await createRun(inputs);
    expect(runId).toMatch(/^\d{8}-\d{4}$/);
    expect(runId).toBe("20260607-0001");
    const stateRaw = await readFile(join(runsDir, runId, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as RunState;
    expect(state.run_id).toBe(runId);
  });

  it("marks no-dependency required jobs as ready and dependent jobs as waiting (T-ENG-3, UC-ENG-2)", async () => {
    const inputs: CreateRunInputs = {
      workflowPath,
      task: "check job states",
      runsDir,
      skillLockPath,
      clock: new FakeClock(FIXED_ISO),
    };
    const { runId } = await createRun(inputs);
    const stateRaw = await readFile(join(runsDir, runId, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as RunState;
    expect(state.jobs["intake"]?.status).toBe("ready");
    expect(state.jobs["code-map"]?.status).toBe("waiting");
  });

  it("marks activation: optional jobs as inactive (T-ENG-4, UC-ENG-3)", async () => {
    const inputs: CreateRunInputs = {
      workflowPath,
      task: "check optional job",
      runsDir,
      skillLockPath,
      clock: new FakeClock(FIXED_ISO),
    };
    const { runId } = await createRun(inputs);
    const stateRaw = await readFile(join(runsDir, runId, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as RunState;
    expect(state.jobs["review"]?.status).toBe("inactive");
    expect(state.jobs["review"]?.activation).toBe("optional");
  });

  it("state.last_event_id equals the id of the last line in events.jsonl (T-ENG-5, UC-ENG-4)", async () => {
    const inputs: CreateRunInputs = {
      workflowPath,
      task: "event id consistency",
      runsDir,
      skillLockPath,
      clock: new FakeClock(FIXED_ISO),
    };
    const { runId } = await createRun(inputs);
    const runDir = join(runsDir, runId);
    const [stateRaw, eventsRaw] = await Promise.all([
      readFile(join(runDir, "state.json"), "utf-8"),
      readFile(join(runDir, "events.jsonl"), "utf-8"),
    ]);
    const state = JSON.parse(stateRaw) as RunState;
    const lines = eventsRaw.trim().split("\n").filter(Boolean);
    const lastEvent = JSON.parse(lines[lines.length - 1]!) as WorkflowEvent;
    expect(state.last_event_id).toBe(lastEvent.id);
  });

  it("writes run_created then one job_ready per initial ready job, with sequential evt ids (T-ENG-6, UC-ENG-5)", async () => {
    const twoReadyPath = join(tmpDir, "two-ready.yml");
    await writeFile(twoReadyPath, TWO_READY_WORKFLOW_YAML, "utf-8");
    const inputs: CreateRunInputs = {
      workflowPath: twoReadyPath,
      task: "two ready jobs",
      runsDir,
      skillLockPath,
      clock: new FakeClock(FIXED_ISO),
    };
    const { runId } = await createRun(inputs);
    const eventsRaw = await readFile(join(runsDir, runId, "events.jsonl"), "utf-8");
    const events = eventsRaw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkflowEvent);

    expect(events[0]?.type).toBe("run_created");
    expect(events[0]?.id).toBe("evt-001");

    const jobReadyEvents = events.slice(1);
    expect(jobReadyEvents).toHaveLength(2);
    expect(jobReadyEvents.every((e) => e.type === "job_ready")).toBe(true);
    expect(events[1]?.id).toBe("evt-002");
    expect(events[2]?.id).toBe("evt-003");

    const jobIds = new Set(jobReadyEvents.map((e) => e.payload["job_id"] as string));
    expect(jobIds).toEqual(new Set(["job-a", "job-b"]));
  });

  it("state.json is the run-state shape expected by the contract (T-ENG-7, UC-ENG-1)", async () => {
    const inputs: CreateRunInputs = {
      workflowPath,
      task: "contract shape check",
      runsDir,
      skillLockPath,
      clock: new FakeClock(FIXED_ISO),
    };
    const { runId } = await createRun(inputs);
    const stateRaw = await readFile(join(runsDir, runId, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as RunState;
    expect(state.run_id).toBeTruthy();
    expect(state.workflow).toBe("code-change");
    expect(state.task).toBe("contract shape check");
    expect(Date.parse(state.created_at)).not.toBeNaN();
    expect(state.last_event_id).toMatch(/^evt-\d{3}$/);
    expect(Object.keys(state.jobs)).toEqual(
      expect.arrayContaining(["intake", "code-map", "review"])
    );
  });
});
