/**
 * skill-add command tests — Issue #142, Problem 2.
 *
 * Verifies that `skillAddAction` correctly:
 *   - Loads and validates the skill pack at the given path.
 *   - Writes or updates .zigma-flow/skill-lock.json with the skill entry.
 *   - Produces the correct resolved URI (local://<relative-path>).
 *   - Preserves existing entries in skill-lock.json.
 *
 * Covers:
 *   - T-SKILL-ADD-1: Creates skill-lock.json when it doesn't exist.
 *   - T-SKILL-ADD-2: Adds to an existing skill-lock.json without clobbering.
 *   - T-SKILL-ADD-3: Updates an existing entry when the same skill is added again.
 *   - T-SKILL-ADD-4: The resolved URI uses the local:// scheme with a correct
 *                    path relative to .zigma-flow/.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { skillAddAction } from "../../src/commands/skill-add.js";

// ---------------------------------------------------------------------------
// Minimal skill pack fixture
// ---------------------------------------------------------------------------

const MINIMAL_SKILL_YAML = `\
id: zigma.test-skill
name: Test Skill Pack
version: 1.2.3
kind: skill-pack
description: Minimal skill pack for testing skill-add command.
`;

const ANOTHER_SKILL_YAML = `\
id: zigma.another-skill
name: Another Skill Pack
version: 2.0.0
kind: skill-pack
description: A second skill pack for testing multi-entry skill-lock.
`;

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

interface Sandbox {
  projectRoot: string;
  dotZigma: string;
  skillsDir: string;
  lockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-skill-add-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const skillsDir = join(dotZigma, "skills");
  const lockPath = join(dotZigma, "skill-lock.json");

  await mkdir(skillsDir, { recursive: true });

  return { projectRoot, dotZigma, skillsDir, lockPath };
}

/**
 * Create a minimal skill pack directory at <skillsDir>/<packName>.
 * No knowledge/prompts/scripts/checks to keep it minimal (no referenced files).
 */
async function createSkillPack(
  skillsDir: string,
  packName: string,
  yamlContent: string,
): Promise<string> {
  const packDir = join(skillsDir, packName);
  await mkdir(packDir, { recursive: true });
  await writeFile(join(packDir, "skill.yml"), yamlContent, "utf-8");
  return packDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skillAddAction — register a local skill pack (Issue #142 Problem 2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "creates skill-lock.json with the registered skill when the file doesn't exist (T-SKILL-ADD-1)",
    async () => {
      const packDir = await createSkillPack(
        sandbox.skillsDir,
        "test-skill",
        MINIMAL_SKILL_YAML,
      );

      await skillAddAction(packDir, { zigmaflowDir: sandbox.projectRoot });

      const raw = await readFile(sandbox.lockPath, "utf-8");
      const lock = JSON.parse(raw) as {
        skills: Record<string, { resolved: string; version: string; hash: string }>;
      };

      expect(lock.skills).toHaveProperty("zigma.test-skill");
      const entry = lock.skills["zigma.test-skill"]!;
      expect(entry.version).toBe("1.2.3");
      expect(entry.resolved).toMatch(/^local:\/\//);
      expect(entry.hash).toContain("zigma.test-skill");
    },
  );

  it(
    "preserves existing entries when adding a new skill (T-SKILL-ADD-2)",
    async () => {
      // Pre-populate skill-lock.json with an existing entry
      const existingLock = {
        skills: {
          "zigma.existing-skill": {
            resolved: "local://skills/existing",
            version: "0.1.0",
            hash: "sha256:local:zigma.existing-skill@0.1.0",
          },
        },
      };
      await writeFile(sandbox.lockPath, JSON.stringify(existingLock, null, 2), "utf-8");

      const packDir = await createSkillPack(
        sandbox.skillsDir,
        "test-skill",
        MINIMAL_SKILL_YAML,
      );

      await skillAddAction(packDir, { zigmaflowDir: sandbox.projectRoot });

      const raw = await readFile(sandbox.lockPath, "utf-8");
      const lock = JSON.parse(raw) as {
        skills: Record<string, { resolved: string; version: string; hash: string }>;
      };

      // Both entries must exist
      expect(lock.skills).toHaveProperty("zigma.existing-skill");
      expect(lock.skills).toHaveProperty("zigma.test-skill");

      // Existing entry must be unchanged
      expect(lock.skills["zigma.existing-skill"]!.version).toBe("0.1.0");

      // New entry must be correct
      expect(lock.skills["zigma.test-skill"]!.version).toBe("1.2.3");
    },
  );

  it(
    "updates an existing entry when the same skill id is registered again (T-SKILL-ADD-3)",
    async () => {
      const packDir = await createSkillPack(
        sandbox.skillsDir,
        "test-skill",
        MINIMAL_SKILL_YAML,
      );

      // Register once
      await skillAddAction(packDir, { zigmaflowDir: sandbox.projectRoot });

      // Register again with a different skill yaml (same id, new version)
      const updatedYaml = MINIMAL_SKILL_YAML.replace("version: 1.2.3", "version: 2.0.0");
      await writeFile(join(packDir, "skill.yml"), updatedYaml, "utf-8");

      await skillAddAction(packDir, { zigmaflowDir: sandbox.projectRoot });

      const raw = await readFile(sandbox.lockPath, "utf-8");
      const lock = JSON.parse(raw) as {
        skills: Record<string, { resolved: string; version: string; hash: string }>;
      };

      // Entry must be updated
      expect(lock.skills["zigma.test-skill"]!.version).toBe("2.0.0");
      // Only one entry for this skill
      expect(Object.keys(lock.skills)).toHaveLength(1);
    },
  );

  it(
    "uses a local:// URI relative to .zigma-flow/ when pack is inside .zigma-flow/ (T-SKILL-ADD-4)",
    async () => {
      const packDir = await createSkillPack(
        sandbox.skillsDir,
        "test-skill",
        MINIMAL_SKILL_YAML,
      );

      await skillAddAction(packDir, { zigmaflowDir: sandbox.projectRoot });

      const raw = await readFile(sandbox.lockPath, "utf-8");
      const lock = JSON.parse(raw) as {
        skills: Record<string, { resolved: string; version: string; hash: string }>;
      };

      const entry = lock.skills["zigma.test-skill"]!;
      // Should be local://skills/test-skill (relative to .zigma-flow/)
      expect(entry.resolved).toBe("local://skills/test-skill");
    },
  );

  it(
    "handles packs outside .zigma-flow/ by using skills/<basename> fallback URI",
    async () => {
      // Pack is at projectRoot/external-skills/test-skill (not inside .zigma-flow/)
      const externalPackDir = join(sandbox.projectRoot, "external-skills", "test-skill");
      await mkdir(externalPackDir, { recursive: true });
      await writeFile(join(externalPackDir, "skill.yml"), MINIMAL_SKILL_YAML, "utf-8");

      await skillAddAction(externalPackDir, { zigmaflowDir: sandbox.projectRoot });

      const raw = await readFile(sandbox.lockPath, "utf-8");
      const lock = JSON.parse(raw) as {
        skills: Record<string, { resolved: string; version: string; hash: string }>;
      };

      const entry = lock.skills["zigma.test-skill"]!;
      // Fallback: local://skills/<basename>
      expect(entry.resolved).toBe("local://skills/test-skill");
    },
  );

  it(
    "emits deprecation warning when used (v0.6, Issue #207)",
    async () => {
      const packDir = await createSkillPack(
        sandbox.skillsDir,
        "test-skill",
        MINIMAL_SKILL_YAML,
      );

      const warnCalls: string[] = [];
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation((...args: unknown[]) => {
          warnCalls.push(args.map(String).join(" "));
        });

      try {
        await skillAddAction(packDir, { zigmaflowDir: sandbox.projectRoot });

        // Deprecation warning should have been emitted
        const deprecationCall = warnCalls.find((c) => c.includes("[DEPRECATED]"));
        expect(deprecationCall).toBeDefined();
        expect(deprecationCall!).toContain("skill add is deprecated");

        // But the command still works — lock file should have been created
        const raw = await readFile(sandbox.lockPath, "utf-8");
        const lock = JSON.parse(raw) as {
          skills: Record<string, { resolved: string; version: string }>;
        };
        expect(lock.skills).toHaveProperty("zigma.test-skill");
      } finally {
        warnSpy.mockRestore();
      }
    },
  );
});
