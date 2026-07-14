/**
 * Shared evidence types for the evidence bundle system.
 *
 * These types align with the Host API contracts in `src/host-api.ts`
 * (HostApiCollectEvidenceResult, RunEvidenceSummary, etc.) so the bundle
 * can be returned directly from the Host API layer without transformation.
 *
 * Reference: GitHub issues #189, #196, #197
 */

import type { Decision } from "../host-api.js";

// ---------------------------------------------------------------------------
// EventEvidenceEntry
// ---------------------------------------------------------------------------

/**
 * A single event entry in the evidence bundle.
 *
 * A filtered subset of the full ZigmaFlowEvent envelope — includes only
 * the common envelope fields plus a payload summary.
 */
export interface EventEvidenceEntry {
  /** Event identifier (e.g. "evt-042"). */
  id: string;
  /** Event type tag. */
  type: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Component that emitted the event. */
  producer: string;
  /** Associated job, if any. */
  job?: string;
  /** Associated step, if any. */
  step?: string;
  /** Attempt number, if applicable. */
  attempt?: number;
  /** Serialisable snapshot of the event payload. */
  payloadSummary: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ArtifactIndexEntry
// ---------------------------------------------------------------------------

/**
 * A single entry from the artifact index, included in the evidence bundle.
 */
export interface ArtifactIndexEntry {
  /** Artifact identifier. */
  id: string;
  /** Artifact kind (e.g. "human_gate_request", "agent_report", "script_output"). */
  kind: string;
  /** Relative POSIX-style path to the artifact file within the run directory. */
  path: string;
  /** MIME content type. */
  contentType: string;
  /** Size in bytes. */
  size: number;
  /** Short summary / first line of artifact content. */
  summary: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// ValidationEvidence
// ---------------------------------------------------------------------------

/**
 * Evidence from a check-type step execution.
 */
export interface ValidationEvidence {
  /** Check identifier (matches the step definition's check id). */
  checkId: string;
  /** Job that ran the check. */
  jobId: string;
  /** Step that ran the check. */
  stepId: string;
  /** Whether the check passed. */
  passed: boolean;
  /** Failure messages if the check did not pass. */
  failures?: string[];
  /** ISO 8601 timestamp of the check execution. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// HumanDecisionEvidence
// ---------------------------------------------------------------------------

/**
 * Evidence from a recorded human gate decision.
 *
 * Extended from the Host API's HumanDecisionEvidence with the optional
 * `actor` and `source` fields for richer audit trails.
 */
export interface HumanDecisionEvidence {
  /** Job containing the human gate step. */
  jobId: string;
  /** Gated step. */
  stepId: string;
  /** The decision rendered. */
  decision: Decision;
  /** Optional comment from the reviewer. */
  comment?: string;
  /** Legacy flat identity of the reviewer, if recorded. */
  decidedBy?: string;
  /** Structured actor identity (v0.5+). */
  actor?: {
    id: string;
    name?: string;
    type: "user" | "system" | "service";
  };
  /** Source channel the decision came through (v0.5+). */
  source?: "cli" | "api" | "email" | "web";
  /** ISO 8601 timestamp of the decision. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// KnownRisk
// ---------------------------------------------------------------------------

/**
 * A known risk identified during run execution.
 *
 * Risks are surfaced by the engine when it detects conditions that do not
 * cause outright failure but may warrant operator attention (e.g. agent
 * timeouts, partial traverse failures, skipped steps due to conditions).
 */
export interface KnownRisk {
  /** Risk identifier (stable within the run). */
  riskId: string;
  /** Severity classification. */
  severity: "low" | "medium" | "high";
  /** Human-readable description of the risk. */
  description: string;
  /** Optional mitigation or recommended follow-up action. */
  mitigation?: string;
}

// ---------------------------------------------------------------------------
// EvidenceBundle
// ---------------------------------------------------------------------------

/**
 * High-level summary of a run for the evidence bundle.
 *
 * Derived from the run state snapshot and event log metadata.
 */
export interface EvidenceBundleSummary {
  /** Run identifier. */
  runId: string;
  /** Workflow name. */
  workflow: string;
  /** Task description. */
  task: string;
  /** Final run status. */
  status: "running" | "blocked" | "failed" | "completed" | "cancelled";
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 completion/cancellation/failure timestamp, if terminal. */
  completedAt?: string;
  /** Total number of jobs defined in the workflow. */
  totalJobs: number;
  /** Number of jobs that reached "completed" status. */
  completedJobs: number;
  /** Number of jobs that reached "failed" status. */
  failedJobs: number;
  /** Total number of events in the run's event log. */
  totalEvents: number;
}

/**
 * Complete evidence bundle for a run.
 *
 * Matches the Host API `HostApiCollectEvidenceResult` contract so the Host
 * layer can return this bundle directly without transformation.
 */
export interface EvidenceBundle {
  /** Top-level run summary. */
  summary: EvidenceBundleSummary;
  /** Filtered event log entries (all events, redacted to envelope + payload). */
  events: EventEvidenceEntry[];
  /** All artifact index entries. */
  artifacts: ArtifactIndexEntry[];
  /** Validation results from check-type steps. */
  validation: ValidationEvidence[];
  /** Recorded human gate decisions. */
  humanDecisions: HumanDecisionEvidence[];
  /** Known risks surfaced by the engine. */
  knownRisks: KnownRisk[];
}
