/**
 * Prompt Quality Gate — detects common defects in rendered prompt text.
 *
 * Wave 1 (Issue #107): 6 detection categories.
 * Reference: docs/phases/v0.2.2-runtime-reliability/README.md
 */

import { posix } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityGateIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface QualityGateResult {
  passed: boolean;
  issues: QualityGateIssue[];
}

export interface QualityGateContext {
  runId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  hasPrimaryPrompt: boolean;
  allowGenericPrompt: boolean;
  isReadOnly: boolean;
  hasEditPermissions: boolean;
  validArtifactPaths: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FALLBACK_PROMPT_TEXT =
  "No primary Skill Pack prompt was resolved for this step";

const CANONICAL_REPORT_PATH_PREFIX = ".zigma-flow/runs/";

// ---------------------------------------------------------------------------
// Quality gate checks
// ---------------------------------------------------------------------------

/**
 * 1. Unresolved template markers: detect any remaining {{...}} patterns.
 */
function checkUnresolvedMarkers(promptText: string): QualityGateIssue | undefined {
  const unresolved = promptText.match(/\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}/g);
  if (unresolved !== null && unresolved.length > 0) {
    return {
      code: "unresolved_template_markers",
      message: `Prompt contains ${unresolved.length} unresolved template marker(s): ${unresolved.slice(0, 5).join(", ")}${unresolved.length > 5 ? "..." : ""}.`,
      severity: "error",
    };
  }
  return undefined;
}

/**
 * 2. Missing report path: the canonical report path must be present.
 */
function checkMissingReportPath(
  promptText: string,
  context: QualityGateContext,
): QualityGateIssue | undefined {
  const expectedPath = posix.join(
    CANONICAL_REPORT_PATH_PREFIX,
    context.runId,
    "jobs",
    context.jobId,
    "attempts",
    String(context.attempt),
    "steps",
    context.stepId,
    "report.json",
  );
  if (!promptText.includes(expectedPath)) {
    return {
      code: "missing_report_path",
      message: `Prompt does not contain the canonical report path "${expectedPath}".`,
      severity: "error",
    };
  }
  return undefined;
}

/**
 * 3. Missing step instructions: the Workflow Step Prompt section is empty
 *    or contains only the fallback text.
 */
function checkMissingStepInstructions(
  promptText: string,
  context: QualityGateContext,
): QualityGateIssue | undefined {
  const stepSection = extractSection(promptText, "Workflow Step Prompt");
  if (stepSection === undefined) {
    return {
      code: "missing_step_instructions",
      message: "Workflow Step Prompt section is missing from the prompt.",
      severity: "error",
    };
  }

  const trimmed = stepSection.trim();
  if (trimmed.length === 0) {
    return {
      code: "missing_step_instructions",
      message: "Workflow Step Prompt section is empty.",
      severity: "error",
    };
  }

  // Check if the section contains only the fallback text with no actionable instructions.
  // The fallback template is rendered in step-prompt-fallback.md.
  if (trimmed.includes(FALLBACK_PROMPT_TEXT)) {
    // Check if there's additional content beyond the boilerplate
    const boilerplateLines = trimmed.split("\n").filter(
      (line) =>
        line.includes(FALLBACK_PROMPT_TEXT) ||
        line.includes("Current workflow scope") ||
        line.includes("[DEBUG MODE]") ||
        line.includes("Generic fallback active") ||
        line.trim().length === 0,
    );
    if (boilerplateLines.length === trimmed.split("\n").length) {
      return {
        code: "missing_step_instructions",
        message: "Workflow Step Prompt contains only fallback text with no actionable instructions.",
        severity: "error",
      };
    }
  }

  return undefined;
}

/**
 * 4. Read-only/write wording conflict: prompt says "read-only mode"
 *    but also mentions "edits: write" or editing permissions.
 */
function checkReadOnlyWriteConflict(promptText: string): QualityGateIssue | undefined {
  const hasReadOnly = /\bread-only\s*mode\b/i.test(promptText);
  const hasEditWrite = /\bedits\s*:\s*write\b|\*\*edits\*\*/i.test(promptText);

  if (hasReadOnly && hasEditWrite) {
    return {
      code: "read_only_write_conflict",
      message: 'Read-only prompt handoff should not contain an "edits: write" permission.',
      severity: "error",
    };
  }
  return undefined;
}

/**
 * 5. Future artifact leakage: the prompt references artifact paths from
 *    future steps or jobs that haven't been completed yet.
 */
function checkFutureArtifactLeakage(
  promptText: string,
  context: QualityGateContext,
): QualityGateIssue | undefined {
  if (context.validArtifactPaths.length === 0) {
    // No valid paths provided — skip this check
    return undefined;
  }

  const runPathPrefix = `${CANONICAL_REPORT_PATH_PREFIX}${context.runId}/`;
  const pathRegex = new RegExp(
    `${escapeForRegex(runPathPrefix)}(?:[^\\s)"'\`]|\\.(?!\\s))+`,
    "g",
  );
  const foundPaths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(promptText)) !== null) {
    foundPaths.push(match[0]);
  }

  if (foundPaths.length === 0) {
    return undefined;
  }

  // Build set of valid paths (full paths)
  const validFullPaths = new Set<string>();
  for (const p of context.validArtifactPaths) {
    validFullPaths.add(posix.join(CANONICAL_REPORT_PATH_PREFIX, context.runId, p));
  }

  // The current step's canonical report path is always valid
  const currentReportPath = posix.join(
    CANONICAL_REPORT_PATH_PREFIX,
    context.runId,
    "jobs",
    context.jobId,
    "attempts",
    String(context.attempt),
    "steps",
    context.stepId,
    "report.json",
  );
  validFullPaths.add(currentReportPath);

  const leaked = foundPaths.filter((p) => !validFullPaths.has(p));
  if (leaked.length > 0) {
    return {
      code: "future_artifact_leakage",
      message: `Prompt references ${leaked.length} artifact path(s) not in the valid set: ${leaked.slice(0, 3).join(", ")}${leaked.length > 3 ? "..." : ""}.`,
      severity: "error",
    };
  }

  return undefined;
}

/**
 * 6. No-primary-prompt warning: the Workflow Step Prompt section contains
 *    only the generic fallback and no primary prompt was resolved.
 */
function checkNoPrimaryPrompt(
  promptText: string,
  context: QualityGateContext,
): QualityGateIssue | undefined {
  if (context.hasPrimaryPrompt || context.allowGenericPrompt) {
    return undefined;
  }

  const stepSection = extractSection(promptText, "Workflow Step Prompt");
  if (stepSection === undefined) {
    return undefined;
  }

  if (stepSection.includes(FALLBACK_PROMPT_TEXT)) {
    return {
      code: "no_primary_prompt",
      message: "Agent Step has no primary prompt; rendered the generic fallback.",
      severity: "warning",
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export function runQualityGate(
  promptText: string,
  context: QualityGateContext,
): QualityGateResult {
  const issues: QualityGateIssue[] = [];

  const check1 = checkUnresolvedMarkers(promptText);
  if (check1 !== undefined) issues.push(check1);

  const check2 = checkMissingReportPath(promptText, context);
  if (check2 !== undefined) issues.push(check2);

  const check3 = checkMissingStepInstructions(promptText, context);
  if (check3 !== undefined) issues.push(check3);

  const check4 = checkReadOnlyWriteConflict(promptText);
  if (check4 !== undefined) issues.push(check4);

  const check5 = checkFutureArtifactLeakage(promptText, context);
  if (check5 !== undefined) issues.push(check5);

  const check6 = checkNoPrimaryPrompt(promptText, context);
  if (check6 !== undefined) issues.push(check6);

  const errors = issues.filter((i) => i.severity === "error");
  return {
    passed: errors.length === 0,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the content of a Markdown section by title.
 */
function extractSection(markdown: string, title: string): string | undefined {
  const header = new RegExp(`^##\\s+${escapeForRegex(title)}\\s*$`, "m");
  const match = header.exec(markdown);
  if (match === null) {
    return undefined;
  }
  const contentStart = match.index + match[0].length;
  const rest = markdown.slice(contentStart);
  const nextHeader = /^##\s+/m.exec(rest);
  const content = nextHeader === null ? rest : rest.slice(0, nextHeader.index);
  return content.trim();
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
