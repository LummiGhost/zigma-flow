/**
 * Capability-based model routing (Issue #286 Phase 1).
 *
 * Pure module: no IO, no workflow/engine imports. The engine calls
 * `routeModel` before backend resolution; the returned profile (when any) is
 * merged into an effective step-backend override via
 * `buildEffectiveBackendOverride` so the existing backend resolution chain
 * stays unchanged.
 *
 * Phase 2 (Accepted Artifact Cost optimization) will replace the
 * filter-then-first-match pick with an economics-aware preference function;
 * `capabilities` on profiles is reserved for that phase.
 */

import type { StepBackendOverride } from "./config.js";
import { ModelRoutingError } from "../utils/index.js";

export type CostClass = "low" | "medium" | "high";
export type DataClassification = "public" | "internal" | "confidential" | "restricted";

const CLASS_ORDER: Record<CostClass, number> = { low: 0, medium: 1, high: 2 };

export interface StepModelConstraints {
  /** Hard constraint: the selected model's profile must serve this data classification. */
  data_classification?: DataClassification;
  /** Hard constraint: every region must be covered by the profile (subset semantics). */
  regions?: string[];
  /** Hard constraint: the profile must declare local execution. */
  local_required?: boolean;
  /** Soft constraint: profile cost class must be at most this class (low < medium < high). */
  max_cost_class?: CostClass;
  /** Soft constraint: profile latency class must be at most this class. */
  max_latency_class?: CostClass;
}

export interface ModelProfileDefinition {
  /** Model id (e.g. "claude-sonnet-4-6"). */
  model: string;
  /** Named backend this model runs on (optional; only applied when the step pins none). */
  backend?: string;
  /** Reserved capability map — not matched in Phase 1. */
  capabilities?: Record<string, unknown>;
  /** Economics class. Omitted = "high" (most conservative). */
  cost_class?: CostClass;
  /** Latency class. Omitted = "high". */
  latency_class?: CostClass;
  /** Data classifications this model may serve. Omitted = serves none. */
  data_classification?: DataClassification[];
  /** Regions this model may run in. Omitted = no region coverage. */
  regions?: string[];
  /** Whether this model runs locally. Omitted = false. */
  local_required?: boolean;
}

export interface ModelProfileCandidate extends ModelProfileDefinition {
  /** Registry key from the workflow `models:` block. */
  name: string;
}

export interface ModelRouteInput {
  /** Workflow model registry entries in declaration order. */
  candidates: readonly ModelProfileCandidate[];
  /** Step-level model constraints (routing engages only when present). */
  constraints?: StepModelConstraints | undefined;
  /** Explicit step backend override (#238): pinned backend name and/or model. */
  explicit?: { backendName?: string; model?: string } | undefined;
}

export interface ModelRouteResult {
  /** Selected profile; undefined when routing is skipped or bypassed. */
  profile?: ModelProfileDefinition;
  /** Human-readable routing reason, surfaced in the agent_invoked event. */
  reason: string;
}

function hasAnyConstraintField(constraints: StepModelConstraints): boolean {
  return constraints.data_classification !== undefined
    || constraints.regions !== undefined
    || constraints.local_required !== undefined
    || constraints.max_cost_class !== undefined
    || constraints.max_latency_class !== undefined;
}

function hasHardConstraints(constraints: StepModelConstraints): boolean {
  return constraints.data_classification !== undefined
    || (constraints.regions !== undefined && constraints.regions.length > 0)
    || constraints.local_required === true;
}

function checkHardConstraints(
  profile: ModelProfileDefinition,
  constraints: StepModelConstraints,
): string[] {
  const rejections: string[] = [];
  if (
    constraints.data_classification !== undefined
    && !(profile.data_classification ?? []).includes(constraints.data_classification)
  ) {
    rejections.push(
      `data_classification: profile does not serve "${constraints.data_classification}"`,
    );
  }
  if (constraints.regions !== undefined) {
    const covered = profile.regions ?? [];
    const missing = constraints.regions.filter((region) => !covered.includes(region));
    if (missing.length > 0) {
      rejections.push(`regions: profile does not cover ${missing.join(", ")}`);
    }
  }
  if (constraints.local_required === true && profile.local_required !== true) {
    rejections.push("local_required: profile does not declare local execution");
  }
  return rejections;
}

function checkEconomicsConstraints(
  profile: ModelProfileDefinition,
  constraints: StepModelConstraints,
): string[] {
  const rejections: string[] = [];
  if (constraints.max_cost_class !== undefined) {
    const profileClass = profile.cost_class ?? "high";
    if (CLASS_ORDER[profileClass] > CLASS_ORDER[constraints.max_cost_class]) {
      rejections.push(
        `max_cost_class: profile cost class "${profileClass}" exceeds "${constraints.max_cost_class}"`,
      );
    }
  }
  if (constraints.max_latency_class !== undefined) {
    const profileClass = profile.latency_class ?? "high";
    if (CLASS_ORDER[profileClass] > CLASS_ORDER[constraints.max_latency_class]) {
      rejections.push(
        `max_latency_class: profile latency class "${profileClass}" exceeds "${constraints.max_latency_class}"`,
      );
    }
  }
  return rejections;
}

export function routeModel(input: ModelRouteInput): ModelRouteResult {
  const { candidates, constraints, explicit } = input;

  if (constraints === undefined || !hasAnyConstraintField(constraints)) {
    return { reason: "routing skipped: step declares no model constraints" };
  }

  if (explicit?.model !== undefined && explicit.model.trim() !== "") {
    const match = candidates.find(
      (candidate) => candidate.name === explicit.model || candidate.model === explicit.model,
    );
    if (match === undefined) {
      if (hasHardConstraints(constraints)) {
        throw new ModelRoutingError(
          `Explicit model override "${explicit.model}" cannot be verified against hard constraints: the model is not declared in the workflow "models" registry`,
          {
            details: {
              candidates: candidates.map((candidate) => candidate.name),
              constraints,
              explicitOverride: explicit,
            },
            suggestion:
              `Declare the model as a profile in the workflow "models" registry so its hard-constraint coverage can be verified, or remove hard constraints from the step.`,
          },
        );
      }
      return {
        reason: `explicit model override "${explicit.model}" (routing bypassed)`,
      };
    }
    const rejections = checkHardConstraints(match, constraints);
    if (rejections.length > 0) {
      throw new ModelRoutingError(
        `Explicit model override "${explicit.model}" violates hard constraints for profile "${match.name}"`,
        {
          details: {
            candidates: candidates.map((candidate) => candidate.name),
            constraints,
            explicitOverride: explicit,
            rejections: [{ profile: match.name, reasons: rejections }],
          },
          suggestion: `Hard constraints cannot be overridden. Choose a model whose profile satisfies them, or relax the step's hard constraints.`,
        },
      );
    }
    return {
      profile: match,
      reason: `explicit model override "${explicit.model}" resolved to profile "${match.name}" and verified against hard constraints`,
    };
  }

  const matchedProfiles: ModelProfileCandidate[] = [];
  const rejections: Array<{ profile: string; reasons: string[] }> = [];
  for (const candidate of candidates) {
    const reasons: string[] = [];
    reasons.push(...checkHardConstraints(candidate, constraints));
    reasons.push(...checkEconomicsConstraints(candidate, constraints));
    if (
      explicit?.backendName !== undefined
      && candidate.backend !== undefined
      && candidate.backend !== explicit.backendName
    ) {
      reasons.push(
        `backend: profile backend "${candidate.backend}" does not match the step-pinned backend "${explicit.backendName}"`,
      );
    }
    if (reasons.length === 0) {
      matchedProfiles.push(candidate);
    } else {
      rejections.push({ profile: candidate.name, reasons });
    }
  }

  if (matchedProfiles.length === 0) {
    throw new ModelRoutingError(
      `No model profile in the workflow "models" registry satisfies the step constraints`,
      {
        details: {
          candidates: candidates.map((candidate) => candidate.name),
          constraints,
          ...(explicit !== undefined ? { explicitOverride: explicit } : {}),
          rejections,
        },
        suggestion:
          `Adjust the step constraints or add a model profile to the workflow "models" registry that satisfies them.`,
      },
    );
  }

  const selected = matchedProfiles[0]!;
  return {
    profile: selected,
    reason: `matched profile "${selected.name}" (first of ${matchedProfiles.length} candidate(s) satisfying constraints)`,
  };
}

/**
 * Merge the routed profile into the step's original backend declaration,
 * producing the effective step-backend override handed to backendResolver.
 *
 * The profile's `model` always wins (routing owns model selection); the
 * profile's `backend` name applies only when the original declaration did not
 * pin a backend name. A string-form original is upgraded to object form so
 * the model can be carried alongside the pinned name.
 */
export function buildEffectiveBackendOverride(
  original: string | StepBackendOverride | undefined,
  profile: ModelProfileDefinition,
): StepBackendOverride {
  if (typeof original === "string") {
    return { name: original, model: profile.model };
  }
  if (original === undefined) {
    const override: StepBackendOverride = { model: profile.model };
    if (profile.backend !== undefined) override.name = profile.backend;
    return override;
  }
  return {
    ...original,
    model: profile.model,
    ...(original.name === undefined && profile.backend !== undefined
      ? { name: profile.backend }
      : {}),
  };
}
