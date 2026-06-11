/**
 * Agent Report Schema rendering tests for WF-P9-SCHEMA (Step 1 — Cases and Tests).
 *
 * Covers:
 *   - buildAgentPrompt extension: render an additive Report Schema block
 *     describing the four MUST-have top-level fields of the Agent Report
 *     (outputs / artifacts / signals / summary), the report.json path
 *     under the step artifacts directory, and the allowed signal ids
 *     listed via the bundle's signal specs.
 *   - Pure rendering — no IO, no clock, deterministic for a given
 *     ContextBundle.
 *
 * Reference:
 *   - docs/prd.md §6 FR-006 验收标准 (输出路径和 report schema)
 *   - docs/mvp-contracts.md §2.6 Agent Report Contract (outputs /
 *     artifacts / signals / summary)
 *   - docs/phases/p9-agent-report-retry/workflows/wf-p9-schema/01-cases-and-tests.md
 *
 * Red-phase notes:
 *   - The current P5 buildAgentPrompt does NOT emit a Report Schema
 *     block and does NOT emit the literal quoted keys `"outputs"`,
 *     `"artifacts"`, `"signals"`, `"summary"`. TC-SCHEMA-2..7 fail with
 *     assertion errors against the existing implementation.
 *   - TC-SCHEMA-1 fails because the current implementation does not
 *     carry a Report Schema heading; the regex span check requires
 *     `report.json` to appear together with a "Report Schema" (or
 *     "Agent Report Contract") heading.
 *   - Step 2 of WF-P9-SCHEMA implements the additive rendering and
 *     turns the suite green.
 */

import { describe, expect, it } from "vitest";

import type { ContextBundle } from "../../src/context/index.js";
import { buildAgentPrompt } from "../../src/prompt/index.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const FIXED_RUN_ID = "20260611-0001";

/**
 * Build a populated ContextBundle suitable for the schema rendering tests.
 * Deliberately empty `capabilities` and `artifacts` so the existing P5
 * renderer cannot inadvertently leak the quoted-key substrings via the
 * `### Functions` (outputs: {...}) or `## Prior Artifacts` (summary: ...)
 * sections.
 */
function makeContextBundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  const base: ContextBundle = {
    runId: FIXED_RUN_ID,
    jobId: "plan",
    stepId: "draft",
    stepType: "agent",
    capabilities: {
      skills: [],
      knowledge: [],
      prompts: [],
      functions: [],
      tools: [],
    },
    inputs: { goal: "fix the bug" },
    artifacts: [],
    signals: [
      {
        id: "needs_review",
        description: "Request review from a human",
        allowed_from: ["plan"],
      },
    ],
    permissions: {
      contents: "read",
      edits: "none",
      workflow_state: "none",
    },
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// TC-SCHEMA-1 — FP-SCHEMA-PATH
// ---------------------------------------------------------------------------

describe("buildAgentPrompt — Report Schema block path reference", () => {
  it("renders a Report Schema block that names report.json under the step artifacts directory (TC-SCHEMA-1, UC-SCHEMA-1)", () => {
    const out = buildAgentPrompt(makeContextBundle());

    // The Report Schema block MUST exist (heading) — match either
    // "Report Schema" or "Agent Report Contract".
    const schemaHeading = out.search(
      /^#{2,4}\s+(Report Schema|Agent Report Contract)/m,
    );
    expect(
      schemaHeading,
      `expected a Report Schema heading in:\n${out}`,
    ).toBeGreaterThanOrEqual(0);

    // report.json MUST appear AFTER the schema heading (the
    // existing Output paragraph also mentions report.json before
    // it; here we assert the schema block carries its own
    // reference).
    const reportJsonAfterHeading = out.indexOf("report.json", schemaHeading);
    expect(
      reportJsonAfterHeading,
      `expected report.json to appear after the Report Schema heading in:\n${out}`,
    ).toBeGreaterThan(schemaHeading);
  });
});

// ---------------------------------------------------------------------------
// TC-SCHEMA-2..5 — FP-SCHEMA-FIELDS
// ---------------------------------------------------------------------------

describe("buildAgentPrompt — Report Schema quoted JSON keys", () => {
  it("renders the literal \"outputs\" quoted key in the Report Schema block (TC-SCHEMA-2, UC-SCHEMA-2)", () => {
    const out = buildAgentPrompt(makeContextBundle());
    // Literal substring including JSON quotes — guards against the
    // YAML-style `outputs:` line emitted under `### Functions` (which
    // only appears when a function declares outputs, and which is
    // already suppressed here by the empty capabilities fixture).
    expect(out).toContain('"outputs"');
  });

  it("renders the literal \"signals\" quoted key in the Report Schema block (TC-SCHEMA-3, UC-SCHEMA-3)", () => {
    const out = buildAgentPrompt(makeContextBundle());
    expect(out).toContain('"signals"');
  });

  it("renders the literal \"summary\" quoted key in the Report Schema block (TC-SCHEMA-4, UC-SCHEMA-4)", () => {
    const out = buildAgentPrompt(makeContextBundle());
    expect(out).toContain('"summary"');
  });

  it("renders all four quoted JSON keys together in the Report Schema block (TC-SCHEMA-5, UC-SCHEMA-5)", () => {
    const out = buildAgentPrompt(makeContextBundle());

    const outputsIdx = out.indexOf('"outputs"');
    const artifactsIdx = out.indexOf('"artifacts"');
    const signalsIdx = out.indexOf('"signals"');
    const summaryIdx = out.indexOf('"summary"');

    // All four MUST be present.
    expect(outputsIdx, `expected "outputs" key`).toBeGreaterThanOrEqual(0);
    expect(artifactsIdx, `expected "artifacts" key`).toBeGreaterThanOrEqual(0);
    expect(signalsIdx, `expected "signals" key`).toBeGreaterThanOrEqual(0);
    expect(summaryIdx, `expected "summary" key`).toBeGreaterThanOrEqual(0);

    // All four MUST sit inside one contiguous schema block. We assert
    // pairwise distance: the span from the first to the last quoted
    // key MUST be at most 400 characters (a generous bound covering a
    // pretty-printed JSON object with whitespace and inline
    // comments).
    const indices = [outputsIdx, artifactsIdx, signalsIdx, summaryIdx];
    const minIdx = Math.min(...indices);
    const maxIdx = Math.max(...indices);
    expect(
      maxIdx - minIdx,
      `expected the four quoted keys to sit inside one contiguous block (span at most 400 chars) in:\n${out}`,
    ).toBeLessThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// TC-SCHEMA-6 — FP-SCHEMA-DETERMINISTIC
// ---------------------------------------------------------------------------

describe("buildAgentPrompt — Report Schema determinism", () => {
  it("renders the Report Schema block deterministically (idempotent) (TC-SCHEMA-6, UC-SCHEMA-6)", () => {
    const bundle = makeContextBundle();
    const out1 = buildAgentPrompt(bundle);
    const out2 = buildAgentPrompt(bundle);
    // Byte-identical output for identical input — guards against
    // any accidental clock / random-id usage in the schema block.
    expect(out2).toBe(out1);

    // And the schema block must actually be present in the
    // deterministic output (this guards the determinism assertion
    // against a degenerate "both empty" pass).
    expect(out1).toContain('"outputs"');
    expect(out1).toContain('"artifacts"');
    expect(out1).toContain('"signals"');
    expect(out1).toContain('"summary"');
  });
});

// ---------------------------------------------------------------------------
// TC-SCHEMA-7 — FP-SCHEMA-FIELDS + FP-SCHEMA-SIGNALS (empty signals)
// ---------------------------------------------------------------------------

describe("buildAgentPrompt — Report Schema with empty signals", () => {
  it("renders the Report Schema block even when bundle.signals is empty (TC-SCHEMA-7, UC-SCHEMA-7)", () => {
    const out = buildAgentPrompt(makeContextBundle({ signals: [] }));

    // Four quoted JSON keys still appear.
    expect(out).toContain('"outputs"');
    expect(out).toContain('"artifacts"');
    expect(out).toContain('"signals"');
    expect(out).toContain('"summary"');

    // Schema block heading still present.
    const schemaHeading = out.search(
      /^#{2,4}\s+(Report Schema|Agent Report Contract)/m,
    );
    expect(
      schemaHeading,
      `expected a Report Schema heading in:\n${out}`,
    ).toBeGreaterThanOrEqual(0);
  });
});
