/**
 * init command action handler.
 *
 * Calls runInit({ cwd }) and prints the per-path summary.
 * When `cwd` is not provided, falls back to `process.cwd()`.
 * Errors are re-thrown so the CLI top-level handler can map them to exit codes.
 */

import { runInit } from "../init/index.js";

export interface InitActionOptions {
  /** Working directory for initialization (defaults to process.cwd()). */
  cwd?: string;
}

export async function initAction(options: InitActionOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const result = await runInit({ cwd });

  if (result.alreadyInitialized) {
    console.log(".zigma-flow/config.json already exists — project is already initialized.");
  }

  for (const dir of result.directories) {
    console.log(`${dir.status === "created" ? "created" : "skipped"}: ${dir.path}`);
  }

  for (const file of result.files) {
    console.log(`${file.status}: ${file.path}`);
  }
}
