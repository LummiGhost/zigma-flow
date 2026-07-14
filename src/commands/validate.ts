/**
 * validate command action handler.
 *
 * Routes to skill pack loader or workflow loader based on the YAML `kind` field
 * (content is authoritative over filename).
 * Errors are re-thrown so the CLI top-level handler can map them to exit codes.
 *
 * Reference: docs/prd.md FR-002, FR-003.
 * WF-P2-VALIDATE Step 2. Fix Issue #5.
 */

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parse } from "yaml";

import { loadSkillPack } from "../skill-pack/index.js";
import { FilesystemError } from "../utils/index.js";
import { loadWorkflow } from "../workflow/index.js";

export interface ValidateOptions {
  /**
   * Host name for trigger validation.
   *
   * - When omitted, unknown trigger types produce warnings (the local runtime
   *   ignores triggers).
   * - When set (e.g. "zigma-server"), unknown trigger types cause validation
   *   errors (strict mode for server-side consumption).
   */
  host?: string | undefined;
}

export async function validateAction(
  filePath: string,
  options?: ValidateOptions,
): Promise<void> {
  const text = await readFile(filePath, "utf-8").catch((e: unknown) => {
    throw new FilesystemError(`Cannot read file: ${filePath}`, { cause: e });
  });

  let kind: unknown;
  try {
    const top = parse(text) as Record<string, unknown> | null;
    kind = top?.kind;
  } catch {
    // parse failure — fall through to workflow loader which will report the error
  }

  if (kind === "skill-pack") {
    const packRoot = dirname(filePath);
    await loadSkillPack(packRoot);
    console.log(`valid: ${filePath}`);
  } else {
    const loadOpts: { host?: string } = {};
    if (options?.host !== undefined) loadOpts.host = options.host;
    loadWorkflow(text, loadOpts);            // synchronous; reuses already-read text
    console.log(`valid: ${filePath}`);
  }
}
