/**
 * Tests for the `verify-run` command (WF-V022-VERIFYRUN Step 1 — Cases and Tests).
 *
 * Exercises the new CLI handler that powers `zigma-flow verify-run [run-id]`.
 * It reads state.json, events.jsonl, artifacts.jsonl for a run directory and
 * reports consistency errors with actionable, human-readable output.
 *
 * Consistency checks under test:
 *   1. state.json valid (exists, parseable JSON, required fields present).
 *   2. events.jsonl has no duplicate event ids AND
 *      state.last_event_id matches the last event id in the log.
 *   3. every entry in artifacts.jsonl references an existing file on disk.
 *   4. per-job attempt count equals the number of jobs/<jobId>/attempts/<n>/ dirs.
 *   5. every `context_block_updated` event references an artifact path that
 *      exists on disk.
 *
 * Exit codes: 0 = all checks pass; 1 = at least one FAIL.
 *
 * Fixtures (static, read-only):
 *   - tests/fixtures/corrupt-runs/valid-run/            (all checks pass)
 *   - tests/fixtures/corrupt-runs/missing-artifact/     (artifact file absent)
 *   - tests/fixtures/corrupt-runs/duplicate-event-id/   (evt-002 appears twice)
 *   - tests/fixtures/corrupt-runs/stale-last-event-id/  (state says evt-099, log tail is evt-003)
 *   - tests/fixtures/corrupt-runs/attempt-count-mismatch/ (state says attempt=3, only 2 dirs)
 *
 * Red-phase note: `src/commands/verify-run.ts` does not yet exist; tests
 * will fail to compile until WF-V022-VERIFYRUN Step 2 ships the module.
 *
 * Reference:
 *   - docs/phases/v0.2.2-runtime-reliability/workflows/wf-v022-verifyrun/01-cases-and-tests.md
 *   - GitHub Issue #94
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Red-phase: this module does not yet exist. Step 2 must create
// `src/commands/verify-run.ts` that exports `verifyRunAction` and
// `VerifyRunOptions`.
import {
  verifyRunAction,
  type VerifyRunOptions,
} from "../../src/commands/verify-run.js";

// ---------------------------------------------------------------------------
// Fixture paths (static, checked into the repo)
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(HERE, "..", "fixtures", "corrupt-runs");
const VALID_RUN_FIXTURE = join(FIXTURES_ROOT, "valid-run");
const MISSING_ARTIFACT_FIXTURE = join(FIXTURES_ROOT, "missing-artifact");
const DUPLICATE_EVENT_FIXTURE = join(FIXTURES_ROOT, "duplicate-event-id");
const STALE_LAST_EVENT_FIXTURE = join(FIXTURES_ROOT, "stale-last-event-id");
const ATTEMPT_MISMATCH_FIXTURE = join(FIXTURES_ROOT, "attempt-count-mismatch");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Copy a static fixture into a temp directory so tests can freely mutate the
 * copy (e.g. corrupt state.json) without affecting the read-only fixture in
 * source control. Returns the absolute path to the copied run dir.
 */
async function copyFixture(fixtureDir: string): Promise<string> {
  const dest = join(tmpdir(), `zigma-verify-run-${randomUUID()}`);
  await mkdir(dest, { recursive: true });
  await cp(fixtureDir, dest, { recursive: true });
  return dest;
}

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

/**
 * Build a VerifyRunOptions wired up to capture stdout/stderr lines so the tests
 * can assert on the human-readable output. `runDir` points at the run being
 * verified; the runsDir/runId variants are supported to mirror the CLI shape.
 */
function makeOpts(
  runDir: string,
  captured: CapturedOutput,
  extra: Partial<VerifyRunOptions> = {},
): VerifyRunOptions {
  return {
    runDir,
    stdout: (line: string) => {
      captured.stdout.push(line);
    },
    stderr: (line: string) => {
      captured.stderr.push(line);
    },
    ...extra,
  };
}

function makeCaptured(): CapturedOutput {
  return { stdout: [], stderr: [] };
}

/** Join stdout lines with newline for easier substring assertions. */
function joinedStdout(captured: CapturedOutput): string {
  return captured.stdout.join("\n");
}

// ---------------------------------------------------------------------------
// Cleanup registry — tests push temp dirs here and afterEach removes them.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function stagedFixture(fixtureDir: string): Promise<string> {
  const copy = await copyFixture(fixtureDir);
  tempDirs.push(copy);
  return copy;
}

// ---------------------------------------------------------------------------
// UC-VERIFY-1 — valid run: every check passes, exit code 0
// ---------------------------------------------------------------------------

describe("verifyRunAction — valid run (UC-VERIFY-1)", () => {
  it("returns exit code 0 when every consistency check passes (T-VR-001)", async () => {
    const runDir = await stagedFixture(VALID_RUN_FIXTURE);
    const captured = makeCaptured();

    const exitCode = await verifyRunAction(makeOpts(runDir, captured));

    expect(exitCode).toBe(0);
  });

  it("emits at least one [PASS] line for the state.json check (T-VR-002)", async () => {
    const runDir = await stagedFixture(VALID_RUN_FIXTURE);
    const captured = makeCaptured();

    await verifyRunAction(makeOpts(runDir, captured));

    const out = joinedStdout(captured);
    expect(out).toContain("[PASS]");
    expect(out.toLowerCase()).toContain("state.json");
  });

  it("emits no [FAIL] lines and no non-zero summary counts (T-VR-003)", async () => {
    const runDir = await stagedFixture(VALID_RUN_FIXTURE);
    const captured = makeCaptured();

    await verifyRunAction(makeOpts(runDir, captured));

    const out = joinedStdout(captured);
    expect(out).not.toContain("[FAIL]");
    // Summary must exist and say 0 failed. We do not lock the exact wording,
    // but the summary line must include "0" together with "fail" (case
    // insensitive).
    const lower = out.toLowerCase();
    expect(lower).toContain("summary");
    expect(lower).toMatch(/0\s*fail/);
  });
});

// ---------------------------------------------------------------------------
// UC-VERIFY-2 — state.json corruption
// ---------------------------------------------------------------------------

describe("verifyRunAction — state.json corruption (UC-VERIFY-2)", () => {
  it("returns exit code 1 and emits [FAIL] when state.json is missing (T-VR-010)", async () => {
    const runDir = await stagedFixture(VALID_RUN_FIXTURE);
    await rm(join(runDir, "state.json"));
    const captured = makeCaptured();

    const exitCode = await verifyRunAction(makeOpts(runDir, captured));

    expect(exitCode).toBe(1);
    const out = joinedStdout(captured);
    expect(out).toContain("[FAIL]");
    expect(out.toLowerCase()).toContain("state.json");
  });

  it("returns exit code 1 and emits [FAIL] when state.json is malformed JSON (T-VR-011)", async () => {
    const runDir = await stagedFixture(VALID_RUN_FIXTURE);
    await writeFile(join(runDir, "state.json"), "{ not valid json", "utf-8");
    const captured = makeCaptured();

    const exitCode = await verifyRunAction(makeOpts(runDir, captured));

    expect(exitCode).toBe(1);
    const out = joinedStdout(captured);
    expect(out).toContain("[FAIL]");
    expect(out.toLowerCase()).toContain("state.json");
  });

  it("returns exit code 1 when state.json is missing required fields (T-VR-012)", async () => {
    const runDir = await stagedFixture(VALID_RUN_FIXTURE);
    // Write a JSON object missing run_id and jobs — the shape check must fail.
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({ workflow: "code-change" }),
      "utf-8",
    );
    const captured = makeCaptured();

    const exitCode = await verifyRunAction(makeOpts(runDir, captured));

    expect(exitCode).toBe(1);
    expect(joinedStdout(captured)).toContain("[FAIL]");
  });
});

// ---------------------------------------------------------------------------
// UC-VERIFY-3 — events.jsonl integrity (duplicate ids + stale last_event_id)
// ---------------------------------------------------------------------------

describe("verifyRunAction — event sequence integrity (UC-VERIFY-3)", () => {
  it("returns exit code 1 and emits [FAIL] on duplicate event ids (T-VR-020)", async () => {
    const runDir = await stagedFixture(DUPLICATE_EVENT_FIXTURE);
    const captured = makeCaptured();

    const exitCode = await verifyRunAction(makeOpts(runDir, captured));

    expect(exitCode).toBe(1);
    const out = joinedStdout(captured);
    expect(out).toContain("[FAIL]");
    // The message should mention the duplicate id or the file. We accept
    // either signal to avoid over-specifying wording.
    const lower = out.toLowerCase();
    expect(lower.includes("events.jsonl") || lower.includes("duplicate")).toBe(
      true,
    );
    // The specific duplicated id from the fixture must appear so the operator
    // can locate it.
    expect(out).toContain("evt-002");
  });

  it("returns exit code 1 when state.last_event_id does not match the log tail (T-VR-021)", async () => {
    const runDir = await stagedFixture(STALE_LAST_EVENT_FIXTURE);
    const captured = makeCaptured();

    const exitCode = await verifyRunAction(makeOpts(runDir, captured));

    expect(exitCode).toBe(1);
    const out = joinedStdout(captured);
    expect(out).toContain("[FAIL]");
    // Both ids must appear so the operator sees what state claims vs. what
    // the log actually shows.
    expect(out).toContain("evt-099");
    expect(out).toContain("evt-003");
  });

  it("does NOT flag a run where events.jsonl is empty and last_event_id is absent (T-VR-022)", async () => {
    const runDir = await stagedFixture(VALID_RUN_FIXTURE);
    // Truncate events.jsonl and remove last_event_id from state.
    await writeFile(join(runDir, "events.jsonl"), "", "utf-8");
    const stateText = JSON.stringify({
      run_id: "20260701-0001",
      workflow: "code-change",
      task: "fix the encoding bug",
      created_at: "2026-07-01T00:00:00.000Z",
      status: "running",
      last_event_id: "",
      jobs: {},
    });
    await writeFile(join(runDir, "state.json"), stateText, "utf-8");
    // Also drop the artifact reference so we do not fail on that path.
    await writeFile(join(runDir, "artifacts.jsonl"), "", "utf-8");

    const captured = makeCaptured();
    const exitCode = await verifyRunAction(makeOpts(runDir, captured));

    // Event/state consistency for an empty run is acceptable.
    const out = joinedStdout(captured);
    expect(out).not.toMatch(/\[FAIL\][^\n]*event/i);
    // Exit code depends only on whether *some* other check failed; the
    // fixture we just built has no jobs and no artifacts, so we expect 0.
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// UC-VERIFY-4 — artifact file existence
// ---------------------------------------------------------------------------

describe("verifyRunAction — artifact file existence (UC-VERIFY-4)", () => {
  it("returns exit code 1 and emits [FAIL] when an artifact file is missing (T-VR-030)", async () => {
    const runDir = await stagedFixture(MISSING_ARTIFACT_FIXTURE);
    const captured = makeCaptured();

    const exitCode = await verifyRunAction(makeOpts(runDir, captured));

    expect(exitCode).toBe(1);
    const out = joinedStdout(captured);
    expect(out).toContain("[FAIL]");
    // The failing artifact path (or its filename) must appear so the operator
    // can locate the missing file.
    expect(out).toContain("stdout.txt");
  });

  it("returns exit code 1 when an artifact entry has no `path` field (T-VR-031)", async () => {
    const runDir = await stagedFixture(VALID_RUN_FIXTURE);
    // Overwrite artifacts.jsonl with an entry that omits `path`.
    const bad = JSON.stringify({
      id: "artifact://20260701-0001/jobs/implement/attempts/1/steps/implement/stdout",
      run_id: "20260701-0001",
      producer: { job: "implement", step: "implement", attempt: 1 },
      kind: "agent_stdout",
      content_type: "text/plain",
      size: 12,
      summary: "hello world",
      created_at: "2026-07-01T00:00:03.000Z",
    });
    await writeFile(join(runDir, "artifacts.jsonl"), bad + "\n", "utf-8");

    const captured = makeCaptured();
    const exitCode = await verifyRunAction(makeOpts(runDir, captured));

    expect(exitCode).toBe(1);
    expect(joinedStdout(captured)).toContain("[FAIL]");
  });
});

// ---------------------------------------------------------------------------
// UC-VERIFY-5 — job attempt integrity
// ---------------------------------------------------------------------------

describe("verifyRunAction — job attempt integrity (UC-VERIFY-5)", () => {
  it("returns exit code 1 when job.attempt exceeds the attempt dir count (T-VR-040)", async () => {
    const runDir = await stagedFixture(ATTEMPT_MISMATCH_FIXTURE);
    const captured = makeCaptured();

    const exitCode = await verifyRunAction(makeOpts(runDir, captured));

    expect(exitCode).toBe(1);
    const out = joinedStdout(captured);
    expect(out).toContain("[FAIL]");
    // The offending job id must appear in the diagnostic.
    expect(out).toContain("implement");
  });

  it("does not flag a job with attempt=1 that has exactly one attempt dir (T-VR-041)", async () => {
    const runDir = await stagedFixture(VALID_RUN_FIXTURE);
    const captured = makeCaptured();

    const exitCode = await verifyRunAction(makeOpts(runDir, captured));

    expect(exitCode).toBe(0);
    const out = joinedStdout(captured);
    // No FAIL line should mention "attempt" mismatch for the implement job.
    expect(out).not.toMatch(/\[FAIL\][^\n]*attempt/i);
  });
});

// ---------------------------------------------------------------------------
// UC-VERIFY-6 — context_block_updated → artifact_ref existence
// ---------------------------------------------------------------------------

describe("verifyRunAction — context block artifact references (UC-VERIFY-6)", () => {
  it("returns exit code 1 when a context_block_updated payload references a missing artifact (T-VR-050)", async () => {
    const runDir = await stagedFixture(VALID_RUN_FIXTURE);
    // Append a context_block_updated event whose artifact_ref points to a
    // path that does not exist on disk.
    const evt = {
      id: "evt-004",
      run_id: "20260701-0001",
      type: "context_block_updated",
      timestamp: "2026-07-01T00:00:04.000Z",
      producer: "engine",
      job: "implement",
      step: "implement",
      attempt: 1,
      payload: {
        block: "code_map",
        version: 1,
        artifact_ref: "jobs/implement/attempts/1/context/code_map.v1.md",
        producer: "implement/implement/1",
      },
    };
    await writeFile(
      join(runDir, "events.jsonl"),
      // Append to the existing 3 events; keep them so the log tail stays
      // consistent with state.last_event_id after we update it below.
      [
        `{"id":"evt-001","run_id":"20260701-0001","type":"run_created","timestamp":"2026-07-01T00:00:00.000Z","producer":"engine","job":null,"step":null,"attempt":null,"payload":{"workflow":"code-change","task":"fix the encoding bug"}}`,
        `{"id":"evt-002","run_id":"20260701-0001","type":"job_ready","timestamp":"2026-07-01T00:00:01.000Z","producer":"engine","job":"implement","step":null,"attempt":null,"payload":{"job_id":"implement"}}`,
        `{"id":"evt-003","run_id":"20260701-0001","type":"step_started","timestamp":"2026-07-01T00:00:02.000Z","producer":"engine","job":"implement","step":"implement","attempt":1,"payload":{"job_id":"implement","step_id":"implement","attempt":1}}`,
        JSON.stringify(evt),
        "",
      ].join("\n"),
      "utf-8",
    );
    // Sync last_event_id so the event-sequence check does not also flag.
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({
        run_id: "20260701-0001",
        workflow: "code-change",
        task: "fix the encoding bug",
        created_at: "2026-07-01T00:00:00.000Z",
        status: "running",
        last_event_id: "evt-004",
        jobs: { implement: { status: "running", attempt: 1 } },
      }),
      "utf-8",
    );

    const captured = makeCaptured();
    const exitCode = await verifyRunAction(makeOpts(runDir, captured));

    expect(exitCode).toBe(1);
    const out = joinedStdout(captured);
    expect(out).toContain("[FAIL]");
    // The missing context artifact path (or its filename) must appear.
    expect(out).toContain("code_map.v1.md");
  });
});

// ---------------------------------------------------------------------------
// UC-VERIFY-7 — output format contract (header, summary)
// ---------------------------------------------------------------------------

describe("verifyRunAction — output format (UC-VERIFY-7)", () => {
  it("prints a `Run: <run-id>` header line (T-VR-060)", async () => {
    const runDir = await stagedFixture(VALID_RUN_FIXTURE);
    const captured = makeCaptured();

    await verifyRunAction(makeOpts(runDir, captured));

    const out = joinedStdout(captured);
    // The run id from the valid-run fixture is 20260701-0001.
    expect(out).toContain("Run:");
    expect(out).toContain("20260701-0001");
  });

  it("prints a summary line with counts of passed / failed checks (T-VR-061)", async () => {
    const runDir = await stagedFixture(MISSING_ARTIFACT_FIXTURE);
    const captured = makeCaptured();

    await verifyRunAction(makeOpts(runDir, captured));

    const lower = joinedStdout(captured).toLowerCase();
    expect(lower).toContain("summary");
    expect(lower).toMatch(/\d+\s*pass/);
    expect(lower).toMatch(/\d+\s*fail/);
  });

  it("prints failures with actionable path/id detail (T-VR-062)", async () => {
    const runDir = await stagedFixture(MISSING_ARTIFACT_FIXTURE);
    const captured = makeCaptured();

    await verifyRunAction(makeOpts(runDir, captured));

    const out = joinedStdout(captured);
    // The FAIL line for the missing artifact should reference the artifact
    // path (not just say "an artifact is missing").
    expect(out).toMatch(/\[FAIL\][^\n]*jobs\/implement\/attempts\/1\/steps\/implement\/stdout\.txt/);
  });
});

// ---------------------------------------------------------------------------
// UC-VERIFY-8 — exit code contract
// ---------------------------------------------------------------------------

describe("verifyRunAction — exit code (UC-VERIFY-8)", () => {
  it("returns 0 exactly when there are no FAIL findings (T-VR-070)", async () => {
    const runDir = await stagedFixture(VALID_RUN_FIXTURE);
    const captured = makeCaptured();
    const exitCode = await verifyRunAction(makeOpts(runDir, captured));
    expect(exitCode).toBe(0);
  });

  it("returns 1 when at least one FAIL finding is reported (T-VR-071)", async () => {
    const runDir = await stagedFixture(DUPLICATE_EVENT_FIXTURE);
    const captured = makeCaptured();
    const exitCode = await verifyRunAction(makeOpts(runDir, captured));
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// UC-VERIFY-9 — runId / runsDir resolution (CLI wiring)
// ---------------------------------------------------------------------------

describe("verifyRunAction — run id resolution (UC-VERIFY-9)", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = join(tmpdir(), `zigma-verify-proj-${randomUUID()}`);
    await mkdir(join(tmpProject, ".zigma-flow", "runs"), { recursive: true });
    tempDirs.push(tmpProject);
  });

  it("resolves runId against runsDir when runDir is not supplied (T-VR-080)", async () => {
    // Stage a valid-run fixture under runsDir/<runId>/
    const runId = "20260701-0001";
    const runsDir = join(tmpProject, ".zigma-flow", "runs");
    await cp(VALID_RUN_FIXTURE, join(runsDir, runId), { recursive: true });

    const captured = makeCaptured();
    const exitCode = await verifyRunAction({
      runsDir,
      runId,
      stdout: (line: string) => captured.stdout.push(line),
      stderr: (line: string) => captured.stderr.push(line),
    });

    expect(exitCode).toBe(0);
    expect(joinedStdout(captured)).toContain(runId);
  });

  it("errors clearly when the run cannot be located (T-VR-081)", async () => {
    const runsDir = join(tmpProject, ".zigma-flow", "runs");
    const captured = makeCaptured();

    // Either the action throws a diagnostic error, or it returns 1 and writes
    // to stderr. We accept both shapes so we do not over-specify wording.
    let exitCode: number | undefined;
    let thrown: unknown;
    try {
      exitCode = await verifyRunAction({
        runsDir,
        runId: "does-not-exist",
        stdout: (line: string) => captured.stdout.push(line),
        stderr: (line: string) => captured.stderr.push(line),
      });
    } catch (e) {
      thrown = e;
    }

    if (thrown !== undefined) {
      expect(thrown).toBeInstanceOf(Error);
    } else {
      expect(exitCode).toBe(1);
      const combined = [
        ...captured.stdout,
        ...captured.stderr,
      ].join("\n").toLowerCase();
      expect(combined).toMatch(/not found|does[- ]not[- ]exist|missing/);
    }
  });
});

// ---------------------------------------------------------------------------
// Guard: silence the console during any tests that don't override stdout
// ---------------------------------------------------------------------------

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});
