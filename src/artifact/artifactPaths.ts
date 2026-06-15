/**
 * Artifact path allocation and safety enforcement.
 *
 * Reference: docs/mvp-contracts.md §2.5
 * WF-P4-ARTIFACT Step 2.
 */

import { join, resolve, relative, isAbsolute, normalize, posix } from "node:path";

import { ArtifactError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// assertPathSafe
// ---------------------------------------------------------------------------

/**
 * Assert that `relPath` is safe to use as an artifact path under `runDir`.
 *
 * Throws `ArtifactError` if:
 *   - `relPath` is empty
 *   - `relPath` is absolute
 *   - `relPath` after normalization contains `..` segments that escape `runDir`
 *   - the resolved absolute path is not inside `runDir`
 */
export function assertPathSafe(runDir: string, relPath: string): void {
  if (relPath.length === 0) {
    throw new ArtifactError("Artifact path must not be empty", {
      details: { runDir, relPath },
    });
  }

  if (isAbsolute(relPath)) {
    throw new ArtifactError("Artifact path must not be absolute", {
      details: { runDir, relPath },
    });
  }

  const normalized = normalize(relPath);
  const resolved = resolve(runDir, normalized);

  // Ensure the resolved path is inside runDir.
  // We use relative() and check that it doesn't start with ".." to detect escapes.
  const rel = relative(runDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ArtifactError(
      `Artifact path "${relPath}" resolves outside the run directory`,
      { details: { runDir, relPath, resolved } }
    );
  }
}

// ---------------------------------------------------------------------------
// artifactStepDir / artifactPath
// ---------------------------------------------------------------------------

/**
 * Returns the canonical step artifact path relative to a run directory,
 * using POSIX separators for portable rendering and metadata.
 *
 * `jobs/<job>/attempts/<attempt>/steps/<step>`
 */
export function artifactStepRelativePath(
  job: string,
  attempt: number,
  step: string
): string {
  return posix.join("jobs", job, "attempts", String(attempt), "steps", step);
}

/**
 * Returns the canonical artifact file path relative to a run directory,
 * using POSIX separators for portable rendering and metadata.
 *
 * `jobs/<job>/attempts/<attempt>/steps/<step>/<filename>`
 */
export function artifactFileRelativePath(
  job: string,
  attempt: number,
  step: string,
  filename: string
): string {
  return posix.join(artifactStepRelativePath(job, attempt, step), filename);
}

/**
 * Returns the canonical step artifacts directory:
 * `<runDir>/jobs/<job>/attempts/<attempt>/steps/<step>`
 */
export function artifactStepDir(
  runDir: string,
  job: string,
  attempt: number,
  step: string
): string {
  return join(runDir, "jobs", job, "attempts", String(attempt), "steps", step);
}

/**
 * Returns the full path for an artifact file and validates path safety.
 *
 * `<runDir>/jobs/<job>/attempts/<attempt>/steps/<step>/<filename>`
 */
export function artifactPath(
  runDir: string,
  job: string,
  attempt: number,
  step: string,
  filename: string
): string {
  const relPath = artifactFileRelativePath(job, attempt, step, filename);
  assertPathSafe(runDir, relPath);
  return join(runDir, relPath);
}
