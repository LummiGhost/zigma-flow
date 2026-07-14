/**
 * CLI integration tests for `zigma-flow run`.
 *
 * Covers the MVP init -> run contract that lets a freshly initialized project
 * start `.zigma-flow/workflows/<name>.yml` by workflow name.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveWorkflowPath, runAction } from "../../src/commands/run.js";
import { FilesystemError } from "../../src/utils/index.js";

const SINGLE_AGENT_WORKFLOW_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: analyze
        type: agent
        with:
          goal: "\${{ inputs.task }}"
`;

interface Sandbox {
  projectRoot: string;
  workflowsDir: string;
  runsDir: string;
  configPath: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-run-cli-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const workflowsDir = join(dotZigma, "workflows");
  const runsDir = join(dotZigma, "runs");
  const configPath = join(dotZigma, "config.json");
  const skillLockPath = join(dotZigma, "skill-lock.json");

  await mkdir(workflowsDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ tool_version: "0.1.0", active_run: null }, null, 2),
    "utf-8",
  );
  await writeFile(skillLockPath, JSON.stringify({ skills: {} }, null, 2), "utf-8");

  return {
    projectRoot,
    workflowsDir,
    runsDir,
    configPath,
    skillLockPath,
  };
}

describe("resolveWorkflowPath", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("resolves a bare workflow name from .zigma-flow/workflows (P12.4.1)", async () => {
    const workflowPath = join(sandbox.workflowsDir, "code-change.yml");
    await writeFile(workflowPath, SINGLE_AGENT_WORKFLOW_YAML, "utf-8");

    await expect(resolveWorkflowPath("code-change", sandbox.projectRoot)).resolves.toBe(
      workflowPath,
    );
  });

  it("keeps explicit workflow paths as the primary contract", async () => {
    const workflowPath = join(sandbox.projectRoot, "custom-flow.yml");
    await writeFile(workflowPath, SINGLE_AGENT_WORKFLOW_YAML, "utf-8");

    await expect(resolveWorkflowPath(workflowPath, sandbox.projectRoot)).resolves.toBe(
      workflowPath,
    );
  });
});

describe("runAction", () => {
  let sandbox: Sandbox;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    originalCwd = process.cwd();
    process.chdir(sandbox.projectRoot);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    process.chdir(originalCwd);
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("creates a run from a workflow name initialized under .zigma-flow/workflows", async () => {
    const workflowPath = join(sandbox.workflowsDir, "code-change.yml");
    await writeFile(workflowPath, SINGLE_AGENT_WORKFLOW_YAML, "utf-8");

    await runAction("code-change", { task: "fix the bug" });

    const runIds = await readdir(sandbox.runsDir);
    expect(runIds).toHaveLength(1);

    const runYaml = await readFile(join(sandbox.runsDir, runIds[0]!, "run.yml"), "utf-8");
    expect(runYaml).toContain("task: fix the bug");
    expect(runYaml).toContain("workflow:");
    expect(runYaml).toContain("path:");
    expect(runYaml).toContain("code-change.yml");

    // v0.6: active_run is deprecated — runAction no longer sets it in config.json

    const printed = logSpy.mock.calls
      .map((call: unknown[]) => String(call[0] ?? ""))
      .join("\n");
    expect(printed).toContain(`run: ${runIds[0]}`);
    expect(printed).toContain(`next: zigma-flow status ${runIds[0]}`);
  });

  it("still reports the underlying filesystem error when a workflow cannot be found", async () => {
    await expect(runAction("missing-workflow", { task: "fix the bug" })).rejects.toBeInstanceOf(
      FilesystemError,
    );
  });

  it("two runs coexist without interfering via active_run (T-CONCURRENT-1)", async () => {
    // v0.6: active_run is deprecated. Multiple runs coexist without a shared
    // pointer in config.json. Each run is independent.

    // Place the workflow under .zigma-flow/workflows/ so runAction can resolve
    // the bare name "code-change".
    const workflowsDir = join(sandbox.projectRoot, ".zigma-flow", "workflows");
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, "code-change.yml"), SINGLE_AGENT_WORKFLOW_YAML, "utf-8");

    // Create two runs sequentially (run ID generator uses directory listing which
    // is not safe for concurrent creation within the same process).
    await runAction("code-change", { task: "task A" });
    await runAction("code-change", { task: "task B" });

    // Both runs must exist.
    const runIds = await readdir(sandbox.runsDir);
    expect(runIds).toHaveLength(2);

    // Verify both tasks were recorded correctly.
    for (const rid of runIds) {
      const runYaml = await readFile(join(sandbox.runsDir, rid!, "run.yml"), "utf-8");
      expect(runYaml).toMatch(/task: task [AB]/);
      expect(runYaml).toContain("code-change.yml");
    }

    // Config should no longer have active_run set — no single "current" run.
    const config = JSON.parse(await readFile(sandbox.configPath, "utf-8")) as {
      active_run?: string | null;
    };
    expect(config.active_run ?? null).toBeNull();
  });
});
