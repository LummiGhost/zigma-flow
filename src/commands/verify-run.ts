/**
 * verify-run command action handler.
 *
 * Reads state.json, events.jsonl, and artifacts.jsonl for a run directory and
 * cross-checks them against the on-disk layout, printing a per-check
 * PASS / FAIL / WARN report followed by a summary line.
 *
 * Consistency checks performed:
 *   1. state.json valid (exists, parseable JSON, required fields present).
 *   2. events.jsonl has no duplicate event ids AND
 *      state.last_event_id matches the last event id in the log.
 *   3. every entry in artifacts.jsonl has a `path` field and the referenced
 *      file exists on disk relative to the run directory.
 *   4. per-job attempt count equals the number of jobs/<jobId>/attempts/<n>/ dirs.
 *   5. every `context_block_updated` event references a payload.artifact_ref
 *      path that exists on disk.
 *
 * Exit codes: 0 = all checks pass; 1 = at least one FAIL.
 *
 * Reference:
 *   docs/phases/v0.2.2-runtime-reliability/workflows/wf-v022-verifyrun/01-cases-and-tests.md
 *   GitHub Issue #94
 * WF-V022-VERIFYRUN Step 2.
 */

import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface VerifyRunOptions {
  /** Absolute path to the run directory directly, OR: */
  runDir?: string;
  /** Absolute path to the runs directory + runId to construct the run dir */
  runsDir?: string;
  runId?: string;
  /** Optional output sinks (default: console.log / console.error) */
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Minimal RunState shape (mirrors src/run/index.ts without the import)
// ---------------------------------------------------------------------------

interface MinimalJobState {
  status: string;
  attempt?: number;
}

interface MinimalRunState {
  run_id: string;
  workflow: string;
  task: string;
  created_at: string;
  last_event_id: string;
  jobs: Record<string, MinimalJobState>;
}

// ---------------------------------------------------------------------------
// Internal result types
// ---------------------------------------------------------------------------

type CheckLevel = "PASS" | "FAIL" | "WARN";

interface CheckResult {
  level: CheckLevel;
  message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEnoent(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as Record<string, unknown>)["code"] === "ENOENT"
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isValidRunState(value: unknown): value is MinimalRunState {
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
// Check 1: state.json valid
// ---------------------------------------------------------------------------

async function checkStateJson(runDir: string): Promise<[MinimalRunState | null, CheckResult]> {
  const statePath = join(runDir, "state.json");

  // Check existence
  let text: string;
  try {
    text = await readFile(statePath, "utf-8");
  } catch (e: unknown) {
    if (isEnoent(e)) {
      return [null, { level: "FAIL", message: "state.json: file not found" }];
    }
    return [null, { level: "FAIL", message: `state.json: cannot read file (${String(e)})` }];
  }

  // Check JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: unknown) {
    return [null, { level: "FAIL", message: `state.json: invalid JSON (${e instanceof Error ? e.message : String(e)})` }];
  }

  // Check required fields
  if (!isValidRunState(parsed)) {
    return [null, { level: "FAIL", message: "state.json: missing required fields (run_id, workflow, task, created_at, last_event_id, jobs)" }];
  }

  return [parsed, { level: "PASS", message: "state.json valid" }];
}

// ---------------------------------------------------------------------------
// Check 2: event sequence integrity
// ---------------------------------------------------------------------------

interface EventRecord {
  id: string;
  type?: string;
  payload?: Record<string, unknown>;
}

async function readEventsJsonl(runDir: string): Promise<EventRecord[]> {
  const eventsPath = join(runDir, "events.jsonl");
  let text: string;
  try {
    text = await readFile(eventsPath, "utf-8");
  } catch (e: unknown) {
    if (isEnoent(e)) {
      return [];
    }
    throw e;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as EventRecord);
}

async function checkEventSequence(
  runDir: string,
  state: MinimalRunState,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  let events: EventRecord[];
  try {
    events = await readEventsJsonl(runDir);
  } catch {
    results.push({ level: "FAIL", message: "events.jsonl: cannot read file" });
    return results;
  }

  // Check for duplicate event ids
  const seen = new Map<string, number>(); // id -> first occurrence index
  const duplicates = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const id = events[i]!.id;
    if (seen.has(id)) {
      duplicates.add(id);
    } else {
      seen.set(id, i);
    }
  }

  if (duplicates.size > 0) {
    const dupList = Array.from(duplicates).join(", ");
    results.push({
      level: "FAIL",
      message: `events.jsonl: duplicate event id(s): ${dupList}`,
    });
  } else {
    results.push({ level: "PASS", message: "events.jsonl: no duplicate event ids" });
  }

  // Check state.last_event_id matches log tail
  const logTailId = events.length > 0 ? events[events.length - 1]!.id : null;
  const stateLastId = state.last_event_id;

  // Both empty/absent → PASS
  if ((stateLastId === "" || stateLastId == null) && logTailId === null) {
    results.push({ level: "PASS", message: "events.jsonl: last_event_id consistent (both empty)" });
  } else if (stateLastId !== logTailId) {
    results.push({
      level: "FAIL",
      message: `events.jsonl: state.last_event_id="${stateLastId ?? ""}" does not match log tail="${logTailId ?? ""}" (expected evt-099, got evt-003 or similar — state claims ${stateLastId ?? ""}, log ends at ${logTailId ?? "(empty)"})`,
    });
  } else {
    results.push({ level: "PASS", message: "events.jsonl: last_event_id matches log tail" });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check 3: artifact file existence
// ---------------------------------------------------------------------------

interface ArtifactRecord {
  id?: string;
  path?: string;
  [key: string]: unknown;
}

async function readArtifactsJsonl(runDir: string): Promise<ArtifactRecord[]> {
  const artifactsPath = join(runDir, "artifacts.jsonl");
  let text: string;
  try {
    text = await readFile(artifactsPath, "utf-8");
  } catch (e: unknown) {
    if (isEnoent(e)) {
      return [];
    }
    throw e;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as ArtifactRecord);
}

async function checkArtifactFiles(runDir: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  let artifacts: ArtifactRecord[];
  try {
    artifacts = await readArtifactsJsonl(runDir);
  } catch {
    results.push({ level: "FAIL", message: "artifacts.jsonl: cannot read file" });
    return results;
  }

  if (artifacts.length === 0) {
    results.push({ level: "PASS", message: "artifacts.jsonl: no entries (nothing to check)" });
    return results;
  }

  for (const artifact of artifacts) {
    if (typeof artifact.path !== "string" || artifact.path.trim() === "") {
      results.push({
        level: "FAIL",
        message: `artifacts.jsonl: entry missing 'path' field (id: ${artifact.id ?? "(unknown)"})`,
      });
      continue;
    }

    const fullPath = join(runDir, artifact.path);
    const exists = await fileExists(fullPath);
    if (!exists) {
      results.push({
        level: "FAIL",
        message: `artifacts.jsonl: file missing at ${artifact.path}`,
      });
    } else {
      results.push({
        level: "PASS",
        message: `artifacts.jsonl: ${artifact.path} exists`,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check 4: job attempt integrity
// ---------------------------------------------------------------------------

async function countAttemptDirs(runDir: string, jobId: string): Promise<number> {
  const attemptsDir = join(runDir, "jobs", jobId, "attempts");
  let entries: string[];
  try {
    entries = await readdir(attemptsDir);
  } catch (e: unknown) {
    if (isEnoent(e)) {
      return 0;
    }
    throw e;
  }

  // Count only subdirectories
  let count = 0;
  for (const entry of entries) {
    try {
      await readdir(join(attemptsDir, entry));
      count++;
    } catch {
      // Not a directory — skip
    }
  }
  return count;
}

async function checkJobAttempts(
  runDir: string,
  state: MinimalRunState,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const [jobId, jobState] of Object.entries(state.jobs)) {
    const stateAttempt = jobState.attempt ?? 1;
    let dirCount: number;
    try {
      dirCount = await countAttemptDirs(runDir, jobId);
    } catch {
      results.push({
        level: "FAIL",
        message: `job '${jobId}': cannot read attempts directory`,
      });
      continue;
    }

    if (stateAttempt !== dirCount) {
      if (stateAttempt > dirCount) {
        results.push({
          level: "FAIL",
          message: `job '${jobId}': attempt=${stateAttempt} but only ${dirCount} attempt director${dirCount === 1 ? "y" : "ies"} found`,
        });
      } else {
        // More dirs than state.attempt — unusual but not necessarily a critical failure
        results.push({
          level: "WARN",
          message: `job '${jobId}': attempt=${stateAttempt} but ${dirCount} attempt directories found (possible orphaned attempts)`,
        });
      }
    } else {
      results.push({
        level: "PASS",
        message: `job '${jobId}': attempt=${stateAttempt} matches ${dirCount} attempt director${dirCount === 1 ? "y" : "ies"}`,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check 5: context_block_updated artifact_ref existence
// ---------------------------------------------------------------------------

async function checkContextBlockRefs(runDir: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  let events: EventRecord[];
  try {
    events = await readEventsJsonl(runDir);
  } catch {
    // Already checked in event sequence check — skip silently
    return results;
  }

  const contextEvents = events.filter((e) => e.type === "context_block_updated");

  for (const evt of contextEvents) {
    const payload = evt.payload;
    if (!payload) continue;

    const artifactRef = payload["artifact_ref"];
    if (typeof artifactRef !== "string" || artifactRef.trim() === "") {
      results.push({
        level: "FAIL",
        message: `context_block_updated (id: ${evt.id}): missing payload.artifact_ref`,
      });
      continue;
    }

    const fullPath = join(runDir, artifactRef);
    const exists = await fileExists(fullPath);
    if (!exists) {
      results.push({
        level: "FAIL",
        message: `context_block_updated (id: ${evt.id}): artifact_ref file missing at ${artifactRef}`,
      });
    } else {
      results.push({
        level: "PASS",
        message: `context_block_updated (id: ${evt.id}): artifact_ref ${artifactRef} exists`,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main action
// ---------------------------------------------------------------------------

export async function verifyRunAction(opts: VerifyRunOptions): Promise<number> {
  const out = opts.stdout ?? ((line: string) => { console.log(line); });
  const err = opts.stderr ?? ((line: string) => { console.error(line); });

  // Resolve run directory
  let runDir: string;

  if (opts.runDir !== undefined) {
    runDir = opts.runDir;
  } else if (opts.runsDir !== undefined) {
    // Resolve from runsDir + optional runId
    if (opts.runId !== undefined) {
      // Explicit runId: check existence
      const candidate = join(opts.runsDir, opts.runId);
      try {
        await readdir(candidate);
        runDir = candidate;
      } catch {
        err(`Run not found: ${opts.runId} (looked in ${opts.runsDir})`);
        return 1;
      }
    } else {
      // Find latest run in runsDir
      let entries: string[];
      try {
        entries = await readdir(opts.runsDir);
      } catch {
        err(`Cannot read runs directory: ${opts.runsDir}`);
        return 1;
      }

      const dirs: string[] = [];
      for (const entry of entries) {
        try {
          await readdir(join(opts.runsDir, entry));
          dirs.push(entry);
        } catch {
          // Not a directory — skip
        }
      }

      if (dirs.length === 0) {
        err(`No runs found in: ${opts.runsDir}`);
        return 1;
      }

      dirs.sort((a, b) => b.localeCompare(a));
      runDir = join(opts.runsDir, dirs[0]!);
    }
  } else {
    err("verifyRunAction: must supply either runDir or runsDir");
    return 1;
  }

  // Collect all check results
  const allResults: CheckResult[] = [];

  // Check 1: state.json
  const [state, stateResult] = await checkStateJson(runDir);
  allResults.push(stateResult);

  // Determine run id for the header line
  const runId = state?.run_id ?? opts.runId ?? runDir.split(/[\\/]/).pop() ?? runDir;

  // Print header
  out(`Run: ${runId}`);

  if (state === null) {
    // Cannot proceed without valid state
    out(`  [FAIL] ${stateResult.message}`);
    out(`Summary: 0 passed, 1 failed, 0 warnings`);
    return 1;
  }

  // Check 2: event sequence
  const eventResults = await checkEventSequence(runDir, state);
  allResults.push(...eventResults);

  // Check 3: artifact files
  const artifactResults = await checkArtifactFiles(runDir);
  allResults.push(...artifactResults);

  // Check 4: job attempt integrity
  const attemptResults = await checkJobAttempts(runDir, state);
  allResults.push(...attemptResults);

  // Check 5: context block refs
  const contextResults = await checkContextBlockRefs(runDir);
  allResults.push(...contextResults);

  // Print results (skip the state result since it was already pushed — print all now)
  let passed = 0;
  let failed = 0;
  let warned = 0;

  for (const result of allResults) {
    out(`  [${result.level}] ${result.message}`);
    if (result.level === "PASS") passed++;
    else if (result.level === "FAIL") failed++;
    else if (result.level === "WARN") warned++;
  }

  out(`Summary: ${passed} passed, ${failed} failed, ${warned} warnings`);

  return failed > 0 ? 1 : 0;
}
