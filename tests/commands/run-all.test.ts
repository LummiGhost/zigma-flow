import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { agentFactory, type AgentBackend, type AgentBackendConfig, type AgentExecuteOptions, type AgentExecuteResult } from "../../src/agent/index.js";
import { runAllAction } from "../../src/commands/run-all.js";

const TEST_BACKEND = "test-run-all";

const SINGLE_AGENT_WORKFLOW_YAML = `\
name: run-all-smoke
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

class TestRunAllBackend implements AgentBackend {
  readonly name = TEST_BACKEND;
  static calls: AgentExecuteOptions[] = [];

  constructor(_config: AgentBackendConfig) {}

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    TestRunAllBackend.calls.push(opts);
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
  configPath: string;
  runsDir: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-run-all-${randomUUID()}`);
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
  await writeFile(workflowPath, SINGLE_AGENT_WORKFLOW_YAML, "utf-8");

  return { projectRoot, workflowPath, configPath, runsDir };
}

describe("runAllAction", () => {
  let sandbox: Sandbox;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    sandbox = await makeSandbox();
    process.chdir(sandbox.projectRoot);
    TestRunAllBackend.calls = [];
    agentFactory.register(TEST_BACKEND, TestRunAllBackend);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.chdir(originalCwd);
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("executes the initial ready agent job instead of treating the run as stuck", async () => {
    await runAllAction(sandbox.workflowPath, { task: "exercise the first ready job" });

    expect(TestRunAllBackend.calls).toHaveLength(1);
    expect(TestRunAllBackend.calls[0]!.prompt).toContain("# intake/analyze Agent Prompt");
    expect(TestRunAllBackend.calls[0]!.prompt).toContain("exercise the first ready job");

    const config = JSON.parse(await readFile(sandbox.configPath, "utf-8")) as {
      active_run: string | null;
    };
    expect(config.active_run).toBeTruthy();

    const state = JSON.parse(
      await readFile(join(sandbox.runsDir, config.active_run!, "state.json"), "utf-8"),
    ) as {
      status?: string;
      jobs: Record<string, { status: string; outputs?: Record<string, unknown> }>;
    };

    expect(state.status).toBe("completed");
    expect(state.jobs["intake"]?.status).toBe("completed");
    expect(state.jobs["intake"]?.outputs).toEqual({ completed: true });
  });
});
