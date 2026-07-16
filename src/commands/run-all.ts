/**
 * `zigma-flow run-all` command handler.
 *
 * Thin CLI shell that loads agent configuration, resolves the backend, and
 * delegates to the Engine's `runAll` function. Config-loading helpers have
 * been extracted into `src/agent/config.ts` (WF-P13-BACKEND-CONFIG).
 *
 * Reference: docs/prd.md §24 (Agent Adapter).
 * WF-P13-ENGINE-RUNALL Step 2 / WF-P13-RESUME-CANCEL Step 2.
 */

import { join } from "node:path";

import type { AgentBackend } from "../agent/index.js";
import { loadAgentConfig, resolveBackendForStep, createBackend, type StepBackendOverride } from "../agent/config.js";
import { runAll, type RunAllOpts, type RunAllSummary } from "../engine/runAll.js";
import { deprecationWarn } from "../utils/index.js";
import { resolveWorkflowPath } from "./run.js";

// ---------------------------------------------------------------------------
// runAllAction options
// ---------------------------------------------------------------------------

export interface RunAllOptions {
  /** Task description for new runs (mutually exclusive with resume). */
  task?: string;
  /** Run ID to resume (mutually exclusive with task). */
  resume?: string;
  /** CLI override for the agent backend name. */
  backend?: string;
  /** Maximum concurrent job count (default 4, AD-P14-007). */
  parallelism?: number;
  /** Enable fail-fast abort propagation (default false, AD-P14-005). */
  failFast?: boolean;
  /** Additional named inputs from CLI --input flags. */
  inputs?: Record<string, string>;
  /** Project root directory (defaults to process.cwd()). */
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// runAllAction
// ---------------------------------------------------------------------------

export async function runAllAction(
  workflowPath: string,
  options: RunAllOptions,
): Promise<void> {
  deprecationWarn("'zigma-flow run-all' is deprecated", "zigma-flow invoke");
  const projectRoot = options.projectRoot ?? process.cwd();
  const absWorkflowPath = await resolveWorkflowPath(workflowPath, projectRoot);
  const zigmaflowDir = projectRoot;
  const runsDir = join(projectRoot, ".zigma-flow", "runs");
  const skillLockPath = join(projectRoot, ".zigma-flow", "skill-lock.json");

  // ── 1. Load agent config and resolve backend ────────────────────────────

  const agentConfig = await loadAgentConfig(zigmaflowDir);
  const defaultResolved = resolveBackendForStep(agentConfig, undefined, options.backend);

  console.log(`Agent backend: ${defaultResolved.name}`);
  console.log(`Command: ${defaultResolved.config.command} ${(defaultResolved.config.args ?? []).join(" ")}`);

  // ── 2. SIGINT handler (WF-P13-RESUME-CANCEL) ──────────────────────────

  const abortController = new AbortController();
  const onSigint = (): void => {
    console.log("\nSIGINT received — stopping run...");
    abortController.abort();
    process.off("SIGINT", onSigint);
  };
  process.on("SIGINT", onSigint);

  // ── 3. Delegate to the Engine's runAll ──────────────────────────────────

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
    onEvent: (event) => {
      console.log(`  [${event.id}] ${event.type}`);
    },
    ...(options.parallelism !== undefined ? { parallelism: options.parallelism } : {}),
    ...(options.failFast !== undefined ? { failFast: options.failFast } : {}),
    ...(options.inputs !== undefined ? { inputs: options.inputs } : {}),
  };

  const summary: RunAllSummary = await runAll(runAllOpts);

  // ── 4. Print final status ──────────────────────────────────────────────

  const statusLine = summary.status ?? "(max iterations reached)";
  console.log(`\nRun ${summary.runId} finished with status: ${statusLine}`);

  if (summary.jobs.length > 0) {
    console.log("\nJob summary:");
    for (const job of summary.jobs) {
      const activation = ""; // job-level activation not tracked in RunAllSummary
      console.log(`  ${job.id}: ${job.status}${activation} (attempt ${job.attempts})`);
    }
  }
}
