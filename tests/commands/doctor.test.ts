/**
 * Integration tests for the `doctor` command (WF-DOCTOR Step 1 -- Cases and Tests).
 *
 * Exercises the doctorAction orchestrator, which runs all checks and returns an
 * exit code. Uses temp directories with real file structures to simulate healthy
 * and broken project states.
 *
 * Test scenarios:
 *   - Missing .zigma-flow/ directory (exit 1, suggests init)
 *   - Healthy initialized project (exit 0, all PASS)
 *   - Broken config.json (exit 1)
 *   - Broken skill-lock.json (exit 1)
 *   - Broken workflow YAML (exit 1)
 *   - Broken skill pack manifest (exit 1)
 *   - Check independence (config failure doesn't block workflow check)
 *   - Exit code 1 when any FAIL present
 *   - Exit code 1 on WARN-only scenario
 *
 * Red-phase note: `src/commands/doctor.ts` does not yet exist; tests will fail
 * to compile until WF-DOCTOR Step 2 ships the module.
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

// Red-phase: this export does not yet exist.
import { doctorAction, type DoctorActionOptions } from "../../src/commands/doctor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

function makeCaptured(): CapturedOutput {
  return { stdout: [], stderr: [] };
}

function joinedStdout(captured: CapturedOutput): string {
  return captured.stdout.join("\n");
}

function joinedStderr(captured: CapturedOutput): string {
  return captured.stderr.join("\n");
}

function makeOpts(
  zigmaflowDir: string,
  captured: CapturedOutput,
): DoctorActionOptions {
  return {
    zigmaflowDir,
    stdout: (line: string) => {
      captured.stdout.push(line);
    },
    stderr: (line: string) => {
      captured.stderr.push(line);
    },
  };
}

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
  const dir = join(tmpdir(), `zigma-doctor-int-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const VALID_CONFIG_JSON = {
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
};

const VALID_LOCK_JSON = {
  skills: {
    "zigma.code-change": {
      resolved: "local://skills/code-change",
      version: "1.0.0",
      hash: "abc123def456",
    },
  },
};

const VALID_WORKFLOW_YAML = `name: test-workflow
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

const VALID_SKILL_YML = `id: zigma.code-change
kind: skill-pack
name: zigma.code-change
version: 1.0.0
description: Test skill pack

knowledge: []
prompts: []
scripts: []
checks: []
`;

/**
 * Create a healthy .zigma-flow/ directory structure inside the given temp dir.
 * Returns the path to the .zigma-flow/ directory.
 */
async function createHealthyProject(dir: string): Promise<string> {
  const dotZigma = join(dir, ".zigma-flow");
  await mkdir(dotZigma, { recursive: true });
  await mkdir(join(dotZigma, "workflows"), { recursive: true });
  await mkdir(join(dotZigma, "runs"), { recursive: true });

  // Skill pack directory
  const skillDir = join(dotZigma, "skills", "code-change");
  await mkdir(skillDir, { recursive: true });

  // Write files
  await writeJson(join(dotZigma, "config.json"), VALID_CONFIG_JSON);
  await writeJson(join(dotZigma, "skill-lock.json"), VALID_LOCK_JSON);
  await writeFile(join(dotZigma, "workflows", "test.yml"), VALID_WORKFLOW_YAML, "utf-8");
  await writeFile(join(skillDir, "skill.yml"), VALID_SKILL_YML, "utf-8");

  return dotZigma;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("doctorAction", () => {
  // UC-DOCTOR-2: Missing .zigma-flow/ directory
  describe("missing .zigma-flow/ directory (UC-DOCTOR-2)", () => {
    it("returns exit code 1 when .zigma-flow/ does not exist (T-DOC-INT-1)", async () => {
      const dir = await createTempDir();
      const dotZigma = join(dir, ".zigma-flow");
      // Do NOT create .zigma-flow/

      const captured = makeCaptured();
      const exitCode = await doctorAction(makeOpts(dotZigma, captured));

      expect(exitCode).toBe(1);
    });

    it("missing .zigma-flow message suggests running init (T-DOC-INT-2)", async () => {
      const dir = await createTempDir();
      const dotZigma = join(dir, ".zigma-flow");

      const captured = makeCaptured();
      await doctorAction(makeOpts(dotZigma, captured));

      const stdout = joinedStdout(captured);
      expect(stdout).toMatch(/init/i);
    });
  });

  // UC-DOCTOR-1: Healthy project
  describe("healthy initialized project (UC-DOCTOR-1)", () => {
    it("returns exit code 0 when all checks pass (T-DOC-INT-3)", async () => {
      const dir = await createTempDir();
      const dotZigma = await createHealthyProject(dir);

      const captured = makeCaptured();
      const exitCode = await doctorAction(makeOpts(dotZigma, captured));

      expect(exitCode).toBe(0);

      const stdout = joinedStdout(captured);
      expect(stdout).toMatch(/Summary:/i);
      expect(stdout).toMatch(/0 failed/i);
    });
  });

  // UC-DOCTOR-3: Broken config.json
  describe("broken config.json (UC-DOCTOR-3)", () => {
    it("returns exit 1 with invalid JSON in config.json (T-DOC-INT-4)", async () => {
      const dir = await createTempDir();
      const dotZigma = await createHealthyProject(dir);
      // Corrupt the config.json
      await writeFile(join(dotZigma, "config.json"), "{ invalid json", "utf-8");

      const captured = makeCaptured();
      const exitCode = await doctorAction(makeOpts(dotZigma, captured));

      expect(exitCode).toBe(1);

      const stdout = joinedStdout(captured);
      expect(stdout).toMatch(/FAIL/i);
      // Should include either config or json in the failure message
      expect(stdout.toLowerCase()).toMatch(/config/i);
    });
  });

  // UC-DOCTOR-4: Broken skill-lock.json
  describe("broken skill-lock.json (UC-DOCTOR-4)", () => {
    it("returns exit 1 with broken skill-lock.json (T-DOC-INT-5)", async () => {
      const dir = await createTempDir();
      const dotZigma = await createHealthyProject(dir);
      // Corrupt the skill-lock.json
      await writeFile(join(dotZigma, "skill-lock.json"), "{ bad json @@@", "utf-8");

      const captured = makeCaptured();
      const exitCode = await doctorAction(makeOpts(dotZigma, captured));

      expect(exitCode).toBe(1);

      const stdout = joinedStdout(captured);
      expect(stdout).toMatch(/FAIL/i);
    });
  });

  // UC-DOCTOR-5: Broken workflow YAML
  describe("broken workflow YAML (UC-DOCTOR-5)", () => {
    it("returns exit 1 with broken workflow YAML (T-DOC-INT-6)", async () => {
      const dir = await createTempDir();
      const dotZigma = await createHealthyProject(dir);
      // Corrupt the workflow YAML
      await writeFile(
        join(dotZigma, "workflows", "test.yml"),
        "::: totally ::: invalid ::: yaml :::",
        "utf-8"
      );

      const captured = makeCaptured();
      const exitCode = await doctorAction(makeOpts(dotZigma, captured));

      expect(exitCode).toBe(1);

      const stdout = joinedStdout(captured);
      expect(stdout).toMatch(/FAIL/i);
    });
  });

  // UC-DOCTOR-6: Broken skill pack manifest
  describe("broken skill pack manifest (UC-DOCTOR-6)", () => {
    it("returns exit 1 with broken skill pack YAML (T-DOC-INT-7)", async () => {
      const dir = await createTempDir();
      const dotZigma = await createHealthyProject(dir);
      // Corrupt the skill.yml
      await writeFile(
        join(dotZigma, "skills", "code-change", "skill.yml"),
        "::bad yaml::",
        "utf-8"
      );

      const captured = makeCaptured();
      const exitCode = await doctorAction(makeOpts(dotZigma, captured));

      expect(exitCode).toBe(1);

      const stdout = joinedStdout(captured);
      expect(stdout).toMatch(/FAIL/i);
    });
  });

  // UC-DOCTOR-8: Check independence
  describe("check independence (UC-DOCTOR-8)", () => {
    it("reports multiple failing checks when multiple files are broken (T-DOC-INT-8)", async () => {
      const dir = await createTempDir();
      const dotZigma = await createHealthyProject(dir);
      // Break both config.json and skill-lock.json
      await writeFile(join(dotZigma, "config.json"), "{ bad config", "utf-8");
      await writeFile(join(dotZigma, "skill-lock.json"), "{ bad lock", "utf-8");

      const captured = makeCaptured();
      const exitCode = await doctorAction(makeOpts(dotZigma, captured));

      expect(exitCode).toBe(1);

      const stdout = joinedStdout(captured);
      // There should be at least 2 FAIL results
      const failCount = (stdout.match(/\[FAIL\]/g) ?? []).length;
      expect(failCount).toBeGreaterThanOrEqual(2);
    });
  });

  // UC-DOCTOR-9: Exit code reflects health
  describe("exit code reflects health (UC-DOCTOR-9)", () => {
    it("exit code 0 means all checks passed (T-DOC-INT-9)", async () => {
      const dir = await createTempDir();
      const dotZigma = await createHealthyProject(dir);

      const captured = makeCaptured();
      const exitCode = await doctorAction(makeOpts(dotZigma, captured));

      expect(exitCode).toBe(0);

      const stdout = joinedStdout(captured);
      // No FAIL or WARN should appear in healthy project output
      expect(stdout).not.toMatch(/\[FAIL\]/i);
      // WARN may appear for edge cases (empty runs dir, etc.) but in
      // a truly healthy project there should be no warnings either.
      // If the implementation chooses to warn on empty runs dir, that's
      // acceptable -- we only assert no FAILs.
    });

    it("exit code 1 when WARN-only scenario -- empty workflows dir (T-DOC-INT-10)", async () => {
      const dir = await createTempDir();
      const dotZigma = await createHealthyProject(dir);
      // Remove the workflow file to trigger a WARN on empty workflows dir
      await rm(join(dotZigma, "workflows", "test.yml"), { force: true });

      const captured = makeCaptured();
      const exitCode = await doctorAction(makeOpts(dotZigma, captured));

      // WARN-only should still produce exit code 1 (not fully clean)
      expect(exitCode).toBe(1);

      const stdout = joinedStdout(captured);
      expect(stdout).toMatch(/\[WARN\]/i);
    });
  });
});
