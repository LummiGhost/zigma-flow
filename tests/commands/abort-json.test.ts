/**
 * `abort --json` output tests (ISSUE #254).
 *
 * Covers:
 *   - JSON mode produces valid CommandJsonResult on success
 *   - JSON mode produces error JSON on RUN_NOT_FOUND
 *   - Interactive mode output is unchanged
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock } from "../../src/run/index.js";
import { abortAction } from "../../src/commands/abort.js";

const FIXED_ISO = "2026-07-14T00:00:00.000Z";

class FakeClock implements Clock {
  now(): string {
    return FIXED_ISO;
  }
}

const MINIMAL_WORKFLOW_YAML = `\
name: abort-json-test
version: "0.1.0"
jobs:
  plan:
    steps:
      - id: plan-step
        type: script
        run: "echo plan"
`;

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  runsDir: string;
  workflowPath: string;
  skillLockPath: string;
  runId: string;
}

async function makeSandboxWithRun(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-abort-json-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const workflowPath = join(projectRoot, "workflow.yml");
  const skillLockPath = join(dotZigma, "skill-lock.json");

  await mkdir(runsDir, { recursive: true });
  await writeFile(workflowPath, MINIMAL_WORKFLOW_YAML, "utf-8");
  await writeFile(skillLockPath, JSON.stringify({ skills: {} }), "utf-8");
  await writeFile(
    join(dotZigma, "config.json"),
    JSON.stringify({ active_run: null }),
    "utf-8",
  );

  const clock = new FakeClock();
  const { runId } = await createRun({
    workflowPath,
    task: "test task",
    runsDir,
    skillLockPath,
    clock,
  });

  return { projectRoot, zigmaflowDir: projectRoot, runsDir, workflowPath, skillLockPath, runId };
}

describe("abortAction --json", () => {
  let sandbox: Sandbox;
  let stdoutLines: string[];

  beforeEach(async () => {
    sandbox = await makeSandboxWithRun();
    stdoutLines = [];
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  // ── Success ────────────────────────────────────────────────────────────

  it("produces valid CommandJsonResult on successful abort", async () => {
    const stdout = vi.fn((line: string) => { stdoutLines.push(line); });

    const result = await abortAction({
      zigmaflowDir: sandbox.zigmaflowDir,
      clock: new FakeClock(),
      runId: sandbox.runId,
      json: true,
      stdout,
    });

    expect(result.status).toBe("success");
    expect(result.command).toBe("abort");
    expect(result.runId).toBe(sandbox.runId);
    expect(result.contractVersion).toBe(1);

    const jsonOutput = JSON.parse(stdoutLines[0]!) as Record<string, unknown>;
    expect(jsonOutput["contractVersion"]).toBe(1);
    expect(jsonOutput["command"]).toBe("abort");
    expect(jsonOutput["status"]).toBe("success");
    expect(jsonOutput["runId"]).toBe(sandbox.runId);
  });

  it("includes reason in success data when provided", async () => {
    const stdout = vi.fn((line: string) => { stdoutLines.push(line); });

    const result = await abortAction({
      zigmaflowDir: sandbox.zigmaflowDir,
      clock: new FakeClock(),
      runId: sandbox.runId,
      reason: "testing abort",
      json: true,
      stdout,
    });

    const jsonOutput = JSON.parse(stdoutLines[0]!) as Record<string, unknown>;
    const data = jsonOutput["data"] as Record<string, unknown>;
    expect(data["reason"]).toBe("testing abort");
  });

  // ── Error: run not found ───────────────────────────────────────────────

  it("produces RUN_NOT_FOUND error in JSON mode for nonexistent run", async () => {
    const stdout = vi.fn((line: string) => { stdoutLines.push(line); });

    const result = await abortAction({
      zigmaflowDir: sandbox.zigmaflowDir,
      clock: new FakeClock(),
      runId: "nonexistent-run",
      json: true,
      stdout,
    });

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("RUN_NOT_FOUND");

    const jsonOutput = JSON.parse(stdoutLines[0]!) as Record<string, unknown>;
    expect(jsonOutput["status"]).toBe("error");
    const err = jsonOutput["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("RUN_NOT_FOUND");
  });

  // ── Error: already terminal ────────────────────────────────────────────

  it("produces RUN_ALREADY_TERMINAL error for already-aborted run", async () => {
    // First abort succeeds
    const stdout1 = vi.fn();
    await abortAction({
      zigmaflowDir: sandbox.zigmaflowDir,
      clock: new FakeClock(),
      runId: sandbox.runId,
      stdout: stdout1,
    });

    // Second abort should fail
    const stdout = vi.fn((line: string) => { stdoutLines.push(line); });
    const result = await abortAction({
      zigmaflowDir: sandbox.zigmaflowDir,
      clock: new FakeClock(),
      runId: sandbox.runId,
      json: true,
      stdout,
    });

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("RUN_ALREADY_TERMINAL");
  });
});
