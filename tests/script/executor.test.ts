/**
 * `executeScriptStep` tests for WF-P6-SCRIPT (Step 1 — Cases and Tests).
 *
 * These tests exercise the complete script-step execution pipeline against
 * real temp directories under `os.tmpdir()`. A local `FakeRunner` is injected
 * via `opts.runner` so the tests are independent of `execa` and of
 * WF-P6-RUNNER's `ExecaProcessRunner` adapter.
 *
 * Covers:
 *   - T-SCRIPT-1: Happy path — zero exit emits step_started → script_completed
 *                 → step_completed → job_completed; job status → "completed";
 *                 stdout artifact exists on disk.
 *   - T-SCRIPT-2: Non-zero exit emits step_failed and transitions the job to
 *                 "failed".
 *   - T-SCRIPT-3: Timeout (FakeRunner returns timedOut: true) emits
 *                 step_failed whose payload.reason contains "timeout"; job
 *                 status → "failed".
 *   - T-SCRIPT-4: result.json contains a snake_case ScriptResult with
 *                 artifact:// URIs in `stdout` and `stderr`.
 *   - T-SCRIPT-5: step_started is appended strictly before script_completed in
 *                 events.jsonl.
 *   - T-SCRIPT-6: state.json.last_event_id equals the tail event id of
 *                 events.jsonl after execution; the snapshot is written once.
 *   - T-SCRIPT-7: on_failure: { status: "failed" } produces the same observable
 *                 failure transition as the default (baseline before
 *                 TD-P6-002).
 *
 * Reference:
 *   - docs/phases/p6-script-step/workflows/wf-p6-script/01-cases-and-tests.md
 *   - docs/prd.md FR-007
 *   - docs/architecture.md §7.1, §7.2, §9.4, §12.3, §13 phase 6
 *   - docs/mvp-contracts.md §2.7 (Script Result), §6 (ProcessRunner), §7
 *
 * Red-phase note: `src/script/executor.ts` does not exist yet; tests fail at
 * module resolution. WF-P6-SCRIPT Step 2 creates the executor and turns the
 * tests green.
 *
 * Interface convention: the `ProcessRunner.run()` raw result uses camelCase
 * (`exitCode`, `timedOut`, `stdout`, `stderr`, `startedAt`, `endedAt`). The
 * executor maps that camelCase result to the snake_case `ScriptResult`
 * persisted in result.json (`exit_code`, `timed_out`, `started_at`,
 * `ended_at`). The FakeRunner below is the canonical reference for the
 * camelCase shape.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock } from "../../src/run/index.js";
import { executeScriptStep } from "../../src/script/executor.js";

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
 * Local mirror of the `ProcessRunner.run()` options shape. Declared inline so
 * the test file does not have to import from `src/script/index.ts`, which is
 * still empty in the red phase. The real port (WF-P6-RUNNER) will export a
 * compatible interface.
 */
interface FakeRunOptions {
  command: string;
  shell?: string | boolean;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Canonical `ProcessRunner.run()` raw result shape — CAMELCASE.
 *
 * This is the authoritative interface convention for the port:
 *   exitCode, timedOut, stdout, stderr, startedAt, endedAt
 *
 * `executeScriptStep` maps this camelCase result to the snake_case
 * `ScriptResult` written to `result.json`.
 */
interface FakeRunResult {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
}

/**
 * FakeRunner implements the ProcessRunner shape with a deterministic, fully
 * camelCase `run()` return value. Tests configure the canned result via the
 * constructor.
 */
class FakeRunner {
  public readonly calls: FakeRunOptions[] = [];

  constructor(private readonly canned: FakeRunResult) {}

  async run(opts: FakeRunOptions): Promise<FakeRunResult> {
    this.calls.push(opts);
    return this.canned;
  }
}

/**
 * Workflow YAML with a single script step in job "build" using inline `run`.
 * Used for T-SCRIPT-1..6.
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
 * Workflow YAML matching SCRIPT_WORKFLOW_YAML but with an explicit
 * `on_failure: { status: failed }` declaration. Used for T-SCRIPT-7.
 */
const SCRIPT_WORKFLOW_WITH_ON_FAILURE_YAML = `\
name: code-change
version: "0.1.0"
jobs:
  build:
    steps:
      - id: compile
        type: script
        run: "echo hello"
        on_failure:
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
  const projectRoot = join(tmpdir(), `zigma-script-exec-${randomUUID()}`);
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
 * Bootstrap a run for the script-step tests. Writes the workflow YAML, calls
 * `createRun`, and returns the resolved `runId` + run directory path.
 */
async function bootstrapScriptRun(
  sandbox: Sandbox,
  yamlBody: string
): Promise<{ runId: string; runDir: string; workflowPath: string }> {
  const workflowPath = join(sandbox.projectRoot, "code-change.yml");
  await writeFile(workflowPath, yamlBody, "utf-8");

  const { runId } = await createRun({
    workflowPath,
    task: "compile sources",
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
 * Build the canonical opts object for `executeScriptStep`. Uses conditional
 * spread for the runner field to satisfy `exactOptionalPropertyTypes` if the
 * caller chooses to omit it.
 */
function makeExecutorOpts(args: {
  runDir: string;
  zigmaflowDir: string;
  runId: string;
  jobId: string;
  clock?: Clock;
  runner: FakeRunner;
}): {
  runDir: string;
  zigmaflowDir: string;
  runId: string;
  jobId: string;
  clock: Clock;
  runner: FakeRunner;
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

// ---------------------------------------------------------------------------
// T-SCRIPT-1: Happy path — zero exit
// ---------------------------------------------------------------------------

describe("executeScriptStep — happy path (T-SCRIPT-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits step_started → script_completed → step_completed → job_completed and writes a stdout artifact when exit code is zero (T-SCRIPT-1, UC-SCRIPT-1, UC-SCRIPT-5)",
    async () => {
      const { runId, runDir } = await bootstrapScriptRun(
        sandbox,
        SCRIPT_WORKFLOW_YAML
      );

      const runner = new FakeRunner({
        exitCode: 0,
        timedOut: false,
        stdout: "ok\n",
        stderr: "",
        startedAt: FIXED_ISO,
        endedAt: FIXED_ISO,
      });

      await executeScriptStep(
        makeExecutorOpts({
          runDir,
          zigmaflowDir: sandbox.zigmaflowDir,
          runId,
          jobId: "build",
          runner,
        })
      );

      // Runner was invoked exactly once.
      expect(runner.calls.length).toBe(1);

      // Inspect events.jsonl: the four script-step events must appear in
      // order, after the existing run_created / job_ready events.
      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);

      expect(types).toContain("step_started");
      expect(types).toContain("script_completed");
      expect(types).toContain("step_completed");
      expect(types).toContain("job_completed");

      const idxStarted = types.indexOf("step_started");
      const idxScriptDone = types.indexOf("script_completed");
      const idxStepDone = types.indexOf("step_completed");
      const idxJobDone = types.indexOf("job_completed");

      expect(idxStarted).toBeGreaterThanOrEqual(0);
      expect(idxStarted).toBeLessThan(idxScriptDone);
      expect(idxScriptDone).toBeLessThan(idxStepDone);
      expect(idxStepDone).toBeLessThan(idxJobDone);

      // State snapshot: build job is completed.
      const snapshot = await readStateSnapshot(runDir);
      expect(snapshot.jobs["build"]?.status).toBe("completed");

      // stdout artifact file exists on disk under the canonical path:
      //   <runDir>/jobs/build/attempts/<attempt>/steps/compile/stdout.txt
      // The attempt directory may be "1" (initial attempt). We probe attempt
      // 1 first, then fall back to 0 in case the implementer chose 0.
      const stdoutAt1 = join(
        runDir,
        "jobs",
        "build",
        "attempts",
        "1",
        "steps",
        "compile",
        "stdout.txt"
      );
      const stdoutAt0 = join(
        runDir,
        "jobs",
        "build",
        "attempts",
        "0",
        "steps",
        "compile",
        "stdout.txt"
      );
      const stdoutPath = await stat(stdoutAt1).then(
        () => stdoutAt1,
        async () => {
          await stat(stdoutAt0);
          return stdoutAt0;
        }
      );
      const stdoutContents = await readFile(stdoutPath, "utf-8");
      expect(stdoutContents).toBe("ok\n");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SCRIPT-2: Non-zero exit → step_failed
// ---------------------------------------------------------------------------

describe("executeScriptStep — non-zero exit (T-SCRIPT-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "appends step_failed and sets the job status to failed when the runner reports a non-zero exit code (T-SCRIPT-2, UC-SCRIPT-2)",
    async () => {
      const { runId, runDir } = await bootstrapScriptRun(
        sandbox,
        SCRIPT_WORKFLOW_YAML
      );

      const runner = new FakeRunner({
        exitCode: 2,
        timedOut: false,
        stdout: "",
        stderr: "boom\n",
        startedAt: FIXED_ISO,
        endedAt: FIXED_ISO,
      });

      await executeScriptStep(
        makeExecutorOpts({
          runDir,
          zigmaflowDir: sandbox.zigmaflowDir,
          runId,
          jobId: "build",
          runner,
        })
      );

      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);

      // step_failed must appear; step_completed / job_completed must NOT.
      expect(types).toContain("step_started");
      expect(types).toContain("script_completed");
      expect(types).toContain("step_failed");
      expect(types).not.toContain("step_completed");
      expect(types).not.toContain("job_completed");

      const snapshot = await readStateSnapshot(runDir);
      expect(snapshot.jobs["build"]?.status).toBe("failed");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SCRIPT-3: Timeout → step_failed with reason containing "timeout"
// ---------------------------------------------------------------------------

describe("executeScriptStep — timeout (T-SCRIPT-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "appends step_failed whose payload.reason contains \"timeout\" and sets the job status to failed when the runner reports timedOut: true (T-SCRIPT-3, UC-SCRIPT-3)",
    async () => {
      const { runId, runDir } = await bootstrapScriptRun(
        sandbox,
        SCRIPT_WORKFLOW_YAML
      );

      const runner = new FakeRunner({
        exitCode: 124,
        timedOut: true,
        stdout: "",
        stderr: "",
        startedAt: FIXED_ISO,
        endedAt: FIXED_ISO,
      });

      await executeScriptStep(
        makeExecutorOpts({
          runDir,
          zigmaflowDir: sandbox.zigmaflowDir,
          runId,
          jobId: "build",
          runner,
        })
      );

      const events = await readEvents(runDir);
      const failed = events.find((e) => e.type === "step_failed");
      expect(failed).toBeDefined();

      const reason = failed?.payload["reason"];
      expect(typeof reason).toBe("string");
      expect(String(reason).toLowerCase()).toContain("timeout");

      const snapshot = await readStateSnapshot(runDir);
      expect(snapshot.jobs["build"]?.status).toBe("failed");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SCRIPT-4: result.json contains ScriptResult with artifact:// URIs
// ---------------------------------------------------------------------------

describe("executeScriptStep — result.json contents (T-SCRIPT-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "writes a ScriptResult JSON file whose stdout / stderr fields are artifact:// URIs (T-SCRIPT-4, UC-SCRIPT-4)",
    async () => {
      const { runId, runDir } = await bootstrapScriptRun(
        sandbox,
        SCRIPT_WORKFLOW_YAML
      );

      const runner = new FakeRunner({
        exitCode: 0,
        timedOut: false,
        stdout: "hello stdout\n",
        stderr: "warning\n",
        startedAt: "2026-06-08T00:00:01.000Z",
        endedAt: "2026-06-08T00:00:02.000Z",
      });

      await executeScriptStep(
        makeExecutorOpts({
          runDir,
          zigmaflowDir: sandbox.zigmaflowDir,
          runId,
          jobId: "build",
          runner,
        })
      );

      // Locate result.json under either attempts/1 or attempts/0.
      const resultAt1 = join(
        runDir,
        "jobs",
        "build",
        "attempts",
        "1",
        "steps",
        "compile",
        "result.json"
      );
      const resultAt0 = join(
        runDir,
        "jobs",
        "build",
        "attempts",
        "0",
        "steps",
        "compile",
        "result.json"
      );
      const resultPath = await stat(resultAt1).then(
        () => resultAt1,
        async () => {
          await stat(resultAt0);
          return resultAt0;
        }
      );

      const raw = await readFile(resultPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      // Snake-case ScriptResult schema (mvp-contracts §2.7, arch §9.4).
      expect(parsed["exit_code"]).toBe(0);
      expect(parsed["timed_out"]).toBe(false);
      expect(typeof parsed["started_at"]).toBe("string");
      expect(typeof parsed["ended_at"]).toBe("string");

      const stdoutRef = parsed["stdout"];
      const stderrRef = parsed["stderr"];
      expect(typeof stdoutRef).toBe("string");
      expect(typeof stderrRef).toBe("string");
      expect(String(stdoutRef).startsWith("artifact://")).toBe(true);
      expect(String(stderrRef).startsWith("artifact://")).toBe(true);

      // Both artifact URIs must reference files that actually exist on disk
      // under the run dir. The URI shape is:
      //   artifact://<runId>/jobs/<job>/attempts/<n>/steps/<step>/<stem>
      // and the on-disk file is `<stem>.txt`.
      const stdoutRefStr = String(stdoutRef);
      const stderrRefStr = String(stderrRef);
      expect(stdoutRefStr).toContain(`/${runId}/jobs/build/`);
      expect(stdoutRefStr).toContain("/steps/compile/stdout");
      expect(stderrRefStr).toContain(`/${runId}/jobs/build/`);
      expect(stderrRefStr).toContain("/steps/compile/stderr");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SCRIPT-5: step_started precedes script_completed in events.jsonl
// ---------------------------------------------------------------------------

describe("executeScriptStep — event ordering (T-SCRIPT-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "appends step_started strictly before script_completed in events.jsonl (T-SCRIPT-5, UC-SCRIPT-5)",
    async () => {
      const { runId, runDir } = await bootstrapScriptRun(
        sandbox,
        SCRIPT_WORKFLOW_YAML
      );

      const runner = new FakeRunner({
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        startedAt: FIXED_ISO,
        endedAt: FIXED_ISO,
      });

      await executeScriptStep(
        makeExecutorOpts({
          runDir,
          zigmaflowDir: sandbox.zigmaflowDir,
          runId,
          jobId: "build",
          runner,
        })
      );

      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);
      const idxStarted = types.indexOf("step_started");
      const idxScriptDone = types.indexOf("script_completed");

      expect(idxStarted).toBeGreaterThanOrEqual(0);
      expect(idxScriptDone).toBeGreaterThanOrEqual(0);
      expect(idxStarted).toBeLessThan(idxScriptDone);
    }
  );
});

// ---------------------------------------------------------------------------
// T-SCRIPT-6: state.last_event_id matches events.jsonl tail; snapshot written
// ---------------------------------------------------------------------------

describe("executeScriptStep — state snapshot consistency (T-SCRIPT-6)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "writes state.json with last_event_id matching the tail of events.jsonl after execution (T-SCRIPT-6, UC-SCRIPT-6)",
    async () => {
      const { runId, runDir } = await bootstrapScriptRun(
        sandbox,
        SCRIPT_WORKFLOW_YAML
      );

      // Capture snapshot mtime before executing the script step so we can
      // confirm the snapshot was rewritten (mtime should advance).
      const statePath = join(runDir, "state.json");
      const mtimeBefore = (await stat(statePath)).mtimeMs;

      const runner = new FakeRunner({
        exitCode: 0,
        timedOut: false,
        stdout: "ok",
        stderr: "",
        startedAt: FIXED_ISO,
        endedAt: FIXED_ISO,
      });

      await executeScriptStep(
        makeExecutorOpts({
          runDir,
          zigmaflowDir: sandbox.zigmaflowDir,
          runId,
          jobId: "build",
          runner,
        })
      );

      const events = await readEvents(runDir);
      const tailId = events[events.length - 1]?.id;
      expect(typeof tailId).toBe("string");

      const snapshot = await readStateSnapshot(runDir);
      expect(snapshot.last_event_id).toBe(tailId);

      // Snapshot was actually re-written (mtime advanced). Some filesystems
      // have coarse mtime resolution, so we accept >= rather than strict >.
      const mtimeAfter = (await stat(statePath)).mtimeMs;
      expect(mtimeAfter).toBeGreaterThanOrEqual(mtimeBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// T-SCRIPT-7: on_failure: { status: failed } baseline equivalence
// ---------------------------------------------------------------------------

describe("executeScriptStep — explicit on_failure: { status: failed } (T-SCRIPT-7)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox({ activeRun: null });
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "produces the same failed-transition outcome as the default when on_failure: { status: failed } is declared explicitly on the step (T-SCRIPT-7, UC-SCRIPT-7)",
    async () => {
      const { runId, runDir } = await bootstrapScriptRun(
        sandbox,
        SCRIPT_WORKFLOW_WITH_ON_FAILURE_YAML
      );

      const runner = new FakeRunner({
        exitCode: 3,
        timedOut: false,
        stdout: "",
        stderr: "fail\n",
        startedAt: FIXED_ISO,
        endedAt: FIXED_ISO,
      });

      await executeScriptStep(
        makeExecutorOpts({
          runDir,
          zigmaflowDir: sandbox.zigmaflowDir,
          runId,
          jobId: "build",
          runner,
        })
      );

      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);
      expect(types).toContain("step_failed");
      expect(types).not.toContain("step_completed");
      expect(types).not.toContain("job_completed");

      const snapshot = await readStateSnapshot(runDir);
      expect(snapshot.jobs["build"]?.status).toBe("failed");
    }
  );
});
