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
    stepType: "agent",
    capabilities: {
      skills: [
        { alias: "code", skillId: "zigma.code-change", version: "1.0.0" },
      ],
      knowledge: [
        { skill: "code", id: "rules", description: "Project rules" },
        { skill: "code", id: "layout", description: "Source layout" },
      ],
      prompts: [{ skill: "code", id: "implement" }],
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
// buildAgentPrompt — FP-PROMPT-RENDER / FP-PROMPT-CONFINE
// ---------------------------------------------------------------------------

describe("buildAgentPrompt — section rendering", () => {
  it("renders all six required sections in order (T-RENDER-1, UC-RENDER-1)", () => {
    const out = buildAgentPrompt(makeContextBundle());

    // Order of section headers: Responsibility → Inputs → Capabilities →
    // Signals → Permissions → Output. The H1 step header precedes them all.
    const headers = [
      out.indexOf("# "),                              // H1 step header
      out.search(/^##\s+(Responsibility|当前职责)/m),
      out.search(/^##\s+(Inputs|当前输入)/m),
      out.search(/^##\s+Exposed Capabilities/m),
      out.search(/^##\s+Available Workflow Signals/m),
      out.search(/^##\s+Permissions and Forbidden Actions/m),
      out.search(/^##\s+Output/m),
    ];
    for (const idx of headers) {
      expect(idx, `header missing in:\n${out}`).toBeGreaterThanOrEqual(0);
    }
    // Strictly increasing order.
    for (let i = 1; i < headers.length; i++) {
      expect(headers[i]!, `header at position ${i} out of order`).toBeGreaterThan(
        headers[i - 1]!,
      );
    }

    // Capabilities sub-section headers and id presence.
    expect(out).toMatch(/^###\s+Knowledge/m);
    expect(out).toMatch(/^###\s+Prompts/m);
    expect(out).toMatch(/^###\s+Functions/m);
    expect(out).toMatch(/^###\s+Tools/m);

    // Spot-check ids surface in the right buckets.
    expect(out).toContain("rules");
    expect(out).toContain("layout");
    expect(out).toContain("implement");
    expect(out).toContain("implement-by-plan");
    expect(out).toContain("grep");
    expect(out).toContain("needs_review");
    expect(out).toContain("goal");
    expect(out).toContain("fix the bug");
  });

  it("emits (none) markers for empty capabilities and signals (T-RENDER-2, UC-RENDER-2)", () => {
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

    // Section headers still present.
    expect(out).toMatch(/^###\s+Knowledge/m);
    expect(out).toMatch(/^###\s+Prompts/m);
    expect(out).toMatch(/^###\s+Functions/m);
    expect(out).toMatch(/^###\s+Tools/m);
    expect(out).toMatch(/^##\s+Available Workflow Signals/m);

    // Each empty bucket emits a (none) marker.
    // We expect at least 5 `(none)` occurrences: 4 capability buckets + 1
    // signals section. Inputs may add a sixth.
    const noneCount = (out.match(/\(none\)/g) ?? []).length;
    expect(noneCount).toBeGreaterThanOrEqual(5);
  });

  it("includes 完成当前 step 后停止 and a report.json reference (T-RENDER-3, UC-RENDER-3)", () => {
    const out = buildAgentPrompt(makeContextBundle());
    expect(out).toContain("完成当前 step 后停止");
    expect(out).toContain("report.json");
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

    expect(out).toMatch(/^###\s+Repository Workspace Permissions/m);
    expect(out).toContain(
      "This job operates in read-only mode. You must not modify files in the repository.",
    );
    expect(out).not.toContain("edits: write");
    expect(out).not.toContain("**edits**");
    expect(out).toMatch(/^###\s+Runtime Artifact Permissions/m);
    expect(out).toContain(
      "You must write `report.json` to the canonical path above. This is a runtime artifact, not a repository file modification.",
    );
    expect(out).toContain("step contract and is always allowed");
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
      payload: { job_id: string; step_id: string; prompt_artifact: string };
    };
    expect(last.type).toBe("prompt_generated");
    expect(last.id).toBe("evt-003");
    expect(last.payload.job_id).toBe("plan");
    expect(last.payload.step_id).toBe("draft");
    expect(last.payload.prompt_artifact).toMatch(/^artifact:\/\//);
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

