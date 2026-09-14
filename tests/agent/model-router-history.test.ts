/**
 * Model router historical-ordering unit tests (Issue #286 Phase 3).
 *
 * Covers the Phase 3 extension of the pure routing contract: matched
 * candidates are reordered by acceptance-first ordering when
 * `ModelRouteInput.history` is supplied and at least two profiles match;
 * otherwise the Phase 1 declaration-order first match is preserved
 * byte-identically.
 *
 * Ordering keys: acceptance_rate desc → retry_rate asc → sample count
 * desc → declaration order; zero-sample models rank after sampled models.
 */

import { describe, expect, it } from "vitest";

import { routeModel } from "../../src/agent/model-router.js";
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

/** Build a TaskClassHistory from a `{ [modelId]: stats }` record. */
function historyOf(
  entries: Record<string, ModelHistoryStats>,
): TaskClassHistory {
  return new Map(Object.entries(entries));
}

const LOW_CONSTRAINT = { max_cost_class: "low" } as const;

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe("routeModel — historical ordering (Phase 3)", () => {
  it("prefers the higher-acceptance profile regardless of declaration order", () => {
    const candidates = [makeProfile("a"), makeProfile("b")];
    const history = historyOf({
      "model-a": { samples: 10, accepted: 5, retried: 0 },
      "model-b": { samples: 10, accepted: 9, retried: 0 },
    });

    const result = routeModel({
      candidates,
      constraints: LOW_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-b");
    expect(result.reason).toContain('matched profile "b"');
    expect(result.reason).toContain("history-ranked 1 of 2");
    expect(result.reason).toContain("acceptance 9/10");
    expect(result.historyRanking).toBeDefined();
    expect(result.historyRanking![0]).toEqual({
      name: "b",
      model: "model-b",
      samples: 10,
      accepted: 9,
      retried: 0,
    });
    expect(result.historyRanking![1]!.name).toBe("a");
  });

  it("breaks equal acceptance by lower retry rate", () => {
    const candidates = [makeProfile("a"), makeProfile("b")];
    const history = historyOf({
      "model-a": { samples: 10, accepted: 8, retried: 5 },
      "model-b": { samples: 10, accepted: 8, retried: 2 },
    });

    const result = routeModel({
      candidates,
      constraints: LOW_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-b");
    expect(result.reason).toContain("retry 2/10");
  });

  it("breaks equal acceptance and retry by higher sample count", () => {
    const candidates = [makeProfile("a"), makeProfile("b")];
    const history = historyOf({
      "model-a": { samples: 5, accepted: 4, retried: 0 },
      "model-b": { samples: 20, accepted: 16, retried: 0 },
    });

    const result = routeModel({
      candidates,
      constraints: LOW_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-b");
    expect(result.reason).toContain("acceptance 16/20");
  });

  it("keeps declaration order when stats are identical", () => {
    const candidates = [makeProfile("a"), makeProfile("b")];
    const history = historyOf({
      "model-a": { samples: 10, accepted: 9, retried: 1 },
      "model-b": { samples: 10, accepted: 9, retried: 1 },
    });

    const result = routeModel({
      candidates,
      constraints: LOW_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-a");
  });

  it("ranks sampled profiles before zero-sample profiles", () => {
    const candidates = [makeProfile("a"), makeProfile("b")];
    // Only model-a has samples — even with terrible acceptance it beats
    // the never-tried model-b.
    const history = historyOf({
      "model-a": { samples: 1, accepted: 0, retried: 0 },
    });

    const result = routeModel({
      candidates,
      constraints: LOW_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-a");
    expect(result.historyRanking![0]).toEqual({
      name: "a",
      model: "model-a",
      samples: 1,
      accepted: 0,
      retried: 0,
    });
    expect(result.historyRanking![1]).toEqual({
      name: "b",
      model: "model-b",
      samples: 0,
      accepted: 0,
      retried: 0,
    });
  });

  it("falls back to declaration order when every matched candidate is zero-sample", () => {
    const candidates = [makeProfile("a"), makeProfile("b")];
    // History has samples only for a model NOT among the candidates.
    const history = historyOf({
      "model-other": { samples: 5, accepted: 5, retried: 0 },
    });

    const result = routeModel({
      candidates,
      constraints: LOW_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-a");
    expect(result.reason).toContain("no historical samples for any candidate");
    expect(result.reason).toContain("first of 2 candidate(s)");
    expect(result.historyRanking![0]!.samples).toBe(0);
    expect(result.historyRanking![1]!.samples).toBe(0);
  });

  it("ignores history when only one profile matches (Phase 1 reason, no ranking)", () => {
    const candidates = [
      makeProfile("a"),
      makeProfile("b", { cost_class: "high" }),
    ];
    const history = historyOf({
      "model-b": { samples: 10, accepted: 10, retried: 0 },
    });

    const result = routeModel({
      candidates,
      constraints: LOW_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-a");
    expect(result.reason).toBe(
      'matched profile "a" (first of 1 candidate(s) satisfying constraints)',
    );
    expect(result.historyRanking).toBeUndefined();
  });

  it("preserves the exact Phase 1 behavior when no history is supplied", () => {
    const candidates = [makeProfile("a"), makeProfile("b")];
    const result = routeModel({ candidates, constraints: LOW_CONSTRAINT });

    expect(result.profile?.model).toBe("model-a");
    expect(result.reason).toBe(
      'matched profile "a" (first of 2 candidate(s) satisfying constraints)',
    );
    expect(result.historyRanking).toBeUndefined();
  });

  it("filters by constraints before ordering — a history-perfect violating profile is never selected", () => {
    const candidates = [
      makeProfile("a"),
      makeProfile("b", { cost_class: "high" }),
    ];
    const history = historyOf({
      "model-b": { samples: 10, accepted: 10, retried: 0 },
    });

    const result = routeModel({
      candidates,
      constraints: LOW_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-a");
    expect(result.historyRanking).toBeUndefined();
  });

  it("ignores history when an explicit model override bypasses routing", () => {
    const candidates = [makeProfile("a"), makeProfile("b")];
    const history = historyOf({
      "model-b": { samples: 10, accepted: 10, retried: 0 },
    });

    const result = routeModel({
      candidates,
      constraints: LOW_CONSTRAINT,
      explicit: { model: "model-a" },
      history,
    });

    expect(result.profile?.model).toBe("model-a");
    expect(result.reason).toContain("resolved to profile");
    expect(result.historyRanking).toBeUndefined();
  });

  it("ignores history keys for models not among the candidates", () => {
    const candidates = [makeProfile("a"), makeProfile("b")];
    const history = historyOf({
      "model-unrelated": { samples: 100, accepted: 100, retried: 0 },
    });

    const result = routeModel({
      candidates,
      constraints: LOW_CONSTRAINT,
      history,
    });

    expect(result.profile?.model).toBe("model-a");
    expect(result.reason).toContain("no historical samples for any candidate");
    expect(result.historyRanking).toHaveLength(2);
  });
});
