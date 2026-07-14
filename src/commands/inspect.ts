/**
 * `zigma-flow inspect` command handler.
 *
 * Unified inspection command that consolidates `status`, `show`, `events`,
 * and `artifacts` into a single command with selectable output views.
 *
 * Reference: docs/prd.md §17 (CLI commands).
 * Issue #204 — v0.6 command consolidation.
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  readActiveRun,
  LocalStateStore,
  type RunState,
} from "../run/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import {
  ConfigError,
  FilesystemError,
  UserInputError,
} from "../utils/index.js";
import { findRun } from "./status.js";

// ---------------------------------------------------------------------------
// InspectOptions
// ---------------------------------------------------------------------------

export interface InspectOptions {
  /** Explicit run id (positional). */
  runId?: string;
  /** Inspect the most recent run. */
  latest?: boolean;
  /** Brief status summary (default). */
  summary?: boolean;
  /** Show all jobs with status. */
  jobs?: boolean;
  /** Show event log. */
  events?: boolean;
  /** List artifacts. */
  artifacts?: boolean;
  /** Output as JSON (for programmatic use). */
  json?: boolean;
  /** Maximum events to show (default: 20). */
  eventLimit?: number;
  /** Filter artifacts to a specific job. */
  artifactJob?: string;
  /** Project root directory. */
  projectRoot?: string;
  /** Injectable stdout function for testing. */
  stdout?: (line: string) => void;
  /** Injectable stderr function for testing. */
  stderr?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// InspectResult (public return for tests)
// ---------------------------------------------------------------------------

export interface InspectResult {
  runId: string;
  runDir: string;
  state: RunState | null;
  events: EventEnvelope[];
  artifacts: ArtifactEntry[];
}

interface EventEnvelope {
  id: string;
  type: string;
  run_id: string;
  timestamp: string;
  producer?: string;
  job?: string | null;
  step?: string | null;
  attempt?: number | null;
  payload?: Record<string, unknown>;
}

interface ArtifactEntry {
  id: string;
  kind: string;
  path: string;
  size: number;
  producer?: { job?: string; step?: string; attempt?: number };
}

// ---------------------------------------------------------------------------
// inspectAction
// ---------------------------------------------------------------------------

export async function inspectAction(
  opts: InspectOptions,
): Promise<InspectResult> {
  const print = opts.stdout ?? ((line: string) => { console.log(line); });
  const printErr = opts.stderr ?? ((line: string) => { console.error(line); });
  const projectRoot = opts.projectRoot ?? process.cwd();

  const runsDir = join(projectRoot, ".zigma-flow", "runs");

  // ── 1. Resolve run id ─────────────────────────────────────────────────

  let runId: string;
  if (opts.runId !== undefined) {
    runId = opts.runId;
  } else if (opts.latest) {
    const runDir = await findRun(runsDir);
    // Extract runId from runDir basename
    const parts = runDir.replace(/\\/g, "/").split("/");
    runId = parts[parts.length - 1]!;
  } else {
    // Default: try active_run, fall back to latest
    const activeRunId = await readActiveRun(projectRoot);
    if (activeRunId !== null) {
      runId = activeRunId;
    } else {
      try {
        const runDir = await findRun(runsDir);
        const parts = runDir.replace(/\\/g, "/").split("/");
        runId = parts[parts.length - 1]!;
      } catch {
        throw new ConfigError(
          "No run id provided and no active or recent runs found.",
          { suggestion: "Use 'zigma-flow invoke <workflow> --task \"...\"' to create a run, or specify a run-id." },
        );
      }
    }
  }

  // Security guard: prevent path traversal
  const runDir = resolve(runsDir, runId);
  const runsPrefix = resolve(runsDir) + sep;
  if (!runDir.startsWith(runsPrefix) && runDir !== resolve(runsDir)) {
    throw new UserInputError(`Invalid run id: ${runId}`);
  }

  // ── 2. Read state.json ───────────────────────────────────────────────

  const stateStore = new LocalStateStore();
  const state = await stateStore.readSnapshot(runDir);

  if (state === null) {
    throw new FilesystemError(`state.json not found for run "${runId}" in: ${runDir}`);
  }

  // ── 3. Read events.jsonl ─────────────────────────────────────────────

  let events: EventEnvelope[] = [];
  try {
    const eventsText = await readFile(join(runDir, "events.jsonl"), "utf-8");
    events = eventsText
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => { try { return JSON.parse(l) as EventEnvelope; } catch { return null; } })
      .filter((e): e is EventEnvelope => e !== null);
  } catch {
    // Missing events.jsonl — fine
  }

  // ── 4. Read artifacts.jsonl ──────────────────────────────────────────

  let artifacts: ArtifactEntry[] = [];
  try {
    const artifactsText = await readFile(join(runDir, "artifacts.jsonl"), "utf-8");
    artifacts = artifactsText
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => { try { return JSON.parse(l) as ArtifactEntry; } catch { return null; } })
      .filter((a): a is ArtifactEntry => a !== null);
  } catch {
    // Missing artifacts.jsonl — fine
  }

  // ── 5. Render output ─────────────────────────────────────────────────

  const renderSummary = opts.summary !== false; // default true
  const renderJobs = opts.jobs === true;
  const renderEvents = opts.events === true;
  const renderArtifacts = opts.artifacts === true;
  const renderJson = opts.json === true;

  // If no specific views are requested, show summary
  const showDefaults = !renderJobs && !renderEvents && !renderArtifacts && !renderJson;
  const showSummary = showDefaults || renderSummary || renderJson;

  if (renderJson) {
    // JSON output: all data in machine-readable form
    const output = {
      runId,
      workflow: state.workflow,
      task: state.task,
      created_at: state.created_at,
      status: state.status,
      jobs: state.jobs,
      events: events.slice(opts.eventLimit ? -opts.eventLimit : undefined),
      artifacts: opts.artifactJob
        ? artifacts.filter((a) => a.producer?.job === opts.artifactJob)
        : artifacts,
    };
    print(JSON.stringify(output, null, 2));
    return { runId, runDir, state, events, artifacts };
  }

  if (showSummary) {
    // Try to load workflow for richer summary
    let workflowName = state.workflow ?? "[unknown]";
    try {
      const runYmlText = await readFile(join(runDir, "run.yml"), "utf-8");
      const runMeta = parseYaml(runYmlText) as { workflow?: { path?: string; name?: string } };
      if (runMeta?.workflow?.name) {
        workflowName = runMeta.workflow.name;
      }
    } catch {
      // Fine
    }

    print(`Run:      ${runId}`);
    print(`Workflow: ${workflowName}`);
    print(`Task:     ${state.task}`);
    print(`Created:  ${state.created_at}`);
    print(`Status:   ${state.status}`);
    print("");

    // Brief job summary
    const statusCounts: Record<string, number> = {};
    for (const job of Object.values(state.jobs)) {
      statusCounts[job.status] = (statusCounts[job.status] ?? 0) + 1;
    }
    print("Jobs:");
    for (const [status, count] of Object.entries(statusCounts)) {
      print(`  ${status}: ${count}`);
    }
    print("");

    // Awaiting human input
    const awaitingHuman = Object.entries(state.jobs)
      .filter(([, js]) => js.step_status === "awaiting_human");
    if (awaitingHuman.length > 0) {
      print("Awaiting human input:");
      for (const [jid, job] of awaitingHuman) {
        print(`  ${jid} / ${job.current_step ?? "?"}`);
      }
      print("");
    }
  }

  if (renderJobs) {
    print("Job details:");
    for (const [jobId, jobState] of Object.entries(state.jobs)) {
      const parts = [`  ${jobId}: ${jobState.status}`];
      if (jobState.current_step) parts.push(`step=${jobState.current_step}`);
      if (jobState.attempt) parts.push(`attempt=${jobState.attempt}`);
      if (jobState.step_status) parts.push(`step_status=${jobState.step_status}`);
      print(parts.join("  "));
    }
    print("");
  }

  if (renderEvents) {
    const limit = opts.eventLimit ?? 20;
    const shownEvents = limit === 0 ? [] : events.slice(-limit);
    print("Events:");
    for (const event of shownEvents) {
      const job = event.job ?? "-";
      const step = event.step ?? "-";
      print(`  ${event.id}  ${event.timestamp}  ${event.type}  ${job}/${step}`);
    }
    print("");
  }

  if (renderArtifacts) {
    let filtered = artifacts;
    if (opts.artifactJob) {
      filtered = artifacts.filter((a) => a.producer?.job === opts.artifactJob);
    }
    if (filtered.length > 0) {
      print("Artifacts:");
      for (const artifact of filtered) {
        print(`  ${artifact.id}  ${artifact.kind}  ${artifact.path}  ${artifact.size}`);
      }
    } else {
      print("Artifacts: (none)");
    }
    print("");
  }

  return { runId, runDir, state, events, artifacts };
}
