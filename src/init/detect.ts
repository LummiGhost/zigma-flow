import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Environment detection for zigma-flow init.
 *
 * Step 2 implementation — detection via lockfiles and package.json.
 *
 * Reference:
 *   - docs/phases/v0.4-productization/workflows/wf-init/01-cases-and-tests.md
 *   - docs/phases/v0.4-productization/02-development-plan.md §M1
 *   - docs/prd.md FR-001
 *
 * Module boundaries: must NOT import engine, workflow, skill-pack, dag, context,
 * prompt, script, check, artifact, run, events, workspace, git, or expression.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Supported package managers detected from lockfiles. */
export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/**
 * Detected project scripts.
 * Each boolean indicates whether the named script exists in package.json's
 * `scripts` field.
 */
export interface DetectedScripts {
  readonly typecheck: boolean;
  readonly lint: boolean;
  readonly test: boolean;
  readonly testCi: boolean;
  readonly build: boolean;
}

/** Full environment detection result. */
export interface DetectionResult {
  /** Detected package manager (falls back to "npm"). */
  readonly packageManager: PackageManager;
  /** Available scripts found in package.json. */
  readonly scripts: DetectedScripts;
  /** Whether a package.json file exists and is readable. */
  readonly hasPackageJson: boolean;
}

// ---------------------------------------------------------------------------
// Public API (red-phase stubs)
// ---------------------------------------------------------------------------

/**
 * Detect the package manager by checking for lockfiles in `cwd`.
 *
 * Priority order: pnpm-lock.yaml > yarn.lock > package-lock.json >
 * bun.lockb > bun.lock. Falls back to "npm" when no lockfile is found.
 */
export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  // Priority order: pnpm-lock.yaml > yarn.lock > package-lock.json > bun.lockb > bun.lock
  const lockfiles: Array<[string, PackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"]
  ];

  for (const [lockfile, pm] of lockfiles) {
    try {
      await stat(join(cwd, lockfile));
      return pm;
    } catch {
      // lockfile not found — continue to next
    }
  }

  // No lockfile found — default to npm
  return "npm";
}

/**
 * Detect available scripts from package.json in `cwd`.
 *
 * Checks for typecheck, lint, test, test:ci, and build scripts.
 * Returns all-false when package.json is missing or has no scripts field.
 */
export async function detectScripts(cwd: string): Promise<DetectedScripts> {
  const allFalse: DetectedScripts = {
    typecheck: false,
    lint: false,
    test: false,
    testCi: false,
    build: false
  };

  let pkgRaw: string;
  try {
    pkgRaw = await readFile(join(cwd, "package.json"), "utf-8");
  } catch {
    // package.json not found — return all-false
    return allFalse;
  }

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
  } catch {
    // Invalid JSON — return all-false
    return allFalse;
  }

  const scripts = pkg.scripts ?? {};

  return {
    typecheck: typeof scripts.typecheck === "string",
    lint: typeof scripts.lint === "string",
    test: typeof scripts.test === "string",
    testCi: typeof scripts["test:ci"] === "string",
    build: typeof scripts.build === "string"
  };
}

/**
 * Full environment detection: package manager + scripts + package.json existence.
 */
export async function detectEnvironment(cwd: string): Promise<DetectionResult> {
  const [packageManager, scripts] = await Promise.all([
    detectPackageManager(cwd),
    detectScripts(cwd)
  ]);

  // Determine hasPackageJson by checking if package.json exists and is valid JSON
  let hasPackageJson = false;
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf-8");
    JSON.parse(raw);
    hasPackageJson = true;
  } catch {
    hasPackageJson = false;
  }

  return { packageManager, scripts, hasPackageJson };
}

/**
 * Build a script execution command for the given package manager and script
 * name.
 *
 * pnpm:  "pnpm typecheck"
 * npm:   "npm run typecheck"
 * yarn:  "yarn typecheck"
 * bun:   "bun run typecheck"
 */
export function buildScriptCommand(pm: PackageManager, scriptName: string): string {
  // pnpm and yarn: "pnpm <script>" / "yarn <script>"
  // npm and bun: "npm run <script>" / "bun run <script>"
  const needsRun = pm === "npm" || pm === "bun";
  return needsRun ? `${pm} run ${scriptName}` : `${pm} ${scriptName}`;
}
