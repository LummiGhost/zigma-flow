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

import { FilesystemError } from "../utils/index.js";

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
  appendEvent(runDir: string, event: WorkflowEvent): Promise<void>;
  readLastEventId(runDir: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// JsonlEventWriter — append-only JSONL implementation
// ---------------------------------------------------------------------------

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
