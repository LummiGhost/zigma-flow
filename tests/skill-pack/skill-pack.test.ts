import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import {
  loadSkillPack,
  resolveSkillLock,
  resetSkillLockDeprecationWarning,
} from "../../src/skill-pack/index.js";
import {
  FilesystemError,
  ValidationError,
  ZigmaFlowError
} from "../../src/utils/index.js";

/**
 * Skill Pack loader, path-safety, skill-lock resolver, and validate-CLI tests
 * for WF-P2-VALIDATE (Step 1).
 *
 * Reference:
 *   - docs/prd.md FR-003, §9, §11
 *   - docs/mvp-contracts.md §7 (error -> exit code mapping)
 *   - docs/phases/p2-validate/workflows/wf-p2-validate/01-cases-and-tests.md
 *
 * Red-phase: `src/skill-pack/index.ts` and the `validate` CLI subcommand are
 * stubs until Step 2.
 */

// ---------------------------------------------------------------------------
// CLI capture helper (mirrors tests/cli/cli.test.ts)
// ---------------------------------------------------------------------------

interface CapturedRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly error: unknown;
}

async function runMain(args: ReadonlyArray<string>): Promise<CapturedRun> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdoutChunks.push(parts.map(String).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderrChunks.push(parts.map(String).join(" "));
  });

  const previousExitCode = process.exitCode;
  process.exitCode = 0;

  let caught: unknown = undefined;
  try {
    await main(["node", "zigma-flow", ...args]);
  } catch (error: unknown) {
    caught = error;
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  const observedExitCode = process.exitCode;
  process.exitCode = previousExitCode;

  return {
    stdout: stdoutChunks.join("\n"),
    stderr: stderrChunks.join("\n"),
    exitCode: typeof observedExitCode === "number" ? observedExitCode : undefined,
    error: caught
  };
}

// ---------------------------------------------------------------------------
// Pack scaffolding helpers
// ---------------------------------------------------------------------------

const CANONICAL_SKILL_YAML = `id: zigma.code-change
name: Code Change Skill Pack
version: 1.0.0
kind: skill-pack
description: Canonical pack used for WF-P2-VALIDATE tests.

knowledge:
  - id: coding-guidelines
    path: knowledge/coding-guidelines.md
    description: General coding guidance.

prompts:
  - id: implement
    path: prompts/implement.md

scripts:
  - id: collect-diff
    runtime: node
    path: scripts/collect-diff.ts

checks:
  - id: report-schema
    kind: json-schema
    path: checks/report-schema.json

policies:
  default_permissions:
    contents: read
    edits: none
    commands: none
    workflow_state: none
`;

async function scaffoldCanonicalPack(root: string): Promise<void> {
  await mkdir(join(root, "knowledge"), { recursive: true });
  await mkdir(join(root, "prompts"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "checks"), { recursive: true });

  await writeFile(join(root, "skill.yml"), CANONICAL_SKILL_YAML, "utf-8");
  await writeFile(
    join(root, "knowledge", "coding-guidelines.md"),
    "# Coding guidelines\n",
    "utf-8"
  );
  await writeFile(join(root, "prompts", "implement.md"), "# Implement\nstop after completing\n", "utf-8");
  await writeFile(
    join(root, "scripts", "collect-diff.ts"),
    "export const placeholder = true;\n",
    "utf-8"
  );
  await writeFile(
    join(root, "checks", "report-schema.json"),
    "{}\n",
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// Skill Pack schema (FP-SP-SCH)
// ---------------------------------------------------------------------------

describe("skill pack schema (FP-SP-SCH)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-sp-sch-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loadSkillPack accepts canonical pack (T-SP-1 / UC-SP-1)", async () => {
    const packRoot = join(tempDir, "code-change");
    await scaffoldCanonicalPack(packRoot);

    const def = await loadSkillPack(packRoot);
    expect(def).toBeDefined();
    const d = def as {
      kind: string;
      knowledge: ReadonlyArray<{ id: string; path: string }>;
      scripts: ReadonlyArray<{ id: string; path: string }>;
    };
    expect(d.kind).toBe("skill-pack");
    expect(d.knowledge.length).toBeGreaterThan(0);
    expect(d.scripts.length).toBeGreaterThan(0);
  });

  it("loadSkillPack rejects manifest missing kind (T-SP-2 / UC-SP-2)", async () => {
    const packRoot = join(tempDir, "no-kind");
    await scaffoldCanonicalPack(packRoot);
    const noKind = CANONICAL_SKILL_YAML.split("\n")
      .filter((line) => !line.startsWith("kind:"))
      .join("\n");
    await writeFile(join(packRoot, "skill.yml"), noKind, "utf-8");

    let thrown: unknown;
    try {
      await loadSkillPack(packRoot);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    const err = thrown as ValidationError;
    expect(JSON.stringify(err.details ?? {})).toContain("kind");
  });

  it("loadSkillPack rejects manifest with kind other than skill-pack (T-SP-3 / UC-SP-3)", async () => {
    const packRoot = join(tempDir, "bad-kind");
    await scaffoldCanonicalPack(packRoot);
    const badKind = CANONICAL_SKILL_YAML.replace("kind: skill-pack", "kind: workflow");
    await writeFile(join(packRoot, "skill.yml"), badKind, "utf-8");

    let thrown: unknown;
    try {
      await loadSkillPack(packRoot);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Path safety (FP-SP-LOAD + FP-SP-PATH)
// ---------------------------------------------------------------------------

describe("skill pack path safety (FP-SP-LOAD, FP-SP-PATH)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-sp-path-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loadSkillPack rejects manifest referencing non-existent file (T-SP-4 / UC-SP-4)", async () => {
    const packRoot = join(tempDir, "missing-knowledge");
    await scaffoldCanonicalPack(packRoot);
    // Remove the referenced knowledge file.
    await rm(join(packRoot, "knowledge", "coding-guidelines.md"));

    let thrown: unknown;
    try {
      await loadSkillPack(packRoot);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ZigmaFlowError);
    const err = thrown as ZigmaFlowError;
    // Must surface as a SkillPackError per the taxonomy.
    expect(err.kind).toBe("SkillPackError");
  });

  it("loadSkillPack rejects manifest with path that escapes pack root (T-SP-5 / UC-SP-5)", async () => {
    const packRoot = join(tempDir, "escape-up");
    await scaffoldCanonicalPack(packRoot);
    // Stage a sibling file outside the pack root.
    await writeFile(join(tempDir, "outside.md"), "leak", "utf-8");
    // Rewrite skill.yml to reference a path that walks above the pack root.
    const escapeYaml = CANONICAL_SKILL_YAML.replace(
      "    path: knowledge/coding-guidelines.md",
      "    path: ../outside.md"
    );
    await writeFile(join(packRoot, "skill.yml"), escapeYaml, "utf-8");

    let thrown: unknown;
    try {
      await loadSkillPack(packRoot);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ZigmaFlowError);
    const err = thrown as ZigmaFlowError;
    expect(err.kind).toBe("SkillPackError");
  });

  it("loadSkillPack rejects manifest with absolute path (T-SP-6 / UC-SP-6)", async () => {
    const packRoot = join(tempDir, "abs-path");
    await scaffoldCanonicalPack(packRoot);
    // Use an absolute path that resolves to a real file (the canonical pack's
    // knowledge file) but is provided in absolute form. The loader must reject
    // any absolute path even when it would happen to land inside the pack.
    const target = resolve(packRoot, "knowledge", "coding-guidelines.md");
    expect(isAbsolute(target)).toBe(true);
    const absYaml = CANONICAL_SKILL_YAML.replace(
      "    path: knowledge/coding-guidelines.md",
      `    path: ${target.replace(/\\/g, "/")}`
    );
    await writeFile(join(packRoot, "skill.yml"), absYaml, "utf-8");

    let thrown: unknown;
    try {
      await loadSkillPack(packRoot);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ZigmaFlowError);
    const err = thrown as ZigmaFlowError;
    expect(err.kind).toBe("SkillPackError");
  });
});

// ---------------------------------------------------------------------------
// Skill lock schema and resolver (FP-LK-SCH + FP-LK-RES)
// ---------------------------------------------------------------------------

describe("skill lock resolver (FP-LK-SCH, FP-LK-RES)", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "zigma-flow-lk-"));
    await mkdir(join(baseDir, ".zigma-flow", "skills", "code-change"), { recursive: true });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("resolveSkillLock turns local URI into absolute pack root (T-LK-1 / UC-LK-1)", async () => {
    const lockfile = join(baseDir, ".zigma-flow", "skill-lock.json");
    await writeFile(
      lockfile,
      JSON.stringify(
        {
          skills: {
            "zigma.code-change": {
              version: "1.0.0",
              resolved: "local://skills/code-change",
              hash: "sha256:deadbeef"
            }
          }
        },
        null,
        2
      ),
      "utf-8"
    );

    const resolved = await resolveSkillLock(baseDir, "zigma.code-change");
    expect(typeof resolved).toBe("string");
    expect(resolved).toBe(join(baseDir, ".zigma-flow", "skills", "code-change"));
  });

  it("resolveSkillLock throws FilesystemError when lockfile missing (T-LK-2 / UC-LK-2)", async () => {
    let thrown: unknown;
    try {
      await resolveSkillLock(baseDir, "zigma.code-change");
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(FilesystemError);
  });

  it("resolveSkillLock throws SkillPackError when skill id absent from lockfile (T-LK-3 / UC-LK-3)", async () => {
    const lockfile = join(baseDir, ".zigma-flow", "skill-lock.json");
    await writeFile(
      lockfile,
      JSON.stringify({ skills: {} }, null, 2),
      "utf-8"
    );

    let thrown: unknown;
    try {
      await resolveSkillLock(baseDir, "zigma.code-change");
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ZigmaFlowError);
    expect((thrown as ZigmaFlowError).kind).toBe("SkillPackError");
  });
});

// ---------------------------------------------------------------------------
// validate CLI -> skill.yml tests (FP-CLI-VAL + FP-CLI-ERR + FP-CLI-EXIT)
// ---------------------------------------------------------------------------

describe("validate CLI (skill pack)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-validate-sp-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("validate CLI returns 0 on legal skill.yml (T-SP-CLI-1 / UC-CLI-V2)", async () => {
    const packRoot = join(tempDir, "code-change");
    await scaffoldCanonicalPack(packRoot);

    const result = await runMain(["validate", join(packRoot, "skill.yml")]);
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("validate CLI returns non-zero on skill.yml with bad kind (T-SP-CLI-2 / UC-CLI-V3)", async () => {
    const packRoot = join(tempDir, "bad-kind");
    await scaffoldCanonicalPack(packRoot);
    const badKind = CANONICAL_SKILL_YAML.replace("kind: skill-pack", "kind: workflow");
    await writeFile(join(packRoot, "skill.yml"), badKind, "utf-8");

    const result = await runMain(["validate", join(packRoot, "skill.yml")]);

    const failureSignaled =
      (typeof result.exitCode === "number" && result.exitCode !== 0) ||
      result.error !== undefined;
    expect(failureSignaled).toBe(true);
    // With content-based dispatch (Issue #5), kind != "skill-pack" routes to workflow loader.
    // The workflow loader reports a validation error because the file lacks required workflow fields.
    expect(result.stderr.toLowerCase()).toContain("validation");
  });
});

// ---------------------------------------------------------------------------
// Skill discovery from multiple search paths (v0.6, Issue #207)
// ---------------------------------------------------------------------------

describe("skill discovery (v0.6, Issue #207)", () => {
  let baseDir: string;
  let projectSkillsDir: string;
  let repoSettingsDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "zigma-flow-discover-"));
    projectSkillsDir = join(baseDir, ".zigma-flow", "skills");
    repoSettingsDir = join(baseDir, ".zigma", "skills");
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function createSkillPack(dir: string, id: string): Promise<void> {
    const packRoot = join(dir, id.split(".").pop() ?? id);
    await mkdir(packRoot, { recursive: true });
    await writeFile(
      join(packRoot, "skill.yml"),
      `id: ${id}\nkind: skill-pack\nname: ${id}\nversion: 1.0.0\n`,
      "utf-8",
    );
  }

  it("discovers skills from project-level path (.zigma-flow/skills/)", async () => {
    await createSkillPack(projectSkillsDir, "zigma.project-skill");

    const { discoverSkillPacks } = await import("../../src/skill-pack/index.js");
    const result = await discoverSkillPacks(baseDir);

    const found = result.skills.filter((s) => s.skillId === "zigma.project-skill");
    expect(found.length).toBe(1);
    expect(found[0]!.source).toContain(".zigma-flow/skills");
    expect(found[0]!.priority).toBe(10);
  });

  it("discovers skills from repository-level path (.zigma/skills/)", async () => {
    await createSkillPack(repoSettingsDir, "zigma.repo-skill");

    const { discoverSkillPacks } = await import("../../src/skill-pack/index.js");
    const result = await discoverSkillPacks(baseDir);

    const found = result.skills.filter((s) => s.skillId === "zigma.repo-skill");
    expect(found.length).toBe(1);
    expect(found[0]!.source).toContain(".zigma/skills");
    expect(found[0]!.priority).toBe(20);
  });

  it("discovers skills from both paths simultaneously", async () => {
    await createSkillPack(projectSkillsDir, "zigma.project-skill");
    await createSkillPack(repoSettingsDir, "zigma.repo-skill");

    const { discoverSkillPacks } = await import("../../src/skill-pack/index.js");
    const result = await discoverSkillPacks(baseDir);

    const ids = result.skills.map((s) => s.skillId).sort();
    expect(ids).toContain("zigma.project-skill");
    expect(ids).toContain("zigma.repo-skill");
    expect(result.searchPaths.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty list when no skill packs exist", async () => {
    const { discoverSkillPacks } = await import("../../src/skill-pack/index.js");
    const result = await discoverSkillPacks(baseDir);

    expect(result.skills.length).toBe(0);
    expect(result.searchPaths.length).toBeGreaterThan(0);
    expect(result.usedLockFile).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Name conflict resolution (v0.6, Issue #207)
// ---------------------------------------------------------------------------

describe("skill name conflict resolution (v0.6, Issue #207)", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "zigma-flow-conflict-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function createSkillPack(dir: string, id: string, version: string): Promise<void> {
    const packRoot = join(dir, id.split(".").pop() ?? id);
    await mkdir(packRoot, { recursive: true });
    await writeFile(
      join(packRoot, "skill.yml"),
      `id: ${id}\nkind: skill-pack\nname: ${id}\nversion: ${version}\n`,
      "utf-8",
    );
  }

  it("first path wins when same skill name in project and repo paths", async () => {
    const projectSkillsDir = join(baseDir, ".zigma-flow", "skills");
    const repoSettingsDir = join(baseDir, ".zigma", "skills");

    // Same id in both paths — project path wins (higher priority)
    await createSkillPack(projectSkillsDir, "zigma.shared", "1.0.0");
    await createSkillPack(repoSettingsDir, "zigma.shared", "2.0.0");

    const { discoverSkillPacks } = await import("../../src/skill-pack/index.js");
    const result = await discoverSkillPacks(baseDir);

    const found = result.skills.filter((s) => s.skillId === "zigma.shared");
    expect(found.length).toBe(1);

    // Project path has priority 10 (lower = higher priority), wins over repo (20)
    expect(found[0]!.source).toContain(".zigma-flow/skills");

    // Conflict should be reported
    expect(found[0]!.conflict).toBe(true);
    expect(found[0]!.conflictPaths.length).toBeGreaterThan(0);
    expect(found[0]!.conflictPaths.some((p) => p.includes(".zigma"))).toBe(true);
  });

  it("reports no conflict when skills have different names", async () => {
    const projectSkillsDir = join(baseDir, ".zigma-flow", "skills");
    const repoSettingsDir = join(baseDir, ".zigma", "skills");

    await createSkillPack(projectSkillsDir, "zigma.project-skill", "1.0.0");
    await createSkillPack(repoSettingsDir, "zigma.repo-skill", "1.0.0");

    const { discoverSkillPacks } = await import("../../src/skill-pack/index.js");
    const result = await discoverSkillPacks(baseDir);

    const projectSkill = result.skills.find((s) => s.skillId === "zigma.project-skill");
    const repoSkill = result.skills.find((s) => s.skillId === "zigma.repo-skill");

    expect(projectSkill).toBeDefined();
    expect(repoSkill).toBeDefined();
    expect(projectSkill!.conflict).toBe(false);
    expect(repoSkill!.conflict).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deprecation warnings (v0.6, Issue #207)
// ---------------------------------------------------------------------------

describe("skill-lock deprecation warnings (v0.6, Issue #207)", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "zigma-flow-deprecate-"));
    await mkdir(join(baseDir, ".zigma-flow", "skills", "code-change"), { recursive: true });
    // Reset the deprecation warning flag so each test gets a clean state
    resetSkillLockDeprecationWarning();
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("resolveSkillLock still works but emits deprecation warning", async () => {
    const lockfile = join(baseDir, ".zigma-flow", "skill-lock.json");
    await writeFile(
      lockfile,
      JSON.stringify({
        skills: {
          "zigma.code-change": {
            version: "1.0.0",
            resolved: "local://skills/code-change",
            hash: "sha256:deadbeef",
          },
        },
      }, null, 2),
      "utf-8",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const resolved = await resolveSkillLock(baseDir, "zigma.code-change");
      expect(typeof resolved).toBe("string");

      // Deprecation warning should have been emitted
      const calls = warnSpy.mock.calls.map((c) => c.join(" "));
      const deprecationLine = calls.find((c) => c.includes("[DEPRECATED]"));
      expect(deprecationLine).toBeDefined();
      expect(deprecationLine!).toContain("skill-lock.json");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resolveSkillLock only emits deprecation warning once per process", async () => {
    const lockfile = join(baseDir, ".zigma-flow", "skill-lock.json");
    await writeFile(
      lockfile,
      JSON.stringify({
        skills: {
          "zigma.code-change": {
            version: "1.0.0",
            resolved: "local://skills/code-change",
            hash: "sha256:deadbeef",
          },
        },
      }, null, 2),
      "utf-8",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      // Call resolveSkillLock twice — deprecation warning should only appear once
      await resolveSkillLock(baseDir, "zigma.code-change");
      await resolveSkillLock(baseDir, "zigma.code-change");

      const deprecationCalls = warnSpy.mock.calls.filter((c) =>
        c.join(" ").includes("[DEPRECATED]"),
      );
      expect(deprecationCalls.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
