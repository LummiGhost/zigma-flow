/**
 * `SimpleGitInspector` integration tests for WF-P7-GITCHECK (Step 1 —
 * Cases and Tests).
 *
 * These tests exercise the `simple-git`-backed adapter against a real
 * temp git repository. NO mocking of `simple-git`; each test creates a
 * fresh temp directory under `os.tmpdir()`, runs `git init` + identity
 * config via `node:child_process`, mutates the working tree, and then
 * asserts the inspector's observations.
 *
 * Covers:
 *   - T-GC-7 (a): `SimpleGitInspector` reports modified files and
 *                 `diffExists === true` for a dirty temp repo (file
 *                 created + staged + modified on disk).
 *   - T-GC-7 (b): `SimpleGitInspector` reports `changedFiles === []`
 *                 and `diffExists === false` for a freshly-committed
 *                 clean repo.
 *
 * Reference:
 *   - docs/phases/p7-check-step/workflows/wf-p7-gitcheck/01-cases-and-tests.md
 *   - docs/phases/p7-check-step/02-development-plan.md §4 WF-P7-GITCHECK
 *   - docs/prd.md FR-008
 *   - docs/architecture.md §9.4, §13 phase 7, §16
 *   - docs/mvp-contracts.md §2.8
 *
 * Red-phase note: `src/git/index.ts` does not exist yet; these tests
 * fail at module resolution. `simple-git` is also not yet a
 * dependency. After WF-P7-GITCHECK Step 2 ships `src/git/index.ts` and
 * adds `simple-git` to `package.json`, both T-GC-7 cases should turn
 * green.
 *
 * Port contract under test (declared in `src/git/index.ts` in Step 2):
 *
 *   interface GitInspector {
 *     changedFiles(cwd: string): Promise<string[]>;
 *     diffExists(cwd: string): Promise<boolean>;
 *   }
 *
 *   class SimpleGitInspector implements GitInspector { ... }
 *
 *   `changedFiles()` returns the union of staged + unstaged + untracked
 *   files (deduped). `diffExists()` is true iff `changedFiles()` is
 *   non-empty.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { SimpleGitInspector } from "../../src/git/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TempRepo {
  /** Absolute path to the temp directory used as the git working tree. */
  dir: string;
}

/**
 * Create a fresh temp directory, `git init` it, and configure a local
 * identity so subsequent `git commit` invocations do not depend on the
 * host's global git config (which CI machines often lack).
 */
async function makeTempRepo(): Promise<TempRepo> {
  const dir = join(tmpdir(), `zigma-git-inspector-${randomUUID()}`);
  await mkdir(dir, { recursive: true });

  // `git init` — the repo is created with whatever default branch the
  // host's git uses (master or main); the test does not care which.
  execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@zigma.local"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Zigma Test"], {
    cwd: dir,
    stdio: "ignore",
  });
  // Suppress hook execution so any host-installed templates do not
  // interfere with the test. Point `core.hooksPath` at an empty
  // sibling directory (NOT under `dir`, so it does not show up as an
  // untracked file in the working tree); cross-platform-safe (avoids
  // POSIX-specific `/dev/null`).
  const emptyHooks = join(tmpdir(), `zigma-git-empty-hooks-${randomUUID()}`);
  await mkdir(emptyHooks, { recursive: true });
  execFileSync("git", ["config", "core.hooksPath", emptyHooks], {
    cwd: dir,
    stdio: "ignore",
  });

  return { dir };
}

/** Run an arbitrary `git` subcommand inside the temp repo. */
function git(repo: TempRepo, args: string[]): void {
  execFileSync("git", args, { cwd: repo.dir, stdio: "ignore" });
}

// ---------------------------------------------------------------------------
// T-GC-7: SimpleGitInspector integration
// ---------------------------------------------------------------------------

describe("SimpleGitInspector — integration with a real temp git repo", () => {
  let repo: TempRepo;
  let inspector: SimpleGitInspector;

  beforeEach(async () => {
    repo = await makeTempRepo();
    inspector = new SimpleGitInspector();
  });

  afterEach(async () => {
    await rm(repo.dir, { recursive: true, force: true });
  });

  it(
    "reports modified files and diffExists=true in a dirty temp repo (T-GC-7 a, UC-GC-7)",
    async () => {
      // Step 1: create + stage a file. Now `notes.txt` is in the index
      // (staged "added") but not yet committed — it shows up under
      // `not_added` / `staged` depending on simple-git's classification.
      const filePath = join(repo.dir, "notes.txt");
      await writeFile(filePath, "initial content\n", "utf-8");
      git(repo, ["add", "notes.txt"]);

      // Step 2: modify the staged file on disk. Now `notes.txt` is BOTH
      // staged (with the original content) AND has unstaged modifications.
      // This is the worst-case dirty state and exercises the union
      // semantics of `changedFiles`.
      await writeFile(filePath, "modified content\n", "utf-8");

      // changedFiles() MUST include notes.txt.
      const changed = await inspector.changedFiles(repo.dir);
      expect(Array.isArray(changed)).toBe(true);
      // The file path may be reported as "notes.txt" (POSIX) regardless
      // of platform — `simple-git` normalises separators internally.
      expect(changed.some((p: string) => p.endsWith("notes.txt"))).toBe(true);

      // diffExists() MUST be true since changedFiles() is non-empty.
      const exists = await inspector.diffExists(repo.dir);
      expect(exists).toBe(true);
    }
  );

  it(
    "reports no changes for a freshly-committed clean repo (T-GC-7 b, UC-GC-7)",
    async () => {
      // Create + add + commit a single file so HEAD is non-empty and
      // working tree is clean.
      const filePath = join(repo.dir, "committed.txt");
      await writeFile(filePath, "committed content\n", "utf-8");
      git(repo, ["add", "committed.txt"]);
      git(repo, ["commit", "--quiet", "-m", "initial commit"]);

      // changedFiles() MUST be the empty array.
      const changed = await inspector.changedFiles(repo.dir);
      expect(Array.isArray(changed)).toBe(true);
      expect(changed).toEqual([]);

      // diffExists() MUST be false.
      const exists = await inspector.diffExists(repo.dir);
      expect(exists).toBe(false);
    }
  );
});
