/**
 * Evidence bundle collection for Zigma Flow v0.5.
 *
 * Provides a programmatic (non-CLI) entry point that assembles an audit-ready
 * evidence bundle from a completed or in-progress run directory. The bundle
 * aggregates state snapshot, event log, artifact index, human gate decisions,
 * and check validation results into a single structured record.
 *
 * Importable by:
 *  - Host API layer (collectRunEvidence)
 *  - CLI status/export commands
 *  - Adapter formatters (src/evidence/adapters.ts)
 *  - Test harnesses
 *
 * Reference: GitHub issues #189, #196
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { RunState } from "../run/index.js";
import type { ZigmaFlowEvent } from "../events/eventTypes.js";
import type { ArtifactMetadata } from "../artifact/artifactMetadata.js";
import type {
  EvidenceBundle,
  EvidenceBundleSummary,
  EventEvidenceEntry,
  ArtifactIndexEntry,
  ValidationEvidence,
  HumanDecisionEvidence,
  KnownRisk,
} from "./types.js";

// Re-export types for consumers.
export type {
  EvidenceBundle,
  EvidenceBundleSummary,
  EventEvidenceEntry,
  ArtifactIndexEntry,
  ValidationEvidence,
  HumanDecisionEvidence,
  KnownRisk,
} from "./types.js";

// ---------------------------------------------------------------------------
// collectEvidence
// ---------------------------------------------------------------------------

/**
 * Assemble an evidence bundle from a run directory.
 *
 * Reads the following files from `runDir`:
 *   - `state.json` — run state snapshot
 *   - `events.jsonl` — event log
 *   - `artifacts.jsonl` — artifact index
 *   - `jobs/{job}/attempts/{n}/steps/{step}/human-decision.json` — human gate decisions
 *
 * Check results are extracted from `check_completed` events in the event log.
 *
 * The function is pure-ish: it performs filesystem reads but does not modify
 * any run state. It can be called on running, completed, or failed runs.
 *
 * @param runDir - Absolute path to the run directory.
 * @param runId - Run identifier (used for metadata, not path resolution).
 * @returns A complete evidence bundle.
 */
export async function collectEvidence(
  runDir: string,
  runId: string,
): Promise<EvidenceBundle> {
  // 1. Read state snapshot
  const state = await readRunState(runDir);

  // 2. Read all events
  const events = await readEvents(runDir);

  // 3. Read all artifact index entries
  const artifacts = await readArtifactIndex(runDir);

  // 4. Read all human-decision.json files
  const humanDecisions = await readHumanDecisions(runDir);

  // 5. Extract validation evidence from check_completed events
  const validation = extractValidationEvidence(events);

  // 6. Build summary
  const summary = buildSummary(state, events);

  // 7. Identify known risks
  const knownRisks = identifyKnownRisks(state, events);

  return {
    summary,
    events: events.map(toEventEvidenceEntry),
    artifacts,
    validation,
    humanDecisions,
    knownRisks,
  };
}

// ---------------------------------------------------------------------------
// Internal: readRunState
// ---------------------------------------------------------------------------

async function readRunState(runDir: string): Promise<RunState> {
  const statePath = join(runDir, "state.json");
  let raw: string;
  try {
    raw = await readFile(statePath, "utf-8");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Cannot read state.json in ${runDir}: ${msg}`);
  }

  try {
    return JSON.parse(raw) as RunState;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`state.json contains invalid JSON in ${runDir}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Internal: readEvents
// ---------------------------------------------------------------------------

async function readEvents(runDir: string): Promise<ZigmaFlowEvent[]> {
  const eventsPath = join(runDir, "events.jsonl");
  let raw: string;
  try {
    raw = await readFile(eventsPath, "utf-8");
  } catch (_e: unknown) {
    // events.jsonl may not exist for a freshly created run with no events yet
    return [];
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as ZigmaFlowEvent);
}

// ---------------------------------------------------------------------------
// Internal: readArtifactIndex
// ---------------------------------------------------------------------------

async function readArtifactIndex(runDir: string): Promise<ArtifactIndexEntry[]> {
  const indexPath = join(runDir, "artifacts.jsonl");
  let raw: string;
  try {
    raw = await readFile(indexPath, "utf-8");
  } catch (_e: unknown) {
    return [];
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => {
    const meta = JSON.parse(line) as ArtifactMetadata;
    return {
      id: meta.id,
      kind: meta.kind,
      path: meta.path,
      contentType: meta.content_type,
      size: meta.size,
      summary: meta.summary,
      createdAt: meta.created_at,
    };
  });
}

// ---------------------------------------------------------------------------
// Internal: readHumanDecisions
// ---------------------------------------------------------------------------

/**
 * Recursively discover and read all `human-decision.json` files under the
 * run directory's `jobs/` subtree.
 */
async function readHumanDecisions(
  runDir: string,
): Promise<HumanDecisionEvidence[]> {
  const results: HumanDecisionEvidence[] = [];
  const jobsDir = join(runDir, "jobs");

  let jobDirs: string[];
  try {
    const entries = await readdir(jobsDir, { withFileTypes: true });
    jobDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return results;
  }

  for (const jobId of jobDirs) {
    const attemptsDir = join(jobsDir, jobId, "attempts");
    let attemptDirs: string[];
    try {
      const entries = await readdir(attemptsDir, { withFileTypes: true });
      attemptDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }

    for (const attemptName of attemptDirs) {
      const stepsDir = join(attemptsDir, attemptName, "steps");
      let stepDirs: string[];
      try {
        const entries = await readdir(stepsDir, { withFileTypes: true });
        stepDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        continue;
      }

      for (const stepId of stepDirs) {
        const decisionPath = join(stepsDir, stepId, "human-decision.json");
        try {
          const raw = await readFile(decisionPath, "utf-8");
          const record = JSON.parse(raw) as {
            decision: string;
            timestamp?: string;
            comment?: string;
            decided_by?: string;
            actor?: { id: string; name?: string; type: string };
            source?: string;
          };

          const base: HumanDecisionEvidence = {
            jobId,
            stepId,
            decision: record.decision as HumanDecisionEvidence["decision"],
            timestamp: record.timestamp ?? "",
          };

          // Conditionally add optional fields (exactOptionalPropertyTypes compat)
          const mutable = base as unknown as Record<string, unknown>;
          if (record.comment !== undefined) {
            mutable["comment"] = record.comment;
          }
          if (record.decided_by !== undefined) {
            mutable["decidedBy"] = record.decided_by;
          }
          if (record.actor !== undefined) {
            const actorEntry: HumanDecisionEvidence["actor"] = {
              id: record.actor.id,
              type: record.actor.type as "user" | "system" | "service",
            };
            if (record.actor.name !== undefined) {
              actorEntry.name = record.actor.name;
            }
            mutable["actor"] = actorEntry;
          }
          if (
            record.source === "cli" ||
            record.source === "api" ||
            record.source === "email" ||
            record.source === "web"
          ) {
            mutable["source"] = record.source;
          }

          results.push(base);
        } catch {
          // Skip unparseable decision files
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal: extractValidationEvidence
// ---------------------------------------------------------------------------

function extractValidationEvidence(
  events: ZigmaFlowEvent[],
): ValidationEvidence[] {
  return events
    .filter(
      (e): e is ZigmaFlowEvent & { type: "check_completed" } =>
        e.type === "check_completed",
    )
    .map((e) => {
      const entry: ValidationEvidence = {
        checkId: String(e.payload.check_id ?? ""),
        jobId: e.job ?? "",
        stepId: e.step ?? "",
        passed: Boolean(e.payload.passed),
        timestamp: e.timestamp,
      };
      if (Array.isArray(e.payload.failures) && e.payload.failures.length > 0) {
        entry.failures = e.payload.failures.map(String);
      }
      return entry;
    });
}

// ---------------------------------------------------------------------------
// Internal: buildSummary
// ---------------------------------------------------------------------------

function buildSummary(
  state: RunState,
  events: ZigmaFlowEvent[],
): EvidenceBundleSummary {
  const jobIds = Object.keys(state.jobs);
  const totalJobs = jobIds.length;
  const completedJobs = jobIds.filter(
    (id) => state.jobs[id]!.status === "completed",
  ).length;
  const failedJobs = jobIds.filter(
    (id) => state.jobs[id]!.status === "failed",
  ).length;

  // Derive completedAt from the last terminal event
  let completedAt: string | undefined;
  const terminalTypes = new Set([
    "run_completed",
    "run_failed",
    "run_cancelled",
  ]);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (terminalTypes.has(e.type as string)) {
      completedAt = e.timestamp;
      break;
    }
  }

  const summary: EvidenceBundleSummary = {
    runId: state.run_id,
    workflow: state.workflow,
    task: state.task,
    status: (state.status as EvidenceBundleSummary["status"]) ?? "running",
    createdAt: state.created_at,
    totalJobs,
    completedJobs,
    failedJobs,
    totalEvents: events.length,
  };
  if (completedAt !== undefined) {
    summary.completedAt = completedAt;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Internal: identifyKnownRisks
// ---------------------------------------------------------------------------

function identifyKnownRisks(
  state: RunState,
  events: ZigmaFlowEvent[],
): KnownRisk[] {
  const risks: KnownRisk[] = [];

  // Risk: jobs in failed status
  for (const [jobId, jobState] of Object.entries(state.jobs)) {
    if (jobState.status === "failed") {
      risks.push({
        riskId: `failed-job-${jobId}`,
        severity: "high",
        description: `Job "${jobId}" failed.`,
        mitigation: "Investigate the failure reason and retry or re-run.",
      });
    }
  }

  // Risk: agent timeouts
  const agentTimeouts = events.filter((e) => e.type === "agent_timed_out");
  if (agentTimeouts.length > 0) {
    risks.push({
      riskId: "agent-timeouts",
      severity: "medium",
      description: `${agentTimeouts.length} agent timeout(s) detected.`,
      mitigation:
        "Increase timeout_ms on affected steps or optimize agent prompts.",
    });
  }

  // Risk: step visit exceeded
  const visitExceeded = events.filter(
    (e) => e.type === "step_visit_exceeded",
  );
  if (visitExceeded.length > 0) {
    risks.push({
      riskId: "step-visit-exceeded",
      severity: "high",
      description: `${visitExceeded.length} step visit exceed event(s).`,
      mitigation:
        "Check step loop conditions and max_visits configuration.",
    });
  }

  // Risk: traverse item failures
  const traverseItemFailures = events.filter(
    (e) => e.type === "traverse_item_failed",
  );
  if (traverseItemFailures.length > 0) {
    risks.push({
      riskId: "traverse-item-failures",
      severity: "medium",
      description: `${traverseItemFailures.length} traverse item failure(s).`,
      mitigation:
        "Check traverse on_item_failure policy and review failed items.",
    });
  }

  // Risk: run blocked
  if (state.status === "blocked") {
    risks.push({
      riskId: "run-blocked",
      severity: "medium",
      description: "Run is in blocked status.",
      mitigation: "Resolve blocking conditions and resume the run.",
    });
  }

  return risks;
}

// ---------------------------------------------------------------------------
// Internal: toEventEvidenceEntry
// ---------------------------------------------------------------------------

function toEventEvidenceEntry(event: ZigmaFlowEvent): EventEvidenceEntry {
  const entry: EventEvidenceEntry = {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    producer: event.producer,
    payloadSummary: event.payload as Record<string, unknown>,
  };
  if (event.job !== null && event.job !== undefined) {
    entry.job = event.job;
  }
  if (event.step !== null && event.step !== undefined) {
    entry.step = event.step;
  }
  if (event.attempt !== null && event.attempt !== undefined) {
    entry.attempt = event.attempt;
  }
  return entry;
}
