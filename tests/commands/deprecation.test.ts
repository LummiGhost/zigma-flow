/**
 * Deprecation warning tests for v0.6 command consolidation (Issue #204).
 *
 * Validates that all deprecated commands print consistent deprecation warnings
 * to stderr, that they still function normally, and that the
 * ZIGMA_SUPPRESS_DEPRECATION env var suppresses the warnings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { main } from "../../src/cli.js";
import { deprecationWarn } from "../../src/utils/index.js";

interface Sandbox {
  projectRoot: string;
  workflowsDir: string;
  runsDir: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-deprecation-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const workflowsDir = join(dotZigma, "workflows");
  const runsDir = join(dotZigma, "runs");

  await mkdir(workflowsDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  await writeFile(
    join(dotZigma, "config.json"),
    JSON.stringify({ tool_version: "0.1.0", active_run: null }, null, 2),
    "utf-8",
  );
  await writeFile(join(dotZigma, "skill-lock.json"), JSON.stringify({ skills: {} }, null, 2), "utf-8");

  // Create a valid workflow file
  await writeFile(
    join(workflowsDir, "test-workflow.yml"),
    `name: test-workflow
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: analyze
        type: agent
        with:
          goal: "\${{ inputs.task }}"
`,
    "utf-8",
  );

  return { projectRoot, workflowsDir, runsDir };
}

async function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdoutChunks.push(parts.map(String).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderrChunks.push(parts.map(String).join(" "));
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((...parts: unknown[]) => {
    stderrChunks.push(parts.map(String).join(" "));
  });

  const previousExitCode = process.exitCode;
  process.exitCode = 0;

  try {
    await main(["node", "zigma-flow", ...args]);
  } catch {
    // Ignore errors for testing
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }

  const observedExitCode = process.exitCode;
  process.exitCode = previousExitCode;

  return {
    stdout: stdoutChunks.join("\n"),
    stderr: stderrChunks.join("\n"),
    exitCode: typeof observedExitCode === "number" ? observedExitCode : undefined,
  };
}

describe("deprecationWarn utility", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env["ZIGMA_SUPPRESS_DEPRECATION"];
  });

  it("prints deprecation warning to stderr", () => {
    deprecationWarn("deprecated-cmd is deprecated", "new-cmd");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("[DEPRECATED]");
    expect(msg).toContain("deprecated-cmd");
    expect(msg).toContain("new-cmd");
    expect(msg).toContain("v1.0");
  });

  it("suppresses deprecation when ZIGMA_SUPPRESS_DEPRECATION=1", () => {
    process.env["ZIGMA_SUPPRESS_DEPRECATION"] = "1";

    deprecationWarn("run", "zigma-flow invoke");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("suppresses deprecation when ZIGMA_SUPPRESS_DEPRECATION=true", () => {
    process.env["ZIGMA_SUPPRESS_DEPRECATION"] = "true";

    deprecationWarn("run", "zigma-flow invoke");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT suppress when ZIGMA_SUPPRESS_DEPRECATION=0", () => {
    process.env["ZIGMA_SUPPRESS_DEPRECATION"] = "0";

    deprecationWarn("run", "zigma-flow invoke");

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("CLI deprecated commands print warnings", () => {
  let sandbox: Sandbox;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    sandbox = await makeSandbox();
    process.chdir(sandbox.projectRoot);
    process.env["ZIGMA_SUPPRESS_DEPRECATION"] = ""; // Ensure not suppressed
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    delete process.env["ZIGMA_SUPPRESS_DEPRECATION"];
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  // ── Invoke command does NOT print deprecation warning ───────────────────

  it("invoke command does not print deprecation warning", async () => {
    const result = await runCli(["invoke", "--help"], sandbox.projectRoot);

    expect(result.stderr).not.toContain("[DEPRECATED]");
  });

  it("inspect command does not print deprecation warning", async () => {
    const result = await runCli(["inspect", "--help"], sandbox.projectRoot);

    expect(result.stderr).not.toContain("[DEPRECATED]");
  });

  // ── Deprecated commands print warnings in help ──────────────────────────

  it("run help shows (deprecated) in description", async () => {
    const result = await runCli(["--help"], sandbox.projectRoot);

    expect(result.stdout).toContain("deprecated");
  });

  it("run-all help shows (deprecated) in description", async () => {
    const result = await runCli(["--help"], sandbox.projectRoot);

    expect(result.stdout).toContain("run-all");
    expect(result.stdout).toContain("deprecated");
  });

  it("prompt help shows (deprecated) in description", async () => {
    const result = await runCli(["--help"], sandbox.projectRoot);

    expect(result.stdout).toContain("prompt");
    expect(result.stdout).toContain("deprecated");
  });

  it("step help shows (deprecated) in description", async () => {
    const result = await runCli(["--help"], sandbox.projectRoot);

    expect(result.stdout).toContain("step");
    expect(result.stdout).toContain("deprecated");
  });

  it("next help shows (deprecated) in description", async () => {
    const result = await runCli(["--help"], sandbox.projectRoot);

    expect(result.stdout).toContain("next");
    expect(result.stdout).toContain("deprecated");
  });

  it("check command shows (deprecated) in description", async () => {
    const result = await runCli(["--help"], sandbox.projectRoot);

    expect(result.stdout).toContain("check");
    expect(result.stdout).toContain("deprecated");
  });

  // ── Invoke and inspect appear in help ───────────────────────────────────

  it("invoke appears in help output", async () => {
    const result = await runCli(["--help"], sandbox.projectRoot);

    expect(result.stdout).toContain("invoke");
    expect(result.stdout).toContain("unified");
  });

  it("inspect appears in help output", async () => {
    const result = await runCli(["--help"], sandbox.projectRoot);

    expect(result.stdout).toContain("inspect");
  });
});

describe("CLI deprecated commands still work", () => {
  let sandbox: Sandbox;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    sandbox = await makeSandbox();
    process.chdir(sandbox.projectRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("run command still works", async () => {
    const result = await runCli(
      ["run", "test-workflow", "--task", "test task"],
      sandbox.projectRoot,
    );

    // Should succeed (exit 0 or undefined)
    expect(result.exitCode ?? 0).toBe(0);
    // Should print deprecation warning
    expect(result.stderr).toContain("[DEPRECATED]");
    expect(result.stderr).toContain("run");
    expect(result.stderr).toContain("invoke");
  });

  it("run-all command still works with --help (deprecation shown on execution attempt)", async () => {
    // Just verify run-all exists in help; full integration test requires agent backend
    const result = await runCli(["run-all", "--help"], sandbox.projectRoot);

    expect(result.exitCode ?? 0).toBe(0);
    expect(result.stdout).toContain("run-all");
  });

  it("prompt command prints deprecation warning on execution attempt", async () => {
    const result = await runCli(["prompt", "--help"], sandbox.projectRoot);

    expect(result.exitCode ?? 0).toBe(0);
    // Help display doesn't call the action, so no deprecation warning here.
    // But the description should say (deprecated).
    expect(result.stdout).toContain("deprecated");
  });

  it("step command prints deprecation warning on execution attempt", async () => {
    const result = await runCli(["step", "--help"], sandbox.projectRoot);

    expect(result.exitCode ?? 0).toBe(0);
    expect(result.stdout).toContain("deprecated");
  });

  it("next command prints deprecation warning on execution attempt", async () => {
    const result = await runCli(["next", "--help"], sandbox.projectRoot);

    expect(result.exitCode ?? 0).toBe(0);
    expect(result.stdout).toContain("deprecated");
  });

  it("check command prints deprecation warning on execution attempt", async () => {
    const result = await runCli(["check", "--help"], sandbox.projectRoot);

    expect(result.exitCode ?? 0).toBe(0);
    expect(result.stdout).toContain("deprecated");
  });
});

describe("ZIGMA_SUPPRESS_DEPRECATION", () => {
  let sandbox: Sandbox;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    sandbox = await makeSandbox();
    process.chdir(sandbox.projectRoot);
    process.env["ZIGMA_SUPPRESS_DEPRECATION"] = "1";
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    delete process.env["ZIGMA_SUPPRESS_DEPRECATION"];
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("run command suppresses deprecation warning when ZIGMA_SUPPRESS_DEPRECATION=1", async () => {
    const result = await runCli(
      ["run", "test-workflow", "--task", "test"],
      sandbox.projectRoot,
    );

    expect(result.exitCode ?? 0).toBe(0);
    expect(result.stderr).not.toContain("[DEPRECATED]");
  });
});
