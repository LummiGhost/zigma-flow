/**
 * CLI entry point for zigma-flow.
 *
 * Uses commander for command parsing. All ZigmaFlowErrors thrown by command
 * handlers are caught here and mapped to process.exitCode.
 *
 * Reference: docs/prd.md §17 (CLI commands), §19 (tech stack).
 * Module boundary: must NOT directly push run state.
 */

import { pathToFileURL } from "node:url";

import { Command } from "commander";

import { ZigmaFlowError, getPackageInfo } from "./utils/index.js";
import { initAction } from "./commands/init.js";

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
