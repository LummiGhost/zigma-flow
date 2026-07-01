/**
 * Tests for the `events` command (WF-V022-DIAGNOSTIC Step 1 — Cases and Tests).
 *
 * Exercises the new CLI handler that powers `zigma-flow events [run-id]`.
 * It reads `events.jsonl` from the requested (or latest) run directory and
 * prints the last N events (default 20) as one-line-per-event, with a
 * `--limit N` flag and a `--job <id>` filter honored via options.
 *
 * Format (one line per event):
 *   `<event-id>  <timestamp>  <event-type>  <job>/<step>`
 *
 * Exit contract:
 *   - Command returns exit code 0 on success even when the log is empty.
 *   - Command returns exit code 1 (or throws a ZigmaFlowError) when the
 *     run directory itself is not found; missing `events.jsonl` inside an
 *     existing run directory is treated as an empty log (exit 0).
 *
 * Red-phase note: `src/commands/events.ts` does not yet exist; tests will
 * fail to compile until WF-V022-DIAGNOSTIC Step 2 ships the module.
 *
 * Reference:
 *   - docs/phases/v0.2.2-runtime-reliability/workflows/wf-v022-diagnostic/01-cases-and-tests.md
 *   - docs/phases/v0.2.2-runtime-reliability/02-development-plan.md §WF-V022-DIAGNOSTIC
 *   - GitHub Issue #94 (P1 items)
 */

import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Red-phase: this module does not yet exist. Step 2 must create
// `src/commands/events.ts` exporting `eventsAction` and `EventsOptions`.
import {
  eventsAction,
  type EventsOptions,
} from "../../src/commands/events.js";

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(HERE, "..", "fixtures");
const DIAGNOSTIC_RUN_FIXTURE = join(FIXTURES_ROOT, "diagnostic-run");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

function makeCaptured(): CapturedOutput {
  return { stdout: [], stderr: [] };
}

function joinedStdout(captured: CapturedOutput): string {
  return captured.stdout.join("\n");
}

/**
 * Build an EventsOptions wired up to capture stdout/stderr for assertions.
 * `runDir` points at the run being inspected. `runsDir`/`runId` variants
 * are supported to mirror the CLI shape (resolving latest / explicit id).
 */
function makeOpts(
  captured: CapturedOutput,
  extra: Partial<EventsOptions> = {},
): EventsOptions {
  return {
    stdout: (line: string) => {
      captured.stdout.push(line);
    },
    stderr: (line: string) => {
      captured.stderr.push(line);
    },
    ...extra,
  } as EventsOptions;
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

/** Copy the fixture to a temp dir so tests can freely mutate the copy. */
async function stagedFixture(fixtureDir: string): Promise<string> {
  const dest = join(tmpdir(), `zigma-events-${randomUUID()}`);
  await mkdir(dest, { recursive: true });
  await cp(fixtureDir, dest, { recursive: true });
  tempDirs.push(dest);
  return dest;
}

/**
 * Build a tiny runs dir tree with one run copied from a fixture. Returns
 * `{ runsDir, runId, runDir }` so tests can exercise runId resolution.
 */
async function makeRunsDirWithFixture(
  fixtureDir: string,
  runId: string,
): Promise<{ runsDir: string; runId: string; runDir: string }> {
  const runsDir = join(tmpdir(), `zigma-events-runs-${randomUUID()}`);
  const runDir = join(runsDir, runId);
  await mkdir(runDir, { recursive: true });
  await cp(fixtureDir, runDir, { recursive: true });
  tempDirs.push(runsDir);
  return { runsDir, runId, runDir };
}

// ---------------------------------------------------------------------------
// UC-EV-1 — default output: prints all events (up to default limit) newest at end
// ---------------------------------------------------------------------------

describe("eventsAction — default output (UC-EV-1)", () => {
  it("prints one line per event when the log has fewer than the default 20 (T-EV-001)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    const captured = makeCaptured();

    await eventsAction(makeOpts(captured, { runDir }));

    // 8 events in the fixture → 8 output lines (order preserved).
    expect(captured.stdout.length).toBe(8);
    // First and last event ids from the fixture appear in order.
    expect(captured.stdout[0]).toContain("evt-001");
    expect(captured.stdout[captured.stdout.length - 1]).toContain("evt-008");
  });

  it("each line includes event id, timestamp, type, and job/step (T-EV-002)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    const captured = makeCaptured();

    await eventsAction(makeOpts(captured, { runDir }));

    // Locate the step_started line for the `implement` job attempt 2 —
    // it has id evt-008 and step id impl-step.
    const lastLine = captured.stdout[captured.stdout.length - 1] ?? "";
    expect(lastLine).toContain("evt-008");
    expect(lastLine).toContain("step_started");
    // Timestamp appears (ISO 8601 prefix `2026-07-01T`).
    expect(lastLine).toContain("2026-07-01T");
    // Job/step: `implement/impl-step` — accept either that literal
    // formatting or the two ids appearing on the line.
    expect(lastLine).toContain("implement");
    expect(lastLine).toContain("impl-step");
  });
});

// ---------------------------------------------------------------------------
// UC-EV-2 — --limit N slices the tail
// ---------------------------------------------------------------------------

describe("eventsAction — --limit slicing (UC-EV-2)", () => {
  it("prints only the last N events when --limit N is set (T-EV-010)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    const captured = makeCaptured();

    await eventsAction(makeOpts(captured, { runDir, limit: 5 }));

    // Exactly 5 lines printed (the newest 5 = evt-004..evt-008).
    expect(captured.stdout.length).toBe(5);
    // The first line printed is the oldest of the 5 kept = evt-004.
    expect(captured.stdout[0]).toContain("evt-004");
    // The last line printed is evt-008.
    expect(captured.stdout[4]).toContain("evt-008");
    // evt-001 must NOT appear anywhere.
    expect(joinedStdout(captured)).not.toContain("evt-001");
  });

  it("limit greater than the log size prints every event (T-EV-011)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    const captured = makeCaptured();

    await eventsAction(makeOpts(captured, { runDir, limit: 100 }));

    expect(captured.stdout.length).toBe(8);
    expect(joinedStdout(captured)).toContain("evt-001");
    expect(joinedStdout(captured)).toContain("evt-008");
  });

  it("limit of 0 prints nothing but still exits cleanly (T-EV-012)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    const captured = makeCaptured();

    await eventsAction(makeOpts(captured, { runDir, limit: 0 }));

    expect(captured.stdout.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// UC-EV-3 — missing / empty inputs are handled gracefully
// ---------------------------------------------------------------------------

describe("eventsAction — graceful missing/empty inputs (UC-EV-3)", () => {
  it("treats a missing events.jsonl inside an existing run dir as an empty log (T-EV-020)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    // Remove the events file — state.json remains.
    await rm(join(runDir, "events.jsonl"));

    const captured = makeCaptured();
    // Should not throw; must exit cleanly with 0 output lines.
    await expect(
      eventsAction(makeOpts(captured, { runDir })),
    ).resolves.not.toThrow();

    expect(captured.stdout.length).toBe(0);
  });

  it("treats an empty events.jsonl file as an empty log (T-EV-021)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    await writeFile(join(runDir, "events.jsonl"), "", "utf-8");

    const captured = makeCaptured();
    await expect(
      eventsAction(makeOpts(captured, { runDir })),
    ).resolves.not.toThrow();

    expect(captured.stdout.length).toBe(0);
  });

  it("reports a clear error when the run directory itself does not exist (T-EV-022)", async () => {
    const bogusRunDir = join(
      tmpdir(),
      `zigma-events-missing-${randomUUID()}`,
    );

    const captured = makeCaptured();
    // Accept either behavior: throw a ZigmaFlowError, or resolve with a
    // non-zero pathway that emits a stderr message. We require _some_
    // signal that the operator's target directory is missing.
    let threw = false;
    try {
      await eventsAction(makeOpts(captured, { runDir: bogusRunDir }));
    } catch (e: unknown) {
      threw = true;
      expect(e).toBeInstanceOf(Error);
    }
    const stderr = captured.stderr.join("\n").toLowerCase();
    const signaled = threw || stderr.includes("not found") || stderr.includes("run");
    expect(signaled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UC-EV-4 — runId resolution against a runs dir
// ---------------------------------------------------------------------------

describe("eventsAction — runsDir + runId resolution (UC-EV-4)", () => {
  it("resolves runsDir + runId when runDir is not provided (T-EV-030)", async () => {
    const { runsDir, runId } = await makeRunsDirWithFixture(
      DIAGNOSTIC_RUN_FIXTURE,
      "20260701-0007",
    );

    const captured = makeCaptured();
    await eventsAction(makeOpts(captured, { runsDir, runId }));

    // The 8 events from the fixture should print.
    expect(captured.stdout.length).toBe(8);
    expect(joinedStdout(captured)).toContain("evt-008");
  });

  it("resolves the latest run when neither runId nor runDir is provided (T-EV-031)", async () => {
    // Two runs in the same runsDir; lexicographic sort picks the newer one.
    const runsDir = join(tmpdir(), `zigma-events-latest-${randomUUID()}`);
    await mkdir(runsDir, { recursive: true });
    tempDirs.push(runsDir);

    const olderRun = join(runsDir, "20260630-0001");
    const newerRun = join(runsDir, "20260701-0007");
    await mkdir(olderRun, { recursive: true });
    await cp(DIAGNOSTIC_RUN_FIXTURE, newerRun, { recursive: true });
    // Give the older run an events.jsonl with a marker id we can detect
    // if the command accidentally picks the older run.
    await writeFile(
      join(olderRun, "events.jsonl"),
      JSON.stringify({
        id: "OLD-EVT",
        run_id: "20260630-0001",
        type: "run_created",
        timestamp: "2026-06-30T00:00:00.000Z",
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: {},
      }) + "\n",
      "utf-8",
    );

    const captured = makeCaptured();
    await eventsAction(makeOpts(captured, { runsDir }));

    const out = joinedStdout(captured);
    // The newer run's events must be picked, not the older one.
    expect(out).toContain("evt-008");
    expect(out).not.toContain("OLD-EVT");
  });
});
