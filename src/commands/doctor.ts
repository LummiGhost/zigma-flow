/**
 * doctor command action handler.
 *
 * Runs independent diagnostics checks on a zigma-flow project:
 *   1. Node.js version check (always runs, independent of project state)
 *   2. config.json validity
 *   3. skill-lock.json validity
 *   4. Workflow YAML validity (parse + schema)
 *   5. Skill pack manifest validity (parse + schema)
 *
 * Each check runs independently -- a failure in one check does not prevent
 * subsequent checks from executing. Output is line-oriented [LEVEL] message
 * with a summary line.
 *
 * Exit codes: 0 = all checks pass; 1 = any FAIL or WARN.
 *
 * Reference:
 *   docs/phases/v0.4-productization/workflows/wf-doctor/01-cases-and-tests.md
 *   GitHub Issue #97
 * WF-DOCTOR Step 2.
 */

import { readFileSync, existsSync } from "node:fs";
import { readFile, readdir, access } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadWorkflow } from "../workflow/index.js";
import { loadSkillPack, discoverSkillPacks } from "../skill-pack/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckLevel = "PASS" | "FAIL" | "WARN";

export interface CheckResult {
  level: CheckLevel;
  message: string;
}

export interface DoctorActionOptions {
  /** Path to .zigma-flow/ directory. */
  zigmaflowDir: string;
  /** Output sink for check results (default: console.log). */
  stdout?: (line: string) => void;
  /** Output sink for error messages (default: console.error). */
  stderr?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tool root directory (where package.json lives). Resolved relative to
 * this source file at module load time.
 */
const TOOL_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function isEnoent(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as Record<string, unknown>)["code"] === "ENOENT"
  );
}

/**
 * Compare two dot-separated version strings. Returns negative if a < b,
 * zero if equal, positive if a > b.
 */
function compareVersions(a: string, b: string): number {
  const aParts = a.split(".").map(Number);
  const bParts = b.split(".").map(Number);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

/**
 * Parse an engines.node semver string (e.g. ">=20.11.0") and return the
 * bare minimum version. Falls back to "20.11.0" when unparseable.
 */
function parseMinVersion(engine: string): string {
  const cleaned = engine.replace(/^[>=<~^]+\s*/, "").trim();
  if (cleaned.length === 0) return "20.11.0";
  const parts = cleaned.split(".");
  if (parts.length < 2 || parts.some((p) => isNaN(Number(p)))) {
    return "20.11.0";
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// checkNodeVersion
// ---------------------------------------------------------------------------

/**
 * Check that the current Node.js version satisfies the engines.node
 * requirement from the tool's package.json. Defaults to >=20.11.0 when
 * the field is absent or unparseable (AD-WF-DOCTOR-005).
 */
export function checkNodeVersion(): CheckResult {
  let minVersion = "20.11.0";

  try {
    const pkgPath = join(TOOL_ROOT, "package.json");
    if (existsSync(pkgPath)) {
      const pkg: Record<string, unknown> = JSON.parse(
        readFileSync(pkgPath, "utf-8"),
      );
      const engines = pkg["engines"] as Record<string, unknown> | undefined;
      if (
        engines?.node !== undefined &&
        typeof engines.node === "string"
      ) {
        minVersion = parseMinVersion(engines.node);
      }
    }
  } catch {
    // Fall back to default
  }

  const current = process.versions.node;
  const satisfies = compareVersions(current, minVersion) >= 0;

  if (satisfies) {
    return {
      level: "PASS",
      message: `Node.js ${current} satisfies >=${minVersion}`,
    };
  }
  return {
    level: "FAIL",
    message: `Node.js ${current} does not satisfy >=${minVersion} (minimum: ${minVersion})`,
  };
}

// ---------------------------------------------------------------------------
// checkConfigJson
// ---------------------------------------------------------------------------

/**
 * Check that config.json exists, is valid JSON, and has the required
 * fields: tool_version and agent.
 *
 * Also warns if the deprecated "version" field is present.
 */
export async function checkConfigJson(
  zigmaflowDir: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const configPath = join(zigmaflowDir, "config.json");

  let text: string;
  try {
    text = await readFile(configPath, "utf-8");
  } catch (e: unknown) {
    if (isEnoent(e)) {
      return [{ level: "FAIL", message: "config.json: file not found" }];
    }
    return [{
      level: "FAIL",
      message: `config.json: cannot read file (${String(e)})`,
    }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: unknown) {
    return [{
      level: "FAIL",
      message: `config.json: invalid JSON (${e instanceof Error ? e.message : String(e)})`,
    }];
  }

  if (typeof parsed !== "object" || parsed === null) {
    return [{ level: "FAIL", message: "config.json: must be a JSON object" }];
  }

  const obj = parsed as Record<string, unknown>;
  const missing: string[] = [];

  if (typeof obj["tool_version"] !== "string") {
    missing.push("tool_version");
  }
  if (typeof obj["agent"] !== "object" || obj["agent"] === null) {
    missing.push("agent");
  }

  if (missing.length > 0) {
    results.push({
      level: "FAIL",
      message: `config.json: missing required field(s): ${missing.join(", ")}`,
    });
  } else {
    results.push({ level: "PASS", message: "config.json valid" });
  }

  // Warn about deprecated "version" field
  if (typeof obj["version"] === "string") {
    results.push({
      level: "WARN",
      message:
        "config.json: 'version' field is deprecated. Project history is tracked by git. " +
        "This will be removed in v1.0.",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// checkSkillLockJson
// ---------------------------------------------------------------------------

/**
 * Check that skill-lock.json exists, is valid JSON, has a 'skills' field,
 * and that each skill entry's resolved path exists on disk.
 */
export async function checkSkillLockJson(
  zigmaflowDir: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const lockPath = join(zigmaflowDir, "skill-lock.json");

  let text: string;
  try {
    text = await readFile(lockPath, "utf-8");
  } catch (e: unknown) {
    if (isEnoent(e)) {
      results.push({
        level: "WARN",
        message: "skill-lock.json: file not found (deprecated, skill discovery is preferred)",
      });
      return results;
    }
    results.push({
      level: "FAIL",
      message: `skill-lock.json: cannot read file (${String(e)})`,
    });
    return results;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: unknown) {
    results.push({
      level: "FAIL",
      message: `skill-lock.json: invalid JSON (${e instanceof Error ? e.message : String(e)})`,
    });
    return results;
  }

  if (typeof parsed !== "object" || parsed === null) {
    results.push({
      level: "FAIL",
      message: "skill-lock.json: must be a JSON object",
    });
    return results;
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj["skills"] !== "object" || obj["skills"] === null) {
    results.push({
      level: "FAIL",
      message: "skill-lock.json: missing required field 'skills'",
    });
    return results;
  }

  const skills = obj["skills"] as Record<string, unknown>;

  // For each skill entry, check that the resolved path exists on disk
  for (const [skillId, skillEntry] of Object.entries(skills)) {
    if (typeof skillEntry !== "object" || skillEntry === null) {
      results.push({
        level: "WARN",
        message: `skill '${skillId}': invalid entry in skill-lock.json`,
      });
      continue;
    }

    const entry = skillEntry as Record<string, unknown>;
    const resolved =
      (entry["resolved"] as string | undefined) ??
      (entry["path"] as string | undefined);

    if (typeof resolved !== "string") {
      results.push({
        level: "WARN",
        message: `skill '${skillId}': missing resolved or path field`,
      });
      continue;
    }

    const localPath = resolved.startsWith("local://")
      ? resolved.slice("local://".length)
      : resolved;
    const resolvedDir = join(zigmaflowDir, localPath);

    try {
      await access(resolvedDir);
    } catch {
      results.push({
        level: "WARN",
        message: `skill '${skillId}': resolved path not found (${join(".zigma-flow", localPath)})`,
      });
    }
  }

  // Structural validation passed
  results.push({ level: "PASS", message: "skill-lock.json valid" });

  // Deprecation warning for skill-lock.json
  results.push({
    level: "WARN",
    message:
      "[DEPRECATED] skill-lock.json is deprecated. Skill version management will move to " +
      "zigma-skill. Place skill packs directly in skill search paths instead. " +
      "This will be removed in v1.0.",
  });

  return results;
}

// ---------------------------------------------------------------------------
// checkWorkflowYaml
// ---------------------------------------------------------------------------

/**
 * Check that .yml and .yaml files under .zigma-flow/workflows/ are valid
 * workflow definitions (parseable YAML + schema validation via loadWorkflow).
 *
 * Reports WARN when the workflows/ directory is missing or empty.
 */
export async function checkWorkflowYaml(
  zigmaflowDir: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const workflowsDir = join(zigmaflowDir, "workflows");

  let entries: string[];
  try {
    entries = await readdir(workflowsDir);
  } catch (e: unknown) {
    if (isEnoent(e)) {
      results.push({
        level: "WARN",
        message: "workflows: directory not found (.zigma-flow/workflows/)",
      });
      return results;
    }
    results.push({
      level: "WARN",
      message: `workflows: cannot read directory (${String(e)})`,
    });
    return results;
  }

  const yamlFiles = entries.filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );

  if (yamlFiles.length === 0) {
    results.push({
      level: "WARN",
      message: "workflows: no .yml or .yaml files found",
    });
    return results;
  }

  for (const file of yamlFiles) {
    const filePath = join(workflowsDir, file);
    try {
      const text = await readFile(filePath, "utf-8");
      loadWorkflow(text);
      results.push({
        level: "PASS",
        message: `workflows/${file}: valid`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        level: "FAIL",
        message: `workflows/${file}: ${msg}`,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// checkSkillPacks
// ---------------------------------------------------------------------------

/**
 * Check that each skill pack referenced in skill-lock.json has a valid,
 * loadable skill.yml manifest. Reads skill-lock.json independently and
 * gracefully handles missing/unparseable lock files with WARN results
 * (not silently omitted -- see AD-WF-DOCTOR-002).
 */
export async function checkSkillPacks(
  zigmaflowDir: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const lockPath = join(zigmaflowDir, "skill-lock.json");

  let lockText: string;
  try {
    lockText = await readFile(lockPath, "utf-8");
  } catch {
    results.push({
      level: "WARN",
      message: "skill packs: cannot read skill-lock.json, skipping check",
    });
    return results;
  }

  let lockParsed: unknown;
  try {
    lockParsed = JSON.parse(lockText);
  } catch {
    results.push({
      level: "WARN",
      message: "skill packs: skill-lock.json has invalid JSON, skipping check",
    });
    return results;
  }

  if (typeof lockParsed !== "object" || lockParsed === null) {
    results.push({
      level: "WARN",
      message: "skill packs: skill-lock.json is not an object, skipping check",
    });
    return results;
  }

  const lockObj = lockParsed as Record<string, unknown>;
  const skills = lockObj["skills"];

  if (typeof skills !== "object" || skills === null) {
    results.push({
      level: "WARN",
      message: "skill packs: skill-lock.json has no 'skills' field, skipping check",
    });
    return results;
  }

  const skillEntries = skills as Record<string, unknown>;

  if (Object.keys(skillEntries).length === 0) {
    results.push({
      level: "WARN",
      message: "skill packs: no skills declared in skill-lock.json",
    });
    return results;
  }

  for (const [skillId, skillEntry] of Object.entries(skillEntries)) {
    if (typeof skillEntry !== "object" || skillEntry === null) {
      results.push({
        level: "FAIL",
        message: `skill '${skillId}': invalid entry in skill-lock.json`,
      });
      continue;
    }

    const entry = skillEntry as Record<string, unknown>;
    const resolved =
      (entry["resolved"] as string | undefined) ??
      (entry["path"] as string | undefined);

    if (typeof resolved !== "string") {
      results.push({
        level: "FAIL",
        message: `skill '${skillId}': missing resolved path`,
      });
      continue;
    }

    const localPath = resolved.startsWith("local://")
      ? resolved.slice("local://".length)
      : resolved;
    const packRoot = join(zigmaflowDir, localPath);

    try {
      await loadSkillPack(packRoot);
      results.push({
        level: "PASS",
        message: `skill '${skillId}': manifest valid`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        level: "FAIL",
        message: `skill '${skillId}': ${msg}`,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// checkSkillDiscovery — scan skill search paths (v0.6)
// ---------------------------------------------------------------------------

/**
 * Scan all skill search paths and report:
 *   - Which search paths exist and are scanned
 *   - Which skills were discovered from each path
 *   - Name conflicts (same skill id found in multiple paths)
 *
 * Uses the new discovery mechanism: direct path scanning with deterministic
 * priority ordering. skill-lock.json is deprecated; skill resolution should
 * use direct discovery instead.
 */
export async function checkSkillDiscovery(
  zigmaflowDir: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const projectRoot = resolve(zigmaflowDir, "..");
  const discovery = await discoverSkillPacks(projectRoot);

  // Report search paths
  results.push({
    level: "PASS",
    message: `skill discovery: scanning ${discovery.searchPaths.length} search path(s)`,
  });

  for (const sp of discovery.searchPaths) {
    let dirExists = false;
    try {
      await access(sp.path);
      dirExists = true;
    } catch {
      // Directory does not exist
    }

    if (dirExists) {
      results.push({
        level: "PASS",
        message: `  [priority ${sp.priority}] ${sp.source} → ${sp.path}`,
      });
    } else {
      results.push({
        level: "WARN",
        message: `  [priority ${sp.priority}] ${sp.source} → ${sp.path} (not found)`,
      });
    }
  }

  // Report discovered skills
  if (discovery.skills.length === 0) {
    results.push({
      level: "WARN",
      message: "skill discovery: no skill packs found in any search path",
    });
  } else {
    results.push({
      level: "PASS",
      message: `skill discovery: ${discovery.skills.length} skill pack(s) found`,
    });

    for (const skill of discovery.skills) {
      const conflictNote = skill.conflict
        ? ` (CONFLICT: also found at ${skill.conflictPaths.join(", ")})`
        : "";
      const level = skill.conflict ? "WARN" as const : "PASS" as const;
      results.push({
        level,
        message: `  ${skill.skillId} → ${skill.packRoot} [${skill.source}]${conflictNote}`,
      });
    }
  }

  // Report lock file status
  if (discovery.usedLockFile) {
    results.push({
      level: "WARN",
      message:
        "[DEPRECATED] skill discovery also used skill-lock.json. " +
        "Prefer direct skill discovery. This will be removed in v1.0.",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// doctorAction -- orchestrator
// ---------------------------------------------------------------------------

/**
 * Run all doctor checks and return the exit code.
 *
 * All checks run independently: a failure in an early check (e.g.
 * config.json) does not prevent later checks (e.g. workflow YAML) from
 * executing (AD-WF-DOCTOR-002). If the .zigma-flow/ directory does not
 * exist, the project-specific checks are skipped and the user is directed
 * to run `zigma-flow init`.
 *
 * @returns 0 when all checks PASS; 1 when any FAIL or WARN is present.
 */
export async function doctorAction(
  opts: DoctorActionOptions,
): Promise<number> {
  const out = opts.stdout ?? ((line: string) => { console.log(line); });
  const _err = opts.stderr ?? ((line: string) => { console.error(line); });

  const { zigmaflowDir } = opts;

  // Check if .zigma-flow/ directory exists
  let projectExists = false;
  try {
    await access(zigmaflowDir);
    projectExists = true;
  } catch {
    // Directory does not exist
  }

  const allResults: CheckResult[] = [];

  // Check 1: Node version (always runs, independent of project state)
  allResults.push(checkNodeVersion());

  if (!projectExists) {
    allResults.push({
      level: "FAIL",
      message:
        "Project directory .zigma-flow/ not found. Did you run `zigma-flow init`?",
    });
  } else {
    // Check 2: config.json validity (returns array now for v0.6 deprecation warnings)
    const configResults = await checkConfigJson(zigmaflowDir);
    allResults.push(...configResults);

    // Check 3: skill-lock.json validity (with deprecation warning)
    const lockResults = await checkSkillLockJson(zigmaflowDir);
    allResults.push(...lockResults);

    // Check 4: workflow YAML validity
    const workflowResults = await checkWorkflowYaml(zigmaflowDir);
    allResults.push(...workflowResults);

    // Check 5: skill pack discovery (v0.6 — scan search paths, show sources and conflicts)
    const skillDiscoveryResults = await checkSkillDiscovery(zigmaflowDir);
    allResults.push(...skillDiscoveryResults);

    // Check 5b: skill pack manifest validity (from lock file, if present)
    const skillPackResults = await checkSkillPacks(zigmaflowDir);
    allResults.push(...skillPackResults);
  }

  // Print results and compute summary
  let passed = 0;
  let failed = 0;
  let warned = 0;

  for (const result of allResults) {
    out(`[${result.level}] ${result.message}`);
    if (result.level === "PASS") passed++;
    else if (result.level === "FAIL") failed++;
    else if (result.level === "WARN") warned++;
  }

  out(`Summary: ${passed} passed, ${failed} failed, ${warned} warnings`);

  return failed > 0 || warned > 0 ? 1 : 0;
}
