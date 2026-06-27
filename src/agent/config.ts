/**
 * Agent configuration loading and backend resolution.
 *
 * Extracted from `src/commands/run-all.ts` as part of WF-P13-BACKEND-CONFIG.
 * Provides functions to load .zigma-flow/config.json, resolve the backend for
 * a given step (with CLI override support), and create AgentBackend instances.
 *
 * Reference:
 *   docs/phases/p13-agent-adapter-hardening/02-development-plan.md §AD-P13-008
 *   docs/prd.md §24
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentBackend } from "./types.js";
import { agentFactory, ClaudeCodeBackend } from "./index.js";
import { ConfigError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentBackendConfigEntry {
  command: string;
  args?: string[];
  timeout?: number;
  env?: Record<string, string>;
}

export interface AgentConfig {
  backend: string;
  backends: Record<string, AgentBackendConfigEntry>;
}

export interface ResolvedBackend {
  name: string;
  config: AgentBackendConfigEntry;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ZigmaConfig {
  tool_version?: string;
  active_run?: string | null;
  agent?: AgentConfig;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CLAUDE_CODE_CONFIG: AgentBackendConfigEntry = {
  command: "claude",
  args: ["-p"],
  timeout: 600_000,
};

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  backend: "claude-code",
  backends: {},
};

// ---------------------------------------------------------------------------
// loadAgentConfig
// ---------------------------------------------------------------------------

/**
 * Load agent configuration from `.zigma-flow/config.json`.
 *
 * - If config.json is missing or contains invalid JSON, returns a default
 *   config with backend "claude-code" and no custom backends.
 * - If config.json has no `agent` key, returns the same default.
 * - Otherwise returns the parsed `agent` section.
 */
export async function loadAgentConfig(zigmaflowDir: string): Promise<AgentConfig> {
  const configPath = join(zigmaflowDir, ".zigma-flow", "config.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    return DEFAULT_AGENT_CONFIG;
  }

  let parsed: ZigmaConfig;
  try {
    parsed = JSON.parse(raw) as ZigmaConfig;
  } catch {
    return DEFAULT_AGENT_CONFIG;
  }

  return parsed.agent ?? DEFAULT_AGENT_CONFIG;
}

// ---------------------------------------------------------------------------
// resolveBackendForStep
// ---------------------------------------------------------------------------

/**
 * Resolve the agent backend name and configuration for a step.
 *
 * Resolution priority (highest to lowest):
 * 1. `cliOverride` — the `--backend` CLI flag
 * 2. `stepDef.backend` — the step-level backend declaration
 * 3. `agentConfig.backend` — the global default
 *
 * The built-in "claude-code" backend gets a default config if not explicitly
 * declared in `agentConfig.backends`. All other backends must be configured.
 *
 * If the resolved backend name is unknown and is not the built-in, throws
 * ConfigError.
 *
 * If the step definition specifies a `timeout`, it overrides the backend-level
 * timeout in the returned config.
 */
export function resolveBackendForStep(
  agentConfig: AgentConfig,
  stepDef?: { backend?: string; timeout?: number },
  cliOverride?: string,
): ResolvedBackend {
  const backends = agentConfig.backends ?? {};

  // Determine effective backend name (CLI > step > global)
  const backendName = cliOverride ?? stepDef?.backend ?? agentConfig.backend;

  // Handle built-in "claude-code" with default config
  const isBuiltin = backendName === "claude-code";
  if (isBuiltin && !(backendName in backends)) {
    // Apply step-level timeout override on top of the default config
    const config: AgentBackendConfigEntry = { ...DEFAULT_CLAUDE_CODE_CONFIG };
    if (stepDef?.timeout !== undefined) {
      config.timeout = stepDef.timeout;
    }
    return { name: backendName, config };
  }

  // Look up the backend in the configured backends map
  const entry = backends[backendName];
  if (entry === undefined) {
    throw new ConfigError(
      `Agent backend "${backendName}" is not configured. ` +
      `Available backends: ${Object.keys(backends).join(", ") || "(none)"}`,
      {
        details: { backendName, available: Object.keys(backends) },
        suggestion: `Add a "backends.${backendName}" entry to .zigma-flow/config.json.`,
      },
    );
  }

  // Apply step-level timeout override on top of the backend config
  const config: AgentBackendConfigEntry = { ...entry };
  if (stepDef?.timeout !== undefined) {
    config.timeout = stepDef.timeout;
  }

  return { name: backendName, config };
}

// ---------------------------------------------------------------------------
// createBackend
// ---------------------------------------------------------------------------

/**
 * Create an AgentBackend instance from a resolved backend name and config.
 *
 * Registers the built-in "claude-code" backend on first call if not already
 * registered, then delegates to the agent factory.
 */
export function createBackend(
  name: string,
  config: AgentBackendConfigEntry,
): AgentBackend {
  // Register ClaudeCodeBackend as the default built-in on first access
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
