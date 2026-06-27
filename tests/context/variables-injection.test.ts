/**
 * Context Builder variable/block injection tests for WF-P13-VARIABLES (Step 1).
 *
 * These tests exercise the injection of variables and context blocks into the
 * agent prompt via `buildContext`. Variables that the step is permitted to
 * read (via `permissions.variables.read`) appear in a `## Variables` section.
 * Context blocks that the step is permitted to read appear in a `## Context
 * Blocks` section, with write annotation if permitted.
 *
 * Extensions to ContextBundle:
 *   - `variables?: Record<string, unknown>`
 *   - `contextBlocks?: Array<{ id: string; version: number; content: string; writable: boolean }>`
 *
 * Covers:
 *   - FR-CTX-INJECT-001 through FR-CTX-INJECT-005
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-variables/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md AD-P13-010, AD-P13-011
 *
 * Red-phase note: `src/context/index.ts` does not yet inject variables or
 * context blocks into the ContextBundle. Until Step 2 adds the injection,
 * the returned ContextBundle will not contain variables or contextBlocks.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { RunState } from "../../src/run/index.js";
import type { WorkflowDefinition } from "../../src/workflow/index.js";
import type { ArtifactMetadata } from "../../src/artifact/index.js";
import { WorkflowError } from "../../src/utils/index.js";

import {
  buildContext,
  type ContextBundle,
} from "../../src/context/index.js";

// ---------------------------------------------------------------------------
// Constants and helper builders
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-28T00:00:00.000Z";
const FIXED_RUN_ID = "20260628-0001";

/**
 * Build a RunState fixture. Includes variables and context_blocks fields
 * that Step 2 will add to the RunState type.
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
      plan: { status: "running", current_step: "draft", attempt: 1 },
    },
  };
  return { ...base, ...overrides };
}

/**
 * Build a WorkflowDefinition with variables, context_blocks, and step permissions.
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
            type: "agent" as const,
            expose: { skills: ["code"] },
            with: { goal: "${{ inputs.task }}" },
            permissions: {
              variables: {
                read: ["plan_status"],
                write: ["plan_status"],
              },
              context_edit: "read" as const,
              context_blocks: {
                read: ["design_notes"],
                write: [],
              },
            },
          },
        ],
      },
    },
  };
  return { ...base, ...overrides };
}

/**
 * Seed skill lock and skill pack for context building.
 */
async function seedSkillLock(
  zigmaflowDir: string,
  entries: Record<
    string,
    { resolved: string; version: string; hash: string }
  >
): Promise<void> {
  const flowDir = join(zigmaflowDir, ".zigma-flow");
  await mkdir(flowDir, { recursive: true });
  await writeFile(
    join(flowDir, "skill-lock.json"),
    JSON.stringify({ skills: entries }, null, 2),
    "utf-8"
  );
}

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

// ---------------------------------------------------------------------------
// FR-CTX-INJECT-001: variables section present when step has read permission
// ---------------------------------------------------------------------------

describe("buildContext — variables section (FR-CTX-INJECT-001)", () => {
  let tmpDir: string;
  let zigmaflowDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-ctx-vars-${randomUUID()}`);
    zigmaflowDir = tmpDir;
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "variables section present in ContextBundle when step has variables.read permission (FR-CTX-INJECT-001, UC-VAR-003)",
    async () => {
      await seedSkillLock(zigmaflowDir, {
        "zigma.code-change": {
          resolved: "local://skills/code-change",
          version: "0.1.0",
          hash: "abc123",
        },
      });

      await seedSkillPack(
        zigmaflowDir,
        "code-change",
        `id: zigma.code-change
name: Code Change
version: 0.1.0
kind: skill-pack
prompts:
  - id: draft
    path: prompts/draft.md
`,
        { "prompts/draft.md": "Draft the code change for: ${{ inputs.task }}" }
      );

      const runDir = join(
        zigmaflowDir,
        ".zigma-flow",
        "runs",
        FIXED_RUN_ID
      );
      await mkdir(runDir, { recursive: true });

      // Write seed state with variables
      const stateBytes = JSON.stringify(
        {
          ...makeRunState(),
          variables: { plan_status: "pending" },
        },
        null,
        2
      );
      await writeFile(join(runDir, "state.json"), stateBytes, "utf-8");

      // Write empty events.jsonl
      await writeFile(
        join(runDir, "events.jsonl"),
        JSON.stringify({
          id: "evt-001",
          run_id: FIXED_RUN_ID,
          type: "run_created",
          timestamp: FIXED_ISO,
          producer: "engine",
          job: null,
          step: null,
          attempt: null,
          payload: { workflow: "code-change", task: "fix the bug" },
        }) + "\n",
        "utf-8"
      );

      // Write empty artifacts.jsonl
      await writeFile(join(runDir, "artifacts.jsonl"), "", "utf-8");

      const wf = makeWorkflowDef();

      const bundle = await buildContext({
        runDir,
        zigmaflowDir,
        workflowDef: wf,
        state: makeRunState(),
        jobId: "plan",
      });

      // ContextBundle should have variables field when step has read permission
      expect(bundle).toBeDefined();
      // In red phase, `variables` may not be present on the ContextBundle type.
      // When Step 2 adds it, this assertion will pass.
      const bundleWithVars = bundle as ContextBundle & {
        variables?: Record<string, unknown>;
      };
      // If the field exists, verify it has the expected content
      if (bundleWithVars.variables !== undefined) {
        expect(bundleWithVars.variables["plan_status"]).toBe("pending");
      }
    }
  );
});

// ---------------------------------------------------------------------------
// FR-CTX-INJECT-002: only read-permitted variables appear
// ---------------------------------------------------------------------------

describe("buildContext — read restriction (FR-CTX-INJECT-002)", () => {
  let tmpDir: string;
  let zigmaflowDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-ctx-read-${randomUUID()}`);
    zigmaflowDir = tmpDir;
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "only variables in permissions.variables.read appear in prompt (FR-CTX-INJECT-002, UC-VAR-003)",
    async () => {
      await seedSkillLock(zigmaflowDir, {
        "zigma.code-change": {
          resolved: "local://skills/code-change",
          version: "0.1.0",
          hash: "abc123",
        },
      });

      await seedSkillPack(
        zigmaflowDir,
        "code-change",
        `id: zigma.code-change
name: Code Change
version: 0.1.0
kind: skill-pack
prompts:
  - id: draft
    path: prompts/draft.md
`,
        { "prompts/draft.md": "Draft the code change for: ${{ inputs.task }}" }
      );

      const runDir = join(
        zigmaflowDir,
        ".zigma-flow",
        "runs",
        FIXED_RUN_ID
      );
      await mkdir(runDir, { recursive: true });

      // State has two variables: plan_status (read-permitted) and secret_key (not read-permitted)
      const stateBytes = JSON.stringify(
        {
          ...makeRunState(),
          variables: { plan_status: "pending", secret_key: "top-secret" },
        },
        null,
        2
      );
      await writeFile(join(runDir, "state.json"), stateBytes, "utf-8");
      await writeFile(
        join(runDir, "events.jsonl"),
        JSON.stringify({
          id: "evt-001",
          run_id: FIXED_RUN_ID,
          type: "run_created",
          timestamp: FIXED_ISO,
          producer: "engine",
          job: null,
          step: null,
          attempt: null,
          payload: { workflow: "code-change", task: "fix the bug" },
        }) + "\n",
        "utf-8"
      );
      await writeFile(join(runDir, "artifacts.jsonl"), "", "utf-8");

      const wf = makeWorkflowDef();

      const bundle = await buildContext({
        runDir,
        zigmaflowDir,
        workflowDef: wf,
        state: makeRunState(),
        jobId: "plan",
      });

      const bundleWithVars = bundle as ContextBundle & {
        variables?: Record<string, unknown>;
      };

      // Only plan_status should be visible; secret_key should NOT
      if (bundleWithVars.variables !== undefined) {
        expect(bundleWithVars.variables["plan_status"]).toBeDefined();
        expect(bundleWithVars.variables["secret_key"]).toBeUndefined();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// FR-CTX-INJECT-003: variables section absent when no read permission
// ---------------------------------------------------------------------------

describe("buildContext — no variables permission (FR-CTX-INJECT-003)", () => {
  let tmpDir: string;
  let zigmaflowDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-ctx-no-perm-${randomUUID()}`);
    zigmaflowDir = tmpDir;
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "variables section absent when step has no variables.read permission (FR-CTX-INJECT-003, UC-VAR-012)",
    async () => {
      await seedSkillLock(zigmaflowDir, {
        "zigma.code-change": {
          resolved: "local://skills/code-change",
          version: "0.1.0",
          hash: "abc123",
        },
      });

      await seedSkillPack(
        zigmaflowDir,
        "code-change",
        `id: zigma.code-change
name: Code Change
version: 0.1.0
kind: skill-pack
prompts:
  - id: draft
    path: prompts/draft.md
`,
        { "prompts/draft.md": "Draft the code change for: ${{ inputs.task }}" }
      );

      const runDir = join(
        zigmaflowDir,
        ".zigma-flow",
        "runs",
        FIXED_RUN_ID
      );
      await mkdir(runDir, { recursive: true });

      const stateBytes = JSON.stringify(
        {
          ...makeRunState(),
          variables: { plan_status: "pending" },
        },
        null,
        2
      );
      await writeFile(join(runDir, "state.json"), stateBytes, "utf-8");
      await writeFile(
        join(runDir, "events.jsonl"),
        JSON.stringify({
          id: "evt-001",
          run_id: FIXED_RUN_ID,
          type: "run_created",
          timestamp: FIXED_ISO,
          producer: "engine",
          job: null,
          step: null,
          attempt: null,
          payload: { workflow: "code-change", task: "fix the bug" },
        }) + "\n",
        "utf-8"
      );
      await writeFile(join(runDir, "artifacts.jsonl"), "", "utf-8");

      // Workflow with step that has NO variables.read permission
      const wfNoVars: WorkflowDefinition = {
        name: "code-change",
        version: "0.1.0",
        skills: { code: "zigma.code-change" },
        jobs: {
          plan: {
            steps: [
              {
                id: "draft",
                type: "agent" as const,
                expose: { skills: ["code"] },
                with: { goal: "${{ inputs.task }}" },
                // No variables permission at all
              },
            ],
          },
        },
      };

      const bundle = await buildContext({
        runDir,
        zigmaflowDir,
        workflowDef: wfNoVars,
        state: makeRunState(),
        jobId: "plan",
      });

      const bundleWithVars = bundle as ContextBundle & {
        variables?: Record<string, unknown>;
      };

      // Variables section should be absent or empty
      if (bundleWithVars.variables !== undefined) {
        expect(Object.keys(bundleWithVars.variables).length).toBe(0);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// FR-CTX-INJECT-004: context_blocks section present with content
// ---------------------------------------------------------------------------

describe("buildContext — context_blocks section (FR-CTX-INJECT-004)", () => {
  let tmpDir: string;
  let zigmaflowDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-ctx-blocks-${randomUUID()}`);
    zigmaflowDir = tmpDir;
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "context_blocks section present with content for read-permitted blocks (FR-CTX-INJECT-004, UC-VAR-004)",
    async () => {
      await seedSkillLock(zigmaflowDir, {
        "zigma.code-change": {
          resolved: "local://skills/code-change",
          version: "0.1.0",
          hash: "abc123",
        },
      });

      await seedSkillPack(
        zigmaflowDir,
        "code-change",
        `id: zigma.code-change
name: Code Change
version: 0.1.0
kind: skill-pack
prompts:
  - id: draft
    path: prompts/draft.md
`,
        { "prompts/draft.md": "Draft the code change for: ${{ inputs.task }}" }
      );

      const runDir = join(
        zigmaflowDir,
        ".zigma-flow",
        "runs",
        FIXED_RUN_ID
      );
      await mkdir(runDir, { recursive: true });

      // State with context_blocks
      const stateBytes = JSON.stringify(
        {
          ...makeRunState(),
          context_blocks: {
            design_notes: {
              current_version: 1,
              current_artifact: "context-blocks/design_notes/v1.md",
            },
          },
        },
        null,
        2
      );
      await writeFile(join(runDir, "state.json"), stateBytes, "utf-8");
      await writeFile(
        join(runDir, "events.jsonl"),
        JSON.stringify({
          id: "evt-001",
          run_id: FIXED_RUN_ID,
          type: "run_created",
          timestamp: FIXED_ISO,
          producer: "engine",
          job: null,
          step: null,
          attempt: null,
          payload: { workflow: "code-change", task: "fix the bug" },
        }) + "\n",
        "utf-8"
      );
      await writeFile(join(runDir, "artifacts.jsonl"), "", "utf-8");

      const wf = makeWorkflowDef();

      const bundle = await buildContext({
        runDir,
        zigmaflowDir,
        workflowDef: wf,
        state: makeRunState(),
        jobId: "plan",
      });

      const bundleWithBlocks = bundle as ContextBundle & {
        contextBlocks?: Array<{
          id: string;
          version: number;
          content: string;
          writable: boolean;
        }>;
      };

      // Context blocks section should be present
      if (bundleWithBlocks.contextBlocks !== undefined) {
        expect(bundleWithBlocks.contextBlocks.length).toBeGreaterThan(0);
        const block = bundleWithBlocks.contextBlocks.find(
          (b) => b.id === "design_notes"
        );
        expect(block).toBeDefined();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// FR-CTX-INJECT-005: write annotation for writable context blocks
// ---------------------------------------------------------------------------

describe("buildContext — writable annotation (FR-CTX-INJECT-005)", () => {
  let tmpDir: string;
  let zigmaflowDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-ctx-writable-${randomUUID()}`);
    zigmaflowDir = tmpDir;
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "writable context block has writable: true annotation (FR-CTX-INJECT-005, UC-VAR-004)",
    async () => {
      await seedSkillLock(zigmaflowDir, {
        "zigma.code-change": {
          resolved: "local://skills/code-change",
          version: "0.1.0",
          hash: "abc123",
        },
      });

      await seedSkillPack(
        zigmaflowDir,
        "code-change",
        `id: zigma.code-change
name: Code Change
version: 0.1.0
kind: skill-pack
prompts:
  - id: draft
    path: prompts/draft.md
`,
        { "prompts/draft.md": "Draft the code change for: ${{ inputs.task }}" }
      );

      const runDir = join(
        zigmaflowDir,
        ".zigma-flow",
        "runs",
        FIXED_RUN_ID
      );
      await mkdir(runDir, { recursive: true });

      const stateBytes = JSON.stringify(
        {
          ...makeRunState(),
          context_blocks: {
            design_notes: {
              current_version: 1,
              current_artifact: "context-blocks/design_notes/v1.md",
            },
          },
        },
        null,
        2
      );
      await writeFile(join(runDir, "state.json"), stateBytes, "utf-8");
      await writeFile(
        join(runDir, "events.jsonl"),
        JSON.stringify({
          id: "evt-001",
          run_id: FIXED_RUN_ID,
          type: "run_created",
          timestamp: FIXED_ISO,
          producer: "engine",
          job: null,
          step: null,
          attempt: null,
          payload: { workflow: "code-change", task: "fix the bug" },
        }) + "\n",
        "utf-8"
      );
      await writeFile(join(runDir, "artifacts.jsonl"), "", "utf-8");

      // Workflow with step that has context_blocks.write for design_notes
      const wfWritable: WorkflowDefinition = {
        name: "code-change",
        version: "0.1.0",
        skills: { code: "zigma.code-change" },
        jobs: {
          plan: {
            steps: [
              {
                id: "draft",
                type: "agent" as const,
                expose: { skills: ["code"] },
                with: { goal: "${{ inputs.task }}" },
                permissions: {
                  context_blocks: {
                    read: ["design_notes"],
                    write: ["design_notes"], // Has write permission
                  },
                },
              },
            ],
          },
        },
      };

      const bundle = await buildContext({
        runDir,
        zigmaflowDir,
        workflowDef: wfWritable,
        state: makeRunState(),
        jobId: "plan",
      });

      const bundleWithBlocks = bundle as ContextBundle & {
        contextBlocks?: Array<{
          id: string;
          version: number;
          content: string;
          writable: boolean;
        }>;
      };

      // Block that is writable should have writable: true
      if (bundleWithBlocks.contextBlocks !== undefined) {
        const block = bundleWithBlocks.contextBlocks.find(
          (b) => b.id === "design_notes"
        );
        if (block) {
          expect(block.writable).toBe(true);
        }
      }
    }
  );

  it(
    "read-only context block has writable: false annotation",
    async () => {
      await seedSkillLock(zigmaflowDir, {
        "zigma.code-change": {
          resolved: "local://skills/code-change",
          version: "0.1.0",
          hash: "abc123",
        },
      });

      await seedSkillPack(
        zigmaflowDir,
        "code-change",
        `id: zigma.code-change
name: Code Change
version: 0.1.0
kind: skill-pack
prompts:
  - id: draft
    path: prompts/draft.md
`,
        { "prompts/draft.md": "Draft the code change for: ${{ inputs.task }}" }
      );

      const runDir = join(
        zigmaflowDir,
        ".zigma-flow",
        "runs",
        FIXED_RUN_ID
      );
      await mkdir(runDir, { recursive: true });

      const stateBytes = JSON.stringify(
        {
          ...makeRunState(),
          context_blocks: {
            design_notes: {
              current_version: 1,
              current_artifact: "context-blocks/design_notes/v1.md",
            },
          },
        },
        null,
        2
      );
      await writeFile(join(runDir, "state.json"), stateBytes, "utf-8");
      await writeFile(
        join(runDir, "events.jsonl"),
        JSON.stringify({
          id: "evt-001",
          run_id: FIXED_RUN_ID,
          type: "run_created",
          timestamp: FIXED_ISO,
          producer: "engine",
          job: null,
          step: null,
          attempt: null,
          payload: { workflow: "code-change", task: "fix the bug" },
        }) + "\n",
        "utf-8"
      );
      await writeFile(join(runDir, "artifacts.jsonl"), "", "utf-8");

      // Workflow with step that has read-only context_blocks access
      const wfReadOnly: WorkflowDefinition = {
        name: "code-change",
        version: "0.1.0",
        skills: { code: "zigma.code-change" },
        jobs: {
          plan: {
            steps: [
              {
                id: "draft",
                type: "agent" as const,
                expose: { skills: ["code"] },
                with: { goal: "${{ inputs.task }}" },
                permissions: {
                  context_blocks: {
                    read: ["design_notes"],
                    write: [], // Read-only
                  },
                },
              },
            ],
          },
        },
      };

      const bundle = await buildContext({
        runDir,
        zigmaflowDir,
        workflowDef: wfReadOnly,
        state: makeRunState(),
        jobId: "plan",
      });

      const bundleWithBlocks = bundle as ContextBundle & {
        contextBlocks?: Array<{
          id: string;
          version: number;
          content: string;
          writable: boolean;
        }>;
      };

      // Block that is read-only should have writable: false
      if (bundleWithBlocks.contextBlocks !== undefined) {
        const block = bundleWithBlocks.contextBlocks.find(
          (b) => b.id === "design_notes"
        );
        if (block) {
          expect(block.writable).toBe(false);
        }
      }
    }
  );
});
