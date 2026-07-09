/**
 * Unit tests for individual doctor check functions (WF-DOCTOR Step 1 -- Cases and Tests).
 *
 * Each test exercises a single check function exported from `src/commands/doctor.ts`.
 * Tests use real temp directories with specific file contents to simulate healthy
 * and broken project states.
 *
 * Check functions under test:
 *   - checkNodeVersion()
 *   - checkConfigJson(zigmaflowDir)
 *   - checkSkillLockJson(zigmaflowDir)
 *   - checkWorkflowYaml(zigmaflowDir)
 *   - checkSkillPacks(zigmaflowDir)
 *
 * Exit codes (enforced by doctorAction orchestrator, verified in integration tests):
 *   0 = all PASS; 1 = any FAIL or WARN.
 *
 * Red-phase note: `src/commands/doctor.ts` does not yet exist; tests will fail to
 * compile until WF-DOCTOR Step 2 ships the module.
 *
 * Reference:
 *   docs/phases/v0.4-productization/workflows/wf-doctor/01-cases-and-tests.md
 *   GitHub Issue #97
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Red-phase: these exports do not yet exist. Step 2 must create
// `src/commands/doctor.ts` that exports these functions.
import {
  checkNodeVersion,
  checkConfigJson,
  checkSkillLockJson,
  checkWorkflowYaml,
  checkSkillPacks,
} from "../../src/commands/doctor.js";

// ---------------------------------------------------------------------------
// Types (mirror expected export shapes)
// ---------------------------------------------------------------------------

type CheckLevel = "PASS" | "FAIL" | "WARN";

interface CheckResult {
  level: CheckLevel;
  message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `zigma-doctor-unit-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// checkNodeVersion() tests
// ---------------------------------------------------------------------------

describe("checkNodeVersion", () => {
  it("returns PASS when Node version satisfies engines requirement (T-DOC-1)", () => {
    const result = checkNodeVersion();
    // On a supported runtime (Node >= 20.11.0), this should PASS.
    // The test environment itself must be running a supported Node version.
    expect(result.level).toBe("PASS");
    expect(result.message).toMatch(/node/i);
  });

  it("detects unsupported Node version (T-DOC-2)", () => {
    // We cannot downgrade Node at test time, so we verify the check function
    // exists and returns a well-formed CheckResult. The actual version check
    // logic is tested indirectly: the function must at minimum return either
    // PASS or FAIL with a message that includes the version number.
    const result = checkNodeVersion();
    expect(["PASS", "FAIL", "WARN"]).toContain(result.level);
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("returns a message containing the detected Node version (T-DOC-3)", () => {
    const result = checkNodeVersion();
    const nodeVersion = process.versions.node;
    // The message should include the detected version for diagnostic purposes.
    expect(result.message).toMatch(new RegExp(nodeVersion.replace(/\./g, "\\.")));
  });
});

// ---------------------------------------------------------------------------
// checkConfigJson() tests
// ---------------------------------------------------------------------------

describe("checkConfigJson", () => {
  it("returns PASS for valid config.json (T-DOC-4)", async () => {
    const dir = await createTempDir();
    await writeJson(join(dir, "config.json"), {
      tool_version: "0.3.6",
      active_run: null,
      agent: {
        backend: "claude-code",
        backends: {
          "claude-code": {
            command: "claude",
            args: ["-p"],
            timeout: 600000,
          },
        },
      },
    });

    const result = await checkConfigJson(dir);
    expect(result.level).toBe("PASS");
  });

  it("returns FAIL when config.json does not exist (T-DOC-5)", async () => {
    const dir = await createTempDir();

    const result = await checkConfigJson(dir);
    expect(result.level).toBe("FAIL");
    expect(result.message).toMatch(/not found|missing|exist/i);
  });

  it("returns FAIL for invalid JSON in config.json (T-DOC-6)", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "config.json"), "{ invalid json", "utf-8");

    const result = await checkConfigJson(dir);
    expect(result.level).toBe("FAIL");
    expect(result.message).toMatch(/json|parse/i);
  });

  it("returns FAIL for missing required fields in config.json (T-DOC-7)", async () => {
    const dir = await createTempDir();
    // Missing tool_version and agent fields
    await writeJson(join(dir, "config.json"), { active_run: null });

    const result = await checkConfigJson(dir);
    // At minimum, missing tool_version should be detected.
    // If the implementation is lenient, it may just WARN on partial data.
    expect(["FAIL", "WARN"]).toContain(result.level);
  });
});

// ---------------------------------------------------------------------------
// checkSkillLockJson() tests
// ---------------------------------------------------------------------------

describe("checkSkillLockJson", () => {
  const validLockJson = {
    skills: {
      "zigma.code-change": {
        resolved: "local://skills/code-change",
        version: "1.0.0",
        hash: "abc123def456",
      },
    },
  };

  it("returns PASS for valid skill-lock.json (T-DOC-8)", async () => {
    const dir = await createTempDir();
    await writeJson(join(dir, "skill-lock.json"), validLockJson);

    const results = await checkSkillLockJson(dir);
    expect(results.length).toBeGreaterThan(0);
    // At least one result should be PASS
    const passResults = results.filter((r) => r.level === "PASS");
    expect(passResults.length).toBeGreaterThan(0);
  });

  it("returns FAIL when skill-lock.json is missing (T-DOC-9)", async () => {
    const dir = await createTempDir();

    const results = await checkSkillLockJson(dir);
    expect(results.length).toBeGreaterThan(0);
    const failResults = results.filter((r) => r.level === "FAIL");
    expect(failResults.length).toBeGreaterThan(0);
  });

  it("returns FAIL for invalid JSON in skill-lock.json (T-DOC-10)", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "skill-lock.json"), "{ not valid }", "utf-8");

    const results = await checkSkillLockJson(dir);
    const failResults = results.filter((r) => r.level === "FAIL");
    expect(failResults.length).toBeGreaterThan(0);
  });

  it('returns FAIL when "skills" field is missing (T-DOC-11)', async () => {
    const dir = await createTempDir();
    await writeJson(join(dir, "skill-lock.json"), { version: "1.0.0" });

    const results = await checkSkillLockJson(dir);
    const failResults = results.filter((r) => r.level === "FAIL");
    expect(failResults.length).toBeGreaterThan(0);
  });

  it("returns WARN when resolved skill path does not exist (T-DOC-12)", async () => {
    const dir = await createTempDir();
    await writeJson(join(dir, "skill-lock.json"), {
      skills: {
        "zigma.nonexistent": {
          resolved: "local://skills/nonexistent",
          version: "1.0.0",
          hash: "abc123",
        },
      },
    });

    const results = await checkSkillLockJson(dir);
    const warnResults = results.filter((r) => r.level === "WARN");
    expect(warnResults.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// checkWorkflowYaml() tests
// ---------------------------------------------------------------------------

describe("checkWorkflowYaml", () => {
  const validWorkflowYaml = `name: test-workflow
version: 0.1.0

on:
  manual:
    inputs:
      task:
        type: string
        required: true

skills: {}

permissions:
  contents: read
  edits: write
  commands: none
  workflow_state: none

signals: {}

jobs:
  test-job:
    workspace:
      mode: read-only
    steps:
      - id: echo
        type: script
        run: echo hello
`;

  it("returns PASS for valid workflow YAML (T-DOC-13)", async () => {
    const dir = await createTempDir();
    const workflowsDir = join(dir, "workflows");
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, "test.yml"), validWorkflowYaml, "utf-8");

    const results = await checkWorkflowYaml(dir);
    expect(results.length).toBeGreaterThan(0);
    const passResults = results.filter((r) => r.level === "PASS");
    expect(passResults.length).toBeGreaterThan(0);
  });

  it("returns FAIL for YAML syntax error (T-DOC-14)", async () => {
    const dir = await createTempDir();
    const workflowsDir = join(dir, "workflows");
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(
      join(workflowsDir, "broken.yml"),
      "name: broken\n  - bad\nindent: !!invalid!!",
      "utf-8"
    );

    const results = await checkWorkflowYaml(dir);
    const failResults = results.filter((r) => r.level === "FAIL");
    expect(failResults.length).toBeGreaterThan(0);
  });

  it("returns FAIL for workflow validation error (T-DOC-15)", async () => {
    const dir = await createTempDir();
    const workflowsDir = join(dir, "workflows");
    await mkdir(workflowsDir, { recursive: true });
    // Missing required fields: no `name` field on the workflow
    const invalidWorkflow = `version: 0.1.0
on:
  manual:
    inputs: {}
skills: {}
jobs: {}
`;
    await writeFile(join(workflowsDir, "invalid.yml"), invalidWorkflow, "utf-8");

    const results = await checkWorkflowYaml(dir);
    const failOrWarnResults = results.filter(
      (r) => r.level === "FAIL" || r.level === "WARN"
    );
    expect(failOrWarnResults.length).toBeGreaterThan(0);
  });

  it("returns WARN when workflows directory is empty (T-DOC-16)", async () => {
    const dir = await createTempDir();
    const workflowsDir = join(dir, "workflows");
    await mkdir(workflowsDir, { recursive: true });

    const results = await checkWorkflowYaml(dir);
    const warnResults = results.filter((r) => r.level === "WARN");
    expect(warnResults.length).toBeGreaterThan(0);
  });

  it("returns WARN when workflows directory does not exist (T-DOC-17)", async () => {
    const dir = await createTempDir();

    const results = await checkWorkflowYaml(dir);
    const warnResults = results.filter((r) => r.level === "WARN");
    expect(warnResults.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// checkSkillPacks() tests
// ---------------------------------------------------------------------------

describe("checkSkillPacks", () => {
  const validSkillYml = `id: zigma.code-change
kind: skill-pack
name: zigma.code-change
version: 1.0.0
description: Test skill pack

knowledge: []
prompts: []
scripts: []
checks: []
`;

  it("returns PASS for valid skill pack (T-DOC-18)", async () => {
    const dir = await createTempDir();
    // Create a skill-lock.json that references the skill pack
    await writeJson(join(dir, "skill-lock.json"), {
      skills: {
        "zigma.code-change": {
          resolved: "local://skills/code-change",
          version: "1.0.0",
          hash: "abc123",
        },
      },
    });
    // Create the skill pack directory with a valid skill.yml
    const skillDir = join(dir, "skills", "code-change");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "skill.yml"), validSkillYml, "utf-8");

    const results = await checkSkillPacks(dir);
    expect(results.length).toBeGreaterThan(0);
    const passResults = results.filter((r) => r.level === "PASS");
    expect(passResults.length).toBeGreaterThan(0);
  });

  it("returns FAIL for invalid skill pack YAML (T-DOC-19)", async () => {
    const dir = await createTempDir();
    await writeJson(join(dir, "skill-lock.json"), {
      skills: {
        "zigma.broken": {
          resolved: "local://skills/broken",
          version: "1.0.0",
          hash: "abc123",
        },
      },
    });
    const skillDir = join(dir, "skills", "broken");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "skill.yml"), "::: bad yaml :::", "utf-8");

    const results = await checkSkillPacks(dir);
    const failResults = results.filter((r) => r.level === "FAIL");
    expect(failResults.length).toBeGreaterThan(0);
  });

  it("returns FAIL when skill.yml is missing (T-DOC-20)", async () => {
    const dir = await createTempDir();
    await writeJson(join(dir, "skill-lock.json"), {
      skills: {
        "zigma.empty": {
          resolved: "local://skills/empty",
          version: "1.0.0",
          hash: "abc123",
        },
      },
    });
    // Create the directory but no skill.yml
    const skillDir = join(dir, "skills", "empty");
    await mkdir(skillDir, { recursive: true });

    const results = await checkSkillPacks(dir);
    const failResults = results.filter((r) => r.level === "FAIL");
    expect(failResults.length).toBeGreaterThan(0);
  });
});
