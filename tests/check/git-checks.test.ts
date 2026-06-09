/**
 * Git / path check-kind tests for WF-P7-GITCHECK (Step 1 — Cases and
 * Tests).
 *
 * These tests exercise the three pure check functions
 * `checkGitDiffExists`, `checkForbiddenPaths`,
 * `checkProtectedRuntimeFiles` via a locally-declared `FakeGitInspector`
 * (dependency injection — NO real git is invoked). Each check function
 * reads its `with` arguments + the `runDir`, consults the injected
 * `GitInspector`, and returns a canonical `CheckResult`
 * (`{ passed, check_id, failures, artifacts }`).
 *
 * Covers:
 *   - T-GC-1: git-diff-exists fail (no diff)
 *   - T-GC-2: git-diff-exists pass (diff present)
 *   - T-GC-3: forbidden-paths pass (no match)
 *   - T-GC-4: forbidden-paths fail (matched file(s) listed in failures)
 *   - T-GC-5: protected-runtime-files pass (no runtime file touched)
 *   - T-GC-6: protected-runtime-files fail
 *             (`.zigma-flow/runs/<id>/state.json` changed)
 *
 * Reference:
 *   - docs/phases/p7-check-step/workflows/wf-p7-gitcheck/01-cases-and-tests.md
 *   - docs/phases/p7-check-step/02-development-plan.md §4 WF-P7-GITCHECK
 *   - docs/prd.md FR-008
 *   - docs/architecture.md §9.4, §11, §13 phase 7
 *   - docs/mvp-contracts.md §2.8
 *
 * Red-phase note: the four `src/...` modules below do not exist yet.
 * The tests fail at module resolution. After WF-P7-GITCHECK Step 2
 * ships `src/git/index.ts` (port + adapter) and the three check
 * functions, and adds `simple-git` + `micromatch` to dependencies,
 * the six T-GC-N tests should turn green.
 *
 * Function contract (uniform across all three kinds):
 *
 *   ({ with: Record<string, unknown>,
 *      runDir: string,
 *      git?: GitInspector }) => Promise<CheckResult>;
 *
 *   - `with.cwd?: string` overrides the inspector cwd; defaults to
 *     `runDir`. The FakeGitInspector ignores `cwd` and returns
 *     canned data regardless.
 *   - The returned `check_id` equals the canonical kind identifier:
 *     `"zigma/git-diff-exists"`, `"zigma/forbidden-paths"`,
 *     `"zigma/protected-runtime-files"`.
 *   - `artifacts` is always `[]` (pure-logic checks).
 *   - Semantic failures (no diff, matched forbidden path, touched
 *     protected file) return `passed: false` with descriptive
 *     `failures[]`.
 *   - Malformed `with` (wrong type, missing required `paths` for
 *     forbidden-paths) throws `CheckError` (not asserted in these
 *     red-phase tests — covered indirectly by WF-P7-CHECK T-CHECK-5
 *     and Step 2 may add explicit assertions).
 */

import { describe, expect, it } from "vitest";

import type { CheckResult } from "../../src/check/index.js";
import type { GitInspector } from "../../src/git/index.js";
import { checkGitDiffExists } from "../../src/check/checks/git-diff-exists.js";
import { checkForbiddenPaths } from "../../src/check/checks/forbidden-paths.js";
import { checkProtectedRuntimeFiles } from "../../src/check/checks/protected-runtime-files.js";

// ---------------------------------------------------------------------------
// FakeGitInspector — local DI implementation for unit tests
// ---------------------------------------------------------------------------

/**
 * In-memory `GitInspector` for unit tests. The constructor takes a
 * fixed list of "changed" file paths; `changedFiles()` returns that
 * list verbatim regardless of `cwd`, and `diffExists()` is true iff
 * the list is non-empty.
 *
 * This is the dependency-injection seam the check functions expose
 * via the optional `git?: GitInspector` parameter. Real git is NOT
 * invoked in this file; see `tests/git/inspector.test.ts` for the
 * `SimpleGitInspector` integration test.
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
 * Assert that a value is shaped like a canonical `CheckResult`:
 *   { passed: boolean, check_id: string, failures: string[], artifacts: string[] }
 *
 * Used as a precondition before per-case field assertions so a
 * wrong-shape regression surfaces as a clearer failure than a
 * downstream `undefined` access.
 */
function expectCheckResultShape(value: unknown): asserts value is CheckResult {
  expect(value).toBeDefined();
  expect(typeof value).toBe("object");
  const result = value as Record<string, unknown>;
  expect(typeof result["passed"]).toBe("boolean");
  expect(typeof result["check_id"]).toBe("string");
  expect(Array.isArray(result["failures"])).toBe(true);
  expect(Array.isArray(result["artifacts"])).toBe(true);
}

// A non-existent runDir is fine — the FakeGitInspector ignores `cwd`,
// and the check functions only pass it through to the inspector.
const RUN_DIR = "/tmp/zigma-test-run-dir-not-used";

// ===========================================================================
// T-GC-1 / T-GC-2: git-diff-exists
// ===========================================================================

describe("checkGitDiffExists — git-diff-exists kind", () => {
  it(
    "fails when the working tree has no diff (T-GC-1, UC-GC-1)",
    async () => {
      const fake = new FakeGitInspector([]);

      const result = await checkGitDiffExists({
        with: {},
        runDir: RUN_DIR,
        git: fake,
      });

      expectCheckResultShape(result);
      expect(result.passed).toBe(false);
      expect(result.check_id).toBe("zigma/git-diff-exists");
      expect(result.artifacts).toEqual([]);
      // At least one failure entry must explain the missing diff.
      expect(result.failures.length).toBeGreaterThanOrEqual(1);
      expect(result.failures.join("\n").toLowerCase()).toContain("no diff");
    }
  );

  it(
    "passes when the working tree has uncommitted changes (T-GC-2, UC-GC-2)",
    async () => {
      const fake = new FakeGitInspector(["src/main.ts"]);

      const result = await checkGitDiffExists({
        with: {},
        runDir: RUN_DIR,
        git: fake,
      });

      expectCheckResultShape(result);
      expect(result.passed).toBe(true);
      expect(result.check_id).toBe("zigma/git-diff-exists");
      expect(result.failures).toEqual([]);
      expect(result.artifacts).toEqual([]);
    }
  );
});

// ===========================================================================
// T-GC-3 / T-GC-4: forbidden-paths
// ===========================================================================

describe("checkForbiddenPaths — forbidden-paths kind", () => {
  it(
    "passes when no changed file matches any forbidden glob (T-GC-3, UC-GC-3)",
    async () => {
      const fake = new FakeGitInspector(["src/main.ts", "README.md"]);

      const result = await checkForbiddenPaths({
        with: { paths: ["**/*.secret"] },
        runDir: RUN_DIR,
        git: fake,
      });

      expectCheckResultShape(result);
      expect(result.passed).toBe(true);
      expect(result.check_id).toBe("zigma/forbidden-paths");
      expect(result.failures).toEqual([]);
      expect(result.artifacts).toEqual([]);
    }
  );

  it(
    "fails listing each matched file when a forbidden glob is hit (T-GC-4, UC-GC-4)",
    async () => {
      const fake = new FakeGitInspector([
        "config/api.secret",
        "src/util.ts",
      ]);

      const result = await checkForbiddenPaths({
        with: { paths: ["**/*.secret"] },
        runDir: RUN_DIR,
        git: fake,
      });

      expectCheckResultShape(result);
      expect(result.passed).toBe(false);
      expect(result.check_id).toBe("zigma/forbidden-paths");
      expect(result.artifacts).toEqual([]);

      // The matched file MUST appear in failures; the unmatched file
      // MUST NOT.
      expect(result.failures.length).toBeGreaterThanOrEqual(1);
      const joined = result.failures.join("\n");
      expect(joined).toContain("config/api.secret");
      expect(joined).not.toContain("src/util.ts");
    }
  );
});

// ===========================================================================
// T-GC-5 / T-GC-6: protected-runtime-files
// ===========================================================================

describe("checkProtectedRuntimeFiles — protected-runtime-files kind", () => {
  it(
    "passes when no runtime file is touched (T-GC-5, UC-GC-5)",
    async () => {
      const fake = new FakeGitInspector(["src/main.ts", "docs/notes.md"]);

      const result = await checkProtectedRuntimeFiles({
        with: {},
        runDir: RUN_DIR,
        git: fake,
      });

      expectCheckResultShape(result);
      expect(result.passed).toBe(true);
      expect(result.check_id).toBe("zigma/protected-runtime-files");
      expect(result.failures).toEqual([]);
      expect(result.artifacts).toEqual([]);
    }
  );

  it(
    "fails when .zigma-flow/runs/<id>/state.json is changed (T-GC-6, UC-GC-6)",
    async () => {
      const fake = new FakeGitInspector([
        ".zigma-flow/runs/abc/state.json",
        "src/x.ts",
      ]);

      const result = await checkProtectedRuntimeFiles({
        with: {},
        runDir: RUN_DIR,
        git: fake,
      });

      expectCheckResultShape(result);
      expect(result.passed).toBe(false);
      expect(result.check_id).toBe("zigma/protected-runtime-files");
      expect(result.artifacts).toEqual([]);

      // The touched state.json MUST be listed; the unrelated src file
      // MUST NOT.
      expect(result.failures.length).toBeGreaterThanOrEqual(1);
      const joined = result.failures.join("\n");
      expect(joined).toContain(".zigma-flow/runs/abc/state.json");
      expect(joined).not.toContain("src/x.ts");
    }
  );
});
