/**
 * Model router unit tests (Issue #286 Phase 1).
 *
 * Covers the pure routing contract: skip-when-no-constraints, class-based
 * economics filters, hard constraint enforcement, explicit override
 * verification, declaration-order matching, structured no-match errors, and
 * the effective-override builder.
 */

import { describe, expect, it } from "vitest";

import { buildEffectiveBackendOverride, routeModel } from "../../src/agent/model-router.js";
import type { ModelProfileCandidate } from "../../src/agent/model-router.js";
import { ModelRoutingError } from "../../src/utils/index.js";

function makeProfile(
  name: string,
  overrides: Partial<ModelProfileCandidate> = {},
): ModelProfileCandidate {
  return { name, model: `model-${name}`, ...overrides };
}

// ---------------------------------------------------------------------------
// Routing skipped / basic matching
// ---------------------------------------------------------------------------

describe("routeModel — skip and matching", () => {
  it("skips routing when the step declares no constraints", () => {
    const result = routeModel({ candidates: [makeProfile("a")] });
    expect(result.profile).toBeUndefined();
    expect(result.reason).toContain("routing skipped");
  });

  it("treats an all-empty constraints block as no constraints (skips routing)", () => {
    const result = routeModel({ candidates: [makeProfile("a")], constraints: {} });
    expect(result.profile).toBeUndefined();
    expect(result.reason).toContain("routing skipped");
  });

  it("selects the single candidate that satisfies all constraint axes", () => {
    const candidates = [
      makeProfile("cheap", {
        cost_class: "low",
        latency_class: "low",
        data_classification: ["internal"],
        regions: ["us-east-1"],
        local_required: false,
      }),
      makeProfile("premium", {
        cost_class: "high",
        latency_class: "high",
        data_classification: ["internal", "confidential"],
        regions: ["us-east-1", "eu-west-1"],
        local_required: true,
      }),
    ];
    const result = routeModel({
      candidates,
      constraints: {
        data_classification: "confidential",
        regions: ["us-east-1"],
        local_required: true,
        max_cost_class: "high",
        max_latency_class: "high",
      },
    });
    expect(result.profile?.model).toBe("model-premium");
    expect(result.reason).toContain('matched profile "premium"');
  });

  it("max_cost_class excludes profiles above the class and profiles with omitted cost (defaults to high)", () => {
    const candidates = [
      makeProfile("declared-low", { cost_class: "low" }),
      makeProfile("undeclared"),
    ];
    const result = routeModel({ candidates, constraints: { max_cost_class: "low" } });
    expect(result.profile?.model).toBe("model-declared-low");
  });

  it("max_latency_class filters on the profile latency class", () => {
    const candidates = [
      makeProfile("fast", { latency_class: "low" }),
      makeProfile("slow", { latency_class: "high" }),
    ];
    const result = routeModel({ candidates, constraints: { max_latency_class: "medium" } });
    expect(result.profile?.model).toBe("model-fast");
  });

  it("data_classification requires membership in the profile list", () => {
    const candidates = [
      makeProfile("internal-only", { data_classification: ["internal"] }),
      makeProfile("confidential-ok", { data_classification: ["internal", "confidential"] }),
    ];
    const result = routeModel({ candidates, constraints: { data_classification: "confidential" } });
    expect(result.profile?.model).toBe("model-confidential-ok");
  });

  it("regions use subset semantics — the profile must cover every constraint region", () => {
    const candidates = [
      makeProfile("us-only", { regions: ["us-east-1"] }),
      makeProfile("global", { regions: ["us-east-1", "eu-west-1"] }),
    ];
    const result = routeModel({ candidates, constraints: { regions: ["us-east-1", "eu-west-1"] } });
    expect(result.profile?.model).toBe("model-global");
  });

  it("local_required: true requires profile.local_required === true", () => {
    const candidates = [
      makeProfile("cloud", { local_required: false }),
      makeProfile("local", { local_required: true }),
    ];
    const result = routeModel({ candidates, constraints: { local_required: true } });
    expect(result.profile?.model).toBe("model-local");
  });

  it("first declaration-order match wins; reason records rank and match count", () => {
    const candidates = [
      makeProfile("first", { cost_class: "low" }),
      makeProfile("second", { cost_class: "low" }),
      makeProfile("third", { cost_class: "high" }),
    ];
    const result = routeModel({ candidates, constraints: { max_cost_class: "low" } });
    expect(result.profile?.model).toBe("model-first");
    expect(result.reason).toContain("first of 2 candidate(s)");
  });
});

// ---------------------------------------------------------------------------
// Explicit override
// ---------------------------------------------------------------------------

describe("routeModel — explicit override", () => {
  it("verifies a registry-declared explicit model against hard constraints", () => {
    const candidates = [
      makeProfile("premium", { model: "claude-opus-4-7", data_classification: ["confidential"] }),
    ];
    const result = routeModel({
      candidates,
      constraints: { data_classification: "confidential" },
      explicit: { model: "claude-opus-4-7" },
    });
    expect(result.profile?.model).toBe("claude-opus-4-7");
    expect(result.reason).toContain("verified against hard constraints");
  });

  it("resolves an explicit model by profile name and carries the profile's model id", () => {
    const candidates = [
      makeProfile("fast", { model: "claude-haiku-4-5", data_classification: ["internal"] }),
    ];
    const result = routeModel({
      candidates,
      constraints: { data_classification: "internal" },
      explicit: { model: "fast" },
    });
    expect(result.profile?.model).toBe("claude-haiku-4-5");
  });

  it("throws when the explicit model violates a hard constraint (not overridable)", () => {
    const candidates = [
      makeProfile("public-only", { model: "m1", data_classification: ["public"] }),
    ];
    let caught: unknown;
    try {
      routeModel({
        candidates,
        constraints: { data_classification: "confidential" },
        explicit: { model: "m1" },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModelRoutingError);
    const details = (caught as ModelRoutingError).details as {
      rejections: Array<{ profile: string; reasons: string[] }>;
    };
    expect(details.rejections).toHaveLength(1);
    expect(details.rejections[0]!.profile).toBe("public-only");
    expect(details.rejections[0]!.reasons.join(" ")).toContain("data_classification");
  });

  it("throws when the explicit model is not in the registry and hard constraints are declared (unverifiable)", () => {
    expect(() =>
      routeModel({
        candidates: [],
        constraints: { local_required: true },
        explicit: { model: "unknown-model" },
      }),
    ).toThrow(ModelRoutingError);
  });

  it("bypasses when the explicit model is unknown and only economics constraints are declared", () => {
    const result = routeModel({
      candidates: [makeProfile("whatever", { model: "m1", cost_class: "low" })],
      constraints: { max_cost_class: "low" },
      explicit: { model: "unknown-model" },
    });
    expect(result.profile).toBeUndefined();
    expect(result.reason).toContain("routing bypassed");
  });
});

// ---------------------------------------------------------------------------
// Backend pin and no-match errors
// ---------------------------------------------------------------------------

describe("routeModel — backend pin and no-match", () => {
  it("excludes a profile whose backend conflicts with the step-pinned backend name", () => {
    const candidates = [
      makeProfile("codex-model", { backend: "codex-cli", cost_class: "low" }),
      makeProfile("claude-model", { backend: "claude-code", cost_class: "low" }),
    ];
    const result = routeModel({
      candidates,
      constraints: { max_cost_class: "low" },
      explicit: { backendName: "claude-code" },
    });
    expect(result.profile?.model).toBe("model-claude-model");
  });

  it("throws a structured no-match error with per-candidate rejections (exit 31)", () => {
    const candidates = [
      makeProfile("a", { cost_class: "high", data_classification: ["public"] }),
      makeProfile("b", { regions: ["us-west-2"] }),
    ];
    let caught: unknown;
    try {
      routeModel({
        candidates,
        constraints: {
          data_classification: "restricted",
          regions: ["eu-west-1"],
          max_cost_class: "low",
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModelRoutingError);
    const routingError = caught as ModelRoutingError;
    expect(routingError.kind).toBe("ModelRoutingError");
    expect(routingError.exitCode).toBe(31);
    const details = routingError.details as {
      candidates: string[];
      rejections: Array<{ profile: string; reasons: string[] }>;
    };
    expect(details.candidates).toEqual(["a", "b"]);
    expect(details.rejections).toHaveLength(2);
    expect(details.rejections[0]!.profile).toBe("a");
    expect(details.rejections[0]!.reasons.length).toBeGreaterThan(0);
    expect(details.rejections[1]!.reasons).toContain(
      'data_classification: profile does not serve "restricted"',
    );
    expect(details.rejections[1]!.reasons).toContain("regions: profile does not cover eu-west-1");
  });

  it("throws with empty candidates when the registry is absent but constraints are declared", () => {
    let caught: unknown;
    try {
      routeModel({ candidates: [], constraints: { max_cost_class: "low" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModelRoutingError);
    const details = (caught as ModelRoutingError).details as { candidates: string[] };
    expect(details.candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildEffectiveBackendOverride
// ---------------------------------------------------------------------------

describe("buildEffectiveBackendOverride", () => {
  it("merges the profile model into an object-form override, preserving other fields", () => {
    const merged = buildEffectiveBackendOverride(
      { max_turns: 3, timeout: 60_000 },
      makeProfile("p", { model: "m1" }),
    );
    expect(merged).toEqual({ max_turns: 3, timeout: 60_000, model: "m1" });
  });

  it("upgrades a string-form backend to object form with the pinned name", () => {
    const merged = buildEffectiveBackendOverride("claude-code", makeProfile("p", { model: "m1" }));
    expect(merged).toEqual({ name: "claude-code", model: "m1" });
  });

  it("applies the profile backend name only when the original pins none", () => {
    const merged = buildEffectiveBackendOverride(
      undefined,
      makeProfile("p", { model: "m1", backend: "codex-cli" }),
    );
    expect(merged).toEqual({ name: "codex-cli", model: "m1" });

    const pinned = buildEffectiveBackendOverride(
      { name: "claude-code" },
      makeProfile("p", { model: "m1", backend: "codex-cli" }),
    );
    expect(pinned).toEqual({ name: "claude-code", model: "m1" });
  });

  it("yields a model-only override for an undefined original with a backend-less profile", () => {
    const merged = buildEffectiveBackendOverride(undefined, makeProfile("p", { model: "m1" }));
    expect(merged).toEqual({ model: "m1" });
  });
});
