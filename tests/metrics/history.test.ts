/**
 * Model-history aggregation tests (Issue #286 Phase 3).
 *
 * Exercises `loadModelHistory`, `makeTaskClassKey`, and
 * `createModelHistoryStore` against seeded run directories:
 *
 *   - T-HIST-1: missing / empty runsDir → empty history, never rejects.
 *   - T-HIST-2: per-(job, skill, model) grouping and counts.
 *   - T-HIST-3..5: exclusion rules — no skill, no model, cancelled.
 *   - T-HIST-6: tolerance — garbage lines, dirs without metrics.jsonl,
 *               stray files, malformed records.
 *   - T-HIST-7: task-class key isolation across jobs/skills.
 *   - T-HIST-8: store caching / forced refresh / single-flight.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  createModelHistoryStore,
  loadModelHistory,
  loadModelHistoryRows,
  makeTaskClassKey,
  type ModelHistory,
} from "../../src/metrics/history.js";
import type { ModelHistoryStats } from "../../src/agent/model-router.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/**
 * Seed one run directory with a metrics.jsonl file. `lines` are written
 * verbatim as JSONL (one JSON record per line) — the same shape
 * `appendMetricsRecord` produces. Mirrors the `seedRun` precedent in
 * tests/commands/list-runs.test.ts.
 */
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

/** A well-formed metrics line; only the fields the aggregator consumes matter. */
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
    duration_ms: 1234,
    status: "completed",
    report_accepted: true,
    invocation_id: "evt-001",
    ...overrides,
  };
}

function statsFor(
  history: ModelHistory,
  jobId: string,
  skill: string,
  model: string,
): ModelHistoryStats | undefined {
  return history.get(makeTaskClassKey(jobId, skill))?.get(model);
}

// ---------------------------------------------------------------------------
// Phase 4 AAC proxy cost expectations
// ---------------------------------------------------------------------------

// The `line()` fixture defaults to cost_class "low" (weight 1) and
// duration_ms 1234, so every folded record contributes 1 × 1234 = 1234
// proxy cost units.
const UNITS_PER_RECORD = 1234;

const EMPTY_STATS = {
  samples: 0,
  accepted: 0,
  retried: 0,
  execution_cost: 0,
  retry_overhead: 0,
  rework_overhead: 0,
};

describe("loadModelHistory — aggregation", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = join(tmpdir(), `zigma-history-${randomUUID()}`);
    await mkdir(runsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  it("returns an empty history for a missing runsDir and never rejects (T-HIST-1)", async () => {
    const missing = join(runsDir, "does-not-exist");
    const history = await loadModelHistory(missing);
    expect(history.size).toBe(0);
  });

  it("returns an empty history for an empty runsDir (T-HIST-1)", async () => {
    const history = await loadModelHistory(runsDir);
    expect(history.size).toBe(0);
  });

  it("groups by (job, skill, model) and counts samples/accepted/retried (T-HIST-2)", async () => {
    await seedMetricsRun(runsDir, "seed-1", [
      line({ run_id: "seed-1", attempt: 1, model: "m1", report_accepted: true }),
      line({ run_id: "seed-1", attempt: 2, model: "m1", report_accepted: true }),
      line({ run_id: "seed-1", attempt: 3, model: "m1", report_accepted: false }),
      line({ run_id: "seed-1", attempt: 1, model: "m2", report_accepted: true }),
    ]);
    await seedMetricsRun(runsDir, "seed-2", [
      line({ run_id: "seed-2", attempt: 1, model: "m1", report_accepted: true }),
    ]);

    const history = await loadModelHistory(runsDir);
    expect(history.size).toBe(1);

    // m1: 4 records across two runs; attempts 2 and 3 are retry evidence.
    // Phase 4 cost units: 4 × 1234 execution, attempts 2+3 retry overhead
    // (2 × 1234), attempt 3 rejected → rework overhead (1 × 1234).
    expect(statsFor(history, "main", "zigma/analyze-skill", "m1")).toEqual({
      samples: 4,
      accepted: 3,
      retried: 2,
      execution_cost: 4 * UNITS_PER_RECORD,
      retry_overhead: 2 * UNITS_PER_RECORD,
      rework_overhead: UNITS_PER_RECORD,
    });
    expect(statsFor(history, "main", "zigma/analyze-skill", "m2")).toEqual({
      samples: 1,
      accepted: 1,
      retried: 0,
      execution_cost: UNITS_PER_RECORD,
      retry_overhead: 0,
      rework_overhead: 0,
    });
  });

  it("excludes records without a skill (T-HIST-3)", async () => {
    const noSkillA = { ...line({ model: "m1" }) };
    delete (noSkillA as Record<string, unknown>)["skill"];
    const noSkillB = { ...line({ model: "m1" }) };
    delete (noSkillB as Record<string, unknown>)["skill"];
    await seedMetricsRun(runsDir, "seed-1", [noSkillA]);
    await seedMetricsRun(runsDir, "seed-2", [noSkillB]);

    const history = await loadModelHistory(runsDir);
    expect(history.size).toBe(0);
  });

  it("excludes records without a model (T-HIST-4)", async () => {
    const noModel = { ...line({}) };
    delete (noModel as Record<string, unknown>)["model"];
    await seedMetricsRun(runsDir, "seed-1", [noModel, line({ model: "m1" })]);

    const history = await loadModelHistory(runsDir);
    const stats = statsFor(history, "main", "zigma/analyze-skill", "m1");
    expect(stats?.samples).toBe(1);
  });

  it("excludes cancelled records; counts failed report-validation records (T-HIST-5)", async () => {
    await seedMetricsRun(runsDir, "seed-1", [
      line({ model: "m1", status: "cancelled", report_accepted: false }),
      // Phase 2 report-validation failure: execution happened, report
      // rejected — exit_code 0 distinguishes it from backend failures.
      line({
        model: "m1",
        status: "failed",
        exit_code: 0,
        report_accepted: false,
      }),
      line({ model: "m1", status: "timed_out", report_accepted: false }),
    ]);

    const history = await loadModelHistory(runsDir);
    const stats = statsFor(history, "main", "zigma/analyze-skill", "m1");
    // Both counted records were rejected at the report gate → their cost
    // units are charged again as rework overhead.
    expect(stats).toEqual({
      samples: 2,
      accepted: 0,
      retried: 0,
      execution_cost: 2 * UNITS_PER_RECORD,
      retry_overhead: 0,
      rework_overhead: 2 * UNITS_PER_RECORD,
    });
  });

  it("tolerates garbage lines, dirs without metrics.jsonl, stray files, and malformed records (T-HIST-6)", async () => {
    await seedMetricsRun(runsDir, "seed-1", [line({ model: "m1" })]);
    await writeFile(
      join(runsDir, "seed-1", "metrics.jsonl"),
      JSON.stringify(line({ model: "m1" })) + "\n",
      { flag: "a", encoding: "utf-8" },
    );
    await writeFile(
      join(runsDir, "seed-1", "metrics.jsonl"),
      '{"torn": ',
      { flag: "a", encoding: "utf-8" },
    );

    // Dir without metrics.jsonl at all.
    await mkdir(join(runsDir, "seed-empty"), { recursive: true });

    // A stray FILE inside runsDir (not a directory).
    await writeFile(join(runsDir, "stray.txt"), "not a run", "utf-8");

    // Malformed records: missing attempt / missing report_accepted.
    await seedMetricsRun(runsDir, "seed-2", [
      line({ model: "m2" }),
      { ...line({ model: "m2", attempt: undefined as unknown }) },
      { ...line({ model: "m2", report_accepted: "yes" as unknown }) },
      { ...line({ model: "m2", attempt: 0 }) },
    ]);

    const history = await loadModelHistory(runsDir);
    // seed-1: the original line plus the appended duplicate — the torn
    // garbage line is skipped.
    expect(statsFor(history, "main", "zigma/analyze-skill", "m1")?.samples).toBe(2);
    expect(statsFor(history, "main", "zigma/analyze-skill", "m2")?.samples).toBe(1);
    expect(history.size).toBe(1);
  });

  it("isolates task classes by job and skill (T-HIST-7)", async () => {
    await seedMetricsRun(runsDir, "seed-1", [
      line({ job: "job-a", skill: "skill-x", model: "m1" }),
      line({ job: "job-a", skill: "skill-y", model: "m1" }),
      line({ job: "job-b", skill: "skill-x", model: "m1" }),
    ]);

    const history = await loadModelHistory(runsDir);
    expect(history.size).toBe(3);
    expect(makeTaskClassKey("job-a", "skill-x")).toBe(
      makeTaskClassKey("job-a", "skill-x"),
    );
    expect(makeTaskClassKey("job-a", "skill-x")).not.toBe(
      makeTaskClassKey("job-b", "skill-x"),
    );
    expect(makeTaskClassKey("job-a", "skill-x")).not.toBe(
      makeTaskClassKey("job-a", "skill-y"),
    );
    expect(statsFor(history, "job-a", "skill-x", "m1")?.samples).toBe(1);
  });
});

describe("createModelHistoryStore — caching, refresh, single-flight", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = join(tmpdir(), `zigma-history-store-${randomUUID()}`);
    await mkdir(runsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  it("caches after first load and re-scans on force (T-HIST-8)", async () => {
    await seedMetricsRun(runsDir, "seed-a", [line({ model: "m1" })]);
    const store = createModelHistoryStore(runsDir);

    const first = await store.get();
    expect(statsFor(first, "main", "zigma/analyze-skill", "m1")?.samples).toBe(1);

    // A run seeded after the first load is invisible to cached gets...
    await seedMetricsRun(runsDir, "seed-b", [line({ model: "m1" })]);
    const cached = await store.get();
    expect(statsFor(cached, "main", "zigma/analyze-skill", "m1")?.samples).toBe(1);

    // ...and visible after a forced refresh.
    const refreshed = await store.get(true);
    expect(statsFor(refreshed, "main", "zigma/analyze-skill", "m1")?.samples).toBe(2);
  });

  it("shares one in-flight scan across concurrent gets (T-HIST-8)", async () => {
    const store = createModelHistoryStore(runsDir);
    const p1 = store.get();
    const p2 = store.get();
    const p3 = store.get();

    // All three promises resolve to the SAME history object — one shared
    // scan (single-flight).
    const [h1, h2, h3] = await Promise.all([p1, p2, p3]);
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);

    // The cache persists: a subsequent non-forced get still returns the
    // same object, while a forced re-scan picks up runs seeded after the
    // first load.
    await seedMetricsRun(runsDir, "seed-late", [line({ model: "m1" })]);
    expect(await store.get()).toBe(h1);
    const refreshed = await store.get(true);
    expect(statsFor(refreshed, "main", "zigma/analyze-skill", "m1")?.samples).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 (Issue #286): AAC proxy cost accumulation + report rows
// ---------------------------------------------------------------------------

describe("loadModelHistory — Phase 4 AAC proxy cost accumulation", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = join(tmpdir(), `zigma-history-aac-${randomUUID()}`);
    await mkdir(runsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  it("accumulates execution, retry, and rework proxy cost units (T-AAC-1)", async () => {
    await seedMetricsRun(runsDir, "seed-1", [
      // accepted, attempt 1, medium (weight 2), 500 ms → 1000 units.
      line({ model: "m1", cost_class: "medium", duration_ms: 500 }),
      // rejected, attempt 2, medium → exec 1000 + retry 1000 + rework 1000.
      line({
        model: "m1",
        cost_class: "medium",
        duration_ms: 500,
        attempt: 2,
        report_accepted: false,
      }),
    ]);

    const history = await loadModelHistory(runsDir);
    expect(statsFor(history, "main", "zigma/analyze-skill", "m1")).toEqual({
      samples: 2,
      accepted: 1,
      retried: 1,
      execution_cost: 2000,
      retry_overhead: 1000,
      rework_overhead: 1000,
    });
  });

  it("weights cost classes (low=1, medium=2, high=4) and defaults missing classes to high (T-AAC-2)", async () => {
    await seedMetricsRun(runsDir, "seed-1", [
      line({ model: "m-low", cost_class: "low", duration_ms: 100 }),
      line({ model: "m-medium", cost_class: "medium", duration_ms: 100 }),
      line({ model: "m-high", cost_class: "high", duration_ms: 100 }),
    ]);
    const noClass = { ...line({ model: "m-missing", duration_ms: 100 }) };
    delete (noClass as Record<string, unknown>)["cost_class"];
    await seedMetricsRun(runsDir, "seed-2", [noClass]);

    const history = await loadModelHistory(runsDir);
    expect(statsFor(history, "main", "zigma/analyze-skill", "m-low")?.execution_cost).toBe(100);
    expect(statsFor(history, "main", "zigma/analyze-skill", "m-medium")?.execution_cost).toBe(200);
    expect(statsFor(history, "main", "zigma/analyze-skill", "m-high")?.execution_cost).toBe(400);
    expect(statsFor(history, "main", "zigma/analyze-skill", "m-missing")?.execution_cost).toBe(400);
  });

  it("treats a missing or malformed duration_ms as zero cost units (T-AAC-3)", async () => {
    await seedMetricsRun(runsDir, "seed-1", [
      { ...line({ model: "m1", duration_ms: undefined as unknown }) },
      { ...line({ model: "m1", duration_ms: -5 }) },
      { ...line({ model: "m1", duration_ms: "fast" as unknown }) },
      line({ model: "m1", duration_ms: 250 }),
    ]);

    const history = await loadModelHistory(runsDir);
    const stats = statsFor(history, "main", "zigma/analyze-skill", "m1");
    expect(stats?.samples).toBe(4);
    // Only the well-formed 250 ms record contributes units (low × 250).
    expect(stats?.execution_cost).toBe(250);
  });
});

describe("loadModelHistoryRows — Phase 4 report rows", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = join(tmpdir(), `zigma-history-rows-${randomUUID()}`);
    await mkdir(runsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  it("flattens the aggregation into (job, skill, model) rows with the same counts and costs (T-AAC-4)", async () => {
    await seedMetricsRun(runsDir, "seed-1", [
      line({ job: "job-b", skill: "skill-y", model: "m2", duration_ms: 10 }),
      line({ job: "job-a", skill: "skill-x", model: "m1" }),
    ]);

    const rows = await loadModelHistoryRows(runsDir);
    expect(rows).toEqual([
      {
        job: "job-a",
        skill: "skill-x",
        model: "m1",
        stats: {
          samples: 1,
          accepted: 1,
          retried: 0,
          execution_cost: UNITS_PER_RECORD,
          retry_overhead: 0,
          rework_overhead: 0,
        },
      },
      {
        job: "job-b",
        skill: "skill-y",
        model: "m2",
        stats: {
          samples: 1,
          accepted: 1,
          retried: 0,
          execution_cost: 10,
          retry_overhead: 0,
          rework_overhead: 0,
        },
      },
    ]);
  });

  it("returns no rows for a missing runsDir and never rejects (T-AAC-5)", async () => {
    const rows = await loadModelHistoryRows(join(runsDir, "does-not-exist"));
    expect(rows).toEqual([]);
  });
});
