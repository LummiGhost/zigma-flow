/**
 * Zod schema for the `human-decision.json` artifact written by
 * `recordHumanDecision` in `src/engine/humanGate.ts`.
 *
 * This schema is the audit anchor for a human decision (mvp-contracts §7).
 * Downstream tooling (status commands, review scripts, audit pipelines) should
 * import this schema to validate or parse `human-decision.json` artifacts.
 *
 * Required fields: `decision` (enum), `timestamp` (ISO string).
 * Optional fields: `comment`, `decided_by`, `outputs`.
 *
 * Reference:
 *   - docs/phases/p15-human-gate/02-development-plan.md AD-P15-005
 *   - docs/phases/v0.2.2-runtime-reliability/workflows/wf-v022-humangate/01-cases-and-tests.md FP-V022-HUMANGATE-005
 */

import { z } from "zod";

export const HumanDecisionRecordSchema = z.object({
  /** The human decision outcome. Must be exactly "approved" or "rejected". */
  decision: z.enum(["approved", "rejected"]),
  /** ISO 8601 timestamp when the decision was recorded. */
  timestamp: z.string().min(1),
  /** Optional human-readable comment explaining the decision. */
  comment: z.string().optional(),
  /** Identity of the person who made the decision (informational only; MVP does not enforce identity). */
  decided_by: z.string().optional(),
  /** Optional structured outputs attached to the decision. */
  outputs: z.record(z.string(), z.string()).optional(),
});

export type HumanDecisionRecord = z.infer<typeof HumanDecisionRecordSchema>;
