/**
 * Evidence module — public API.
 *
 * Provides evidence bundle collection and rendering adapters for
 * audit-ready output from completed or in-progress runs.
 *
 * Reference: GitHub issues #189, #196, #197
 */

export { collectEvidence } from "./bundle.js";
export {
  renderEmailSummary,
  renderPrDescription,
  renderIssueComment,
  renderAuditReport,
} from "./adapters.js";

export type {
  EvidenceBundle,
  EvidenceBundleSummary,
  EventEvidenceEntry,
  ArtifactIndexEntry,
  ValidationEvidence,
  HumanDecisionEvidence,
  KnownRisk,
} from "./types.js";
