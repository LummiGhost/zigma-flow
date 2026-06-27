/**
 * `zigma-flow run-all` command handler.
 *
 * Thin CLI shell that loads agent configuration, resolves the backend, and
 * delegates to the Engine's `runAll` function. Config-loading helpers live
 * here until WF-P13-BACKEND-CONFIG extracts them into the engine layer.
 *
 * Reference: docs/prd.md §24 (Agent Adapter).
 * WF-P13-ENGINE-RUNALL Step 2.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { AgentBackend } from "../agent/index.js";
import { agentFactory, ClaudeCodeBackend } from "../agent/index.js";
import { runAll, type RunAllOpts, type RunAllSummary } from "../engine/runAll.js";
import { ConfigError } from "../utils/index.js";

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

  // ── 1. Load agent config and resolve backend ────────────────────────────

  const agentConfig = await loadAgentConfig(zigmaflowDir);
  const backendName = options.backend ?? agentConfig.backend;
  const { config: backendConfig } = resolveBackendConfig(agentConfig, backendName);
  const backend = createBackendInstance(backendName, backendConfig);

  console.log(`Agent backend: ${backendName}`);
  console.log(`Command: ${backendConfig.command} ${(backendConfig.args ?? []).join(" ")}`);

  // ── 2. SIGINT handler (stub — WF-P13-RESUME-CANCEL will flesh this out) ─

  const abortController = new AbortController();
  const onSigint = (): void => {
    console.log("\nSIGINT received — stopping run...");
    abortController.abort();
    process.off("SIGINT", onSigint);
  };
  process.on("SIGINT", onSigint);

  // ── 3. Delegate to the Engine's runAll ──────────────────────────────────

  const summary: RunAllSummary = await runAll({
    task: options.task,
    workflowPath: absWorkflowPath,
    runsDir,
    zigmaflowDir,
    skillLockPath,
    backendResolver: () => backend,
    signal: abortController.signal,
    onEvent: (event) => {
      console.log(`  [${event.id}] ${event.type}`);
    },
  });

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
