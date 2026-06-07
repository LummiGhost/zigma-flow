/**
 * Artifact write helper — creates directory, writes content, returns metadata.
 *
 * Reference: docs/mvp-contracts.md §2.5
 * WF-P4-ARTIFACT Step 2.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { posix, join, relative } from "node:path";

import { artifactId } from "./artifactMetadata.js";
import { artifactStepDir, assertPathSafe } from "./artifactPaths.js";
import type { ArtifactMetadata } from "./artifactMetadata.js";

// ---------------------------------------------------------------------------
// Clock — re-exported so callers of artifact/ do not need to import from run/
// ---------------------------------------------------------------------------

export interface Clock {
  now(): string; // ISO 8601
}

// ---------------------------------------------------------------------------
// WriteArtifactOpts
// ---------------------------------------------------------------------------

export interface WriteArtifactOpts {
  runDir: string;
  runId: string;
  job: string;
  step: string;
  attempt: number;
  kind: string;
  filename: string;
  content: string | Buffer;
  contentType: string;
  summary?: string;
  clock: Clock;
}

// ---------------------------------------------------------------------------
// writeArtifact
// ---------------------------------------------------------------------------

/**
 * Write artifact content to disk and return fully-populated `ArtifactMetadata`.
 *
 * - Creates the step artifacts directory recursively (idempotent).
 * - Writes `content` to the target file.
 * - Returns metadata where `path` is a relative POSIX-style path from `runDir`.
 */
export async function writeArtifact(opts: WriteArtifactOpts): Promise<ArtifactMetadata> {
  const { runDir, runId, job, step, attempt, kind, filename, content, contentType, clock } = opts;
  const summary = opts.summary ?? "";

  const stepDir = artifactStepDir(runDir, job, attempt, step);

  // F-01: Validate the computed relative path before any filesystem operations.
  // This prevents job/step/filename values containing ".." from escaping runDir.
  const fullPath = join(stepDir, filename);
  const relPath = relative(runDir, fullPath).split("\\").join(posix.sep);
  assertPathSafe(runDir, relPath);

  await mkdir(stepDir, { recursive: true });

  if (typeof content === "string") {
    await writeFile(fullPath, content, "utf-8");
  } else {
    await writeFile(fullPath, content);
  }

  // Compute size from content bytes.
  const size =
    typeof content === "string"
      ? Buffer.byteLength(content, "utf-8")
      : content.byteLength;

  const id = artifactId(runId, job, attempt, step, filename);
  const createdAt = clock.now();

  const metadata: ArtifactMetadata = {
    id,
    run_id: runId,
    producer: { job, step, attempt },
    kind,
    path: relPath,
    content_type: contentType,
    size,
    summary,
    created_at: createdAt,
  };

  return metadata;
}
