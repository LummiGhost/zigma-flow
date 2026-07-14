/**
 * Skill Pack loader — reads, validates, and resolves skill pack manifests.
 *
 * Reference: docs/prd.md FR-003, §9, §11.
 * WF-P2-VALIDATE Step 2.
 *
 * Skill discovery (v0.6): discovers skill packs from multiple search paths with
 * deterministic priority order. Direct discovery is preferred over skill-lock.json.
 * skill-lock.json is deprecated and will be removed in v1.0.
 */

import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
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
// Skill search paths (v0.6)
// ---------------------------------------------------------------------------

/**
 * Skill search path entry with its priority source label.
 *
 * Search order (highest to lowest priority):
 *   1. Project-level:   .zigma-flow/skills/
 *   2. Repository-level: .zigma/skills/
 *   3. User-level:       ZIGMA_SKILL_PATH env var or OS-specific user directory
 *   4. Extra paths:      ZIGMA_EXTRA_SKILL_PATHS env var or CLI flag
 */
export interface SkillSearchPath {
  /** Absolute path to the skills directory. */
  readonly path: string;
  /** Human-readable source label for diagnostics. */
  readonly source: string;
  /** Priority (lower = higher priority). */
  readonly priority: number;
}

/** Result of discovering a single skill pack in search paths. */
export interface SkillDiscoveryEntry {
  /** The skill pack's unique id (from skill.yml). */
  readonly skillId: string;
  /** Absolute path to the pack root directory. */
  readonly packRoot: string;
  /** The search path source this pack was found in. */
  readonly source: string;
  /** Priority of the search path (lower = higher priority). */
  readonly priority: number;
  /** Whether there was a name collision (another pack with the same id at a lower priority). */
  readonly conflict: boolean;
  /** Paths where conflicting packs were found (if any). */
  readonly conflictPaths: ReadonlyArray<string>;
}

/** Full result of skill discovery across all search paths. */
export interface SkillDiscoveryResult {
  /** Resolved skills (first-wins by priority). */
  readonly skills: ReadonlyArray<SkillDiscoveryEntry>;
  /** All search paths that were scanned. */
  readonly searchPaths: ReadonlyArray<SkillSearchPath>;
  /** Whether skill-lock.json was also used (deprecated). */
  readonly usedLockFile: boolean;
}

/**
 * Build the ordered list of search paths for skill discovery.
 *
 * The search order is deterministic and documented:
 *   1. Project-level:   .zigma-flow/skills/  (priority 10)
 *   2. Repository-level: .zigma/skills/       (priority 20)
 *   3. User-level:       ZIGMA_SKILL_PATH or ~/.zigma/skills/ (priority 30)
 *   4. Extra paths:      ZIGMA_EXTRA_SKILL_PATHS or CLI flag  (priority 40)
 */
export function buildSkillSearchPaths(
  projectRoot: string,
  extraPaths: ReadonlyArray<string> = [],
): SkillSearchPath[] {
  const paths: SkillSearchPath[] = [];

  // 1. Project-level: .zigma-flow/skills/
  paths.push({
    path: resolve(projectRoot, ".zigma-flow", "skills"),
    source: "project (.zigma-flow/skills/)",
    priority: 10,
  });

  // 2. Repository-level: .zigma/skills/
  paths.push({
    path: resolve(projectRoot, ".zigma", "skills"),
    source: "repository (.zigma/skills/)",
    priority: 20,
  });

  // 3. User-level: ZIGMA_SKILL_PATH env var or OS-specific user directory
  const userSkillPath = process.env["ZIGMA_SKILL_PATH"];
  if (userSkillPath) {
    for (const dir of userSkillPath.split(process.platform === "win32" ? ";" : ":")) {
      const trimmed = dir.trim();
      if (trimmed.length > 0) {
        paths.push({
          path: resolve(trimmed),
          source: "user (ZIGMA_SKILL_PATH)",
          priority: 30,
        });
      }
    }
  } else {
    // OS-specific user directory fallback
    const userHome = homedir();
    paths.push({
      path: resolve(userHome, ".zigma", "skills"),
      source: "user (~/.zigma/skills/)",
      priority: 30,
    });
  }

  // 4. Extra paths: ZIGMA_EXTRA_SKILL_PATHS env var
  const extraEnvPaths = process.env["ZIGMA_EXTRA_SKILL_PATHS"];
  if (extraEnvPaths) {
    for (const dir of extraEnvPaths.split(process.platform === "win32" ? ";" : ":")) {
      const trimmed = dir.trim();
      if (trimmed.length > 0) {
        extraPaths = [...extraPaths, trimmed];
      }
    }
  }

  // 4. Extra paths (CLI flag or merged env var)
  for (const extra of extraPaths) {
    const trimmed = extra.trim();
    if (trimmed.length > 0) {
      paths.push({
        path: resolve(trimmed),
        source: "extra (ZIGMA_EXTRA_SKILL_PATHS / --skill-path)",
        priority: 40,
      });
    }
  }

  return paths;
}

/**
 * Discover skill packs across all configured search paths.
 *
 * For each search path that exists as a directory, this function:
 *   1. Lists subdirectories (each potentially a skill pack)
 *   2. Looks for skill.yml in each subdirectory
 *   3. Reads the skill id from skill.yml
 *   4. Resolves name conflicts by priority (first path wins)
 *
 * @param projectRoot - Project root directory (for project-level paths)
 * @param extraPaths - Additional search paths from CLI flags
 * @param useLockFile - Whether to also read skill-lock.json (deprecated)
 */
export async function discoverSkillPacks(
  projectRoot: string,
  extraPaths: ReadonlyArray<string> = [],
  useLockFile = false,
): Promise<SkillDiscoveryResult> {
  const searchPaths = buildSkillSearchPaths(projectRoot, extraPaths);

  // Map of skillId -> { packRoot, source, priority }
  const seen = new Map<string, SkillDiscoveryEntry>();
  const conflicts: Array<{ skillId: string; conflictingPath: string }> = [];

  for (const searchPath of searchPaths) {
    let subdirs: string[];
    try {
      const entries = await readdir(searchPath.path, { withFileTypes: true });
      subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      // Directory doesn't exist — skip
      continue;
    }

    for (const dirName of subdirs) {
      const packRoot = resolve(searchPath.path, dirName);
      const skillYmlPath = join(packRoot, "skill.yml");

      // Check if skill.yml exists
      try {
        await access(skillYmlPath);
      } catch {
        // No skill.yml in this directory — skip
        continue;
      }

      // Read the skill id from skill.yml (lightweight parse — just the id field)
      let skillId: string | undefined;
      try {
        const raw = await readFile(skillYmlPath, "utf-8");
        const parsed = parseYaml(raw);
        if (parsed !== null && typeof parsed === "object" && "id" in (parsed as object)) {
          const id = (parsed as Record<string, unknown>)["id"];
          if (typeof id === "string") {
            skillId = id;
          }
        }
      } catch {
        // Could not parse skill.yml — skip this pack
        continue;
      }

      if (!skillId) {
        continue;
      }

      // Check for name conflict
      const existing = seen.get(skillId);
      if (existing) {
        // Existing entry has higher priority (lower number) — keep it, record conflict
        if (existing.priority <= searchPath.priority) {
          conflicts.push({ skillId, conflictingPath: packRoot });
          continue;
        }
        // This entry has higher priority — replace, record old as conflict
        conflicts.push({ skillId, conflictingPath: existing.packRoot });
      }

      seen.set(skillId, {
        skillId,
        packRoot,
        source: searchPath.source,
        priority: searchPath.priority,
        conflict: existing !== undefined,
        conflictPaths: existing !== undefined ? [existing.packRoot] : [],
      });
    }
  }

  // Update conflict info on entries that had collisions.
  // Deduplicate conflict paths and filter out self-references (same path as
  // the winning entry's own packRoot).
  for (const { skillId, conflictingPath } of conflicts) {
    const entry = seen.get(skillId);
    if (entry) {
      // Ignore self-references (conflicting path equals the entry's own root)
      if (conflictingPath === entry.packRoot) {
        continue;
      }
      // Skip if this conflicting path is already recorded
      if (entry.conflictPaths.includes(conflictingPath)) {
        continue;
      }
      const updatedPaths = [...entry.conflictPaths, conflictingPath];
      seen.set(skillId, {
        ...entry,
        conflict: true,
        conflictPaths: updatedPaths,
      });
    }
  }

  return {
    skills: [...seen.values()].sort((a, b) => a.skillId.localeCompare(b.skillId)),
    searchPaths,
    usedLockFile: useLockFile,
  };
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
/** Whether the skill-lock.json deprecation warning has been emitted (once per process). */
let lockDeprecationWarned = false;

/** Reset the deprecation warning flag (for testing only). */
export function resetSkillLockDeprecationWarning(): void {
  lockDeprecationWarned = false;
}

export async function resolveSkillLock(baseDir: string, skillId: string): Promise<string> {
  if (!lockDeprecationWarned) {
    lockDeprecationWarned = true;
    console.warn(
      "[DEPRECATED] skill-lock.json is deprecated. Skill version management will move to zigma-skill. " +
        "See docs for migration. This will be removed in v1.0.",
    );
  }

  const lockPath = join(baseDir, ".zigma-flow", "skill-lock.json");

  let raw: string;
  try {
    raw = await readFile(lockPath, "utf-8");
  } catch (e) {
    throw new FilesystemError(`skill-lock.json not found at ${lockPath}`, { cause: e });
  }

  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(raw);
  } catch (e) {
    throw new ValidationError(`skill-lock.json is not valid JSON: ${lockPath}`, { cause: e });
  }

  const lockResult = SkillLockSchema.safeParse(rawParsed);
  if (!lockResult.success) {
    const paths = lockResult.error.issues.map((i) => i.path.join("."));
    throw new ValidationError(`skill-lock.json failed schema validation at: ${paths[0] ?? "root"}`, {
      details: { fields: paths },
    });
  }

  const entry = lockResult.data.skills[skillId];
  if (entry === undefined) {
    throw new SkillPackError(`Skill "${skillId}" not found in skill-lock.json`, {
      details: { skillId, lockPath },
    });
  }

  // Support both "resolved" (canonical) and "path" (legacy) fields
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

// ---------------------------------------------------------------------------
// SkillLockSchema — validates the canonical skill-lock.json structure
// Reference: docs/prd.md §9, architecture.md §6.2 (SkillPack invariants)
// ---------------------------------------------------------------------------

const SkillLockEntrySchema = z.object({
  resolved: z.string().optional(),
  path: z.string().optional(), // legacy alias for resolved
  version: z.string(),
  hash: z.string(),
});

export const SkillLockSchema = z.object({
  skills: z.record(z.string(), SkillLockEntrySchema),
});
