/**
 * Prompt Quality Gate unit tests (Wave 1, Issue #107).
 *
 * Tests each of the 6 detection categories with both positive and negative
 * cases. The quality gate is additive — it does not replace existing
 * validatePromptHandoff checks.
 */

import { describe, expect, it } from "vitest";
import { runQualityGate } from "../../src/prompt/qualityGate.js";
import type { QualityGateContext } from "../../src/prompt/qualityGate.js";

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const BASE_CONTEXT: QualityGateContext = {
  runId: "20260701-0001",
  jobId: "plan",
  stepId: "draft",
  attempt: 1,
  hasPrimaryPrompt: true,
  allowGenericPrompt: false,
  isReadOnly: true,
  hasEditPermissions: false,
  validArtifactPaths: [
    "jobs/intake/attempts/1/steps/analyze/report.json",
    "jobs/intake/attempts/1/steps/analyze/stdout.txt",
  ],
};

function makeContext(overrides: Partial<QualityGateContext> = {}): QualityGateContext {
  return { ...BASE_CONTEXT, ...overrides };
}

function reportPath(context: QualityGateContext = BASE_CONTEXT): string {
  return `.zigma-flow/runs/${context.runId}/jobs/${context.jobId}/attempts/${context.attempt}/steps/${context.stepId}/report.json`;
}

// ---------------------------------------------------------------------------
// Helper: build a clean prompt with minimal valid sections
// ---------------------------------------------------------------------------

function cleanPrompt(context: QualityGateContext = BASE_CONTEXT): string {
  return [
    "# test/step Prompt Packet",
    "",
    "## System Prompt",
    "",
    "You are a Zigma Flow Agent Step executor.",
    "",
    "## Task Prompt",
    "",
    "Overall run task: do something",
    "",
    "## Workflow Step Prompt",
    "",
    "Current workflow scope: job \"plan\", step \"draft\", attempt 1.",
    "### Custom Instruction",
    "",
    "Implement the feature according to the plan.",
    "",
    "## Context Blocks",
    "",
    "(none)",
    "",
    "## Output Contract",
    "",
    "Write your report to:",
    "",
    `  \`${reportPath(context)}\``,
    "",
    "This is the canonical step artifact path.",
    "This is a runtime artifact file.",
    "",
    "### Required Outputs",
    "",
    "(none declared)",
    "",
    "### Required Artifacts",
    "",
    "(none declared)",
    "",
    "### Allowed Signals",
    "",
    "(none)",
    "",
    "### Artifact Rules",
    "",
    "- Write the Agent report to the canonical report path only.",
    "- Use artifact references for large logs, diffs, test results, and generated files.",
    "- Do not place full large artifact contents in the prompt or report JSON.",
    "",
    "### Report Schema",
    "",
    'The file must be valid JSON with exactly these required top-level fields:',
    "",
    '```json',
    '{',
    '  "outputs": {},',
    '  "artifacts": [],',
    '  "signals": [],',
    '  "summary": ""',
    '}',
    '```',
    "",
    '- "outputs": current step output values.',
    '- "artifacts": artifact references for large outputs.',
    '- "signals": structured workflow-change requests from the allowed list above.',
    '- "summary": short execution summary.',
    "",
    "Complete the current step, write report.json, then stop. 完成当前 step 后停止.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 1. Unresolved template markers
// ---------------------------------------------------------------------------

describe("Unresolved template markers", () => {
  it("detects remaining {{...}} markers in the prompt (positive)", () => {
    const prompt = cleanPrompt() + "\n\n{{unresolved_marker}}";
    const result = runQualityGate(prompt, makeContext());

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unresolved_template_markers",
          severity: "error",
        }),
      ]),
    );
    expect(result.passed).toBe(false);
  });

  it("detects multiple unresolved markers (positive)", () => {
    const prompt = cleanPrompt() + "\n\n{{marker_one}} and {{marker_two}}";
    const result = runQualityGate(prompt, makeContext());

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unresolved_template_markers",
          severity: "error",
        }),
      ]),
    );
  });

  it("passes clean prompts with no {{...}} patterns (negative)", () => {
    const result = runQualityGate(cleanPrompt(), makeContext());
    const markerIssues = result.issues.filter(
      (i) => i.code === "unresolved_template_markers",
    );
    expect(markerIssues).toHaveLength(0);
  });

  it("passes prompts with plain text curly braces like {foo} (negative)", () => {
    const prompt = cleanPrompt() + "\n\nPlain text curly braces like {foo} are fine.";
    const result = runQualityGate(prompt, makeContext());
    const markerIssues = result.issues.filter(
      (i) => i.code === "unresolved_template_markers",
    );
    expect(markerIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Missing report path
// ---------------------------------------------------------------------------

describe("Missing report path", () => {
  it("detects when canonical report path is missing (positive)", () => {
    const prompt = cleanPrompt().replace(reportPath(), ".zigma-flow/runs/missing/report.json");
    const result = runQualityGate(prompt, makeContext());

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_report_path",
          severity: "error",
        }),
      ]),
    );
    expect(result.passed).toBe(false);
  });

  it("passes when canonical report path is present (negative)", () => {
    const result = runQualityGate(cleanPrompt(), makeContext());
    const pathIssues = result.issues.filter((i) => i.code === "missing_report_path");
    expect(pathIssues).toHaveLength(0);
  });

  it("passes when report path is present with different attempt number (negative)", () => {
    const ctx = makeContext({ attempt: 3 });
    const prompt = cleanPrompt(ctx);
    const result = runQualityGate(prompt, ctx);
    const pathIssues = result.issues.filter((i) => i.code === "missing_report_path");
    expect(pathIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Missing step instructions
// ---------------------------------------------------------------------------

describe("Missing step instructions", () => {
  it("detects when Workflow Step Prompt section contains only fallback text (positive)", () => {
    const prompt = cleanPrompt().replace(
      /### Custom Instruction\n\nImplement the feature according to the plan\./,
      "No primary Skill Pack prompt was resolved for this step. Use the task prompt, context blocks, and output contract to complete only the current step.",
    );
    const result = runQualityGate(prompt, makeContext());

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_step_instructions",
          severity: "error",
        }),
      ]),
    );
    expect(result.passed).toBe(false);
  });

  it("detects empty Workflow Step Prompt section (positive)", () => {
    const prompt = cleanPrompt().replace(
      /^## Workflow Step Prompt[\s\S]*?(?=^## Context Blocks)/m,
      "## Workflow Step Prompt\n\n",
    );
    const result = runQualityGate(prompt, makeContext());

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_step_instructions",
          severity: "error",
        }),
      ]),
    );
  });

  it("detects missing Workflow Step Prompt section entirely (positive)", () => {
    const prompt = cleanPrompt().replace(
      /^## Workflow Step Prompt[\s\S]*?(?=^## Context Blocks)/m,
      "",
    );
    const result = runQualityGate(prompt, makeContext());

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_step_instructions",
          severity: "error",
        }),
      ]),
    );
  });

  it("passes when step has actionable instructions (negative)", () => {
    const result = runQualityGate(cleanPrompt(), makeContext());
    const stepIssues = result.issues.filter((i) => i.code === "missing_step_instructions");
    expect(stepIssues).toHaveLength(0);
  });

  it("passes when step section has custom content mixed with boilerplate (negative)", () => {
    const prompt = cleanPrompt().replace(
      /### Custom Instruction\n\nImplement the feature according to the plan\./,
      "Current workflow scope: job \"plan\", step \"draft\", attempt 1.\n\n## Task\n\nImplement the feature.",
    );
    const result = runQualityGate(prompt, makeContext());
    const stepIssues = result.issues.filter((i) => i.code === "missing_step_instructions");
    expect(stepIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Read-only/write wording conflict
// ---------------------------------------------------------------------------

describe("Read-only/write wording conflict", () => {
  it("detects read-only mode with edits: write (positive)", () => {
    const prompt = cleanPrompt() + "\nThis job operates in read-only mode.\n- edits: write\n";
    const result = runQualityGate(prompt, makeContext());

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "read_only_write_conflict",
          severity: "error",
        }),
      ]),
    );
    expect(result.passed).toBe(false);
  });

  it("detects read-only mode with **edits** bold marker (positive)", () => {
    const prompt = cleanPrompt() + "\nThis job operates in read-only mode.\n**edits**\n";
    const result = runQualityGate(prompt, makeContext());

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "read_only_write_conflict",
          severity: "error",
        }),
      ]),
    );
  });

  it("passes when read-only mode but no edits: write (negative)", () => {
    const result = runQualityGate(cleanPrompt(), makeContext());
    const conflictIssues = result.issues.filter((i) => i.code === "read_only_write_conflict");
    expect(conflictIssues).toHaveLength(0);
  });

  it("passes when edits: write but no read-only mode (negative)", () => {
    const prompt = cleanPrompt() + "\n- edits: write\n";
    const result = runQualityGate(prompt, makeContext({ isReadOnly: false }));
    const conflictIssues = result.issues.filter((i) => i.code === "read_only_write_conflict");
    expect(conflictIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Future artifact leakage
// ---------------------------------------------------------------------------

describe("Future artifact leakage", () => {
  it("detects artifact reference to a future job step (positive)", () => {
    const prompt = cleanPrompt() +
      "\n\nSee the output at `.zigma-flow/runs/20260701-0001/jobs/review/attempts/1/steps/critique/report.json`";
    const result = runQualityGate(prompt, makeContext());

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "future_artifact_leakage",
          severity: "error",
        }),
      ]),
    );
    expect(result.passed).toBe(false);
  });

  it("passes when no artifact paths outside valid set are referenced (negative)", () => {
    const result = runQualityGate(cleanPrompt(), makeContext());
    const leakIssues = result.issues.filter((i) => i.code === "future_artifact_leakage");
    expect(leakIssues).toHaveLength(0);
  });

  it("passes when referenced paths are in the valid set (negative)", () => {
    const prompt = cleanPrompt() +
      "\n\nSee `.zigma-flow/runs/20260701-0001/jobs/intake/attempts/1/steps/analyze/report.json`";
    const result = runQualityGate(prompt, makeContext());
    const leakIssues = result.issues.filter((i) => i.code === "future_artifact_leakage");
    expect(leakIssues).toHaveLength(0);
  });

  it("skips leakage check when validArtifactPaths is empty (negative)", () => {
    const prompt = cleanPrompt() +
      "\n\nSee `.zigma-flow/runs/20260701-0001/jobs/review/attempts/1/steps/critique/report.json`";
    const result = runQualityGate(prompt, makeContext({ validArtifactPaths: [] }));
    const leakIssues = result.issues.filter((i) => i.code === "future_artifact_leakage");
    expect(leakIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. No-primary-prompt warning
// ---------------------------------------------------------------------------

describe("No-primary-prompt warning", () => {
  it("warns when step has no primary prompt and uses fallback (positive)", () => {
    const prompt = cleanPrompt().replace(
      /### Custom Instruction\n\nImplement the feature according to the plan\./,
      "No primary Skill Pack prompt was resolved for this step. Use the task prompt, context blocks, and output contract to complete only the current step.",
    );
    const result = runQualityGate(prompt, makeContext({ hasPrimaryPrompt: false }));

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "no_primary_prompt",
          severity: "warning",
        }),
      ]),
    );
  });

  it("passes when hasPrimaryPrompt is true (negative)", () => {
    const prompt = cleanPrompt().replace(
      /### Custom Instruction\n\nImplement the feature according to the plan\./,
      "No primary Skill Pack prompt was resolved for this step. Use the task prompt, context blocks, and output contract to complete only the current step.",
    );
    const result = runQualityGate(prompt, makeContext({ hasPrimaryPrompt: true }));
    const noPromptIssues = result.issues.filter((i) => i.code === "no_primary_prompt");
    expect(noPromptIssues).toHaveLength(0);
  });

  it("passes when allowGenericPrompt is true (negative)", () => {
    const prompt = cleanPrompt().replace(
      /### Custom Instruction\n\nImplement the feature according to the plan\./,
      "No primary Skill Pack prompt was resolved for this step.",
    );
    const result = runQualityGate(
      prompt,
      makeContext({ hasPrimaryPrompt: false, allowGenericPrompt: true }),
    );
    const noPromptIssues = result.issues.filter((i) => i.code === "no_primary_prompt");
    expect(noPromptIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: full clean prompt should pass all checks
// ---------------------------------------------------------------------------

describe("Clean prompt passes all checks", () => {
  it("passes a fully clean prompt with no issues", () => {
    const result = runQualityGate(cleanPrompt(), makeContext());
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});
