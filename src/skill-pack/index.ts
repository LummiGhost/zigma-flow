/**
 * Skill Pack loader — reads, validates, and resolves skill pack manifests.
 *
 * Reference: docs/prd.md FR-003, §9, §11.
 * WF-P2-VALIDATE Step 2.
 */

import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { FilesystemError, SkillPackError, ValidationError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillPackDefinition {
  id: string;
  name: string;
  version: string;
  kind: "skill-pack";
  description?: string;
  knowledge?: Array<{ id: string; path: string; description?: string }>;
  prompts?: Array<{ id: string; path: string }>;
  scripts?: Array<{
    id: string;
    runtime?: string;
    path?: string;
    command?: string;
    inputs?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
  }>;
  checks?: Array<{ id: string; kind: string; path: string }>;
  functions?: unknown[];
  workflow_templates?: unknown[];
  policies?: { default_permissions?: Record<string, unknown> };
  examples?: unknown[];
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const KnowledgeItemSchema = z.object({
  id: z.string(),
  path: z.string(),
  description: z.string().optional(),
});

const PromptItemSchema = z.object({
  id: z.string(),
  path: z.string(),
});

const ScriptItemSchema = z.object({
  id: z.string(),
  runtime: z.string().optional(),
  path: z.string().optional(),
  command: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
});

const CheckItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  path: z.string(),
});

const SkillPackSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  kind: z.literal("skill-pack"),
  description: z.string().optional(),
  knowledge: z.array(KnowledgeItemSchema).optional(),
  prompts: z.array(PromptItemSchema).optional(),
  scripts: z.array(ScriptItemSchema).optional(),
  checks: z.array(CheckItemSchema).optional(),
  functions: z.array(z.unknown()).optional(),
  workflow_templates: z.array(z.unknown()).optional(),
  policies: z
    .object({
      default_permissions: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  examples: z.array(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function isPathSafe(packRoot: string, relativePath: string): boolean {
  if (isAbsolute(relativePath)) return false;
  const resolved = resolve(packRoot, relativePath);
  const rel = relative(packRoot, resolved);
  // If relative starts with ".." the resolved path escapes the pack root.
  return !rel.startsWith("..");
}

// ---------------------------------------------------------------------------
// loadSkillPack
// ---------------------------------------------------------------------------

/**
 * Reads `skill.yml` from packRoot, validates schema, checks path safety,
 * and verifies that all referenced files exist.
 */
export async function loadSkillPack(packRoot: string): Promise<SkillPackDefinition> {
  const manifestPath = join(packRoot, "skill.yml");

  // Read manifest
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (e) {
    throw new FilesystemError(`Cannot read skill pack manifest: ${manifestPath}`, { cause: e });
  }

  // Parse YAML
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new ValidationError(`YAML parse error in skill.yml: ${String(e)}`, {
      details: { error: String(e) },
      cause: e,
    });
  }

  // Validate kind before full schema validation so we can give a targeted error.
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("kind" in (parsed as object))
  ) {
    throw new ValidationError("skill.yml is missing required field: kind", {
      details: { kind: "missing" },
    });
  }

  const parsedObj = parsed as Record<string, unknown>;
  if (parsedObj["kind"] !== "skill-pack") {
    throw new ValidationError(
      `skill.yml has invalid kind "${String(parsedObj["kind"])}"; expected "skill-pack"`,
      {
        details: { kind: parsedObj["kind"] },
      }
    );
  }

  // Full schema validation
  const result = SkillPackSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues;
    const paths = issues.map((i) => i.path.join("."));
    const fields: Record<string, string> = {};
    for (const issue of issues) {
      const key = issue.path.join(".") || "root";
      fields[key] = issue.message;
    }
    throw new ValidationError(
      `skill.yml validation failed at: ${paths[0] ?? "unknown"}`,
      { details: { fields, paths } }
    );
  }

  const def = result.data as SkillPackDefinition;

  // Collect all path references from the manifest
  const pathRefs: string[] = [];
  if (def.knowledge) {
    for (const item of def.knowledge) {
      pathRefs.push(item.path);
    }
  }
  if (def.prompts) {
    for (const item of def.prompts) {
      pathRefs.push(item.path);
    }
  }
  if (def.scripts) {
    for (const item of def.scripts) {
      if (item.path !== undefined) pathRefs.push(item.path);
    }
  }
  if (def.checks) {
    for (const item of def.checks) {
      pathRefs.push(item.path);
    }
  }

  // Validate each path reference
  for (const refPath of pathRefs) {
    // Check path safety (no absolute paths, no escaping pack root)
    if (!isPathSafe(packRoot, refPath)) {
      throw new SkillPackError(
        `Path "${refPath}" in skill.yml is unsafe (absolute or escapes pack root)`,
        { details: { path: refPath, packRoot } }
      );
    }

    // Verify the file exists
    const fullPath = resolve(packRoot, refPath);
    try {
      await access(fullPath);
    } catch (e) {
      throw new SkillPackError(
        `Referenced file does not exist: ${refPath} (resolved to ${fullPath})`,
        { details: { path: refPath, resolvedPath: fullPath }, cause: e }
      );
    }
  }

  return def;
}

// ---------------------------------------------------------------------------
// resolveSkillLock
// ---------------------------------------------------------------------------

/**
 * Reads `.zigma-flow/skill-lock.json` and resolves a skill id to an absolute
 * pack root path.
 *
 * @param baseDir - project root directory (parent of .zigma-flow/)
 * @param skillId - skill identifier (e.g., "zigma.code-change")
 */
export async function resolveSkillLock(baseDir: string, skillId: string): Promise<string> {
  const lockPath = join(baseDir, ".zigma-flow", "skill-lock.json");

  let raw: string;
  try {
    raw = await readFile(lockPath, "utf-8");
  } catch (e) {
    throw new FilesystemError(`skill-lock.json not found at ${lockPath}`, { cause: e });
  }

  let parsed: { skills?: Record<string, { resolved?: string; path?: string }> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (e) {
    throw new FilesystemError(`skill-lock.json is not valid JSON: ${lockPath}`, { cause: e });
  }

  const entry = parsed.skills?.[skillId];
  if (entry === undefined) {
    throw new SkillPackError(`Skill "${skillId}" not found in skill-lock.json`, {
      details: { skillId, lockPath },
    });
  }

  // Support both "resolved" (new) and "path" (legacy) fields
  const resolvedUri = entry.resolved ?? entry.path;

  if (!resolvedUri?.startsWith("local://")) {
    throw new SkillPackError(
      `Unsupported resolved URI for "${skillId}": ${String(resolvedUri)}`,
      { details: { skillId, resolved: resolvedUri } }
    );
  }

  // local://skills/code-change → baseDir/.zigma-flow/skills/code-change
  const localPath = resolvedUri.slice("local://".length);
  return join(baseDir, ".zigma-flow", localPath);
}
