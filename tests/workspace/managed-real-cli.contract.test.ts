/**
 * M3.5 real-CLI contract test — gated on ZIGMA_WORKSPACE_CLI_PATH.
 *
 * Drives the actual built zigma-workspace CLI through the bridge over spawn
 * boundaries: negotiation, prepare-run/prepare-job round-trips, idempotent
 * replay, and the fail-closed stale-CAS rejection when the Run HEAD advances
 * under a prepared attempt.
 *
 * Run with:
 *   ZIGMA_WORKSPACE_CLI_PATH=<zigma-workspace>/dist/cli/index.js \
 *   pnpm vitest run tests/workspace/managed-real-cli.contract.test.ts
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ValidationError } from "../../src/utils/index.js";
import { createZigmaWorkspaceCliProvider } from "../../src/workspace/zigma-workspace-cli-provider.js";
import type { WorkspaceHandle, WorkspaceProvider } from "../../src/workspace/index.js";

const CLI_PATH = process.env["ZIGMA_WORKSPACE_CLI_PATH"];
const SHA_PATTERN = /^[0-9a-f]{40}$/;

interface Fixture {
  root: string;
  sourceRepo: string;
  stateDir: string;
  provider: WorkspaceProvider;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "zigma-flow-real-cli-"));
  const sourceRepo = join(root, "source");
  mkdirSync(sourceRepo, { recursive: true });
  git(sourceRepo, "init", "-b", "main");
  git(sourceRepo, "config", "user.email", "bridge@example.test");
  git(sourceRepo, "config", "user.name", "Bridge contract test");
  writeFileSync(join(sourceRepo, "README.md"), "# source\n", "utf-8");
  git(sourceRepo, "add", ".");
  git(sourceRepo, "commit", "-m", "initial");

  const stateDir = join(root, "state");
  const provider = await createZigmaWorkspaceCliProvider({
    cliPath: CLI_PATH!,
    stateDir,
  });
  return { root, sourceRepo, stateDir, provider };
}

function commitFile(repo: string, name: string, content: string): string {
  // Workspaces are separate clones; ensure a committer identity exists there.
  git(repo, "config", "user.email", "bridge@example.test");
  git(repo, "config", "user.name", "Bridge contract test");
  writeFileSync(join(repo, name), content, "utf-8");
  git(repo, "add", name);
  git(repo, "commit", "-m", `add ${name}`);
  return git(repo, "rev-parse", "HEAD");
}

async function expectProviderError(promise: Promise<unknown>): Promise<ValidationError> {
  try {
    await promise;
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(ValidationError);
    return err as ValidationError;
  }
  throw new Error("expected the bridge to reject the provider failure");
}

describe.skipIf(CLI_PATH === undefined || CLI_PATH === "")(
  "managed real-CLI contract (ZIGMA_WORKSPACE_CLI_PATH)",
  () => {
    let fx: Fixture;

    beforeEach(async () => {
      fx = await makeFixture();
    }, 30_000);

    afterEach(() => {
      rmSync(fx.root, { recursive: true, force: true });
    });

    it("round-trips prepare-run and replays the same operation byte-identically", async () => {
      const input = {
        operationId: "run:real-1:create",
        runId: "real-1",
        projectRoot: fx.sourceRepo,
        definition: {
          provider: "zigma-workspace" as const,
          repository: ".",
          base: "main",
        },
      };

      const first: WorkspaceHandle = await fx.provider.prepareRun(input);
      expect(first.id).toMatch(/^ws_/);
      expect(isAbsolute(first.path)).toBe(true);
      expect(existsSync(first.path)).toBe(true);
      expect(first.branch).toBe("flow/real-1");
      expect(first.baseCommit).toMatch(SHA_PATTERN);
      expect(first.baseCommit).toBe(git(fx.sourceRepo, "rev-parse", "HEAD"));

      const replay: WorkspaceHandle = await fx.provider.prepareRun(input);
      expect(replay).toEqual(first);
    });

    it("prepares a job attempt from the exact Run HEAD and replays identically", async () => {
      const runHandle: WorkspaceHandle = await fx.provider.prepareRun({
        operationId: "run:real-2:create",
        runId: "real-2",
        projectRoot: fx.sourceRepo,
        definition: { provider: "zigma-workspace", repository: ".", base: "main" },
      });

      const newHead = commitFile(runHandle.path, "job-input.txt", "from the run workspace\n");

      const input = {
        operationId: "run:real-2:job:impl:attempt:1:create",
        runId: "real-2",
        jobId: "impl",
        attempt: 1,
        runWorkspace: runHandle,
        definition: { scope: "job" as const, mode: "writable" as const },
      };

      const first: WorkspaceHandle = await fx.provider.prepareJob(input);
      expect(first.id).toMatch(/^ws_/);
      expect(isAbsolute(first.path)).toBe(true);
      expect(existsSync(first.path)).toBe(true);
      expect(first.branch).toBe("job/real-2/impl/a1");
      expect(first.baseCommit).toBe(newHead);

      const replay: WorkspaceHandle = await fx.provider.prepareJob(input);
      expect(replay).toEqual(first);
    });

    it("fails closed with OPERATION_ID_CONFLICT when the Run HEAD advanced under a prepared attempt", async () => {
      const runHandle: WorkspaceHandle = await fx.provider.prepareRun({
        operationId: "run:real-3:create",
        runId: "real-3",
        projectRoot: fx.sourceRepo,
        definition: { provider: "zigma-workspace", repository: ".", base: "main" },
      });

      const input = {
        operationId: "run:real-3:job:impl:attempt:1:create",
        runId: "real-3",
        jobId: "impl",
        attempt: 1,
        runWorkspace: runHandle,
        definition: { scope: "job" as const },
      };
      await fx.provider.prepareJob(input);

      // A concurrent integration advances the Run HEAD; retrying the same
      // attempt now carries a different expected-head, so the provider's
      // idempotency guard rejects the diverged operation instead of silently
      // adopting the workspace based on the old head. (The HEAD-conflict code
      // is reserved for crash adoption, where no idempotency row exists.)
      commitFile(runHandle.path, "advance.txt", "concurrent integration\n");

      const err = await expectProviderError(fx.provider.prepareJob(input));
      expect(err.details).toMatchObject({ providerCode: "OPERATION_ID_CONFLICT" });
    });

    it("keeps provider state in the passed ZIGMA_WORKSPACE_STATE_DIR", async () => {
      await fx.provider.prepareRun({
        operationId: "run:real-4:create",
        runId: "real-4",
        projectRoot: fx.sourceRepo,
        definition: { provider: "zigma-workspace", repository: ".", base: "main" },
      });

      expect(existsSync(join(fx.stateDir, "registry.db"))).toBe(true);
    });

    // ── M4 lifecycle round-trip ─────────────────────────────────────────────

    it("runs the full M4 lifecycle: prepare → commit → integrate → publish → reconcile → cleanup", async () => {
      const runHandle: WorkspaceHandle = await fx.provider.prepareRun({
        operationId: "run:real-5:create",
        runId: "real-5",
        projectRoot: fx.sourceRepo,
        definition: { provider: "zigma-workspace", repository: ".", base: "main" },
      });
      const jobHandle: WorkspaceHandle = await fx.provider.prepareJob({
        operationId: "run:real-5:job:impl:attempt:1:create",
        runId: "real-5",
        jobId: "impl",
        attempt: 1,
        runWorkspace: runHandle,
        definition: { scope: "job", mode: "writable" },
      });

      writeFileSync(join(jobHandle.path, "feature.txt"), "implemented\n", "utf-8");
      const commit = await fx.provider.commitJob({
        operationId: "run:real-5:job:impl:attempt:1:commit",
        runId: "real-5",
        jobId: "impl",
        attempt: 1,
        jobWorkspace: jobHandle,
      });
      expect(commit.noOp).toBe(false);
      expect(commit.changedFiles).toContain("feature.txt");
      expect(commit.headCommit).toMatch(SHA_PATTERN);
      expect(commit.headCommit).not.toBe(commit.baseCommit);

      const integrate = await fx.provider.integrateJob({
        operationId: "run:real-5:job:impl:attempt:1:integrate",
        runId: "real-5",
        jobId: "impl",
        attempt: 1,
        jobWorkspace: jobHandle,
        runWorkspace: runHandle,
      });
      expect(integrate.status).toBe("merged");
      if (integrate.status === "merged") {
        expect(integrate.resultingCommit).toMatch(SHA_PATTERN);
        expect(git(runHandle.path, "rev-parse", "HEAD")).toBe(integrate.resultingCommit);
      }

      const publish = await fx.provider.publishRun({
        operationId: "run:real-5:publish",
        runId: "real-5",
        workspace: runHandle,
        strategy: "branch",
        targetRef: "flow/real-5",
      });
      expect(publish.resultingRef).toBe("refs/heads/flow/real-5");
      expect(publish.resultingCommit).toBe(integrate.status === "merged" ? integrate.resultingCommit : "");

      const reconcile = await fx.provider.reconcileRun({ workspace: runHandle });
      expect(reconcile.workspaceId).toBe(runHandle.id);
      expect(reconcile.directoryExists).toBe(true);
      expect(["complete", "incomplete", "orphaned", "inconsistent"]).toContain(
        reconcile.reconciledStatus,
      );

      const cleanup = await fx.provider.cleanupRun({
        operationId: "run:real-5:cleanup",
        workspace: runHandle,
      });
      expect(cleanup.status).toBe("CLEANED");
      expect(cleanup.removed).toBe(true);
      expect(existsSync(runHandle.path)).toBe(false);
    }, 60_000);

    it("surfaces an external-commit merge conflict as the typed conflicted result", async () => {
      const runHandle: WorkspaceHandle = await fx.provider.prepareRun({
        operationId: "run:real-6:create",
        runId: "real-6",
        projectRoot: fx.sourceRepo,
        definition: { provider: "zigma-workspace", repository: ".", base: "main" },
      });
      const jobHandle: WorkspaceHandle = await fx.provider.prepareJob({
        operationId: "run:real-6:job:impl:attempt:1:create",
        runId: "real-6",
        jobId: "impl",
        attempt: 1,
        runWorkspace: runHandle,
        definition: { scope: "job" },
      });

      writeFileSync(join(jobHandle.path, "README.md"), "# job version\n", "utf-8");
      const commit = await fx.provider.commitJob({
        operationId: "run:real-6:job:impl:attempt:1:commit",
        runId: "real-6",
        jobId: "impl",
        attempt: 1,
        jobWorkspace: jobHandle,
      });
      expect(commit.noOp).toBe(false);

      // An external writer (not the bridge) diverges the Run workspace. The
      // bridge resolves the CAS head at call time, so the merge itself — not
      // the CAS — must surface the conflict.
      const externalHead = commitFile(runHandle.path, "README.md", "# external version\n");

      const integrate = await fx.provider.integrateJob({
        operationId: "run:real-6:job:impl:attempt:1:integrate",
        runId: "real-6",
        jobId: "impl",
        attempt: 1,
        jobWorkspace: jobHandle,
        runWorkspace: runHandle,
      });
      expect(integrate.status).toBe("conflicted");
      if (integrate.status === "conflicted") {
        expect(integrate.conflictFiles).toContain("README.md");
        expect(integrate.jobCommit).toBe(commit.headCommit);
        expect(integrate.runHead).toBe(externalHead);
      }
    }, 60_000);

    it("passes retention flags through prepare-run and echoes them on the handle", async () => {
      const handle: WorkspaceHandle = await fx.provider.prepareRun({
        operationId: "run:real-7:create",
        runId: "real-7",
        projectRoot: fx.sourceRepo,
        definition: {
          provider: "zigma-workspace",
          repository: ".",
          base: "main",
          retention: { success: "cleanup", failure: "retain", blocked: "retain" },
        },
      });

      expect(handle.retention).toEqual({
        success: "cleanup",
        failure: "retain",
        blocked: "retain",
      });
    }, 30_000);
  },
);
