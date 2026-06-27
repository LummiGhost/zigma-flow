/**
 * EventWriter interface and JsonlEventWriter implementation.
 *
 * Moved from src/run/index.ts and re-exported from there for backward compat.
 *
 * Reference: docs/mvp-contracts.md §2.4
 * WF-P4-EVENT Step 2.
 */

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { AsyncQueue } from "../run/asyncQueue.js";
import { FilesystemError } from "../utils/index.js";
import type { ZigmaFlowEvent } from "./eventTypes.js";

// ---------------------------------------------------------------------------
// WorkflowEvent — legacy event shape (retained for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Legacy event envelope — used by `run/index.ts`, the engine, and P3 tests.
 * New code should prefer `ZigmaFlowEvent` from `eventTypes.ts`.
 */
export interface WorkflowEvent {
  id: string;            // "evt-001", "evt-002", ...
  type: string;          // "run_created" | "job_ready" | ...
  run_id: string;
  timestamp: string;     // ISO 8601
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// EventWriter interface
// ---------------------------------------------------------------------------

export interface EventWriter {
  appendEvent(runDir: string, event: ZigmaFlowEvent): Promise<void>;
  readLastEventId(runDir: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Per-runDir append serialization queues (AD-P14-003)
// ---------------------------------------------------------------------------

const appendQueues = new Map<string, AsyncQueue>();

function getAppendQueue(runDir: string): AsyncQueue {
  let queue = appendQueues.get(runDir);
  if (!queue) {
    queue = new AsyncQueue();
    appendQueues.set(runDir, queue);
  }
  return queue;
}

// JsonlEventWriter — append-only JSONL implementation
export class JsonlEventWriter implements EventWriter {
  async appendEvent(runDir: string, event: ZigmaFlowEvent): Promise<void> {
    return getAppendQueue(runDir).run(async () => {
      const eventsPath = join(runDir, "events.jsonl");
      await appendFile(eventsPath, JSON.stringify(event) + "\n", "utf-8");
    });
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
    let parsed: { id: string };
    try {
      parsed = JSON.parse(lastLine) as { id: string };
    } catch (e: unknown) {
      throw new FilesystemError(
        `events.jsonl contains unparseable last line: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      );
    }
    return parsed.id;
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
