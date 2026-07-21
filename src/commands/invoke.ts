/**
 * `zigma-flow invoke` command handler.
 *
 * Unified command that creates/resumes a workflow run and executes it to
 * completion (or until paused/failed). Consolidates the workflow lifecycle
 * that was previously split across `run`, `run-all`, `prompt`, `step`,
 * `check`, and `next`.
 *
 * Internally delegates to the Engine's `runAll` function — invoke does NOT
 * duplicate the run loop.
 *
 * v0.7 (ISSUE #254): Added --json, --event-file, --context-file options for
 * machine-readable platform integration.
 *
 * Reference: docs/prd.md §17 (CLI commands).
 * Issue #204 — v0.6 command consolidation.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadAgentConfig, resolveBackendForStep, createBackend, type StepBackendOverride } from "../agent/config.js";
import { runAll, type RunAllOpts, type RunAllSummary } from "../engine/runAll.js";
import { loadWorkflowFile } from "../workflow/index.js";
import { UserInputError } from "../utils/index.js";
import { validateCallerContext } from "../caller-context.js";
import type { CallerContext } from "../caller-context.js";
import { resolveWorkflowPath } from "./run.js";
import {
  INVOKE_CONTRACT_VERSION,
  mapRunAllStatusToInvokeStatus,
  statusToExitCode,
  type InvokeJsonOutput,
  type InvokeJsonStatus,
  type PausedGateInfo,
} from "./invoke-schema.js";

// ---------------------------------------------------------------------------
// InvokeOptions
// ---------------------------------------------------------------------------

export interface InvokeOptions {
  /** Task description for new runs (mutually exclusive with resume). */
  task?: string;
  /** Run ID to resume (mutually exclusive with task). */
  resume?: string;
  /** CLI override for the agent backend name. */
  backend?: string;
  /** Maximum concurrent job count (default 4). */
  parallelism?: number;
  /** Enable fail-fast abort propagation. */
  failFast?: boolean;
  /** Additional named inputs from CLI --input flags. */
  inputs?: Record<string, string>;
  /** Project root directory (defaults to process.cwd()). */
  projectRoot?: string;
  /** Dry-run: validate and plan without executing. */
  dryRun?: boolean;
  /** Trace: verbose event-by-event output. */
  trace?: boolean;
  /** Pause before executing a specific job.step (debugging). */
  pauseBefore?: string;
  /** Stop after completing a specific job.step (debugging). */
  stopAfter?: string;
  /** Save all prompts without pausing (debugging mode). */
  saveAllPrompts?: boolean;
  /** JSON mode: machine-readable output to stdout, logs to stderr (ISSUE #254). */
  json?: boolean;
  /** Path to NDJSON event sink file (ISSUE #254). */
  eventFile?: string;
  /** Path to caller context JSON file (ISSUE #254). */
  contextFile?: string;
  /** Injectable stdout function for testing. */
  stdout?: (line: string) => void;
  /** Injectable stderr function for testing. */
  stderr?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// InvokeSummary (public return type for tests)
// ---------------------------------------------------------------------------

export interface InvokeSummary {
  runId: string;
  status: string | undefined;
  jobs: Array<{ id: string; status: string; attempts: number }>;
  iterations: number;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// invokeAction
// ---------------------------------------------------------------------------

export async function invokeAction(
  workflowPath: string,
  options: InvokeOptions,
): Promise<InvokeSummary> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const absWorkflowPath = await resolveWorkflowPath(workflowPath, projectRoot);
  const zigmaflowDir = projectRoot;
  const runsDir = join(projectRoot, ".zigma-flow", "runs");
  const skillLockPath = join(projectRoot, ".zigma-flow", "skill-lock.json");

  const print = options.stdout ?? ((line: string) => { console.log(line); });
  const printErr = options.stderr ?? ((line: string) => { console.error(line); });

  const isJson = options.json === true;

  // ── Dry-run: validate and plan without executing ──────────────────────

  if (options.dryRun) {
    const wf = await loadWorkflowFile(absWorkflowPath);
    if (isJson) {
      print(JSON.stringify({
        contractVersion: INVOKE_CONTRACT_VERSION,
        runId: "(dry-run)",
        status: "running" as InvokeJsonStatus,
        exitCode: 0,
        pausedGate: null,
        artifacts: [],
        eventLogUri: "",
      } satisfies InvokeJsonOutput));
      return {
        runId: "(dry-run)",
        status: "valid",
        jobs: Object.entries(wf.jobs).map(([id, job]) => ({
          id,
          status: "planned",
          attempts: 0,
        })),
        iterations: 0,
        dryRun: true,
      };
    }
    console.log(`Workflow: ${wf.name} (v${wf.version})`);
    console.log(`Jobs: ${Object.keys(wf.jobs).length}`);
    for (const [id, job] of Object.entries(wf.jobs)) {
      const stepTypes = job.steps.map((s) => s.type).join(", ");
      console.log(`  ${id}: ${job.steps.length} step(s) [${stepTypes}]`);
      if (job.needs && job.needs.length > 0) {
        console.log(`    needs: ${job.needs.join(", ")}`);
      }
    }
    console.log("\nDry-run: workflow is valid and ready to invoke.");
    return {
      runId: "(dry-run)",
      status: "valid",
      jobs: Object.entries(wf.jobs).map(([id, job]) => ({
        id,
        status: "planned",
        attempts: 0,
      })),
      iterations: 0,
      dryRun: true,
    };
  }

  // ── Validate: at least one of task or resume required ─────────────────

  if (options.task === undefined && options.resume === undefined) {
    throw new UserInputError(
      "Either --task <description> or --resume <run-id> is required.",
      { suggestion: "Usage: zigma-flow invoke <workflow> --task \"description\"" },
    );
  }

  if (options.task !== undefined && options.resume !== undefined) {
    throw new UserInputError(
      "--task and --resume are mutually exclusive.",
      { suggestion: "Use either --task for a new run or --resume to continue a run." },
    );
  }

  // ── Validate pause-before / stop-after format ─────────────────────────

  if (options.pauseBefore !== undefined) {
    const parts = options.pauseBefore.split(".");
    if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) {
      throw new UserInputError(
        `--pause-before must be in "job.step" format, got: "${options.pauseBefore}"`,
        { suggestion: "Example: --pause-before plan.plan" },
      );
    }
  }

  if (options.stopAfter !== undefined) {
    const parts = options.stopAfter.split(".");
    if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) {
      throw new UserInputError(
        `--stop-after must be in "job.step" format, got: "${options.stopAfter}"`,
        { suggestion: "Example: --stop-after implement.implement" },
      );
    }
  }

  // ── Parse caller context file (ISSUE #254) ────────────────────────────

  let callerContext: CallerContext | undefined;
  if (options.contextFile !== undefined) {
    try {
      const raw = await readFile(options.contextFile, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new UserInputError(
          `--context-file contains invalid JSON: ${options.contextFile}`,
          { suggestion: "Provide a valid JSON file with caller context." },
        );
      }
      callerContext = validateCallerContext(parsed);
    } catch (err: unknown) {
      if (isJson) {
        print(JSON.stringify({
          contractVersion: INVOKE_CONTRACT_VERSION,
          runId: "(error)",
          status: "failed" as InvokeJsonStatus,
          exitCode: 1,
          pausedGate: null,
          artifacts: [],
          eventLogUri: "",
        }));
        return { runId: "(error)", status: "failed", jobs: [], iterations: 0, dryRun: false };
      }
      throw err;
    }
  }

  // ── Resolve event file path (ISSUE #254) ──────────────────────────────

  const eventSinkPath = options.eventFile !== undefined
    ? resolve(options.eventFile)
    : undefined;

  // ── 1. Load agent config and resolve backend ──────────────────────────

  const agentConfig = await loadAgentConfig(zigmaflowDir);
  const defaultResolved = resolveBackendForStep(agentConfig, undefined, options.backend);

  if (!isJson) {
    console.log(`Agent backend: ${defaultResolved.name}`);
    console.log(`Command: ${defaultResolved.config.command} ${(defaultResolved.config.args ?? []).join(" ")}`);
  }

  // ── 2. SIGINT handler ─────────────────────────────────────────────────

  const abortController = new AbortController();
  const onSigint = (): void => {
    if (!isJson) {
      console.log("\nSIGINT received — stopping run...");
    }
    abortController.abort();
    process.off("SIGINT", onSigint);
  };
  process.on("SIGINT", onSigint);

  // ── 3. Delegate to the Engine's runAll ────────────────────────────────

  const runAllOpts: RunAllOpts = {
    ...(options.resume !== undefined ? { runId: options.resume } : {}),
    ...(options.task !== undefined ? { task: options.task } : {}),
    workflowPath: absWorkflowPath,
    runsDir,
    zigmaflowDir,
    skillLockPath,
    backendResolver: (stepBackend?: string | StepBackendOverride) => {
      const stepDef = stepBackend !== undefined ? { backend: stepBackend } : undefined;
      const resolved = resolveBackendForStep(agentConfig, stepDef, options.backend);
      return createBackend(resolved.name, resolved.config);
    },
    signal: abortController.signal,
    ...(options.trace
      ? {
          onEvent: (event) => {
            printErr(`  [${event.id}] ${event.type}${event.job ? ` job=${event.job}` : ""}${event.step ? ` step=${event.step}` : ""}`);
            if (event.payload) {
              const payload = { ...event.payload };
              delete (payload as Record<string, unknown>)["prompt_artifact"];
              delete (payload as Record<string, unknown>)["stdout_artifact"];
              delete (payload as Record<string, unknown>)["stderr_artifact"];
              delete (payload as Record<string, unknown>)["invocation_artifact"];
              delete (payload as Record<string, unknown>)["report_artifact"];
              delete (payload as Record<string, unknown>)["step_artifact_dir"];
              const remaining = Object.keys(payload as Record<string, unknown>);
              if (remaining.length > 0) {
                printErr(`           payload: ${JSON.stringify(payload)}`);
              }
            }
          },
        }
      : {}),
    ...(options.parallelism !== undefined ? { parallelism: options.parallelism } : {}),
    ...(options.failFast !== undefined ? { failFast: options.failFast } : {}),
    ...(options.inputs !== undefined ? { inputs: options.inputs } : {}),
    ...(options.pauseBefore !== undefined ? { pauseBefore: options.pauseBefore } : {}),
    ...(options.stopAfter !== undefined ? { stopAfter: options.stopAfter } : {}),
    ...(options.saveAllPrompts !== undefined ? { saveAllPrompts: options.saveAllPrompts } : {}),
    ...(eventSinkPath !== undefined ? { eventSinkPath } : {}),
    ...(callerContext !== undefined ? { callerContext } : {}),
  };

  let summary: RunAllSummary;
  try {
    summary = await runAll(runAllOpts);
  } catch (err: unknown) {
    if (isJson) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      print(JSON.stringify({
        contractVersion: INVOKE_CONTRACT_VERSION,
        runId: "(error)",
        status: "failed" as InvokeJsonStatus,
        exitCode: 1,
        pausedGate: null,
        artifacts: [],
        eventLogUri: "",
      }));
      return { runId: "(error)", status: "failed", jobs: [], iterations: 0, dryRun: false };
    }
    throw err;
  }

  // ── 4. Output mode ────────────────────────────────────────────────────

  if (isJson) {
    const hasPausedGate = summary.pausedGate !== undefined;
    const status = mapRunAllStatusToInvokeStatus(summary.status, hasPausedGate);
    const exitCode = statusToExitCode(status);

    // Map paused gate if present
    let pausedGate: PausedGateInfo | null = null;
    if (summary.pausedGate !== undefined) {
      pausedGate = {
        jobId: summary.pausedGate.jobId,
        stepId: summary.pausedGate.stepId,
        prompt: summary.pausedGate.prompt,
        ...(summary.pausedGate.externalGateId !== undefined ? { externalGateId: summary.pausedGate.externalGateId } : {}),
        ...(summary.pausedGate.inputSchema !== undefined ? { inputSchema: summary.pausedGate.inputSchema } : {}),
        ...(summary.pausedGate.deadline !== undefined ? { deadline: summary.pausedGate.deadline } : {}),
      };
    }

    // Read artifacts
    let artifacts: InvokeJsonOutput["artifacts"] = [];
    try {
      const artifactsText = await readFile(join(runsDir, summary.runId, "artifacts.jsonl"), "utf-8");
      artifacts = artifactsText
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try {
            const a = JSON.parse(l) as { id?: string; kind?: string; path?: string; size?: number };
            return {
              id: a.id ?? "?",
              kind: a.kind ?? "?",
              path: a.path ?? "?",
              size: a.size ?? 0,
            };
          } catch {
            return null;
          }
        })
        .filter((a): a is InvokeJsonOutput["artifacts"][number] => a !== null);
    } catch {
      // No artifacts file — fine
    }

    const eventLogPath = resolve(runsDir, summary.runId, "events.jsonl");
    const eventLogUri = pathToFileURL(eventLogPath).href;

    const output: InvokeJsonOutput = {
      contractVersion: INVOKE_CONTRACT_VERSION,
      runId: summary.runId,
      status,
      exitCode,
      pausedGate,
      artifacts,
      eventLogUri,
    };

    print(JSON.stringify(output));
    return {
      runId: summary.runId,
      status: summary.status,
      jobs: summary.jobs,
      iterations: summary.iterations,
      dryRun: false,
    };
  }

  // ── Interactive mode: print final status ──────────────────────────────

  const statusLine = summary.status ?? "(max iterations reached)";
  console.log(`\nRun ${summary.runId} finished with status: ${statusLine}`);

  if (summary.jobs.length > 0) {
    console.log("\nJob summary:");
    for (const job of summary.jobs) {
      console.log(`  ${job.id}: ${job.status} (attempt ${job.attempts})`);
    }
  }

  return {
    runId: summary.runId,
    status: summary.status,
    jobs: summary.jobs,
    iterations: summary.iterations,
    dryRun: false,
  };
}
