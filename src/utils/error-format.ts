/**
 * Step 2 (Implementation): Error formatting utility.
 *
 * Formats a ZigmaFlowError into a structured, human-readable string
 * for stderr output. See docs/error-codes.md for the output contract.
 */

import type { ZigmaFlowError } from "./errors.js";

/**
 * Formats a ZigmaFlowError for CLI stderr output.
 *
 * Output format:
 * ```
 * Error [<Kind>]: <message>
 *   Exit code: <N>
 *   Run: <runId>        (when present)
 *   Job: <jobId>         (when present)
 *   Step: <stepId>       (when present)
 *   Artifact: <artifactPath>  (when present)
 *   Suggestion: <suggestion>  (when present, always last)
 * ```
 *
 * Context fields appear in a consistent order: Run, Job, Step, Artifact, Suggestion.
 * Unknown detail keys are silently omitted.
 * When no details are provided, only kind/message and exit code are printed.
 */
export function formatError(error: ZigmaFlowError): string {
  const lines: string[] = [];

  // First line: Error [<Kind>]: <message>
  lines.push(`Error [${error.kind}]: ${error.message}`);

  // Exit code line
  lines.push(`  Exit code: ${error.exitCode}`);

  // Context fields from details (only when present and non-null/undefined)
  const details = error.details ?? {};

  if (details.runId != null) {
    lines.push(`  Run: ${String(details.runId)}`);
  }
  if (details.jobId != null) {
    lines.push(`  Job: ${String(details.jobId)}`);
  }
  if (details.stepId != null) {
    lines.push(`  Step: ${String(details.stepId)}`);
  }
  if (details.artifactPath != null) {
    lines.push(`  Artifact: ${String(details.artifactPath)}`);
  }

  // Suggestion (always last, if present)
  if (error.suggestion != null) {
    lines.push(`  Suggestion: ${error.suggestion}`);
  }

  return lines.join("\n");
}
