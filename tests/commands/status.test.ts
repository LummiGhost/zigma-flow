/**
 * Tests for the `status` command (WF-P3-STATUS Step 1 — Cases and Tests).
 *
 * Covers: findRun, renderRunStatus, and statusAction.
 *
 * Tests will not compile until Step 2 creates `src/commands/status.ts`
 * exporting `findRun`, `renderRunStatus`, `statusAction`, and `StatusOptions`.
 *
 * Reference:
 *   - docs/phases/p3-run/workflows/wf-p3-status/01-cases-and-tests.md
 *   - docs/prd.md FR-005
 *   - docs/mvp-contracts.md §2.3
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { JobState, RunState } from "../../src/run/index.js";
import {
  findRun,
  renderRunStatus,
  statusAction,
} from "../../src/commands/status.js";
import { FilesystemError } from "../../src/utils/index.js";

const FIXED_ISO = "2026-06-07T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a RunState. Optional fields use conditional assignment so we never
 * set `undefined` (required by `exactOptionalPropertyTypes`). */
function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: "20260607-0001",
    workflow: "code-change",
    task: "fix the bug",
    created_at: FIXED_ISO,
    last_event_id: "evt-001",
    jobs: {
      intake: { status: "ready" },
    },
    ...overrides,
  };
}

/** Build a JobState with conditional activation/attempt assignment. */
function makeJob(
  status: JobState["status"],
  options: { activation?: string; attempt?: number } = {},
): JobState {
  const job: JobState = { status };
  if (options.activation !== undefined) {
    job.activation = options.activation;
  }
  if (options.attempt !== undefined) {
    job.attempt = options.attempt;
  }
  return job;
}

/** Write a state.json fixture using raw writeFile + JSON.stringify so the
 * fixture is independent of LocalStateStore.writeSnapshot. */
async function writeState(runDir: string, state: RunState): Promise<void> {
  await writeFile(join(runDir, "state.json"), JSON.stringify(state), "utf-8");
}

// ---------------------------------------------------------------------------
// findRun
// ---------------------------------------------------------------------------

describe("findRun", () => {
  let tmpDir: string;
  let runsDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-status-test-${randomUUID()}`);
    runsDir = join(tmpDir, "runs");
    await mkdir(runsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns the only run dir when one exists (T-FIND-1, UC-FIND-1)", async () => {
    const runId = "20260607-0001";
    await mkdir(join(runsDir, runId));
    const result = await findRun(runsDir);
    expect(result).toBe(join(runsDir, runId));
  });

  it("returns the lexicographically largest run dir when multiple exist (T-FIND-2, UC-FIND-2)", async () => {
    await mkdir(join(runsDir, "20260606-0001"));
    await mkdir(join(runsDir, "20260607-0001"));
    await mkdir(join(runsDir, "20260607-0002"));
    const result = await findRun(runsDir);
    expect(result).toBe(join(runsDir, "20260607-0002"));
  });

  it("throws FilesystemError when no runs exist (T-FIND-3, UC-FIND-3)", async () => {
    await expect(findRun(runsDir)).rejects.toBeInstanceOf(FilesystemError);
  });

  it("returns the requested run dir when given an explicit run id (T-FIND-4, UC-FIND-4)", async () => {
    const runId = "20260607-0001";
    await mkdir(join(runsDir, runId));
    // Also create a later run to prove the explicit id is honored, not "latest".
    await mkdir(join(runsDir, "20260607-0002"));
    const result = await findRun(runsDir, runId);
    expect(result).toBe(join(runsDir, runId));
  });

  it("throws FilesystemError when the explicit run id does not exist (T-FIND-5, UC-FIND-5)", async () => {
    await mkdir(join(runsDir, "20260607-0001"));
    await expect(findRun(runsDir, "does-not-exist")).rejects.toBeInstanceOf(
      FilesystemError,
    );
  });
});

// ---------------------------------------------------------------------------
// renderRunStatus
// ---------------------------------------------------------------------------

describe("renderRunStatus", () => {
  it("includes run_id, workflow, task, and created_at in the header (T-REND-1, UC-RENDER-1)", () => {
    const state = makeState({
      run_id: "20260607-0001",
      workflow: "code-change",
      task: "fix the encoding bug",
      created_at: FIXED_ISO,
    });
    const out = renderRunStatus(state, {});
    expect(out).toContain("20260607-0001");
    expect(out).toContain("code-change");
    expect(out).toContain("fix the encoding bug");
    expect(out).toContain(FIXED_ISO);
  });

  it("lists each job with its status, activation, and attempt (T-REND-2, UC-RENDER-2)", () => {
    const state = makeState({
      jobs: {
        intake: makeJob("ready"),
        "code-map": makeJob("waiting"),
        review: makeJob("inactive", { activation: "optional" }),
        implement: makeJob("running", { attempt: 2 }),
      },
    });
    const out = renderRunStatus(state, {});

    // Each job id appears.
    expect(out).toContain("intake");
    expect(out).toContain("code-map");
    expect(out).toContain("review");
    expect(out).toContain("implement");

    // Each status keyword appears.
    expect(out).toContain("ready");
    expect(out).toContain("waiting");
    expect(out).toContain("inactive");
    expect(out).toContain("running");

    // activation and attempt for the jobs that declare them.
    expect(out).toContain("optional");
    expect(out).toContain("2");
  });

  it("keeps status readable when a job id is wider than the default column", () => {
    const state = makeState({
      jobs: {
        "architecture-design": makeJob("inactive", { activation: "manual" }),
      },
    });

    const out = renderRunStatus(state, {});

    expect(out).toContain("architecture-design  inactive");
    expect(out).not.toContain("architecture-designinactive");
  });

  it("lists waiting jobs with their unfulfilled needs from workflowJobs (T-REND-3, UC-RENDER-3)", () => {
    const state = makeState({
      jobs: {
        intake: makeJob("ready"),
        "code-map": makeJob("ready"),
        plan: makeJob("waiting"),
      },
    });
    const workflowJobs: Record<string, { needs?: string[] }> = {
      intake: {},
      "code-map": { needs: ["intake"] },
      plan: { needs: ["intake", "code-map"] },
    };
    const out = renderRunStatus(state, workflowJobs);
    expect(out).toContain("plan");
    // Unfulfilled deps for the waiting `plan` job must be shown.
    expect(out).toContain("intake");
    expect(out).toContain("code-map");
  });

  it("emits a next-step suggestion that references a ready job id (T-REND-4, UC-RENDER-4)", () => {
    const state = makeState({
      jobs: {
        intake: makeJob("ready"),
        "code-map": makeJob("waiting"),
      },
    });
    const out = renderRunStatus(state, {});
    expect(out.toLowerCase()).toContain("next");
    // A zigma-flow command referencing the ready job id.
    expect(out).toContain("zigma-flow");
    expect(out).toContain("intake");
  });

  it("still emits a next-step section when there are no ready jobs (T-REND-5, UC-RENDER-5)", () => {
    const state = makeState({
      jobs: {
        review: makeJob("inactive", { activation: "optional" }),
        plan: makeJob("waiting"),
      },
    });
    const out = renderRunStatus(state, {
      review: {},
      plan: { needs: ["intake"] },
    });
    // We don't dictate the exact phrasing; just require a "next" section
    // and that the function does not throw and returns a non-empty string.
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
    expect(out.toLowerCase()).toContain("next");
  });
});

// ---------------------------------------------------------------------------
// statusAction (end-to-end against a real run directory)
// ---------------------------------------------------------------------------

describe("statusAction", () => {
  let tmpDir: string;
  let runsDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-status-action-test-${randomUUID()}`);
    runsDir = join(tmpDir, "runs");
    await mkdir(runsDir, { recursive: true });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("prints run header, job table, and next-step hint for the latest run (T-ACT-1, UC-ACTION-1)", async () => {
    const runId = "20260607-0001";
    const runDir = join(runsDir, runId);
    await mkdir(runDir);
    const state = makeState({
      run_id: runId,
      workflow: "code-change",
      task: "fix the encoding bug",
      jobs: {
        intake: makeJob("ready"),
        "code-map": makeJob("waiting"),
        review: makeJob("inactive", { activation: "optional" }),
      },
    });
    await writeState(runDir, state);

    await statusAction({}, runsDir);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain(runId);
    expect(printed).toContain("code-change");
    expect(printed).toContain("fix the encoding bug");
    expect(printed).toContain("intake");
    expect(printed).toContain("ready");
    expect(printed).toContain("waiting");
    expect(printed).toContain("inactive");
    expect(printed.toLowerCase()).toContain("next");
  });

  it("accepts --run <run_id> and prints that specific run (T-ACT-2, UC-ACTION-2)", async () => {
    // Two runs exist; ensure we pick the explicit (older) one, not "latest".
    const older = "20260607-0001";
    const newer = "20260607-0002";
    await mkdir(join(runsDir, older));
    await mkdir(join(runsDir, newer));
    await writeState(join(runsDir, older), makeState({ run_id: older }));
    await writeState(join(runsDir, newer), makeState({ run_id: newer }));

    await statusAction({ run: older }, runsDir);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = logSpy.mock.calls[0]?.[0] as string;
    expect(printed).toContain(older);
    expect(printed).not.toContain(newer);
  });

  it("throws FilesystemError when no runs exist (T-ACT-3, UC-ACTION-3)", async () => {
    await expect(statusAction({}, runsDir)).rejects.toBeInstanceOf(FilesystemError);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("throws FilesystemError when state.json is missing in the run dir (T-ACT-4, UC-ACTION-4)", async () => {
    const runId = "20260607-0001";
    await mkdir(join(runsDir, runId)); // run dir but no state.json
    await expect(statusAction({}, runsDir)).rejects.toBeInstanceOf(FilesystemError);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("throws FilesystemError when state.json contains malformed JSON (T-ACT-5, UC-ACTION-5)", async () => {
    const runId = "20260607-0001";
    const runDir = join(runsDir, runId);
    await mkdir(runDir);
    await writeFile(join(runDir, "state.json"), "{ not valid json", "utf-8");
    await expect(statusAction({}, runsDir)).rejects.toBeInstanceOf(FilesystemError);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
