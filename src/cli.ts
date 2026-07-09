/**
 * CLI entry point for zigma-flow.
 *
 * Uses commander for command parsing. All ZigmaFlowErrors thrown by command
 * handlers are caught here and mapped to process.exitCode.
 *
 * Reference: docs/prd.md §17 (CLI commands), §19 (tech stack).
 * Module boundary: must NOT directly push run state.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Command } from "commander";

import { ZigmaFlowError, getPackageInfo } from "./utils/index.js";
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
import { approveAction } from "./commands/approve.js";
import { rejectAction } from "./commands/reject.js";
import { verifyRunAction } from "./commands/verify-run.js";
import { doctorAction } from "./commands/doctor.js";
import { eventsAction } from "./commands/events.js";
import { artifactsAction } from "./commands/artifacts.js";
import { skillAddAction } from "./commands/skill-add.js";
import { SystemClock } from "./run/index.js";

export async function main(argv: string[] = process.argv): Promise<void> {
  const packageInfo = getPackageInfo();

  const program = new Command();

  program
    .name("zigma-flow")
    .description("Local Agent Workflow Runtime / Workflow Harness.")
    .version(packageInfo.version, "-V, --version")
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
      await initAction();
    });

  program
    .command("validate <path>")
    .description("Validate a workflow YAML or Skill Pack manifest.")
    .exitOverride()
    .action(async (filePath: string) => {
      await validateAction(filePath);
    });

  program
    .command("run <workflow>")
    .description("Create a new workflow run.")
    .requiredOption("--task <task>", "Task description for this run.")
    .exitOverride()
    .action(async (workflowPath: string, options: { task: string }) => {
      await runAction(workflowPath, options);
    });

  program
    .command("run-all <workflow>")
    .description("Create and execute an entire workflow run automatically using an agent backend.")
    .option("--task <task>", "Task description for a new run (mutually exclusive with --resume).")
    .option("--resume <run-id>", "Resume an existing run from where it left off (mutually exclusive with --task).")
    .option("--backend <name>", "Agent backend to use (default: from config, or claude-code).")
    .option("--parallelism <N>", "Maximum concurrent job count (default 4).", parseInt)
    .option("--fail-fast", "Enable fail-fast abort propagation on job failure.")
    .exitOverride()
    .action(async (workflowPath: string, options: { task?: string; resume?: string; backend?: string; parallelism?: number; failFast?: boolean }) => {
      if (options.task === undefined && options.resume === undefined) {
        console.error("Error: Either --task <description> or --resume <run-id> is required.");
        process.exit(2);
      }
      if (options.task !== undefined && options.resume !== undefined) {
        console.error("Error: --task and --resume are mutually exclusive.");
        process.exit(2);
      }
      await runAllAction(workflowPath, {
        ...(options.task !== undefined ? { task: options.task } : {}),
        ...(options.resume !== undefined ? { resume: options.resume } : {}),
        ...(options.backend !== undefined ? { backend: options.backend } : {}),
        ...(options.parallelism !== undefined ? { parallelism: options.parallelism } : {}),
        ...(options.failFast !== undefined ? { failFast: options.failFast } : {}),
      });
    });

  program
    .command("status")
    .description("Show the status of a workflow run.")
    .option("--run <run_id>", "Specific run id to show (defaults to latest).")
    .option("-v, --verbose", "Show step-level details for each job.")
    .exitOverride()
    .action(async (options: { run?: string; verbose?: boolean }) => {
      await statusAction(options, join(process.cwd(), ".zigma-flow", "runs"));
    });

  program
    .command("prompt")
    .description("Generate an agent prompt for the current step of the active run.")
    .option("--job <job>", "Job id to generate a prompt for (defaults to the single ready job).")
    .exitOverride()
    .action(async (options: { job?: string }) => {
      await promptAction({
        zigmaflowDir: process.cwd(),
        ...(options.job !== undefined ? { job: options.job } : {}),
        clock: new SystemClock(),
      });
    });

  program
    .command("step")
    .description("Execute the current script step of the active run.")
    .option("--job <job>", "Job id to execute (defaults to the single ready job).")
    .exitOverride()
    .action(async (options: { job?: string }) => {
      await stepAction({
        zigmaflowDir: process.cwd(),
        ...(options.job !== undefined ? { job: options.job } : {}),
        clock: new SystemClock(),
      });
    });

  program
    .command("next")
    .description("Accept the agent report for the current step of a job and advance the run.")
    .requiredOption("--job <job>", "Job id whose agent report should be accepted.")
    .exitOverride()
    .action(async (options: { job: string }) => {
      await nextAction({
        zigmaflowDir: process.cwd(),
        jobId: options.job,
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
    .exitOverride()
    .action(async (options: { job: string; reason?: string; with?: string; force?: boolean }) => {
      let retryInputs: Record<string, string> | undefined;
      if (options.with !== undefined) {
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
        zigmaflowDir: process.cwd(),
        jobId: options.job,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
        ...(retryInputs !== undefined ? { retryInputs } : {}),
        ...(options.force !== undefined ? { force: options.force } : {}),
        clock: new SystemClock(),
      });
    });

  program
    .command("abort")
    .description("Cancel the active run without deleting artifacts.")
    .option("--reason <reason>", "Human-readable reason for the abort.")
    .exitOverride()
    .action(async (options: { reason?: string }) => {
      await abortAction({
        zigmaflowDir: process.cwd(),
        clock: new SystemClock(),
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      });
    });

  program
    .command("list-runs")
    .description("List all runs in the .zigma-flow/runs/ directory.")
    .exitOverride()
    .action(async () => {
      await listRunsAction({ zigmaflowDir: process.cwd() });
    });

  program
    .command("show [run-id]")
    .description("Show details of a run (run info, jobs, last 5 events).")
    .exitOverride()
    .action(async (runId?: string) => {
      await showAction({
        zigmaflowDir: process.cwd(),
        ...(runId !== undefined ? { runId } : {}),
      });
    });

  program
    .command("check")
    .description("Execute the current check step of the active run (alias for step).")
    .option("--job <job>", "Job id to execute (defaults to the single ready job).")
    .exitOverride()
    .action(async (options: { job?: string }) => {
      await stepAction({
        zigmaflowDir: process.cwd(),
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
    .exitOverride()
    .action(async (options: { job: string; step?: string; comment?: string; output?: string[] }) => {
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
        zigmaflowDir: process.cwd(),
        jobId: options.job,
        ...(options.step !== undefined ? { stepId: options.step } : {}),
        ...(options.comment !== undefined ? { comment: options.comment } : {}),
        ...(outputs !== undefined ? { outputs } : {}),
        clock: new SystemClock(),
      });
    });

  program
    .command("reject")
    .description("Reject a human gate step in the active run.")
    .requiredOption("--job <job>", "Job id to reject.")
    .requiredOption("--comment <text>", "Reason for rejection.")
    .option("--step <step>", "Step id to reject (auto-detected if only one awaiting).")
    .exitOverride()
    .action(async (options: { job: string; comment: string; step?: string }) => {
      await rejectAction({
        zigmaflowDir: process.cwd(),
        jobId: options.job,
        comment: options.comment,
        ...(options.step !== undefined ? { stepId: options.step } : {}),
        clock: new SystemClock(),
      });
    });

  program
    .command("events [run-id]")
    .description("Show recent events for a workflow run.")
    .option("--limit <N>", "Maximum number of events to show (default: 20).", parseInt)
    .exitOverride()
    .action(async (runId: string | undefined, options: { limit?: number }) => {
      await eventsAction({
        runsDir: join(process.cwd(), ".zigma-flow", "runs"),
        ...(runId !== undefined ? { runId } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
    });

  program
    .command("artifacts [run-id]")
    .description("List artifacts produced by a workflow run.")
    .option("--job <id>", "Filter to artifacts produced by the specified job.")
    .exitOverride()
    .action(async (runId: string | undefined, options: { job?: string }) => {
      await artifactsAction({
        runsDir: join(process.cwd(), ".zigma-flow", "runs"),
        ...(runId !== undefined ? { runId } : {}),
        ...(options.job !== undefined ? { job: options.job } : {}),
      });
    });

  program
    .command("verify-run [run-id]")
    .description("Check run data integrity (state, events, artifacts, job attempts).")
    .exitOverride()
    .action(async (runId?: string) => {
      const exitCode = await verifyRunAction({
        runsDir: join(process.cwd(), ".zigma-flow", "runs"),
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
        zigmaflowDir: join(process.cwd(), ".zigma-flow"),
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
      await skillAddAction(packPath);
    });

  try {
    await program.parseAsync(argv as string[]);
  } catch (error: unknown) {
    if (error instanceof ZigmaFlowError) {
      console.error(error.message);
      if (error.suggestion !== undefined) {
        console.error(error.suggestion);
      }
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

const entryPointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;

if (entryPointUrl === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
