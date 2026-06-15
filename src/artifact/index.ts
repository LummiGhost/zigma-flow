/**
 * Artifact module — public API.
 *
 * Reference: docs/mvp-contracts.md §2.5
 * WF-P4-ARTIFACT Step 2.
 */

export {
  artifactId,
  type ArtifactMetadata,
  type ArtifactProducer,
} from "./artifactMetadata.js";

export {
  appendArtifactIndex,
} from "./artifactIndex.js";

export {
  artifactFileRelativePath,
  artifactPath,
  artifactStepRelativePath,
  artifactStepDir,
  assertPathSafe,
} from "./artifactPaths.js";

export {
  writeArtifact,
  type Clock,
  type WriteArtifactOpts,
} from "./writeArtifact.js";
