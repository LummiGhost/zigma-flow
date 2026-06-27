/**
 * Event ID sequencing — reads the last event from events.jsonl and returns
 * the next sequential event id.
 *
 * Replaces all scattered `parseInt(lastId.replace("evt-",""), 10)` calls
 * throughout the codebase with a single, consistent utility.
 *
 * Reference: AD-P13-007 (event ID sequence port)
 * WF-P13-ENGINE-RUNALL Step 2.
 */

import { FilesystemError } from "../utils/index.js";
import { nextEventId } from "./eventTypes.js";
import { JsonlEventWriter } from "./appendEvent.js";
import type { EventWriter } from "./appendEvent.js";

/**
 * Read the last event from events.jsonl in `runDir` and return the next
 * sequential event id.
 *
 * - If no events exist (file missing or empty), returns "evt-001".
 * - If the last event has id "evt-NNN", returns "evt-{NNN+1}" zero-padded
 *   to at least 3 digits (via `nextEventId`).
 * - If the last line is not valid JSON or lacks an `id` field matching the
 *   "evt-NNN" pattern, throws `FilesystemError`.
 *
 * @param runDir – absolute path to the run directory
 * @param eventWriter – optional EventWriter (defaults to new JsonlEventWriter)
 */
export async function nextSequentialEventId(
  runDir: string,
  eventWriter?: EventWriter,
): Promise<string> {
  const writer: EventWriter = eventWriter ?? new JsonlEventWriter();
  const lastId: string | null = await writer.readLastEventId(runDir);

  if (lastId === null) {
    return nextEventId(1); // "evt-001"
  }

  // Runtime guard: lastId could be undefined at runtime if the JSON was valid
  // but had no `id` field (readLastEventId casts JSON.parse result).
  if (typeof (lastId as string | undefined) !== "string") {
    throw new FilesystemError(
      "events.jsonl last line does not contain an id field",
      { details: { runDir } },
    );
  }

  // Parse the numeric suffix from "evt-NNN"
  const evtMatch = lastId.match(/^evt-(\d+)$/);
  if (evtMatch === null) {
    throw new FilesystemError(
      `events.jsonl last line has invalid event id format: "${lastId}" — expected "evt-<N>"`,
      { details: { lastId } },
    );
  }

  const counter = parseInt(evtMatch[1]!, 10);
  return nextEventId(counter + 1);
}
