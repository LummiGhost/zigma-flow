/**
 * CLI integration tests for `zigma-flow prompt` (WF-P5-PROMPT Step 1 — Cases
 * and Tests).
 *
 * These tests exercise the command handler against real `.zigma-flow/`
 * directories under `os.tmpdir()`, covering the full end-to-end happy path
 * (`createRun` → `promptAction`) and the two main CLI error cases:
 *   - unknown --job argument → UserInputError (exit code 2)
 *   - missing active_run → ConfigError (exit code 4)
 *
 * Reference:
 *   - docs/phases/p5-context-prompt/workflows/wf-p5-prompt/01-cases-and-tests.md
 *   - docs/prd.md FR-006, §17
 *   - docs/architecture.md §12.2
 *   - docs/mvp-contracts.md §2.4, §7
 *
 * Red-phase notes:
 *   - `src/commands/prompt.ts` does not yet exist; tests fail with module
 *     resolution errors until Step 2 creates it.
 *   - `createRun` does not yet write `active_run`, so the happy-path test
 *     fails on the post-createRun assertion until Step 2 extends the engine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock } from "../../src/run/index.js";
import { promptAction } from "../../src/commands/prompt.js";
import { ConfigError, UserInputError } from "../../src/utils/index.js";

const FIXED_ISO = "2026-06-08T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Workflow YAML with a single Agent step in job "plan" — used for the
 * end-to-end happy-path test.
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

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  dotZigma: string;
  configPath: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(opts: { activeRun?: string | null } = {}): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-prompt-cli-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const configPath = join(dotZigma, "config.json");
  const skillLockPath = join(dotZigma, "skill-lock.json");

  await mkdir(runsDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(
      { tool_version: "0.1.0", active_run: opts.activeRun ?? null },
      null,
      2,
    ),
    "utf-8",
  );
  await writeFile(skillLockPath, JSON.stringify({ skills: {} }, null, 2), "utf-8");

  return {
    projectRoot,
    zigmaflowDir: projectRoot,
    dotZigma,
    configPath,
    runsDir,
    skillLockPath,
  };
}

// ---------------------------------------------------------------------------
// T-CLI-1: end-to-end happy path
// ---------------------------------------------------------------------------

describe("promptAction (CLI integration) — happy path", () => {
  let sandbox: Sandbox;
  let workflowPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
    workflowPath = join(sandbox.projectRoot, "code-change.yml");
    await writeFile(workflowPath, SINGLE_AGENT_WORKFLOW_YAML, "utf-8");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("writes current-step.md and a prompt_generated event after createRun (T-CLI-1, UC-ERR-3, UC-CREATE-ACTIVE-1)", async () => {
    // 1. createRun must populate active_run in config.json.
    const { runId } = await createRun({
      workflowPath,
      task: "fix the bug",
      runsDir: sandbox.runsDir,
      skillLockPath: sandbox.skillLockPath,
      clock: new FakeClock(),
    });

    const cfgAfterCreate = JSON.parse(
      await readFile(sandbox.configPath, "utf-8"),
    ) as { active_run: string | null };
    expect(cfgAfterCreate.active_run).toBe(runId);

    // 2. promptAction without --job auto-detects the single ready job.
    await promptAction({
      zigmaflowDir: sandbox.zigmaflowDir,
      clock: new FakeClock(),
    });

    // 3. current-step.md exists in the run dir.
    const runDir = join(sandbox.runsDir, runId);
    const mirror = await readFile(join(runDir, "current-step.md"), "utf-8");
    expect(mirror).toMatch(/^#/);
    expect(mirror).toContain("完成当前 step 后停止");

    // 4. events.jsonl now ends with a prompt_generated event.
    const eventsText = await readFile(join(runDir, "events.jsonl"), "utf-8");
    const lines = eventsText
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const last = JSON.parse(lines[lines.length - 1]!) as {
      type: string;
      payload: { job_id: string; step_id: string; prompt_artifact: string };
    };
    expect(last.type).toBe("prompt_generated");
    expect(last.payload.job_id).toBe("plan");
    expect(last.payload.step_id).toBe("draft");
    expect(last.payload.prompt_artifact).toMatch(/^artifact:\/\//);

    // 5. CLI should have printed the path to current-step.md.
    expect(logSpy).toHaveBeenCalled();
    const printed = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0] ?? ""))
      .join("\n");
    expect(printed).toContain("current-step.md");
  });
});

// ---------------------------------------------------------------------------
// T-CLI-2: unknown --job → UserInputError (exit 2)
// ---------------------------------------------------------------------------

describe("promptAction (CLI integration) — unknown --job", () => {
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

  it("throws UserInputError (exit code 2) for an unknown --job (T-CLI-2, UC-ERR-1)", async () => {
    await createRun({
      workflowPath,
      task: "fix the bug",
      runsDir: sandbox.runsDir,
      skillLockPath: sandbox.skillLockPath,
      clock: new FakeClock(),
    });

    await expect(
      promptAction({
        job: "does-not-exist",
        zigmaflowDir: sandbox.zigmaflowDir,
        clock: new FakeClock(),
      }),
    ).rejects.toMatchObject({
      kind: "UserInputError",
      exitCode: 2,
    });

    await expect(
      promptAction({
        job: "does-not-exist",
        zigmaflowDir: sandbox.zigmaflowDir,
        clock: new FakeClock(),
      }),
    ).rejects.toBeInstanceOf(UserInputError);
  });
});

// ---------------------------------------------------------------------------
// T-CLI-3: missing active_run → ConfigError (exit 4)
// ---------------------------------------------------------------------------

describe("promptAction (CLI integration) — missing active_run", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("throws ConfigError (exit code 4) when active_run is null (T-CLI-3, UC-ERR-2)", async () => {
    await expect(
      promptAction({
        zigmaflowDir: sandbox.zigmaflowDir,
        clock: new FakeClock(),
      }),
    ).rejects.toMatchObject({
      kind: "ConfigError",
      exitCode: 4,
    });

    await expect(
      promptAction({
        zigmaflowDir: sandbox.zigmaflowDir,
        clock: new FakeClock(),
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
