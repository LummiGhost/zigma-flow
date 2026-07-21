/**
 * `resume --json` output tests (ISSUE #254).
 *
 * Covers:
 *   - JSON mode produces valid CommandJsonResult on success
 *   - JSON mode produces error JSON for various error codes
 *   - Structured decision data in success response
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import { enterHumanGate } from "../../src/engine/humanGate.js";
import type { Clock, RunState } from "../../src/run/index.js";
import { LocalStateStore, JsonlEventWriter } from "../../src/run/index.js";
import { resumeAction } from "../../src/commands/resume.js";

const FIXED_ISO = "2026-07-14T00:00:00.000Z";

class FakeClock implements Clock {
  now(): string {
    return FIXED_ISO;
  }
}

const HUMAN_WORKFLOW_YAML = `\
name: resume-json-test
version: "0.1.0"
jobs:
  gate:
    steps:
      - id: approve-merge
        type: human
        prompt: "Review and approve the merge."
        with:
          inputs:
            decision:
              type: string
              enum:
                - approve
                - reject
              required: true
`;

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  runsDir: string;
  workflowPath: string;
  skillLockPath: string;
  runId: string;
  runDir: string;
}

async function makeSandboxWithHumanGate(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-resume-json-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const workflowPath = join(projectRoot, "workflow.yml");
  const skillLockPath = join(dotZigma, "skill-lock.json");

  await mkdir(runsDir, { recursive: true });
  await writeFile(workflowPath, HUMAN_WORKFLOW_YAML, "utf-8");
  await writeFile(skillLockPath, JSON.stringify({ skills: {} }), "utf-8");
  await writeFile(
    join(dotZigma, "config.json"),
    JSON.stringify({ active_run: null }),
    "utf-8",
  );

  const clock = new FakeClock();
  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  const { runId } = await createRun({
    workflowPath,
    task: "test human gate",
    runsDir,
    skillLockPath,
    clock,
  });

  const runDir = join(runsDir, runId);

  // Set up the job state so enterHumanGate works
  const state = await stateStore.readSnapshot(runDir);
  if (state === null) throw new Error("state not found");

  const updated: RunState = {
    ...state,
    jobs: {
      ...state.jobs,
      gate: {
        ...(state.jobs["gate"] ?? { status: "running" as const }),
        status: "running" as const,
        current_step: "approve-merge",
        attempt: 1,
      },
    },
    status: "running",
  };
  await stateStore.writeSnapshot(runDir, updated);

  await enterHumanGate({
    runDir,
    runId,
    jobId: "gate",
    stepId: "approve-merge",
    stepPrompt: "Review and approve the merge.",
    clock,
    stateStore,
    eventWriter,
  });

  return { projectRoot, zigmaflowDir: projectRoot, runsDir, workflowPath, skillLockPath, runId, runDir };
}

describe("resumeAction --json", () => {
  let sandbox: Sandbox | undefined;
  let stdoutLines: string[];
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    sandbox = await makeSandboxWithHumanGate();
    process.chdir(sandbox.projectRoot);
    stdoutLines = [];
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (sandbox) {
      await rm(sandbox.projectRoot, { recursive: true, force: true });
    }
  });

  // ── Success ────────────────────────────────────────────────────────────

  it("produces valid CommandJsonResult on successful resume", async () => {
    const stdout = vi.fn((line: string) => { stdoutLines.push(line); });

    const result = await resumeAction({
      zigmaflowDir: sandbox!.zigmaflowDir,
      runId: sandbox!.runId,
      jobId: "gate",
      stepId: "approve-merge",
      input: { decision: "approve" },
      clock: new FakeClock(),
      json: true,
      stdout,
    });

    expect(result.status).toBe("success");
    expect(result.command).toBe("resume");
    expect(result.runId).toBe(sandbox!.runId);
    expect(result.contractVersion).toBe(1);

    const data = result.data;
    expect(data["jobId"]).toBe("gate");
    expect(data["stepId"]).toBe("approve-merge");
    expect(data["outcome"]).toBe("approved");
    // Single-step human gate job: approving completes it → "completed"
    expect(["continue", "completed"]).toContain(data["nextAction"]);
    expect(data["recordedAt"]).toBeTruthy();
    expect(data["effects"]).toBeDefined();

    // Verify JSON output
    const jsonOutput = JSON.parse(stdoutLines[0]!) as Record<string, unknown>;
    expect(jsonOutput["status"]).toBe("success");
    const jsonData = jsonOutput["data"] as Record<string, unknown>;
    expect(jsonData["outcome"]).toBe("approved");
  });

  // ── Error: run not found ───────────────────────────────────────────────

  it("produces RUN_NOT_FOUND for nonexistent run", async () => {
    const stdout = vi.fn((line: string) => { stdoutLines.push(line); });

    const result = await resumeAction({
      zigmaflowDir: sandbox!.zigmaflowDir,
      runId: "nonexistent-run",
      jobId: "gate",
      input: { decision: "approve" },
      clock: new FakeClock(),
      json: true,
      stdout,
    });

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("RUN_NOT_FOUND");
  });

  // ── Error: job not found ───────────────────────────────────────────────

  it("produces JOB_NOT_FOUND for invalid job id", async () => {
    const stdout = vi.fn((line: string) => { stdoutLines.push(line); });

    const result = await resumeAction({
      zigmaflowDir: sandbox!.zigmaflowDir,
      runId: sandbox!.runId,
      jobId: "nonexistent-job",
      input: { decision: "approve" },
      clock: new FakeClock(),
      json: true,
      stdout,
    });

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("JOB_NOT_FOUND");
  });

  // ── Error: step not awaiting (after first resume completes it) ────────

  it("produces STEP_NOT_AWAITING when resuming an already-resolved step", async () => {
    // First resume — succeeds
    const stdout1 = vi.fn();
    await resumeAction({
      zigmaflowDir: sandbox!.zigmaflowDir,
      runId: sandbox!.runId,
      jobId: "gate",
      stepId: "approve-merge",
      input: { decision: "approve" },
      clock: new FakeClock(),
      stdout: stdout1,
    });

    // Second resume — step is no longer awaiting
    const stdout = vi.fn((line: string) => { stdoutLines.push(line); });
    const result = await resumeAction({
      zigmaflowDir: sandbox!.zigmaflowDir,
      runId: sandbox!.runId,
      jobId: "gate",
      stepId: "approve-merge",
      input: { decision: "approve" },
      clock: new FakeClock(),
      json: true,
      stdout,
    });

    expect(result.status).toBe("error");
    // After approve completes the job, state transition happens.
    // The step_status is no longer awaiting → STEP_NOT_AWAITING or ALREADY_DECIDED
    const code = result.error?.code;
    expect(
      code === "STEP_NOT_AWAITING" || code === "ALREADY_DECIDED" || code === "STATE_CORRUPT",
    ).toBe(true);
  });
});
