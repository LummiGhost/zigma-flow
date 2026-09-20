/**
 * `zigma-flow model-history` CLI command tests (Issue #286 Phase 4).
 *
 * Exercises the inspect/report acceptance criterion: per-task-class
 * per-model acceptance and Accepted Artifact Cost stats aggregated from
 * runs/<id>/metrics.jsonl.
 *
 * Covers:
 *   - T-MH-1: rows are grouped by task class and show acceptance counts
 *             and AAC figures computed with the same proxy model the
 *             router uses.
 *   - T-MH-2: missing / empty runs directory → "No metrics history
 *             found." and does not throw.
 *   - T-MH-3: --json emits the machine-readable contract with exact AAC
 *             figures.
 *   - T-MH-4: malformed metrics content is tolerated (total scan).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { modelHistoryAction } from "../../src/commands/model-history.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  runsDir: string;
}

async function makeSandbox(opts: { createRunsDir?: boolean } = {}): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-model-history-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");

  await mkdir(dotZigma, { recursive: true });
  if (opts.createRunsDir !== false) {
    await mkdir(runsDir, { recursive: true });
  }

  return { projectRoot, zigmaflowDir: projectRoot, runsDir };
}

/** Seed one run dir with a metrics.jsonl (records share job/skill/model via overrides). */
async function seedMetricsRun(
  runsDir: string,
  runId: string,
  lines: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  const runDir = join(runsDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "metrics.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

function line(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: "2026-09-13T00:00:00.000Z",
    run_id: "seed-run",
    workflow: "wf",
    job: "main",
    step: "analyze",
    attempt: 1,
    skill: "zigma/analyze-skill",
    backend: "fake",
    model: "claude-haiku-4-5",
    cost_class: "low",
    duration_ms: 1000,
    status: "completed",
    report_accepted: true,
    invocation_id: "evt-001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("modelHistoryAction", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("reports per-task-class per-model acceptance and AAC figures (T-MH-1)", async () => {
    // m1: 10 accepted, 1000 units each → exec 10000 → AAC 1000.
    await seedMetricsRun(sandbox.runsDir, "seed-1", [
      ...Array.from({ length: 10 }, () => line({ model: "m1", duration_ms: 1000 })),
      // m2: 5 accepted + 5 rejected, 100 units each → exec 1000 + rework
      // 500 = delivered 1500 → AAC 300.
      ...Array.from({ length: 5 }, () => line({ model: "m2", duration_ms: 100 })),
      ...Array.from({ length: 5 }, () =>
        line({ model: "m2", duration_ms: 100, report_accepted: false })),
    ]);

    const out: string[] = [];
    const rows = await modelHistoryAction({
      zigmaflowDir: sandbox.zigmaflowDir,
      stdout: (l) => out.push(l),
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      job: "main",
      skill: "zigma/analyze-skill",
      model: "m1",
      samples: 10,
      accepted: 10,
      aac: 1000,
      delivered_cost: 10000,
    });
    expect(rows[1]).toMatchObject({
      model: "m2",
      samples: 10,
      accepted: 5,
      aac: 300,
      delivered_cost: 1500,
      execution_cost: 1000,
      rework_overhead: 500,
    });

    expect(out[0]).toBe("Task class: main / zigma/analyze-skill");
    expect(out[1]).toContain("m1");
    expect(out[1]).toContain("samples=10");
    expect(out[1]).toContain("accepted=10 (100.0%)");
    expect(out[1]).toContain("aac=1000.00");
    expect(out[2]).toContain("m2");
    expect(out[2]).toContain("accepted=5 (50.0%)");
    expect(out[2]).toContain("aac=300.00");
    expect(out[2]).toContain("rework-ovh=500.00");
  });

  it("prints a friendly empty message for a missing or empty runs directory (T-MH-2)", async () => {
    const out: string[] = [];
    const rows = await modelHistoryAction({
      zigmaflowDir: sandbox.zigmaflowDir,
      stdout: (l) => out.push(l),
    });

    expect(rows).toEqual([]);
    expect(out).toEqual(["No metrics history found."]);
  });

  it("emits the machine-readable JSON contract (T-MH-3)", async () => {
    await seedMetricsRun(sandbox.runsDir, "seed-1", [
      line({ model: "m1", duration_ms: 500 }),
      line({ model: "m1", duration_ms: 500, attempt: 2 }),
      line({ model: "m1", duration_ms: 500, report_accepted: false }),
    ]);

    const out: string[] = [];
    const rows = await modelHistoryAction({
      zigmaflowDir: sandbox.zigmaflowDir,
      json: true,
      stdout: (l) => out.push(l),
    });

    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!) as {
      contractVersion: number;
      command: string;
      rows: Array<Record<string, unknown>>;
    };
    expect(parsed.contractVersion).toBe(1);
    expect(parsed.command).toBe("model-history");
    expect(parsed.rows).toHaveLength(1);
    // exec 1500 + retry 500 + rework 500 = delivered 2500; accepted 2 →
    // AAC 1250.
    expect(parsed.rows[0]).toMatchObject({
      model: "m1",
      samples: 3,
      accepted: 2,
      retried: 1,
      execution_cost: 1500,
      retry_overhead: 500,
      rework_overhead: 500,
      delivered_cost: 2500,
      aac: 1250,
    });
    expect(rows[0]!.aac).toBe(1250);
  });

  it("tolerates malformed metrics content and never rejects (T-MH-4)", async () => {
    await seedMetricsRun(sandbox.runsDir, "seed-1", [
      line({ model: "m1" }),
    ]);
    await writeFile(
      join(sandbox.runsDir, "seed-1", "metrics.jsonl"),
      '{"torn": ',
      { flag: "a", encoding: "utf-8" },
    );

    const out: string[] = [];
    const rows = await modelHistoryAction({
      zigmaflowDir: sandbox.zigmaflowDir,
      stdout: (l) => out.push(l),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.samples).toBe(1);
  });
});
