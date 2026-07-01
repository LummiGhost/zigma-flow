/**
 * Tests for the `artifacts` command (WF-V022-DIAGNOSTIC Step 1 — Cases and Tests).
 *
 * Exercises the new CLI handler that powers `zigma-flow artifacts [run-id]`.
 * It reads `artifacts.jsonl` from the requested (or latest) run directory
 * and prints each artifact in tabular form:
 *
 *   `<id>  <kind>  <path>  <size>`
 *
 * The `--job <id>` filter narrows output to artifacts produced by the named
 * job (matched against `producer.job` on each artifact metadata entry).
 *
 * Exit contract:
 *   - Command returns exit code 0 on success even when the artifact index
 *     is empty.
 *   - Missing `artifacts.jsonl` inside an existing run directory is treated
 *     as an empty index (exit 0, no output rows besides an optional header).
 *   - A missing run directory itself is signaled either by a thrown
 *     ZigmaFlowError or a stderr message.
 *
 * Red-phase note: `src/commands/artifacts.ts` does not yet exist; tests
 * will fail to compile until WF-V022-DIAGNOSTIC Step 2 ships the module.
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
// `src/commands/artifacts.ts` exporting `artifactsAction` and `ArtifactsOptions`.
import {
  artifactsAction,
  type ArtifactsOptions,
} from "../../src/commands/artifacts.js";

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
 * Build an ArtifactsOptions wired up to capture stdout/stderr. Mirrors the
 * CLI shape: caller supplies `runDir` OR `runsDir` (+ optional `runId`),
 * plus an optional `job` filter.
 */
function makeOpts(
  captured: CapturedOutput,
  extra: Partial<ArtifactsOptions> = {},
): ArtifactsOptions {
  return {
    stdout: (line: string) => {
      captured.stdout.push(line);
    },
    stderr: (line: string) => {
      captured.stderr.push(line);
    },
    ...extra,
  } as ArtifactsOptions;
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

async function stagedFixture(fixtureDir: string): Promise<string> {
  const dest = join(tmpdir(), `zigma-artifacts-${randomUUID()}`);
  await mkdir(dest, { recursive: true });
  await cp(fixtureDir, dest, { recursive: true });
  tempDirs.push(dest);
  return dest;
}

/**
 * Count how many stdout lines match a job id. We look for the job token
 * inside the artifact id or path so the assertion works regardless of
 * whether the implementation prints the producer job as a dedicated
 * column or embeds it in the artifact id/path.
 */
function countLinesMentioning(captured: CapturedOutput, token: string): number {
  return captured.stdout.filter((line) => line.includes(token)).length;
}

// ---------------------------------------------------------------------------
// UC-AR-1 — default output: lists every artifact with the required columns
// ---------------------------------------------------------------------------

describe("artifactsAction — default output (UC-AR-1)", () => {
  it("prints one row per artifact when no filter is provided (T-AR-001)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    const captured = makeCaptured();

    await artifactsAction(makeOpts(captured, { runDir }));

    // 3 artifacts in fixture. We do not lock down whether a header row is
    // printed, but the three artifact ids must each appear on some line.
    const out = joinedStdout(captured);
    expect(out).toContain("intake/attempts/1/steps/intake/stdout");
    expect(out).toContain("intake/attempts/1/steps/intake/report");
    expect(out).toContain("implement/attempts/1/steps/impl-step/stdout");
  });

  it("each row surfaces id, kind, path, and size columns (T-AR-002)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    const captured = makeCaptured();

    await artifactsAction(makeOpts(captured, { runDir }));

    const out = joinedStdout(captured);
    // kind values from the fixture.
    expect(out).toContain("agent_stdout");
    expect(out).toContain("agent_report");
    // path values from the fixture.
    expect(out).toContain("jobs/intake/attempts/1/steps/intake/stdout.txt");
    expect(out).toContain("jobs/intake/attempts/1/steps/intake/report.json");
    expect(out).toContain("jobs/implement/attempts/1/steps/impl-step/stdout.txt");
    // size values from the fixture (as raw digits — implementation may
    // right-align or format, but the number itself must appear).
    expect(out).toContain("42");
    expect(out).toContain("128");
    expect(out).toContain("256");
  });
});

// ---------------------------------------------------------------------------
// UC-AR-2 — --job filter narrows to artifacts produced by a single job
// ---------------------------------------------------------------------------

describe("artifactsAction — --job filter (UC-AR-2)", () => {
  it("keeps only artifacts produced by the requested job (T-AR-010)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    const captured = makeCaptured();

    await artifactsAction(makeOpts(captured, { runDir, job: "intake" }));

    const out = joinedStdout(captured);
    // Both intake artifacts must appear.
    expect(out).toContain("intake/attempts/1/steps/intake/stdout");
    expect(out).toContain("intake/attempts/1/steps/intake/report");
    // The implement artifact must NOT appear.
    expect(out).not.toContain("implement/attempts/1/steps/impl-step/stdout");

    // Row count: 2 rows contain the token "intake/attempts".
    expect(countLinesMentioning(captured, "intake/attempts")).toBe(2);
  });

  it("prints nothing (no data rows) when the job filter matches zero artifacts (T-AR-011)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    const captured = makeCaptured();

    await artifactsAction(makeOpts(captured, { runDir, job: "no-such-job" }));

    // No line should mention any artifact from the fixture.
    expect(countLinesMentioning(captured, "intake/attempts")).toBe(0);
    expect(countLinesMentioning(captured, "implement/attempts")).toBe(0);
  });

  it("filter narrows to a job that has exactly one artifact (T-AR-012)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    const captured = makeCaptured();

    await artifactsAction(makeOpts(captured, { runDir, job: "implement" }));

    const out = joinedStdout(captured);
    expect(out).toContain("implement/attempts/1/steps/impl-step/stdout");
    // Intake artifacts must NOT appear.
    expect(out).not.toContain("intake/attempts/1/steps/intake/stdout");
    expect(out).not.toContain("intake/attempts/1/steps/intake/report");

    expect(countLinesMentioning(captured, "implement/attempts")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// UC-AR-3 — missing/empty inputs are handled gracefully
// ---------------------------------------------------------------------------

describe("artifactsAction — graceful missing/empty inputs (UC-AR-3)", () => {
  it("treats a missing artifacts.jsonl inside an existing run dir as an empty index (T-AR-020)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    await rm(join(runDir, "artifacts.jsonl"));

    const captured = makeCaptured();
    await expect(
      artifactsAction(makeOpts(captured, { runDir })),
    ).resolves.not.toThrow();

    // No artifact ids should appear.
    expect(countLinesMentioning(captured, "intake/attempts")).toBe(0);
    expect(countLinesMentioning(captured, "implement/attempts")).toBe(0);
  });

  it("treats an empty artifacts.jsonl as an empty index (T-AR-021)", async () => {
    const runDir = await stagedFixture(DIAGNOSTIC_RUN_FIXTURE);
    await writeFile(join(runDir, "artifacts.jsonl"), "", "utf-8");

    const captured = makeCaptured();
    await expect(
      artifactsAction(makeOpts(captured, { runDir })),
    ).resolves.not.toThrow();

    expect(countLinesMentioning(captured, "intake/attempts")).toBe(0);
    expect(countLinesMentioning(captured, "implement/attempts")).toBe(0);
  });

  it("reports a clear error when the run directory itself does not exist (T-AR-022)", async () => {
    const bogusRunDir = join(
      tmpdir(),
      `zigma-artifacts-missing-${randomUUID()}`,
    );

    const captured = makeCaptured();
    let threw = false;
    try {
      await artifactsAction(makeOpts(captured, { runDir: bogusRunDir }));
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
// UC-AR-4 — runId resolution against a runs dir
// ---------------------------------------------------------------------------

describe("artifactsAction — runsDir + runId resolution (UC-AR-4)", () => {
  it("resolves runsDir + runId when runDir is not provided (T-AR-030)", async () => {
    const runsDir = join(tmpdir(), `zigma-artifacts-runs-${randomUUID()}`);
    const runId = "20260701-0007";
    const runDir = join(runsDir, runId);
    await mkdir(runDir, { recursive: true });
    await cp(DIAGNOSTIC_RUN_FIXTURE, runDir, { recursive: true });
    tempDirs.push(runsDir);

    const captured = makeCaptured();
    await artifactsAction(makeOpts(captured, { runsDir, runId }));

    const out = joinedStdout(captured);
    expect(out).toContain("intake/attempts/1/steps/intake/stdout");
    expect(out).toContain("implement/attempts/1/steps/impl-step/stdout");
  });

  it("resolves the latest run when neither runId nor runDir is provided (T-AR-031)", async () => {
    const runsDir = join(tmpdir(), `zigma-artifacts-latest-${randomUUID()}`);
    await mkdir(runsDir, { recursive: true });
    tempDirs.push(runsDir);

    const olderRun = join(runsDir, "20260630-0001");
    const newerRun = join(runsDir, "20260701-0007");
    await mkdir(olderRun, { recursive: true });
    await cp(DIAGNOSTIC_RUN_FIXTURE, newerRun, { recursive: true });
    // Older run has an artifacts.jsonl with a marker id that must NOT
    // show up when the command picks the newer run.
    await writeFile(
      join(olderRun, "artifacts.jsonl"),
      JSON.stringify({
        id: "artifact://OLD-RUN/marker",
        run_id: "20260630-0001",
        producer: { job: "old-job", step: "old-step", attempt: 1 },
        kind: "marker",
        path: "old.txt",
        content_type: "text/plain",
        size: 1,
        summary: "old",
        created_at: "2026-06-30T00:00:00.000Z",
      }) + "\n",
      "utf-8",
    );

    const captured = makeCaptured();
    await artifactsAction(makeOpts(captured, { runsDir }));

    const out = joinedStdout(captured);
    expect(out).toContain("intake/attempts/1/steps/intake/stdout");
    expect(out).not.toContain("OLD-RUN");
  });
});
