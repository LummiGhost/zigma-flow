/**
 * Tests for `zigma-flow logs` command (Issue #280).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import { logsAction } from "../../src/commands/logs.js";

describe("logs command", () => {
  let tmpDir: string;
  let runsDir: string;
  let runDir: string;
  const runId = "20260811-0001";

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "zigma-logs-cmd-"));
    runsDir = join(tmpDir, "runs");
    runDir = join(runsDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "state.json"), JSON.stringify({ status: "completed" }), "utf-8");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reads existing log records and exits", async () => {
    await writeFile(
      join(runDir, "run.log.jsonl"),
      JSON.stringify({ id: 1, occurred_at: "2026-08-11T00:00:00.000Z", run_id: runId, job_id: null, step_id: null, attempt: null, stream: "system", text: "run started" }) + "\n" +
      JSON.stringify({ id: 2, occurred_at: "2026-08-11T00:00:01.000Z", run_id: runId, job_id: "job-1", step_id: "step-a", attempt: 1, stream: "stdout", text: "hello" }) + "\n",
      "utf-8"
    );

    const stdout = vi.fn();
    const stderr = vi.fn();

    await logsAction({
      runsDir,
      run: runId,
      stdout,
      stderr,
    });

    // System log goes to stderr, stdout/stderr log goes to stdout
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("run started"));

    // stdout output contains the forwarded stdout chunk with prefix
    const stdoutCalls = stdout.mock.calls.map((c) => c[0]).join("\n");
    expect(stdoutCalls).toContain("hello");
    expect(stdoutCalls).toContain("job-1");
  });

  test("logs --latest resolves latest run", async () => {
    // Create a second, newer run
    const newerRunDir = join(runsDir, "20260811-0002");
    await mkdir(newerRunDir, { recursive: true });
    await writeFile(join(newerRunDir, "state.json"), JSON.stringify({ status: "running" }), "utf-8");
    await writeFile(
      join(newerRunDir, "run.log.jsonl"),
      JSON.stringify({ id: 1, occurred_at: "2026-08-11T00:00:00.000Z", run_id: "20260811-0002", job_id: null, step_id: null, attempt: null, stream: "system", text: "newer run" }) + "\n",
      "utf-8"
    );

    // Also ensure the older run has a log file
    await writeFile(join(runDir, "run.log.jsonl"), "", "utf-8");

    const stdout = vi.fn();
    const stderr = vi.fn();

    await logsAction({
      runsDir,
      latest: true,
      stdout,
      stderr,
    });

    // Should read from the latest run (0002)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("newer run"));
  });

  test("logs --follow with terminal state exits cleanly", async () => {
    await writeFile(
      join(runDir, "run.log.jsonl"),
      JSON.stringify({ id: 1, occurred_at: "2026-08-11T00:00:00.000Z", run_id: runId, job_id: null, step_id: null, attempt: null, stream: "system", text: "existing" }) + "\n",
      "utf-8"
    );

    const stdout = vi.fn();
    const stderr = vi.fn();

    await logsAction({
      runsDir,
      run: runId,
      follow: true,
      pollMs: 20,
      stdout,
      stderr,
    });

    // Should have read the existing record
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("existing"));
    // Should have announced following
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Following logs"));
    // Should have announced terminal exit
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("terminal state"));
  });

  test("logs with --step requires --job", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();

    await expect(
      logsAction({
        runsDir,
        run: runId,
        step: "step-a",
        stdout,
        stderr,
      }),
    ).rejects.toThrow(/--step.*requires.*--job/i);
  });

  test("logs with --latest when no runs exist", async () => {
    // Delete the run directory
    await rm(runDir, { recursive: true, force: true });

    const stdout = vi.fn();
    const stderr = vi.fn();

    await expect(
      logsAction({
        runsDir,
        latest: true,
        stdout,
        stderr,
      }),
    ).rejects.toThrow(/no runs found/i);
  });

  test("logs with non-existent run", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();

    await expect(
      logsAction({
        runsDir,
        run: "nonexistent-run",
        stdout,
        stderr,
      }),
    ).rejects.toThrow(/not found/i);
  });

  test("logs with no records shows empty message", async () => {
    // No run.log.jsonl file
    const stdout = vi.fn();
    const stderr = vi.fn();

    await logsAction({
      runsDir,
      run: runId,
      stdout,
      stderr,
    });

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("No log records"));
  });

  test("logs filtering by job shows only matching records", async () => {
    await writeFile(
      join(runDir, "run.log.jsonl"),
      JSON.stringify({ id: 1, occurred_at: "2026-08-11T00:00:00.000Z", run_id: runId, job_id: "job-a", step_id: "s1", attempt: 1, stream: "stdout", text: "from-a" }) + "\n" +
      JSON.stringify({ id: 2, occurred_at: "2026-08-11T00:00:01.000Z", run_id: runId, job_id: "job-b", step_id: "s1", attempt: 1, stream: "stdout", text: "from-b" }) + "\n",
      "utf-8"
    );

    const stdout = vi.fn();
    const stderr = vi.fn();

    await logsAction({
      runsDir,
      run: runId,
      job: "job-a",
      stdout,
      stderr,
    });

    const stdoutText = stdout.mock.calls.map((c) => c[0]).join("\n");
    expect(stdoutText).toContain("from-a");
    expect(stdoutText).not.toContain("from-b");
  });
});
