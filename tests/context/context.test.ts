/**
 * Context Builder unit tests for WF-P5-CONTEXT (Step 1 — Cases and Tests).
 *
 * Covers:
 *   - resolveExpression: supported patterns, passthrough, empty string,
 *     whitespace tolerance, multi-occurrence, missing key passthrough.
 *   - buildContext: step selection, skill pack loading via expose, input
 *     resolution, artifact summary read, signal allowed_from filtering,
 *     permission merging, side-effect-free contract, edge cases.
 *
 * Reference:
 *   - docs/prd.md §14, FR-006
 *   - docs/architecture.md §5.2, §6.1, §12.2
 *   - docs/mvp-contracts.md §2.3, §2.4, §2.5, §5
 *   - docs/phases/p5-context-prompt/workflows/wf-p5-context/01-cases-and-tests.md
 *
 * Red-phase notes:
 *   - `src/expression/index.ts` currently exports `{}`; tests fail with
 *     import errors until Step 2 supplies `resolveExpression`.
 *   - `src/context/index.ts` currently exports `{}`; tests fail until Step 2
 *     supplies `buildContext`, `ContextBundle` and the supporting types.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { RunState } from "../../src/run/index.js";
import type { WorkflowDefinition } from "../../src/workflow/index.js";
import type { ArtifactMetadata } from "../../src/artifact/index.js";
import { WorkflowError } from "../../src/utils/index.js";

import {
  resolveExpression,
  type ExpressionContext,
} from "../../src/expression/index.js";
import {
  buildContext,
  isInlinePrompt,
  type ContextBundle,
} from "../../src/context/index.js";

// ---------------------------------------------------------------------------
// Constants and helper builders
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-08T00:00:00.000Z";
const FIXED_RUN_ID = "20260608-0001";

/**
 * Build a default ExpressionContext used by the resolveExpression unit tests.
 */
function makeExprCtx(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  const base: ExpressionContext = {
    inputs: { task: "fix the bug" },
    run: { id: FIXED_RUN_ID, workflow: "code-change" },
  };
  return {
    ...base,
    ...overrides,
    inputs: { ...base.inputs, ...(overrides.inputs ?? {}) },
    run: { ...base.run, ...(overrides.run ?? {}) },
  };
}

/**
 * Build a fully-populated RunState fixture for buildContext tests.
 */
function makeRunState(overrides: Partial<RunState> = {}): RunState {
  const base: RunState = {
    run_id: FIXED_RUN_ID,
    workflow: "code-change",
    task: "fix the bug",
    created_at: FIXED_ISO,
    status: "running",
    last_event_id: "evt-001",
    jobs: {
      plan: { status: "ready" },
    },
  };
  return { ...base, ...overrides };
}

/**
 * Build a minimal but valid WorkflowDefinition with a single agent step in
 * job "plan". Tests override per-case via deep-merge spread.
 */
function makeWorkflowDef(
  overrides: Partial<WorkflowDefinition> = {}
): WorkflowDefinition {
  const base: WorkflowDefinition = {
    name: "code-change",
    version: "0.1.0",
    skills: { code: "zigma.code-change" },
    jobs: {
      plan: {
        steps: [
          {
            id: "draft",
            type: "agent",
            expose: { skills: ["code"] },
            with: { goal: "${{ inputs.task }}" },
          },
        ],
      },
    },
  };
  return { ...base, ...overrides };
}

/**
 * Append one or more ArtifactMetadata records as JSON lines to
 * <runDir>/artifacts.jsonl.
 */
async function seedArtifactsJsonl(
  runDir: string,
  entries: ArtifactMetadata[]
): Promise<void> {
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
  await writeFile(join(runDir, "artifacts.jsonl"), lines, "utf-8");
}

/**
 * Build a simple ArtifactMetadata record for use with seedArtifactsJsonl.
 */
function makeArtifactMetadata(overrides: Partial<ArtifactMetadata> = {}): ArtifactMetadata {
  const base: ArtifactMetadata = {
    id: "artifact://20260608-0001/jobs/plan/attempts/1/steps/draft/notes",
    run_id: FIXED_RUN_ID,
    producer: { job: "plan", step: "draft", attempt: 1 },
    kind: "note",
    path: "jobs/plan/attempts/1/steps/draft/notes.md",
    content_type: "text/markdown",
    size: 42,
    summary: "Draft notes",
    created_at: FIXED_ISO,
  };
  return { ...base, ...overrides };
}

/**
 * Write a minimal skill-lock.json under `<zigmaflowDir>/.zigma-flow/`.
 */
async function seedSkillLock(
  zigmaflowDir: string,
  entries: Record<string, { resolved: string; version: string; hash: string }>
): Promise<void> {
  const flowDir = join(zigmaflowDir, ".zigma-flow");
  await mkdir(flowDir, { recursive: true });
  await writeFile(
    join(flowDir, "skill-lock.json"),
    JSON.stringify({ skills: entries }, null, 2),
    "utf-8"
  );
}

/**
 * Write a minimal skill pack at `<zigmaflowDir>/.zigma-flow/skills/<dir>/` with
 * the supplied skill.yml content plus required referenced files. Returns the
 * absolute pack root for diagnostic use.
 */
async function seedSkillPack(
  zigmaflowDir: string,
  dirName: string,
  skillYml: string,
  referencedFiles: Record<string, string> = {}
): Promise<string> {
  const packRoot = join(zigmaflowDir, ".zigma-flow", "skills", dirName);
  await mkdir(packRoot, { recursive: true });
  await writeFile(join(packRoot, "skill.yml"), skillYml, "utf-8");
  for (const [relPath, content] of Object.entries(referencedFiles)) {
    const fullPath = join(packRoot, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
  return packRoot;
}

/**
 * Snapshot file `stat` for side-effect assertions (mtime + size).
 */
async function snapshotFileStat(path: string): Promise<{ mtimeMs: number; size: number }> {
  const s = await stat(path);
  return { mtimeMs: s.mtimeMs, size: s.size };
}

// ---------------------------------------------------------------------------
// resolveExpression — FP-EXPR
// ---------------------------------------------------------------------------

describe("resolveExpression", () => {
  it("substitutes ${{ inputs.<key> }} from ctx.inputs (T-EXPR-1, UC-EXPR-1)", () => {
    const ctx = makeExprCtx({ inputs: { task: "fix bug" } });
    expect(resolveExpression("hello ${{ inputs.task }}", ctx)).toBe("hello fix bug");
  });

  it("substitutes ${{ run.id }} from ctx.run.id (T-EXPR-2, UC-EXPR-2)", () => {
    const ctx = makeExprCtx({ run: { id: FIXED_RUN_ID, workflow: "wf" } });
    expect(resolveExpression("run is ${{ run.id }}", ctx)).toBe(`run is ${FIXED_RUN_ID}`);
  });

  it("substitutes ${{ run.workflow }} from ctx.run.workflow (T-EXPR-3, UC-EXPR-3)", () => {
    const ctx = makeExprCtx({ run: { id: "x", workflow: "code-change" } });
    expect(resolveExpression("wf=${{ run.workflow }}", ctx)).toBe("wf=code-change");
  });

  it("passes unknown patterns through unchanged (T-EXPR-4, UC-EXPR-4)", () => {
    const ctx = makeExprCtx();
    const input = "unknown ${{ jobs.x.outputs.y }} and ${{ retry.reason }}";
    expect(resolveExpression(input, ctx)).toBe(input);
  });

  it("returns empty string for empty template (T-EXPR-5, UC-EXPR-5)", () => {
    expect(resolveExpression("", makeExprCtx())).toBe("");
  });

  it("substitutes multiple occurrences in one template (T-EXPR-6, UC-EXPR-6)", () => {
    const ctx = makeExprCtx({ inputs: { a: "1", b: "2" } });
    expect(resolveExpression("${{ inputs.a }} and ${{ inputs.b }}", ctx)).toBe("1 and 2");
  });

  it("tolerates whitespace inside ${{ ... }} braces (T-EXPR-7, UC-EXPR-7)", () => {
    const ctx = makeExprCtx({ inputs: { task: "x" } });
    expect(resolveExpression("${{  inputs.task  }}", ctx)).toBe("x");
  });

  it("keeps the literal pattern when the inputs key is missing (T-EXPR-8, UC-EXPR-8)", () => {
    const ctx = makeExprCtx({ inputs: { task: "fix bug" } });
    // 'missing' is not declared in ctx.inputs — pattern must NOT be replaced
    // with an empty string nor throw; it MUST be left literal.
    expect(resolveExpression("${{ inputs.missing }}", ctx)).toBe("${{ inputs.missing }}");
  });
});

// ---------------------------------------------------------------------------
// buildContext — fixture wiring
// ---------------------------------------------------------------------------

interface Sandbox {
  zigmaflowDir: string; // project root (parent of .zigma-flow/)
  runDir: string;       // <zigmaflowDir>/.zigma-flow/runs/<run-id>
}

async function makeSandbox(): Promise<Sandbox> {
  const zigmaflowDir = join(tmpdir(), `zigma-ctx-${randomUUID()}`);
  const runDir = join(zigmaflowDir, ".zigma-flow", "runs", FIXED_RUN_ID);
  await mkdir(runDir, { recursive: true });
  return { zigmaflowDir, runDir };
}

/**
 * A canonical skill.yml for a pack that declares 2 knowledge entries, 1
 * prompt, 1 function and (functions act as the agent function exposure
 * surface). Tests that need a different shape build their own.
 */
const CANONICAL_SKILL_YML = [
  "id: zigma.code-change",
  "name: Code Change",
  "version: 1.0.0",
  "kind: skill-pack",
  "description: Modify code by plan",
  "knowledge:",
  "  - id: rules",
  "    path: knowledge/rules.md",
  "    description: Project rules",
  "  - id: layout",
  "    path: knowledge/layout.md",
  "    description: Source layout",
  "prompts:",
  "  - id: implement",
  "    path: prompts/implement.md",
  "functions:",
  "  - id: implement-by-plan",
  "    description: Implement according to a plan",
  "    inputs:",
  "      plan: string",
  "    outputs:",
  "      changed_files: array",
  "",
].join("\n");

const CANONICAL_SKILL_FILES: Record<string, string> = {
  "knowledge/rules.md": "# rules",
  "knowledge/layout.md": "# layout",
  "prompts/implement.md": "# implement",
};

const CANONICAL_LOCK_ENTRY = {
  resolved: "local://skills/code-change",
  version: "1.0.0",
  hash: "sha256-placeholder",
};

const PRIMARY_PROMPT_SKILL_YML = [
  "id: zigma.code-change",
  "name: Code Change",
  "version: 1.0.0",
  "kind: skill-pack",
  "prompts:",
  "  - id: plan",
  "    path: prompts/plan.md",
  "  - id: draft",
  "    path: prompts/draft.md",
  "  - id: intake",
  "    path: prompts/intake.md",
  "  - id: review",
  "    path: prompts/review.md",
  "",
].join("\n");

const PRIMARY_PROMPT_SKILL_FILES: Record<string, string> = {
  "prompts/plan.md": "# Plan Primary\n\nPlan by job id.",
  "prompts/draft.md": "# Draft Primary\n\nDraft by step id.",
  "prompts/intake.md": "# Intake Primary\n\nIntake by step id.",
  "prompts/review.md": "# Review Primary\n\nReview from explicit prompt.",
};

// ---------------------------------------------------------------------------
// buildContext — step selection (FP-CTX-STEP, FP-CTX-EDGE)
// ---------------------------------------------------------------------------

describe("buildContext step selection", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sb.zigmaflowDir, { recursive: true, force: true });
  });

  it("picks step from state.jobs.<job>.current_step when present (T-CTX-STEP-1, UC-CTX-STEP-1)", async () => {
    await seedSkillLock(sb.zigmaflowDir, { "zigma.code-change": CANONICAL_LOCK_ENTRY });
    await seedSkillPack(sb.zigmaflowDir, "code-change", CANONICAL_SKILL_YML, CANONICAL_SKILL_FILES);

    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            { id: "first", type: "agent" },
            { id: "draft", type: "agent", expose: { skills: ["code"] } },
          ],
        },
      },
    });
    const state = makeRunState({
      jobs: { plan: { status: "ready", current_step: "draft" } as never },
    });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });
    expect(bundle.stepId).toBe("draft");
    expect(bundle.stepType).toBe("agent");
    expect(bundle.jobId).toBe("plan");
    expect(bundle.runId).toBe(FIXED_RUN_ID);
  });

  it("defaults to first step when current_step is absent (T-CTX-STEP-2, UC-CTX-STEP-2)", async () => {
    const workflowDef = makeWorkflowDef({
      skills: {},
      jobs: {
        plan: {
          steps: [
            { id: "first", type: "agent" },
            { id: "second", type: "agent" },
          ],
        },
      },
    });
    const state = makeRunState({ jobs: { plan: { status: "ready" } } });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });
    expect(bundle.stepId).toBe("first");
  });

  it("throws WorkflowError when jobId is unknown (T-CTX-STEP-3, UC-CTX-STEP-3)", async () => {
    const workflowDef = makeWorkflowDef();
    const state = makeRunState();

    await expect(
      buildContext({
        runDir: sb.runDir,
        zigmaflowDir: sb.zigmaflowDir,
        workflowDef,
        state,
        jobId: "nope",
      })
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

// ---------------------------------------------------------------------------
// buildContext — capability exposure (FP-CTX-EXPOSE)
// ---------------------------------------------------------------------------

describe("buildContext capability exposure", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sb.zigmaflowDir, { recursive: true, force: true });
  });

  it("loads skill packs declared in step.expose.skills (T-CTX-EXPOSE-1, UC-CTX-EXPOSE-1)", async () => {
    await seedSkillLock(sb.zigmaflowDir, { "zigma.code-change": CANONICAL_LOCK_ENTRY });
    await seedSkillPack(sb.zigmaflowDir, "code-change", CANONICAL_SKILL_YML, CANONICAL_SKILL_FILES);

    const workflowDef = makeWorkflowDef();
    const state = makeRunState();

    const bundle: ContextBundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });

    expect(bundle.capabilities.skills).toHaveLength(1);
    expect(bundle.capabilities.skills[0]?.alias).toBe("code");
    expect(bundle.capabilities.skills[0]?.skillId).toBe("zigma.code-change");
    expect(bundle.capabilities.skills[0]?.version).toBe("1.0.0");

    expect(bundle.capabilities.knowledge.length).toBeGreaterThanOrEqual(2);
    expect(bundle.capabilities.knowledge.map((k: { id: string }) => k.id)).toEqual(
      expect.arrayContaining(["rules", "layout"])
    );
    expect(bundle.capabilities.knowledge).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rules",
          path: "knowledge/rules.md",
          readPolicy: "optional",
          usage: "Project rules",
        }),
        expect.objectContaining({
          id: "layout",
          path: "knowledge/layout.md",
          readPolicy: "optional",
          usage: "Source layout",
        }),
      ]),
    );

    expect(bundle.capabilities.prompts.map((p: { id: string }) => p.id)).toContain("implement");
    expect(bundle.capabilities.prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "implement", path: "prompts/implement.md" }),
      ]),
    );
    expect(bundle.capabilities.functions.map((f: { id: string }) => f.id)).toContain(
      "implement-by-plan"
    );
  });

  it("adds required/optional reading strategy for built-in code-change knowledge (Issue #29)", async () => {
    const skillYml = [
      "id: zigma.code-change",
      "name: Code Change",
      "version: 1.0.0",
      "kind: skill-pack",
      "knowledge:",
      "  - id: coding-guidelines",
      "    path: knowledge/coding-guidelines.md",
      "    description: Coding rules",
      "  - id: workflow-guide",
      "    path: knowledge/workflow-guide.md",
      "    description: Workflow guide",
      "  - id: common-failure-patterns",
      "    path: knowledge/common-failure-patterns.md",
      "    description: Failure patterns",
      "",
    ].join("\n");
    await seedSkillLock(sb.zigmaflowDir, { "zigma.code-change": CANONICAL_LOCK_ENTRY });
    await seedSkillPack(sb.zigmaflowDir, "code-change", skillYml, {
      "knowledge/coding-guidelines.md": "# coding",
      "knowledge/workflow-guide.md": "# workflow",
      "knowledge/common-failure-patterns.md": "# failures",
    });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef: makeWorkflowDef(),
      state: makeRunState(),
      jobId: "plan",
    });

    expect(bundle.capabilities.knowledge).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "coding-guidelines",
          path: "knowledge/coding-guidelines.md",
          readPolicy: "required",
          usage: "read before starting this step",
        }),
        expect.objectContaining({
          id: "workflow-guide",
          path: "knowledge/workflow-guide.md",
          readPolicy: "required",
          usage: "report schema and workflow DAG reference",
        }),
        expect.objectContaining({
          id: "common-failure-patterns",
          path: "knowledge/common-failure-patterns.md",
          readPolicy: "optional",
          usage: "consult if unsure about approach, failure handling, or retry behavior",
        }),
      ]),
    );
  });

  it("returns empty capabilities when step has no expose (T-CTX-EXPOSE-2, UC-CTX-EXPOSE-2)", async () => {
    const workflowDef = makeWorkflowDef({
      skills: {},
      jobs: {
        plan: {
          steps: [{ id: "draft", type: "agent" }], // no expose
        },
      },
    });
    const state = makeRunState();

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });
    expect(bundle.capabilities.skills).toEqual([]);
    expect(bundle.capabilities.knowledge).toEqual([]);
    expect(bundle.capabilities.prompts).toEqual([]);
    expect(bundle.capabilities.functions).toEqual([]);
    expect(bundle.capabilities.tools).toEqual([]);
  });

  it("returns empty capabilities for non-agent steps even with expose (T-CTX-EXPOSE-3, UC-CTX-EXPOSE-3)", async () => {
    await seedSkillLock(sb.zigmaflowDir, { "zigma.code-change": CANONICAL_LOCK_ENTRY });
    await seedSkillPack(sb.zigmaflowDir, "code-change", CANONICAL_SKILL_YML, CANONICAL_SKILL_FILES);

    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            {
              id: "compile",
              type: "script",
              expose: { skills: ["code"] }, // declared but ignored for non-agent
            },
          ],
        },
      },
    });
    const state = makeRunState();

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });
    expect(bundle.capabilities.skills).toEqual([]);
    expect(bundle.capabilities.knowledge).toEqual([]);
    expect(bundle.capabilities.prompts).toEqual([]);
    expect(bundle.capabilities.functions).toEqual([]);
    expect(bundle.capabilities.tools).toEqual([]);
  });

  it("throws WorkflowError when expose alias is undeclared (T-CTX-EXPOSE-4, UC-CTX-EXPOSE-4)", async () => {
    const workflowDef = makeWorkflowDef({
      skills: {}, // no aliases declared
      jobs: {
        plan: {
          steps: [
            { id: "draft", type: "agent", expose: { skills: ["nope"] } },
          ],
        },
      },
    });
    const state = makeRunState();

    await expect(
      buildContext({
        runDir: sb.runDir,
        zigmaflowDir: sb.zigmaflowDir,
        workflowDef,
        state,
        jobId: "plan",
      })
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

// ---------------------------------------------------------------------------
// buildContext — primary prompt resolution (Issue #25)
// ---------------------------------------------------------------------------

describe("buildContext primary prompt resolution", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await makeSandbox();
    await seedSkillLock(sb.zigmaflowDir, { "zigma.code-change": CANONICAL_LOCK_ENTRY });
    await seedSkillPack(
      sb.zigmaflowDir,
      "code-change",
      PRIMARY_PROMPT_SKILL_YML,
      PRIMARY_PROMPT_SKILL_FILES,
    );
  });

  afterEach(async () => {
    await rm(sb.zigmaflowDir, { recursive: true, force: true });
  });

  it("resolves the primary prompt by job id before step id", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            { id: "draft", type: "agent", expose: { skills: ["code"] } },
          ],
        },
      },
    });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state: makeRunState(),
      jobId: "plan",
    });

    expect(bundle.primaryPrompt).toMatchObject({
      skill: "code",
      id: "plan",
      path: "prompts/plan.md",
      source: "job.id",
    });
    expect(bundle.primaryPrompt?.content).toContain("Plan by job id.");
    expect(bundle.warnings).toBeUndefined();
  });

  it("resolves the primary prompt by step id when job id does not match", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        analysis: {
          steps: [
            { id: "intake", type: "agent", expose: { skills: ["code"] } },
          ],
        },
      },
    });
    const state = makeRunState({
      jobs: { analysis: { status: "ready", current_step: "intake" } as never },
    });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "analysis",
    });

    expect(bundle.primaryPrompt).toMatchObject({
      skill: "code",
      id: "intake",
      path: "prompts/intake.md",
      source: "step.id",
    });
    expect(bundle.primaryPrompt?.content).toContain("Intake by step id.");
    expect(bundle.warnings).toBeUndefined();
  });

  it("resolves an explicit workflow step prompt before job id and step id", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              prompt: "review",
              expose: { skills: ["code"] },
            },
          ],
        },
      },
    });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state: makeRunState(),
      jobId: "plan",
    });

    expect(bundle.primaryPrompt).toMatchObject({
      skill: "code",
      id: "review",
      path: "prompts/review.md",
      source: "step.prompt",
    });
    expect(bundle.primaryPrompt?.content).toContain("Review from explicit prompt.");
    expect(bundle.warnings).toBeUndefined();
  });

  it("emits a warning and generated-context fallback when no primary prompt matches", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        noMatch: {
          steps: [
            { id: "unknown", type: "agent", expose: { skills: ["code"] } },
          ],
        },
      },
    });
    const state = makeRunState({
      jobs: { noMatch: { status: "ready", current_step: "unknown" } as never },
    });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "noMatch",
    });

    expect(bundle.primaryPrompt).toBeUndefined();
    expect(bundle.warnings?.[0]).toContain("No primary prompt resolved");
    expect(bundle.warnings?.[0]).toContain("Falling back");
  });
});

// ---------------------------------------------------------------------------
// buildContext — input resolution (FP-CTX-INPUTS)
// ---------------------------------------------------------------------------

describe("buildContext input resolution", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await makeSandbox();
    await seedSkillLock(sb.zigmaflowDir, { "zigma.code-change": CANONICAL_LOCK_ENTRY });
    await seedSkillPack(sb.zigmaflowDir, "code-change", CANONICAL_SKILL_YML, CANONICAL_SKILL_FILES);
  });

  afterEach(async () => {
    await rm(sb.zigmaflowDir, { recursive: true, force: true });
  });

  it("resolves ${{ inputs.task }} in step.with (T-CTX-IN-1, UC-CTX-INPUTS-1)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              expose: { skills: ["code"] },
              with: { goal: "${{ inputs.task }}", note: "static" },
            },
          ],
        },
      },
    });
    const state = makeRunState({ task: "fix the bug" });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });
    expect(bundle.inputs).toMatchObject({ goal: "fix the bug", note: "static" });
  });

  it("resolves ${{ run.id }} and ${{ run.workflow }} in step.with (T-CTX-IN-2, UC-CTX-INPUTS-2)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              expose: { skills: ["code"] },
              with: { ref: "${{ run.id }}/${{ run.workflow }}" },
            },
          ],
        },
      },
    });
    const state = makeRunState({ run_id: FIXED_RUN_ID, workflow: "wf" });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });
    expect(bundle.inputs.ref).toBe(`${FIXED_RUN_ID}/wf`);
  });

  it("leaves unsupported ${{ ... }} patterns as literal (T-CTX-IN-3, UC-CTX-INPUTS-3)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              expose: { skills: ["code"] },
              with: { x: "${{ jobs.foo.outputs.bar }}" },
            },
          ],
        },
      },
    });
    const state = makeRunState();

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });
    expect(bundle.inputs.x).toBe("${{ jobs.foo.outputs.bar }}");
  });

  it("drops non-string with values from inputs (T-CTX-IN-4, UC-CTX-INPUTS-4)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              expose: { skills: ["code"] },
              with: { count: 7, flag: true, name: "ok" },
            },
          ],
        },
      },
    });
    const state = makeRunState();

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });
    // MVP `inputs` is Record<string, string>; non-strings dropped.
    expect(bundle.inputs).not.toHaveProperty("count");
    expect(bundle.inputs).not.toHaveProperty("flag");
    expect(bundle.inputs.name).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// buildContext — artifact summaries (FP-CTX-ARTIFACT)
// ---------------------------------------------------------------------------

describe("buildContext artifact summaries", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await makeSandbox();
    await seedSkillLock(sb.zigmaflowDir, { "zigma.code-change": CANONICAL_LOCK_ENTRY });
    await seedSkillPack(sb.zigmaflowDir, "code-change", CANONICAL_SKILL_YML, CANONICAL_SKILL_FILES);
  });

  afterEach(async () => {
    await rm(sb.zigmaflowDir, { recursive: true, force: true });
  });

  it("projects artifacts.jsonl entries to ArtifactSummary (T-CTX-ART-1, UC-CTX-ART-1)", async () => {
    const m1 = makeArtifactMetadata({
      id: "artifact://x/jobs/plan/attempts/1/steps/draft/n1",
      kind: "note",
      path: "jobs/plan/attempts/1/steps/draft/n1.md",
      summary: "first",
      size: 10,
      content_type: "text/markdown",
    });
    const m2 = makeArtifactMetadata({
      id: "artifact://x/jobs/plan/attempts/1/steps/draft/log",
      kind: "log",
      path: "jobs/plan/attempts/1/steps/draft/log.txt",
      summary: "second",
      size: 20,
      content_type: "text/plain",
    });
    await seedArtifactsJsonl(sb.runDir, [m1, m2]);

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef: makeWorkflowDef(),
      state: makeRunState(),
      jobId: "plan",
    });

    expect(bundle.artifacts).toHaveLength(2);
    expect(bundle.artifacts[0]).toEqual({
      id: m1.id,
      kind: m1.kind,
      path: m1.path,
      summary: m1.summary,
      size: m1.size,
      content_type: m1.content_type,
    });
    // Ensure no full-metadata leakage.
    expect(bundle.artifacts[0]).not.toHaveProperty("producer");
    expect(bundle.artifacts[0]).not.toHaveProperty("run_id");
    expect(bundle.artifacts[0]).not.toHaveProperty("created_at");
  });

  it("returns empty artifacts when artifacts.jsonl is missing (T-CTX-ART-2, UC-CTX-ART-2)", async () => {
    // No artifacts.jsonl file written.
    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef: makeWorkflowDef(),
      state: makeRunState(),
      jobId: "plan",
    });
    expect(bundle.artifacts).toEqual([]);
  });

  it("returns empty artifacts when artifacts.jsonl is empty (T-CTX-ART-3, UC-CTX-ART-3)", async () => {
    await writeFile(join(sb.runDir, "artifacts.jsonl"), "", "utf-8");

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef: makeWorkflowDef(),
      state: makeRunState(),
      jobId: "plan",
    });
    expect(bundle.artifacts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildContext — signal filtering (FP-CTX-SIGNAL)
// ---------------------------------------------------------------------------

describe("buildContext signal filtering", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await makeSandbox();
    await seedSkillLock(sb.zigmaflowDir, { "zigma.code-change": CANONICAL_LOCK_ENTRY });
    await seedSkillPack(sb.zigmaflowDir, "code-change", CANONICAL_SKILL_YML, CANONICAL_SKILL_FILES);
  });

  afterEach(async () => {
    await rm(sb.zigmaflowDir, { recursive: true, force: true });
  });

  it("keeps signals whose allowed_from includes the jobId (T-CTX-SIG-1, UC-CTX-SIG-1)", async () => {
    const workflowDef = makeWorkflowDef({
      signals: {
        needs_review: {
          description: "Request review",
          allowed_from: ["plan"],
        },
      },
    });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state: makeRunState(),
      jobId: "plan",
    });
    expect(bundle.signals.map((s: { id: string }) => s.id)).toEqual(["needs_review"]);
  });

  it("filters out signals whose allowed_from excludes the jobId (T-CTX-SIG-2, UC-CTX-SIG-2)", async () => {
    const workflowDef = makeWorkflowDef({
      signals: {
        needs_review: { allowed_from: ["other-job"] },
      },
    });
    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state: makeRunState(),
      jobId: "plan",
    });
    expect(bundle.signals).toEqual([]);
  });

  it("returns empty signals when workflow has no signals block (T-CTX-SIG-3, UC-CTX-SIG-3)", async () => {
    const workflowDef = makeWorkflowDef(); // no `signals` declared
    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state: makeRunState(),
      jobId: "plan",
    });
    expect(bundle.signals).toEqual([]);
  });

  it("filters out signals without allowed_from (T-CTX-SIG-4, UC-CTX-SIG-4)", async () => {
    const workflowDef = makeWorkflowDef({
      signals: {
        broken: { description: "no allowed_from declared" },
      },
    });
    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state: makeRunState(),
      jobId: "plan",
    });
    expect(bundle.signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildContext — permission merging (FP-CTX-PERM)
// ---------------------------------------------------------------------------

describe("buildContext permission merging", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await makeSandbox();
    await seedSkillLock(sb.zigmaflowDir, { "zigma.code-change": CANONICAL_LOCK_ENTRY });
    await seedSkillPack(sb.zigmaflowDir, "code-change", CANONICAL_SKILL_YML, CANONICAL_SKILL_FILES);
  });

  afterEach(async () => {
    await rm(sb.zigmaflowDir, { recursive: true, force: true });
  });

  it("returns workflow defaults when job declares no permissions (T-CTX-PERM-1, UC-CTX-PERM-1)", async () => {
    const workflowDef = makeWorkflowDef({
      permissions: { fs: "ro" },
    });
    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state: makeRunState(),
      jobId: "plan",
    });
    expect(bundle.permissions).toEqual({ fs: "ro" });
  });

  it("applies job permission overrides on shared keys (T-CTX-PERM-2, UC-CTX-PERM-2)", async () => {
    const workflowDef = makeWorkflowDef({
      permissions: { fs: "ro" },
      jobs: {
        plan: {
          steps: [{ id: "draft", type: "agent", expose: { skills: ["code"] } }],
          permissions: { fs: "rw" },
        },
      },
    });
    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state: makeRunState(),
      jobId: "plan",
    });
    expect(bundle.permissions).toEqual({ fs: "rw" });
  });

  it("merges disjoint workflow and job permissions (T-CTX-PERM-3, UC-CTX-PERM-3)", async () => {
    const workflowDef = makeWorkflowDef({
      permissions: { fs: "ro" },
      jobs: {
        plan: {
          steps: [{ id: "draft", type: "agent", expose: { skills: ["code"] } }],
          permissions: { net: "deny" },
        },
      },
    });
    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state: makeRunState(),
      jobId: "plan",
    });
    expect(bundle.permissions).toEqual({ fs: "ro", net: "deny" });
  });

  it("returns empty permissions when neither workflow nor job declares any (T-CTX-PERM-4, UC-CTX-PERM-4)", async () => {
    const workflowDef = makeWorkflowDef(); // no top-level permissions
    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state: makeRunState(),
      jobId: "plan",
    });
    expect(bundle.permissions).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildContext — upstream outputs evidence bundle (FP-CTX-UPSTREAM)
// ---------------------------------------------------------------------------

describe("buildContext upstream outputs", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await makeSandbox();
    await seedSkillLock(sb.zigmaflowDir, { "zigma.code-change": CANONICAL_LOCK_ENTRY });
    await seedSkillPack(sb.zigmaflowDir, "code-change", CANONICAL_SKILL_YML, CANONICAL_SKILL_FILES);
  });

  afterEach(async () => {
    await rm(sb.zigmaflowDir, { recursive: true, force: true });
  });

  it("populates upstreamOutputs from completed jobs with outputs (T-CTX-UPSTREAM-1)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        intake: {
          steps: [{ id: "intake", type: "agent", uses: "zigma/intake" }],
        },
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              expose: { skills: ["code"] },
              with: { goal: "${{ inputs.task }}" },
            },
          ],
        },
      },
    });

    const state = makeRunState({
      jobs: {
        intake: {
          status: "completed",
          outputs: { summary: "intake done", risks: ["a", "b"] },
        },
        plan: { status: "running" },
      },
    });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });

    expect(bundle.upstreamOutputs).toBeDefined();
    expect(bundle.upstreamOutputs!["intake"]).toEqual({ summary: "intake done", risks: ["a", "b"] });
  });

  it("excludes the current job from upstreamOutputs (T-CTX-UPSTREAM-2)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              expose: { skills: ["code"] },
              with: { goal: "${{ inputs.task }}" },
            },
          ],
        },
      },
    });

    const state = makeRunState({
      jobs: {
        plan: {
          status: "running",
          outputs: { previous_plan: "something" },
        },
      },
    });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });

    // plan itself must not appear in upstreamOutputs
    expect(bundle.upstreamOutputs?.["plan"]).toBeUndefined();
  });

  it("omits upstreamOutputs when no completed jobs have outputs (T-CTX-UPSTREAM-3)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        intake: {
          steps: [{ id: "intake", type: "agent", uses: "zigma/intake" }],
        },
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              expose: { skills: ["code"] },
              with: { goal: "${{ inputs.task }}" },
            },
          ],
        },
      },
    });

    // intake completed but has no outputs
    const state = makeRunState({
      jobs: {
        intake: { status: "completed" },
        plan: { status: "running" },
      },
    });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });

    expect(bundle.upstreamOutputs).toBeUndefined();
  });

  it("excludes non-completed jobs even when they have outputs (T-CTX-UPSTREAM-4)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        intake: {
          steps: [{ id: "intake", type: "agent", uses: "zigma/intake" }],
        },
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              expose: { skills: ["code"] },
              with: { goal: "${{ inputs.task }}" },
            },
          ],
        },
      },
    });

    const state = makeRunState({
      jobs: {
        intake: { status: "running", outputs: { partial: "result" } },
        plan: { status: "running" },
      },
    });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });

    expect(bundle.upstreamOutputs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildContext — side-effect-free contract (FP-CTX-PURE)
// ---------------------------------------------------------------------------

describe("buildContext is side-effect free", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await makeSandbox();
    await seedSkillLock(sb.zigmaflowDir, { "zigma.code-change": CANONICAL_LOCK_ENTRY });
    await seedSkillPack(sb.zigmaflowDir, "code-change", CANONICAL_SKILL_YML, CANONICAL_SKILL_FILES);
  });

  afterEach(async () => {
    await rm(sb.zigmaflowDir, { recursive: true, force: true });
  });

  it("does not mutate state.json, events.jsonl, or artifacts.jsonl (T-CTX-PURE-1, UC-CTX-PURE-1)", async () => {
    // Seed the three observable files.
    const statePath = join(sb.runDir, "state.json");
    const eventsPath = join(sb.runDir, "events.jsonl");
    const artifactsPath = join(sb.runDir, "artifacts.jsonl");

    const state = makeRunState();
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
    await writeFile(eventsPath, JSON.stringify({ id: "evt-001" }) + "\n", "utf-8");
    await seedArtifactsJsonl(sb.runDir, [makeArtifactMetadata()]);

    const beforeState = await snapshotFileStat(statePath);
    const beforeEvents = await snapshotFileStat(eventsPath);
    const beforeArtifacts = await snapshotFileStat(artifactsPath);

    await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef: makeWorkflowDef(),
      state,
      jobId: "plan",
    });

    const afterState = await snapshotFileStat(statePath);
    const afterEvents = await snapshotFileStat(eventsPath);
    const afterArtifacts = await snapshotFileStat(artifactsPath);

    expect(afterState).toEqual(beforeState);
    expect(afterEvents).toEqual(beforeEvents);
    expect(afterArtifacts).toEqual(beforeArtifacts);
  });
});

// ---------------------------------------------------------------------------
// isInlinePrompt — FP-INLINE-DETECT (P12.9, WF-P12-INLINE-PROMPT Step 1)
// ---------------------------------------------------------------------------
// Imported from src/context/index.ts (moved from local helper in Step 2).

describe("isInlinePrompt", () => {
  it("returns true for multiline prompt (T-INLINE-DETECT-1, UC-INLINE-DETECT-1)", () => {
    expect(isInlinePrompt("line1\nline2")).toBe(true);
  });

  it("returns true for single-line prompt with ${{ }} expression (T-INLINE-DETECT-2, UC-INLINE-DETECT-2)", () => {
    expect(isInlinePrompt("Use ${{ inputs.task }} to proceed")).toBe(true);
  });

  it("returns true for single-line prompt with ${{ run.id }} expression", () => {
    expect(isInlinePrompt("Run: ${{ run.id }}")).toBe(true);
  });

  it("returns false for single-line reference ID (T-INLINE-DETECT-3, UC-INLINE-DETECT-3)", () => {
    expect(isInlinePrompt("review")).toBe(false);
  });

  it("returns false for another single-line reference ID like 'implement'", () => {
    expect(isInlinePrompt("implement")).toBe(false);
  });

  it("returns false for empty string (T-INLINE-DETECT-4, UC-INLINE-DETECT-4)", () => {
    expect(isInlinePrompt("")).toBe(false);
  });

  it("returns false for undefined (T-INLINE-DETECT-5, UC-INLINE-DETECT-5)", () => {
    expect(isInlinePrompt(undefined)).toBe(false);
  });

  it("returns false for whitespace-only prompt (T-INLINE-DETECT-6, UC-INLINE-DETECT-6)", () => {
    expect(isInlinePrompt("   ")).toBe(false);
    expect(isInlinePrompt("\t  \t")).toBe(false);
  });

  it("returns true for Windows line endings (T-INLINE-DETECT-7, UC-INLINE-DETECT-7)", () => {
    expect(isInlinePrompt("line1\r\nline2")).toBe(true);
  });

  it("returns true for YAML block scalar style multiline prompt", () => {
    // Simulates what a YAML | block scalar produces
    const yamlBlockScalar = "You are implementing a feature.\n\n" +
      "Task: ${{ inputs.task }}\n" +
      "Run ID: ${{ run.id }}\n";
    expect(isInlinePrompt(yamlBlockScalar)).toBe(true);
  });

  it("returns false for a single-line string that looks like a skill pack prompt ID", () => {
    expect(isInlinePrompt("zigma.code-change.implement")).toBe(false);
  });

  it("returns true when prompt has ${{ }} but no newlines (single-line expression)", () => {
    // Edge case: single-line template that uses expression but is not multiline
    expect(isInlinePrompt("complete ${{ inputs.goal }} using plan")).toBe(true);
  });

  it("returns false for prompt that has double braces but not ${{ }} syntax", () => {
    // {{ alone without $ prefix is not an expression token
    expect(isInlinePrompt("use {{ braces }} but not expression")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildContext — inline prompt conflict detection (FP-INLINE-CONFLICT)
// ---------------------------------------------------------------------------
// These tests verify the detection logic used by the conflict check.
// Step 2 will add full buildContext-level integration tests that assert
// WorkflowError is thrown when an inline prompt matches a Skill Pack
// prompt ID.

describe("buildContext inline prompt conflict detection", () => {
  it("isInlinePrompt detects possible conflict when inline text matches a prompt ID (T-INLINE-CONFLICT-1)", () => {
    // If step.prompt = "review" (a single word), and that word is also
    // a Skill Pack prompt ID, we need isInlinePrompt to tell us whether
    // it's inline or a reference. For pure text like "review" (no newlines,
    // no ${{ }}), isInlinePrompt returns false → no conflict possible.
    // Conflict only arises when isInlinePrompt returns true but the raw
    // text happens to look like a Skill Pack prompt ID.
    //
    // Example conflict scenario:
    //   step.prompt = "review\n\nCheck the changes."  ← inline (multiline)
    //   Skill Pack has prompt id: "review"            ← matching ID
    //
    // The inline prompt text trimmed is "review\n\nCheck the changes." which
    // does NOT match prompt id "review" (because it has newlines and extra
    // content). For a genuine conflict, the trimmed raw text would need to
    // be a short single-line value like "review" that also contains newlines
    // or ${{ }}. This is an unusual edge case but the detection is correct.

    // Verify: a multiline prompt with first line "review" is inline
    const inlineWithReview = "review\n\nCheck the implementation.";
    expect(isInlinePrompt(inlineWithReview)).toBe(true);

    // Verify: trimmed text does NOT cleanly match "review"
    expect(inlineWithReview.trim()).not.toBe("review");

    // For a true conflict, the inline text's trimmed value would need to
    // equal a prompt ID. Example:
    //   step.prompt = "review\n"  ← trimmed to "review", still inline (has \n)
    //   Skill Pack prompt id: "review"
    const inlineBareId = "review\n";
    expect(isInlinePrompt(inlineBareId)).toBe(true);
    expect(inlineBareId.trim()).toBe("review");
    // This is the conflict scenario: inline detected, trimmed text matches
    // a Skill Pack prompt ID → Step 2 should throw WorkflowError.
  });

  it("isInlinePrompt returns false for reference ID (no conflict possible) (T-INLINE-CONFLICT-2)", () => {
    // A normal Skill Pack reference — no inline, no conflict
    expect(isInlinePrompt("review")).toBe(false);
    expect(isInlinePrompt("plan")).toBe(false);
    expect(isInlinePrompt("implement")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildContext — inline prompt resolution (FP-INLINE-RESOLVE, FP-INLINE-CONFLICT)
// ---------------------------------------------------------------------------

describe("buildContext inline prompt resolution", () => {
  let sb: Sandbox;

  beforeEach(async () => {
    sb = await makeSandbox();
    await seedSkillLock(sb.zigmaflowDir, { "zigma.code-change": CANONICAL_LOCK_ENTRY });
    await seedSkillPack(
      sb.zigmaflowDir,
      "code-change",
      PRIMARY_PROMPT_SKILL_YML,
      PRIMARY_PROMPT_SKILL_FILES,
    );
  });

  afterEach(async () => {
    await rm(sb.zigmaflowDir, { recursive: true, force: true });
  });

  it("resolves inline multiline prompt with expose.skills (T-INLINE-RESOLVE-1)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              prompt: "Do the task\n\nTask: ${{ inputs.task }}",
              expose: { skills: ["code"] },
            },
          ],
        },
      },
    });
    const state = makeRunState({ task: "fix bug" });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });

    expect(bundle.primaryPrompt).toMatchObject({
      skill: "code",
      id: "(inline)",
      path: "(inline template)",
      source: "step.prompt",
    });
    // Content contains resolved expression
    expect(bundle.primaryPrompt?.content).toContain("Task: fix bug");
    // No warning for inline prompt
    expect(bundle.warnings).toBeUndefined();
  });

  it("resolves inline prompt without expose.skills (T-INLINE-RESOLVE-2)", async () => {
    const workflowDef = makeWorkflowDef({
      skills: {},
      jobs: {
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              prompt: "Do ${{ inputs.task }}",
            },
          ],
        },
      },
    });
    const state = makeRunState({ task: "fix bug" });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });

    expect(bundle.primaryPrompt).toMatchObject({
      skill: "",
      id: "(inline)",
      path: "(inline template)",
      source: "step.prompt",
    });
    expect(bundle.primaryPrompt?.content).toBe("Do fix bug");
    // No warning should be emitted when inline prompt resolves
    expect(bundle.warnings).toBeUndefined();
  });

  it("resolves ${{ run.id }} and ${{ run.workflow }} in inline prompt (T-INLINE-RESOLVE-3)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              prompt: "Run ${{ run.id }} in ${{ run.workflow }}",
              expose: { skills: ["code"] },
            },
          ],
        },
      },
    });
    const state = makeRunState({ run_id: "test-001", workflow: "code-change" });

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });

    expect(bundle.primaryPrompt?.content).toBe("Run test-001 in code-change");
  });

  it("passes unknown ${{ }} expressions through unchanged (T-INLINE-RESOLVE-4)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              prompt: "Task: ${{ jobs.x.outputs.y }}",
              expose: { skills: ["code"] },
            },
          ],
        },
      },
    });
    const state = makeRunState();

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });

    expect(bundle.primaryPrompt?.content).toContain("${{ jobs.x.outputs.y }}");
  });

  it("populates capabilities when inline prompt has expose.skills (T-INLINE-RESOLVE-5)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              prompt: "Do the work\n\nInline task.",
              expose: { skills: ["code"] },
            },
          ],
        },
      },
    });
    const state = makeRunState();

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });

    // Capabilities should still be populated from exposed skills
    expect(bundle.capabilities.skills).toHaveLength(1);
    expect(bundle.capabilities.skills[0]?.alias).toBe("code");
    expect(bundle.capabilities.prompts.length).toBeGreaterThan(0);
  });

  it("throws WorkflowError when inline prompt conflicts with Skill Pack prompt id (T-INLINE-CONFLICT-1)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              prompt: "review\n",
              expose: { skills: ["code"] },
            },
          ],
        },
      },
    });
    const state = makeRunState();

    await expect(
      buildContext({
        runDir: sb.runDir,
        zigmaflowDir: sb.zigmaflowDir,
        workflowDef,
        state,
        jobId: "plan",
      }),
    ).rejects.toThrow(WorkflowError);
  });

  it("does not conflict when single-line reference matches Skill Pack prompt id (normal resolution) (T-INLINE-CONFLICT-2)", async () => {
    const workflowDef = makeWorkflowDef({
      jobs: {
        plan: {
          steps: [
            {
              id: "draft",
              type: "agent",
              prompt: "review",
              expose: { skills: ["code"] },
            },
          ],
        },
      },
    });
    const state = makeRunState();

    const bundle = await buildContext({
      runDir: sb.runDir,
      zigmaflowDir: sb.zigmaflowDir,
      workflowDef,
      state,
      jobId: "plan",
    });

    // Normal Skill Pack resolution — not inline, no conflict
    expect(bundle.primaryPrompt).toMatchObject({
      skill: "code",
      id: "review",
      source: "step.prompt",
    });
    expect(bundle.primaryPrompt?.content).toContain("Review from explicit prompt.");
  });
});
