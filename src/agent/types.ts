/**
 * Agent Backend types — the interface that all agent backends must implement.
 *
 * Reference: docs/prd.md §24 (Agent Adapter), docs/architecture.md §11 (security).
 */

export interface AgentExecuteOptions {
  /** The composed prompt text to send to the agent. */
  prompt: string;
  /** Absolute path where report.json must be written by the agent. */
  reportPath: string;
  /** Step artifact directory — the agent should write outputs here. */
  stepDir: string;
  /** Repository root — the agent's working directory. */
  projectRoot: string;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface AgentExecuteResult {
  /** Whether the agent completed successfully. */
  success: boolean;
  /** Path to the report.json written by the agent (if success). */
  reportPath?: string;
  /** Error message if the agent failed. */
  error?: string;
}

export interface AgentBackend {
  /** Unique name of this backend (e.g. "claude-code"). */
  readonly name: string;

  /** Execute the agent with the given options. */
  execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult>;
}

export interface AgentBackendConfig {
  /** Command to invoke (e.g. "claude"). */
  command: string;
  /** Arguments to pass before the prompt. */
  args?: string[];
  /** Timeout in milliseconds (default: 600000 = 10 min). */
  timeout?: number;
  /** Environment variables to set for the agent process. */
  env?: Record<string, string>;
}
