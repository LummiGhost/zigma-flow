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
 * Reference: docs/prd.md §17 (CLI commands).
 * Issue #204 — v0.6 command consolidation.
 */

import { join } from "node:path";

import { loadAgentConfig, resolveBackendForStep, createBackend } from "../agent/config.js";
import { runAll, type RunAllOpts, type RunAllSummary } from "../engine/runAll.js";
import { loadWorkflowFile } from "../workflow/index.js";
import { UserInputError } from "../utils/index.js";
import { resolveWorkflowPath } from "./run.js";

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

  // ── Dry-run: validate and plan without executing ──────────────────────

  if (options.dryRun) {
    const wf = await loadWorkflowFile(absWorkflowPath);
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

  // ── 1. Load agent config and resolve backend ──────────────────────────

  const agentConfig = await loadAgentConfig(zigmaflowDir);
  const resolved = resolveBackendForStep(agentConfig, undefined, options.backend);
  const backend = createBackend(resolved.name, resolved.config);

  console.log(`Agent backend: ${resolved.name}`);
  console.log(`Command: ${resolved.config.command} ${(resolved.config.args ?? []).join(" ")}`);

  // ── 2. SIGINT handler ─────────────────────────────────────────────────

  const abortController = new AbortController();
  const onSigint = (): void => {
    console.log("\nSIGINT received — stopping run...");
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
    backendResolver: () => backend,
    signal: abortController.signal,
    ...(options.trace
      ? {
          onEvent: (event) => {
            console.log(`  [${event.id}] ${event.type}${event.job ? ` job=${event.job}` : ""}${event.step ? ` step=${event.step}` : ""}`);
            if (event.payload) {
              const payload = { ...event.payload };
              // Keep output concise — omit artifacts for trace readability
              delete (payload as Record<string, unknown>)["prompt_artifact"];
              delete (payload as Record<string, unknown>)["stdout_artifact"];
              delete (payload as Record<string, unknown>)["stderr_artifact"];
              delete (payload as Record<string, unknown>)["invocation_artifact"];
              delete (payload as Record<string, unknown>)["report_artifact"];
              delete (payload as Record<string, unknown>)["step_artifact_dir"];
              const remaining = Object.keys(payload as Record<string, unknown>);
              if (remaining.length > 0) {
                console.log(`           payload: ${JSON.stringify(payload)}`);
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
  };

  const summary: RunAllSummary = await runAll(runAllOpts);

  // ── 4. Print final status ────────────────────────────────────────────

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
