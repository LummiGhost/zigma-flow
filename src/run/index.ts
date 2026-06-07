/**
 * Run creation infrastructure — adapters, types, and filesystem helpers.
 *
 * Reference: docs/mvp-contracts.md §2.3, §2.4
 * WF-P3-RUN Step 2.
 */

import { appendFile, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { stringify } from "yaml";

import { FilesystemError, WorkflowError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface Clock {
  now(): string; // ISO 8601
}

export interface IdGenerator {
  nextRunId(runsDir: string): Promise<string>;
}

export interface StateStore {
  readSnapshot(runDir: string): Promise<RunState | null>;
  writeSnapshot(runDir: string, state: RunState): Promise<void>;
  validateLastEventId(runDir: string, expectedEventId: string): Promise<void>;
}

export interface EventWriter {
  appendEvent(runDir: string, event: WorkflowEvent): Promise<void>;
  readLastEventId(runDir: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobState {
  status: "ready" | "waiting" | "inactive" | "running" | "done" | "failed";
  activation?: string; // present iff workflow declares activation on the job
  attempt?: number;    // present iff retry-eligible; omit for initial state
}

export interface RunState {
  run_id: string;
  workflow: string;      // workflow name (NOT path)
  task: string;
  created_at: string;    // ISO 8601
  last_event_id: string; // id of tail event in events.jsonl
  jobs: Record<string, JobState>;
}

export interface WorkflowEvent {
  id: string;            // "evt-001", "evt-002", ...
  type: string;          // "run_created" | "job_ready"
  run_id: string;
  timestamp: string;     // ISO 8601
  payload: Record<string, unknown>;
}

export interface RunYamlMeta {
  task: string;
  workflow: {
    name: string;
    path: string;
  };
  created_at: string;
  skill_lock_snapshot: string;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

export class LocalRunIdGenerator implements IdGenerator {
  constructor(private readonly clock: Clock) {}

  async nextRunId(runsDir: string): Promise<string> {
    // 1. Derive date prefix from clock.now() → "YYYYMMDD"
    const iso = this.clock.now();
    const datePrefix = iso.slice(0, 10).replace(/-/g, ""); // "YYYYMMDD"

    // 2. Try to read runsDir; if ENOENT, count = 0
    let count = 0;
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(runsDir);
      // 3. Count entries whose name starts with the date prefix
      count = entries.filter((name) => name.startsWith(datePrefix)).length;
    } catch (e: unknown) {
      if (isEnoent(e)) {
        count = 0;
      } else {
        throw new FilesystemError(`Cannot read runs directory: ${runsDir}`, { cause: e });
      }
    }

    // 4. Format: `${datePrefix}-${String(count + 1).padStart(4, "0")}`
    return `${datePrefix}-${String(count + 1).padStart(4, "0")}`;
  }
}

export class LocalStateStore implements StateStore {
  async readSnapshot(runDir: string): Promise<RunState | null> {
    const statePath = join(runDir, "state.json");
    try {
      const text = await readFile(statePath, "utf-8");
      return JSON.parse(text) as RunState;
    } catch (e: unknown) {
      if (isEnoent(e)) {
        return null;
      }
      throw new FilesystemError(`Cannot read state.json in: ${runDir}`, { cause: e });
    }
  }

  async writeSnapshot(runDir: string, state: RunState): Promise<void> {
    const statePath = join(runDir, "state.json");
    const tmpPath = join(runDir, `state.json.tmp-${randomUUID()}`);
    const text = JSON.stringify(state, null, 2);
    await writeFile(tmpPath, text, "utf-8");
    await rename(tmpPath, statePath);
  }

  async validateLastEventId(runDir: string, expectedEventId: string): Promise<void> {
    const snap = await this.readSnapshot(runDir);
    const actual = snap?.last_event_id;
    if (actual !== expectedEventId) {
      throw new WorkflowError(
        `Event id mismatch: expected "${expectedEventId}", got "${actual ?? "null"}"`,
        { details: { expected: expectedEventId, actual: actual ?? null } }
      );
    }
  }
}

export class JsonlEventWriter implements EventWriter {
  async appendEvent(runDir: string, event: WorkflowEvent): Promise<void> {
    const eventsPath = join(runDir, "events.jsonl");
    await appendFile(eventsPath, JSON.stringify(event) + "\n", "utf-8");
  }

  async readLastEventId(runDir: string): Promise<string | null> {
    const eventsPath = join(runDir, "events.jsonl");
    let text: string;
    try {
      text = await readFile(eventsPath, "utf-8");
    } catch (e: unknown) {
      if (isEnoent(e)) {
        return null;
      }
      throw new FilesystemError(`Cannot read events.jsonl in: ${runDir}`, { cause: e });
    }

    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return null;
    }

    const lastLine = lines[lines.length - 1]!;
    const parsed = JSON.parse(lastLine) as WorkflowEvent;
    return parsed.id;
  }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export async function createRunDirectory(runId: string, runsDir: string): Promise<string> {
  const runDir = join(runsDir, runId);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

export async function writeRunYaml(runDir: string, meta: RunYamlMeta): Promise<void> {
  const yamlPath = join(runDir, "run.yml");
  const content = stringify(meta);
  await writeFile(yamlPath, content, "utf-8");
}

export async function snapshotSkillLock(runDir: string, skillLockPath: string): Promise<void> {
  const destPath = join(runDir, "skill-lock.snapshot.json");
  try {
    await copyFile(skillLockPath, destPath);
  } catch (e: unknown) {
    if (isEnoent(e)) {
      throw new FilesystemError(`Skill lock file not found: ${skillLockPath}`, { cause: e });
    }
    throw new FilesystemError(`Cannot copy skill lock file: ${skillLockPath}`, { cause: e });
  }
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function isEnoent(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as Record<string, unknown>)["code"] === "ENOENT"
  );
}
