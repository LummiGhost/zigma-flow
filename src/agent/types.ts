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
  [key: string]: unknown;
  /** Whether the agent completed successfully. */
  success: boolean;
  /** Path to the report.json written by the agent (if success). */
  reportPath?: string;
  /** Error message if the agent failed. */
  error?: string;
  /** Process exit code (absent for timeout/cancel). */
  exitCode?: number;
  /** Path to the captured stdout file (agent.stdout.log). */
  stdoutPath?: string;
  /** Path to the captured stderr file (agent.stderr.log). */
  stderrPath?: string;
  /** Path to the invocation metadata file (agent.invocation.json). */
  invocationPath?: string;
  /** Wall-clock duration of the execution in milliseconds. */
  durationMs?: number;
}

export interface AgentBackend {
  /** Unique name of this backend (e.g. "claude-code"). */
  readonly name: string;

  /** The command executable invoked by this backend (e.g. "claude"). Optional for backwards compatibility. */
  readonly backendCommand?: string;
  /** Command-line arguments (excluding the prompt). Optional for backwards compatibility. */
  readonly backendArgs?: readonly string[];
  /** Timeout in milliseconds. Optional for backwards compatibility. */
  readonly backendTimeoutMs?: number;

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
  /** Model to use (e.g. "claude-sonnet-4-6"). Injected as --model before the prompt. */
  model?: string;
  /** When true, use --result-file instead of embedding the report path in the prompt. */
  use_result_file?: boolean;
  /** Maximum agent turns. Injected as --max-turns before the prompt. */
  max_turns?: number;
  /** Tools the agent is allowed to use. Injected as --allowedTools before the prompt. */
  allowed_tools?: string[];
  /** Tools the agent is not allowed to use. Injected as --disallowedTools before the prompt. */
  disallowed_tools?: string[];
}
