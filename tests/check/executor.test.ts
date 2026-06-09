/**
 * `executeCheckStep` tests for WF-P7-CHECK (Step 1 — Cases and Tests).
 *
 * These tests exercise the complete check-step execution pipeline against
 * real temp directories under `os.tmpdir()`. A local `FakeCheckRunner` is
 * injected via `opts.runner` so the tests are independent of any concrete
 * check kind implementation (file-exists / json-parse / git-diff / …),
 * which are deferred to TD-P7-002.
 *
 * Covers:
 *   - T-CHECK-1: Happy path — passing check emits step_started →
 *                 check_completed(passed:true) → step_completed →
 *                 job_completed; job status → "completed"; check-result.json
 *                 artifact exists on disk; state.last_event_id matches
 *                 events.jsonl tail.
 *   - T-CHECK-2: Failing check emits step_failed and transitions job to
 *                 "failed". check_completed payload carries the failures
 *                 list. No step_completed / job_completed.
 *   - T-CHECK-3: check-result.json is written to the canonical artifact
 *                 path with the runner's CheckResult contents (snake_case
 *                 keys: passed, check_id, failures, artifacts).
 *   - T-CHECK-4: on_fail: { status: "failed" } produces the same
 *                 observable failure transition as the default (baseline
 *                 before TD-P7-003 lands the other on_fail forms).
 *   - T-CHECK-5: Unknown check kind throws CheckError BEFORE any events
 *                 are appended; state.json is unchanged.
 *
 * Reference:
 *   - docs/phases/p7-check-step/workflows/wf-p7-check/01-cases-and-tests.md
 *   - docs/prd.md FR-008
 *   - docs/architecture.md §7.1, §7.2, §9.4, §12.3, §13 phase 7, §16
 *   - docs/mvp-contracts.md §2.4, §2.5, §2.8, §7
 *
 * Red-phase note: `src/check/executor.ts` does not exist yet; tests fail at
 * module resolution. WF-P7-CHECK Step 2 creates the executor and turns the
 * tests green.
 *
 * Interface convention: the `CheckRunner.run()` result uses the same
 * snake_case shape as the on-disk `check-result.json` artifact
 * (`passed`, `check_id`, `failures`, `artifacts`). Unlike P6's
 * `ProcessRunner` (which exposes a camelCase result that the executor
 * maps to a snake_case `ScriptResult`), the CheckRunner directly returns
 * the on-disk shape. The Engine is still the sole writer of `state.json`
 * and `events.jsonl`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock } from "../../src/run/index.js";
import { executeCheckStep } from "../../src/check/executor.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-09T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Local mirror of the `CheckRunner.run()` options shape. Declared inline so
 * the test file does not have to import from `src/check/index.ts`, which is
 * still empty in the red phase. The real port (WF-P7-CHECK Step 2) will
 * export a compatible interface.
 */
interface FakeCheckRunOptions {
  checkId: string;
  jobId: string;
  stepId: string;
  runDir: string;
  with?: Record<string, unknown>;
}

/**
 * Canonical `CheckRunner.run()` result shape — SNAKE_CASE; identical to the
 * on-disk `check-result.json` artifact.
 *
 * mvp-contracts §2.8 / architecture §9.4:
 *   { passed: boolean, check_id: string, failures: string[], artifacts: string[] }
 */
interface FakeCheckResult {
  passed: boolean;
  check_id: string;
  failures: string[];
  artifacts: string[];
}

/**
 * FakeCheckRunner implements the CheckRunner shape with a deterministic
 * canned `run()` return value plus an `unknownKind` mode used by T-CHECK-5
 * to simulate an unregistered check kind. When `unknownKind` is true,
 * `resolveKind()` throws `CheckError` so the executor short-circuits before
 * appending any events and before invoking `run()`. The `run()` guard
 * (throwing if called in unknownKind mode) is a regression safeguard — the
 * executor MUST NOT reach `run()` for an unknown kind.
 */
import { CheckError } from "../../src/utils/index.js";

class FakeCheckRunner {
  public readonly calls: FakeCheckRunOptions[] = [];

  constructor(
    private readonly canned: FakeCheckResult,
    private readonly opts: { unknownKind?: boolean } = {}
  ) {}

  async resolveKind(checkId: string): Promise<void> {
    if (this.opts.unknownKind === true) {
      throw new CheckError(`Unknown check kind: ${checkId}`, {
        details: { checkId },
      });
    }
  }

  async run(opts: FakeCheckRunOptions): Promise<FakeCheckResult> {
    this.calls.push(opts);
    if (this.opts.unknownKind === true) {
      throw new Error(
        "FakeCheckRunner reached for unknownKind mode — executor failed to short-circuit on unknown kind"
      );
    }
    return this.canned;
  }
}

/**
 * Workflow YAML with a single check step in job "verify" using `uses` to
 * reference a (placeholder) Skill Pack check. Used for T-CHECK-1, T-CHECK-2,
 * T-CHECK-3, T-CHECK-5.
 */
const CHECK_WORKFLOW_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  verify:
    steps:
      - id: report-schema
        type: check
        uses: code.checks.report-schema
`;

/**
 * Workflow YAML matching CHECK_WORKFLOW_YAML but with an explicit
 * `on_fail: { status: failed }` declaration. Used for T-CHECK-4.
 */
const CHECK_WORKFLOW_WITH_ON_FAIL_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  verify:
    steps:
      - id: report-schema
        type: check
        uses: code.checks.report-schema
        on_fail:
          status: failed
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
  const projectRoot = join(tmpdir(), `zigma-check-exec-${randomUUID()}`);
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
 * Bootstrap a run for the check-step tests. Writes the workflow YAML, calls
 * `createRun`, and returns the resolved `runId` + run directory path.
 */
async function bootstrapCheckRun(
  sandbox: Sandbox,
  yamlBody: string
): Promise<{ runId: string; runDir: string; workflowPath: string }> {
  const workflowPath = join(sandbox.projectRoot, "code-change.yml");
  await writeFile(workflowPath, yamlBody, "utf-8");

  const { runId } = await createRun({
    workflowPath,
    task: "verify report schema",
    runsDir: sandbox.runsDir,
    skillLockPath: sandbox.skillLockPath,
    clock: new FakeClock(),
  });
  const runDir = join(sandbox.runsDir, runId);
  return { runId, runDir, workflowPath };
}

/**
 * Read events.jsonl as an array of parsed event objects. Drops blank lines.
 */
async function readEvents(runDir: string): Promise<
  Array<{
    id: string;
    type: string;
    payload: Record<string, unknown>;
  }>
> {
  const text = await readFile(join(runDir, "events.jsonl"), "utf-8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map(
      (l) =>
        JSON.parse(l) as {
          id: string;
          type: string;
          payload: Record<string, unknown>;
        }
    );
}

/**
 * Read state.json as a typed snapshot. Required fields only.
 */
async function readStateSnapshot(runDir: string): Promise<{
  last_event_id: string;
  jobs: Record<string, { status: string }>;
}> {
  const text = await readFile(join(runDir, "state.json"), "utf-8");
  return JSON.parse(text) as {
    last_event_id: string;
    jobs: Record<string, { status: string }>;
  };
}

/**
 * Build the canonical opts object for `executeCheckStep`. Mirrors the
 * pattern used in the P6 script-executor tests.
 */
function makeExecutorOpts(args: {
  runDir: string;
  zigmaflowDir: string;
  runId: string;
  jobId: string;
  clock?: Clock;
  runner: FakeCheckRunner;
}): {
  runDir: string;
  zigmaflowDir: string;
  runId: string;
  jobId: string;
  clock: Clock;
  runner: FakeCheckRunner;
} {
  const clock: Clock = args.clock ?? new FakeClock();
  return {
    runDir: args.runDir,
    zigmaflowDir: args.zigmaflowDir,
    runId: args.runId,
    jobId: args.jobId,
    clock,
    runner: args.runner,
  };
}

/**
 * Locate `check-result.json` for a given step. Probes attempt=1 first
 * (current convention) and falls back to attempt=0 to be robust against
 * the implementer's attempt-numbering choice.
 */
async function locateCheckResultPath(
  runDir: string,
  jobId: string,
  stepId: string
): Promise<string> {
  const candidates = [
    join(
      runDir,
      "jobs",
      jobId,
      "attempts",
      "1",
      "steps",
      stepId,
      "check-result.json"
    ),
    join(
      runDir,
      "jobs",
      jobId,
      "attempts",
      "0",
      "steps",
      stepId,
      "check-result.json"
    ),
  ];
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `check-result.json not found under any expected attempt path for job=${jobId} step=${stepId}`
  );
}

// ---------------------------------------------------------------------------
// T-CHECK-1: Happy path — passing check
// ---------------------------------------------------------------------------

describe("executeCheckStep — happy path (T-CHECK-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits step_started → check_completed(passed:true) → step_completed → job_completed and writes check-result.json when the runner reports passed:true (T-CHECK-1, UC-CHECK-1)",
    async () => {
      const { runId, runDir } = await bootstrapCheckRun(
        sandbox,
        CHECK_WORKFLOW_YAML
      );

      const runner = new FakeCheckRunner({
        passed: true,
        check_id: "code.checks.report-schema",
        failures: [],
        artifacts: [],
      });

      await executeCheckStep(
        makeExecutorOpts({
          runDir,
          zigmaflowDir: sandbox.zigmaflowDir,
          runId,
          jobId: "verify",
          runner,
        })
      );

      // Runner was invoked exactly once.
      expect(runner.calls.length).toBe(1);

      // Inspect events.jsonl: the four check-step events must appear in
      // order, after the existing run_created / job_ready events.
      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);

      expect(types).toContain("step_started");
      expect(types).toContain("check_completed");
      expect(types).toContain("step_completed");
      expect(types).toContain("job_completed");

      const idxStarted = types.indexOf("step_started");
      const idxCheckDone = types.indexOf("check_completed");
      const idxStepDone = types.indexOf("step_completed");
      const idxJobDone = types.indexOf("job_completed");

      expect(idxStarted).toBeGreaterThanOrEqual(0);
      expect(idxStarted).toBeLessThan(idxCheckDone);
      expect(idxCheckDone).toBeLessThan(idxStepDone);
      expect(idxStepDone).toBeLessThan(idxJobDone);

      // check_completed payload carries the passed flag.
      const checkCompleted = events.find((e) => e.type === "check_completed");
      expect(checkCompleted).toBeDefined();
      expect(checkCompleted?.payload["passed"]).toBe(true);
      expect(checkCompleted?.payload["check_id"]).toBe(
        "code.checks.report-schema"
      );

      // State snapshot: verify job is completed.
      const snapshot = await readStateSnapshot(runDir);
      expect(snapshot.jobs["verify"]?.status).toBe("completed");

      // state.last_event_id equals the tail event id of events.jsonl.
      const tailId = events[events.length - 1]?.id;
      expect(typeof tailId).toBe("string");
      expect(snapshot.last_event_id).toBe(tailId);

      // check-result.json exists at the canonical path.
      const resultPath = await locateCheckResultPath(
        runDir,
        "verify",
        "report-schema"
      );
      const raw = await readFile(resultPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed["passed"]).toBe(true);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CHECK-2: Failing check → step_failed + state failed; failures carried
// ---------------------------------------------------------------------------

describe("executeCheckStep — failing check (T-CHECK-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "appends step_failed and transitions job to failed when the runner reports passed:false; check_completed payload carries failures (T-CHECK-2, UC-CHECK-2)",
    async () => {
      const { runId, runDir } = await bootstrapCheckRun(
        sandbox,
        CHECK_WORKFLOW_YAML
      );

      const failures = [
        "missing required field 'report'",
        "field 'summary' is empty",
      ];

      const runner = new FakeCheckRunner({
        passed: false,
        check_id: "code.checks.report-schema",
        failures,
        artifacts: [],
      });

      await executeCheckStep(
        makeExecutorOpts({
          runDir,
          zigmaflowDir: sandbox.zigmaflowDir,
          runId,
          jobId: "verify",
          runner,
        })
      );

      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);

      expect(types).toContain("step_started");
      expect(types).toContain("check_completed");
      expect(types).toContain("step_failed");
      expect(types).not.toContain("step_completed");
      expect(types).not.toContain("job_completed");

      // check_completed payload carries passed:false and the failures list.
      const checkCompleted = events.find((e) => e.type === "check_completed");
      expect(checkCompleted).toBeDefined();
      expect(checkCompleted?.payload["passed"]).toBe(false);

      const payloadFailures = checkCompleted?.payload["failures"];
      expect(Array.isArray(payloadFailures)).toBe(true);
      expect(payloadFailures as string[]).toEqual(failures);

      // State snapshot: verify job is failed.
      const snapshot = await readStateSnapshot(runDir);
      expect(snapshot.jobs["verify"]?.status).toBe("failed");

      // check-result.json exists and carries the failures.
      const resultPath = await locateCheckResultPath(
        runDir,
        "verify",
        "report-schema"
      );
      const parsed = JSON.parse(await readFile(resultPath, "utf-8")) as {
        passed: boolean;
        failures: string[];
      };
      expect(parsed.passed).toBe(false);
      expect(parsed.failures).toEqual(failures);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CHECK-3: check-result.json shape and path
// ---------------------------------------------------------------------------

describe("executeCheckStep — check-result.json contents (T-CHECK-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "writes check-result.json with snake_case fields { passed, check_id, failures, artifacts } matching the runner's CheckResult (T-CHECK-3, UC-CHECK-3)",
    async () => {
      const { runId, runDir } = await bootstrapCheckRun(
        sandbox,
        CHECK_WORKFLOW_YAML
      );

      const canned: FakeCheckResult = {
        passed: true,
        check_id: "code.checks.report-schema",
        failures: [],
        artifacts: [
          `artifact://${runId}/jobs/verify/attempts/1/steps/report-schema/check-result`,
        ],
      };

      const runner = new FakeCheckRunner(canned);

      await executeCheckStep(
        makeExecutorOpts({
          runDir,
          zigmaflowDir: sandbox.zigmaflowDir,
          runId,
          jobId: "verify",
          runner,
        })
      );

      const resultPath = await locateCheckResultPath(
        runDir,
        "verify",
        "report-schema"
      );

      const raw = await readFile(resultPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      // Snake-case CheckResult schema (mvp-contracts §2.8, arch §9.4).
      expect(Object.keys(parsed).sort()).toEqual(
        ["artifacts", "check_id", "failures", "passed"].sort()
      );

      expect(parsed["passed"]).toBe(canned.passed);
      expect(parsed["check_id"]).toBe(canned.check_id);
      expect(parsed["failures"]).toEqual(canned.failures);
      expect(parsed["artifacts"]).toEqual(canned.artifacts);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CHECK-4: on_fail: { status: failed } baseline equivalence
// ---------------------------------------------------------------------------

describe(
  "executeCheckStep — explicit on_fail: { status: failed } (T-CHECK-4)",
  () => {
    let sandbox: Sandbox;

    beforeEach(async () => {
      sandbox = await makeSandbox({ activeRun: null });
    });

    afterEach(async () => {
      await rm(sandbox.projectRoot, { recursive: true, force: true });
    });

    it(
      "produces the same failed-transition outcome as the default when on_fail: { status: failed } is declared explicitly on the step (T-CHECK-4, UC-CHECK-4)",
      async () => {
        const { runId, runDir } = await bootstrapCheckRun(
          sandbox,
          CHECK_WORKFLOW_WITH_ON_FAIL_YAML
        );

        const runner = new FakeCheckRunner({
          passed: false,
          check_id: "code.checks.report-schema",
          failures: ["report missing"],
          artifacts: [],
        });

        await executeCheckStep(
          makeExecutorOpts({
            runDir,
            zigmaflowDir: sandbox.zigmaflowDir,
            runId,
            jobId: "verify",
            runner,
          })
        );

        const events = await readEvents(runDir);
        const types = events.map((e) => e.type);
        expect(types).toContain("step_failed");
        expect(types).not.toContain("step_completed");
        expect(types).not.toContain("job_completed");

        const snapshot = await readStateSnapshot(runDir);
        expect(snapshot.jobs["verify"]?.status).toBe("failed");
      }
    );
  }
);

// ---------------------------------------------------------------------------
// T-CHECK-4b: on_fail: "fail" literal — explicit branch, same outcome as default
// ---------------------------------------------------------------------------

/**
 * Workflow YAML with `on_fail: "fail"` string literal on the check step.
 * Used for T-CHECK-4b to verify the explicit branch in the dispatch logic.
 */
const CHECK_WORKFLOW_WITH_ON_FAIL_LITERAL_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  verify:
    steps:
      - id: report-schema
        type: check
        uses: code.checks.report-schema
        on_fail: fail
`;

describe(
  "executeCheckStep — on_fail: \"fail\" string literal (T-CHECK-4b)",
  () => {
    let sandbox: Sandbox;

    beforeEach(async () => {
      sandbox = await makeSandbox({ activeRun: null });
    });

    afterEach(async () => {
      await rm(sandbox.projectRoot, { recursive: true, force: true });
    });

    it(
      "transitions job to \"failed\" when on_fail is the \"fail\" string literal — explicit branch prevents silent fallthrough (T-CHECK-4b)",
      async () => {
        const { runId, runDir } = await bootstrapCheckRun(
          sandbox,
          CHECK_WORKFLOW_WITH_ON_FAIL_LITERAL_YAML
        );

        const runner = new FakeCheckRunner({
          passed: false,
          check_id: "code.checks.report-schema",
          failures: ["report missing"],
          artifacts: [],
        });

        await executeCheckStep(
          makeExecutorOpts({
            runDir,
            zigmaflowDir: sandbox.zigmaflowDir,
            runId,
            jobId: "verify",
            runner,
          })
        );

        const events = await readEvents(runDir);
        const types = events.map((e) => e.type);
        expect(types).toContain("step_failed");
        expect(types).not.toContain("step_completed");
        expect(types).not.toContain("job_completed");

        const snapshot = await readStateSnapshot(runDir);
        expect(snapshot.jobs["verify"]?.status).toBe("failed");
      }
    );
  }
);

// ---------------------------------------------------------------------------
// T-CHECK-6: on_pass with unsupported value → WorkflowError (TD-P7-003 guard)
// ---------------------------------------------------------------------------

import { WorkflowError } from "../../src/utils/index.js";

/**
 * Workflow YAML with an unsupported `on_pass` value. Used for T-CHECK-6
 * to verify the guard throws WorkflowError instead of silently succeeding.
 */
const CHECK_WORKFLOW_WITH_UNSUPPORTED_ON_PASS_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  verify:
    steps:
      - id: report-schema
        type: check
        uses: code.checks.report-schema
        on_pass: fail
`;

describe(
  "executeCheckStep — on_pass unsupported value → WorkflowError (T-CHECK-6)",
  () => {
    let sandbox: Sandbox;

    beforeEach(async () => {
      sandbox = await makeSandbox({ activeRun: null });
    });

    afterEach(async () => {
      await rm(sandbox.projectRoot, { recursive: true, force: true });
    });

    it(
      "throws WorkflowError when on_pass is present and is not \"continue\" — prevents silent misconfiguration (T-CHECK-6, TD-P7-003 guard)",
      async () => {
        const { runId, runDir } = await bootstrapCheckRun(
          sandbox,
          CHECK_WORKFLOW_WITH_UNSUPPORTED_ON_PASS_YAML
        );

        const runner = new FakeCheckRunner({
          passed: true,
          check_id: "code.checks.report-schema",
          failures: [],
          artifacts: [],
        });

        let thrown: unknown = undefined;
        try {
          await executeCheckStep(
            makeExecutorOpts({
              runDir,
              zigmaflowDir: sandbox.zigmaflowDir,
              runId,
              jobId: "verify",
              runner,
            })
          );
        } catch (e: unknown) {
          thrown = e;
        }

        expect(thrown).toBeDefined();
        expect(thrown).toBeInstanceOf(WorkflowError);
        const err = thrown as WorkflowError;
        expect(err.message).toMatch(/on_pass/);
        expect(err.message).toMatch(/TD-P7-003/);
      }
    );
  }
);

// ---------------------------------------------------------------------------
// T-CHECK-5: Unknown check kind → CheckError BEFORE any events
// ---------------------------------------------------------------------------

describe("executeCheckStep — unknown check kind (T-CHECK-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws CheckError BEFORE appending any step_started event and leaves state.json unchanged when the check kind is not registered (T-CHECK-5, UC-CHECK-5)",
    async () => {
      const { runId, runDir } = await bootstrapCheckRun(
        sandbox,
        CHECK_WORKFLOW_YAML
      );

      // Capture the events.jsonl tail event id and the state snapshot BEFORE
      // attempting to execute the check step. After the CheckError is
      // thrown, both must be unchanged.
      const eventsBefore = await readEvents(runDir);
      const tailIdBefore = eventsBefore[eventsBefore.length - 1]?.id;
      const eventsContentBefore = await readFile(
        join(runDir, "events.jsonl"),
        "utf-8"
      );
      const stateContentBefore = await readFile(
        join(runDir, "state.json"),
        "utf-8"
      );

      // FakeCheckRunner in unknownKind mode throws if it is ever reached —
      // this is a regression guard. The executor MUST detect the unknown
      // kind during resolution and throw `CheckError` before invoking the
      // runner.
      const runner = new FakeCheckRunner(
        {
          passed: false,
          check_id: "code.checks.report-schema",
          failures: [],
          artifacts: [],
        },
        { unknownKind: true }
      );

      let thrown: unknown = undefined;
      try {
        await executeCheckStep(
          makeExecutorOpts({
            runDir,
            zigmaflowDir: sandbox.zigmaflowDir,
            runId,
            jobId: "verify",
            runner,
          })
        );
      } catch (e: unknown) {
        thrown = e;
      }

      expect(thrown).toBeDefined();
      const err = thrown as { kind?: string; exitCode?: number; name?: string };
      expect(err.kind ?? err.name).toBe("CheckError");
      expect(err.exitCode).toBe(1);

      // events.jsonl must NOT have grown a step_started line.
      const eventsAfter = await readEvents(runDir);
      const typesAfter = eventsAfter.map((e) => e.type);
      expect(typesAfter).not.toContain("step_started");
      expect(typesAfter).not.toContain("check_completed");

      // events.jsonl tail event id is unchanged.
      const tailIdAfter = eventsAfter[eventsAfter.length - 1]?.id;
      expect(tailIdAfter).toBe(tailIdBefore);

      // events.jsonl raw text is byte-for-byte unchanged.
      const eventsContentAfter = await readFile(
        join(runDir, "events.jsonl"),
        "utf-8"
      );
      expect(eventsContentAfter).toBe(eventsContentBefore);

      // state.json is byte-for-byte unchanged.
      const stateContentAfter = await readFile(
        join(runDir, "state.json"),
        "utf-8"
      );
      expect(stateContentAfter).toBe(stateContentBefore);

      // Runner was never invoked.
      expect(runner.calls.length).toBe(0);
    }
  );
});
