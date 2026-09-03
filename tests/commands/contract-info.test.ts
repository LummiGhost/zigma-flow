import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import { getFlowContractInfo } from "../../src/commands/contract-info.js";

interface CapturedRun {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  error: unknown;
}

async function runMain(args: readonly string[]): Promise<CapturedRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.map(String).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.map(String).join(" "));
  });
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  let error: unknown;
  try {
    await main(["node", "zigma-flow", ...args]);
  } catch (caught: unknown) {
    error = caught;
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = previousExitCode;
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode, error };
}

describe("contract-info provider handshake", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-contract-info-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("prints one versioned JSON envelope and does not initialize project state", async () => {
    // Include a directory that would be touched by normal run commands. The
    // handshake must not inspect or mutate it.
    await mkdir(join(tempDir, "existing"));
    await writeFile(join(tempDir, "existing", "marker"), "keep", "utf8");
    const before = await readdir(tempDir, { recursive: true });

    const result = await runMain(["contract-info", "--json"]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual(getFlowContractInfo());
    expect(await readdir(tempDir, { recursive: true })).toEqual(before);
  });

  it("requires --json and rejects unknown options without side effects", async () => {
    const before = await readdir(tempDir, { recursive: true });
    const missingJson = await runMain(["contract-info"]);
    const unknownOption = await runMain(["contract-info", "--unknown"]);

    expect(missingJson.exitCode).not.toBe(0);
    expect(unknownOption.exitCode).not.toBe(0);
    expect(unknownOption.stdout).toBe("");
    expect(await readdir(tempDir, { recursive: true })).toEqual(before);
  });
});
