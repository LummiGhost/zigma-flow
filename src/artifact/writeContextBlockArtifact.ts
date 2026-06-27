/**
 * Write a versioned context block artifact to disk.
 *
 * Path: <runDir>/context-blocks/<blockId>/v<version>.md
 * Returns fully-populated ArtifactMetadata with kind="context_block".
 *
 * WF-P13-VARIABLES (AD-P13-011).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import type { ArtifactMetadata } from "./artifactMetadata.js";
import { assertPathSafe } from "./artifactPaths.js";

// Clock shape matches writeArtifact.Clock — same interface, same name,
// re-exported from the barrel via writeArtifact.js.
export interface Clock {
  now(): string;
}

export interface WriteContextBlockArtifactOpts {
  runDir: string;
  runId: string;
  blockId: string;
  version: number;
  content: string;
  job: string;
  step: string;
  attempt: number;
  clock: Clock;
}

/**
 * Write a context block artifact to disk and return its metadata.
 *
 * - Creates the context-blocks/<blockId>/ directory recursively.
 * - Writes content to context-blocks/<blockId>/v<version>.md
 * - Returns ArtifactMetadata with kind="context_block"
 * - Does NOT append to the artifact index (caller responsibility).
 */
export async function writeContextBlockArtifact(
  opts: WriteContextBlockArtifactOpts
): Promise<ArtifactMetadata> {
  const { runDir, runId, blockId, version, content, job, step, attempt, clock } = opts;

  const filename = `v${version}.md`;
  const relPath = posix.join("context-blocks", blockId, filename);
  assertPathSafe(runDir, relPath);

  const blockDir = join(runDir, "context-blocks", blockId);
  const fullPath = join(blockDir, filename);

  await mkdir(blockDir, { recursive: true });
  await writeFile(fullPath, content, "utf-8");

  const size = Buffer.byteLength(content, "utf-8");
  const createdAt = clock.now();

  const artifactId = `artifact://${runId}/context-blocks/${blockId}/v${version}`;

  const metadata: ArtifactMetadata = {
    id: artifactId,
    run_id: runId,
    producer: { job, step, attempt },
    kind: "context_block",
    path: relPath,
    content_type: "text/markdown",
    size,
    summary: `Context block "${blockId}" version ${version}`,
    created_at: createdAt,
  };

  return metadata;
}
