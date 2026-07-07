/**
 * Claude Code Agent Backend — invokes the `claude` CLI as an agent step executor.
 *
 * Uses execa to spawn `claude -p "<prompt>"` in the project root directory.
 * After Claude exits, verifies that report.json was written to the expected path.
 *
 * WF-P13-EVENTS-ARTIFACTS Step 2:
 *   - Writes stdout to ${stepDir}/agent.stdout.log
 *   - Writes stderr to ${stepDir}/agent.stderr.log
 *   - Writes invocation metadata to ${stepDir}/agent.invocation.json
 *   - Tracks durationMs in all result paths
 *   - Error messages no longer embed truncated stdout/stderr
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";

import type { AgentBackend, AgentBackendConfig, AgentExecuteOptions, AgentExecuteResult } from "../types.js";

const DEFAULT_TIMEOUT = 600_000; // 10 minutes
const DEFAULT_ARGS: string[] = ["-p"];

export class ClaudeCodeBackend implements AgentBackend {
  readonly name = "claude-code";

  /** Publicly exposed command/args/timeout for args_hash computation in runAll. */
  readonly backendCommand: string;
  readonly backendArgs: readonly string[];
  readonly backendTimeoutMs: number;

  private readonly command: string;
  private readonly args: string[];
  private readonly timeout: number;
  private readonly env: Record<string, string | undefined>;

  constructor(config: AgentBackendConfig) {
    this.command = config.command;
    this.args = config.args ?? DEFAULT_ARGS;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.env = this.interpolateEnv(config.env ?? {});

    this.backendCommand = this.command;
    this.backendArgs = this.args;
    this.backendTimeoutMs = this.timeout;
  }

  private interpolateEnv(env: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      result[key] = value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
        return process.env[varName] ?? `\${${varName}}`;
      });
    }
    return result;
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    const { prompt, reportPath, stepDir, projectRoot, signal } = opts;

    // a. Create stepDir if it doesn't exist (idempotent)
    await mkdir(stepDir, { recursive: true });

    // Append output contract reminder to the prompt
    const fullPrompt = [
      prompt,
      "",
      "---",
      "",
      "CRITICAL: After completing your work, write a report.json file to this exact path:",
      `\`${reportPath}\``,
      "",
      "The report.json must include these fields: outputs (object), artifacts (array), signals (array), summary (string).",
      "Stop after writing report.json — do not continue to subsequent steps.",
    ].join("\n");

    // b. Capture timing
    const startTime = Date.now();
    let durationMs = 0;

    // File paths for captured output
    const stdoutPath = join(stepDir, "agent.stdout.log");
    const stderrPath = join(stepDir, "agent.stderr.log");
    const invocationPath = join(stepDir, "agent.invocation.json");

    try {
      const mergedEnv = { ...process.env, ...this.env } as Record<string, string>;

      // Build options separately to satisfy exactOptionalPropertyTypes
      const execaOpts: {
        cwd: string;
        timeout: number;
        env: Record<string, string>;
        cancelSignal?: AbortSignal;
      } = {
        cwd: projectRoot,
        timeout: this.timeout,
        env: mergedEnv,
      };
      if (signal !== undefined) {
        execaOpts.cancelSignal = signal;
      }

      const result = await execa(this.command, [...this.args, fullPrompt], execaOpts);

      durationMs = Date.now() - startTime;

      // c. Write stdout/stderr to files
      await writeFile(stdoutPath, result.stdout ?? "", "utf-8");
      await writeFile(stderrPath, result.stderr ?? "", "utf-8");

      // Write invocation metadata — args list WITHOUT prompt contents
      const argsForMetadata = [...this.args, "<prompt>"];
      const invocationMeta = {
        command: this.command,
        args: argsForMetadata,
        timeout_ms: this.timeout,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date().toISOString(),
        exit_code: result.exitCode,
        project_root: projectRoot,
      };
      await writeFile(invocationPath, JSON.stringify(invocationMeta, null, 2), "utf-8");

      // Check if report.json was written
      if (!existsSync(reportPath)) {
        return {
          success: false,
          exitCode: result.exitCode ?? 1,
          error: `Claude Code exited with code ${result.exitCode}. See agent.stdout.log and agent.stderr.log for full output.`,
          stdoutPath,
          stderrPath,
          invocationPath,
          durationMs,
        };
      }

      // Validate report.json is valid JSON
      try {
        const reportText = await readFile(reportPath, "utf-8");
        JSON.parse(reportText);
      } catch {
        return {
          success: false,
          exitCode: result.exitCode ?? 1,
          error: `Claude Code wrote report.json but it contains invalid JSON at: ${reportPath}`,
          stdoutPath,
          stderrPath,
          invocationPath,
          durationMs,
        };
      }

      return {
        success: true,
        exitCode: result.exitCode ?? 0,
        reportPath,
        stdoutPath,
        stderrPath,
        invocationPath,
        durationMs,
      };
    } catch (error: unknown) {
      durationMs = Date.now() - startTime;

      const err = error as Error & {
        exitCode?: number;
        stderr?: string;
        stdout?: string;
        shortMessage?: string;
        isCanceled?: boolean;
        isTerminated?: boolean;
        timedOut?: boolean;
        code?: string;
      };

      // Always write whatever output was captured before the error
      const capturedStdout: string = err.stdout ?? "";
      const capturedStderr: string = err.stderr ?? "";

      // e. Write files even on failure/timeout/cancel — always capture output
      await writeFile(stdoutPath, capturedStdout, "utf-8");
      await writeFile(stderrPath, capturedStderr, "utf-8");

      // Write invocation metadata
      const argsForMetadata = [...this.args, "<prompt>"];
      const invocationMeta = {
        command: this.command,
        args: argsForMetadata,
        timeout_ms: this.timeout,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date().toISOString(),
        exit_code: err.exitCode ?? (err.isCanceled ? undefined : null),
        project_root: projectRoot,
        error: err.message ?? "Unknown error",
      };
      await writeFile(invocationPath, JSON.stringify(invocationMeta, null, 2), "utf-8");

      // Handle cancellation
      if (err.isCanceled || signal?.aborted) {
        return {
          success: false,
          error: "Agent execution was cancelled.",
          stdoutPath,
          stderrPath,
          durationMs,
        };
      }

      // Handle timeout
      const timedOut =
        err.timedOut ||
        err.name === "TimeoutError" ||
        (err.message !== undefined && err.message.includes("timed out"));

      if (timedOut) {
        return {
          success: false,
          error: `Claude Code timed out after ${this.timeout}ms. See agent.stdout.log and agent.stderr.log for full output.`,
          stdoutPath,
          stderrPath,
          durationMs,
        };
      }

      // Classify the error for better diagnostics and retry behaviour

      // Command not found (ENOENT) → ConfigError-like diagnostic
      if (err.code === "ENOENT" || (err.message ?? "").toLowerCase().includes("command not found")) {
        return {
          success: false,
          error: `ConfigError: Agent command "${this.command}" was not found. Please check your PATH or install the CLI.`,
          stdoutPath,
          stderrPath,
          durationMs,
        };
      }

      // Authentication error → PermissionError-like diagnostic
      const stderrLower = (err.stderr ?? "").toLowerCase();
      if (
        stderrLower.includes("not logged in") ||
        stderrLower.includes("authenticate") ||
        err.exitCode === 401
      ) {
        return {
          success: false,
          exitCode: err.exitCode ?? 1,
          error: `PermissionError: Claude Code is not logged in. Please run \`claude login\` to authenticate.`,
          stdoutPath,
          stderrPath,
          invocationPath,
          durationMs,
        };
      }

      // Rate limited → retryable error with suggestion
      if (stderrLower.includes("rate limit") || stderrLower.includes("429")) {
        return {
          success: false,
          exitCode: err.exitCode ?? 1,
          error: `Agent process exited with code ${err.exitCode ?? 1}: rate limit exceeded. Consider waiting before retrying.`,
          stdoutPath,
          stderrPath,
          invocationPath,
          durationMs,
        };
      }

      // Generic failure — short error message, no embedded stdout/stderr
      return {
        success: false,
        exitCode: err.exitCode ?? 1,
        error: `Agent process exited with code ${err.exitCode ?? 1}. See agent.stdout.log and agent.stderr.log for full output.`,
        stdoutPath,
        stderrPath,
        invocationPath,
        durationMs,
      };
    }
  }
}
