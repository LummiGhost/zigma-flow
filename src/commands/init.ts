/**
 * init command action handler.
 *
 * Calls runInit({ cwd: process.cwd() }) and prints the per-path summary.
 * Errors are re-thrown so the CLI top-level handler can map them to exit codes.
 */

import { runInit } from "../init/index.js";

export async function initAction(): Promise<void> {
  const result = await runInit({ cwd: process.cwd() });

  if (result.alreadyInitialized) {
    console.log(".zigma-flow/config.json already exists — project is already initialized.");
  }

  for (const dir of result.directories) {
    console.log(`${dir.status === "created" ? "created" : "skipped"}: ${dir.path}`);
  }

  for (const file of result.files) {
    console.log(`${file.status === "created" ? "created" : "skipped"}: ${file.path}`);
  }
}
