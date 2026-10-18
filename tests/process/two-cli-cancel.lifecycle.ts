/**
 * Real-process M1 acceptance: one CLI owns `invoke`, another sends `abort`.
 *
 * This file intentionally uses a `.lifecycle.ts` suffix so it is run only by
 * `pnpm run test:lifecycle`, which builds the CLI immediately beforehand.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cliPath = join(repositoryRoot, "dist", "cli.js");

it("returns nonzero process status for abort JSON errors including failed quiescence", async () => {
  const root = await mkdtemp(join(tmpdir(), "zigma-abort-error-"));
  const runId = "20261018-0001";
  const invocationId = "test-invocation";
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.split("\n")[0]!);
      socket.end(JSON.stringify({
        version: 1, type: "cancel-ack", requestId: request.requestId,
        runId, invocationId, status: "cancelled", quiescent: false,
        cleanupErrors: ["synthetic callback delivery failure"],
      }) + "\n");
    });
  });
  try {
    const missing = runCli(root, ["abort", "--run", runId, "--json"]);
    const missingExit = await missing.exited;
    expect(parseSingleJson(missing.stdout)).toMatchObject({command: "abort", status: "error"});
    expect(missingExit).toEqual({code: 1, signal: null});

    const control = join(root, ".zigma-flow", "runs", runId, ".control");
    await mkdir(control, {recursive: true});
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test owner port");
    await writeFile(join(control, "invoke-owner.json"), JSON.stringify({
      version: 1, phase: "active", runId, invocationId, pid: process.pid,
      host: "127.0.0.1", port: address.port, token: "synthetic-test-token",
      startedAt: new Date().toISOString(),
    }));
    const failed = runCli(root, ["abort", "--run", runId, "--json"]);
    const failedExit = await failed.exited;
    expect(parseSingleJson(failed.stdout)).toMatchObject({
      command: "abort", status: "error", error: {code: "INTERNAL_ERROR"},
    });
    expect(failedExit).toEqual({code: 1, signal: null});
  } finally {
    if (server.listening) await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await rm(root, {recursive: true, force: true});
  }
}, 20_000);

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


it("returns nonzero process status for failed invoke and legacy run-all", async () => {
  const root=await mkdtemp(join(tmpdir(),"zigma-cli-failure-"));
  try {
    const workflow=join(root,"fail.yml");
    await writeFile(workflow,`name: cli-failure
version: "1"
jobs:
  fails:
    steps:
      - id: fail
        type: script
        run: node -e "process.exit(7)"
`);
    for (const command of ["invoke","run-all"]) {
      const child=runCli(root,[command,workflow,"--task","fail",...(command === "invoke" ? ["--json"] : [])]);
      expect(await child.exited).toEqual({code:1,signal:null});
      if(command === "invoke")expect(parseSingleJson(child.stdout)).toMatchObject({status:"failed",exitCode:1});
    }
    await writeFile(workflow,"invalid: workflow");
    const invalid=runCli(root,["invoke",workflow,"--task","fail","--json"]);
    expect(await invalid.exited).toEqual({code:1,signal:null});
    expect(parseSingleJson(invalid.stdout)).toMatchObject({runId:"(error)",status:"failed",exitCode:1});
  } finally {await rm(root,{recursive:true,force:true});}
},20000);
