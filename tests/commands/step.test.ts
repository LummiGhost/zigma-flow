/**
 * CLI integration tests for `zigma-flow step` (WF-P6-DISPATCH Step 1 —
 * Cases and Tests).
 *
 * These tests exercise the step command handler against real
 * `.zigma-flow/` directories under `os.tmpdir()`. They cover the
 * dispatch boundary between the CLI and the Engine's
 * `executeCurrentStep` entry point.
 *
 * Reference:
 *   - docs/phases/p6-script-step/workflows/wf-p6-dispatch/01-cases-and-tests.md
 *   - docs/prd.md FR-007
 *   - docs/architecture.md §7.1, §7.2, §12.3
 *   - docs/mvp-contracts.md §6 (ProcessRunner port), §7 (error taxonomy)
 *
 * Red-phase notes:
 *   - `src/commands/step.ts` does not yet exist; tests fail with module
 *     resolution errors until WF-P6-DISPATCH Step 2 creates it.
 *   - `executeCurrentStep` is not yet exported from
 *     `src/engine/index.ts`; the happy-path test asserts the dispatch
 *     boundary only and tolerates either a Step 2 stub transition
 *     (`ready -> running`) or the full WF-P6-SCRIPT outcome
 *     (`ready -> running -> done`).
 *
 * Test ids (T-DISPATCH-1..5) align with the test plan in the cases
 * document above.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock } from "../../src/run/index.js";
import { stepAction } from "../../src/commands/step.js";
import {
  ConfigError,
  StateError,
  UserInputError,
  WorkflowError,
} from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-08T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Minimal ProcessRunner-shaped fake. The dispatch tests do not exercise
 * the runner; we only need a no-op stub that can be passed through
 * `stepAction` → `executeCurrentStep` without depending on `execa`.
 *
 * The shape mirrors WF-P6-RUNNER's planned `ProcessRunner` port. Using
 * `any` here keeps the test compilable even before
 * `src/script/index.ts` exports the real port.
 */
class FakeRunner {
  public calls: Array<Record<string, unknown>> = [];
  async run(opts: Record<string, unknown>): Promise<{
    exitCode: number;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    startedAt: string;
    endedAt: string;
  }> {
    this.calls.push(opts);
    return {
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      startedAt: FIXED_ISO,
      endedAt: FIXED_ISO,
    };
  }
}

/**
 * Workflow YAML with a single script step in job "build". Used for the
 * happy-path and most failure-path tests.
 */
const SCRIPT_WORKFLOW_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  build:
    steps:
      - id: compile
        type: script
        run: "echo hello"
`;

/**
 * Workflow YAML where the only ready job's current step is an agent
 * step. Used to verify the non-script-step guard.
 */
const AGENT_WORKFLOW_YAML = `\
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

async function makeSandbox(
  opts: { activeRun?: string | null } = {}
): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-step-cli-${randomUUID()}`);
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
      2
    ),
    "utf-8"
  );
  await writeFile(
    skillLockPath,
    JSON.stringify({ skills: {} }, null, 2),
    "utf-8"
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
 * Local stub type for `stepAction` opts. We declare it inline rather
 * than importing it from `src/commands/step.ts` because that module
 * does not exist yet in the red phase. The real `StepActionOpts`
 * exported by Step 2 MUST be structurally compatible with this shape
 * (see WF-P6-DISPATCH §Step 2 Handoff Notes).
 *
 * `exactOptionalPropertyTypes` requires conditional spreading rather
 * than assigning `undefined` to optional fields — `makeStepOpts`
 * enforces that.
 */
interface StepActionOptsLocal {
  zigmaflowDir: string;
  clock: Clock;
  job?: string;
  runner?: unknown;
  latest?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStepOpts(args: {
  zigmaflowDir: string;
  job?: string;
  clock?: Clock;
  runner?: unknown;
  latest?: boolean;
}): any {
  const clock: Clock = args.clock ?? new FakeClock();
  const base: StepActionOptsLocal = {
    zigmaflowDir: args.zigmaflowDir,
    clock,
  };
  const withJob: StepActionOptsLocal =
    args.job === undefined ? base : { ...base, job: args.job };
  const withRunner: StepActionOptsLocal =
    args.runner === undefined
      ? withJob
      : { ...withJob, runner: args.runner };
  const withLatest: StepActionOptsLocal =
    args.latest === undefined
      ? withRunner
      : { ...withRunner, latest: args.latest };
  return withLatest;
}

// ---------------------------------------------------------------------------
// T-DISPATCH-1: happy path — createRun → stepAction on a script step
// ---------------------------------------------------------------------------

describe("stepAction (CLI integration) — happy path", () => {
  let sandbox: Sandbox;
  let workflowPath: string;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
    workflowPath = join(sandbox.projectRoot, "code-change.yml");
    await writeFile(workflowPath, SCRIPT_WORKFLOW_YAML, "utf-8");
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "dispatches a script step on a freshly created run and transitions the job out of ready (T-DISPATCH-1, UC-DISPATCH-1)",
    async () => {
      // 1. createRun creates a run directory and places the script job in `ready`.
      // v0.6: active_run is deprecated — createRun no longer updates config.json.
      const { runId } = await createRun({
        workflowPath,
        task: "compile sources",
        runsDir: sandbox.runsDir,
        skillLockPath: sandbox.skillLockPath,
        clock: new FakeClock(),
      });

      const runDir = join(sandbox.runsDir, runId);
      const stateBefore = JSON.parse(
        await readFile(join(runDir, "state.json"), "utf-8")
      ) as { jobs: Record<string, { status: string }> };
      expect(stateBefore.jobs["build"]?.status).toBe("ready");

      // 2. Dispatch the step with an injected no-op runner. The
      //    dispatch boundary's contract is to forward to
      //    `executeCurrentStep`; we only assert that the call returns
      //    without throwing and that the chosen job no longer reports
      //    `ready` (the Engine — Step 2 stub or full WF-P6-SCRIPT —
      //    owns the actual transition target).
      const fakeRunner = new FakeRunner();
      await stepAction(
        makeStepOpts({
          zigmaflowDir: sandbox.zigmaflowDir,
          job: "build",
          runner: fakeRunner,
        })
      );

      const stateAfter = JSON.parse(
        await readFile(join(runDir, "state.json"), "utf-8")
      ) as { jobs: Record<string, { status: string }> };
      expect(stateAfter.jobs["build"]?.status).not.toBe("ready");
    }
  );
});

// ---------------------------------------------------------------------------
// T-DISPATCH-2: missing active_run → ConfigError (exit 4)
// ---------------------------------------------------------------------------

describe("stepAction (CLI integration) — missing active_run", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws ConfigError (exit code 4) when active_run is null (T-DISPATCH-2, UC-DISPATCH-9)",
    async () => {
      await expect(
        stepAction(
          makeStepOpts({
            zigmaflowDir: sandbox.zigmaflowDir,
          })
        )
      ).rejects.toMatchObject({
        kind: "ConfigError",
        exitCode: 4,
      });

      await expect(
        stepAction(
          makeStepOpts({
            zigmaflowDir: sandbox.zigmaflowDir,
          })
        )
      ).rejects.toBeInstanceOf(ConfigError);
    }
  );
});

// ---------------------------------------------------------------------------
// T-DISPATCH-3: --job points at a non-script step → WorkflowError (exit 3)
// ---------------------------------------------------------------------------

describe("stepAction (CLI integration) — non-script step", () => {
  let sandbox: Sandbox;
  let workflowPath: string;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
    workflowPath = join(sandbox.projectRoot, "code-change.yml");
    await writeFile(workflowPath, AGENT_WORKFLOW_YAML, "utf-8");
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws WorkflowError (exit code 3) when the current step is an agent step (T-DISPATCH-3, UC-DISPATCH-7)",
    async () => {
      const { runId } = await createRun({
        workflowPath,
        task: "draft the plan",
        runsDir: sandbox.runsDir,
        skillLockPath: sandbox.skillLockPath,
        clock: new FakeClock(),
      });

      const runDir = join(sandbox.runsDir, runId);
      const stateBytesBefore = await readFile(join(runDir, "state.json"));
      const eventsBytesBefore = await readFile(join(runDir, "events.jsonl"));

      await expect(
        stepAction(
          makeStepOpts({
            zigmaflowDir: sandbox.zigmaflowDir,
            job: "plan",
            runner: new FakeRunner(),
          })
        )
      ).rejects.toMatchObject({
        kind: "WorkflowError",
        exitCode: 11,
      });

      await expect(
        stepAction(
          makeStepOpts({
            zigmaflowDir: sandbox.zigmaflowDir,
            job: "plan",
            runner: new FakeRunner(),
          })
        )
      ).rejects.toBeInstanceOf(WorkflowError);

      // Handler must not write state.json or events.jsonl when the
      // step-kind guard rejects. The bytes on disk must be unchanged.
      const stateBytesAfter = await readFile(join(runDir, "state.json"));
      const eventsBytesAfter = await readFile(join(runDir, "events.jsonl"));
      expect(stateBytesAfter.equals(stateBytesBefore)).toBe(true);
      expect(eventsBytesAfter.equals(eventsBytesBefore)).toBe(true);
    }
  );
});

// ---------------------------------------------------------------------------
// T-DISPATCH-4: --job names an unknown job → UserInputError (exit 2)
// ---------------------------------------------------------------------------

describe("stepAction (CLI integration) — unknown --job", () => {
  let sandbox: Sandbox;
  let workflowPath: string;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
    workflowPath = join(sandbox.projectRoot, "code-change.yml");
    await writeFile(workflowPath, SCRIPT_WORKFLOW_YAML, "utf-8");
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws UserInputError (exit code 2) for an unknown --job (T-DISPATCH-4, UC-DISPATCH-5)",
    async () => {
      await createRun({
        workflowPath,
        task: "compile sources",
        runsDir: sandbox.runsDir,
        skillLockPath: sandbox.skillLockPath,
        clock: new FakeClock(),
      });

      await expect(
        stepAction(
          makeStepOpts({
            zigmaflowDir: sandbox.zigmaflowDir,
            job: "does-not-exist",
            runner: new FakeRunner(),
          })
        )
      ).rejects.toMatchObject({
        kind: "UserInputError",
        exitCode: 2,
      });

      await expect(
        stepAction(
          makeStepOpts({
            zigmaflowDir: sandbox.zigmaflowDir,
            job: "does-not-exist",
            runner: new FakeRunner(),
          })
        )
      ).rejects.toBeInstanceOf(UserInputError);
    }
  );
});

// ---------------------------------------------------------------------------
// T-DISPATCH-5: no --job, auto-detect, zero ready jobs → UserInputError
// ---------------------------------------------------------------------------

describe("stepAction (CLI integration) — auto-detect: zero ready jobs", () => {
  let sandbox: Sandbox;
  let workflowPath: string;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
    workflowPath = join(sandbox.projectRoot, "code-change.yml");
    await writeFile(workflowPath, SCRIPT_WORKFLOW_YAML, "utf-8");
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws UserInputError (exit code 2) when --job is omitted and zero jobs are ready (T-DISPATCH-5, UC-DISPATCH-4)",
    async () => {
      const { runId } = await createRun({
        workflowPath,
        task: "compile sources",
        runsDir: sandbox.runsDir,
        skillLockPath: sandbox.skillLockPath,
        clock: new FakeClock(),
      });

      // Mutate state.json so no job is in `ready`. We bypass the
      // Engine here intentionally to construct the "zero ready jobs"
      // pre-condition; this is fixture setup, not a state transition
      // performed by the system under test.
      const runDir = join(sandbox.runsDir, runId);
      const statePath = join(runDir, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf-8")) as {
        jobs: Record<string, { status: string }>;
      };
      for (const id of Object.keys(state.jobs)) {
        state.jobs[id] = { status: "waiting" };
      }
      await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");

      await expect(
        stepAction(
          makeStepOpts({
            zigmaflowDir: sandbox.zigmaflowDir,
            runner: new FakeRunner(),
          })
        )
      ).rejects.toMatchObject({
        kind: "UserInputError",
        exitCode: 2,
      });

      await expect(
        stepAction(
          makeStepOpts({
            zigmaflowDir: sandbox.zigmaflowDir,
            runner: new FakeRunner(),
          })
        )
      ).rejects.toBeInstanceOf(UserInputError);
    }
  );
});

// ---------------------------------------------------------------------------
// Type-only reference: ensures StateError remains imported so the file's
// import surface is stable for future tests (UC-DISPATCH-6, UC-DISPATCH-10
// are planned but not yet exercised at the dispatch test level).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _stateErrorTypeAnchor: typeof StateError = StateError;

// ---------------------------------------------------------------------------
// --latest flag resolution
// ---------------------------------------------------------------------------

describe("stepAction with --latest flag", () => {
  let sandbox: Sandbox;
  let workflowPath: string;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
    workflowPath = join(sandbox.projectRoot, "code-change.yml");
    await writeFile(workflowPath, SCRIPT_WORKFLOW_YAML, "utf-8");
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("resolves latest run when --latest is passed, without deprecation warning (T-LATEST-1)", async () => {
    // Create a run
    const { runId } = await createRun({
      workflowPath,
      task: "compile sources",
      runsDir: sandbox.runsDir,
      skillLockPath: sandbox.skillLockPath,
      clock: new FakeClock(),
    });

    // Verify that stepAction with --latest resolves to the correct run
    // without printing deprecation warnings.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fakeRunner = new FakeRunner();
      await stepAction(
        makeStepOpts({
          zigmaflowDir: sandbox.zigmaflowDir,
          job: "build",
          runner: fakeRunner,
          latest: true,
        })
      );

      // The step command itself is deprecated (v0.6), so one deprecation
      // warning is expected. What matters is that --latest does NOT trigger
      // an additional active_run deprecation warning.
      const deprecationCalls = warnSpy.mock.calls.filter(
        (call: unknown[]) => String(call[0]).includes("[DEPRECATED]")
      );
      expect(deprecationCalls).toHaveLength(1);
      expect(String(deprecationCalls[0]?.[0])).toContain("step");
      expect(String(deprecationCalls[0]?.[0])).not.toContain("active_run");
    } finally {
      warnSpy.mockRestore();
    }

    void runId;
  });

  it("throws ConfigError when --latest is passed but no runs exist (T-LATEST-2)", async () => {
    await expect(
      stepAction(
        makeStepOpts({
          zigmaflowDir: sandbox.zigmaflowDir,
          latest: true,
        })
      )
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
