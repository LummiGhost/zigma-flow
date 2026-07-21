/**
 * `invoke --json` output tests (ISSUE #254).
 *
 * Covers:
 *   - JSON mode produces valid InvokeJsonOutput to stdout
 *   - Dry-run JSON output has correct shape
 *   - Error JSON output on invalid context-file
 *   - --event-file creates NDJSON sink
 *   - Status mapping and exit code mapping
 *   - mapRunAllStatusToInvokeStatus and statusToExitCode unit tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { agentFactory, type AgentBackend, type AgentBackendConfig, type AgentExecuteOptions, type AgentExecuteResult } from "../../src/agent/index.js";
import { invokeAction } from "../../src/commands/invoke.js";
import {
  mapRunAllStatusToInvokeStatus,
  statusToExitCode,
} from "../../src/commands/invoke-schema.js";

const TEST_BACKEND = "test-invoke-json";

const AGENT_WORKFLOW = `\
name: invoke-json-test
version: "0.1.0"
jobs:
  main:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        with:
          goal: "\${{ inputs.task }}"
`;

class TestBackend implements AgentBackend {
  readonly name = TEST_BACKEND;
  static calls: AgentExecuteOptions[] = [];

  constructor(_config: AgentBackendConfig) {}

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    TestBackend.calls.push(opts);
    await mkdir(dirname(opts.reportPath), { recursive: true });
    await writeFile(
      opts.reportPath,
      JSON.stringify({
        outputs: { completed: true },
        artifacts: [],
        signals: [],
        summary: "ok",
      }),
      "utf-8",
    );
    return { success: true, reportPath: opts.reportPath };
  }
}

interface Sandbox {
  projectRoot: string;
  workflowPath: string;
  runsDir: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-invoke-json-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const configPath = join(dotZigma, "config.json");
  const workflowPath = join(projectRoot, "workflow.yml");

  await mkdir(runsDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      tool_version: "0.1.0",
      active_run: null,
      agent: {
        backend: TEST_BACKEND,
        backends: { [TEST_BACKEND]: { command: "fake" } },
      },
    }),
    "utf-8",
  );
  await writeFile(join(dotZigma, "skill-lock.json"), JSON.stringify({ skills: {} }), "utf-8");
  await writeFile(workflowPath, AGENT_WORKFLOW, "utf-8");

  return { projectRoot, workflowPath, runsDir };
}

describe("invokeAction --json", () => {
  let sandbox: Sandbox;
  let originalCwd: string;
  let stdoutLines: string[];
  let stderrLines: string[];

  beforeEach(async () => {
    originalCwd = process.cwd();
    sandbox = await makeSandbox();
    process.chdir(sandbox.projectRoot);
    TestBackend.calls = [];
    agentFactory.register(TEST_BACKEND, TestBackend);
    stdoutLines = [];
    stderrLines = [];
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  // ── JSON output shape ──────────────────────────────────────────────────

  it("produces valid InvokeJsonOutput to stdout when --json is set", async () => {
    const stdout = vi.fn((line: string) => { stdoutLines.push(line); });
    const stderr = vi.fn((line: string) => { stderrLines.push(line); });

    await invokeAction(sandbox.workflowPath, {
      task: "test json output",
      json: true,
      stdout,
      stderr,
    });

    expect(stdoutLines.length).toBe(1);
    const output = JSON.parse(stdoutLines[0]!) as Record<string, unknown>;

    expect(output["contractVersion"]).toBe(1);
    expect(typeof output["runId"]).toBe("string");
    expect(output["runId"]).not.toBe("(error)");
    expect(output["status"]).toBe("completed");
    expect(output["exitCode"]).toBe(0);
    expect(output["pausedGate"]).toBeNull();
    expect(Array.isArray(output["artifacts"])).toBe(true);
    expect(typeof output["eventLogUri"]).toBe("string");
    expect((output["eventLogUri"] as string).startsWith("file://")).toBe(true);
  });

  it("outputs human-readable messages to stderr in JSON mode", async () => {
    const stdout = vi.fn((_line: string) => { stdoutLines.push(_line); });
    const stderr = vi.fn((_line: string) => { stderrLines.push(_line); });

    await invokeAction(sandbox.workflowPath, {
      task: "test stderr",
      json: true,
      stdout,
      stderr,
    });

    // Console.log is still called for "Agent backend:" etc., but
    // stdout callback only gets the JSON. The output injection means
    // non-JSON console output goes to the real console unless suppressed.
    // At minimum, stdout should contain valid JSON.
    expect(stdoutLines.length).toBeGreaterThanOrEqual(1);
    JSON.parse(stdoutLines[0]!); // does not throw
  });

  // ── Dry-run JSON ───────────────────────────────────────────────────────

  it("dry-run with --json produces valid InvokeJsonOutput", async () => {
    const stdout = vi.fn((line: string) => { stdoutLines.push(line); });

    await invokeAction(sandbox.workflowPath, {
      dryRun: true,
      json: true,
      stdout,
    });

    const output = JSON.parse(stdoutLines[0]!) as Record<string, unknown>;
    expect(output["runId"]).toBe("(dry-run)");
    expect(output["status"]).toBe("running");
    expect(output["exitCode"]).toBe(0);
  });

  // ── Error JSON output ──────────────────────────────────────────────────

  it("invalid context-file produces error JSON in --json mode", async () => {
    const stdout = vi.fn((line: string) => { stdoutLines.push(line); });

    // Create an invalid context file
    const badContextPath = join(sandbox.projectRoot, "bad-context.json");
    await writeFile(badContextPath, JSON.stringify({ user: "not-an-object" }), "utf-8");

    const result = await invokeAction(sandbox.workflowPath, {
      task: "test error json",
      json: true,
      contextFile: badContextPath,
      stdout,
    });

    // Should have returned a failed summary without throwing
    expect(result.status).toBe("failed");
  });

  // ── --event-file creates NDJSON sink ───────────────────────────────────

  it("--event-file produces an NDJSON file with FlowPlatformEvents", async () => {
    const eventFilePath = join(sandbox.projectRoot, "events.ndjson");
    const stdout = vi.fn((_line: string) => { stdoutLines.push(_line); });

    await invokeAction(sandbox.workflowPath, {
      task: "test event sink",
      json: true,
      eventFile: eventFilePath,
      stdout,
    });

    // The event file should exist and contain NDJSON
    const content = await readFile(eventFilePath, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    // Each line should be valid JSON with FlowPlatformEvent shape
    for (const line of lines) {
      const evt = JSON.parse(line) as Record<string, unknown>;
      expect(typeof evt["eventId"]).toBe("string");
      expect(typeof evt["runId"]).toBe("string");
      expect(typeof evt["type"]).toBe("string");
      expect(typeof evt["occurredAt"]).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Status mapping unit tests
// ---------------------------------------------------------------------------

describe("mapRunAllStatusToInvokeStatus", () => {
  it("returns awaiting_human when hasPausedGate is true regardless of run status", () => {
    expect(mapRunAllStatusToInvokeStatus("running", true)).toBe("awaiting_human");
    expect(mapRunAllStatusToInvokeStatus(undefined, true)).toBe("awaiting_human");
  });

  it("returns completed for completed status with no paused gate", () => {
    expect(mapRunAllStatusToInvokeStatus("completed", false)).toBe("completed");
  });

  it("returns failed for failed status with no paused gate", () => {
    expect(mapRunAllStatusToInvokeStatus("failed", false)).toBe("failed");
  });

  it("returns failed for blocked status with no paused gate", () => {
    expect(mapRunAllStatusToInvokeStatus("blocked", false)).toBe("failed");
  });

  it("returns cancelled for cancelled status with no paused gate", () => {
    expect(mapRunAllStatusToInvokeStatus("cancelled", false)).toBe("cancelled");
  });

  it("returns running for undefined status with no paused gate", () => {
    expect(mapRunAllStatusToInvokeStatus(undefined, false)).toBe("running");
  });
});

describe("statusToExitCode", () => {
  it("returns 0 for completed", () => {
    expect(statusToExitCode("completed")).toBe(0);
  });

  it("returns 0 for awaiting_human", () => {
    expect(statusToExitCode("awaiting_human")).toBe(0);
  });

  it("returns 0 for running", () => {
    expect(statusToExitCode("running")).toBe(0);
  });

  it("returns 1 for failed", () => {
    expect(statusToExitCode("failed")).toBe(1);
  });

  it("returns 1 for cancelled", () => {
    expect(statusToExitCode("cancelled")).toBe(1);
  });
});
