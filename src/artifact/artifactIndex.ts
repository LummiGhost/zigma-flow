/**
 * Artifact index — append-only JSONL index at <runDir>/artifacts.jsonl.
 *
 * Reference: docs/mvp-contracts.md §2.5
 * WF-P4-ARTIFACT Step 2.
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactMetadata } from "./artifactMetadata.js";

/**
 * Append a single `ArtifactMetadata` record to `<runDir>/artifacts.jsonl`.
 * Creates the file on first call (append mode is idempotent).
 */
export async function appendArtifactIndex(
  runDir: string,
  metadata: ArtifactMetadata
): Promise<void> {
  const indexPath = join(runDir, "artifacts.jsonl");
  await appendFile(indexPath, JSON.stringify(metadata) + "\n", "utf-8");
}
