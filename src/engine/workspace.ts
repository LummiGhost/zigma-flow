/**
 * Job workspace resolution — resolves `${{ }}` expressions in a job's
 * working-directory path and validates the result at job-start time.
 *
 * Reference: GitHub Issue #178
 * docs/architecture.md §5.2 (module boundaries):
 *   - Engine owns state transitions. Workspace resolution is a validated
 *     execution context decision, not a state-machine bypass.
 */

import { stat } from "node:fs/promises";
import { resolve, parse as parsePath } from "node:path";

import type { JobDefinition } from "../workflow/index.js";
import type { RunState } from "../run/index.js";
import { resolveExpression } from "../expression/index.js";
import type { ExpressionContext } from "../expression/index.js";
import { ValidationError } from "../utils/index.js";

/**
 * Extract the raw (pre-resolution) workspace directory path from a job
 * definition. Returns `undefined` when no workspace path is configured
 * (only a mode or no workspace at all).
 */
export function extractWorkspacePath(
  jobDef: JobDefinition,
): string | undefined {
  const ws = jobDef.workspace;
  if (ws === undefined) return undefined;
  if (typeof ws === "string") return ws;
  if (typeof ws === "object" && ws !== null && typeof ws.directory === "string" && ws.directory.length > 0) {
    return ws.directory;
  }
  return undefined;
}

/**
 * Resolve a job's working directory from its workspace definition and the
 * current run state.
 *
 * Steps:
 * 1. Extract the raw workspace path (string form or `workspace.directory`).
 * 2. Resolve `${{ }}` expressions against current state (job outputs, variables).
 * 3. Validate the resolved path exists and is a directory.
 * 4. Reject unsafe paths (e.g. `..` traversal past project root is caught
 *    by the fact that the resolved path must exist — we just resolve relative
 *    paths from cwd and verify the absolute result is a real directory).
 *
 * Returns `undefined` when the job has no workspace path configured.
 * Throws `ValidationError` for missing/invalid directories or unsafe paths.
 */
export async function resolveJobWorkingDirectory(
  jobDef: JobDefinition,
  state: RunState,
  runDir?: string,
): Promise<string | undefined> {
  const raw = extractWorkspacePath(jobDef);
  if (raw === undefined) return undefined;

  // Build expression context from current run state
  const exprCtx: ExpressionContext = {
    inputs: {},
    run: {
      id: state.run_id,
      workflow: state.workflow,
      ...(runDir !== undefined ? { dir: runDir } : {}),
    },
    jobs: Object.fromEntries(
      Object.entries(state.jobs).map(([id, js]) => [
        id,
        { outputs: js.outputs ?? {} },
      ]),
    ),
    ...(state.variables !== undefined ? { variables: state.variables } : {}),
  };

  // Resolve ${{ }} expressions
  const resolved = resolveExpression(raw, exprCtx);

  // Validate path safety: reject paths containing unresolved expressions
  if (/\$\{\{/.test(resolved)) {
    throw new ValidationError(
      `Workspace path contains unresolved expressions: "${resolved}"`,
      {
        details: {
          raw_path: raw,
          resolved_path: resolved,
          hint: "Ensure all upstream job outputs referenced in the workspace path exist.",
        },
      },
    );
  }

  // Resolve to an absolute path, normalizing away ".." segments.
  // Using resolve() unconditionally ensures the result is always a canonical
  // absolute path without directory traversal artifacts, even when the
  // incoming string is already absolute.
  const absolutePath = resolve(resolved);

  // Path traversal safety: resolved path must not be a filesystem root
  {
    const parsed = parsePath(absolutePath);
    if (absolutePath.length === 0 || (parsed.root === absolutePath && parsed.base === "")) {
      throw new ValidationError(
        `Workspace path resolved to filesystem root: "${raw}" → "${absolutePath}"`,
        {
          details: { raw_path: raw, resolved_path: absolutePath },
        },
      );
    }
  }

  // Defense-in-depth: reject any path that still contains ".." segments
  // after normalization. Node's resolve() should have already collapsed
  // these, but this guard protects against edge cases and future changes.
  //
  // Residual risk: this feature is intended for trusted users with
  // workflow-authoring access. Symlinks that point outside the intended
  // workspace tree are not detected here — the primary defense is that
  // the resolved path must exist as a real directory.
  {
    const segments = absolutePath.split(/[/\\]/);
    if (segments.includes("..")) {
      throw new ValidationError(
        `Workspace path contains ".." traversal after normalization: "${raw}" → "${absolutePath}"`,
        {
          details: { raw_path: raw, resolved_path: absolutePath },
        },
      );
    }
  }

  // Verify the path exists and is a directory
  let dirStat;
  try {
    dirStat = await stat(absolutePath);
  } catch {
    throw new ValidationError(
      `Workspace directory does not exist: "${absolutePath}" (from "${raw}")`,
      {
        details: { raw_path: raw, resolved_path: absolutePath },
        suggestion: "Ensure the upstream job that creates this directory completed successfully.",
      },
    );
  }

  if (!dirStat.isDirectory()) {
    throw new ValidationError(
      `Workspace path is not a directory: "${absolutePath}" (from "${raw}")`,
      {
        details: { raw_path: raw, resolved_path: absolutePath },
      },
    );
  }

  return absolutePath;
}
