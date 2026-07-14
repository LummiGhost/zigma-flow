/**
 * Evidence bundle rendering adapters for Zigma Flow v0.5.
 *
 * Each adapter is a pure function that takes an {@link EvidenceBundle} and
 * returns a formatted string suitable for a specific use case. Adapters do
 * NOT perform I/O, send emails, create PRs, or post comments — they only
 * format the evidence data into the appropriate text representation.
 *
 * Reference: GitHub issue #197
 */

import type { EvidenceBundle } from "./types.js";

// ---------------------------------------------------------------------------
// renderEmailSummary
// ---------------------------------------------------------------------------

/**
 * Render a plain text summary suitable for an email notification body.
 *
 * Includes the run status, key metrics, a timeline of major events, and
 * a summary of human decisions and validation results.
 *
 * @param bundle - The evidence bundle to render.
 * @returns A plain text string suitable for email body.
 */
export function renderEmailSummary(bundle: EvidenceBundle): string {
  const s = bundle.summary;
  const lines: string[] = [];

  lines.push(`Zigma Flow Run: ${s.runId}`);
  lines.push(`Workflow: ${s.workflow}`);
  lines.push(`Task: ${s.task}`);
  lines.push(`Status: ${s.status}`);
  lines.push(`Created: ${s.createdAt}`);
  if (s.completedAt) {
    lines.push(`Completed: ${s.completedAt}`);
  }
  lines.push("");
  lines.push(`Jobs: ${s.completedJobs}/${s.totalJobs} completed`);
  if (s.failedJobs > 0) {
    lines.push(`Failed Jobs: ${s.failedJobs}`);
  }
  lines.push(`Events: ${s.totalEvents}`);
  lines.push("");

  // Human decisions
  if (bundle.humanDecisions.length > 0) {
    lines.push("--- Human Decisions ---");
    for (const d of bundle.humanDecisions) {
      const who =
        d.actor?.name ?? d.decidedBy ?? d.actor?.id ?? "unknown";
      const src = d.source ? ` (via ${d.source})` : "";
      lines.push(`  ${d.jobId}/${d.stepId}: ${d.decision} by ${who}${src}`);
      if (d.comment) {
        lines.push(`    Comment: ${d.comment}`);
      }
    }
    lines.push("");
  }

  // Validation results
  if (bundle.validation.length > 0) {
    const passed = bundle.validation.filter((v) => v.passed).length;
    const failed = bundle.validation.length - passed;
    lines.push("--- Validation ---");
    lines.push(`  Passed: ${passed}, Failed: ${failed}`);
    for (const v of bundle.validation) {
      const status = v.passed ? "PASS" : "FAIL";
      lines.push(`  ${status} ${v.checkId} (${v.jobId}/${v.stepId})`);
      if (v.failures && v.failures.length > 0) {
        for (const f of v.failures) {
          lines.push(`    - ${f}`);
        }
      }
    }
    lines.push("");
  }

  // Known risks
  if (bundle.knownRisks.length > 0) {
    lines.push("--- Known Risks ---");
    for (const r of bundle.knownRisks) {
      lines.push(`  [${r.severity.toUpperCase()}] ${r.description}`);
      if (r.mitigation) {
        lines.push(`    Mitigation: ${r.mitigation}`);
      }
    }
    lines.push("");
  }

  // Timeline (major events)
  const majorTypes = new Set([
    "run_created",
    "run_completed",
    "run_failed",
    "run_cancelled",
    "run_blocked",
    "job_ready",
    "job_completed",
    "job_failed",
    "human_gate_waiting",
    "human_decision",
  ]);
  const majorEvents = bundle.events.filter((e) => majorTypes.has(e.type));
  if (majorEvents.length > 0) {
    lines.push("--- Event Timeline ---");
    for (const e of majorEvents) {
      const jobLabel = e.job ? ` [${e.job}]` : "";
      lines.push(`  ${e.timestamp} ${e.type}${jobLabel}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// renderPrDescription
// ---------------------------------------------------------------------------

/**
 * Render a markdown string suitable for a GitHub Pull Request description.
 *
 * Summarizes the run outcome, decision log, validation results, and
 * known risks in a format that fits a PR body.
 *
 * @param bundle - The evidence bundle to render.
 * @returns A markdown string suitable for a PR description.
 */
export function renderPrDescription(bundle: EvidenceBundle): string {
  const s = bundle.summary;
  const lines: string[] = [];

  // Header
  lines.push("## Zigma Flow Run Evidence");
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| **Run ID** | \`${s.runId}\` |`);
  lines.push(`| **Workflow** | ${s.workflow} |`);
  lines.push(`| **Task** | ${s.task} |`);
  lines.push(`| **Status** | ${statusBadge(s.status)} |`);
  lines.push(`| **Jobs** | ${s.completedJobs}/${s.totalJobs} completed |`);
  if (s.failedJobs > 0) {
    lines.push(`| **Failed Jobs** | ${s.failedJobs} |`);
  }
  lines.push(`| **Events** | ${s.totalEvents} |`);
  lines.push(`| **Created** | ${s.createdAt} |`);
  if (s.completedAt) {
    lines.push(`| **Completed** | ${s.completedAt} |`);
  }
  lines.push("");

  // Human decisions
  if (bundle.humanDecisions.length > 0) {
    lines.push("### Human Decisions");
    lines.push("");
    lines.push(
      "| Job | Step | Decision | By | Source | Comment |",
    );
    lines.push(
      "|-----|------|----------|----|--------|---------|",
    );
    for (const d of bundle.humanDecisions) {
      const who =
        d.actor?.name ?? d.decidedBy ?? d.actor?.id ?? "unknown";
      const src = d.source ?? "-";
      const comment = d.comment ?? "-";
      lines.push(
        `| \`${d.jobId}\` | \`${d.stepId}\` | ${d.decision} | ${who} | ${src} | ${comment} |`,
      );
    }
    lines.push("");
  }

  // Validation results
  if (bundle.validation.length > 0) {
    lines.push("### Validation Results");
    lines.push("");
    lines.push(
      "| Check | Job | Step | Result | Failures |",
    );
    lines.push(
      "|-------|-----|------|--------|----------|",
    );
    for (const v of bundle.validation) {
      const result = v.passed ? "Passed" : "Failed";
      const failures = v.failures?.join(", ") ?? "-";
      lines.push(
        `| \`${v.checkId}\` | \`${v.jobId}\` | \`${v.stepId}\` | ${result} | ${failures} |`,
      );
    }
    lines.push("");
  }

  // Known risks
  if (bundle.knownRisks.length > 0) {
    lines.push("### Known Risks");
    lines.push("");
    for (const r of bundle.knownRisks) {
      const icon =
        r.severity === "high"
          ? "!  "
          : r.severity === "medium"
            ? "!! "
            : "⚠️ ";
      lines.push(`- ${icon}**${r.severity.toUpperCase()}**: ${r.description}`);
      if (r.mitigation) {
        lines.push(`  - Mitigation: ${r.mitigation}`);
      }
    }
    lines.push("");
  }

  // Artifacts
  if (bundle.artifacts.length > 0) {
    lines.push("### Artifacts");
    lines.push("");
    lines.push(
      "| Kind | Path | Size | Created |",
    );
    lines.push(
      "|------|------|------|---------|",
    );
    for (const a of bundle.artifacts) {
      const sizeKiB = (a.size / 1024).toFixed(1);
      lines.push(
        `| ${a.kind} | \`${a.path}\` | ${sizeKiB} KiB | ${a.createdAt} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// renderIssueComment
// ---------------------------------------------------------------------------

/**
 * Render a concise markdown string suitable for a GitHub Issue comment.
 *
 * Provides a compact summary focused on the run outcome, decisions, and
 * actionable items (failures, risks).
 *
 * @param bundle - The evidence bundle to render.
 * @returns A concise markdown string for an issue comment.
 */
export function renderIssueComment(bundle: EvidenceBundle): string {
  const s = bundle.summary;
  const lines: string[] = [];

  lines.push(
    `**Zigma Flow Run \`${s.runId}\`** — ${s.workflow} — ${statusBadge(s.status)}`,
  );
  lines.push("");

  if (bundle.humanDecisions.length > 0) {
    lines.push("**Decisions:**");
    for (const d of bundle.humanDecisions) {
      const who =
        d.actor?.name ?? d.decidedBy ?? d.actor?.id ?? "unknown";
      lines.push(
        `- ${d.jobId}/${d.stepId}: **${d.decision}** by ${who}${d.comment ? ` — ${d.comment}` : ""}`,
      );
    }
    lines.push("");
  }

  // Validation failures (focus on failures only for conciseness)
  const failures = bundle.validation.filter((v) => !v.passed);
  if (failures.length > 0) {
    lines.push("**Validation Failures:**");
    for (const v of failures) {
      lines.push(
        `- \`${v.checkId}\` in ${v.jobId}/${v.stepId}: ${(v.failures ?? ["check failed"]).join("; ")}`,
      );
    }
    lines.push("");
  }

  // Known risks
  if (bundle.knownRisks.length > 0) {
    lines.push("**Risks:**");
    for (const r of bundle.knownRisks) {
      lines.push(
        `- [${r.severity}] ${r.description}${r.mitigation ? ` — ${r.mitigation}` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push(
    `_${s.completedJobs}/${s.totalJobs} jobs completed, ${s.failedJobs} failed, ${s.totalEvents} events_`,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// renderAuditReport
// ---------------------------------------------------------------------------

/**
 * Render a full JSON audit report from the evidence bundle.
 *
 * Produces a complete, machine-readable audit record suitable for
 * persistence, compliance review, or downstream analysis. The output
 * includes every event, artifact, decision, validation result, and
 * known risk in the bundle.
 *
 * @param bundle - The evidence bundle to render.
 * @returns A formatted JSON string (pretty-printed, 2-space indent).
 */
export function renderAuditReport(bundle: EvidenceBundle): string {
  const report = {
    audit_report_version: "0.5.0",
    generated_at: new Date().toISOString(),
    bundle: {
      summary: bundle.summary,
      eventCount: bundle.events.length,
      artifactCount: bundle.artifacts.length,
      validationCount: bundle.validation.length,
      decisionCount: bundle.humanDecisions.length,
      riskCount: bundle.knownRisks.length,
    },
    summary: bundle.summary,
    events: bundle.events,
    artifacts: bundle.artifacts,
    validation: bundle.validation,
    humanDecisions: bundle.humanDecisions,
    knownRisks: bundle.knownRisks,
  };

  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadge(status: string): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "blocked":
      return "Blocked";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}
