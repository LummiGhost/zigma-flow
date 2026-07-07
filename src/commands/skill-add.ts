/**
 * skill-add — register a local skill pack in .zigma-flow/skill-lock.json.
 *
 * Reads a skill pack at the given path, validates it, and adds or updates
 * the corresponding entry in .zigma-flow/skill-lock.json.
 *
 * Reference: docs/prd.md FR-003, §9 (SkillPack resolution).
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";

import { loadSkillPack } from "../skill-pack/index.js";

export interface SkillAddOptions {
  zigmaflowDir?: string;
}

export async function skillAddAction(
  packPath: string,
  options: SkillAddOptions = {},
): Promise<void> {
  const projectRoot = options.zigmaflowDir ?? process.cwd();
  const absPackPath = resolve(projectRoot, packPath);

  // Load and validate the skill pack
  const skillDef = await loadSkillPack(absPackPath);

  const lockPath = join(projectRoot, ".zigma-flow", "skill-lock.json");

  // Read existing skill-lock.json or start fresh
  let lockData: { skills: Record<string, { resolved: string; version: string; hash: string }> };
  try {
    const raw = await readFile(lockPath, "utf-8");
    lockData = JSON.parse(raw) as typeof lockData;
  } catch {
    lockData = { skills: {} };
  }

  // Compute a relative path for the local:// URI.
  // Store as local://<relative-path-from-.zigma-flow/>
  // e.g. if pack is at .zigma-flow/skills/my-skill, store local://skills/my-skill
  const zigmaflowSubdir = join(projectRoot, ".zigma-flow");

  // Try to make a relative URI — if the pack is inside .zigma-flow, use local://
  // If not, we still store it as a local URI relative to .zigma-flow
  let relativeToDotZigma: string;
  const normalizedAbsPack = absPackPath.replace(/\\/g, "/");
  const normalizedSubdir = zigmaflowSubdir.replace(/\\/g, "/");

  if (normalizedAbsPack.startsWith(normalizedSubdir + "/")) {
    relativeToDotZigma = normalizedAbsPack.slice(normalizedSubdir.length + 1);
  } else {
    relativeToDotZigma = `skills/${basename(absPackPath)}`;
  }

  const resolvedUri = `local://${relativeToDotZigma}`;

  // Update the skill entry
  lockData.skills[skillDef.id] = {
    resolved: resolvedUri,
    version: skillDef.version,
    hash: `sha256:local:${skillDef.id}@${skillDef.version}`,
  };

  await writeFile(lockPath, JSON.stringify(lockData, null, 2) + "\n", "utf-8");

  console.log(`Registered skill: ${skillDef.id}@${skillDef.version}`);
  console.log(`  resolved: ${resolvedUri}`);
  console.log(`  lock: ${lockPath}`);
}
