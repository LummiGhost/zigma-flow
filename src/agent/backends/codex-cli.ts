/**
 * Native Codex CLI backend.
 *
 * Uses `codex exec -` so the composed prompt travels over stdin instead of the
 * command line. This avoids platform command-length and quoting limits. Codex
 * JSONL events are captured as audit output while the final response is written
 * directly to the canonical report path with `--output-last-message`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";
import { waitForSubprocess } from "../../process/lifecycle.js";

import type {
  AgentBackend,
  AgentBackendConfig,
  AgentExecuteOptions,
  AgentExecuteResult,
} from "../types.js";
import { outputSchemaHash } from "../outputSchema.js";

const DEFAULT_TIMEOUT = 600_000;
const DEFAULT_ARGS = ["exec", "-", "--json", "--color", "never"];

export class CodexCliBackend implements AgentBackend {
  readonly name = "codex-cli";
  readonly supportsOutputSchema = true;
  readonly backendCommand: string;
  readonly backendArgs: readonly string[];
  readonly backendTimeoutMs: number;

  private readonly command: string;
  private readonly args: string[];
  private readonly timeout: number;
  private readonly env: Record<string, string | undefined>;
  private readonly model: string | undefined;
  private readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  private readonly profile: string | undefined;
  private readonly reasoningEffort: string | undefined;
  private readonly search: boolean;
  private readonly ephemeral: boolean;

  constructor(config: AgentBackendConfig) {
    this.command = config.command;
    this.args = config.args ?? DEFAULT_ARGS;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.env = this.interpolateEnv(config.env ?? {});
    this.model = config.model;
    this.sandbox = config.sandbox ?? "workspace-write";
    this.profile = config.profile;
    this.reasoningEffort = config.reasoning_effort;
    this.search = config.search ?? false;
    this.ephemeral = config.ephemeral ?? true;

    this.backendCommand = this.command;
    this.backendArgs = this.args;
    this.backendTimeoutMs = this.timeout;
  }

  private interpolateEnv(env: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(env).map(([key, value]) => [
        key,
        value.replace(/\$\{([^}]+)\}/g, (_, variable: string) =>
          process.env[variable] ?? `\${${variable}}`
        ),
      ]),
    );
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    const { prompt, reportPath, stepDir, projectRoot, signal, outputSchema } = opts;
    await mkdir(stepDir, { recursive: true });

    const stdoutPath = join(stepDir, "agent.stdout.log");
    const stderrPath = join(stepDir, "agent.stderr.log");
    const invocationPath = join(stepDir, "agent.invocation.json");
    const schemaPath = join(stepDir, "agent-output-schema.json");
    const args = [...this.args];
    if (outputSchema !== undefined) {
      await writeFile(schemaPath, JSON.stringify(outputSchema, null, 2), "utf-8");
      args.push("--output-schema", schemaPath);
    }

    if (this.model !== undefined) args.push("--model", this.model);
    if (this.profile !== undefined) args.push("--profile", this.profile);
    args.push("--sandbox", this.sandbox);
    args.push("-c", 'approval_policy="never"');
    if (this.reasoningEffort !== undefined) {
      args.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
    }
    if (this.search) args.push("--search");
    if (this.ephemeral) args.push("--ephemeral");
    args.push("--cd", projectRoot);
    args.push("--output-last-message", reportPath);

    const fullPrompt = prompt;

    const startedAt = Date.now();
    try {
      const subprocess = execa(this.command, args, {
        cwd: projectRoot,
        env: { ...process.env, ...this.env } as Record<string, string>,
        input: fullPrompt,
        ...(process.platform !== "win32" ? { detached: true } : {}),
      });
      const settled = await waitForSubprocess(subprocess, {
        timeoutMs: this.timeout,
        ...(signal !== undefined ? { signal } : {}),
      });
      const { result } = settled;
      if (settled.cancelled || settled.timedOut) {
        throw Object.assign(new Error(settled.cancelled ? "Agent execution was cancelled." : "Agent execution timed out."), {
          isCanceled: settled.cancelled,
          timedOut: settled.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      }
      const durationMs = Date.now() - startedAt;
      await writeFile(stdoutPath, result.stdout ?? "", "utf-8");
      await writeFile(stderrPath, result.stderr ?? "", "utf-8");
      await this.writeInvocation(invocationPath, args, projectRoot, startedAt, result.exitCode, durationMs, undefined, outputSchema === undefined ? undefined : schemaPath, outputSchema === undefined ? undefined : outputSchemaHash(outputSchema));

      try {
        JSON.parse(await readFile(reportPath, "utf-8"));
      } catch {
        return {
          success: false,
          exitCode: result.exitCode ?? 1,
          error: `Codex CLI did not produce a valid report at: ${reportPath}`,
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
      const durationMs = Date.now() - startedAt;
      const err = error as Error & {
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        code?: string;
        isCanceled?: boolean;
        timedOut?: boolean;
      };
      await writeFile(stdoutPath, err.stdout ?? "", "utf-8");
      await writeFile(stderrPath, err.stderr ?? "", "utf-8");
      await this.writeInvocation(invocationPath, args, projectRoot, startedAt, err.exitCode, durationMs, err.message, outputSchema === undefined ? undefined : schemaPath, outputSchema === undefined ? undefined : outputSchemaHash(outputSchema));

      if (err.isCanceled || signal?.aborted) {
        return { success: false, error: "Agent execution was cancelled.", stdoutPath, stderrPath, invocationPath, durationMs };
      }
      if (err.timedOut || err.name === "TimeoutError" || err.message.includes("timed out")) {
        return {
          success: false,
          error: `Codex CLI timed out after ${this.timeout}ms. See agent.stdout.log and agent.stderr.log for full output.`,
          stdoutPath,
          stderrPath,
          invocationPath,
          durationMs,
        };
      }
      const diagnostic = `${err.stderr ?? ""}\n${err.message}`.toLowerCase();
      if (
        err.code === "ENOENT" ||
        diagnostic.includes("command not found") ||
        diagnostic.includes("is not recognized as an internal or external command")
      ) {
        return {
          success: false,
          error: `ConfigError: Agent command "${this.command}" was not found. Install Codex CLI or check PATH.`,
          stdoutPath,
          stderrPath,
          invocationPath,
          durationMs,
        };
      }
      if (diagnostic.includes("login") || diagnostic.includes("authenticate") || diagnostic.includes("unauthorized")) {
        return {
          success: false,
          exitCode: err.exitCode ?? 1,
          error: "PermissionError: Codex CLI is not authenticated. Run `codex login`.",
          stdoutPath,
          stderrPath,
          invocationPath,
          durationMs,
        };
      }
      return {
        success: false,
        exitCode: err.exitCode ?? 1,
        error: `Codex CLI exited with code ${err.exitCode ?? 1}. See agent.stdout.log and agent.stderr.log for full output.`,
        stdoutPath,
        stderrPath,
        invocationPath,
        durationMs,
      };
    }
  }

  private async writeInvocation(
    path: string,
    args: string[],
    projectRoot: string,
    startedAt: number,
    exitCode: number | undefined,
    durationMs: number,
    error?: string,
    outputSchemaPath?: string,
    outputSchemaSha256?: string,
  ): Promise<void> {
    await writeFile(path, JSON.stringify({
      command: this.command,
      args,
      prompt_transport: "stdin",
      timeout_ms: this.timeout,
      start_time: new Date(startedAt).toISOString(),
      end_time: new Date(startedAt + durationMs).toISOString(),
      exit_code: exitCode ?? null,
      project_root: projectRoot,
      output_schema_path: outputSchemaPath,
      output_schema_sha256: outputSchemaSha256,
      ...(error !== undefined ? { error } : {}),
    }, null, 2), "utf-8");
  }
}
