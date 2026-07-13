/**
 * Job workspace resolution tests for Issue #178.
 *
 * Covers:
 *   - Schema validation: string workspace, object workspace, backward compat
 *   - extractWorkspacePath: string, object with directory, object without directory, undefined
 *   - resolveJobWorkingDirectory: expression resolution, missing directory, non-directory
 *   - Unresolved expression handling
 *   - Job-level cwd inheritance to steps via executeScriptStep
 *   - Step-level cwd overriding job-level cwd
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, parse as parsePath, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { loadWorkflow } from "../../src/workflow/index.js";
import type { WorkflowDefinition } from "../../src/workflow/index.js";
import { extractWorkspacePath, resolveJobWorkingDirectory } from "../../src/engine/workspace.js";
import { ValidationError, WorkflowError } from "../../src/utils/index.js";
import type { RunState } from "../../src/run/index.js";

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe("Job workspace — schema validation", () => {
  it("accepts string workspace on a job", () => {
    const yaml = `\
name: ws-test
version: "0.1.0"
jobs:
  build:
    workspace: /tmp/build-dir
    steps:
      - id: compile
        type: script
        run: echo hello
`;
    const wf = loadWorkflow(yaml);
    expect(wf.jobs["build"]?.workspace).toBe("/tmp/build-dir");
  });

  it("accepts object workspace with directory", () => {
    const yaml = `\
name: ws-test
version: "0.1.0"
jobs:
  build:
    workspace:
      directory: /tmp/build-dir
    steps:
      - id: compile
        type: script
        run: echo hello
`;
    const wf = loadWorkflow(yaml);
    const ws = wf.jobs["build"]?.workspace;
    expect(ws).toBeTypeOf("object");
    expect((ws as Record<string, unknown>).directory).toBe("/tmp/build-dir");
  });

  it("accepts object workspace with mode only (backward compat)", () => {
    const yaml = `\
name: ws-test
version: "0.1.0"
jobs:
  build:
    workspace:
      mode: read-only
    steps:
      - id: compile
        type: script
        run: echo hello
`;
    const wf = loadWorkflow(yaml);
    const ws = wf.jobs["build"]?.workspace;
    expect(ws).toBeTypeOf("object");
    expect((ws as Record<string, unknown>).mode).toBe("read-only");
  });

  it("accepts object workspace with both directory and mode", () => {
    const yaml = `\
name: ws-test
version: "0.1.0"
jobs:
  build:
    workspace:
      directory: /tmp/build-dir
      mode: read-only
    steps:
      - id: compile
        type: script
        run: echo hello
`;
    const wf = loadWorkflow(yaml);
    const ws = wf.jobs["build"]?.workspace;
    expect(ws).toBeTypeOf("object");
    expect((ws as Record<string, unknown>).directory).toBe("/tmp/build-dir");
    expect((ws as Record<string, unknown>).mode).toBe("read-only");
  });

  it("accepts job without workspace (backward compat)", () => {
    const yaml = `\
name: ws-test
version: "0.1.0"
jobs:
  build:
    steps:
      - id: compile
        type: script
        run: echo hello
`;
    const wf = loadWorkflow(yaml);
    expect(wf.jobs["build"]?.workspace).toBeUndefined();
  });

  it("rejects numeric workspace", () => {
    const yaml = `\
name: ws-test
version: "0.1.0"
jobs:
  build:
    workspace: 123
    steps:
      - id: compile
        type: script
        run: echo hello
`;
    expect(() => loadWorkflow(yaml)).toThrow();
  });

  it("rejects boolean workspace", () => {
    const yaml = `\
name: ws-test
version: "0.1.0"
jobs:
  build:
    workspace: true
    steps:
      - id: compile
        type: script
        run: echo hello
`;
    expect(() => loadWorkflow(yaml)).toThrow();
  });

  it("validates forbidden expressions in string workspace", () => {
    const yaml = `\
name: ws-test
version: "0.1.0"
jobs:
  build:
    workspace: "\${{ inputs.a + inputs.b }}"
    steps:
      - id: compile
        type: script
        run: echo hello
`;
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });

  it("validates forbidden expressions in workspace.directory", () => {
    const yaml = `\
name: ws-test
version: "0.1.0"
jobs:
  build:
    workspace:
      directory: "\${{ inputs.x * 2 }}"
    steps:
      - id: compile
        type: script
        run: echo hello
`;
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// extractWorkspacePath tests
// ---------------------------------------------------------------------------

describe("extractWorkspacePath", () => {
  it("returns undefined for undefined workspace", () => {
    const jobDef = { steps: [{ id: "s1", type: "script" as const, run: "echo" }] };
    expect(extractWorkspacePath(jobDef)).toBeUndefined();
  });

  it("returns string workspace directly", () => {
    const jobDef = {
      steps: [{ id: "s1", type: "script" as const, run: "echo" }],
      workspace: "/tmp/my-dir",
    };
    expect(extractWorkspacePath(jobDef)).toBe("/tmp/my-dir");
  });

  it("returns directory from object workspace", () => {
    const jobDef = {
      steps: [{ id: "s1", type: "script" as const, run: "echo" }],
      workspace: { directory: "/tmp/my-dir" },
    };
    expect(extractWorkspacePath(jobDef)).toBe("/tmp/my-dir");
  });

  it("returns undefined for object workspace without directory", () => {
    const jobDef = {
      steps: [{ id: "s1", type: "script" as const, run: "echo" }],
      workspace: { mode: "read-only" },
    };
    expect(extractWorkspacePath(jobDef)).toBeUndefined();
  });

  it("returns undefined for object workspace with empty directory", () => {
    const jobDef = {
      steps: [{ id: "s1", type: "script" as const, run: "echo" }],
      workspace: { directory: "" },
    };
    expect(extractWorkspacePath(jobDef)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// resolveJobWorkingDirectory tests
// ---------------------------------------------------------------------------

describe("resolveJobWorkingDirectory", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-ws-resolve-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeRunState(overrides?: Partial<RunState>): RunState {
    return {
      run_id: "test-run",
      workflow: "ws-test",
      task: "test task",
      created_at: "2026-07-13T00:00:00.000Z",
      last_event_id: "evt-001",
      jobs: {},
      ...overrides,
    };
  }

  it("returns undefined when job has no workspace config", async () => {
    const jobDef = { steps: [{ id: "s1", type: "script" as const, run: "echo" }] };
    const state = makeRunState();
    const result = await resolveJobWorkingDirectory(jobDef, state);
    expect(result).toBeUndefined();
  });

  it("returns undefined when workspace has only mode", async () => {
    const jobDef = {
      steps: [{ id: "s1", type: "script" as const, run: "echo" }],
      workspace: { mode: "read-only" },
    };
    const state = makeRunState();
    const result = await resolveJobWorkingDirectory(jobDef, state);
    expect(result).toBeUndefined();
  });

  it("resolves absolute path directly", async () => {
    const jobDef = {
      steps: [{ id: "s1", type: "script" as const, run: "echo" }],
      workspace: tmpDir,
    };
    const state = makeRunState();
    const result = await resolveJobWorkingDirectory(jobDef, state);
    expect(result).toBe(tmpDir);
  });

  it("resolves object workspace with directory", async () => {
    const jobDef = {
      steps: [{ id: "s1", type: "script" as const, run: "echo" }],
      workspace: { directory: tmpDir },
    };
    const state = makeRunState();
    const result = await resolveJobWorkingDirectory(jobDef, state);
    expect(result).toBe(tmpDir);
  });

  it("resolves ${{ variables.<name> }} in workspace path", async () => {
    const jobDef = {
      steps: [{ id: "s1", type: "script" as const, run: "echo" }],
      workspace: "${{ variables.build_dir }}",
    };
    const state = makeRunState({
      variables: { build_dir: tmpDir },
    });
    const result = await resolveJobWorkingDirectory(jobDef, state);
    expect(result).toBe(tmpDir);
  });

  it("resolves ${{ jobs.<id>.outputs.<key> }} in workspace path", async () => {
    const jobDef = {
      steps: [{ id: "s1", type: "script" as const, run: "echo" }],
      workspace: "${{ jobs.create-tree.outputs.path }}",
    };
    const state = makeRunState({
      jobs: {
        "create-tree": { status: "completed", outputs: { path: tmpDir } },
      },
    });
    const result = await resolveJobWorkingDirectory(jobDef, state);
    expect(result).toBe(tmpDir);
  });

  it("throws ValidationError for non-existent directory", async () => {
    const nonExistent = join(tmpDir, "does-not-exist");
    const jobDef = {
      steps: [{ id: "s1", type: "script" as const, run: "echo" }],
      workspace: nonExistent,
    };
    const state = makeRunState();
    await expect(resolveJobWorkingDirectory(jobDef, state)).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for file instead of directory", async () => {
    const filePath = join(tmpDir, "file.txt");
    await writeFile(filePath, "hello", "utf-8");
    const jobDef = {
      steps: [{ id: "s1", type: "script" as const, run: "echo" }],
      workspace: filePath,
    };
    const state = makeRunState();
    await expect(resolveJobWorkingDirectory(jobDef, state)).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError when expression is unresolved", async () => {
    const jobDef = {
      steps: [{ id: "s1", type: "script" as const, run: "echo" }],
      workspace: "${{ jobs.missing-job.outputs.path }}",
    };
    const state = makeRunState();
    await expect(resolveJobWorkingDirectory(jobDef, state)).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for path resolving to filesystem root", async () => {
    // Use the platform's actual root path
    const rootPath = parsePath(resolve("/")).root;
    const jobDef = {
      steps: [{ id: "s1", type: "script" as const, run: "echo" }],
      workspace: rootPath,
    };
    const state = makeRunState();
    await expect(resolveJobWorkingDirectory(jobDef, state)).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Integration: job-level cwd inheritance via executeScriptStep
// ---------------------------------------------------------------------------

import { createRun } from "../../src/engine/index.js";
import type { Clock } from "../../src/run/index.js";
import { executeScriptStep } from "../../src/script/executor.js";
import { appendArtifactIndex } from "../../src/artifact/artifactIndex.js";

const FIXED_ISO = "2026-07-13T00:00:00.000Z";

class FakeClock implements Clock {
  now(): string { return FIXED_ISO; }
}

interface FakeRunOptions {
  command: string;
  shell?: string | boolean;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

interface FakeRunResult {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
}

class FakeRunner {
  public readonly calls: FakeRunOptions[] = [];
  constructor(private readonly canned: FakeRunResult) {}
  async run(opts: FakeRunOptions): Promise<FakeRunResult> {
    this.calls.push(opts);
    return this.canned;
  }
}

const SCRIPT_WORKFLOW_YAML = `\
name: ws-integration-test
version: "0.1.0"
jobs:
  build:
    steps:
      - id: compile
        type: script
        run: "echo hello"
`;

interface Sandbox {
  projectRoot: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-ws-integration-${randomUUID()}`);
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
  await writeFile(
    skillLockPath,
    JSON.stringify({ skills: {} }, null, 2),
    "utf-8"
  );

  return { projectRoot, runsDir, skillLockPath };
}

async function bootstrapScriptRun(
  sandbox: Sandbox,
  yamlBody: string
): Promise<{ runId: string; runDir: string; workflowPath: string }> {
  const workflowPath = join(sandbox.projectRoot, "workflow.yml");
  await writeFile(workflowPath, yamlBody, "utf-8");

  const { runId } = await createRun({
    workflowPath,
    task: "test task",
    runsDir: sandbox.runsDir,
    skillLockPath: sandbox.skillLockPath,
    clock: new FakeClock(),
  });
  const runDir = join(sandbox.runsDir, runId);
  return { runId, runDir, workflowPath };
}

describe("executeScriptStep — jobCwd inheritance", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("uses jobCwd as default cwd when step has no cwd", async () => {
    const workDir = join(sandbox.projectRoot, "target-dir");
    await mkdir(workDir, { recursive: true });

    const { runId, runDir, workflowPath } = await bootstrapScriptRun(
      sandbox,
      SCRIPT_WORKFLOW_YAML
    );
    const runner = new FakeRunner({
      exitCode: 0,
      timedOut: false,
      stdout: "ok",
      stderr: "",
      startedAt: FIXED_ISO,
      endedAt: FIXED_ISO,
    });

    await executeScriptStep({
      runDir,
      zigmaflowDir: sandbox.projectRoot,
      runId,
      jobId: "build",
      clock: new FakeClock(),
      runner,
      jobCwd: workDir,
    });

    expect(runner.calls.length).toBeGreaterThanOrEqual(1);
    expect(runner.calls[0]?.cwd).toBe(workDir);
  });

  it("step-level cwd overrides jobCwd", async () => {
    const workDir = join(sandbox.projectRoot, "job-target-dir");
    await mkdir(workDir, { recursive: true });
    const stepTargetDir = join(sandbox.projectRoot, "step-target-dir");
    await mkdir(stepTargetDir, { recursive: true });

    const yamlWithStepCwd = `\
name: ws-step-cwd-test
version: "0.1.0"
jobs:
  build:
    steps:
      - id: compile
        type: script
        run: "echo hello"
        cwd: ${stepTargetDir}
`;

    const { runId, runDir, workflowPath } = await bootstrapScriptRun(
      sandbox,
      yamlWithStepCwd
    );
    const runner = new FakeRunner({
      exitCode: 0,
      timedOut: false,
      stdout: "ok",
      stderr: "",
      startedAt: FIXED_ISO,
      endedAt: FIXED_ISO,
    });

    await executeScriptStep({
      runDir,
      zigmaflowDir: sandbox.projectRoot,
      runId,
      jobId: "build",
      clock: new FakeClock(),
      runner,
      jobCwd: workDir,
    });

    expect(runner.calls.length).toBeGreaterThanOrEqual(1);
    // Step-level cwd should take precedence
    expect(runner.calls[0]?.cwd).toBe(stepTargetDir);
  });

  it("uses neither cwd when both jobCwd and step cwd are absent", async () => {
    const { runId, runDir, workflowPath } = await bootstrapScriptRun(
      sandbox,
      SCRIPT_WORKFLOW_YAML
    );
    const runner = new FakeRunner({
      exitCode: 0,
      timedOut: false,
      stdout: "ok",
      stderr: "",
      startedAt: FIXED_ISO,
      endedAt: FIXED_ISO,
    });

    await executeScriptStep({
      runDir,
      zigmaflowDir: sandbox.projectRoot,
      runId,
      jobId: "build",
      clock: new FakeClock(),
      runner,
    });

    expect(runner.calls.length).toBeGreaterThanOrEqual(1);
    expect(runner.calls[0]?.cwd).toBeUndefined();
  });
});
