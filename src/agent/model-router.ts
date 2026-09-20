/**
 * Capability-based model routing (Issue #286 Phase 1).
 *
 * Pure module: no IO, no workflow/engine imports. The engine calls
 * `routeModel` before backend resolution; the returned profile (when any) is
 * merged into an effective step-backend override via
 * `buildEffectiveBackendOverride` so the existing backend resolution chain
 * stays unchanged.
 *
 * Phase 2 (Issue #286) shipped runtime metrics recording. Phase 3 orders
 * matched candidates by historical stats passed in via
 * `ModelRouteInput.history` when at least two profiles match; with no
 * history (or a single match) the declaration-order first-match pick is
 * unchanged.
 *
 * Phase 4 (Accepted Artifact Cost optimization, this change) adds a
 * cost-aware preference that engages ONLY when the step constraints
 * declare `routing_policy.objective: accepted_artifact_cost`. The proxy
 * cost units are accumulated by the metrics aggregation
 * (src/metrics/history.ts); this module combines them into the AAC score
 * (pure arithmetic — the router never does IO). Without the policy the
 * Phase 3 acceptance-first ordering is preserved byte-identically.
 */

import type { StepBackendOverride } from "./config.js";
import { ModelRoutingError } from "../utils/index.js";

export type CostClass = "low" | "medium" | "high";
export type DataClassification = "public" | "internal" | "confidential" | "restricted";

const CLASS_ORDER: Record<CostClass, number> = { low: 0, medium: 1, high: 2 };

/**
 * Phase 4 (Issue #286): routing policy objective.
 *
 * - `quality` — Phase 3 acceptance-first ordering (the default; explicit or
 *   implicit when no policy is declared).
 * - `accepted_artifact_cost` — Phase 4 AAC ordering (see routeModel).
 *
 * Weighted multi-objective tradeoffs (latency, risk, ...) are out of scope
 * for v1: the issue explicitly allows a simple deterministic scoring model.
 */
export type RoutingPolicyObjective = "quality" | "accepted_artifact_cost";

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
  /**
   * Phase 4: ordering objective for matched candidates. Declaring the
   * policy (even with `quality`) engages routing like any other constraint
   * field; omitting it preserves Phase 3 behavior byte-identically.
   */
  routing_policy?: { objective: RoutingPolicyObjective };
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

/**
 * Phase 3: per-model aggregate for one task class (job, skill).
 *
 * Raw counts are stored (not rates) so the routing reason can carry exact
 * `accepted/samples` figures; rates are derived at comparison time.
 *
 * Phase 4: the three cost accumulators hold proxy cost units folded by the
 * metrics aggregation (src/metrics/history.ts): each record contributes
 * `cost_class_weight(cost_class) × duration_ms` units (weights low=1,
 * medium=2, high=4; missing cost_class defaults to high=4). There are no
 * real token costs in the Phase 2 records — the proxy is the documented
 * v1 stand-in. The fields are optional so hand-built stats (tests, older
 * stores) keep typechecking; the AAC helpers treat a missing field as 0.
 */
export interface ModelHistoryStats {
  /** Terminal records aggregated for this (job, skill, model). */
  samples: number;
  /** Records with report_accepted === true. */
  accepted: number;
  /** Records with attempt > 1 (each post-first attempt counts as retry evidence). */
  retried: number;
  /** Phase 4: Σ proxy cost units over all folded records (base + retry executions). */
  execution_cost?: number;
  /** Phase 4: Σ proxy cost units over records with attempt > 1 (wasted re-runs). */
  retry_overhead?: number;
  /** Phase 4: Σ proxy cost units over records with report_accepted === false (review + redo). */
  rework_overhead?: number;
}

/**
 * Phase 4 (Issue #286): Accepted Artifact Cost proxy.
 *
 * The Phase 2 metrics journal records no real token costs, so the v1 cost
 * model is a documented deterministic proxy. The aggregation pre-computes
 * per-(task-class, model) proxy cost units:
 *
 *   execution_cost = Σ cost_units(every terminal record)        — base + retry executions
 *   retry_overhead = Σ cost_units(records with attempt > 1)     — work that forced a re-run
 *   rework_overhead = Σ cost_units(records rejected at the report gate) — review + redo
 *
 * `deliveredCostUnits` is the sum of the three: the full cost the model
 * generated before producing anything accepted. `acceptedArtifactCost`
 * amortizes it over the accepted artifacts:
 *
 *   AAC = delivered_cost / max(accepted, 1)
 *
 * With zero accepted artifacts the whole delivered cost is charged to one
 * hypothetical artifact — a deterministic worst case; ordering still ranks
 * such models below any model with at least one accepted artifact.
 */
export function deliveredCostUnits(stats: ModelHistoryStats): number {
  return (stats.execution_cost ?? 0)
    + (stats.retry_overhead ?? 0)
    + (stats.rework_overhead ?? 0);
}

export function acceptedArtifactCost(stats: ModelHistoryStats): number {
  return deliveredCostUnits(stats) / Math.max(stats.accepted, 1);
}

/** Historical stats keyed by model id, for the current task class. */
export type TaskClassHistory = ReadonlyMap<string, ModelHistoryStats>;

/**
 * Phase 3: one entry of the post-ordering matched-candidate ranking,
 * exposed for traceability logging. Order is the final preference order.
 */
export interface ModelHistoryRankingEntry {
  /** Registry key from the workflow `models:` block. */
  name: string;
  /** Profile model id. */
  model: string;
  samples: number;
  accepted: number;
  retried: number;
  /**
   * Phase 4 (AAC policy only): proxy cost units per accepted artifact.
   * Undefined for zero-sample candidates and under the quality objective
   * (the ranking then stays byte-identical to Phase 3).
   */
  aac?: number;
  /** Phase 4 (AAC policy only): execution + retry + rework proxy cost units. */
  delivered_cost?: number;
  /** Phase 4 (AAC policy only): Σ proxy cost units over all records. */
  execution_cost?: number;
  /** Phase 4 (AAC policy only): Σ proxy cost units over attempt > 1 records. */
  retry_overhead?: number;
  /** Phase 4 (AAC policy only): Σ proxy cost units over rejected-report records. */
  rework_overhead?: number;
}

export interface ModelRouteInput {
  /** Workflow model registry entries in declaration order. */
  candidates: readonly ModelProfileCandidate[];
  /** Step-level model constraints (routing engages only when present). */
  constraints?: StepModelConstraints | undefined;
  /** Explicit step backend override (#238): pinned backend name and/or model. */
  explicit?: { backendName?: string; model?: string } | undefined;
  /**
   * Phase 3/4: historical stats for the current (job, skill) task class,
   * keyed by model id. When present and at least two profiles match,
   * matched candidates are reordered — by acceptance-first ordering
   * (Phase 3, also under `routing_policy.objective: quality`) or by
   * Accepted Artifact Cost (Phase 4, only under
   * `routing_policy.objective: accepted_artifact_cost`); otherwise the
   * declaration-order first match wins unchanged.
   */
  history?: TaskClassHistory | undefined;
}

export interface ModelRouteResult {
  /** Selected profile; undefined when routing is skipped or bypassed. */
  profile?: ModelProfileDefinition;
  /** Human-readable routing reason, surfaced in the agent_invoked event. */
  reason: string;
  /**
   * Phase 3: full post-ordering ranking of matched profiles. Set only
   * when history was consulted (at least two matches).
   */
  historyRanking?: ReadonlyArray<ModelHistoryRankingEntry> | undefined;
}

function hasAnyConstraintField(constraints: StepModelConstraints): boolean {
  return constraints.data_classification !== undefined
    || constraints.regions !== undefined
    || constraints.local_required !== undefined
    || constraints.max_cost_class !== undefined
    || constraints.max_latency_class !== undefined
    // Phase 4: a declared policy alone engages routing (ordering needs the
    // history lookup the engine only performs for constrained steps).
    || constraints.routing_policy !== undefined;
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

  // ── Phase 3/4: historical ordering (Issue #286) ──
  // Reorder the matched set only when history was supplied AND at least two
  // profiles matched.
  //
  //   objective (default) `quality` — Phase 3: acceptance_rate desc →
  //     retry_rate asc → sample count desc → declaration order. Models with
  //     zero samples rank after sampled models (in declaration order).
  //   objective `accepted_artifact_cost` — Phase 4: sampled models with at
  //     least one accepted artifact rank by AAC asc (tie: acceptance rate
  //     desc → declaration order); sampled models with zero accepted
  //     artifacts rank next by delivered cost asc (they have never
  //     delivered, so no AAC is meaningful — cheaper waste first); models
  //     with zero samples rank last in declaration order.
  //
  // Hard constraints were already enforced by filtering; scoring never
  // re-admits a rejected profile. Without history (or with a single match)
  // the pick below is byte-identical to Phase 1.
  const history = input.history;
  if (history !== undefined && matchedProfiles.length >= 2) {
    const decorated = matchedProfiles.map((candidate, index) => ({
      candidate,
      index,
      stats: history.get(candidate.model),
    }));
    const sampled = decorated.filter(
      (e) => e.stats !== undefined && e.stats.samples > 0,
    );
    const zeroSample = decorated.filter(
      (e) => e.stats === undefined || e.stats.samples === 0,
    );
    const aacPolicy =
      constraints.routing_policy?.objective === "accepted_artifact_cost";

    if (sampled.length > 0 && aacPolicy) {
      // ── Phase 4: Accepted Artifact Cost ordering ──
      const withAccepted = sampled.filter((e) => e.stats!.accepted > 0);
      const zeroAccepted = sampled.filter((e) => e.stats!.accepted === 0);
      withAccepted.sort(
        (a, b) =>
          acceptedArtifactCost(a.stats!) - acceptedArtifactCost(b.stats!) ||
          b.stats!.accepted / b.stats!.samples -
            a.stats!.accepted / a.stats!.samples ||
          a.index - b.index,
      );
      zeroAccepted.sort(
        (a, b) =>
          deliveredCostUnits(a.stats!) - deliveredCostUnits(b.stats!) ||
          a.index - b.index,
      );
      const ordered = [...withAccepted, ...zeroAccepted];

      const ranking: ReadonlyArray<ModelHistoryRankingEntry> = [
        ...ordered,
        ...zeroSample,
      ].map((e) => {
        const stats = e.stats;
        return {
          name: e.candidate.name,
          model: e.candidate.model,
          samples: stats?.samples ?? 0,
          accepted: stats?.accepted ?? 0,
          retried: stats?.retried ?? 0,
          ...(stats !== undefined
            ? {
                aac: acceptedArtifactCost(stats),
                delivered_cost: deliveredCostUnits(stats),
                execution_cost: stats.execution_cost ?? 0,
                retry_overhead: stats.retry_overhead ?? 0,
                rework_overhead: stats.rework_overhead ?? 0,
              }
            : {}),
        };
      });

      const selected = ordered[0]!.candidate;
      const stats = ordered[0]!.stats!;
      if (stats.accepted > 0) {
        return {
          profile: selected,
          reason: `matched profile "${selected.name}" (aac-ranked 1 of ${matchedProfiles.length} candidate(s) satisfying constraints; aac ${acceptedArtifactCost(stats).toFixed(2)} cost-units per accepted artifact, accepted ${stats.accepted}/${stats.samples})`,
          historyRanking: ranking,
        };
      }
      return {
        profile: selected,
        reason: `matched profile "${selected.name}" (aac-ranked 1 of ${matchedProfiles.length} candidate(s) satisfying constraints; no accepted artifacts for any candidate, delivered-cost ${deliveredCostUnits(stats).toFixed(2)} cost-units, accepted 0/${stats.samples})`,
        historyRanking: ranking,
      };
    }

    if (sampled.length > 0) {
      // ── Phase 3: acceptance-first ordering (byte-identical) ──
      sampled.sort(
        (a, b) =>
          b.stats!.accepted / b.stats!.samples -
            a.stats!.accepted / a.stats!.samples ||
          a.stats!.retried / a.stats!.samples -
            b.stats!.retried / b.stats!.samples ||
          b.stats!.samples - a.stats!.samples ||
          a.index - b.index,
      );
    }
    const ranking: ReadonlyArray<ModelHistoryRankingEntry> = [
      ...sampled,
      ...zeroSample,
    ].map((e) => ({
      name: e.candidate.name,
      model: e.candidate.model,
      samples: e.stats?.samples ?? 0,
      accepted: e.stats?.accepted ?? 0,
      retried: e.stats?.retried ?? 0,
    }));

    const selected = sampled[0]?.candidate ?? matchedProfiles[0]!;
    const stats = sampled[0]?.stats;
    if (stats !== undefined) {
      return {
        profile: selected,
        reason: `matched profile "${selected.name}" (history-ranked 1 of ${matchedProfiles.length} candidate(s) satisfying constraints; acceptance ${stats.accepted}/${stats.samples}, retry ${stats.retried}/${stats.samples})`,
        historyRanking: ranking,
      };
    }
    return {
      profile: selected,
      reason: `matched profile "${selected.name}" (first of ${matchedProfiles.length} candidate(s) satisfying constraints; no historical samples for any candidate)`,
      historyRanking: ranking,
    };
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
