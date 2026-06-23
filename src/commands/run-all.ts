/**
 * `zigma-flow run-all` command handler.
 *
 * Automates the full workflow execution loop:
 *   1. Creates a run.
 *   2. Loops through ready jobs, invoking the agent backend for agent steps
 *      and executing script/check/router steps directly.
 *   3. Stops when the run reaches a terminal state (completed, blocked, failed).
 *
 * Reference: docs/prd.md §24 (Agent Adapter).
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { AgentBackend } from "../agent/index.js";
import { agentFactory, ClaudeCodeBackend } from "../agent/index.js";
import { buildContext } from "../context/index.js";
import { buildPromptPacket, renderPromptPacket, writePromptArtifact } from "../prompt/index.js";
import { acceptAgentReport } from "../engine/accept.js";
import { createRun, executeCurrentStep } from "../engine/index.js";
import { advanceJob } from "../engine/index.js";
import {
  JsonlEventWriter,
  LocalStateStore,
  SystemClock,
  writeActiveRun,
  type Clock,
  type RunState,
} from "../run/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import {
  ConfigError,
  FilesystemError,
  StateError,
  UserInputError,
  ValidationError,
} from "../utils/index.js";
import { nextEventId } from "../events/index.js";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

interface AgentBackendConfigEntry {
  command: string;
  args?: string[];
  timeout?: number;
  env?: Record<string, string>;
}

interface AgentConfig {
  backend: string;
  backends: Record<string, AgentBackendConfigEntry>;
}

interface ZigmaConfig {
  tool_version?: string;
  active_run?: string | null;
  agent?: AgentConfig;
}

// ---------------------------------------------------------------------------
// runAllAction options
// ---------------------------------------------------------------------------

export interface RunAllOptions {
  task: string;
  backend?: string;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

async function loadAgentConfig(zigmaflowDir: string): Promise<AgentConfig> {
  const configPath = join(zigmaflowDir, ".zigma-flow", "config.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    return { backend: "claude-code", backends: {} };
  }

  let parsed: ZigmaConfig;
  try {
    parsed = JSON.parse(raw) as ZigmaConfig;
  } catch {
    return { backend: "claude-code", backends: {} };
  }

  return parsed.agent ?? { backend: "claude-code", backends: {} };
}

function defaultClaudeCodeConfig(): AgentBackendConfigEntry {
  return { command: "claude", args: ["-p"], timeout: 600_000 };
}

function resolveBackendConfig(
  agentConfig: AgentConfig,
  backendName: string,
): { name: string; config: AgentBackendConfigEntry } {
  const backends = agentConfig.backends ?? {};
  const isBuiltin = backendName === "claude-code";

  if (isBuiltin && !(backendName in backends)) {
    return { name: backendName, config: defaultClaudeCodeConfig() };
  }

  const entry = backends[backendName];
  if (entry === undefined) {
    throw new ConfigError(
      `Agent backend "${backendName}" is not configured. ` +
      `Available backends: ${Object.keys(backends).join(", ") || "(none)"}`,
      {
        details: { backendName, available: Object.keys(backends) },
        suggestion: `Add a "backends.${backendName}" entry to .zigma-flow/config.json.`,
      }
    );
  }

  return { name: backendName, config: entry };
}

// ---------------------------------------------------------------------------
// Agent backend resolution
// ---------------------------------------------------------------------------

function createBackendInstance(name: string, config: AgentBackendConfigEntry): AgentBackend {
  // Register ClaudeCodeBackend as the default built-in
  if (!agentFactory.get("claude-code")) {
    agentFactory.register("claude-code", ClaudeCodeBackend);
  }

  return agentFactory.createBackend(name, {
    command: config.command,
    ...(config.args !== undefined ? { args: config.args } : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
    ...(config.env !== undefined ? { env: config.env } : {}),
  });
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

  const clock = new SystemClock();
  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // ── 1. Load agent config and resolve backend ────────────────────────────

  const agentConfig = await loadAgentConfig(zigmaflowDir);
  const backendName = options.backend ?? agentConfig.backend;
  const { config: backendConfig } = resolveBackendConfig(agentConfig, backendName);
  const backend = createBackendInstance(backendName, backendConfig);

  console.log(`Agent backend: ${backendName}`);
  console.log(`Command: ${backendConfig.command} ${(backendConfig.args ?? []).join(" ")}`);

  // ── 2. Create run ──────────────────────────────────────────────────────

  const { runId } = await createRun({
    workflowPath: absWorkflowPath,
    task: options.task,
    runsDir,
    skillLockPath,
    clock,
  });

  const runDir = join(runsDir, runId);
  console.log(`Run created: ${runId}`);

  // ── 3. Load workflow definition (needed for step type resolution) ──────

  const wf = await loadWorkflowFile(absWorkflowPath);

  // ── 4. Main execution loop ─────────────────────────────────────────────

  let iteration = 0;
  const MAX_ITERATIONS = 100; // safety limit

  while (iteration++ < MAX_ITERATIONS) {
    const state = await stateStore.readSnapshot(runDir);
    if (state === null) {
      throw new StateError(`state.json missing for run ${runId}`);
    }

    // Check terminal run states
    if (
      state.status === "completed" ||
      state.status === "failed" ||
      state.status === "blocked" ||
      state.status === "cancelled"
    ) {
      console.log(`Run ${runId}: ${state.status}`);
      break;
    }

    // Continue an in-flight multi-step job first; otherwise start the next ready job.
    const runningId = Object.entries(state.jobs)
      .find(([, js]) => js.status === "running")?.[0];
    const readyId = runningId ?? Object.entries(state.jobs)
      .find(([, js]) => js.status === "ready")?.[0];

    if (readyId === undefined) {
      // No ready jobs — check if we're stuck
      const pendingIds = Object.entries(state.jobs)
        .filter(([, js]) => js.status === "waiting" || js.status === "inactive")
        .map(([id]) => id);

      if (pendingIds.length === 0) {
        console.log(`Run ${runId}: all jobs completed`);
        break;
      }

      console.log(
        `Run ${runId}: no ready jobs. Waiting jobs: ${pendingIds.join(", ")}. ` +
        `This may indicate unsatisfied dependencies or inactive optional jobs.`
      );
      break;
    }

    // Process ONE ready job per iteration (MVP: no concurrent Agent execution)
    const jobId = readyId;
    const jobDef = wf.jobs[jobId];
    if (jobDef === undefined) continue;

    const jobState = state.jobs[jobId];
    const stepId = jobState?.current_step ?? jobDef.steps[0]?.id;
    if (stepId === undefined) continue;

    const stepDef = jobDef.steps.find((s) => s.id === stepId);
    if (stepDef === undefined) continue;

    console.log(`Processing job "${jobId}" step "${stepId}" (type: ${stepDef.type})`);

    if (stepDef.type === "agent") {
      // ── Agent step path ──────────────────────────────────────────────

      // Generate prompt (reuses context/prompt pipeline)
      const bundle = await buildContext({
        runDir,
        zigmaflowDir,
        workflowDef: wf,
        state,
        jobId,
      });

      if (bundle.stepType !== "agent") {
        console.log(`  Step is not agent type, skipping.`);
        continue;
      }

      const attempt = state.jobs[jobId]?.attempt ?? 1;

      // Build and write prompt artifact
      const packet = buildPromptPacket(bundle);
      const rendered = renderPromptPacket(packet, { supportsSystemPrompt: true });
      const promptText = rendered.markdown;

      const { artifactRef } = await writePromptArtifact({
        runDir,
        runId,
        jobId,
        stepId: bundle.stepId,
        attempt,
        prompt: promptText,
        packet,
        clock,
      });

      // Emit prompt_generated event
      const currentTail = await eventWriter.readLastEventId(runDir);
      const lastNum = currentTail !== null
        ? parseInt(currentTail.replace("evt-", ""), 10)
        : 0;
      const newEventId = nextEventId(lastNum + 1);

      await eventWriter.appendEvent(runDir, {
        id: newEventId,
        type: "prompt_generated",
        run_id: runId,
        timestamp: clock.now(),
        producer: "run-all",
        job: jobId,
        step: bundle.stepId,
        attempt,
        payload: {
          job_id: jobId,
          step_id: bundle.stepId,
          prompt_artifact: artifactRef,
        },
      });

      // Transition job to running
      const runningState: RunState = {
        ...state,
        last_event_id: newEventId,
        jobs: {
          ...state.jobs,
          [jobId]: {
            ...state.jobs[jobId]!,
            status: "running",
            current_step: bundle.stepId,
            attempt,
          },
        },
      };
      await stateStore.writeSnapshot(runDir, runningState);

      // Compute the expected report path
      const stepDir = join(
        runDir,
        "jobs",
        jobId,
        "attempts",
        String(attempt),
        "steps",
        bundle.stepId,
      );
      const reportPath = join(stepDir, "report.json");

      // Invoke agent backend
      console.log(`  Invoking agent backend "${backendName}"...`);
      const result = await backend.execute({
        prompt: promptText,
        reportPath,
        stepDir,
        projectRoot,
      });

      if (!result.success) {
        console.error(`  Agent backend failed: ${result.error ?? "Unknown error"}`);
        // Mark job as failed
        const failEventId = nextEventId(lastNum + 2);
        await eventWriter.appendEvent(runDir, {
          id: failEventId,
          type: "step_failed",
          run_id: runId,
          timestamp: clock.now(),
          producer: "run-all",
          job: jobId,
          step: bundle.stepId,
          attempt,
          payload: {
            job_id: jobId,
            step_id: bundle.stepId,
            attempt,
            reason: result.error ?? "Agent backend failed",
          },
        });

        const failedState: RunState = {
          ...runningState,
          status: "failed",
          last_event_id: failEventId,
          jobs: {
            ...runningState.jobs,
            [jobId]: {
              ...runningState.jobs[jobId]!,
              status: "failed",
            },
          },
        };
        await stateStore.writeSnapshot(runDir, failedState);
        console.log(`Run ${runId}: failed at job "${jobId}"`);
        return;
      }

      console.log(`  Agent backend completed. Accepting report...`);

      // Accept agent report (Engine processes signals, advances job, etc.)
      await acceptAgentReport({
        runDir,
        runId,
        jobId,
        clock,
      });

      console.log(`  Job "${jobId}" step "${bundle.stepId}" completed.`);
    } else if (
      stepDef.type === "script" ||
      stepDef.type === "check" ||
      stepDef.type === "router"
    ) {
      // ── Script/check/router step path ─────────────────────────────────

      // Ensure job is ready or running before execution
      const currentJobState = state.jobs[jobId];
      if (
        currentJobState?.status !== "ready" &&
        currentJobState?.status !== "running"
      ) {
        // Transition to ready first (shouldn't normally happen since readyIds says it's ready)
        continue;
      }

      await executeCurrentStep({
        runDir,
        zigmaflowDir,
        runId,
        jobId,
        clock,
      });

      // Check if job needs advancing (multi-step jobs)
      const postState = await stateStore.readSnapshot(runDir);
      if (postState !== null) {
        const postJobState = postState.jobs[jobId];
        if (postJobState?.status === "running") {
          await advanceJob({ runDir, runId, jobId, clock });
        }
      }

      console.log(`  Job "${jobId}" step "${stepId}" completed.`);
    } else {
      console.log(
        `  Step type "${stepDef.type}" is not supported in run-all mode. ` +
        `Skipping (workflow and human steps are MVP-reserved).`
      );
      // Skip unsupported step types — they are reserved for future phases
      continue;
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    console.error(`Run ${runId}: exceeded maximum iterations (${MAX_ITERATIONS}) — possible infinite loop.`);
    return;
  }

  // ── 5. Print final status ──────────────────────────────────────────────

  const finalState = await stateStore.readSnapshot(runDir);
  if (finalState === null) {
    console.log(`Run ${runId}: completed (state snapshot unavailable).`);
  } else {
    console.log(`\nRun ${runId} finished with status: ${finalState.status ?? "completed"}`);
    printJobSummary(finalState);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printJobSummary(state: RunState): void {
  console.log("\nJob summary:");
  for (const [id, js] of Object.entries(state.jobs)) {
    const attempt = js.attempt ?? 1;
    const activation = js.activation !== undefined ? ` [${js.activation}]` : "";
    console.log(`  ${id}: ${js.status}${activation} (attempt ${attempt})`);
  }
}
