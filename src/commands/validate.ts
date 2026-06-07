/**
 * validate command action handler.
 *
 * Routes to skill pack loader (skill.yml) or workflow loader (all other files).
 * Errors are re-thrown so the CLI top-level handler can map them to exit codes.
 *
 * Reference: docs/prd.md FR-002, FR-003.
 * WF-P2-VALIDATE Step 2.
 */

import { basename, dirname } from "node:path";

import { loadSkillPack } from "../skill-pack/index.js";
import { loadWorkflowFile } from "../workflow/index.js";

export async function validateAction(filePath: string): Promise<void> {
  if (basename(filePath) === "skill.yml") {
    const packRoot = dirname(filePath);
    await loadSkillPack(packRoot);
    console.log(`valid: ${filePath}`);
  } else {
    await loadWorkflowFile(filePath);
    console.log(`valid: ${filePath}`);
  }
}
