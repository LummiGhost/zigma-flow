/**
 * Claude Code Agent Backend — invokes the `claude` CLI as an agent step executor.
 *
 * Uses execa to spawn `claude -p "<prompt>"` in the project root directory.
 * After Claude exits, verifies that report.json was written to the expected path.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { execa } from "execa";

import type { AgentBackend, AgentBackendConfig, AgentExecuteOptions, AgentExecuteResult } from "../types.js";

const DEFAULT_TIMEOUT = 600_000; // 10 minutes
const DEFAULT_ARGS: string[] = ["-p"];

export class ClaudeCodeBackend implements AgentBackend {
  readonly name = "claude-code";

  private readonly command: string;
  private readonly args: string[];
  private readonly timeout: number;
  private readonly env: Record<string, string | undefined>;

  constructor(config: AgentBackendConfig) {
    this.command = config.command;
    this.args = config.args ?? DEFAULT_ARGS;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.env = config.env ?? {};
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    const { prompt, reportPath, projectRoot, signal } = opts;

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

      // Check if report.json was written
      if (!existsSync(reportPath)) {
        return {
          success: false,
          error: [
            `Claude Code exited with code ${result.exitCode} but report.json was not written to:`,
            reportPath,
            "",
            "stdout (last 1000 chars):",
            result.stdout.slice(-1000),
            "",
            "stderr (last 1000 chars):",
            result.stderr.slice(-1000),
          ].join("\n"),
        };
      }

      // Validate report.json is valid JSON
      try {
        const reportText = await readFile(reportPath, "utf-8");
        JSON.parse(reportText);
      } catch {
        return {
          success: false,
          error: `Claude Code wrote report.json but it contains invalid JSON at: ${reportPath}`,
        };
      }

      return { success: true, reportPath };
    } catch (error: unknown) {
      const err = error as Error & {
        exitCode?: number;
        stderr?: string;
        stdout?: string;
        isCanceled?: boolean;
      };

      if (err.isCanceled) {
        return { success: false, error: "Agent execution was cancelled." };
      }

      const timedOut =
        err.name === "TimeoutError" ||
        (err.message !== undefined && err.message.includes("timed out"));

      if (timedOut) {
        return {
          success: false,
          error: `Claude Code timed out after ${this.timeout}ms.`,
        };
      }

      return {
        success: false,
        error: [
          `Claude Code exited with code ${err.exitCode ?? "unknown"}:`,
          err.message ?? "Unknown error",
          "",
          "stderr (last 1000 chars):",
          (err.stderr ?? "").slice(-1000),
        ].join("\n"),
      };
    }
  }
}
