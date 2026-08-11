import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vitest";

import { RunLogWriter } from "../../src/logs/runLogWriter.js";

describe("RunLogWriter", () => {
  let tmpDir: string;
  let runDir: string;
  const runId = "20260811-0001";

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "zigma-log-writer-"));
    runDir = join(tmpDir, runId);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("writes a system log record", async () => {
    const writer = RunLogWriter.forRun(runDir, runId);
    const id = await writer.writeSystem("Run started");

    expect(id).toBe(1);
    expect(writer.lastId).toBe(1);

    const content = await readFile(join(runDir, "run.log.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!);
    expect(record.id).toBe(1);
    expect(record.run_id).toBe(runId);
    expect(record.stream).toBe("system");
    expect(record.text).toBe("Run started");
    expect(record.job_id).toBeNull();
    expect(record.step_id).toBeNull();
    expect(record.attempt).toBeNull();
    expect(typeof record.occurred_at).toBe("string");
  });

  test("writes stdout/stderr records with attribution", async () => {
    const writer = RunLogWriter.forRun(runDir, runId);

    await writer.write({
      job_id: "job-1",
      step_id: "step-a",
      attempt: 1,
      stream: "stdout",
      text: "hello world\n",
    });

    await writer.write({
      job_id: "job-1",
      step_id: "step-a",
      attempt: 1,
      stream: "stderr",
      text: "warning: something\n",
    });

    const content = await readFile(join(runDir, "run.log.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const r1 = JSON.parse(lines[0]!);
    expect(r1.id).toBe(1);
    expect(r1.stream).toBe("stdout");
    expect(r1.job_id).toBe("job-1");
    expect(r1.step_id).toBe("step-a");
    expect(r1.attempt).toBe(1);
    expect(r1.text).toBe("hello world\n");

    const r2 = JSON.parse(lines[1]!);
    expect(r2.id).toBe(2);
    expect(r2.stream).toBe("stderr");
    expect(r2.job_id).toBe("job-1");
    expect(r2.text).toBe("warning: something\n");
  });

  test("monotonically increasing IDs", async () => {
    const writer = RunLogWriter.forRun(runDir, runId);

    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(await writer.write({ stream: "system", text: `msg ${i}` }));
    }

    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(writer.lastId).toBe(10);
  });

  test("concurrent writes are serialized", async () => {
    const writer = RunLogWriter.forRun(runDir, runId);

    // Fire 20 concurrent writes — IDs must still be monotonic
    const promises = Array.from({ length: 20 }, (_, i) =>
      writer.write({ stream: "system", text: `concurrent ${i}` }),
    );

    const ids = await Promise.all(promises);
    // IDs may not be in call order, but all 1–20 must be present
    ids.sort((a, b) => a - b);
    const expected = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(ids).toEqual(expected);

    // Verify on disk
    const content = await readFile(join(runDir, "run.log.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(20);

    const recordIds = lines.map((l) => (JSON.parse(l) as { id: number }).id).sort((a, b) => a - b);
    expect(recordIds).toEqual(expected);
  });

  test("singleton per run directory", () => {
    const w1 = RunLogWriter.forRun(runDir, "other-id");
    const w2 = RunLogWriter.forRun(runDir, "other-id");
    expect(w1).toBe(w2);

    const w3 = RunLogWriter.forRun(`${runDir}-different`, "other-id");
    expect(w1).not.toBe(w3);
  });

  test("dispose removes singleton", () => {
    const w1 = RunLogWriter.forRun(runDir, runId);
    RunLogWriter.dispose(runDir);
    const w2 = RunLogWriter.forRun(runDir, runId);
    expect(w1).not.toBe(w2);
    expect(w2.lastId).toBe(0); // fresh counter
  });

  test("writeSystem with attribution", async () => {
    const writer = RunLogWriter.forRun(runDir, runId);
    await writer.writeSystem("Step started", {
      job_id: "job-1",
      step_id: "step-a",
      attempt: 2,
    });

    const content = await readFile(join(runDir, "run.log.jsonl"), "utf-8");
    const record = JSON.parse(content.trim().split("\n")[0]!);
    expect(record.stream).toBe("system");
    expect(record.job_id).toBe("job-1");
    expect(record.step_id).toBe("step-a");
    expect(record.attempt).toBe(2);
    expect(record.text).toBe("Step started");
  });

  test("writer auto-creates run directory", async () => {
    // The writer should create the run directory if it doesn't exist
    const nonExistentDir = join(tmpDir, "auto-created", runId);
    const writer = RunLogWriter.forRun(nonExistentDir, runId);

    const id = await writer.write({ stream: "system", text: "auto-created test" });
    expect(id).toBe(1);

    const content = await readFile(join(nonExistentDir, "run.log.jsonl"), "utf-8");
    const record = JSON.parse(content.trim().split("\n")[0]!);
    expect(record.text).toBe("auto-created test");
  });
});
