/**
 * Dist CLI contract smoke for ISSUE #311.
 *
 * Kept in the lifecycle gate so the Windows build verifies both a live
 * cross-process cancellation path and the durable evidence a restart
 * reconciler consumes afterwards.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, "dist", "cli.js");
if (!existsSync(cliPath)) throw new Error("Built CLI not found: run pnpm build first.");

const projectRoot = mkdtempSync(join(tmpdir(), "zigma-flow-reconcile-blackbox-"));
const runId = "provider-reconciliation-311";
const runDir = join(projectRoot, ".zigma-flow", "runs", runId);
const controlPath = join(runDir, ".control", "invoke-owner.json");

try {
  mkdirSync(dirname(controlPath), { recursive: true });
  writeFileSync(join(runDir, "state.json"), JSON.stringify({
    run_id: runId,
    workflow: "reconcile",
    task: "black-box provider reconciliation",
    created_at: "2026-09-05T00:00:00.000Z",
    status: "cancelled",
    last_event_id: "evt-001",
    jobs: {},
  }), "utf8");
  writeFileSync(join(runDir, "caller-context.json"), JSON.stringify({
    frozenAt: "2026-09-05T00:00:00.000Z",
    runId,
    callerContext: {
      contractVersion: 1,
      actor: { type: "service", id: "zigma-core" },
      capabilities: ["task:start"],
      constraints: { repositoryIds: [], workflowRefs: [], toolNames: [], branchPatterns: [] },
      source: { kind: "api", metadata: {} },
      taskId: "task-blackbox-311",
      flowRunId: "core-run-blackbox-311",
      projectId: "project-blackbox-311",
      permissionSnapshotId: "permission-blackbox-311",
      integrityHash: "sha256:blackbox",
      operationId: "operation-blackbox-311",
      callbackCorrelationId: "callback-blackbox-311",
    },
  }), "utf8");
  writeFileSync(controlPath, JSON.stringify({
    version: 1,
    phase: "quiescent",
    runId,
    invocationId: "invocation-blackbox-311",
    pid: process.pid,
    host: "127.0.0.1",
    port: 12345,
    token: "must-not-escape",
    startedAt: "2026-09-05T00:00:00.000Z",
    finishedAt: "2026-09-05T00:01:00.000Z",
    status: "cancelled",
    quiescent: true,
    cleanupErrors: [],
  }), "utf8");
  const controlBefore = readFileSync(controlPath, "utf8");

  const stdout = execFileSync(process.execPath, [
    cliPath, "--cwd", projectRoot, "inspect", "--run", runId, "--json",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`inspect must emit exactly one JSON document, got: ${JSON.stringify(stdout)}`);
  }
  const reconciliation = result?.data?.reconciliation;
  if (
    result.contractVersion !== 1 || result.command !== "inspect" || result.status !== "success" ||
    result.runId !== runId || reconciliation?.contractVersion !== 1 ||
    reconciliation.externalRunId !== runId || reconciliation.lifecycle?.terminal !== true ||
    reconciliation.invocation?.state !== "quiescent" || reconciliation.invocation?.quiescent !== true ||
    reconciliation.callerContext?.state !== "accepted" ||
    reconciliation.callerContext?.operationId !== "operation-blackbox-311" ||
    reconciliation.callerContext?.callbackCorrelationId !== "callback-blackbox-311"
  ) {
    throw new Error(`Unexpected provider reconciliation envelope: ${stdout}`);
  }
  if (stdout.includes("must-not-escape") || stdout.includes('"port"')) {
    throw new Error("inspect exposed invocation-control credentials");
  }
  if (readFileSync(controlPath, "utf8") !== controlBefore) {
    throw new Error("inspect mutated provider control evidence");
  }

  let missing;
  try {
    execFileSync(process.execPath, [
      cliPath, "--cwd", projectRoot, "inspect", "--run", "missing-311", "--json",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    throw new Error("missing run unexpectedly returned zero");
  } catch (error) {
    const captured = error;
    const missingStdout = captured.stdout?.toString("utf8") ?? "";
    missing = JSON.parse(missingStdout.trim());
  }
  if (missing?.status !== "error" || missing?.error?.code !== "RUN_NOT_FOUND") {
    throw new Error(`Missing run was not classified: ${JSON.stringify(missing)}`);
  }
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
}

console.log("provider reconciliation black-box smoke passed");
