import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, test, expect, beforeEach, afterEach } from "vitest";

import { RunLogReader } from "../../src/logs/runLogReader.js";

async function writeState(dir: string, status?: string): Promise<void> {
  await writeFile(join(dir, "state.json"), JSON.stringify({ status }), "utf-8");
}

describe("RunLogReader", () => {
  let tmpDir: string;
  let runDir: string;
  const runId = "20260811-0001";

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "zigma-log-reader-"));
    runDir = join(tmpDir, runId);
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("readNext returns empty when file does not exist", async () => {
    const reader = new RunLogReader({ runDir, runId });
    const result = await reader.readNext();
    expect(result.records).toHaveLength(0);
    expect(result.reachedEnd).toBe(true);
  });

  test("readNext returns empty when file is empty", async () => {
    await writeFile(join(runDir, "run.log.jsonl"), "", "utf-8");
    const reader = new RunLogReader({ runDir, runId });
    const result = await reader.readNext();
    expect(result.records).toHaveLength(0);
    expect(result.reachedEnd).toBe(true);
  });

  test("readNext reads existing records", async () => {
    const logPath = join(runDir, "run.log.jsonl");
    const lines = [
      JSON.stringify({ id: 1, occurred_at: "2026-08-11T00:00:00.000Z", run_id: runId, job_id: null, step_id: null, attempt: null, stream: "system", text: "first" }),
      JSON.stringify({ id: 2, occurred_at: "2026-08-11T00:00:01.000Z", run_id: runId, job_id: "job-1", step_id: "step-a", attempt: 1, stream: "stdout", text: "output" }),
      JSON.stringify({ id: 3, occurred_at: "2026-08-11T00:00:02.000Z", run_id: runId, job_id: "job-1", step_id: "step-a", attempt: 1, stream: "stderr", text: "error" }),
    ].join("\n") + "\n";
    await writeFile(logPath, lines, "utf-8");

    const reader = new RunLogReader({ runDir, runId });
    const result = await reader.readNext();

    expect(result.records).toHaveLength(3);
    expect(result.records[0]!.id).toBe(1);
    expect(result.records[0]!.text).toBe("first");
    expect(result.records[1]!.id).toBe(2);
    expect(result.records[1]!.stream).toBe("stdout");
    expect(result.records[2]!.id).toBe(3);
    expect(result.records[2]!.stream).toBe("stderr");
    expect(result.offset).toBeGreaterThan(0);
    expect(result.reachedEnd).toBe(true);
  });

  test("readNext advances offset and detects no new data", async () => {
    const logPath = join(runDir, "run.log.jsonl");
    await writeFile(logPath, JSON.stringify({ id: 1, occurred_at: "2026-08-11T00:00:00.000Z", run_id: runId, job_id: null, step_id: null, attempt: null, stream: "system", text: "msg" }) + "\n", "utf-8");

    const reader = new RunLogReader({ runDir, runId });
    const r1 = await reader.readNext();
    expect(r1.records).toHaveLength(1);
    const offsetAfter = r1.offset;

    const r2 = await reader.readNext();
    expect(r2.records).toHaveLength(0);
    expect(r2.offset).toBe(offsetAfter);
  });

  test("readNext handles partial last line and re-reads on completion", async () => {
    const logPath = join(runDir, "run.log.jsonl");
    // Write a partial line (no newline)
    await writeFile(logPath, JSON.stringify({ id: 1, occurred_at: "2026-08-11T00:00:00.000Z", run_id: runId, job_id: null, step_id: null, attempt: null, stream: "system", text: "partial" }), "utf-8");

    const reader = new RunLogReader({ runDir, runId });

    // First read: partial line (no newline at end)
    const r1 = await reader.readNext();
    expect(r1.records).toHaveLength(0); // partial line, not consumed

    // Writer appends the newline
    await appendFile(logPath, "\n", "utf-8");

    // Second read: now the line is complete
    const r2 = await reader.readNext();
    expect(r2.records).toHaveLength(1);
    expect(r2.records[0]!.text).toBe("partial");
  });

  test("readNext resists corrupt lines", async () => {
    const logPath = join(runDir, "run.log.jsonl");
    await writeFile(logPath, [
      JSON.stringify({ id: 1, occurred_at: "2026-08-11T00:00:00.000Z", run_id: runId, job_id: null, step_id: null, attempt: null, stream: "system", text: "good" }),
      "this is not valid json",
      JSON.stringify({ id: 2, occurred_at: "2026-08-11T00:00:01.000Z", run_id: runId, job_id: null, step_id: null, attempt: null, stream: "system", text: "also good" }),
    ].join("\n") + "\n", "utf-8");

    const reader = new RunLogReader({ runDir, runId });
    const result = await reader.readNext();
    expect(result.records).toHaveLength(2); // corrupt line skipped
    expect(result.records[0]!.id).toBe(1);
    expect(result.records[1]!.id).toBe(2);
    expect(result.reachedEnd).toBe(true);
  });

  test("filtering by job", async () => {
    const logPath = join(runDir, "run.log.jsonl");
    await writeFile(logPath, [
      JSON.stringify({ id: 1, occurred_at: "2026-08-11T00:00:00.000Z", run_id: runId, job_id: "job-1", step_id: "step-a", attempt: 1, stream: "stdout", text: "a" }),
      JSON.stringify({ id: 2, occurred_at: "2026-08-11T00:00:01.000Z", run_id: runId, job_id: "job-2", step_id: "step-a", attempt: 1, stream: "stdout", text: "b" }),
      JSON.stringify({ id: 3, occurred_at: "2026-08-11T00:00:02.000Z", run_id: runId, job_id: "job-1", step_id: "step-b", attempt: 1, stream: "stdout", text: "c" }),
    ].join("\n") + "\n", "utf-8");

    const reader = new RunLogReader({ runDir, runId, jobId: "job-1" });
    const result = await reader.readNext();
    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.job_id).toBe("job-1");
    expect(result.records[1]!.job_id).toBe("job-1");
  });

  test("filtering by job and step", async () => {
    const logPath = join(runDir, "run.log.jsonl");
    await writeFile(logPath, [
      JSON.stringify({ id: 1, occurred_at: "2026-08-11T00:00:00.000Z", run_id: runId, job_id: "job-1", step_id: "step-a", attempt: 1, stream: "stdout", text: "a" }),
      JSON.stringify({ id: 2, occurred_at: "2026-08-11T00:00:01.000Z", run_id: runId, job_id: "job-1", step_id: "step-b", attempt: 1, stream: "stdout", text: "b" }),
    ].join("\n") + "\n", "utf-8");

    const reader = new RunLogReader({ runDir, runId, jobId: "job-1", stepId: "step-a" });
    const result = await reader.readNext();
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.step_id).toBe("step-a");
  });

  test("follow mode reads existing then new records", async () => {
    const logPath = join(runDir, "run.log.jsonl");
    // Pre-write one record, keep run as running (not terminal)
    await writeFile(logPath, JSON.stringify({ id: 1, occurred_at: "2026-08-11T00:00:00.000Z", run_id: runId, job_id: null, step_id: null, attempt: null, stream: "system", text: "existing" }) + "\n", "utf-8");
    await writeState(runDir, "running");

    const reader = new RunLogReader({ runDir, runId });
    const records: { id: number; text: string }[] = [];

    // Write another record AND change to completed after a short delay
    const writeLater = (async () => {
      await new Promise((r) => setTimeout(r, 80));
      await appendFile(logPath, JSON.stringify({ id: 2, occurred_at: "2026-08-11T00:00:01.000Z", run_id: runId, job_id: null, step_id: null, attempt: null, stream: "system", text: "new" }) + "\n", "utf-8");
      await writeState(runDir, "completed");
    })();

    let terminalStatus: string | undefined;
    await reader.follow(
      (record) => { records.push({ id: record.id, text: record.text }); },
      {
        pollMs: 20,
        onTerminal: (status) => { terminalStatus = status; },
      },
    );
    await writeLater;

    expect(records).toHaveLength(2);
    expect(records[0]!.text).toBe("existing");
    expect(records[1]!.text).toBe("new");
    expect(terminalStatus).toBe("completed");
  });

  test("follow exits when run becomes terminal", async () => {
    const logPath = join(runDir, "run.log.jsonl");
    // File exists but empty, run is already completed
    await writeFile(logPath, "", "utf-8");
    await writeState(runDir, "failed");

    const reader = new RunLogReader({ runDir, runId });
    let terminalStatus: string | undefined;

    await reader.follow(
      () => {},
      {
        pollMs: 10,
        onTerminal: (status) => { terminalStatus = status; },
      },
    );

    expect(terminalStatus).toBe("failed");
  });

  test("follow continues on non-terminal run (blocked)", async () => {
    const logPath = join(runDir, "run.log.jsonl");
    // Pre-write one record
    await writeFile(logPath, JSON.stringify({ id: 1, occurred_at: "2026-08-11T00:00:00.000Z", run_id: runId, job_id: null, step_id: null, attempt: null, stream: "system", text: "started" }) + "\n", "utf-8");
    await writeState(runDir, "blocked"); // blocked is not terminal

    const reader = new RunLogReader({ runDir, runId });
    const records: { id: number; text: string }[] = [];

    // Write more records during follow, but keep state as blocked (non-terminal)
    const writeLater = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      await appendFile(logPath, JSON.stringify({ id: 2, occurred_at: "2026-08-11T00:00:01.000Z", run_id: runId, job_id: null, step_id: null, attempt: null, stream: "system", text: "waiting" }) + "\n", "utf-8");
      // We'll abort after giving it time to pick up the second record
    })();

    const controller = new AbortController();
    const followPromise = reader.follow(
      (record) => { records.push({ id: record.id, text: record.text }); },
      { pollMs: 15, signal: controller.signal },
    );

    // Wait for records to be picked up
    await new Promise((r) => setTimeout(r, 120));
    controller.abort();
    await followPromise;
    await writeLater;

    // Should have read at least the pre-written record
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records[0]!.text).toBe("started");
  });
});
