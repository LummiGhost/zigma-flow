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

import { join, resolve } from "node:path";

import type { AgentBackend } from "../agent/index.js";
import { loadAgentConfig, resolveBackendForStep, createBackend } from "../agent/config.js";
import { runAll, type RunAllOpts, type RunAllSummary } from "../engine/runAll.js";

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
}

// ---------------------------------------------------------------------------
// runAllAction
// ---------------------------------------------------------------------------

export async function runAllAction(
  workflowPath: string,
  options: RunAllOptions,
): Promise<void> {
  const absWorkflowPath = resolve(workflowPath);
  const projectRoot = process.cwd();
  const zigmaflowDir = projectRoot;
  const runsDir = join(projectRoot, ".zigma-flow", "runs");
  const skillLockPath = join(projectRoot, ".zigma-flow", "skill-lock.json");

  // ── 1. Load agent config and resolve backend ────────────────────────────

  const agentConfig = await loadAgentConfig(zigmaflowDir);
  const resolved = resolveBackendForStep(agentConfig, undefined, options.backend);
  const backend = createBackend(resolved.name, resolved.config);

  console.log(`Agent backend: ${resolved.name}`);
  console.log(`Command: ${resolved.config.command} ${(resolved.config.args ?? []).join(" ")}`);

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
    backendResolver: () => backend,
    signal: abortController.signal,
    onEvent: (event) => {
      console.log(`  [${event.id}] ${event.type}`);
    },
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
