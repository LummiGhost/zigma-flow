/**
 * Runtime metrics writer unit tests (Issue #286 Phase 2).
 *
 * Verifies the per-runDir AsyncQueue-serialized appendMetricsRecord behavior:
 * no lost writes, FIFO order, no interleaved/corrupted lines, optional-field
 * omission, drain and dispose semantics.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  appendMetricsRecord,
  drainMetricsWrites,
  disposeMetricsWriter,
} from "../../src/metrics/index.js";
import type { MetricsRecord } from "../../src/metrics/index.js";

const FIXED_ISO = "2026-06-08T00:00:00.000Z";

function makeRecord(overrides: Partial<MetricsRecord> = {}): MetricsRecord {
  return {
    timestamp: FIXED_ISO,
    run_id: "20260608-0001",
    workflow: "wf",
    job: "main",
    step: "analyze",
    attempt: 1,
    backend: "fake",
    duration_ms: 100,
    status: "completed",
    report_accepted: true,
    invocation_id: "evt-001",
    ...overrides,
  };
}

describe("metrics writer (Issue #286 Phase 2)", () => {
  let tmpDir: string;
  let runDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-metrics-${randomUUID()}`);
    runDir = join(tmpDir, "20260608-0001");
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await disposeMetricsWriter(runDir);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("appends records as valid JSONL lines with exact fields (T-METRICS-1)", async () => {
    await appendMetricsRecord(runDir, makeRecord());
    await appendMetricsRecord(runDir, makeRecord({ invocation_id: "evt-002" }));

    const text = await readFile(join(runDir, "metrics.jsonl"), "utf-8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as MetricsRecord;
    expect(first).toEqual(makeRecord());
    const second = JSON.parse(lines[1]!) as MetricsRecord;
    expect(second.invocation_id).toBe("evt-002");
  });

  it("omits optional keys entirely when absent (T-METRICS-2)", async () => {
    await appendMetricsRecord(runDir, makeRecord());
    await drainMetricsWrites(runDir);

    const text = await readFile(join(runDir, "metrics.jsonl"), "utf-8");
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
    expect("skill" in parsed).toBe(false);
    expect("model" in parsed).toBe(false);
    expect("cost_class" in parsed).toBe(false);
    expect("failure_kind" in parsed).toBe(false);
    expect("exit_code" in parsed).toBe(false);
  });

  it("round-trips a full record with all optional fields (T-METRICS-3)", async () => {
    const full = makeRecord({
      skill: "zigma/analyze-skill",
      model: "claude-haiku-4-5",
      cost_class: "low",
      status: "failed",
      failure_kind: "agent_error",
      exit_code: 2,
      report_accepted: false,
    });
    await appendMetricsRecord(runDir, full);
    await drainMetricsWrites(runDir);

    const text = await readFile(join(runDir, "metrics.jsonl"), "utf-8");
    expect(JSON.parse(text.trim())).toEqual(full);
  });

  it("serializes 100 concurrent appends — no loss, no interleaved lines (T-METRICS-4)", async () => {
    const COUNT = 100;
    const writes = Array.from({ length: COUNT }, (_, i) =>
      appendMetricsRecord(runDir, makeRecord({ invocation_id: `evt-${String(i).padStart(3, "0")}` }))
    );
    await Promise.all(writes);

    const text = await readFile(join(runDir, "metrics.jsonl"), "utf-8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(COUNT);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("disposeMetricsWriter releases the queue; later appends use a fresh queue (T-METRICS-5)", async () => {
    await appendMetricsRecord(runDir, makeRecord());
    await disposeMetricsWriter(runDir);

    await appendMetricsRecord(runDir, makeRecord({ invocation_id: "evt-after" }));
    await drainMetricsWrites(runDir);

    const text = await readFile(join(runDir, "metrics.jsonl"), "utf-8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1]!) as MetricsRecord).invocation_id).toBe("evt-after");
  });
});
