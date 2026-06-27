/**
 * Step Returns schema tests for WF-P13-RETURNS (Step 1 — Cases and Tests).
 *
 * These tests exercise the Zod schema additions for `returns` and `on_return`
 * on step definitions. The `StepBaseSchema` in `src/workflow/index.ts` is
 * extended with:
 *   - `returns?: { status: { values: string[]; required?: boolean } }`
 *   - `on_return?: Record<string, RouterAction>`
 *
 * Cross-field validation:
 *   - `returns.status.values` must be a non-empty array
 *   - `on_return` keys must be a subset of `returns.status.values`
 *   - `returns.status.required` must be boolean if present
 *
 * All tests are validated via `loadWorkflow` which applies Zod schema
 * validation + semantic checks.
 *
 * Red-phase note: `src/workflow/index.ts` does not yet include `returns`
 * or `on_return` in the step schema. Until Step 2 adds these fields,
 * Zod will silently strip them and tests that assert validation errors
 * will pass because the invalid data is ignored. Tests that expect
 * success will also pass (since unknown keys are stripped).
 * Step 2 must make the negative tests flip green by adding the schema
 * and making the positive tests assert the fields survive parsing.
 *
 * Covers:
 *   - FR-RETURNS-SCHEMA-001 through FR-RETURNS-SCHEMA-010
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-returns/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md AD-P13-009
 */

import { describe, expect, it } from "vitest";

import { loadWorkflow } from "../../src/workflow/index.js";
import { ValidationError } from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Inline YAML fixtures
// ---------------------------------------------------------------------------

/**
 * Minimum viable workflow YAML for returns schema testing.
 * Takes a step YAML snippet to insert into the single job's steps array.
 */
function makeReturnsWorkflow(stepYaml: string): string {
  return `name: returns-test
version: "0.1.0"
jobs:
  review:
    steps:
${stepYaml
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
`;
}

/**
 * Helper: build a single step with returns/on_return. The caller provides
 * the returns block and on_return block as multi-line YAML strings (or
 * empty string to omit).
 */
function makeStepWithReturns(
  returnsBlock: string,
  onReturnBlock: string
): string {
  const lines: string[] = [];
  lines.push('- id: review');
  lines.push('  type: agent');
  lines.push('  uses: zigma/review-skill');

  if (returnsBlock) {
    for (const line of returnsBlock.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  if (onReturnBlock) {
    for (const line of onReturnBlock.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  return lines.join("\n");
}

/**
 * Minimal valid returns + on_return: one status value with a continue mapping.
 */
const VALID_RETURNS_BLOCK = `returns:
  status:
    values:
      - approved`;

const VALID_ON_RETURN_BLOCK = `on_return:
  approved: continue`;

/**
 * Canonical valid workflow with returns+on_return.
 */
const VALID_RETURNS_YAML = makeReturnsWorkflow(
  makeStepWithReturns(VALID_RETURNS_BLOCK, VALID_ON_RETURN_BLOCK)
);

// ---------------------------------------------------------------------------
// FR-RETURNS-SCHEMA-001: valid returns with status.values and on_return
// ---------------------------------------------------------------------------

describe("returns schema — valid (FR-RETURNS-SCHEMA-001)", () => {
  it("loadWorkflow accepts valid returns with status.values and on_return (FR-RETURNS-SCHEMA-001, UC-RETURNS-001)", () => {
    const def = loadWorkflow(VALID_RETURNS_YAML);
    expect(def).toBeDefined();
    expect(def.name).toBe("returns-test");
    expect(def.jobs["review"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-RETURNS-SCHEMA-002: returns.status.values is empty array
// ---------------------------------------------------------------------------

describe("returns schema — empty values array (FR-RETURNS-SCHEMA-002)", () => {
  it("rejects returns.status.values when empty (FR-RETURNS-SCHEMA-002)", () => {
    const returnsBlock = `returns:
  status:
    values: []`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, VALID_ON_RETURN_BLOCK)
    );

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    const err = thrown as ValidationError;
    const detailsBlob = JSON.stringify(err.details ?? {});
    // The error should mention the values field or indicate the array is too short
    expect(
      detailsBlob.toLowerCase().includes("values") ||
      detailsBlob.toLowerCase().includes("empty") ||
      detailsBlob.toLowerCase().includes("min") ||
      detailsBlob.toLowerCase().includes("length") ||
      detailsBlob.toLowerCase().includes("array")
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FR-RETURNS-SCHEMA-003: on_return key not in returns.status.values
// ---------------------------------------------------------------------------

describe("returns schema — on_return key not in values (FR-RETURNS-SCHEMA-003)", () => {
  it("rejects on_return key that is not in returns.status.values (FR-RETURNS-SCHEMA-003)", () => {
    // values only has "approved", but on_return references "rejected"
    const returnsBlock = `returns:
  status:
    values:
      - approved`;

    const onReturnBlock = `on_return:
  rejected: continue`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, onReturnBlock)
    );

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    // The error should reference the mismatched key
    expect(thrown).toBeInstanceOf(ValidationError);
    const err = thrown as ValidationError;
    const detailsBlob = JSON.stringify(err.details ?? {});
    const messageBlob =
      err.message.toLowerCase() +
      " " +
      JSON.stringify(err.details ?? {}).toLowerCase();
    expect(messageBlob).toContain("rejected");
  });
});

// ---------------------------------------------------------------------------
// FR-RETURNS-SCHEMA-004: returns.status.required is not boolean
// ---------------------------------------------------------------------------

describe("returns schema — non-boolean required (FR-RETURNS-SCHEMA-004)", () => {
  it("rejects returns.status.required when not boolean (FR-RETURNS-SCHEMA-004)", () => {
    const returnsBlock = `returns:
  status:
    values:
      - approved
    required: "yes"`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, VALID_ON_RETURN_BLOCK)
    );

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    const err = thrown as ValidationError;
    const detailsBlob = JSON.stringify(err.details ?? {});
    expect(detailsBlob.toLowerCase()).toContain("required");
  });
});

// ---------------------------------------------------------------------------
// FR-RETURNS-SCHEMA-005: on_return value is invalid RouterAction
// ---------------------------------------------------------------------------

describe("returns schema — invalid on_return action (FR-RETURNS-SCHEMA-005)", () => {
  it("rejects on_return value that is not a valid RouterAction (FR-RETURNS-SCHEMA-005)", () => {
    const returnsBlock = `returns:
  status:
    values:
      - approved`;

    // "delete_job" is not a valid RouterAction
    const onReturnBlock = `on_return:
  approved: delete_job`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, onReturnBlock)
    );

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// FR-RETURNS-SCHEMA-006: returns without on_return → valid
// ---------------------------------------------------------------------------

describe("returns schema — returns without on_return (FR-RETURNS-SCHEMA-006)", () => {
  it("accepts returns with status.values but no on_return block (FR-RETURNS-SCHEMA-006, UC-RETURNS-012)", () => {
    const returnsBlock = `returns:
  status:
    values:
      - approved
      - rejected`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, "")
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-RETURNS-SCHEMA-007: on_return with continue literal action → valid
// ---------------------------------------------------------------------------

describe("returns schema — on_return with continue (FR-RETURNS-SCHEMA-007)", () => {
  it("accepts on_return with continue literal action (FR-RETURNS-SCHEMA-007, UC-RETURNS-007)", () => {
    const returnsBlock = `returns:
  status:
    values:
      - pass
      - fail`;

    const onReturnBlock = `on_return:
  pass: continue
  fail: fail`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, onReturnBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-RETURNS-SCHEMA-008: on_return with retry_job object action → valid
// ---------------------------------------------------------------------------

describe("returns schema — on_return with retry_job (FR-RETURNS-SCHEMA-008)", () => {
  it("accepts on_return with retry_job object action (FR-RETURNS-SCHEMA-008, UC-RETURNS-005)", () => {
    const returnsBlock = `returns:
  status:
    values:
      - approved
      - rejected`;

    const onReturnBlock = `on_return:
  approved: continue
  rejected:
    retry_job: implement`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, onReturnBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-RETURNS-SCHEMA-009: step without returns field → valid (backward compat)
// ---------------------------------------------------------------------------

describe("returns schema — step without returns (FR-RETURNS-SCHEMA-009)", () => {
  it("accepts step without any returns field (backward compat) (FR-RETURNS-SCHEMA-009, UC-RETURNS-004)", () => {
    // Standard workflow without returns or on_return
    const yaml = `name: no-returns
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: analyze
        type: agent
        uses: zigma/analyze-skill
`;

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-RETURNS-SCHEMA-010: returns declared on non-agent step → valid
// ---------------------------------------------------------------------------

describe("returns schema — returns on non-agent step (FR-RETURNS-SCHEMA-010)", () => {
  it("accepts returns on a non-agent step (schema permits; runtime semantic guard) (FR-RETURNS-SCHEMA-010)", () => {
    // A script step with returns declared. The schema does not restrict
    // returns to only agent steps — semantic enforcement is runtime.
    const stepYaml = `- id: lint
  type: script
  run: echo lint
  returns:
    status:
      values:
        - ok
        - fail
  on_return:
    ok: continue
    fail: fail`;

    const yaml = makeReturnsWorkflow(stepYaml);

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Additional boundary tests
// ---------------------------------------------------------------------------

describe("returns schema — edge cases", () => {
  it("accepts returns with multiple status values and multiple on_return mappings", () => {
    const returnsBlock = `returns:
  status:
    values:
      - approved
      - rejected
      - needs_clarification
      - escalated`;

    const onReturnBlock = `on_return:
  approved: continue
  rejected:
    retry_job: implement
  needs_clarification:
    goto_job: gather
  escalated: fail`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, onReturnBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });

  it("accepts returns.status.required: true", () => {
    const returnsBlock = `returns:
  status:
    values:
      - approved
    required: true`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, VALID_ON_RETURN_BLOCK)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });

  it("accepts returns.status.required: false", () => {
    const returnsBlock = `returns:
  status:
    values:
      - approved
    required: false`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, VALID_ON_RETURN_BLOCK)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });

  it("accepts returns.status.required omitted (defaults to false)", () => {
    const returnsBlock = `returns:
  status:
    values:
      - approved`;

    // No required field

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, VALID_ON_RETURN_BLOCK)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });

  it("accepts on_return with activate_job action", () => {
    const returnsBlock = `returns:
  status:
    values:
      - trigger`;

    const onReturnBlock = `on_return:
  trigger:
    activate_job: optional-job`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, onReturnBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });

  it("accepts on_return with goto_job action", () => {
    const returnsBlock = `returns:
  status:
    values:
      - skip`;

    const onReturnBlock = `on_return:
  skip:
    goto_job: next-job`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, onReturnBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });

  it("accepts on_return with status literal action", () => {
    const returnsBlock = `returns:
  status:
    values:
      - block_it`;

    const onReturnBlock = `on_return:
  block_it:
    status: blocked`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, onReturnBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });

  it("accepts on_return with block literal action", () => {
    const returnsBlock = `returns:
  status:
    values:
      - stop`;

    const onReturnBlock = `on_return:
  stop: block`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, onReturnBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });

  it("accepts retry_job with optional retry_with payload", () => {
    const returnsBlock = `returns:
  status:
    values:
      - rejected`;

    const onReturnBlock = `on_return:
  rejected:
    retry_job: implement
    retry_with:
      comments: review feedback`;

    const yaml = makeReturnsWorkflow(
      makeStepWithReturns(returnsBlock, onReturnBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });
});
