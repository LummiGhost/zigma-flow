/**
 * Zod schema for the `human-decision.json` artifact written by
 * `recordHumanDecision` in `src/engine/humanGate.ts`.
 *
 * This schema is the audit anchor for a human decision (mvp-contracts §7).
 * Downstream tooling (status commands, review scripts, audit pipelines) should
 * import this schema to validate or parse `human-decision.json` artifacts.
 *
 * Required fields: `decision` (enum), `timestamp` (ISO string).
 * Optional fields: `comment`, `decided_by`, `outputs`, `actor`, `source`,
 * `step_artifact_dir`, `custom_outputs`.
 *
 * Reference:
 *   - docs/phases/p15-human-gate/02-development-plan.md AD-P15-005
 *   - docs/phases/v0.2.2-runtime-reliability/workflows/wf-v022-humangate/01-cases-and-tests.md FP-V022-HUMANGATE-005
 *   - GitHub issue #194 — extended artifact for remote channel audit trail
 */

import { z } from "zod";

/**
 * Structured actor identity recorded in a human decision artifact.
 *
 * Replaces the legacy flat `decided_by` string with a richer identity
 * record that downstream audit tooling can consume without guesswork.
 */
export const DecisionActorSchema = z.object({
  /** Unique actor identifier (provider-agnostic). */
  id: z.string().min(1),
  /** Display name. */
  name: z.string().optional(),
  /** Actor category. */
  type: z.enum(["user", "system", "service"]),
});

export type DecisionActor = z.infer<typeof DecisionActorSchema>;

export const HumanDecisionRecordSchema = z.object({
  /** The human decision outcome. Must be exactly "approved" or "rejected". */
  decision: z.enum(["approved", "rejected"]),
  /** ISO 8601 timestamp when the decision was recorded. */
  timestamp: z.string().min(1),
  /** Optional human-readable comment explaining the decision. */
  comment: z.string().optional(),
  /** Legacy flat decided-by string (kept for backward compatibility). */
  decided_by: z.string().optional(),
  /** Structured actor identity (replaces decided_by for new consumers). */
  actor: DecisionActorSchema.optional(),
  /**
   * Source channel the decision came through.
   *
   * - `"cli"` — local CLI command (zigma-flow approve/reject)
   * - `"api"` — Host API (programmatic call)
   * - `"email"` — email-based approval link
   * - `"web"` — web UI / dashboard
   */
  source: z.enum(["cli", "api", "email", "web"]).optional(),
  /** Optional structured outputs attached to the decision. */
  outputs: z.record(z.string(), z.string()).optional(),
  /** Optional custom key-value outputs (alias for outputs in newer artifacts). */
  custom_outputs: z.record(z.string(), z.string()).optional(),
  /** Relative POSIX-style path to the step artifact directory within the run dir. */
  step_artifact_dir: z.string().optional(),
});

export type HumanDecisionRecord = z.infer<typeof HumanDecisionRecordSchema>;
