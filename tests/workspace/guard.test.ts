/**
 * Workspace Guard tests for WF-P8-WSGUARD (Step 1 — Cases and Tests).
 *
 * These tests exercise the `WorkspaceGuard` port and the
 * `SimpleWorkspaceGuard` adapter:
 *
 *   - T-WG-1..T-WG-7: unit cases against a locally-declared
 *     `FakeGitInspector` (dependency injection — NO real git is
 *     invoked).
 *   - T-WG-INTEG: integration smoke against a real temp git repo
 *     created via `node:child_process`, exercising the
 *     `SimpleGitInspector`-backed default path of
 *     `SimpleWorkspaceGuard`.
 *
 * Reference:
 *   - docs/phases/p8-router-and-signals/workflows/wf-p8-wsguard/01-cases-and-tests.md
 *   - docs/phases/p8-router-and-signals/02-development-plan.md §4 WF-P8-WSGUARD
 *   - docs/prd.md §20 FR-014
 *   - docs/architecture.md §6.2, §11, §13 phase 7, §16
 *   - docs/mvp-contracts.md §2.1, §2.8, §7
 *
 * Red-phase note: `src/workspace/index.ts` is currently `export {}`.
 * All imports of `WorkspaceGuard`, `WorkspaceModification`,
 * `SimpleWorkspaceGuard`, and `PROTECTED_RUNTIME_PATTERNS` fail at
 * module resolution. After WF-P8-WSGUARD Step 2 ships the port +
 * adapter, every test below should turn green.
 *
 * Port contract under test (declared in `src/workspace/index.ts` in
 * Step 2):
 *
 *   interface WorkspaceModification {
 *     readonly path: string;
 *     readonly kind: "git-changed" | "protected-runtime";
 *   }
 *
 *   interface WorkspaceGuard {
 *     detectModifications(
 *       cwd: string,
 *       opts?: { includeProtected?: boolean },
 *     ): Promise<WorkspaceModification[]>;
 *   }
 *
 *   class SimpleWorkspaceGuard implements WorkspaceGuard {
 *     constructor(git?: GitInspector);
 *     detectModifications(...): ...
 *   }
 *
 *   const PROTECTED_RUNTIME_PATTERNS: readonly string[] =
 *     [".zigma-flow/runs/*\/state.json",
 *      ".zigma-flow/runs/*\/events.jsonl"];
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { GitInspector } from "../../src/git/index.js";
import {
  PROTECTED_RUNTIME_PATTERNS,
  SimpleWorkspaceGuard,
  type WorkspaceGuard,
  type WorkspaceModification,
} from "../../src/workspace/index.js";

// ---------------------------------------------------------------------------
// FakeGitInspector — local DI implementation for unit tests
// ---------------------------------------------------------------------------

/**
 * In-memory `GitInspector` for unit tests. The constructor takes a
 * fixed list of "changed" file paths; `changedFiles()` returns that
 * list verbatim regardless of `cwd`, and `diffExists()` is true iff
 * the list is non-empty.
 *
 * This is the dependency-injection seam the `SimpleWorkspaceGuard`
 * constructor exposes via the optional `git?: GitInspector`
 * parameter. Real git is NOT invoked in this file's unit cases; see
 * the T-WG-INTEG block at the bottom for the real-git integration
 * smoke.
 */
class FakeGitInspector implements GitInspector {
  constructor(private readonly changed: readonly string[]) {}

  async changedFiles(_cwd: string): Promise<string[]> {
    return [...this.changed];
  }

  async diffExists(_cwd: string): Promise<boolean> {
    return this.changed.length > 0;
  }
}

/**
 * Assert that a value is shaped like a canonical
 * `WorkspaceModification[]`: each entry must be an object with a
 * string `path` and a `kind` in the closed set
 * {"git-changed", "protected-runtime"}.
 *
 * Used as a precondition before per-case field assertions so a
 * wrong-shape regression surfaces as a clearer failure than a
 * downstream `undefined` access.
 */
function expectWorkspaceModificationShape(
  value: unknown,
): asserts value is WorkspaceModification[] {
  expect(Array.isArray(value)).toBe(true);
  for (const entry of value as unknown[]) {
    expect(typeof entry).toBe("object");
    expect(entry).not.toBeNull();
    const m = entry as Record<string, unknown>;
    expect(typeof m["path"]).toBe("string");
    expect(typeof m["kind"]).toBe("string");
    expect(["git-changed", "protected-runtime"]).toContain(m["kind"]);
  }
}

// A non-existent cwd is fine for the unit cases — the FakeGitInspector
// ignores `cwd`, and the guard only passes it through.
const FAKE_CWD = "/tmp/zigma-test-cwd-not-used";

// ===========================================================================
// T-WG-1: clean working tree → empty result
// ===========================================================================

describe("SimpleWorkspaceGuard — clean working tree", () => {
  it(
    "returns an empty array when the inspector reports no changes (T-WG-1, UC-WSGUARD-1)",
    async () => {
      const fake = new FakeGitInspector([]);
      const guard: WorkspaceGuard = new SimpleWorkspaceGuard(fake);

      const result = await guard.detectModifications(FAKE_CWD);

      expectWorkspaceModificationShape(result);
      expect(result).toEqual([]);
    },
  );
});

// ===========================================================================
// T-WG-2..T-WG-5: file mutation classes — created / modified / deleted /
// renamed all surface as kind: "git-changed"
// ===========================================================================

describe("SimpleWorkspaceGuard — mutation-class reporting", () => {
  it(
    "reports a newly-created file as kind: git-changed (T-WG-2, UC-WSGUARD-2)",
    async () => {
      const fake = new FakeGitInspector(["new-file.txt"]);
      const guard = new SimpleWorkspaceGuard(fake);

      const result = await guard.detectModifications(FAKE_CWD);

      expectWorkspaceModificationShape(result);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path: "new-file.txt",
        kind: "git-changed",
      });
    },
  );

  it(
    "reports a modified existing file as kind: git-changed (T-WG-3, UC-WSGUARD-3)",
    async () => {
      const fake = new FakeGitInspector(["src/existing.ts"]);
      const guard = new SimpleWorkspaceGuard(fake);

      const result = await guard.detectModifications(FAKE_CWD);

      expectWorkspaceModificationShape(result);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path: "src/existing.ts",
        kind: "git-changed",
      });
    },
  );

  it(
    "reports a deleted file as kind: git-changed (T-WG-4, UC-WSGUARD-4)",
    async () => {
      // `simple-git` reports deletions under `status.files` with the
      // deleted path (just like other mutations); the fake simulates
      // that by returning the deleted path verbatim.
      const fake = new FakeGitInspector(["docs/legacy.md"]);
      const guard = new SimpleWorkspaceGuard(fake);

      const result = await guard.detectModifications(FAKE_CWD);

      expectWorkspaceModificationShape(result);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path: "docs/legacy.md",
        kind: "git-changed",
      });
    },
  );

  it(
    "reports a renamed file's new path as kind: git-changed (T-WG-5, UC-WSGUARD-5)",
    async () => {
      // For renames, `simple-git`'s `f.path` is the NEW name. MVP does
      // not also surface the old name — matches the P7 GitInspector
      // contract (architecture decision D9 of WF-P7-GITCHECK).
      const fake = new FakeGitInspector(["src/renamed.ts"]);
      const guard = new SimpleWorkspaceGuard(fake);

      const result = await guard.detectModifications(FAKE_CWD);

      expectWorkspaceModificationShape(result);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path: "src/renamed.ts",
        kind: "git-changed",
      });
    },
  );
});

// ===========================================================================
// T-WG-6: guard is a pure query — it does NOT inspect the job's
// workspace.mode. Triggering policy lives in the Engine integration
// layer (WF-P8-SIGNALS).
// ===========================================================================

describe("SimpleWorkspaceGuard — purity / no policy decision", () => {
  it(
    "does not branch on workspace mode; returns whatever the inspector reports (T-WG-6, UC-WSGUARD-6)",
    async () => {
      // The guard does not take a mode argument and does not consult
      // anything mode-related. The Engine integration layer is the
      // sole site that decides "should we even call the guard?". This
      // test asserts that contract by exercising the guard with a
      // non-empty inspector and asserting it still returns the data —
      // the guard never says "writable, so I won't report".
      const fake = new FakeGitInspector(["src/x.ts"]);
      const guard = new SimpleWorkspaceGuard(fake);

      const result = await guard.detectModifications(FAKE_CWD);

      expectWorkspaceModificationShape(result);
      expect(result).toHaveLength(1);
      expect(result[0]?.path).toBe("src/x.ts");
      // The guard never throws based on mode.
      // (Asserting "did not throw" implicitly via reaching this line.)
    },
  );
});

// ===========================================================================
// T-WG-7: protected runtime files get `kind: "protected-runtime"` so the
// Engine integration layer can upgrade them to `PermissionError`.
// ===========================================================================

describe("SimpleWorkspaceGuard — protected runtime path classification", () => {
  it(
    "flags protected runtime files with kind: protected-runtime and leaves others as git-changed (T-WG-7, UC-WSGUARD-7)",
    async () => {
      const fake = new FakeGitInspector([
        ".zigma-flow/runs/abc/state.json",
        "src/x.ts",
      ]);
      const guard = new SimpleWorkspaceGuard(fake);

      const result = await guard.detectModifications(FAKE_CWD);

      expectWorkspaceModificationShape(result);
      expect(result).toHaveLength(2);

      // The protected runtime path MUST be classified.
      const stateEntry = result.find(
        (m) => m.path === ".zigma-flow/runs/abc/state.json",
      );
      expect(stateEntry).toBeDefined();
      expect(stateEntry?.kind).toBe("protected-runtime");

      // The unrelated source file is a plain modification.
      const srcEntry = result.find((m) => m.path === "src/x.ts");
      expect(srcEntry).toBeDefined();
      expect(srcEntry?.kind).toBe("git-changed");
    },
  );

  it(
    "exposes the protected pattern list as a non-empty readonly constant",
    async () => {
      // FP-WG-PROTECTED-PATTERNS — the exported constant must include
      // both architecturally-protected paths (architecture §11). This
      // test pins the public surface so a future PR cannot silently
      // drop one of them.
      expect(Array.isArray(PROTECTED_RUNTIME_PATTERNS)).toBe(true);
      expect(PROTECTED_RUNTIME_PATTERNS).toContain(
        ".zigma-flow/runs/*/state.json",
      );
      expect(PROTECTED_RUNTIME_PATTERNS).toContain(
        ".zigma-flow/runs/*/events.jsonl",
      );
    },
  );
});

// ===========================================================================
// T-WG-INTEG: integration smoke against a real temp git repo.
// Exercises the default-constructed `SimpleGitInspector` inside
// `SimpleWorkspaceGuard` so we have at least one assertion that
// real `simple-git` output flows through the guard's classification.
// ===========================================================================

interface TempRepo {
  /** Absolute path to the temp directory used as the git working tree. */
  dir: string;
}

/**
 * Create a fresh temp directory, `git init` it, and configure a local
 * identity so subsequent `git commit` invocations do not depend on
 * the host's global git config (which CI machines often lack).
 *
 * Mirrors `tests/git/inspector.test.ts` (delivered by P7).
 */
async function makeTempRepo(): Promise<TempRepo> {
  const dir = join(tmpdir(), `zigma-wsguard-${randomUUID()}`);
  await mkdir(dir, { recursive: true });

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
  // interfere with the test.
  const emptyHooks = join(tmpdir(), `zigma-wsguard-hooks-${randomUUID()}`);
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

describe("SimpleWorkspaceGuard — integration with a real temp git repo", () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await makeTempRepo();
  });

  afterEach(async () => {
    await rm(repo.dir, { recursive: true, force: true });
  });

  it(
    "flags untracked, modified, deleted, and renamed files when default-constructed (T-WG-INTEG, UC-WSGUARD-2..5)",
    async () => {
      // Baseline: commit three files so the working tree starts clean
      // and we have something to modify / delete / rename.
      const baselineModify = join(repo.dir, "modify.txt");
      const baselineDelete = join(repo.dir, "delete.txt");
      const baselineRenameSrc = join(repo.dir, "old-name.txt");
      await writeFile(baselineModify, "initial\n", "utf-8");
      await writeFile(baselineDelete, "to be deleted\n", "utf-8");
      await writeFile(baselineRenameSrc, "to be renamed\n", "utf-8");
      git(repo, ["add", "modify.txt", "delete.txt", "old-name.txt"]);
      git(repo, ["commit", "--quiet", "-m", "baseline"]);

      // Now mutate the working tree four different ways:
      //   1. untracked: create a brand-new file.
      //   2. modified: change an existing committed file.
      //   3. deleted: remove an existing committed file.
      //   4. renamed: rename a committed file.
      await writeFile(join(repo.dir, "untracked.txt"), "fresh\n", "utf-8");
      await writeFile(baselineModify, "mutated\n", "utf-8");
      await unlink(baselineDelete);
      await rename(baselineRenameSrc, join(repo.dir, "new-name.txt"));

      // Default-constructed guard wires in `SimpleGitInspector`
      // (no fake), so this round-trip exercises the real `simple-git`
      // → guard → `WorkspaceModification[]` pipeline.
      const guard = new SimpleWorkspaceGuard();
      const result = await guard.detectModifications(repo.dir);

      expectWorkspaceModificationShape(result);
      // Each of the four mutations must surface. `simple-git`'s rename
      // detection sometimes reports the new path only; sometimes the
      // old path appears as "deleted" while the new path appears as
      // "untracked" depending on host git version. The assertion
      // tolerates both shapes by checking that the new name OR the
      // old name appears, plus the deleted file path AND the
      // untracked file path AND the modified file path.
      const paths = result.map((m) => m.path);

      // 1. untracked file is reported.
      expect(paths.some((p) => p.endsWith("untracked.txt"))).toBe(true);

      // 2. modified file is reported.
      expect(paths.some((p) => p.endsWith("modify.txt"))).toBe(true);

      // 3. deleted file is reported.
      expect(paths.some((p) => p.endsWith("delete.txt"))).toBe(true);

      // 4. renamed file is reported under the new name (or the old
      //    name if the host git did not detect the rename).
      expect(
        paths.some(
          (p) => p.endsWith("new-name.txt") || p.endsWith("old-name.txt"),
        ),
      ).toBe(true);

      // None of these paths match the protected runtime patterns, so
      // every entry must be classified as "git-changed".
      for (const m of result) {
        expect(m.kind).toBe("git-changed");
      }
    },
  );
});
