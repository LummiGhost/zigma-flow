/**
 * CLI entry point for zigma-flow.
 *
 * Uses commander for command parsing. All ZigmaFlowErrors thrown by command
 * handlers are caught here and mapped to process.exitCode.
 *
 * Reference: docs/prd.md §17 (CLI commands), §19 (tech stack).
 * Module boundary: must NOT directly push run state.
 */

import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Command } from "commander";

import { ZigmaFlowError, UserInputError, formatError, getPackageInfo } from "./utils/index.js";
import { initAction } from "./commands/init.js";
import { validateAction } from "./commands/validate.js";
import { runAction } from "./commands/run.js";
import { statusAction } from "./commands/status.js";
import { promptAction } from "./commands/prompt.js";
import { stepAction } from "./commands/step.js";
import { nextAction } from "./commands/next.js";
import { retryAction } from "./commands/retry.js";
import { abortAction } from "./commands/abort.js";
import { listRunsAction } from "./commands/list-runs.js";
import { showAction } from "./commands/show.js";
import { runAllAction } from "./commands/run-all.js";
import { invokeAction } from "./commands/invoke.js";
import { inspectAction } from "./commands/inspect.js";
import { approveAction } from "./commands/approve.js";
import { rejectAction } from "./commands/reject.js";
import { resumeAction } from "./commands/resume.js";
import { forceSetAction } from "./commands/force-set.js";
import { verifyRunAction } from "./commands/verify-run.js";
import { doctorAction } from "./commands/doctor.js";
import { eventsAction } from "./commands/events.js";
import { artifactsAction } from "./commands/artifacts.js";
import { skillAddAction } from "./commands/skill-add.js";
import { SystemClock } from "./run/index.js";

function collectInputs(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function parseInputs(inputs?: string[]): Record<string, string> | undefined {
  if (inputs === undefined || inputs.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const entry of inputs) {
    const eqIdx = entry.indexOf("=");
    if (eqIdx < 1) {
      console.error(`Invalid --input format: "${entry}". Expected key=value.`);
      process.exit(2);
    }
    result[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
  }
  return result;
}

/**
 * Resolve and validate the --cwd CLI option.
 *
 * Relative paths are resolved against `process.cwd()`. Throws `UserInputError`
 * (exit code 2) when the path does not exist, is a file, or is inaccessible.
 *
 * Returns `undefined` when no --cwd was supplied (caller falls back to
 * `process.cwd()`).
 */
function resolveCwdOption(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // Guard against --cwd= (empty value), which would silently resolve to
  // process.cwd() because path.resolve("") === process.cwd().
  if (raw.trim() === "") {
    throw new UserInputError(
      "--cwd received an empty value",
      {
        suggestion:
          "Provide a valid directory path with --cwd <path>, or omit --cwd to use the current working directory.",
      }
    );
  }
  const absPath = resolve(raw);
  let stats;
  try {
    stats = statSync(absPath);
  } catch {
    throw new UserInputError(
      `--cwd path does not exist or is inaccessible: ${absPath}`,
      {
        suggestion:
          "Verify the path exists, or omit --cwd to use the current working directory.",
      }
    );
  }
  if (!stats.isDirectory()) {
    throw new UserInputError(
      `--cwd must be a directory, but got a file: ${absPath}`,
      {
        suggestion:
          "Provide a path to an existing directory, or omit --cwd to use the current working directory.",
      }
    );
  }
  return absPath;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const packageInfo = getPackageInfo();

  try {
    // ── Extract --cwd from argv (program-level global option) ──────────────
    let rawCwd: string | undefined;
    const filteredArgv: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--cwd") {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          rawCwd = next;
          i++;
        } else {
          throw new UserInputError(
            "--cwd requires a <path> argument",
            { suggestion: "Usage: zigma-flow --cwd <path> <command>" }
          );
        }
      } else if (arg.startsWith("--cwd=")) {
        rawCwd = arg.slice("--cwd=".length);
      } else {
        filteredArgv.push(arg);
      }
    }

    // ── Resolve & validate --cwd, then delegate ─────────────────────────────
    const resolvedCwd = resolveCwdOption(rawCwd);
    // `resolvedCwd` is stable (either a string or undefined), so these could be
    // simple constants. They are kept as zero-argument arrow functions for
    // consistency with the existing call-site convention (cwd() / rDir() /
    // zfDir()). Converting to constants would require updating every call site.
    const cwd = (): string => resolvedCwd ?? process.cwd();
    const zfDir = (): string => join(cwd(), ".zigma-flow");
    const rDir = (): string => join(zfDir(), "runs");

    await runProgram(filteredArgv, packageInfo, cwd, zfDir, rDir);
  } catch (error: unknown) {
    if (error instanceof ZigmaFlowError) {
      console.error(formatError(error));
      process.exitCode = error.exitCode;
      return;
    }

    // Commander throws a CommanderError when exitOverride() is set.
    // Help and version display exit with code 0; errors exit with non-zero.
    if (isCommanderError(error)) {
      const informationalCodes = new Set([
        "commander.helpDisplayed",
        "commander.help",
        "commander.version"
      ]);
      if (informationalCodes.has(error.code)) {
        // Help/version: treat as success (exit code stays 0).
        return;
      }
      // Unknown command, unknown option, etc.: non-zero exit.
      process.exitCode = error.exitCode !== 0 ? error.exitCode : 1;
      return;
    }

    throw error;
  }
}

async function runProgram(
  filteredArgv: string[],
  packageInfo: { version: string },
  cwd: () => string,
  zfDir: () => string,
  rDir: () => string,
): Promise<void> {
  const program = new Command();

  program
    .name("zigma-flow")
    .description("Local Agent Workflow Runtime / Workflow Harness.")
    .version(packageInfo.version, "-V, --version")
    // NOTE: This option is declared for help-text display only. The actual
    // --cwd parsing and validation happens via manual argv extraction in main()
    // above (before Commander's parser runs). The commander parser never sees
    // the raw --cwd argument because it is filtered out of filteredArgv.
    .option("--cwd <path>", "Working directory for zigma-flow (defaults to current working directory).")
    // Route all commander output through console so test spies can capture it.
    .configureOutput({
      writeOut: (str) => {
        console.log(str.replace(/\n$/, ""));
      },
      writeErr: (str) => {
        console.error(str.replace(/\n$/, ""));
      }
    })
    // Let us handle exit ourselves.
    .exitOverride();

  program
    .command("init")
    .description("Initialize a .zigma-flow/ directory in the current working directory.")
    .exitOverride()
    .action(async () => {
      await initAction({ cwd: cwd() });
    });

  program
    .command("validate <path>")
    .description("Validate a workflow YAML or Skill Pack manifest.")
    .option("--host <name>", "Host name for strict trigger validation (e.g. zigma-server).")
    .exitOverride()
    .action(async (filePath: string, options: { host?: string }) => {
      const validateOpts: { host?: string | undefined } = {};
      if (options.host !== undefined) validateOpts.host = options.host;
      await validateAction(filePath, validateOpts);
    });

  program
    .command("invoke <workflow>")
    .description("Create and execute a workflow run to completion (unified lifecycle).")
    .option("--task <task>", "Task description for a new run (mutually exclusive with --resume).")
    .option("--resume <run-id>", "Resume an existing run from where it left off (mutually exclusive with --task).")
    .option("--backend <name>", "Agent backend to use (default: from config, or claude-code).")
    .option("--parallelism <N>", "Maximum concurrent job count (default 4).", parseInt)
    .option("--fail-fast", "Enable fail-fast abort propagation on job failure.")
    .option("--input <key=value>", "Named input for the workflow (repeatable).", collectInputs, [] as string[])
    .option("--dry-run", "Validate and plan without executing.")
    .option("--trace", "Verbose event-by-event output.")
    .option("--pause-before <job.step>", "Pause before a specific step (debugging).")
    .option("--stop-after <job.step>", "Stop after a specific step (debugging).")
    .option("--save-all-prompts", "Save all prompts to artifacts without pausing (debugging mode).")
    .exitOverride()
    .action(async (workflowPath: string, options: { task?: string; resume?: string; backend?: string; parallelism?: number; failFast?: boolean; input?: string[]; dryRun?: boolean; trace?: boolean; pauseBefore?: string; stopAfter?: string; saveAllPrompts?: boolean }) => {
      if (options.task === undefined && options.resume === undefined && options.dryRun !== true) {
        console.error("Error: Either --task <description>, --resume <run-id>, or --dry-run is required.");
        process.exit(2);
      }
      if (options.task !== undefined && options.resume !== undefined) {
        console.error("Error: --task and --resume are mutually exclusive.");
        process.exit(2);
      }
      const inputs = parseInputs(options.input);
      await invokeAction(workflowPath, {
        projectRoot: cwd(),
        ...(options.task !== undefined ? { task: options.task } : {}),
        ...(options.resume !== undefined ? { resume: options.resume } : {}),
        ...(options.backend !== undefined ? { backend: options.backend } : {}),
        ...(options.parallelism !== undefined ? { parallelism: options.parallelism } : {}),
        ...(options.failFast !== undefined ? { failFast: options.failFast } : {}),
        ...(inputs !== undefined ? { inputs } : {}),
        ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
        ...(options.trace !== undefined ? { trace: options.trace } : {}),
        ...(options.pauseBefore !== undefined ? { pauseBefore: options.pauseBefore } : {}),
        ...(options.stopAfter !== undefined ? { stopAfter: options.stopAfter } : {}),
        ...(options.saveAllPrompts !== undefined ? { saveAllPrompts: options.saveAllPrompts } : {}),
      });
    });

  program
    .command("inspect [run-id]")
    .description("Inspect a run (summary, jobs, events, artifacts) with selectable output views.")
    .option("--latest", "Inspect the most recent run.")
    .option("--summary", "Brief status summary (default).")
    .option("--jobs", "Show all jobs with status.")
    .option("--events", "Show event log.")
    .option("--artifacts", "List artifacts.")
    .option("--json", "Output as JSON (for programmatic use).")
    .option("--event-limit <N>", "Maximum events to show (default 20).", parseInt)
    .option("--artifact-job <id>", "Filter artifacts to a specific job.")
    .exitOverride()
    .action(async (runId: string | undefined, options: { latest?: boolean; summary?: boolean; jobs?: boolean; events?: boolean; artifacts?: boolean; json?: boolean; eventLimit?: number; artifactJob?: string }) => {
      await inspectAction({
        projectRoot: cwd(),
        ...(runId !== undefined ? { runId } : {}),
        ...(options.latest ? { latest: options.latest } : {}),
        ...(options.summary !== undefined ? { summary: options.summary } : {}),
        ...(options.jobs ? { jobs: options.jobs } : {}),
        ...(options.events ? { events: options.events } : {}),
        ...(options.artifacts ? { artifacts: options.artifacts } : {}),
        ...(options.json ? { json: options.json } : {}),
        ...(options.eventLimit !== undefined ? { eventLimit: options.eventLimit } : {}),
        ...(options.artifactJob !== undefined ? { artifactJob: options.artifactJob } : {}),
      });
    });

  program
    .command("run <workflow>")
    .description("(deprecated) Create a new workflow run — use 'invoke' instead.")
    .requiredOption("--task <task>", "Task description for this run.")
    .option("--input <key=value>", "Named input for the workflow (repeatable).", collectInputs, [] as string[])
    .exitOverride()
    .action(async (workflowPath: string, options: { task: string; input?: string[] }) => {
      const inputs = parseInputs(options.input);
      await runAction(workflowPath, { task: options.task, projectRoot: cwd(), ...(inputs !== undefined ? { inputs } : {}) });
    });

  program
    .command("run-all <workflow>")
    .description("(deprecated) Create and execute a workflow run — use 'invoke' instead.")
    .option("--task <task>", "Task description for a new run (mutually exclusive with --resume).")
    .option("--resume <run-id>", "Resume an existing run from where it left off (mutually exclusive with --task).")
    .option("--backend <name>", "Agent backend to use (default: from config, or claude-code).")
    .option("--parallelism <N>", "Maximum concurrent job count (default 4).", parseInt)
    .option("--fail-fast", "Enable fail-fast abort propagation on job failure.")
    .option("--input <key=value>", "Named input for the workflow (repeatable).", collectInputs, [] as string[])
    .exitOverride()
    .action(async (workflowPath: string, options: { task?: string; resume?: string; backend?: string; parallelism?: number; failFast?: boolean; input?: string[] }) => {
      if (options.task === undefined && options.resume === undefined) {
        console.error("Error: Either --task <description> or --resume <run-id> is required.");
        process.exit(2);
      }
      if (options.task !== undefined && options.resume !== undefined) {
        console.error("Error: --task and --resume are mutually exclusive.");
        process.exit(2);
      }
      const inputs = parseInputs(options.input);
      // Map --task to inputs.task internally so task is treated as a regular input
      const mergedInputs: Record<string, string> | undefined = (options.task !== undefined || inputs !== undefined)
        ? { ...(options.task !== undefined ? { task: options.task } : {}), ...(inputs ?? {}) }
        : undefined;
      await runAllAction(workflowPath, {
        projectRoot: cwd(),
        ...(options.task !== undefined ? { task: options.task } : {}),
        ...(options.resume !== undefined ? { resume: options.resume } : {}),
        ...(options.backend !== undefined ? { backend: options.backend } : {}),
        ...(options.parallelism !== undefined ? { parallelism: options.parallelism } : {}),
        ...(options.failFast !== undefined ? { failFast: options.failFast } : {}),
        ...(mergedInputs !== undefined ? { inputs: mergedInputs } : {}),
      });
    });

  program
    .command("status")
    .description("Show the status of a workflow run.")
    .option("--run <run_id>", "Specific run id to show (defaults to latest).")
    .option("--latest", "Use the most recently created run.")
    .option("-v, --verbose", "Show step-level details for each job.")
    .exitOverride()
    .action(async (options: { run?: string; latest?: boolean; verbose?: boolean }) => {
      await statusAction(options, rDir());
    });

  program
    .command("prompt")
    .description("(deprecated) Generate an agent prompt — use 'invoke --pause-before <step>' instead.")
    .option("--job <job>", "Job id to generate a prompt for (defaults to the single ready job).")
    .option("--run <run_id>", "Target a specific run instead of the active run.")
    .option("--latest", "Use the most recently created run.")
    .exitOverride()
    .action(async (options: { job?: string; run?: string; latest?: boolean }) => {
      await promptAction({
        zigmaflowDir: cwd(),
        ...(options.job !== undefined ? { job: options.job } : {}),
        ...(options.run !== undefined ? { runId: options.run } : {}),
        ...(options.latest !== undefined ? { latest: options.latest } : {}),
        clock: new SystemClock(),
      });
    });

  program
    .command("step")
    .description("(deprecated) Execute a single script/check/router step — use 'invoke' instead.")
    .option("--job <job>", "Job id to execute (defaults to the single ready job).")
    .option("--run <run_id>", "Target a specific run instead of the active run.")
    .option("--latest", "Use the most recently created run.")
    .exitOverride()
    .action(async (options: { job?: string; run?: string; latest?: boolean }) => {
      await stepAction({
        zigmaflowDir: cwd(),
        ...(options.job !== undefined ? { job: options.job } : {}),
        ...(options.run !== undefined ? { runId: options.run } : {}),
        ...(options.latest !== undefined ? { latest: options.latest } : {}),
        clock: new SystemClock(),
      });
    });

  program
    .command("next")
    .description("(deprecated) Accept an agent report and advance — use 'invoke' instead.")
    .requiredOption("--job <job>", "Job id whose agent report should be accepted.")
    .option("--run <run_id>", "Target a specific run instead of the active run.")
    .option("--latest", "Use the most recently created run.")
    .exitOverride()
    .action(async (options: { job: string; run?: string; latest?: boolean }) => {
      await nextAction({
        zigmaflowDir: cwd(),
        jobId: options.job,
        ...(options.run !== undefined ? { runId: options.run } : {}),
        ...(options.latest !== undefined ? { latest: options.latest } : {}),
        clock: new SystemClock(),
      });
    });

  program
    .command("retry")
    .description("Retry a job in the active run that is in a terminal state.")
    .requiredOption("--job <job>", "Job id to retry.")
    .option("--reason <reason>", "Human-readable reason for the retry.")
    .option("--with <inputs>", "JSON string of retry inputs (wholesale replacement).")
    .option("--force", "Force retry even when max attempts exceeded.")
    .option("--run <run_id>", "Target a specific run instead of the active run.")
    .option("--latest", "Use the most recently created run.")
    .exitOverride()
    .action(async (options: { job: string; reason?: string; with?: string; force?: boolean; run?: string; latest?: boolean }) => {
      let retryInputs: Record<string, string> | undefined;
      if (options.with !== undefined) {
        if (!process.env.ZIGMA_SUPPRESS_DEPRECATION) {
          console.warn(
            "[DEPRECATED] retry --with is deprecated. Review feedback should be passed as explicit upstream outputs. This will be removed in v1.0."
          );
        }
        try {
          const parsed = JSON.parse(options.with);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("not an object");
          }
          const invalidValues = Object.values(parsed as object).filter(v => typeof v !== "string");
          if (invalidValues.length > 0) {
            throw new Error("values must be strings");
          }
          retryInputs = parsed as Record<string, string>;
        } catch {
          console.error(`--with must be a JSON object with string values (e.g., '{"key": "value"}')`);
          process.exitCode = 2;
          return;
        }
      }
      await retryAction({
        zigmaflowDir: cwd(),
        jobId: options.job,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
        ...(retryInputs !== undefined ? { retryInputs } : {}),
        ...(options.force !== undefined ? { force: options.force } : {}),
        ...(options.run !== undefined ? { runId: options.run } : {}),
        ...(options.latest !== undefined ? { latest: options.latest } : {}),
        clock: new SystemClock(),
      });
    });

  program
    .command("abort")
    .description("Cancel the active run without deleting artifacts.")
    .option("--reason <reason>", "Human-readable reason for the abort.")
    .option("--run <run_id>", "Target a specific run instead of the active run.")
    .option("--latest", "Use the most recently created run.")
    .exitOverride()
    .action(async (options: { reason?: string; run?: string; latest?: boolean }) => {
      await abortAction({
        zigmaflowDir: cwd(),
        clock: new SystemClock(),
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
        ...(options.run !== undefined ? { runId: options.run } : {}),
        ...(options.latest !== undefined ? { latest: options.latest } : {}),
      });
    });

  program
    .command("list-runs")
    .description("List all runs in the .zigma-flow/runs/ directory.")
    .exitOverride()
    .action(async () => {
      await listRunsAction({ zigmaflowDir: cwd() });
    });

  program
    .command("show [run-id]")
    .description("Show details of a run (run info, jobs, last 5 events).")
    .option("--latest", "Use the most recently created run.")
    .exitOverride()
    .action(async (runId: string | undefined, options: { latest?: boolean }) => {
      await showAction({
        zigmaflowDir: cwd(),
        ...(runId !== undefined ? { runId } : {}),
        ...(options.latest !== undefined ? { latest: options.latest } : {}),
      });
    });

  program
    .command("check")
    .description("(deprecated) Execute a check step (alias for step) — use 'invoke' instead.")
    .option("--job <job>", "Job id to execute (defaults to the single ready job).")
    .exitOverride()
    .action(async (options: { job?: string }) => {
      await stepAction({
        zigmaflowDir: cwd(),
        ...(options.job !== undefined ? { job: options.job } : {}),
        clock: new SystemClock(),
      });
    });

  program
    .command("approve")
    .description("Approve a human gate step in the active run.")
    .requiredOption("--job <job>", "Job id to approve.")
    .option("--step <step>", "Step id to approve (auto-detected if only one awaiting).")
    .option("--comment <text>", "Optional approval comment.")
    .option("--output <pairs>", "Optional key=value output pairs (repeatable).", (v, prev: string[]) => [...(prev ?? []), v], [] as string[])
    .option("--run <run_id>", "Target a specific run instead of the active run.")
    .option("--latest", "Use the most recently created run.")
    .exitOverride()
    .action(async (options: { job: string; step?: string; comment?: string; output?: string[]; run?: string; latest?: boolean }) => {
      let outputs: Record<string, string> | undefined;
      if (options.output !== undefined && options.output.length > 0) {
        outputs = {};
        for (const pair of options.output) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx <= 0) {
            console.error(`--output must be key=value, got: ${pair}`);
            process.exitCode = 2;
            return;
          }
          outputs[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
      await approveAction({
        zigmaflowDir: cwd(),
        jobId: options.job,
        ...(options.step !== undefined ? { stepId: options.step } : {}),
        ...(options.comment !== undefined ? { comment: options.comment } : {}),
        ...(outputs !== undefined ? { outputs } : {}),
        ...(options.run !== undefined ? { runId: options.run } : {}),
        ...(options.latest !== undefined ? { latest: options.latest } : {}),
        clock: new SystemClock(),
      });
    });

  program
    .command("reject")
    .description("Reject a human gate step in the active run.")
    .requiredOption("--job <job>", "Job id to reject.")
    .requiredOption("--comment <text>", "Reason for rejection.")
    .option("--step <step>", "Step id to reject (auto-detected if only one awaiting).")
    .option("--run <run_id>", "Target a specific run instead of the active run.")
    .option("--latest", "Use the most recently created run.")
    .exitOverride()
    .action(async (options: { job: string; comment: string; step?: string; run?: string; latest?: boolean }) => {
      await rejectAction({
        zigmaflowDir: cwd(),
        jobId: options.job,
        comment: options.comment,
        ...(options.step !== undefined ? { stepId: options.step } : {}),
        ...(options.run !== undefined ? { runId: options.run } : {}),
        ...(options.latest !== undefined ? { latest: options.latest } : {}),
        clock: new SystemClock(),
      });
    });

  program
    .command("resume [run-id]")
    .description("Submit human input to resume a paused run (v0.6+). Replaces approve and reject.")
    .requiredOption("--job <job>", "Job id to resume.")
    .option("--step <step>", "Step id to resume (auto-detected if only one awaiting).")
    .option("--input <key=value>", "Structured input for the human step (repeatable).", collectInputs, [] as string[])
    .exitOverride()
    .action(async (runId: string | undefined, options: { job: string; step?: string; input?: string[] }) => {
      const inputs = parseInputs(options.input);
      if (inputs === undefined || Object.keys(inputs).length === 0) {
        console.error("Error: At least one --input key=value is required (e.g. --input decision=approve).");
        process.exitCode = 2;
        return;
      }
      await resumeAction({
        zigmaflowDir: cwd(),
        ...(runId !== undefined ? { runId } : {}),
        jobId: options.job,
        ...(options.step !== undefined ? { stepId: options.step } : {}),
        input: inputs,
        clock: new SystemClock(),
      });
    });

  program
    .command("force-set [run-id]")
    .description("Manually override a job's status for recovery (completed, waiting, failed, blocked).")
    .requiredOption("--job <id>", "Job id to force-set.")
    .requiredOption("--status <status>", "Target status: completed, waiting, failed, or blocked.")
    .option("--reason <reason>", "Human-readable reason for the override.")
    .option("--latest", "Use the most recently created run.")
    .exitOverride()
    .action(async (runId: string | undefined, options: { job: string; status: string; reason?: string; latest?: boolean }) => {
      await forceSetAction({
        zigmaflowDir: cwd(),
        ...(runId !== undefined ? { runId } : {}),
        jobId: options.job,
        status: options.status,
        clock: new SystemClock(),
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
        ...(options.latest !== undefined ? { latest: options.latest } : {}),
      });
    });

  program
    .command("events [run-id]")
    .description("Show recent events for a workflow run.")
    .option("--limit <N>", "Maximum number of events to show (default: 20).", parseInt)
    .option("--latest", "Use the most recently created run.")
    .exitOverride()
    .action(async (runId: string | undefined, options: { limit?: number; latest?: boolean }) => {
      await eventsAction({
        runsDir: rDir(),
        ...(runId !== undefined ? { runId } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.latest !== undefined ? { latest: options.latest } : {}),
      });
    });

  program
    .command("artifacts [run-id]")
    .description("List artifacts produced by a workflow run.")
    .option("--job <id>", "Filter to artifacts produced by the specified job.")
    .option("--latest", "Use the most recently created run.")
    .exitOverride()
    .action(async (runId: string | undefined, options: { job?: string; latest?: boolean }) => {
      await artifactsAction({
        runsDir: rDir(),
        ...(runId !== undefined ? { runId } : {}),
        ...(options.job !== undefined ? { job: options.job } : {}),
        ...(options.latest !== undefined ? { latest: options.latest } : {}),
      });
    });

  program
    .command("verify-run [run-id]")
    .description("Check run data integrity (state, events, artifacts, job attempts).")
    .exitOverride()
    .action(async (runId?: string) => {
      const exitCode = await verifyRunAction({
        runsDir: rDir(),
        ...(runId !== undefined ? { runId } : {}),
      });
      process.exitCode = exitCode;
    });

  program
    .command("doctor")
    .description("Diagnose the project environment and validate configuration.")
    .exitOverride()
    .action(async () => {
      const exitCode = await doctorAction({
        zigmaflowDir: zfDir(),
      });
      process.exitCode = exitCode;
    });

  const skillCmd = program
    .command("skill")
    .description("Manage skill packs.");

  skillCmd
    .command("add <pack-path>")
    .description("Register a local skill pack in .zigma-flow/skill-lock.json.")
    .exitOverride()
    .action(async (packPath: string) => {
      await skillAddAction(packPath, { zigmaflowDir: cwd() });
    });

  try {
    await program.parseAsync(filteredArgv);
  } catch (error: unknown) {
    if (error instanceof ZigmaFlowError) {
      console.error(formatError(error));
      process.exitCode = error.exitCode;
      return;
    }

    // Commander throws a CommanderError when exitOverride() is set.
    // Help and version display exit with code 0; errors exit with non-zero.
    if (isCommanderError(error)) {
      const informationalCodes = new Set([
        "commander.helpDisplayed",
        "commander.help",
        "commander.version"
      ]);
      if (informationalCodes.has(error.code)) {
        // Help/version: treat as success (exit code stays 0).
        return;
      }
      // Unknown command, unknown option, etc.: non-zero exit.
      process.exitCode = error.exitCode !== 0 ? error.exitCode : 1;
      return;
    }

    throw error;
  }
}

interface CommanderError {
  readonly exitCode: number;
  readonly code: string;
  readonly name: string;
}

function isCommanderError(value: unknown): value is CommanderError {
  return (
    typeof value === "object" &&
    value !== null &&
    "exitCode" in value &&
    "code" in value &&
    typeof (value as Record<string, unknown>)["code"] === "string" &&
    (value as Record<string, unknown>)["name"] === "CommanderError"
  );
}

// ---------------------------------------------------------------------------
// Direct execution entry point
// ---------------------------------------------------------------------------

let entryPointUrl: string | undefined;
if (process.argv[1]) {
  const resolved = realpathSync(process.argv[1]);
  entryPointUrl = pathToFileURL(resolved).href;
}

if (entryPointUrl === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
