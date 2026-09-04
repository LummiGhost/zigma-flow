/**
 * Real-process M1 acceptance: one CLI owns `invoke`, another sends `abort`.
 *
 * This file intentionally uses a `.lifecycle.ts` suffix so it is run only by
 * `pnpm run test:lifecycle`, which builds the CLI immediately beforehand.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cliPath = join(repositoryRoot, "dist", "cli.js");

interface SpawnedCommand {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function runCli(cwd: string, args: string[]): SpawnedCommand {
  const child = spawn(process.execPath, [cliPath, "--cwd", cwd, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    exited,
  };
}

async function waitForActiveOwner(projectRoot: string): Promise<{ runId: string; ownerPath: string }> {
  const runsDir = join(projectRoot, ".zigma-flow", "runs");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let entries: string[] = [];
    try {
      entries = await readdir(runsDir);
    } catch {
      // The invoke process has not created the run directory yet.
    }
    for (const runId of entries) {
      const ownerPath = join(runsDir, runId, ".control", "invoke-owner.json");
      try {
        const owner = JSON.parse(await readFile(ownerPath, "utf-8")) as { phase?: unknown };
        if (owner.phase === "active") return { runId, ownerPath };
      } catch {
        // The owner record is atomically replaced; retry the short poll.
      }
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 25));
  }
  throw new Error("Timed out waiting for the invoke CLI to publish its active owner record");
}

function parseSingleJson(output: string): Record<string, unknown> {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe("two-CLI cancellation", () => {
  let projectRoot: string | undefined;
  let invoke: SpawnedCommand | undefined;

  afterEach(async () => {
    if (invoke?.child.exitCode === null && !invoke.child.killed) {
      invoke.child.kill();
      await invoke.exited.catch(() => undefined);
    }
    if (projectRoot !== undefined) {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("makes abort wait for invoke child/writer quiescence and returns a single JSON acknowledgement", async () => {
    await access(cliPath, constants.R_OK);
    projectRoot = await mkdtemp(join(tmpdir(), "zigma-two-cli-cancel-"));
    const nodePath = process.execPath.replace(/\\/g, "/");
    const markerPath = join(projectRoot, "late-marker.txt");
    const workflowPath = join(projectRoot, "cancel.yml");

    await writeFile(join(projectRoot, "blocker.mjs"), `\
import { writeFile } from "node:fs/promises";
setTimeout(() => { void writeFile(process.argv[2], "late"); }, 5_000);
setInterval(() => {}, 1_000);
`, "utf-8");
    await writeFile(workflowPath, `\
name: two-cli-cancel
version: "1"
jobs:
  blocker:
    workspace:
      directory: .
    steps:
      - id: wait
        type: script
        run: '"${nodePath}" blocker.mjs late-marker.txt'
`, "utf-8");

    invoke = runCli(projectRoot, ["invoke", workflowPath, "--task", "wait", "--json"]);
    const { runId, ownerPath } = await waitForActiveOwner(projectRoot);

    const abort = runCli(projectRoot, [
      "abort", "--run", runId, "--reason", "two-cli lifecycle regression", "--json",
    ]);
    const abortExit = await abort.exited;
    expect(abortExit).toEqual({ code: 0, signal: null });
    expect(parseSingleJson(abort.stdout)).toMatchObject({
      contractVersion: 1,
      command: "abort",
      status: "success",
      runId,
      data: expect.objectContaining({ quiescent: true }),
    });

    const invokeExit = await invoke.exited;
    expect(invokeExit).toEqual({ code: 1, signal: null });
    expect(parseSingleJson(invoke.stdout)).toMatchObject({
      contractVersion: 1,
      runId,
      status: "cancelled",
      exitCode: 1,
    });

    const owner = JSON.parse(await readFile(ownerPath, "utf-8")) as {
      phase?: unknown;
      quiescent?: unknown;
    };
    expect(owner).toEqual(expect.objectContaining({ phase: "quiescent", quiescent: true }));

    await new Promise((resolveTimer) => setTimeout(resolveTimer, 150));
    await expect(access(markerPath, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);
});
