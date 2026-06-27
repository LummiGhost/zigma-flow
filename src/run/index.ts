/**
 * Run creation infrastructure — adapters, types, and filesystem helpers.
 *
 * Reference: docs/mvp-contracts.md §2.3, §2.4
 * WF-P3-RUN Step 2 / WF-P4-STATE Step 2.
 */

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { stringify } from "yaml";

import { ConfigError, FilesystemError, StateError, WorkflowError } from "../utils/index.js";

import { AsyncQueue } from "./asyncQueue.js";

// Re-export event types from events/ for backward compatibility.
export type { EventWriter, WorkflowEvent } from "../events/index.js";
export { JsonlEventWriter } from "../events/index.js";

// Re-export AsyncQueue for convenience.
export { AsyncQueue } from "./asyncQueue.js";

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
  /**
   * Atomically read-modify-write run state within the per-runDir write queue.
   * The `updater` receives the current RunState (guaranteed non-null; throws
   * StateError if state.json is missing) and returns the new state to persist.
   *
   * This is the safe method for concurrent writers (AD-P14-003): the read and
   * write happen inside a single AsyncQueue entry so no peer write can
   * interleave and overwrite partial updates.
   */
  updateState(
    runDir: string,
    updater: (current: RunState) => RunState,
  ): Promise<void>;
  /**
   * Validate last event id consistency.
   *
   * Overloads:
   * - `validateLastEventId(runDir)` — reads events.jsonl tail and compares to
   *   snapshot.last_event_id; throws StateError on mismatch (WF-P4-STATE).
   * - `validateLastEventId(runDir, expectedEventId)` — compares snapshot
   *   last_event_id to the supplied string; throws WorkflowError on mismatch
   *   (backward compat with P3 callers).
   */
  validateLastEventId(runDir: string, expectedEventId?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobState {
  status: "ready" | "waiting" | "inactive" | "running" | "done" | "completed" | "failed" | "blocked";
  activation?: string;           // present iff workflow declares activation on the job
  attempt?: number;              // present iff retry-eligible; omit for initial state
  current_step?: string;         // id of the step that has just completed within the current attempt; absent before any step has run (WF-P8-MULTISTEP Architecture Decision 2)
  activated?: boolean;           // true after activate_job transition (WF-P8-SIGNALS)
  activation_reason?: string;    // reason from opts.reason on activate_job (WF-P8-SIGNALS)
  retry_reason?: string;         // reason from opts.reason on retry_job (WF-P8-SIGNALS)
  retry_inputs?: Record<string, string>; // retry_with payload from the router action that triggered this retry
  outputs?: Record<string, unknown>; // persisted from report.json.outputs by acceptAgentReport (WF-P9-ACCEPT)
  step_visits?: Record<string, number>; // visit count per step id (WF-P13-VARIABLES)
}

export interface RunState {
  run_id: string;
  workflow: string;      // workflow name (NOT path)
  task: string;
  created_at: string;    // ISO 8601
  status?: "running" | "blocked" | "failed" | "completed" | "cancelled"; // mvp-contracts §2.3
  last_event_id: string; // id of tail event in events.jsonl
  jobs: Record<string, JobState>;
  variables?: Record<string, unknown>; // WF-P13-VARIABLES
  context_blocks?: Record<string, { current_version: number; current_artifact: string }>; // WF-P13-VARIABLES
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

/**
 * Minimal shape check for RunState — verifies all required string/object fields
 * are present and non-null. Throws StateError if invalid.
 */
function isValidRunState(value: unknown): value is RunState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["run_id"] === "string" &&
    typeof obj["workflow"] === "string" &&
    typeof obj["task"] === "string" &&
    typeof obj["created_at"] === "string" &&
    typeof obj["last_event_id"] === "string" &&
    typeof obj["jobs"] === "object" &&
    obj["jobs"] !== null
  );
}

// ---------------------------------------------------------------------------
// Per-runDir write serialization queues (AD-P14-003)
// ---------------------------------------------------------------------------

const writeQueues = new Map<string, AsyncQueue>();

function getWriteQueue(runDir: string): AsyncQueue {
  let queue = writeQueues.get(runDir);
  if (!queue) {
    queue = new AsyncQueue();
    writeQueues.set(runDir, queue);
  }
  return queue;
}

export class LocalStateStore implements StateStore {
  async readSnapshot(runDir: string): Promise<RunState | null> {
    const statePath = join(runDir, "state.json");
    let text: string;
    try {
      text = await readFile(statePath, "utf-8");
    } catch (e: unknown) {
      if (isEnoent(e)) {
        return null;
      }
      throw new FilesystemError(`Cannot read state.json in: ${runDir}`, { cause: e });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e: unknown) {
      throw new StateError(`state.json contains invalid JSON in: ${runDir}`, { cause: e });
    }

    if (!isValidRunState(parsed)) {
      throw new StateError(`state.json is missing required fields in: ${runDir}`, {
        details: { runDir },
      });
    }

    return parsed;
  }

  async writeSnapshot(runDir: string, state: RunState): Promise<void> {
    return getWriteQueue(runDir).run(async () => {
      const statePath = join(runDir, "state.json");
      const tmpPath = join(runDir, `state.json.tmp-${randomUUID()}`);
      const text = JSON.stringify(state, null, 2);
      await writeFile(tmpPath, text, "utf-8");
      await rename(tmpPath, statePath);
    });
  }

  async updateState(
    runDir: string,
    updater: (current: RunState) => RunState,
  ): Promise<void> {
    return getWriteQueue(runDir).run(async () => {
      const current = await this.readSnapshot(runDir);
      if (current === null) {
        throw new StateError(`Cannot update state: state.json missing in ${runDir}`);
      }
      const newState = updater(current);
      const statePath = join(runDir, "state.json");
      const tmpPath = join(runDir, `state.json.tmp-${randomUUID()}`);
      const text = JSON.stringify(newState, null, 2);
      await writeFile(tmpPath, text, "utf-8");
      await rename(tmpPath, statePath);
    });
  }

  /**
   * Validate event/state consistency.
   *
   * - If `expectedEventId` is provided: compares snapshot.last_event_id to
   *   it and throws WorkflowError on mismatch (legacy P3 behavior).
   * - If `expectedEventId` is omitted: reads events.jsonl tail and compares
   *   to snapshot.last_event_id; throws StateError on mismatch or missing log.
   */
  async validateLastEventId(runDir: string, expectedEventId?: string): Promise<void> {
    if (expectedEventId !== undefined) {
      // Legacy path: compare snapshot against the caller-supplied id.
      const snap = await this.readSnapshot(runDir);
      const actual = snap?.last_event_id;
      if (actual !== expectedEventId) {
        throw new WorkflowError(
          `Event id mismatch: expected "${expectedEventId}", got "${actual ?? "null"}"`,
          { details: { expected: expectedEventId, actual: actual ?? null } }
        );
      }
      return;
    }

    // New path: read events.jsonl tail and compare to snapshot.
    const { JsonlEventWriter } = await import("../events/index.js");
    const eventWriter = new JsonlEventWriter();
    const eventsTailId = await eventWriter.readLastEventId(runDir);

    const snap = await this.readSnapshot(runDir);
    const snapshotLastEventId = snap?.last_event_id ?? null;

    if (eventsTailId === null) {
      // events.jsonl is missing or empty but snapshot records an event id.
      throw new StateError(
        `events.jsonl is missing or empty but snapshot.last_event_id is "${snapshotLastEventId ?? "null"}"`,
        { details: { snapshot_last_event_id: snapshotLastEventId, events_tail_id: null } }
      );
    }

    if (snapshotLastEventId !== eventsTailId) {
      throw new StateError(
        `Event/state divergence: snapshot.last_event_id="${snapshotLastEventId ?? "null"}", events.jsonl tail="${eventsTailId}"`,
        {
          details: {
            snapshot_last_event_id: snapshotLastEventId,
            events_tail_id: eventsTailId,
          },
        }
      );
    }
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
// Active run pointer helpers — WF-P5-PROMPT
// ---------------------------------------------------------------------------

/**
 * Read the active run id from `.zigma-flow/config.json`.
 * Returns null if config.json is missing or `active_run` is null/absent.
 *
 * Full implementation: WF-P5-PROMPT Step 2.
 */
export async function readActiveRun(zigmaflowDir: string): Promise<string | null> {
  const configPath = join(zigmaflowDir, ".zigma-flow", "config.json");
  let text: string;
  try {
    text = await readFile(configPath, "utf-8");
  } catch (e: unknown) {
    if (isEnoent(e)) {
      return null;
    }
    throw new FilesystemError(`Cannot read config.json at: ${configPath}`, { cause: e });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const cfg = parsed as Record<string, unknown>;
  const activeRun = cfg["active_run"];
  return typeof activeRun === "string" ? activeRun : null;
}

/**
 * Write the active run id into `.zigma-flow/config.json`.
 * Throws ConfigError if config.json does not exist.
 *
 * Full implementation: WF-P5-PROMPT Step 2.
 */
export async function writeActiveRun(zigmaflowDir: string, runId: string): Promise<void> {
  const configPath = join(zigmaflowDir, ".zigma-flow", "config.json");
  let text: string;
  try {
    text = await readFile(configPath, "utf-8");
  } catch (e: unknown) {
    if (isEnoent(e)) {
      throw new ConfigError(
        `config.json not found; cannot write active_run: ${configPath}`,
        { cause: e }
      );
    }
    throw new FilesystemError(`Cannot read config.json at: ${configPath}`, { cause: e });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: unknown) {
    throw new ConfigError(`config.json contains invalid JSON at: ${configPath}`, { cause: e });
  }

  const cfg = (typeof parsed === "object" && parsed !== null
    ? parsed
    : {}) as Record<string, unknown>;

  const updated = { ...cfg, active_run: runId };
  const tmpPath = join(zigmaflowDir, ".zigma-flow", `config.json.tmp-${randomUUID()}`);
  await writeFile(tmpPath, JSON.stringify(updated, null, 2), "utf-8");
  await rename(tmpPath, configPath);
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
