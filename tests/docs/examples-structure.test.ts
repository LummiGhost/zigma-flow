/**
 * examples/ directory structure validation for wf-docs-examples Slice A.
 *
 * Reference:
 *   - docs/phases/v0.4-productization/workflows/wf-docs-examples/01-cases-and-tests.md
 *   - docs/phases/v0.4-productization/02-development-plan.md M3
 *
 * These tests validate the examples/ directory as a static artifact.
 * They use node:fs for file existence checks and the 'yaml' package
 * (already a project dependency) for workflow YAML parsing.
 *
 * Red phase: ALL tests fail because examples/ does not exist yet.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const EXAMPLES_DIR = join(REPO_ROOT, "examples");
const BASIC_CC_DIR = join(EXAMPLES_DIR, "basic-code-change");

/** Files that must exist in examples/basic-code-change/ */
const REQUIRED_EXAMPLE_FILES = [
  "package.json",
  "tsconfig.json",
  join("src", "index.ts"),
  join(".zigma-flow", "workflows", "code-change.yml"),
  join(".zigma-flow", "config.json"),
  join(".zigma-flow", "skills", "code-change", "skill.yml"),
];

/** Optional files that should exist but are not blockers */
const OPTIONAL_EXAMPLE_FILES = [
  "README.md",
  join(".zigma-flow", ".gitignore"),
  join(".zigma-flow", "skills", "code-change", "knowledge", "overview.md"),
  join(".zigma-flow", "skills", "code-change", "prompts", "analyze.md"),
  join(".zigma-flow", "skills", "code-change", "prompts", "implement.md"),
  join(".zigma-flow", "skills", "code-change", "checks", "intake-report.schema.json"),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a directory exists. */
async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** Check if a file exists. */
async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Detect cycles in a DAG using DFS.
 * nodes: map of node id -> set of dependency ids
 */
function detectCycles(deps: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]) {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      cycles.push([...path.slice(cycleStart), node]);
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    const neighbors = deps.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        dfs(neighbor, path);
      }
    }

    path.pop();
    inStack.delete(node);
  }

  for (const node of deps.keys()) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Suite: examples/ directory existence
// ---------------------------------------------------------------------------

describe("examples/ directory structure (T-EX-STRUCT)", () => {
  it("examples/ directory exists with basic-code-change/ subdir (T-EX-STRUCT-1)", async () => {
    // RED PHASE: examples/ does not exist yet
    const examplesExist = await dirExists(EXAMPLES_DIR);
    const basicCcExist = await dirExists(BASIC_CC_DIR);

    if (!examplesExist) {
      console.warn("  [RED] examples/ directory does not exist yet.");
    }
    if (!basicCcExist) {
      console.warn("  [RED] examples/basic-code-change/ directory does not exist yet.");
    }

    expect(examplesExist).toBe(true);
    expect(basicCcExist).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: required files inventory
// ---------------------------------------------------------------------------

describe("examples/ required files inventory (T-EX-STRUCT)", () => {
  let basicCcExists: boolean;

  beforeAll(async () => {
    basicCcExists = await dirExists(BASIC_CC_DIR);
  });

  for (const filePath of REQUIRED_EXAMPLE_FILES) {
    const testName = filePath.replace(/\\/g, "/"); // normalize for display
    it(`${testName} exists (T-EX-STRUCT-2+)`, async () => {
      if (!basicCcExists) {
        console.warn(`  [RED] examples/basic-code-change/ does not exist; cannot check "${testName}"`);
        // Don't skip -- let the test fail to indicate red phase
      }
      const fullPath = join(BASIC_CC_DIR, filePath);
      const exists = await fileExists(fullPath);
      expect(exists).toBe(true);
    });
  }

  it("has at minimum the optional README for self-documentation (T-EX-README-1)", async () => {
    // Check for either examples/basic-code-change/README.md or examples/README.md
    const exampleReadme = join(BASIC_CC_DIR, "README.md");
    const dirReadme = join(EXAMPLES_DIR, "README.md");

    const [hasExampleReadme, hasDirReadme] = await Promise.all([
      fileExists(exampleReadme),
      fileExists(dirReadme),
    ]);

    const hasAnyReadme = hasExampleReadme || hasDirReadme;
    if (!hasAnyReadme) {
      console.warn("  [RED] No README found in examples/ or examples/basic-code-change/.");
    }
    expect(hasAnyReadme).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: workflow YAML validation
// ---------------------------------------------------------------------------

describe("example workflow YAML validation (T-EX-YAML)", () => {
  const WORKFLOW_PATH = join(BASIC_CC_DIR, ".zigma-flow", "workflows", "code-change.yml");

  let workflowYaml: string | null = null;

  beforeAll(async () => {
    try {
      workflowYaml = await readFile(WORKFLOW_PATH, "utf-8");
    } catch {
      workflowYaml = null;
    }
  });

  it("example workflow YAML parses successfully (T-EX-YAML-1)", () => {
    expect(workflowYaml).not.toBeNull();

    if (workflowYaml) {
      try {
        const parsed = parseYaml(workflowYaml);
        expect(parsed).toBeDefined();
      } catch (err) {
        expect.fail(`YAML parse error: ${(err as Error).message}`);
      }
    }
  });

  it("workflow has required fields: name, jobs (T-EX-YAML-2)", () => {
    expect(workflowYaml).not.toBeNull();

    if (workflowYaml) {
      const parsed = parseYaml(workflowYaml) as Record<string, unknown>;
      expect(parsed.name).toBeDefined();
      expect(typeof parsed.name).toBe("string");
      expect(parsed.jobs).toBeDefined();
      expect(typeof parsed.jobs).toBe("object");
    }
  });

  it("workflow DAG has no cycles (T-EX-YAML-3)", () => {
    expect(workflowYaml).not.toBeNull();

    if (workflowYaml) {
      const parsed = parseYaml(workflowYaml) as Record<string, unknown>;
      const jobs = parsed.jobs as Record<string, { needs?: string[]; optional?: boolean }> | undefined;
      expect(jobs).toBeDefined();

      if (jobs) {
        // Build dependency graph
        const deps = new Map<string, Set<string>>();
        for (const [jobId, jobDef] of Object.entries(jobs)) {
          if (!deps.has(jobId)) {
            deps.set(jobId, new Set());
          }
          if (jobDef.needs) {
            for (const need of jobDef.needs) {
              deps.get(jobId)!.add(need);
            }
          }
        }

        const cycles = detectCycles(deps);
        if (cycles.length > 0) {
          const cycleStrs = cycles.map((c) => c.join(" -> "));
          expect.fail(`DAG has cycles: ${cycleStrs.join("; ")}`);
        }
        expect(cycles).toEqual([]);
      }
    }
  });

  it("all job references in needs exist in jobs map (T-EX-YAML-4)", () => {
    expect(workflowYaml).not.toBeNull();

    if (workflowYaml) {
      const parsed = parseYaml(workflowYaml) as Record<string, unknown>;
      const jobs = parsed.jobs as Record<string, unknown> | undefined;
      expect(jobs).toBeDefined();

      if (jobs) {
        const jobIds = new Set(Object.keys(jobs));
        const missingRefs: string[] = [];

        // Check needs references
        for (const [jobId, jobDef] of Object.entries(jobs)) {
          const jd = jobDef as { needs?: string[] };
          if (jd.needs) {
            for (const need of jd.needs) {
              if (!jobIds.has(need)) {
                missingRefs.push(`${jobId}.needs: "${need}"`);
              }
            }
          }
        }

        if (missingRefs.length > 0) {
          expect.fail(
            `Job references do not exist in jobs map: ${missingRefs.join(", ")}`
          );
        }
        expect(missingRefs).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: config.json validation
// ---------------------------------------------------------------------------

describe("example config.json validation (T-EX-CONFIG)", () => {
  const CONFIG_PATH = join(BASIC_CC_DIR, ".zigma-flow", "config.json");

  let configJson: string | null = null;

  beforeAll(async () => {
    try {
      configJson = await readFile(CONFIG_PATH, "utf-8");
    } catch {
      configJson = null;
    }
  });

  it("config.json exists and has valid agent backend config (T-EX-CONFIG-1)", () => {
    expect(configJson).not.toBeNull();

    if (configJson) {
      const config = JSON.parse(configJson) as Record<string, unknown>;

      // Agent config must have a backend field
      expect(config.agent).toBeDefined();
      const agent = config.agent as Record<string, unknown>;
      expect(agent.backend).toBeDefined();
      expect(typeof agent.backend).toBe("string");

      // Backends config must contain the referenced backend
      if (agent.backends) {
        const backends = agent.backends as Record<string, unknown>;
        const backendName = agent.backend as string;
        expect(backends[backendName]).toBeDefined();
      }
    }
  });

  it("config.json has parallelism configuration", () => {
    // Parallelism may be in agent config or top level
    if (configJson) {
      const config = JSON.parse(configJson) as Record<string, unknown>;
      const agent = config.agent as Record<string, unknown> | undefined;
      // Either agent.parallelism or at top level
      const hasParallelism =
        (agent && typeof agent.parallelism === "number") ||
        typeof config.parallelism === "number";
      // Not required but noted if missing
      if (!hasParallelism) {
        console.warn("  [INFO] config.json has no parallelism setting (will use default 4).");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: example project scripts
// ---------------------------------------------------------------------------

describe("example project package.json scripts (T-EX-SCRIPTS)", () => {
  const PKG_PATH = join(BASIC_CC_DIR, "package.json");

  let pkgJson: string | null = null;

  beforeAll(async () => {
    try {
      pkgJson = await readFile(PKG_PATH, "utf-8");
    } catch {
      pkgJson = null;
    }
  });

  it("package.json has typecheck, lint, and test scripts (T-EX-SCRIPTS-1)", () => {
    expect(pkgJson).not.toBeNull();

    if (pkgJson) {
      const pkg = JSON.parse(pkgJson) as { scripts?: Record<string, string> };

      // The example must have the scripts that make the code-change workflow runnable
      const requiredScripts = ["typecheck", "lint", "test"];
      const missingScripts: string[] = [];

      for (const script of requiredScripts) {
        if (!pkg.scripts || !pkg.scripts[script]) {
          missingScripts.push(script);
        }
      }

      if (missingScripts.length > 0) {
        expect.fail(
          `package.json is missing required scripts: ${missingScripts.join(", ")}`
        );
      }
      expect(missingScripts).toEqual([]);
    }
  });
});
