/**
 * Infrastructure unit tests for WF-P3-RUN (Step 1 — Cases and Tests).
 *
 * Covers: Clock, IdGenerator, StateStore, EventWriter adapters and the three
 * run filesystem helpers (createRunDirectory, writeRunYaml, snapshotSkillLock).
 *
 * Reference:
 *   - docs/phases/p3-run/workflows/wf-p3-run/01-cases-and-tests.md
 *   - docs/mvp-contracts.md §2.3, §2.4
 *   - docs/prd.md FR-004
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { Clock, RunState, RunYamlMeta, WorkflowEvent } from "../../src/run/index.js";
import type { ZigmaFlowEvent } from "../../src/events/index.js";
import {
  JsonlEventWriter,
  LocalRunIdGenerator,
  LocalStateStore,
  SystemClock,
  createRunDirectory,
  snapshotSkillLock,
  writeRunYaml,
} from "../../src/run/index.js";
import { FilesystemError, WorkflowError } from "../../src/utils/index.js";

// Deterministic clock for tests that depend on date-formatted ids.
class FakeClock implements Clock {
  constructor(private readonly iso: string) {}
  now(): string {
    return this.iso;
  }
}

const FIXED_ISO = "2026-06-07T00:00:00.000Z";
const FIXED_DATE = "20260607";

// ---------------------------------------------------------------------------
// SystemClock
// ---------------------------------------------------------------------------

describe("SystemClock", () => {
  it("returns an ISO 8601 timestamp (T-CLOCK-1, UC-CLOCK-1)", () => {
    const clock = new SystemClock();
    const ts = clock.now();
    expect(Date.parse(ts)).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// LocalRunIdGenerator
// ---------------------------------------------------------------------------

describe("LocalRunIdGenerator", () => {
  let tmpDir: string;
  let runsDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-test-${randomUUID()}`);
    runsDir = join(tmpDir, "runs");
    await mkdir(runsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("starts the counter at 0001 for an empty runs dir (T-IDGEN-1, UC-IDGEN-1)", async () => {
    const gen = new LocalRunIdGenerator(new FakeClock(FIXED_ISO));
    const id = await gen.nextRunId(runsDir);
    expect(id).toBe(`${FIXED_DATE}-0001`);
  });

  it("increments the counter when a prior run exists for today (T-IDGEN-2, UC-IDGEN-2)", async () => {
    await mkdir(join(runsDir, `${FIXED_DATE}-0001`));
    const gen = new LocalRunIdGenerator(new FakeClock(FIXED_ISO));
    const id = await gen.nextRunId(runsDir);
    expect(id).toBe(`${FIXED_DATE}-0002`);
  });

  it("ignores run directories from other dates (T-IDGEN-3, UC-IDGEN-3)", async () => {
    await mkdir(join(runsDir, "20260606-0001"));
    await mkdir(join(runsDir, `${FIXED_DATE}-0001`));
    const gen = new LocalRunIdGenerator(new FakeClock(FIXED_ISO));
    const id = await gen.nextRunId(runsDir);
    expect(id).toBe(`${FIXED_DATE}-0002`);
  });
});

// ---------------------------------------------------------------------------
// LocalStateStore
// ---------------------------------------------------------------------------

describe("LocalStateStore", () => {
  let tmpDir: string;
  let runDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-test-${randomUUID()}`);
    runDir = join(tmpDir, "20260607-0001");
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("readSnapshot returns null when state.json is missing (T-STATE-1, UC-STATE-1)", async () => {
    const store = new LocalStateStore();
    const snap = await store.readSnapshot(runDir);
    expect(snap).toBeNull();
  });

  it("writeSnapshot then readSnapshot round-trips the state object (T-STATE-2, UC-STATE-2..3)", async () => {
    const store = new LocalStateStore();
    const state: RunState = {
      run_id: "20260607-0001",
      workflow: "code-change",
      task: "fix the bug",
      created_at: FIXED_ISO,
      last_event_id: "evt-001",
      jobs: {
        intake: { status: "ready" },
      },
    };
    await store.writeSnapshot(runDir, state);
    const snap = await store.readSnapshot(runDir);
    expect(snap).toEqual(state);
  });

  it("validateLastEventId resolves when the snapshot matches (T-STATE-3, UC-STATE-4)", async () => {
    const store = new LocalStateStore();
    const state: RunState = {
      run_id: "20260607-0001",
      workflow: "code-change",
      task: "fix the bug",
      created_at: FIXED_ISO,
      last_event_id: "evt-005",
      jobs: { intake: { status: "ready" } },
    };
    await store.writeSnapshot(runDir, state);
    await expect(store.validateLastEventId(runDir, "evt-005")).resolves.toBeUndefined();
  });

  it("validateLastEventId throws WorkflowError on mismatch (T-STATE-4, UC-STATE-5)", async () => {
    const store = new LocalStateStore();
    const state: RunState = {
      run_id: "20260607-0001",
      workflow: "code-change",
      task: "fix the bug",
      created_at: FIXED_ISO,
      last_event_id: "evt-005",
      jobs: { intake: { status: "ready" } },
    };
    await store.writeSnapshot(runDir, state);
    await expect(store.validateLastEventId(runDir, "evt-999")).rejects.toBeInstanceOf(WorkflowError);
  });
});

// ---------------------------------------------------------------------------
// JsonlEventWriter
// ---------------------------------------------------------------------------

describe("JsonlEventWriter", () => {
  let tmpDir: string;
  let runDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-test-${randomUUID()}`);
    runDir = join(tmpDir, "20260607-0001");
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("appendEvent then readLastEventId returns the single appended id (T-EVENT-1, UC-EVENT-1)", async () => {
    const writer = new JsonlEventWriter();
    const event: ZigmaFlowEvent = {
      id: "evt-001",
      type: "run_created",
      run_id: "20260607-0001",
      timestamp: FIXED_ISO,
      producer: "engine",
      job: null,
      step: null,
      attempt: null,
      payload: { workflow: "code-change", task: "test" },
    };
    await writer.appendEvent(runDir, event);
    const lastId = await writer.readLastEventId(runDir);
    expect(lastId).toBe("evt-001");
  });

  it("appendEvent twice and readLastEventId returns the second id (T-EVENT-2, UC-EVENT-2)", async () => {
    const writer = new JsonlEventWriter();
    const ev1: ZigmaFlowEvent = {
      id: "evt-001",
      type: "run_created",
      run_id: "20260607-0001",
      timestamp: FIXED_ISO,
      producer: "engine",
      job: null,
      step: null,
      attempt: null,
      payload: { workflow: "code-change", task: "test" },
    };
    const ev2: ZigmaFlowEvent = {
      id: "evt-002",
      type: "job_ready",
      run_id: "20260607-0001",
      timestamp: FIXED_ISO,
      producer: "engine",
      job: null,
      step: null,
      attempt: null,
      payload: { job_id: "intake" },
    };
    await writer.appendEvent(runDir, ev1);
    await writer.appendEvent(runDir, ev2);
    const lastId = await writer.readLastEventId(runDir);
    expect(lastId).toBe("evt-002");
  });

  it("readLastEventId returns null when events.jsonl is missing (T-EVENT-3, UC-EVENT-3)", async () => {
    const writer = new JsonlEventWriter();
    const lastId = await writer.readLastEventId(runDir);
    expect(lastId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createRunDirectory
// ---------------------------------------------------------------------------

describe("createRunDirectory", () => {
  let tmpDir: string;
  let runsDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-test-${randomUUID()}`);
    runsDir = join(tmpDir, "runs");
    // Intentionally NOT creating runsDir — helper must handle missing parents.
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the run directory and returns its absolute path (T-DIR-1, UC-DIR-1)", async () => {
    const runDir = await createRunDirectory("20260607-0001", runsDir);
    const s = await stat(runDir);
    expect(s.isDirectory()).toBe(true);
    expect(runDir).toBe(join(runsDir, "20260607-0001"));
  });
});

// ---------------------------------------------------------------------------
// writeRunYaml
// ---------------------------------------------------------------------------

describe("writeRunYaml", () => {
  let tmpDir: string;
  let runDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-test-${randomUUID()}`);
    runDir = join(tmpDir, "20260607-0001");
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes run.yml with task, workflow name+path, created_at, skill_lock_snapshot (T-YAML-1, UC-YAML-1)", async () => {
    const meta: RunYamlMeta = {
      task: "fix the critical bug",
      workflow: {
        name: "code-change",
        path: "/project/.zigma-flow/workflows/code-change.yml",
      },
      created_at: FIXED_ISO,
      skill_lock_snapshot: "skill-lock.snapshot.json",
    };
    await writeRunYaml(runDir, meta);
    const contents = await readFile(join(runDir, "run.yml"), "utf-8");
    expect(contents).toContain("task:");
    expect(contents).toContain("fix the critical bug");
    expect(contents).toContain("workflow:");
    expect(contents).toContain("code-change");
    expect(contents).toContain("created_at:");
    expect(contents).toContain("skill_lock_snapshot:");
  });
});

// ---------------------------------------------------------------------------
// snapshotSkillLock
// ---------------------------------------------------------------------------

describe("snapshotSkillLock", () => {
  let tmpDir: string;
  let runDir: string;
  let skillLockPath: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-test-${randomUUID()}`);
    runDir = join(tmpDir, "run");
    skillLockPath = join(tmpDir, "skill-lock.json");
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("copies skill-lock.json to skill-lock.snapshot.json (T-LOCK-1, UC-LOCK-1)", async () => {
    const lockContent = JSON.stringify({ version: "1.0.0", skills: {} });
    await writeFile(skillLockPath, lockContent, "utf-8");
    await snapshotSkillLock(runDir, skillLockPath);
    const snapContent = await readFile(join(runDir, "skill-lock.snapshot.json"), "utf-8");
    expect(snapContent).toBe(lockContent);
  });

  it("throws FilesystemError when skill-lock.json does not exist (T-LOCK-2, UC-LOCK-2)", async () => {
    await expect(snapshotSkillLock(runDir, skillLockPath)).rejects.toBeInstanceOf(FilesystemError);
  });
});
