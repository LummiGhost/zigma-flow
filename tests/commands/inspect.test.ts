import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { inspectAction } from "../../src/commands/inspect.js";

interface Sandbox {
  projectRoot: string;
  runsDir: string;
  runId: string;
  runDir: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-inspect-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const runId = "20260714-0001";
  const runDir = join(runsDir, runId);

  await mkdir(runDir, { recursive: true });

  // Create run.yml
  await writeFile(
    join(runDir, "run.yml"),
    `\
workflow:
  path: /fake/workflow.yml
  name: test-workflow
version: "0.1.0"
task: Test task description
created_at: "2026-07-14T00:00:00.000Z"
`,
    "utf-8",
  );

  // Create state.json
  await writeFile(
    join(runDir, "state.json"),
    JSON.stringify({
      run_id: runId,
      workflow: "test-workflow",
      task: "Test task description",
      created_at: "2026-07-14T00:00:00.000Z",
      status: "completed",
      last_event_id: "evt-003",
      jobs: {
        "intake": {
          status: "completed",
          current_step: "analyze",
          attempt: 1,
        },
        "implement": {
          status: "completed",
          current_step: "implement",
          attempt: 1,
        },
        "review": {
          status: "awaiting_human" as const,
          current_step: "review",
          step_status: "awaiting_human" as const,
          attempt: 1,
        },
        "waiting-job": {
          status: "waiting",
          attempt: 0,
        },
      },
    }, null, 2),
    "utf-8",
  );

  // Create events.jsonl
  await writeFile(
    join(runDir, "events.jsonl"),
    [
      JSON.stringify({ id: "evt-001", type: "run_created", run_id: runId, timestamp: "2026-07-14T00:00:00.000Z", producer: "engine", job: null, step: null, attempt: null }),
      JSON.stringify({ id: "evt-002", type: "job_started", run_id: runId, timestamp: "2026-07-14T00:00:01.000Z", producer: "engine", job: "intake", step: "analyze", attempt: 1 }),
      JSON.stringify({ id: "evt-003", type: "job_completed", run_id: runId, timestamp: "2026-07-14T00:00:02.000Z", producer: "engine", job: "intake", step: "analyze", attempt: 1 }),
    ].join("\n") + "\n",
    "utf-8",
  );

  // Create artifacts.jsonl
  await writeFile(
    join(runDir, "artifacts.jsonl"),
    [
      JSON.stringify({ id: "art-001", kind: "prompt", path: "jobs/intake/attempts/1/steps/analyze/current-step.md", size: 1024, producer: { job: "intake", step: "analyze", attempt: 1 } }),
      JSON.stringify({ id: "art-002", kind: "agent_report", path: "jobs/intake/attempts/1/steps/analyze/report.json", size: 256, producer: { job: "intake", step: "analyze", attempt: 1 } }),
    ].join("\n") + "\n",
    "utf-8",
  );

  // Create config.json with active_run
  await writeFile(
    join(dotZigma, "config.json"),
    JSON.stringify({ tool_version: "0.1.0", active_run: runId }, null, 2),
    "utf-8",
  );

  return { projectRoot, runsDir, runId, runDir };
}

describe("inspectAction", () => {
  let sandbox: Sandbox;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    sandbox = await makeSandbox();
    process.chdir(sandbox.projectRoot);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    process.chdir(originalCwd);
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  // ── Summary view (default) ──────────────────────────────────────────────

  it("shows summary by default (implicit run)", async () => {
    const result = await inspectAction({ projectRoot: sandbox.projectRoot });

    expect(result.runId).toBe(sandbox.runId);
    expect(result.state).not.toBeNull();
    expect(result.state!.status).toBe("completed");

    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
    expect(logs).toContain(sandbox.runId);
    expect(logs).toContain("test-workflow");
    expect(logs).toContain("Test task description");
    expect(logs).toContain("completed");
    // Jobs summary
    expect(logs).toContain("completed: 2");
  });

  it("shows summary for explicit run id", async () => {
    const result = await inspectAction({ runId: sandbox.runId, projectRoot: sandbox.projectRoot });

    expect(result.runId).toBe(sandbox.runId);
    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
    expect(logs).toContain(sandbox.runId);
  });

  it("shows awaiting human input in summary", async () => {
    const result = await inspectAction({ runId: sandbox.runId, projectRoot: sandbox.projectRoot });

    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
    expect(logs).toContain("Awaiting human input");
    expect(logs).toContain("review");
  });

  // ── --latest flag ───────────────────────────────────────────────────────

  it("supports --latest flag", async () => {
    // With multiple runs, --latest picks the most recent
    const result = await inspectAction({ latest: true, projectRoot: sandbox.projectRoot });

    expect(result.runId).toBeTruthy();
  });

  // ── --jobs view ─────────────────────────────────────────────────────────

  it("shows detailed jobs with --jobs", async () => {
    const result = await inspectAction({ runId: sandbox.runId, jobs: true, projectRoot: sandbox.projectRoot });

    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
    expect(logs).toContain("Job details:");
    expect(logs).toContain("intake: completed");
    expect(logs).toContain("implement: completed");
    expect(logs).toContain("review: awaiting_human");
    expect(logs).toContain("step_status=awaiting_human");
  });

  // ── --events view ───────────────────────────────────────────────────────

  it("shows events with --events", async () => {
    const result = await inspectAction({ runId: sandbox.runId, events: true, projectRoot: sandbox.projectRoot });

    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
    expect(logs).toContain("Events:");
    expect(logs).toContain("evt-001");
    expect(logs).toContain("run_created");
    expect(logs).toContain("evt-002");
    expect(logs).toContain("job_started");
    expect(logs).toContain("evt-003");
    expect(logs).toContain("job_completed");
    expect(result.events.length).toBe(3);
  });

  it("respects event limit with --event-limit", async () => {
    // Test with default limit (printed events should be <= 20, all 3 should show)
    const result = await inspectAction({ runId: sandbox.runId, events: true, eventLimit: 2, projectRoot: sandbox.projectRoot });

    // 3 events exist, limit 2 should show last 2
    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
    // evt-001 should NOT appear (it's the first, last 2 are evt-002 and evt-003)
    expect(logs).not.toContain("evt-001");
    expect(logs).toContain("evt-002");
    expect(logs).toContain("evt-003");
  });

  // ── --artifacts view ────────────────────────────────────────────────────

  it("shows artifacts with --artifacts", async () => {
    const result = await inspectAction({ runId: sandbox.runId, artifacts: true, projectRoot: sandbox.projectRoot });

    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
    expect(logs).toContain("Artifacts:");
    expect(logs).toContain("art-001");
    expect(logs).toContain("art-002");
    expect(result.artifacts.length).toBe(2);
  });

  it("filters artifacts by job with --artifact-job", async () => {
    const result = await inspectAction({
      runId: sandbox.runId,
      artifacts: true,
      artifactJob: "intake",
      projectRoot: sandbox.projectRoot,
    });

    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
    expect(logs).toContain("art-001");
    expect(logs).toContain("art-002");
    // Both artifacts belong to intake, so both should appear
  });

  // ── --json output ───────────────────────────────────────────────────────

  it("outputs JSON with --json", async () => {
    const result = await inspectAction({ runId: sandbox.runId, json: true, projectRoot: sandbox.projectRoot });

    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
    const parsed = JSON.parse(logs) as Record<string, unknown>;
    expect(parsed["runId"]).toBe(sandbox.runId);
    expect(parsed["status"]).toBe("completed");
    expect(parsed["jobs"]).toBeDefined();
    expect(parsed["events"]).toBeDefined();
    expect(parsed["artifacts"]).toBeDefined();
  });

  // ── Combined views ──────────────────────────────────────────────────────

  it("supports combined --jobs --events --artifacts", async () => {
    const result = await inspectAction({
      runId: sandbox.runId,
      jobs: true,
      events: true,
      artifacts: true,
      projectRoot: sandbox.projectRoot,
    });

    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");
    expect(logs).toContain("Job details:");
    expect(logs).toContain("Events:");
    expect(logs).toContain("Artifacts:");
  });

  // ── Error cases ─────────────────────────────────────────────────────────

  it("throws for nonexistent run id", async () => {
    await expect(
      inspectAction({ runId: "nonexistent-run", projectRoot: sandbox.projectRoot }),
    ).rejects.toThrow();
  });
});

describe("inspectAction with no active run", () => {
  let sandbox: Sandbox;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    const projectRoot = join(tmpdir(), `zigma-inspect-empty-${randomUUID()}`);
    sandbox = { projectRoot, runsDir: join(projectRoot, ".zigma-flow", "runs"), runId: "", runDir: "" };
    // Create .zigma-flow/runs/ but no runs
    await mkdir(sandbox.runsDir, { recursive: true });
    // Create config without active_run
    await writeFile(
      join(projectRoot, ".zigma-flow", "config.json"),
      JSON.stringify({ tool_version: "0.1.0", active_run: null }, null, 2),
      "utf-8",
    );
    process.chdir(projectRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("throws when no runs exist and no run id is given", async () => {
    await expect(
      inspectAction({ projectRoot: sandbox.projectRoot }),
    ).rejects.toThrow();
  });
});
