/**
 * Agent module — pluggable agent backends for automated workflow execution.
 *
 * Provides the AgentBackend interface, a registry-based factory, and built-in
 * backends (Claude Code). Backends are configured via .zigma-flow/config.json.
 */

export type {
  AgentBackend,
  AgentBackendConfig,
  AgentExecuteOptions,
  AgentExecuteResult,
} from "./types.js";

export type {
  AgentConfig,
  AgentBackendConfigEntry,
  ResolvedBackend,
} from "./config.js";

export {
  loadAgentConfig,
  resolveBackendForStep,
  createBackend,
  DEFAULT_PARALLELISM,
  getParallelism,
} from "./config.js";

export { AgentBackendFactory, agentFactory } from "./factory.js";
export { ClaudeCodeBackend } from "./backends/claude-code.js";
