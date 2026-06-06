import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
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
    // Minimum set per PRD §16 + FR-001.
    for (const required of ["workflows", "skills", "runs", "config.json", "skill-lock.json"]) {
      expect(entries).toContain(required);
    }
  });
});
