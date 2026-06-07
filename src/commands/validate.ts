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
import { loadWorkflowFile } from "../workflow/index.js";

export async function validateAction(filePath: string): Promise<void> {
  // Peek-parse to determine kind before routing (content is authoritative over filename).
  let kind: unknown;
  try {
    const text = await readFile(filePath, "utf-8");
    const top = parse(text) as Record<string, unknown> | null;
    kind = top?.kind;
  } catch {
    // If we can't read/parse, fall through to workflow loader which will report the error.
  }

  if (kind === "skill-pack") {
    const packRoot = dirname(filePath);
    await loadSkillPack(packRoot);
    console.log(`valid: ${filePath}`);
  } else {
    await loadWorkflowFile(filePath);
    console.log(`valid: ${filePath}`);
  }
}
