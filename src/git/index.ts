/**
 * GitInspector port + SimpleGitInspector adapter — WF-P7-GITCHECK Step 2.
 *
 * Reference:
 *   - docs/phases/p7-check-step/workflows/wf-p7-gitcheck/01-cases-and-tests.md
 *   - docs/architecture.md §9.4, §16
 *   - docs/mvp-contracts.md §2.8
 */

import { simpleGit } from "simple-git";

// ---------------------------------------------------------------------------
// GitInspector — port interface
// ---------------------------------------------------------------------------

/**
 * Port for querying the git working-tree state of a given directory.
 * Concrete implementations may use `simple-git`, `child_process`, or
 * an in-memory fake (for tests).
 */
export interface GitInspector {
  /**
   * Returns the deduped list of changed file paths in the working tree
   * at `cwd`. Includes staged, unstaged, and untracked files.
   */
  changedFiles(cwd: string): Promise<string[]>;

  /**
   * Returns `true` iff `changedFiles(cwd)` is non-empty.
   */
  diffExists(cwd: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// SimpleGitInspector — simple-git-backed adapter
// ---------------------------------------------------------------------------

/**
 * `GitInspector` implementation backed by `simple-git`.
 * Uses `status()` to collect the union of staged, unstaged, and untracked
 * changed file paths (deduped).
 */
export class SimpleGitInspector implements GitInspector {
  async changedFiles(cwd: string): Promise<string[]> {
    const sg = simpleGit(cwd);
    const status = await sg.status();
    // status.files covers all staged + unstaged + untracked entries.
    // f.path is the current/new path (for renames, this is the new path).
    const paths = status.files.map((f) => f.path);
    // Deduplicate in case a file appears in multiple buckets.
    return [...new Set(paths)];
  }

  async diffExists(cwd: string): Promise<boolean> {
    return (await this.changedFiles(cwd)).length > 0;
  }
}
