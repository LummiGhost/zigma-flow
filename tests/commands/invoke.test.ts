import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { agentFactory, type AgentBackend, type AgentBackendConfig, type AgentExecuteOptions, type AgentExecuteResult } from "../../src/agent/index.js";
import { invokeAction } from "../../src/commands/invoke.js";

const TEST_BACKEND = "test-invoke";

const SINGLE_AGENT_WORKFLOW = `\
name: invoke-smoke
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        with:
          goal: "\${{ inputs.task }}"
`;

const TWO_AGENT_WORKFLOW = `\
name: invoke-multi
version: "0.1.0"
jobs:
  analyze:
    steps:
      - id: think
        type: agent
        allow_generic_prompt: true
        with:
          goal: "\${{ inputs.task }}"
      - id: review
        type: agent
        allow_generic_prompt: true
        with:
          goal: "review the output"
  summarize:
    needs:
      - analyze
    steps:
      - id: summarize
        type: agent
        allow_generic_prompt: true
`;

class TestInvokeBackend implements AgentBackend {
  readonly name = TEST_BACKEND;
  static calls: AgentExecuteOptions[] = [];

  constructor(_config: AgentBackendConfig) {}

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    TestInvokeBackend.calls.push(opts);
    await mkdir(dirname(opts.reportPath), { recursive: true });
    await writeFile(
      opts.reportPath,
      JSON.stringify(
        {
          outputs: { completed: true },
          artifacts: [],
          signals: [],
          summary: "fake backend completed the agent step",
        },
        null,
        2,
      ),
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
  const projectRoot = join(tmpdir(), `zigma-invoke-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const configPath = join(dotZigma, "config.json");
  const workflowPath = join(projectRoot, "workflow.yml");

  await mkdir(runsDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(
      {
        tool_version: "0.1.0",
        active_run: null,
        agent: {
          backend: TEST_BACKEND,
          backends: {
            [TEST_BACKEND]: { command: "fake" },
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  await writeFile(join(dotZigma, "skill-lock.json"), JSON.stringify({ skills: {} }, null, 2), "utf-8");
  await writeFile(workflowPath, SINGLE_AGENT_WORKFLOW, "utf-8");

  return { projectRoot, workflowPath, runsDir };
}

async function makeSandboxWithWorkflow(workflowYaml: string): Promise<Sandbox> {
  const sandbox = await makeSandbox();
  await writeFile(sandbox.workflowPath, workflowYaml, "utf-8");
  return sandbox;
}

describe("invokeAction", () => {
  let sandbox: Sandbox;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    sandbox = await makeSandbox();
    process.chdir(sandbox.projectRoot);
    TestInvokeBackend.calls = [];
    agentFactory.register(TEST_BACKEND, TestInvokeBackend);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    process.chdir(originalCwd);
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  // ── Basic execution ─────────────────────────────────────────────────────

  it("creates and executes a workflow to completion", async () => {
    const result = await invokeAction(sandbox.workflowPath, { task: "execute workflow" });

    expect(result.dryRun).toBe(false);
    expect(TestInvokeBackend.calls.length).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe("completed");

    // v0.6: active_run is deprecated — find the run via directory listing
    const runDirList = await readdir(sandbox.runsDir);
    const foundRunId = runDirList.sort().reverse()[0]!;

    const state = JSON.parse(
      await readFile(join(sandbox.runsDir, foundRunId, "state.json"), "utf-8"),
    ) as { status?: string; jobs: Record<string, { status: string }> };
    expect(state.status).toBe("completed");
    expect(state.jobs["intake"]?.status).toBe("completed");
  });

  it("returns a summary with job details", async () => {
    const result = await invokeAction(sandbox.workflowPath, { task: "test summary" });

    expect(result.jobs.length).toBeGreaterThan(0);
    const intakeJob = result.jobs.find((j) => j.id === "intake");
    expect(intakeJob).toBeDefined();
    expect(intakeJob!.status).toBe("completed");
  });

  // ── Dry-run ─────────────────────────────────────────────────────────────

  it("validates without executing when --dry-run is set", async () => {
    const result = await invokeAction(sandbox.workflowPath, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.runId).toBe("(dry-run)");
    expect(result.status).toBe("valid");
    // Backend should NOT have been called
    expect(TestInvokeBackend.calls.length).toBe(0);

    // Should print workflow info
    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
    expect(logs).toContain("invoke-smoke");
    expect(logs).toContain("Dry-run");
  });

  // ── Trace output ────────────────────────────────────────────────────────

  it("produces verbose output when --trace is set", async () => {
    await invokeAction(sandbox.workflowPath, { task: "trace test", trace: true });

    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
    // Should contain event IDs
    expect(logs).toMatch(/\[evt-/);
  });

  // ── Parallelism ─────────────────────────────────────────────────────────

  it("accepts custom parallelism", async () => {
    await invokeAction(sandbox.workflowPath, { task: "parallelism test", parallelism: 2 });

    const runDirList = await readdir(sandbox.runsDir);
    const foundRunId = runDirList.sort().reverse()[0]!;
    const state = JSON.parse(
      await readFile(join(sandbox.runsDir, foundRunId, "state.json"), "utf-8"),
    ) as { status?: string };
    expect(state.status).toBe("completed");
  });

  // ── Fail-fast ───────────────────────────────────────────────────────────

  it("accepts failFast option", async () => {
    await invokeAction(sandbox.workflowPath, { task: "failFast test", failFast: true });

    const runDirList = await readdir(sandbox.runsDir);
    const foundRunId = runDirList.sort().reverse()[0]!;
    const state = JSON.parse(
      await readFile(join(sandbox.runsDir, foundRunId, "state.json"), "utf-8"),
    ) as { status?: string };
    expect(state.status).toBe("completed");
  });

  // ── Custom backend ──────────────────────────────────────────────────────

  it("accepts --backend override", async () => {
    class CustomBackend implements AgentBackend {
      readonly name = "custom-backend";
      constructor(_config: AgentBackendConfig) {}
      async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
        await mkdir(dirname(opts.reportPath), { recursive: true });
        await writeFile(
          opts.reportPath,
          JSON.stringify({ outputs: { completed: true }, artifacts: [], signals: [], summary: "custom backend" }, null, 2),
          "utf-8",
        );
        return { success: true, reportPath: opts.reportPath };
      }
    }
    agentFactory.register("custom-backend", CustomBackend);

    // Update config to use custom-backend
    const dotZigma = join(sandbox.projectRoot, ".zigma-flow");
    await writeFile(
      join(dotZigma, "config.json"),
      JSON.stringify({
        tool_version: "0.1.0",
        active_run: null,
        agent: {
          backend: TEST_BACKEND,
          backends: {
            [TEST_BACKEND]: { command: "fake" },
            "custom-backend": { command: "custom" },
          },
        },
      }, null, 2),
      "utf-8",
    );

    await invokeAction(sandbox.workflowPath, { task: "backend test", backend: "custom-backend" });

    const runDirList = await readdir(sandbox.runsDir);
    const foundRunId = runDirList.sort().reverse()[0]!;
    const state = JSON.parse(
      await readFile(join(sandbox.runsDir, foundRunId, "state.json"), "utf-8"),
    ) as { status?: string };
    expect(state.status).toBe("completed");
  });

  // ── Error cases ─────────────────────────────────────────────────────────

  it("throws when neither --task nor --resume is provided (and no --dry-run)", async () => {
    await expect(
      invokeAction(sandbox.workflowPath, {}),
    ).rejects.toThrow("Either --task");
  });

  it("throws when both --task and --resume are provided", async () => {
    await expect(
      invokeAction(sandbox.workflowPath, { task: "x", resume: "20260714-0001" }),
    ).rejects.toThrow("mutually exclusive");
  });

  it("throws for invalid --pause-before format", async () => {
    await expect(
      invokeAction(sandbox.workflowPath, { task: "x", pauseBefore: "invalid" }),
    ).rejects.toThrow("job.step");
  });

  it("throws for invalid --stop-after format", async () => {
    await expect(
      invokeAction(sandbox.workflowPath, { task: "x", stopAfter: "bad" }),
    ).rejects.toThrow("job.step");
  });

  // ── Inputs ──────────────────────────────────────────────────────────────

  it("passes --input values to the workflow", async () => {
    await invokeAction(sandbox.workflowPath, {
      task: "input test",
      inputs: { "extra": "value" },
    });

    const runDirList = await readdir(sandbox.runsDir);
    const foundRunId = runDirList.sort().reverse()[0]!;
    const state = JSON.parse(
      await readFile(join(sandbox.runsDir, foundRunId, "state.json"), "utf-8"),
    ) as { status?: string };
    expect(state.status).toBe("completed");
  });
});

describe("invokeAction with two-agent workflow", () => {
  let sandbox: Sandbox;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    sandbox = await makeSandboxWithWorkflow(TWO_AGENT_WORKFLOW);
    process.chdir(sandbox.projectRoot);
    TestInvokeBackend.calls = [];
    agentFactory.register(TEST_BACKEND, TestInvokeBackend);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    process.chdir(originalCwd);
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("executes multi-step and multi-job workflows", async () => {
    const result = await invokeAction(sandbox.workflowPath, { task: "multi-step test" });

    expect(result.status).toBe("completed");
    // analyze has 2 agent steps, summarize has 1
    expect(TestInvokeBackend.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.jobs.length).toBeGreaterThanOrEqual(2);
  });
});
