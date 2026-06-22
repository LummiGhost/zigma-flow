/**
 * Prompt Builder unit tests for WF-P5-PROMPT (Step 1 — Cases and Tests).
 *
 * Covers:
 *   - buildAgentPrompt section rendering and confinement contract.
 *   - writePromptArtifact: current-step.md mirror, step-scoped artifact,
 *     artifacts.jsonl index entry.
 *   - readActiveRun / writeActiveRun pointer helpers.
 *   - createRun extension: writes active_run into config.json.
 *   - promptAction pipeline: job/step selection, agent-step assertion,
 *     prompt_generated event emission, state transition, error mapping.
 *
 * Reference:
 *   - docs/prd.md §14, FR-006, §17
 *   - docs/architecture.md §5.2, §10, §12.2
 *   - docs/mvp-contracts.md §2.4, §2.5, §5, §7
 *   - docs/phases/p5-context-prompt/workflows/wf-p5-prompt/01-cases-and-tests.md
 *
 * Red-phase notes:
 *   - `src/prompt/index.ts` currently exports `{}`; tests fail with import
 *     errors until Step 2 supplies `buildAgentPrompt` and
 *     `writePromptArtifact`.
 *   - `readActiveRun` / `writeActiveRun` are not yet exported from
 *     `src/run/index.ts`; tests fail with named-export errors until Step 2
 *     adds them.
 *   - `src/commands/prompt.ts` does not yet exist; tests fail with module
 *     resolution errors until Step 2 creates it.
 *   - `createRun` does not yet write `active_run`; T-CREATE-1 fails until
 *     Step 2 extends the engine.
 *   - `buildContext` is delivered by WF-P5-CONTEXT Step 2, which precedes
 *     this workflow.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { ContextBundle } from "../../src/context/index.js";
import type { Clock, RunState } from "../../src/run/index.js";
import {
  LocalStateStore,
  readActiveRun,
  writeActiveRun,
} from "../../src/run/index.js";
import { createRun } from "../../src/engine/index.js";
import {
  buildAgentPrompt,
  buildPromptPacket,
  renderPromptPacket,
  validatePromptPacket,
  validatePromptHandoff,
  writePromptArtifact,
} from "../../src/prompt/index.js";
import { promptAction } from "../../src/commands/prompt.js";
import {
  ConfigError,
  StateError,
  UserInputError,
  WorkflowError,
} from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Constants and shared fixtures
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-08T00:00:00.000Z";
const FIXED_RUN_ID = "20260608-0001";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Build a fully-populated ContextBundle suitable for the render tests.
 * Render tests must NOT depend on `buildContext` — the renderer contract is
 * independent of how the bundle was assembled.
 */
function makeContextBundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  const base: ContextBundle = {
    runId: FIXED_RUN_ID,
    jobId: "plan",
    stepId: "draft",
    attempt: 1,
    stepType: "agent",
    runTask: "fix the bug",
    primaryPrompt: {
      skill: "code",
      id: "plan",
      path: "prompts/plan.md",
      content: "# Primary Plan Prompt\n\nCreate a concrete implementation plan.",
      source: "job.id",
    },
    capabilities: {
      skills: [
        { alias: "code", skillId: "zigma.code-change", version: "1.0.0" },
      ],
      knowledge: [
        {
          skill: "code",
          id: "rules",
          path: "knowledge/rules.md",
          description: "Project rules",
          readPolicy: "required",
          usage: "read before starting this step",
        },
        {
          skill: "code",
          id: "layout",
          path: "knowledge/layout.md",
          description: "Source layout",
          readPolicy: "optional",
          usage: "consult for repository structure",
        },
      ],
      prompts: [
        { skill: "code", id: "plan", path: "prompts/plan.md" },
        { skill: "code", id: "implement", path: "prompts/implement.md" },
      ],
      functions: [
        {
          skill: "code",
          id: "implement-by-plan",
          description: "Implement code by plan",
          inputs: { plan: "string" },
          outputs: { changed_files: "array" },
        },
      ],
      tools: [{ skill: "code", id: "grep" }],
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

/**
 * Sandbox builder: creates a fresh project root with a `.zigma-flow/` skeleton
 * (config.json, runs/, skill-lock.json placeholder).
 */
interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;     // alias for projectRoot — the API expects the
                            // parent directory of `.zigma-flow/`.
  dotZigma: string;         // <projectRoot>/.zigma-flow
  configPath: string;       // <dotZigma>/config.json
  runsDir: string;          // <dotZigma>/runs
  skillLockPath: string;    // <dotZigma>/skill-lock.json
}

async function makeSandbox(opts: { activeRun?: string | null } = {}): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-prompt-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const configPath = join(dotZigma, "config.json");
  const skillLockPath = join(dotZigma, "skill-lock.json");

  await mkdir(runsDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ tool_version: "0.1.0", active_run: opts.activeRun ?? null }, null, 2),
    "utf-8",
  );
  await writeFile(
    skillLockPath,
    JSON.stringify({ skills: {} }, null, 2),
    "utf-8",
  );

  return {
    projectRoot,
    zigmaflowDir: projectRoot,
    dotZigma,
    configPath,
    runsDir,
    skillLockPath,
  };
}

/**
 * Seed a minimal run directory containing run.yml, state.json and empty
 * events.jsonl. The supplied workflow YAML is written next to the project
 * root so `run.yml.workflow.path` is reproducible.
 */
interface SeedRunOpts {
  sandbox: Sandbox;
  runId: string;
  workflowYaml: string;
  state: RunState;
  /**
   * If supplied, write each line to events.jsonl in order before the test
   * runs. This sequence is used to make state.last_event_id match the tail
   * of events.jsonl (avoiding StateError on validateLastEventId).
   */
  events?: Array<Record<string, unknown>>;
}

async function seedRun(opts: SeedRunOpts): Promise<{
  runDir: string;
  workflowPath: string;
}> {
  const runDir = join(opts.sandbox.runsDir, opts.runId);
  await mkdir(runDir, { recursive: true });

  const workflowPath = join(opts.sandbox.projectRoot, "code-change.yml");
  await writeFile(workflowPath, opts.workflowYaml, "utf-8");

  // run.yml — minimum metadata Step 2 needs to resolve the workflow path.
  const runYml = [
    `task: ${JSON.stringify(opts.state.task)}`,
    "workflow:",
    `  name: ${JSON.stringify(opts.state.workflow)}`,
    `  path: ${JSON.stringify(workflowPath)}`,
    `created_at: ${JSON.stringify(opts.state.created_at)}`,
    `skill_lock_snapshot: "skill-lock.snapshot.json"`,
    "",
  ].join("\n");
  await writeFile(join(runDir, "run.yml"), runYml, "utf-8");

  // events.jsonl — seed before state.json so last_event_id matches tail.
  if (opts.events && opts.events.length > 0) {
    const lines = opts.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(runDir, "events.jsonl"), lines, "utf-8");
  } else {
    await writeFile(join(runDir, "events.jsonl"), "", "utf-8");
  }

  // state.json — written directly so the test does not depend on createRun.
  await writeFile(join(runDir, "state.json"), JSON.stringify(opts.state, null, 2), "utf-8");

  // Copy skill-lock as the per-run snapshot.
  await writeFile(join(runDir, "skill-lock.snapshot.json"), JSON.stringify({ skills: {} }, null, 2), "utf-8");

  return { runDir, workflowPath };
}

/**
 * Build a RunState fixture.
 */
function makeRunState(overrides: Partial<RunState> = {}): RunState {
  const base: RunState = {
    run_id: FIXED_RUN_ID,
    workflow: "code-change",
    task: "fix the bug",
    created_at: FIXED_ISO,
    status: "running",
    last_event_id: "evt-002",
    jobs: {
      plan: { status: "ready" },
    },
  };
  return { ...base, ...overrides };
}

/**
 * Minimal workflow YAML with a single agent step in job "plan".
 */
const SINGLE_AGENT_WORKFLOW_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  plan:
    steps:
      - id: draft
        type: agent
        with:
          goal: "\${{ inputs.task }}"
`;

/**
 * Workflow YAML where the current step of job "build" is a script step
 * (used for the agent-step assertion failure test).
 */
const SCRIPT_STEP_WORKFLOW_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  build:
    steps:
      - id: compile
        type: script
        uses: code.scripts.collect-diff
`;

/**
 * Workflow YAML with two no-dependency jobs (both ready), used for the
 * multiple-ready-jobs ambiguity test.
 */
const TWO_READY_WORKFLOW_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  plan:
    steps:
      - id: draft
        type: agent
  review:
    steps:
      - id: critique
        type: agent
`;

/**
 * The seed events sequence used by the happy-path tests so that
 * `validateLastEventId` is satisfied (snapshot.last_event_id = "evt-002").
 */
const SEED_EVENTS: Array<Record<string, unknown>> = [
  {
    id: "evt-001",
    type: "run_created",
    run_id: FIXED_RUN_ID,
    timestamp: FIXED_ISO,
    producer: "engine",
    job: null,
    step: null,
    attempt: null,
    payload: { workflow: "code-change", task: "fix the bug" },
  },
  {
    id: "evt-002",
    type: "job_ready",
    run_id: FIXED_RUN_ID,
    timestamp: FIXED_ISO,
    producer: "engine",
    job: null,
    step: null,
    attempt: null,
    payload: { job_id: "plan" },
  },
];

// ---------------------------------------------------------------------------
// PromptPacket contract — P12.5
// ---------------------------------------------------------------------------

describe("PromptPacket contract", () => {
  it("builds explicit system/task/step/context/output packet layers", () => {
    const packet = buildPromptPacket(makeContextBundle());

    expect(packet.system.block.title).toBe("System Prompt");
    expect(packet.system.invariants).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Engine owns all workflow state transitions"),
      ]),
    );
    expect(packet.system.boundaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Skill Pack knowledge, prompts, functions, and tools"),
        expect.stringContaining("cannot modify workflow state"),
      ]),
    );

    expect(packet.task).toMatchObject({
      source: "run.input",
      task: "fix the bug",
    });
    expect(packet.step).toMatchObject({
      source: "job.id",
      jobId: "plan",
      stepId: "draft",
      promptId: "plan",
      promptPath: "prompts/plan.md",
    });
    expect(packet.output.reportPath).toBe(
      ".zigma-flow/runs/20260608-0001/jobs/plan/attempts/1/steps/draft/report.json",
    );
    expect(packet.output.reportSchema.requiredTopLevelFields).toEqual([
      "outputs",
      "artifacts",
      "signals",
      "summary",
    ]);
  });

  it("creates typed, sorted context blocks without large artifact body injection", () => {
    const packet = buildPromptPacket(
      makeContextBundle({
        artifacts: [
          {
            id: "artifact://20260608-0001/jobs/intake/attempts/1/steps/analyze/report",
            kind: "agent_report",
            path: "jobs/intake/attempts/1/steps/analyze/report.json",
            summary: "Intake summary",
            size: 123,
            content_type: "application/json",
          },
        ],
      }),
    );

    const priorities = packet.context.map((block) => block.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
    expect(packet.context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "artifact-summary",
          source: "artifact://20260608-0001/jobs/intake/attempts/1/steps/analyze/report",
          freshness: "prior",
          artifactRef: "artifact://20260608-0001/jobs/intake/attempts/1/steps/analyze/report",
          path: "jobs/intake/attempts/1/steps/analyze/report.json",
        }),
        expect.objectContaining({
          type: "knowledge-summary",
          source: "code.rules",
          freshness: "static",
        }),
        expect.objectContaining({
          type: "workspace-scan",
          source: "workflow.workspace",
          freshness: "current",
        }),
      ]),
    );
    expect(JSON.stringify(packet.context)).not.toContain("# full artifact body");
  });

  it("filters prompt and prompt_packet_* artifacts from context blocks (Issue #60)", () => {
    const packet = buildPromptPacket(
      makeContextBundle({
        artifacts: [
          {
            id: "artifact://20260608-0001/jobs/plan/attempts/1/steps/draft/current-step",
            kind: "prompt",
            path: "jobs/plan/attempts/1/steps/draft/current-step.md",
            summary: "Plan step prompt",
            size: 456,
            content_type: "text/markdown",
          },
          {
            id: "artifact://20260608-0001/jobs/plan/attempts/1/steps/draft/prompt-packet/system",
            kind: "prompt_packet_system",
            path: "jobs/plan/attempts/1/steps/draft/prompt-packet/system.md",
            summary: "System prompt packet block",
            size: 789,
            content_type: "text/markdown",
          },
          {
            id: "artifact://20260608-0001/jobs/intake/attempts/1/steps/analyze/report",
            kind: "agent_report",
            path: "jobs/intake/attempts/1/steps/analyze/report.json",
            summary: "Intake summary",
            size: 123,
            content_type: "application/json",
          },
        ],
      }),
    );

    // Prompt artifacts should not appear in context blocks
    const promptBlocks = packet.context.filter(
      (b) => b.type === "artifact-summary" && b.artifactRef && b.artifactRef.includes("current-step"),
    );
    expect(promptBlocks).toHaveLength(0);

    // prompt_packet_* artifacts should not appear in context blocks
    const packetBlocks = packet.context.filter(
      (b) => b.type === "artifact-summary" && b.artifactRef && b.artifactRef.includes("prompt-packet"),
    );
    expect(packetBlocks).toHaveLength(0);

    // Other artifact kinds (e.g. agent_report) should still appear
    const reportBlocks = packet.context.filter(
      (b) => b.type === "artifact-summary" && b.artifactRef && b.artifactRef.includes("intake"),
    );
    expect(reportBlocks).toHaveLength(1);
    expect(reportBlocks[0]!.type).toBe("artifact-summary");
    expect(reportBlocks[0]!.source).toBe(
      "artifact://20260608-0001/jobs/intake/attempts/1/steps/analyze/report",
    );
  });

  it("renders system-capable backend payloads with system and user separated", () => {
    const packet = buildPromptPacket(makeContextBundle());
    const rendered = renderPromptPacket(packet, { supportsSystemPrompt: true });

    expect(rendered.system).toContain("You are a Zigma Flow Agent Step executor.");
    expect(rendered.user).toMatch(/^# plan\/draft Agent Prompt/);
    expect(rendered.user).not.toMatch(/^##\s+System Prompt/m);
    expect(rendered.user).toMatch(/^##\s+Task Prompt/m);
    expect(rendered.user).toMatch(/^##\s+Workflow Step Prompt/m);
    expect(rendered.user).toMatch(/^##\s+Context Blocks/m);
    expect(rendered.user).toMatch(/^##\s+Output Contract/m);
    expect(rendered.user).toContain("### Primary Plan Prompt");
    expect(rendered.user).not.toMatch(/^#\s+Primary Plan Prompt/m);
  });

  it("packet quality gate catches missing output contract and oversized context", () => {
    const packet = buildPromptPacket(makeContextBundle());
    const missingOutput = buildAgentPrompt(makeContextBundle()).replace(/^## Output Contract[\s\S]*$/m, "");

    expect(validatePromptPacket(packet, missingOutput).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_output_contract" }),
      ]),
    );

    const oversizedPacket = {
      ...packet,
      context: [
        {
          id: "huge",
          type: "artifact-summary" as const,
          source: "artifact://huge",
          priority: 100,
          freshness: "prior" as const,
          summary: "x".repeat(4_001),
          artifactRef: "artifact://huge",
        },
      ],
    };
    const rendered = renderPromptPacket(oversizedPacket).markdown;

    expect(validatePromptPacket(oversizedPacket, rendered).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "context_block_too_large" }),
      ]),
    );
  });

  it("packet quality gate rejects nested top-level headings in composed markdown", () => {
    const packet = buildPromptPacket(makeContextBundle());
    const malformed = renderPromptPacket(packet).markdown.replace(
      "### Primary Plan Prompt",
      "# Primary Plan Prompt",
    );

    expect(validatePromptPacket(packet, malformed).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "prompt_heading_hierarchy" }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// buildAgentPrompt — FP-PROMPT-RENDER / FP-PROMPT-CONFINE
// ---------------------------------------------------------------------------

describe("buildAgentPrompt — section rendering", () => {
  it("renders PromptPacket layers in fixed order (T-RENDER-1, UC-RENDER-1)", () => {
    const out = buildAgentPrompt(makeContextBundle());

    const headers = [
      out.indexOf("# "),
      out.search(/^##\s+System Prompt/m),
      out.search(/^##\s+Task Prompt/m),
      out.search(/^##\s+Workflow Step Prompt/m),
      out.search(/^##\s+Context Blocks/m),
      out.search(/^##\s+Output Contract/m),
    ];
    for (const idx of headers) {
      expect(idx, `header missing in:\n${out}`).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < headers.length; i++) {
      expect(headers[i]!, `header at position ${i} out of order`).toBeGreaterThan(
        headers[i - 1]!,
      );
    }
    expect(out.match(/^#\s+/gm)).toHaveLength(1);

    expect(out).toContain("Global invariants");
    expect(out).toContain("Overall run task");
    expect(out).toContain("Current workflow scope");
    expect(out).toContain("workspace-mode");
    expect(out).toContain("rules");
    expect(out).toContain("layout");
    expect(out).toContain("path: `knowledge/rules.md`");
    expect(out).toContain("required: read before starting this step");
    expect(out).toContain("optional: consult for repository structure");
    expect(out).toContain("implement-by-plan");
    expect(out).toContain("Primary step prompt rendered");
    expect(out).not.toContain("Reference prompt only");
    expect(out).toContain("not a callable runtime API");
    expect(out).toContain("grep");
    expect(out).toContain("needs_review");
    expect(out).toContain("fix the bug");
  });

  it("renders Workflow Step Prompt after Task Prompt and includes primary prompt markdown (Issue #25)", () => {
    const out = buildAgentPrompt(makeContextBundle());

    const taskIdx = out.search(/^##\s+Task Prompt/m);
    const stepIdx = out.search(/^##\s+Workflow Step Prompt/m);
    const contextIdx = out.search(/^##\s+Context Blocks/m);

    expect(stepIdx).toBeGreaterThan(taskIdx);
    expect(contextIdx).toBeGreaterThan(stepIdx);
    expect(out).toContain("### Primary Plan Prompt");
    expect(out).not.toMatch(/^#\s+Primary Plan Prompt/m);
    expect(out).not.toMatch(/^##\s+Primary Plan Prompt/m);
    expect(out).toContain("Create a concrete implementation plan.");
  });

  it("renders a minimal packet when capabilities and signals are empty (T-RENDER-2, UC-RENDER-2)", () => {
    const bundle = makeContextBundle({
      capabilities: {
        skills: [],
        knowledge: [],
        prompts: [],
        functions: [],
        tools: [],
      },
      signals: [],
      inputs: {},
    });
    const out = buildAgentPrompt(bundle);

    expect(out).toMatch(/^##\s+Context Blocks/m);
    expect(out).toContain("workspace-mode");
    expect(out).toMatch(/^###\s+Allowed Signals/m);
    expect(out).toContain("(none)");
  });

  it("includes 完成当前 step 后停止 and a report.json reference (T-RENDER-3, UC-RENDER-3)", () => {
    const out = buildAgentPrompt(makeContextBundle());
    expect(out).toContain("完成当前 step 后停止");
    expect(out).toContain("report.json");
  });

  it("renders the canonical POSIX report.json path under jobs/<job>/attempts/ (T-RENDER-5, UC-RENDER-4)", () => {
    const out = buildAgentPrompt(
      makeContextBundle({ runId: "20260615-0003", jobId: "intake", stepId: "analyze", attempt: 2 }),
    );

    expect(out).toContain(
      ".zigma-flow/runs/20260615-0003/jobs/intake/attempts/2/steps/analyze/report.json",
    );
    expect(out).toContain("jobs/intake/attempts/");
    expect(out).not.toContain("jobs\\intake\\attempts\\");
    expect(out).toContain("canonical step artifact path");
    expect(out).toContain("Engine to reject the report");
    expect(out).toContain("runtime artifact file");
  });

  it("includes an explicit 'cannot modify workflow state' forbidden-action line (T-RENDER-4, UC-RENDER-4)", () => {
    const out = buildAgentPrompt(makeContextBundle());
    // Case-insensitive substring match — Step 2 may phrase the line slightly
    // differently, but the literal phrase "cannot modify workflow state" is
    // load-bearing per PRD FR-006 and architecture §10.
    expect(out.toLowerCase()).toContain("cannot modify workflow state");
  });

  it("separates read-only repository workspace permission from runtime artifact permission (T-RENDER-5, UC-RENDER-5)", () => {
    const out = buildAgentPrompt(
      makeContextBundle({
        permissions: {
          contents: "read",
          edits: "write",
          workflow_state: "none",
        },
        repositoryWorkspace: { mode: "read-only" },
      }),
    );

    expect(out).toContain(
      "This job operates in read-only mode. You must not modify files in the repository.",
    );
    expect(out).not.toContain("edits: write");
    expect(out).not.toContain("**edits**");
    expect(out).toContain(
      "Writing report.json to the canonical runtime artifact path is allowed and required.",
    );
    expect(out).toContain("This is a runtime artifact file.");
  });

  it("states that writable jobs may modify repository files according to the task (T-RENDER-6, UC-RENDER-6)", () => {
    const out = buildAgentPrompt(
      makeContextBundle({
        permissions: {
          contents: "read",
          edits: "write",
          workflow_state: "none",
        },
      }),
    );

    expect(out).toContain("This job may modify repository files according to the task.");
    expect(out).not.toContain("edits: write");
    expect(out).not.toContain("**edits**");
  });
});

describe("buildAgentPrompt — confinement", () => {
  it("does not name jobs other than bundle.jobId (T-CONFINE-1, UC-CONFINE-1)", () => {
    const bundle = makeContextBundle({ jobId: "plan", stepId: "draft" });
    const out = buildAgentPrompt(bundle);
    // The bundle's renderer must not be given access to other jobs, so
    // it should not surface names like "review", "build", "intake".
    for (const other of ["review", "build", "intake"]) {
      expect(out).not.toContain(`job: ${other}`);
      expect(out).not.toMatch(new RegExp(`\\b${other}\\b.*step`, "i"));
    }
  });

  it("does not name steps other than bundle.stepId (T-CONFINE-2, UC-CONFINE-2)", () => {
    const bundle = makeContextBundle({ jobId: "plan", stepId: "draft" });
    const out = buildAgentPrompt(bundle);
    for (const other of ["collect-diff", "route", "analyze", "implement-step"]) {
      // We allow the *capability* id "implement" / "implement-by-plan"
      // because those are skill exports, not step ids. Step 2 will need
      // to avoid step-naming for any step other than `draft`.
      expect(out).not.toContain(`step: ${other}`);
    }
  });

  it("does not reproduce workflow YAML (no top-level name:/version:/jobs: lines) (T-CONFINE-3, UC-CONFINE-3)", () => {
    const out = buildAgentPrompt(makeContextBundle());
    // The renderer must NOT serialize the workflow YAML. We assert the
    // absence of three load-bearing YAML keys at line start.
    expect(out).not.toMatch(/^name:\s/m);
    expect(out).not.toMatch(/^version:\s/m);
    expect(out).not.toMatch(/^jobs:\s/m);
  });
});

describe("validatePromptHandoff — quality gate", () => {
  it("accepts a complete generated prompt with no errors", () => {
    const bundle = makeContextBundle({
      inputs: { task: "fix the handoff prompt" },
      permissions: { contents: "read", commands: "none", workflow_state: "none" },
      repositoryWorkspace: { mode: "read-only" },
    });
    const out = buildAgentPrompt(bundle);

    const result = validatePromptHandoff(out, bundle);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("fails when the Workflow Step Prompt section is missing", () => {
    const bundle = makeContextBundle();
    const out = buildAgentPrompt(bundle).replace(/^## Workflow Step Prompt[\s\S]*?(?=^## Context Blocks)/m, "");

    const result = validatePromptHandoff(out, bundle);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_step_prompt" }),
      ]),
    );
  });

  it("fails when the canonical report.json path is missing", () => {
    const bundle = makeContextBundle();
    const out = buildAgentPrompt(bundle).replace(
      ".zigma-flow/runs/20260608-0001/jobs/plan/attempts/1/steps/draft/report.json",
      ".zigma-flow/runs/20260608-0001/report.json",
    );

    const result = validatePromptHandoff(out, bundle);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_report_path" }),
      ]),
    );
  });

  it("warns when the original task input text is absent", () => {
    const bundle = makeContextBundle({ runTask: "preserve this task text" });
    const out = buildAgentPrompt(bundle).replace("preserve this task text", "redacted task");

    const result = validatePromptHandoff(out, bundle);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_task_input" }),
      ]),
    );
  });

  it("warns when a read-only prompt exposes edits: write wording", () => {
    const bundle = makeContextBundle({
      permissions: { contents: "read", edits: "write" },
      repositoryWorkspace: { mode: "read-only" },
    });
    const out = `${buildAgentPrompt(bundle)}\n- edits: write\n`;

    const result = validatePromptHandoff(out, bundle);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "read_only_edits_write" }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// writePromptArtifact — FP-PROMPT-ARTIFACT
// ---------------------------------------------------------------------------

describe("writePromptArtifact", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = join(tmpdir(), `zigma-prompt-artifact-${randomUUID()}`);
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("writes current-step.md mirror and step-scoped artifact with identical bytes (T-ARTIFACT-1, UC-ARTIFACT-1)", async () => {
    const promptText = "# Prompt body";

    await writePromptArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      jobId: "plan",
      stepId: "draft",
      attempt: 1,
      prompt: promptText,
      clock: new FakeClock(),
    });

    const mirror = await readFile(join(runDir, "current-step.md"), "utf-8");
    expect(mirror).toBe(promptText);

    const stepScoped = join(
      runDir,
      "jobs",
      "plan",
      "attempts",
      "1",
      "steps",
      "draft",
      "current-step.md",
    );
    const stepText = await readFile(stepScoped, "utf-8");
    expect(stepText).toBe(promptText);
  });

  it("appends one prompt-kind line to artifacts.jsonl and returns its artifact id (T-ARTIFACT-2, UC-ARTIFACT-1, UC-ARTIFACT-2)", async () => {
    const promptText = "# Prompt body 2";

    const result = await writePromptArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      jobId: "plan",
      stepId: "draft",
      attempt: 1,
      prompt: promptText,
      clock: new FakeClock(),
    });

    const indexText = await readFile(join(runDir, "artifacts.jsonl"), "utf-8");
    const lines = indexText.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]!) as {
      id: string;
      kind: string;
      content_type: string;
      producer: { job: string; step: string; attempt: number };
      path: string;
    };
    expect(entry.kind).toBe("prompt");
    expect(entry.content_type).toMatch(/^text\/markdown/);
    expect(entry.producer).toEqual({ job: "plan", step: "draft", attempt: 1 });
    expect(entry.path).toBe("jobs/plan/attempts/1/steps/draft/current-step.md");

    // The returned ref must match the step-scoped artifact id (not the
    // top-level mirror, which is not artifact-tracked).
    expect(result.artifactRef).toBe(entry.id);
    expect(result.artifactRef).toBe(
      `artifact://${FIXED_RUN_ID}/jobs/plan/attempts/1/steps/draft/current-step`,
    );
  });

  it("writes PromptPacket blocks to separate files with a backend composition manifest", async () => {
    const packet = buildPromptPacket(makeContextBundle());
    const promptText = renderPromptPacket(packet).markdown;

    const result = await writePromptArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      jobId: "plan",
      stepId: "draft",
      attempt: 1,
      prompt: promptText,
      packet,
      clock: new FakeClock(),
    });

    expect(result.packetArtifactRefs).toBeDefined();
    expect(result.packetArtifactRefs!.system.path).toBe(
      "jobs/plan/attempts/1/steps/draft/prompt-packet/system.md",
    );
    expect(result.packetArtifactRefs!.manifest.path).toBe(
      "jobs/plan/attempts/1/steps/draft/prompt-packet/packet.json",
    );

    const packetDir = join(
      runDir,
      "jobs",
      "plan",
      "attempts",
      "1",
      "steps",
      "draft",
      "prompt-packet",
    );
    const systemBlock = await readFile(join(packetDir, "system.md"), "utf-8");
    const stepBlock = await readFile(join(packetDir, "step.md"), "utf-8");
    const outputBlock = await readFile(join(packetDir, "output.md"), "utf-8");
    const manifest = JSON.parse(await readFile(join(packetDir, "packet.json"), "utf-8")) as {
      schema_version: string;
      backend_composition: { composition_order: string[]; system_prompt_block: string; user_prompt_blocks: string[] };
      blocks: Array<{ id: string; path: string; artifact_ref: string }>;
    };

    expect(systemBlock).toContain("You are a Zigma Flow Agent Step executor.");
    expect(stepBlock).toContain("# Primary Plan Prompt");
    expect(outputBlock).toContain("### Report Schema");
    expect(manifest.schema_version).toBe("prompt-packet-artifacts.v1");
    expect(manifest.backend_composition).toMatchObject({
      composition_order: ["system", "task", "step", "context", "output"],
      system_prompt_block: "system",
      user_prompt_blocks: ["task", "step", "context", "output"],
    });
    expect(manifest.blocks.map((block) => block.id)).toEqual([
      "system",
      "task",
      "step",
      "context",
      "output",
    ]);
    expect(manifest.blocks.map((block) => block.path)).toEqual([
      "jobs/plan/attempts/1/steps/draft/prompt-packet/system.md",
      "jobs/plan/attempts/1/steps/draft/prompt-packet/task.md",
      "jobs/plan/attempts/1/steps/draft/prompt-packet/step.md",
      "jobs/plan/attempts/1/steps/draft/prompt-packet/context.md",
      "jobs/plan/attempts/1/steps/draft/prompt-packet/output.md",
    ]);

    const indexText = await readFile(join(runDir, "artifacts.jsonl"), "utf-8");
    const indexEntries = indexText
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { kind: string; path: string });
    expect(indexEntries.map((entry) => entry.kind)).toEqual([
      "prompt",
      "prompt_packet_system",
      "prompt_packet_task",
      "prompt_packet_step",
      "prompt_packet_context",
      "prompt_packet_output",
      "prompt_packet_manifest",
    ]);
  });
});

// ---------------------------------------------------------------------------
// readActiveRun / writeActiveRun — FP-ACTIVE-RUN
// ---------------------------------------------------------------------------

describe("readActiveRun / writeActiveRun", () => {
  let sandbox: Sandbox;

  afterEach(async () => {
    if (sandbox) {
      await rm(sandbox.projectRoot, { recursive: true, force: true });
    }
  });

  it("readActiveRun returns null when config.json is missing (T-ACTIVE-1, UC-ACTIVE-1)", async () => {
    const projectRoot = join(tmpdir(), `zigma-active-${randomUUID()}`);
    await mkdir(join(projectRoot, ".zigma-flow"), { recursive: true });
    sandbox = {
      projectRoot,
      zigmaflowDir: projectRoot,
      dotZigma: join(projectRoot, ".zigma-flow"),
      configPath: join(projectRoot, ".zigma-flow", "config.json"),
      runsDir: join(projectRoot, ".zigma-flow", "runs"),
      skillLockPath: join(projectRoot, ".zigma-flow", "skill-lock.json"),
    };

    const result = await readActiveRun(sandbox.zigmaflowDir);
    expect(result).toBeNull();
  });

  it("readActiveRun returns null when active_run is JSON null (T-ACTIVE-2, UC-ACTIVE-2)", async () => {
    sandbox = await makeSandbox({ activeRun: null });
    const result = await readActiveRun(sandbox.zigmaflowDir);
    expect(result).toBeNull();
  });

  it("writeActiveRun round-trips through readActiveRun and preserves tool_version (T-ACTIVE-3, UC-ACTIVE-3)", async () => {
    sandbox = await makeSandbox({ activeRun: null });

    await writeActiveRun(sandbox.zigmaflowDir, FIXED_RUN_ID);

    const got = await readActiveRun(sandbox.zigmaflowDir);
    expect(got).toBe(FIXED_RUN_ID);

    // tool_version field is preserved.
    const raw = JSON.parse(await readFile(sandbox.configPath, "utf-8")) as {
      tool_version: string;
      active_run: string | null;
    };
    expect(raw.tool_version).toBe("0.1.0");
    expect(raw.active_run).toBe(FIXED_RUN_ID);
  });

  it("writeActiveRun throws ConfigError when config.json is absent (T-ACTIVE-4, UC-ACTIVE-4)", async () => {
    const projectRoot = join(tmpdir(), `zigma-active-missing-${randomUUID()}`);
    await mkdir(join(projectRoot, ".zigma-flow"), { recursive: true });
    sandbox = {
      projectRoot,
      zigmaflowDir: projectRoot,
      dotZigma: join(projectRoot, ".zigma-flow"),
      configPath: join(projectRoot, ".zigma-flow", "config.json"),
      runsDir: join(projectRoot, ".zigma-flow", "runs"),
      skillLockPath: join(projectRoot, ".zigma-flow", "skill-lock.json"),
    };

    await expect(writeActiveRun(sandbox.zigmaflowDir, FIXED_RUN_ID)).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// createRun — FP-ACTIVE-RUN-INTEG
// ---------------------------------------------------------------------------

describe("createRun extension — active_run pointer", () => {
  let sandbox: Sandbox;
  let workflowPath: string;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
    workflowPath = join(sandbox.projectRoot, "code-change.yml");
    await writeFile(workflowPath, SINGLE_AGENT_WORKFLOW_YAML, "utf-8");
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("createRun sets active_run in .zigma-flow/config.json to the new runId (T-CREATE-1, UC-CREATE-ACTIVE-1)", async () => {
    const { runId } = await createRun({
      workflowPath,
      task: "fix the bug",
      runsDir: sandbox.runsDir,
      skillLockPath: sandbox.skillLockPath,
      clock: new FakeClock(),
    });

    const got = await readActiveRun(sandbox.zigmaflowDir);
    expect(got).toBe(runId);
  });
});

// ---------------------------------------------------------------------------
// promptAction — FP-PROMPT-SELECT / FP-PROMPT-AGENT / FP-PROMPT-EVENT /
// FP-PROMPT-TRANSITION / FP-PROMPT-ERRORS
// ---------------------------------------------------------------------------

describe("promptAction pipeline", () => {
  let sandbox: Sandbox;

  afterEach(async () => {
    if (sandbox) {
      await rm(sandbox.projectRoot, { recursive: true, force: true });
    }
  });

  it("uses the supplied --job argument (T-SELECT-1, UC-SELECT-1)", async () => {
    sandbox = await makeSandbox({ activeRun: FIXED_RUN_ID });
    await seedRun({
      sandbox,
      runId: FIXED_RUN_ID,
      workflowYaml: SINGLE_AGENT_WORKFLOW_YAML,
      state: makeRunState(),
      events: SEED_EVENTS,
    });

    await expect(
      promptAction({ job: "plan", zigmaflowDir: sandbox.zigmaflowDir, clock: new FakeClock() }),
    ).resolves.toBeUndefined();

    const mirror = await readFile(join(sandbox.runsDir, FIXED_RUN_ID, "current-step.md"), "utf-8");
    expect(mirror.length).toBeGreaterThan(0);
  });

  it("auto-detects the only ready job when --job is omitted (T-SELECT-2, UC-SELECT-2)", async () => {
    sandbox = await makeSandbox({ activeRun: FIXED_RUN_ID });
    await seedRun({
      sandbox,
      runId: FIXED_RUN_ID,
      workflowYaml: SINGLE_AGENT_WORKFLOW_YAML,
      state: makeRunState(),
      events: SEED_EVENTS,
    });

    await expect(
      promptAction({ zigmaflowDir: sandbox.zigmaflowDir, clock: new FakeClock() }),
    ).resolves.toBeUndefined();

    const mirror = await readFile(join(sandbox.runsDir, FIXED_RUN_ID, "current-step.md"), "utf-8");
    expect(mirror.length).toBeGreaterThan(0);
  });

  it("throws UserInputError when multiple ready jobs exist and --job is omitted (T-SELECT-3, UC-SELECT-3)", async () => {
    sandbox = await makeSandbox({ activeRun: FIXED_RUN_ID });
    await seedRun({
      sandbox,
      runId: FIXED_RUN_ID,
      workflowYaml: TWO_READY_WORKFLOW_YAML,
      state: makeRunState({
        jobs: {
          plan: { status: "ready" },
          review: { status: "ready" },
        },
      }),
      events: SEED_EVENTS,
    });

    await expect(
      promptAction({ zigmaflowDir: sandbox.zigmaflowDir, clock: new FakeClock() }),
    ).rejects.toBeInstanceOf(UserInputError);
  });

  it("throws UserInputError when no ready job exists (T-SELECT-4, UC-SELECT-4)", async () => {
    sandbox = await makeSandbox({ activeRun: FIXED_RUN_ID });
    await seedRun({
      sandbox,
      runId: FIXED_RUN_ID,
      workflowYaml: SINGLE_AGENT_WORKFLOW_YAML,
      state: makeRunState({
        jobs: {
          plan: { status: "waiting" },
        },
      }),
      events: SEED_EVENTS,
    });

    await expect(
      promptAction({ zigmaflowDir: sandbox.zigmaflowDir, clock: new FakeClock() }),
    ).rejects.toBeInstanceOf(UserInputError);
  });

  it("throws UserInputError when --job names an unknown job (T-SELECT-5, UC-SELECT-5)", async () => {
    sandbox = await makeSandbox({ activeRun: FIXED_RUN_ID });
    await seedRun({
      sandbox,
      runId: FIXED_RUN_ID,
      workflowYaml: SINGLE_AGENT_WORKFLOW_YAML,
      state: makeRunState(),
      events: SEED_EVENTS,
    });

    await expect(
      promptAction({ job: "does-not-exist", zigmaflowDir: sandbox.zigmaflowDir, clock: new FakeClock() }),
    ).rejects.toBeInstanceOf(UserInputError);
  });

  it("throws WorkflowError when current step is a script step (T-AGENT-1, UC-AGENT-1)", async () => {
    sandbox = await makeSandbox({ activeRun: FIXED_RUN_ID });
    await seedRun({
      sandbox,
      runId: FIXED_RUN_ID,
      workflowYaml: SCRIPT_STEP_WORKFLOW_YAML,
      state: makeRunState({
        workflow: "code-change",
        jobs: {
          build: { status: "ready" },
        },
      }),
      events: SEED_EVENTS,
    });

    await expect(
      promptAction({ job: "build", zigmaflowDir: sandbox.zigmaflowDir, clock: new FakeClock() }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it("appends a prompt_generated event whose id strictly succeeds the previous last_event_id (T-EVENT-1, UC-EVENT-1)", async () => {
    sandbox = await makeSandbox({ activeRun: FIXED_RUN_ID });
    const { runDir } = await seedRun({
      sandbox,
      runId: FIXED_RUN_ID,
      workflowYaml: SINGLE_AGENT_WORKFLOW_YAML,
      state: makeRunState({ last_event_id: "evt-002" }),
      events: SEED_EVENTS,
    });

    await promptAction({
      job: "plan",
      zigmaflowDir: sandbox.zigmaflowDir,
      clock: new FakeClock(),
    });

    const eventsText = await readFile(join(runDir, "events.jsonl"), "utf-8");
    const lines = eventsText.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(SEED_EVENTS.length + 1);

    const last = JSON.parse(lines[lines.length - 1]!) as {
      id: string;
      type: string;
      payload: {
        job_id: string;
        step_id: string;
        prompt_artifact: string;
        prompt_packet_artifacts: {
          system: string;
          task: string;
          step: string;
          context: string;
          output: string;
          manifest: string;
        };
      };
    };
    expect(last.type).toBe("prompt_generated");
    expect(last.id).toBe("evt-003");
    expect(last.payload.job_id).toBe("plan");
    expect(last.payload.step_id).toBe("draft");
    expect(last.payload.prompt_artifact).toMatch(/^artifact:\/\//);
    expect(last.payload.prompt_packet_artifacts).toMatchObject({
      system: expect.stringMatching(/\/prompt-packet\/system$/),
      task: expect.stringMatching(/\/prompt-packet\/task$/),
      step: expect.stringMatching(/\/prompt-packet\/step$/),
      context: expect.stringMatching(/\/prompt-packet\/context$/),
      output: expect.stringMatching(/\/prompt-packet\/output$/),
      manifest: expect.stringMatching(/\/prompt-packet\/packet$/),
    });
  });

  it("transitions job status from ready to running and advances last_event_id (T-TRANSITION-1, UC-TRANSITION-1)", async () => {
    sandbox = await makeSandbox({ activeRun: FIXED_RUN_ID });
    const { runDir } = await seedRun({
      sandbox,
      runId: FIXED_RUN_ID,
      workflowYaml: SINGLE_AGENT_WORKFLOW_YAML,
      state: makeRunState({ last_event_id: "evt-002" }),
      events: SEED_EVENTS,
    });

    await promptAction({
      job: "plan",
      zigmaflowDir: sandbox.zigmaflowDir,
      clock: new FakeClock(),
    });

    const store = new LocalStateStore();
    const snap = await store.readSnapshot(runDir);
    expect(snap).not.toBeNull();
    expect(snap!.jobs.plan!.status).toBe("running");
    expect(snap!.last_event_id).toBe("evt-003");
  });

  it("does not mutate state.json when buildContext fails (T-TRANSITION-2, UC-TRANSITION-2)", async () => {
    sandbox = await makeSandbox({ activeRun: FIXED_RUN_ID });
    const { runDir, workflowPath } = await seedRun({
      sandbox,
      runId: FIXED_RUN_ID,
      workflowYaml: SINGLE_AGENT_WORKFLOW_YAML,
      state: makeRunState({ last_event_id: "evt-002" }),
      events: SEED_EVENTS,
    });

    // Force a downstream failure by removing the workflow file referenced
    // from run.yml. promptAction must surface an error and leave state.json
    // byte-for-byte unchanged.
    await rm(workflowPath);

    const before = await readFile(join(runDir, "state.json"), "utf-8");

    await expect(
      promptAction({ job: "plan", zigmaflowDir: sandbox.zigmaflowDir, clock: new FakeClock() }),
    ).rejects.toBeDefined();

    const after = await readFile(join(runDir, "state.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("throws ConfigError when active_run is null (UC-ERR-2 — covered separately by CLI integration as T-CLI-3 too)", async () => {
    sandbox = await makeSandbox({ activeRun: null });

    await expect(
      promptAction({ zigmaflowDir: sandbox.zigmaflowDir, clock: new FakeClock() }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("throws StateError when state.json is missing in the active run dir", async () => {
    sandbox = await makeSandbox({ activeRun: FIXED_RUN_ID });
    // Create the run dir but DO NOT seed state.json.
    await mkdir(join(sandbox.runsDir, FIXED_RUN_ID), { recursive: true });

    await expect(
      promptAction({ zigmaflowDir: sandbox.zigmaflowDir, clock: new FakeClock() }),
    ).rejects.toBeInstanceOf(StateError);
  });
});

// ---------------------------------------------------------------------------
// Side-effect sanity: writePromptArtifact does not perturb unrelated files.
// (Light coverage; deep purity is asserted in WF-P5-CONTEXT for buildContext.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// buildContextBlocks — upstream-output blocks (FP-PROMPT-UPSTREAM)
// ---------------------------------------------------------------------------

describe("buildContextBlocks — upstream-output blocks", () => {
  it("creates upstream-output context block for each completed upstream job with outputs (T-PROMPT-UPSTREAM-1)", () => {
    const bundle = makeContextBundle({
      upstreamOutputs: {
        intake: { summary: "intake complete", risks: ["dep-a", "dep-b"] },
      },
    });

    const packet = buildPromptPacket(bundle);
    const upstreamBlocks = packet.context.filter((b) => b.type === "upstream-output");

    expect(upstreamBlocks).toHaveLength(1);
    const block = upstreamBlocks[0]!;
    expect(block.id).toBe("upstream-output-intake");
    expect(block.type).toBe("upstream-output");
    expect(block.source).toBe("job.intake.outputs");
    expect(block.priority).toBe(72);
    expect(block.freshness).toBe("prior");
    expect(block.summary).toContain("intake");
    expect(block.summary).toContain("summary: intake complete");
  });

  it("creates one upstream-output block per upstream job (T-PROMPT-UPSTREAM-2)", () => {
    const bundle = makeContextBundle({
      upstreamOutputs: {
        intake: { summary: "done" },
        review: { decision: "approved" },
      },
    });

    const packet = buildPromptPacket(bundle);
    const upstreamBlocks = packet.context.filter((b) => b.type === "upstream-output");

    expect(upstreamBlocks).toHaveLength(2);
    const ids = upstreamBlocks.map((b) => b.id);
    expect(ids).toContain("upstream-output-intake");
    expect(ids).toContain("upstream-output-review");
  });

  it("produces no upstream-output blocks when upstreamOutputs is absent (T-PROMPT-UPSTREAM-3)", () => {
    const bundle = makeContextBundle(); // no upstreamOutputs
    const packet = buildPromptPacket(bundle);
    const upstreamBlocks = packet.context.filter((b) => b.type === "upstream-output");
    expect(upstreamBlocks).toHaveLength(0);
  });

  it("formats array output values with square brackets in summary (T-PROMPT-UPSTREAM-4)", () => {
    const bundle = makeContextBundle({
      upstreamOutputs: {
        intake: { risks: ["dep-a", "dep-b", "dep-c"] },
      },
    });

    const packet = buildPromptPacket(bundle);
    const block = packet.context.find((b) => b.id === "upstream-output-intake")!;
    expect(block.summary).toContain("risks: [dep-a, dep-b, dep-c]");
  });

  it("truncates long string output values to 120 chars (T-PROMPT-UPSTREAM-5)", () => {
    const longValue = "x".repeat(200);
    const bundle = makeContextBundle({
      upstreamOutputs: {
        intake: { description: longValue },
      },
    });

    const packet = buildPromptPacket(bundle);
    const block = packet.context.find((b) => b.id === "upstream-output-intake")!;
    // The truncated value is 117 chars + "..."
    expect(block.summary).toContain("...");
    // description key plus value truncation
    expect(block.summary.length).toBeLessThan(200);
  });

  it("upstream-output blocks are sorted at priority 72 (below workspace-scan 80, above knowledge 70) (T-PROMPT-UPSTREAM-6)", () => {
    const bundle = makeContextBundle({
      upstreamOutputs: {
        intake: { summary: "done" },
      },
      capabilities: {
        skills: [],
        knowledge: [
          {
            skill: "code",
            id: "rules",
            path: "knowledge/rules.md",
            readPolicy: "required",
            usage: "read before starting",
          },
        ],
        prompts: [],
        functions: [],
        tools: [],
      },
    });

    const packet = buildPromptPacket(bundle);
    const workspaceBlock = packet.context.find((b) => b.type === "workspace-scan");
    const upstreamBlock = packet.context.find((b) => b.type === "upstream-output");
    const knowledgeBlock = packet.context.find((b) => b.type === "knowledge-summary");

    expect(workspaceBlock).toBeDefined();
    expect(upstreamBlock).toBeDefined();
    expect(knowledgeBlock).toBeDefined();

    // workspace-scan (80) > upstream-output (72) > knowledge-required (70)
    expect(workspaceBlock!.priority).toBeGreaterThan(upstreamBlock!.priority);
    expect(upstreamBlock!.priority).toBeGreaterThan(knowledgeBlock!.priority);
  });
});

// ---------------------------------------------------------------------------
// Side-effect sanity: writePromptArtifact does not perturb unrelated files.
// (Light coverage; deep purity is asserted in WF-P5-CONTEXT for buildContext.)
// ---------------------------------------------------------------------------

describe("writePromptArtifact side-effects", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = join(tmpdir(), `zigma-prompt-side-${randomUUID()}`);
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("does not touch events.jsonl or state.json when called directly", async () => {
    const eventsBefore = "evt-line\n";
    const stateBefore = JSON.stringify({ run_id: FIXED_RUN_ID });
    await writeFile(join(runDir, "events.jsonl"), eventsBefore, "utf-8");
    await writeFile(join(runDir, "state.json"), stateBefore, "utf-8");

    const eventsStat = await stat(join(runDir, "events.jsonl"));
    const stateStat = await stat(join(runDir, "state.json"));

    await writePromptArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      jobId: "plan",
      stepId: "draft",
      attempt: 1,
      prompt: "# Body",
      clock: new FakeClock(),
    });

    const eventsAfterText = await readFile(join(runDir, "events.jsonl"), "utf-8");
    const stateAfterText = await readFile(join(runDir, "state.json"), "utf-8");
    expect(eventsAfterText).toBe(eventsBefore);
    expect(stateAfterText).toBe(stateBefore);

    const eventsStat2 = await stat(join(runDir, "events.jsonl"));
    const stateStat2 = await stat(join(runDir, "state.json"));
    expect(eventsStat2.size).toBe(eventsStat.size);
    expect(stateStat2.size).toBe(stateStat.size);
  });
});

// ---------------------------------------------------------------------------
// Template loading and rendering — FP-PROMPT-TEMPLATES
// ---------------------------------------------------------------------------

describe("Template loading and rendering", () => {
  it("renders system prompt with the identity and invariants from the template (T-TEMPLATE-1)", () => {
    const out = buildAgentPrompt(makeContextBundle());

    // Template markers are NOT present in the rendered output.
    expect(out).not.toContain("{{identity}}");
    expect(out).not.toContain("{{invariantsLines}}");
    expect(out).not.toContain("{{boundariesLines}}");

    // Template content IS present.
    expect(out).toContain("You are a Zigma Flow Agent Step executor.");
    expect(out).toContain("Global invariants:");
    expect(out).toContain("Capability and permission boundaries:");
  });

  it("renders reproducible output with bundled template (T-TEMPLATE-2)", () => {
    const bundle = makeContextBundle({ runTask: "deterministic template test" });
    const out1 = buildAgentPrompt(bundle);
    const out2 = buildAgentPrompt(bundle);

    expect(out2).toBe(out1);
    expect(out1).toContain("deterministic template test");
  });

  it("task prompt template uses placeholder interpolation (T-TEMPLATE-3)", () => {
    const out = buildAgentPrompt(makeContextBundle({ runTask: "custom run task" }));

    expect(out).toContain("Overall run task:");
    expect(out).toContain("custom run task");
    expect(out).toContain("This task prompt is stable for the run.");
  });

  it("step prompt template with primary prompt renders markdown content (T-TEMPLATE-4)", () => {
    const out = buildAgentPrompt(
      makeContextBundle({ jobId: "implement", stepId: "implement" }),
    );

    expect(out).toContain('job "implement"');
    expect(out).toContain('step "implement"');
    expect(out).toContain("### Primary Plan Prompt");
    expect(out).not.toContain("{{promptContent}}");
  });

  it("output contract templates render report schema with quoted JSON keys (T-TEMPLATE-5)", () => {
    const out = buildAgentPrompt(makeContextBundle());

    expect(out).toContain("### Report Schema");
    expect(out).toContain('"outputs"');
    expect(out).toContain('"artifacts"');
    expect(out).toContain('"signals"');
    expect(out).toContain('"summary"');
    expect(out).toContain("Complete the current step, write report.json, then stop. 完成当前 step 后停止.");
    expect(out).not.toContain("{{stopRequirement}}");
  });

  it("permission boundary template renders conditional lines correctly (T-TEMPLATE-6)", () => {
    const readOnly = buildAgentPrompt(
      makeContextBundle({
        permissions: { contents: "read", edits: "none", workflow_state: "none", commands: "none" },
        repositoryWorkspace: { mode: "read-only" },
      }),
    );
    expect(readOnly).toContain("This job operates in read-only mode.");
    expect(readOnly).not.toContain("{{modePermissionLine}}");
    expect(readOnly).not.toContain("{{contentReadLine}}");
    expect(readOnly).not.toContain("{{commandsLine}}");
  });
});

// ---------------------------------------------------------------------------
// Required artifacts — output contract rendering
// ---------------------------------------------------------------------------

describe("Output contract — required artifacts rendering", () => {
  it("renders Required Artifacts section with list when bundle declares required_artifacts", () => {
    const bundle = makeContextBundle({
      required_artifacts: ["summary.md", "diff.patch"],
    });
    const out = buildAgentPrompt(bundle);

    expect(out).toContain("### Required Artifacts");
    expect(out).toContain("`summary.md`");
    expect(out).toContain("`diff.patch`");
    // Confirm the Required Artifacts section contains the listed artifacts
    // (and not just "(none declared)").
    expect(out).toContain("summary.md");
    expect(out).toContain("diff.patch");
  });

  it("shows (none declared) when bundle has no required_artifacts", () => {
    const bundle = makeContextBundle(); // no required_artifacts
    const out = buildAgentPrompt(bundle);

    expect(out).toContain("### Required Artifacts");
    // The section content is "(none declared)" — verify the heading is
    // followed by that text. Use whitespace-flexible regex to handle
    // both \n and \r\n line endings.
    expect(out).toMatch(/### Required Artifacts\s*\(none declared\)/);
  });

  it("renders required artifacts in the compact output-contract block content (T-TEMPLATE-7)", () => {
    const bundle = makeContextBundle({
      required_artifacts: ["summary.md"],
    });
    const packet = buildPromptPacket(bundle);

    // The compact output-contract.md template renders as the block content.
    expect(packet.output.block.content).toContain("Required artifacts: summary.md");
    expect(packet.output.block.content).not.toContain("{{requiredArtifacts}}");
  });

  it("shows (none declared) in compact output-contract when no required artifacts (T-TEMPLATE-8)", () => {
    const bundle = makeContextBundle(); // no required_artifacts
    const packet = buildPromptPacket(bundle);

    expect(packet.output.block.content).toContain("Required artifacts: (none declared)");
    expect(packet.output.block.content).not.toContain("{{requiredArtifacts}}");
  });
});

// Golden prompt snapshots — FP-PROMPT-SNAPSHOT (#72)
// ---------------------------------------------------------------------------
// These tests capture complete rendered prompts for representative step
// scenarios. Snapshot changes require intentional review — if you change
// a template or the renderer, run with --update to regenerate.
// Targeted unit checks for interpolation edge cases remain in the
// sections above.

describe("Golden prompt snapshots", () => {
  it("read-only plan step with primary prompt, knowledge, and signals (T-SNAPSHOT-1)", () => {
    const bundle = makeContextBundle({
      runId: "20260622-0001",
      jobId: "plan",
      stepId: "plan",
      attempt: 1,
      runTask: "Add golden snapshot tests for prompt template regression detection",
      primaryPrompt: {
        skill: "code",
        id: "plan",
        path: "prompts/plan.md",
        content: "# Plan Step\n\nCreate an implementation plan from the task description and upstream context.",
        source: "job.id",
      },
      capabilities: {
        skills: [{ alias: "code", skillId: "zigma.code-change", version: "1.0.0" }],
        knowledge: [
          { skill: "code", id: "coding-guidelines", path: "knowledge/coding-guidelines.md", description: "Project coding standards", readPolicy: "required", usage: "read before starting this step" },
          { skill: "code", id: "workflow-guide", path: "knowledge/workflow-guide.md", description: "Workflow structure reference", readPolicy: "required", usage: "report schema and workflow DAG reference" },
        ],
        prompts: [{ skill: "code", id: "plan", path: "prompts/plan.md" }],
        functions: [],
        tools: [],
      },
      signals: [{ id: "needs_architecture_design", description: "Request architecture design", allowed_from: ["plan"] }],
      permissions: { contents: "read", edits: "none", workflow_state: "none" },
      repositoryWorkspace: { mode: "read-only" },
      artifacts: [],
      inputs: { task: "Add golden snapshot tests" },
    });
    const prompt = buildAgentPrompt(bundle).replace(/\r\n/g, "\n");
    expect(prompt).toMatchSnapshot();
  });

  it("writable implement step with script artifacts (T-SNAPSHOT-2)", () => {
    const bundle = makeContextBundle({
      runId: "20260622-0001",
      jobId: "implement",
      stepId: "implement",
      attempt: 1,
      runTask: "Implement golden snapshot fixture tests",
      primaryPrompt: {
        skill: "code",
        id: "implement",
        path: "prompts/implement.md",
        content: "# Implement Step\n\nImplement the change according to the plan.",
        source: "step.id",
      },
      capabilities: {
        skills: [{ alias: "code", skillId: "zigma.code-change", version: "1.0.0" }],
        knowledge: [],
        prompts: [{ skill: "code", id: "implement", path: "prompts/implement.md" }],
        functions: [{ skill: "code", id: "implement-by-plan", description: "Implement code by plan", inputs: { plan: "string" }, outputs: { changed_files: "array" }, jobs: ["implement"] }],
        tools: [],
      },
      signals: [],
      permissions: { contents: "read", edits: "write", workflow_state: "none", commands: "none" },
      artifacts: [
        { id: "artifact://20260622-0001/jobs/implement/attempts/1/steps/collect-diff/stdout", kind: "script_stdout", path: "jobs/implement/attempts/1/steps/collect-diff/stdout.txt", summary: "git diff output", size: 2048, content_type: "text/plain" },
      ],
      upstreamOutputs: { plan: { plan_summary: "Add snapshot tests", steps: ["Create fixtures", "Add test cases", "Regenerate snapshots"] } },
      inputs: { task: "Add golden snapshot tests" },
    });
    const prompt = buildAgentPrompt(bundle).replace(/\r\n/g, "\n");
    expect(prompt).toMatchSnapshot();
  });

  it("review step with check and test artifacts (T-SNAPSHOT-3)", () => {
    const bundle = makeContextBundle({
      runId: "20260622-0001",
      jobId: "review",
      stepId: "review",
      attempt: 1,
      runTask: "Review golden snapshot implementation",
      primaryPrompt: {
        skill: "code",
        id: "review",
        path: "prompts/review.md",
        content: "# Review Step\n\nReview the implementation for correctness and quality.",
        source: "job.id",
      },
      capabilities: {
        skills: [{ alias: "code", skillId: "zigma.code-change", version: "1.0.0" }],
        knowledge: [{ skill: "code", id: "coding-guidelines", path: "knowledge/coding-guidelines.md", readPolicy: "required", usage: "read before starting this step" }],
        prompts: [{ skill: "code", id: "review", path: "prompts/review.md" }],
        functions: [],
        tools: [],
      },
      signals: [
        { id: "review_rejected", description: "Reject the changes", allowed_from: ["review"] },
        { id: "needs_architecture_design", description: "Request architecture design", allowed_from: ["review"] },
      ],
      permissions: { contents: "read", edits: "none", workflow_state: "none", commands: "none" },
      repositoryWorkspace: { mode: "read-only" },
      artifacts: [
        { id: "artifact://20260622-0001/jobs/static-check/attempts/1/steps/check/stdout", kind: "script_stdout", path: "jobs/static-check/attempts/1/steps/check/stdout.txt", summary: "Typecheck output", size: 512, content_type: "text/plain" },
        { id: "artifact://20260622-0001/jobs/unit-test/attempts/1/steps/test/stdout", kind: "script_stdout", path: "jobs/unit-test/attempts/1/steps/test/stdout.txt", summary: "Test run output: 423 tests passed", size: 4096, content_type: "text/plain" },
        { id: "artifact://20260622-0001/jobs/implement/attempts/1/steps/collect-diff/stdout", kind: "script_stdout", path: "jobs/implement/attempts/1/steps/collect-diff/stdout.txt", summary: "Git diff of changes", size: 2048, content_type: "text/plain" },
      ],
      upstreamOutputs: {
        "static-check": { exit_code: 0, stdout: "No type errors found" },
        "unit-test": { exit_code: 0, stdout: "35 files, 423 tests passed" },
        implement: { summary: "Added golden snapshot tests", files_changed: ["tests/prompt/prompt.test.ts"] },
      },
      inputs: { task: "Review golden snapshot changes" },
    });
    const prompt = buildAgentPrompt(bundle).replace(/\r\n/g, "\n");
    expect(prompt).toMatchSnapshot();
  });

  it("no-primary-prompt fallback step (T-SNAPSHOT-4)", () => {
    const bundle = makeContextBundle({
      runId: "20260622-0001",
      jobId: "unknown",
      stepId: "unknown",
      attempt: 1,
      runTask: "Generic task with no primary prompt",
      capabilities: { skills: [], knowledge: [], prompts: [], functions: [], tools: [] },
      signals: [],
      permissions: { contents: "read", edits: "none", workflow_state: "none" },
      repositoryWorkspace: { mode: "read-only" },
      artifacts: [],
      inputs: {},
    });
    delete (bundle as unknown as Record<string, unknown>)["primaryPrompt"];
    const prompt = buildAgentPrompt(bundle).replace(/\r\n/g, "\n");
    expect(prompt).toMatchSnapshot();
  });
});

