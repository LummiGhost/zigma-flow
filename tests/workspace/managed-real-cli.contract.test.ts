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
  },
);
