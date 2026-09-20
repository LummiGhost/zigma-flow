/**
 * Model router Accepted Artifact Cost unit tests (Issue #286 Phase 4).
 *
 * Covers the Phase 4 extension of the pure routing contract: when the step
 * constraints declare `routing_policy.objective: accepted_artifact_cost`,
 * matched candidates are ordered by expected delivered cost per accepted
 * artifact instead of the Phase 3 acceptance-first ordering. Without the
 * policy (or with `objective: quality`) the Phase 3 behavior is preserved
 * byte-identically.
 *
 * AAC = (execution_cost + retry_overhead + rework_overhead) / max(accepted, 1)
 * in proxy cost units; see src/agent/model-router.ts for the documented
 * proxy model.
 */

import { describe, expect, it } from "vitest";

import {
  acceptedArtifactCost,
  deliveredCostUnits,
  routeModel,
} from "../../src/agent/model-router.js";
import type {
  ModelHistoryStats,
  ModelProfileCandidate,
  TaskClassHistory,
} from "../../src/agent/model-router.js";

function makeProfile(
  name: string,
  overrides: Partial<ModelProfileCandidate> = {},
): ModelProfileCandidate {
  return { name, model: `model-${name}`, cost_class: "low", ...overrides };
}

function historyOf(entries: Record<string, ModelHistoryStats>): TaskClassHistory {
  return new Map(Object.entries(entries));
}

const AAC_CONSTRAINT = {
  max_cost_class: "low" as const,
  routing_policy: { objective: "accepted_artifact_cost" as const },
};

const QUALITY_CONSTRAINT = {
  max_cost_class: "low" as const,
  routing_policy: { objective: "quality" as const },
};

const POLICY_ONLY_CONSTRAINT = {
  routing_policy: { objective: "accepted_artifact_cost" as const },
};

// ---------------------------------------------------------------------------
// AAC helpers
// ---------------------------------------------------------------------------

describe("acceptedArtifactCost / deliveredCostUnits", () => {
  it("amortizes the delivered cost over accepted artifacts", () => {
    const stats: ModelHistoryStats = {
      samples: 10,
      accepted: 4,
      retried: 2,
      execution_cost: 1000,
      retry_overhead: 200,
      rework_overhead: 300,
    };
    expect(deliveredCostUnits(stats)).toBe(1500);
    expect(acceptedArtifactCost(stats)).toBe(375);
  });

  it("charges the whole delivered cost to one hypothetical artifact when nothing was accepted", () => {
    const stats: ModelHistoryStats = {
      samples: 2,
      accepted: 0,
      retried: 1,
      execution_cost: 400,
      retry_overhead: 100,
      rework_overhead: 100,
    };
    expect(acceptedArtifactCost(stats)).toBe(600);
  });

  it("treats missing cost fields (hand-built stats) as zero", () => {
    const stats: ModelHistoryStats = { samples: 3, accepted: 3, retried: 0 };
    expect(deliveredCostUnits(stats)).toBe(0);
    expect(acceptedArtifactCost(stats)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AAC ordering
// ---------------------------------------------------------------------------

describe("routeModel — Accepted Artifact Cost ordering (Phase 4)", () => {
  it("prefers the lower-AAC profile when acceptance is equal", () => {
    const candidates = [makeProfile("a"), makeProfile("b")];
    const history = historyOf({
      "model-a": {
        samples: 10, accepted: 10, retried: 0,
        execution_cost: 2000, retry_overhead: 0, rework_overhead: 0,
      },
      "model-b": {
        samples: 10, accepted: 10, retried: 0,
        execution_cost: 1000, retry_overhead: 0, rework_overhead: 0,
      },
    });

    const result = routeModel({
      candidates,
      constraints: AAC_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-b");
    expect(result.reason).toContain('matched profile "b"');
    expect(result.reason).toContain("aac-ranked 1 of 2");
    expect(result.reason).toContain("aac 100.00 cost-units per accepted artifact");
    expect(result.reason).toContain("accepted 10/10");
  });

  it("overrides the Phase 3 acceptance preference when the cheaper model costs less per delivery", () => {
    const candidates = [makeProfile("perfect"), makeProfile("cheap")];
    const history = historyOf({
      // perfect: 10/10 accepted but 500 units each → AAC 500.
      "model-perfect": {
        samples: 10, accepted: 10, retried: 0,
        execution_cost: 5000, retry_overhead: 0, rework_overhead: 0,
      },
      // cheap: only 5/10 accepted but 50 units each + rework on rejects →
      // delivered 10×50 + 5×50 = 750 → AAC 750/5 = 150.
      "model-cheap": {
        samples: 10, accepted: 5, retried: 0,
        execution_cost: 500, retry_overhead: 0, rework_overhead: 250,
      },
    });

    const aacResult = routeModel({
      candidates,
      constraints: AAC_CONSTRAINT,
      history,
    });
    expect(aacResult.profile?.model).toBe("model-cheap");

    // Phase 3 (same history, no policy) would have picked "perfect".
    const phase3Result = routeModel({
      candidates,
      constraints: { max_cost_class: "low" },
      history,
    });
    expect(phase3Result.profile?.model).toBe("model-perfect");
  });

  it("ranks sampled models with zero accepted artifacts after delivered models, by delivered cost", () => {
    const candidates = [
      makeProfile("never-a"),
      makeProfile("never-b"),
      makeProfile("delivered"),
    ];
    const history = historyOf({
      // Both never-* models have samples but no accepted artifact. Their
      // AAC is degenerate (delivered/1) — they must never beat "delivered"
      // regardless of cost, and order among themselves by delivered cost.
      "model-never-a": {
        samples: 3, accepted: 0, retried: 0,
        execution_cost: 900, retry_overhead: 0, rework_overhead: 900,
      },
      "model-never-b": {
        samples: 3, accepted: 0, retried: 0,
        execution_cost: 300, retry_overhead: 0, rework_overhead: 300,
      },
      "model-delivered": {
        samples: 1, accepted: 1, retried: 0,
        execution_cost: 10000, retry_overhead: 0, rework_overhead: 0,
      },
    });

    const result = routeModel({
      candidates,
      constraints: AAC_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-delivered");
    expect(result.historyRanking!.map((e) => e.model)).toEqual([
      "model-delivered",
      "model-never-b",
      "model-never-a",
    ]);
  });

  it("uses the no-accepted-artifact reason when no candidate has delivered", () => {
    const candidates = [makeProfile("a"), makeProfile("b")];
    const history = historyOf({
      "model-a": {
        samples: 2, accepted: 0, retried: 0,
        execution_cost: 500, retry_overhead: 0, rework_overhead: 500,
      },
      "model-b": {
        samples: 2, accepted: 0, retried: 0,
        execution_cost: 100, retry_overhead: 0, rework_overhead: 100,
      },
    });

    const result = routeModel({
      candidates,
      constraints: AAC_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-b");
    expect(result.reason).toContain("aac-ranked 1 of 2");
    expect(result.reason).toContain(
      "no accepted artifacts for any candidate, delivered-cost 200.00 cost-units, accepted 0/2",
    );
  });

  it("breaks equal AAC by acceptance rate, then declaration order", () => {
    // a: delivered 200 / 2 accepted = 100 AAC, acceptance 2/10.
    // b: delivered 100 / 1 accepted = 100 AAC, acceptance 1/10.
    // Equal AAC → the higher acceptance rate wins.
    const tieCandidates = [makeProfile("b"), makeProfile("a")];
    const tieHistory = historyOf({
      "model-a": {
        samples: 10, accepted: 2, retried: 0,
        execution_cost: 200, retry_overhead: 0, rework_overhead: 0,
      },
      "model-b": {
        samples: 10, accepted: 1, retried: 0,
        execution_cost: 100, retry_overhead: 0, rework_overhead: 0,
      },
    });
    const tieResult = routeModel({
      candidates: tieCandidates,
      constraints: AAC_CONSTRAINT,
      history: tieHistory,
    });
    expect(tieResult.profile?.model).toBe("model-a");

    // Identical stats → declaration order breaks the full tie.
    const identicalHistory = historyOf({
      "model-x": {
        samples: 10, accepted: 4, retried: 0,
        execution_cost: 800, retry_overhead: 0, rework_overhead: 0,
      },
      "model-y": {
        samples: 10, accepted: 4, retried: 0,
        execution_cost: 800, retry_overhead: 0, rework_overhead: 0,
      },
    });
    const identicalResult = routeModel({
      candidates: [makeProfile("x"), makeProfile("y")],
      constraints: AAC_CONSTRAINT,
      history: identicalHistory,
    });
    expect(identicalResult.profile?.model).toBe("model-x");
  });

  it("carries the full cost breakdown on the ranking entries (run-log traceability)", () => {
    const candidates = [makeProfile("a"), makeProfile("b")];
    const history = historyOf({
      "model-a": {
        samples: 3, accepted: 1, retried: 1,
        execution_cost: 300, retry_overhead: 100, rework_overhead: 200,
      },
      "model-b": {
        samples: 2, accepted: 2, retried: 0,
        execution_cost: 200, retry_overhead: 0, rework_overhead: 0,
      },
    });

    const result = routeModel({
      candidates,
      constraints: AAC_CONSTRAINT,
      history,
    });

    // a: delivered 600 / 1 accepted = 600; b: 200 / 2 = 100 → b first.
    expect(result.historyRanking![0]).toEqual({
      name: "b",
      model: "model-b",
      samples: 2,
      accepted: 2,
      retried: 0,
      aac: 100,
      delivered_cost: 200,
      execution_cost: 200,
      retry_overhead: 0,
      rework_overhead: 0,
    });
    expect(result.historyRanking![1]).toEqual({
      name: "a",
      model: "model-a",
      samples: 3,
      accepted: 1,
      retried: 1,
      aac: 600,
      delivered_cost: 600,
      execution_cost: 300,
      retry_overhead: 100,
      rework_overhead: 200,
    });
  });

  it("places zero-sample models last in declaration order, without cost fields", () => {
    const candidates = [makeProfile("zero"), makeProfile("sampled")];
    const history = historyOf({
      "model-sampled": {
        samples: 1, accepted: 1, retried: 0,
        execution_cost: 100, retry_overhead: 0, rework_overhead: 0,
      },
    });

    const result = routeModel({
      candidates,
      constraints: AAC_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-sampled");
    expect(result.historyRanking![1]).toEqual({
      name: "zero",
      model: "model-zero",
      samples: 0,
      accepted: 0,
      retried: 0,
    });
    expect(result.historyRanking![1]!.aac).toBeUndefined();
  });

  it("falls back to the exact Phase 3 fallback when every matched candidate is zero-sample", () => {
    const candidates = [makeProfile("a"), makeProfile("b")];
    const history = historyOf({
      "model-other": {
        samples: 5, accepted: 5, retried: 0,
        execution_cost: 500, retry_overhead: 0, rework_overhead: 0,
      },
    });

    const result = routeModel({
      candidates,
      constraints: AAC_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-a");
    expect(result.reason).toBe(
      'matched profile "a" (first of 2 candidate(s) satisfying constraints; no historical samples for any candidate)',
    );
    expect(result.historyRanking![0]!.aac).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Policy gating and Phase 3 compatibility
// ---------------------------------------------------------------------------

describe("routeModel — policy gating (Phase 4)", () => {
  const candidates = [makeProfile("a"), makeProfile("b")];
  const history = historyOf({
    // Under Phase 3 acceptance-first, "a" wins (10/10 vs 5/10). Under AAC
    // it loses (AAC 500 vs 150 — same figures as the override test above).
    "model-a": {
      samples: 10, accepted: 10, retried: 0,
      execution_cost: 5000, retry_overhead: 0, rework_overhead: 0,
    },
    "model-b": {
      samples: 10, accepted: 5, retried: 0,
      execution_cost: 500, retry_overhead: 0, rework_overhead: 250,
    },
  });

  it("keeps the exact Phase 3 ordering and strings when no policy is declared", () => {
    const result = routeModel({
      candidates,
      constraints: { max_cost_class: "low" },
      history,
    });

    expect(result.profile?.model).toBe("model-a");
    expect(result.reason).toBe(
      'matched profile "a" (history-ranked 1 of 2 candidate(s) satisfying constraints; acceptance 10/10, retry 0/10)',
    );
    expect(result.historyRanking![0]).toEqual({
      name: "a",
      model: "model-a",
      samples: 10,
      accepted: 10,
      retried: 0,
    });
    expect(result.historyRanking![0]!.aac).toBeUndefined();
  });

  it("keeps the Phase 3 ordering when the policy objective is quality", () => {
    const result = routeModel({
      candidates,
      constraints: QUALITY_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-a");
    expect(result.reason).toContain("history-ranked 1 of 2");
    expect(result.historyRanking![0]!.aac).toBeUndefined();
  });

  it("engages routing when the policy is the only constraint field declared", () => {
    const result = routeModel({
      candidates,
      constraints: POLICY_ONLY_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-b");
    expect(result.reason).toContain("aac-ranked 1 of 2");
  });

  it("never lets scoring re-admit a profile rejected by hard constraints", () => {
    // "cheap" violates the hard classification constraint but has a great
    // AAC; it must be filtered out entirely.
    const hardCandidates = [
      makeProfile("clean", { data_classification: ["confidential"] }),
      makeProfile("cheap", { data_classification: ["public"] }),
    ];
    const hardHistory = historyOf({
      "model-clean": {
        samples: 1, accepted: 1, retried: 0,
        execution_cost: 10000, retry_overhead: 0, rework_overhead: 0,
      },
      "model-cheap": {
        samples: 10, accepted: 10, retried: 0,
        execution_cost: 100, retry_overhead: 0, rework_overhead: 0,
      },
    });

    const result = routeModel({
      candidates: hardCandidates,
      constraints: {
        data_classification: "confidential",
        routing_policy: { objective: "accepted_artifact_cost" },
      },
      history: hardHistory,
    });

    expect(result.profile?.model).toBe("model-clean");
    // Single match → Phase 1 behavior, no ranking at all.
    expect(result.reason).toBe(
      'matched profile "clean" (first of 1 candidate(s) satisfying constraints)',
    );
    expect(result.historyRanking).toBeUndefined();
  });

  it("bypasses the AAC policy when an explicit model override is present", () => {
    const result = routeModel({
      candidates,
      constraints: AAC_CONSTRAINT,
      explicit: { model: "model-a" },
      history,
    });

    expect(result.profile?.model).toBe("model-a");
    expect(result.reason).toContain("resolved to profile");
    expect(result.historyRanking).toBeUndefined();
  });

  it("preserves the exact Phase 1 behavior when no history is supplied", () => {
    const result = routeModel({
      candidates,
      constraints: AAC_CONSTRAINT,
    });

    expect(result.profile?.model).toBe("model-a");
    expect(result.reason).toBe(
      'matched profile "a" (first of 2 candidate(s) satisfying constraints)',
    );
    expect(result.historyRanking).toBeUndefined();
  });
});
