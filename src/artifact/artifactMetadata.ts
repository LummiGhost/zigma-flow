/**
 * Artifact metadata types and id generator.
 *
 * Reference: docs/mvp-contracts.md §2.5
 * WF-P4-ARTIFACT Step 2.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArtifactProducer {
  job: string;
  step: string;
  attempt: number;
}

export interface ArtifactMetadata {
  id: string;
  run_id: string;
  producer: ArtifactProducer;
  kind: string;
  path: string;           // relative POSIX-style path from run directory
  content_type: string;
  size: number;
  summary: string;
  created_at: string;     // ISO 8601
}

// ---------------------------------------------------------------------------
// artifactId — generates the artifact:// URI
// ---------------------------------------------------------------------------

/**
 * Generate a canonical artifact id URI.
 *
 * The id encodes the full path hierarchy without the file extension
 * so the id is stable regardless of how the file is named on disk.
 *
 * Example:
 *   artifactId("20260608-0001", "j", 1, "s", "stdout.log")
 *   → "artifact://20260608-0001/jobs/j/attempts/1/steps/s/stdout"
 */
export function artifactId(
  runId: string,
  job: string,
  attempt: number,
  step: string,
  filename: string
): string {
  // Strip extension from filename for the id stem.
  const dotIndex = filename.lastIndexOf(".");
  const stem = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  return `artifact://${runId}/jobs/${job}/attempts/${attempt}/steps/${step}/${stem}`;
}
