import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import { getPackageInfo } from "../../src/utils/index.js";

/**
 * CLI smoke tests for WF-P1-INIT (Step 1: cases-and-tests).
 *
 * These tests describe the expected behavior of the commander-based CLI built
 * in Step 2. They invoke `main(argv)` directly (no subprocess; `execa` is not
 * in the dependency set) and capture stdout/stderr through `vi.spyOn`.
 *
 * Reference:
 *   - docs/prd.md §17 (CLI commands), §19 (tech stack)
 *   - docs/mvp-contracts.md §7 (error → exit code mapping)
 *   - docs/phases/p1-cli-init/workflows/wf-p1-init/01-cases-and-tests.md
 */

interface CapturedRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly error: unknown;
}

/**
 * Invoke `main(argv)` while capturing stdout/stderr writes and process.exitCode.
 * `argv` is prefixed with two placeholder entries so the CLI sees the same
 * shape as `process.argv` (node binary + script path + args...).
 */
async function runMain(args: ReadonlyArray<string>): Promise<CapturedRun> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdoutChunks.push(parts.map(String).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderrChunks.push(parts.map(String).join(" "));
  });

  const previousExitCode = process.exitCode;
  process.exitCode = 0;

  let caught: unknown = undefined;
  try {
    await main(["node", "zigma-flow", ...args]);
  } catch (error: unknown) {
    caught = error;
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  const observedExitCode = process.exitCode;
  process.exitCode = previousExitCode;

  return {
    stdout: stdoutChunks.join("\n"),
    stderr: stderrChunks.join("\n"),
    exitCode: typeof observedExitCode === "number" ? observedExitCode : undefined,
    error: caught
  };
}

describe("zigma-flow CLI entry", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-cli-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("prints help with init command listed (T-CLI-1 / UC-CLI-1)", async () => {
    const result = await runMain(["--help"]);

    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout.toLowerCase()).toContain("usage");
    // The `init` subcommand must be advertised even before later commands ship.
    expect(result.stdout).toMatch(/\binit\b/);
    expect(result.exitCode ?? 0).toBe(0);
  });

  it("prints version matching package info (T-CLI-2 / UC-CLI-2)", async () => {
    const result = await runMain(["--version"]);
    const expected = getPackageInfo().version;

    expect(result.stdout.trim()).toBe(expected);
    expect(result.exitCode ?? 0).toBe(0);
  });

  it("exits non-zero on unknown command (T-CLI-3 / UC-CLI-3)", async () => {
    const result = await runMain(["no-such-command"]);

    // Either process.exitCode is non-zero, or main rejects with a typed error.
    const failureSignaled =
      (typeof result.exitCode === "number" && result.exitCode !== 0) ||
      result.error !== undefined;

    expect(failureSignaled).toBe(true);
  });

  it("maps typed errors to non-zero exit code (T-CLI-4 / UC-CLI-4)", async () => {
    // When Step 2 wires command handlers, any thrown ZigmaFlowError (e.g.
    // UserInputError thrown by an `init --bogus` flag) must set process.exitCode
    // to the error's configured exitCode per mvp-contracts §7.
    //
    // We probe this by invoking init with an unsupported flag. The CLI is
    // expected to surface a UserInputError → non-zero exit code.
    const result = await runMain(["init", "--definitely-not-a-flag"]);

    const failureSignaled =
      (typeof result.exitCode === "number" && result.exitCode !== 0) ||
      result.error !== undefined;
    expect(failureSignaled).toBe(true);
  });

  it("init command creates .zigma-flow under chosen cwd (T-CLI-5 / UC-CMD-1)", async () => {
    const result = await runMain(["init"]);

    expect(result.exitCode ?? 0).toBe(0);
    const dotZigma = join(tempDir, ".zigma-flow");
    const stats = await stat(dotZigma);
    expect(stats.isDirectory()).toBe(true);

    const entries = await readdir(dotZigma);
    // Minimum set per PRD §16 + FR-001. skill-lock.json no longer generated (v0.6 deprecation).
    for (const required of ["workflows", "skills", "runs", "config.json"]) {
      expect(entries).toContain(required);
    }
  });

  it("invoke accepts CallerContextV1 through the real CLI command and freezes it", async () => {
    const zigmaDir = join(tempDir, ".zigma-flow");
    const runsDir = join(zigmaDir, "runs");
    const workflowPath = join(tempDir, "context-workflow.yml");
    const contextPath = join(tempDir, "caller-context-v1.json");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(zigmaDir, "config.json"), JSON.stringify({
      tool_version: "0.1.0",
      active_run: null,
      agent: { backend: "claude-code", backends: { "claude-code": { command: "claude" } } },
    }), "utf-8");
    await writeFile(join(zigmaDir, "skill-lock.json"), JSON.stringify({ skills: {} }), "utf-8");
    await writeFile(workflowPath, [
      "name: context-cli-smoke",
      "version: \"0.1.0\"",
      "jobs:",
      "  validate:",
      "    steps:",
      "      - id: context",
      "        type: script",
      "        run: echo context-ok",
      "",
    ].join("\n"), "utf-8");
    await writeFile(contextPath, JSON.stringify({
      contractVersion: 1,
      actor: { type: "service", id: "zigma-core" },
      capabilities: ["task:start", "workflow:invoke"],
      constraints: { repositoryIds: [], workflowRefs: [], toolNames: [], branchPatterns: [] },
      source: { kind: "api", metadata: {} },
      taskId: "task-cli-1",
      flowRunId: "flow-run-cli-1",
      projectId: "project-cli-1",
      permissionSnapshotId: "snapshot-cli-1",
      integrityHash: "sha256:cli",
    }), "utf-8");

    const result = await runMain([
      "--cwd", tempDir,
      "invoke", workflowPath,
      "--task", "exercise context command",
      "--context-file", contextPath,
      "--json",
    ]);

    expect(result.exitCode ?? 0).toBe(0);
    const [runId] = await readdir(runsDir);
    expect(runId).toBeTruthy();
    const snapshot = JSON.parse(await readFile(join(runsDir, runId!, "caller-context.json"), "utf-8")) as {
      callerContext: { projectId: string; flowRunId: string };
    };
    expect(snapshot.callerContext).toMatchObject({ projectId: "project-cli-1", flowRunId: "flow-run-cli-1" });
  });
});

describe("--cwd global option", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-cwd-"));
    // Do NOT chdir — we want to verify --cwd overrides the current directory.
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uses --cwd as the working directory when provided with a valid path (T-CWD-1)", async () => {
    const result = await runMain(["--cwd", tempDir, "init"]);

    expect(result.exitCode ?? 0).toBe(0);
    const dotZigma = join(tempDir, ".zigma-flow");
    const stats = await stat(dotZigma);
    expect(stats.isDirectory()).toBe(true);
  });

  it("resolves relative --cwd paths against process.cwd() (T-CWD-2)", async () => {
    const subDir = join(tempDir, "subdir");
    await mkdir(subDir, { recursive: true });

    // Switch to tempDir so we can use a relative path
    process.chdir(tempDir);
    const result = await runMain(["--cwd", "subdir", "init"]);

    expect(result.exitCode ?? 0).toBe(0);
    const dotZigma = join(subDir, ".zigma-flow");
    const stats = await stat(dotZigma);
    expect(stats.isDirectory()).toBe(true);
  });

  it("throws UserInputError when --cwd path does not exist (T-CWD-3)", async () => {
    const nonexistent = join(tempDir, "does-not-exist");
    const result = await runMain(["--cwd", nonexistent, "init"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("does not exist");
  });

  it("throws UserInputError when --cwd path is a file (T-CWD-4)", async () => {
    const filePath = join(tempDir, "not-a-dir.txt");
    await writeFile(filePath, "hello", "utf-8");

    const result = await runMain(["--cwd", filePath, "init"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("must be a directory");
    expect(result.stderr).toContain("got a file");
  });

  it("throws UserInputError when --cwd has no value (T-CWD-5)", async () => {
    // --cwd without a value should produce an error
    const result = await runMain(["--cwd", "--help"]);
    // Either it exits non-zero or produces error output because
    // resolveCwdOption interprets the next arg (--help) as the path
    // which doesn't exist.
    // Actually --cwd --help would make "--help" the value. Let's use a
    // pattern where --cwd is the last arg with no value.
    const result2 = await runMain(["--cwd"]);

    expect(result2.exitCode).toBe(2);
    expect(result2.stderr).toContain("requires");
  });

  it("shows --cwd option in help text (T-CWD-6)", async () => {
    // Switch to tempDir so help output doesn't depend on the real project
    process.chdir(tempDir);
    const result = await runMain(["--help"]);

    expect(result.stdout).toContain("--cwd");
    expect(result.stdout).toContain("Working directory");
  });

  it("defaults to process.cwd() when --cwd is omitted (T-CWD-7)", async () => {
    process.chdir(tempDir);
    const result = await runMain(["init"]);

    expect(result.exitCode ?? 0).toBe(0);
    // .zigma-flow should be created in tempDir (current cwd)
    const dotZigma = join(tempDir, ".zigma-flow");
    const stats = await stat(dotZigma);
    expect(stats.isDirectory()).toBe(true);
  });

  it("uses --cwd even when current working directory differs (T-CWD-8)", async () => {
    // Create a separate target directory
    const targetDir = join(tempDir, "target");
    await mkdir(targetDir, { recursive: true });

    // Change cwd to tempDir, but use --cwd to point to targetDir
    process.chdir(tempDir);
    const result = await runMain(["--cwd", targetDir, "init"]);

    expect(result.exitCode ?? 0).toBe(0);
    // .zigma-flow should be in targetDir, NOT in tempDir
    const targetDotZigma = join(targetDir, ".zigma-flow");
    const targetStats = await stat(targetDotZigma);
    expect(targetStats.isDirectory()).toBe(true);

    // Verify tempDir itself does NOT have .zigma-flow
    const tempDotZigma = join(tempDir, ".zigma-flow");
    await expect(stat(tempDotZigma)).rejects.toBeDefined();
  });

  it("throws UserInputError when --cwd= has an empty value (T-CWD-9)", async () => {
    // --cwd= (equals sign with empty value) must not silently resolve to
    // process.cwd(). It should produce a clear error.
    const result = await runMain(["--cwd=", "init"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("empty");
  });

  it("wires rDir() and zfDir() correctly with --cwd for list-runs command (T-CWD-10)", async () => {
    // Create a project directory with .zigma-flow/runs/ structure
    const projectDir = join(tempDir, "myproject");
    await mkdir(projectDir, { recursive: true });
    const runsDir = join(projectDir, ".zigma-flow", "runs");
    await mkdir(runsDir, { recursive: true });

    // Create a mock run entry (just a directory; list-runs will mark it
    // [unreadable] because there is no state.json).
    const runDir = join(runsDir, "test-run-001");
    await mkdir(runDir);

    process.chdir(tempDir);
    const result = await runMain(["--cwd", projectDir, "list-runs"]);

    expect(result.exitCode ?? 0).toBe(0);
    // The list-runs command should find the run entry under --cwd, not under
    // the current working directory.
    expect(result.stdout).toContain("test-run-001");
  });
});
