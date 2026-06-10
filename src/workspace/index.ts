/**
 * WorkspaceGuard port + SimpleWorkspaceGuard adapter — WF-P8-WSGUARD Step 2.
 *
 * Provides a deterministic, LLM-free query that detects working-tree
 * modifications in a given `cwd`. Intended to be called by the Engine
 * integration layer after a read-only job step executes.
 *
 * Reference:
 *   - docs/phases/p8-router-and-signals/workflows/wf-p8-wsguard/01-cases-and-tests.md
 *   - docs/prd.md §20 FR-014
 *   - docs/architecture.md §6.2, §11, §13 phase 7, §16
 *   - docs/mvp-contracts.md §2.1, §2.8, §7
 *
 * Architecture fitness:
 *   - This file MUST NOT import from src/check/, src/engine/, src/events/,
 *     or src/run/. Only src/git/ (interface + adapter) and micromatch are
 *     allowed external imports.
 *   - src/engine/index.ts MUST NOT import SimpleWorkspaceGuard (only the
 *     WorkspaceGuard interface); DI wiring is done at the CLI composition root.
 */

import { createRequire } from "node:module";

import type { GitInspector } from "../git/index.js";
import { SimpleGitInspector } from "../git/index.js";

// micromatch ships as a CommonJS module; @types/micromatch uses `export =`
// which conflicts with ESM `import default` under NodeNext. Use createRequire
// to avoid the TypeScript type conflict — mirrors the pattern in
// src/check/checks/protected-runtime-files.ts (P7).
const _require = createRequire(import.meta.url);
const micromatch = _require("micromatch") as {
  (list: string[], patterns: string[]): string[];
  isMatch(file: string, patterns: readonly string[]): boolean;
};

// ---------------------------------------------------------------------------
// Protected runtime patterns (architecture §11)
// ---------------------------------------------------------------------------

/**
 * Hardcoded glob patterns for mutable runtime state files that must never
 * be touched by read-only jobs.
 *
 * See also src/check/checks/protected-runtime-files.ts — architecture §11
 * is the canonical source for these patterns. If a third runtime path is
 * ever added, BOTH locations must be updated (TD-WG-2 tracks this debt).
 */
export const PROTECTED_RUNTIME_PATTERNS: readonly string[] = [
  ".zigma-flow/runs/*/state.json",
  ".zigma-flow/runs/*/events.jsonl",
];

// ---------------------------------------------------------------------------
// WorkspaceModification — value type
// ---------------------------------------------------------------------------

/**
 * A single file-level modification detected in the working tree.
 *
 * `path`  — the file path relative to the `cwd` passed to
 *            `detectModifications()`. POSIX-style (normalised by
 *            `simple-git` / `GitInspector`).
 *
 * `kind`  — classification of the modification:
 *   - `"git-changed"`       — any untracked, staged, or unstaged change
 *                             (created / modified / deleted / renamed).
 *   - `"protected-runtime"` — the file additionally matches one of the
 *                             hardcoded `PROTECTED_RUNTIME_PATTERNS`, so
 *                             the Engine integration layer can choose to
 *                             upgrade the failure to a `PermissionError`.
 */
export interface WorkspaceModification {
  readonly path: string;
  readonly kind: "git-changed" | "protected-runtime";
}

// ---------------------------------------------------------------------------
// WorkspaceGuard — port interface
// ---------------------------------------------------------------------------

/**
 * Port for querying whether the working tree at a given `cwd` has been
 * modified. An empty result means the tree is clean.
 *
 * Implementations MUST be pure query functions: no filesystem writes,
 * no event emissions, no Engine state transitions. Throwing is reserved
 * for unrecoverable IO errors (e.g. `cwd` does not exist); domain logic
 * failures are expressed via the returned array.
 */
export interface WorkspaceGuard {
  /**
   * Returns the list of modifications detected in `cwd`. An empty array
   * means the working tree is clean.
   *
   * @param cwd            Absolute path to the directory to inspect.
   *                       Relative paths are resolved by `simple-git`
   *                       against `process.cwd()` (best practice: pass
   *                       an absolute path).
   * @param opts.includeProtected  When `false`, skip the
   *                       `PROTECTED_RUNTIME_PATTERNS` classification
   *                       step (reserved for future use; default `true`).
   */
  detectModifications(
    cwd: string,
    opts?: { includeProtected?: boolean },
  ): Promise<WorkspaceModification[]>;
}

// ---------------------------------------------------------------------------
// SimpleWorkspaceGuard — GitInspector-backed adapter
// ---------------------------------------------------------------------------

/**
 * `WorkspaceGuard` implementation backed by `GitInspector`.
 *
 * Dependency-injection seam: pass a `GitInspector` instance in the
 * constructor for testing (use `FakeGitInspector`). Leave it absent
 * in production and the guard constructs `new SimpleGitInspector()` on
 * demand (lazy, matches the P7 pattern from WF-P7-GITCHECK D9).
 *
 * Triggering policy (whether to call `detectModifications()` at all,
 * based on `workspace.mode === "read-only"`) is owned by the Engine
 * integration layer (WF-P8-SIGNALS or follow-up). This class is a
 * pure query function and has no knowledge of job mode.
 */
export class SimpleWorkspaceGuard implements WorkspaceGuard {
  constructor(private readonly git?: GitInspector) {}

  async detectModifications(
    cwd: string,
    opts: { includeProtected?: boolean } = {},
  ): Promise<WorkspaceModification[]> {
    const includeProtected = opts.includeProtected !== false;

    // Lazy-construct the default adapter if none was injected.
    const git = this.git ?? new SimpleGitInspector();

    const changed = await git.changedFiles(cwd);

    // Classify each path; deduplicate in case the inspector returns
    // duplicates (it should not, but guard defensively).
    const seen = new Set<string>();
    const result: WorkspaceModification[] = [];

    for (const p of changed) {
      if (seen.has(p)) continue;
      seen.add(p);

      const isProtected =
        includeProtected &&
        micromatch.isMatch(p, PROTECTED_RUNTIME_PATTERNS);

      result.push({
        path: p,
        kind: isProtected ? "protected-runtime" : "git-changed",
      });
    }

    return result;
  }
}
