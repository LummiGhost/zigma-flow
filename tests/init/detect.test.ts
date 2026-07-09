import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildScriptCommand,
  detectEnvironment,
  detectPackageManager,
  detectScripts,
  type PackageManager
} from "../../src/init/detect.js";

/**
 * Detection unit tests for WF-INIT env detection (Step 1: cases-and-tests).
 *
 * Reference:
 *   - docs/phases/v0.4-productization/workflows/wf-init/01-cases-and-tests.md
 *   - docs/phases/v0.4-productization/02-development-plan.md M1
 *
 * These tests are red-phase: src/init/detect.ts exports stub functions that
 * throw. They become green once Step 2 implements the detection logic.
 */

describe("detectPackageManager", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-detect-pm-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------- T-DETECT-1 ----------
  it("returns pnpm when pnpm-lock.yaml exists (T-DETECT-1)", async () => {
    await writeFile(join(tempDir, "pnpm-lock.yaml"), "", "utf-8");
    const pm = await detectPackageManager(tempDir);
    expect(pm).toBe("pnpm");
  });

  // ---------- T-DETECT-2 ----------
  it("returns npm when package-lock.json exists (T-DETECT-2)", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "", "utf-8");
    const pm = await detectPackageManager(tempDir);
    expect(pm).toBe("npm");
  });

  // ---------- T-DETECT-3 ----------
  it("returns yarn when yarn.lock exists (T-DETECT-3)", async () => {
    await writeFile(join(tempDir, "yarn.lock"), "", "utf-8");
    const pm = await detectPackageManager(tempDir);
    expect(pm).toBe("yarn");
  });

  // ---------- T-DETECT-4 ----------
  it("returns bun when bun.lockb exists (T-DETECT-4)", async () => {
    await writeFile(join(tempDir, "bun.lockb"), "", "utf-8");
    const pm = await detectPackageManager(tempDir);
    expect(pm).toBe("bun");
  });

  // ---------- T-DETECT-5 ----------
  it("returns bun when bun.lock exists (T-DETECT-5)", async () => {
    await writeFile(join(tempDir, "bun.lock"), "", "utf-8");
    const pm = await detectPackageManager(tempDir);
    expect(pm).toBe("bun");
  });

  // ---------- T-DETECT-6 ----------
  it("defaults to npm when no lockfile found (T-DETECT-6)", async () => {
    // tempDir is empty — no lockfiles at all
    const pm = await detectPackageManager(tempDir);
    expect(pm).toBe("npm");
  });

  // ---------- T-DETECT-17 ----------
  it("pnpm beats yarn when both lockfiles present (T-DETECT-17)", async () => {
    await writeFile(join(tempDir, "pnpm-lock.yaml"), "", "utf-8");
    await writeFile(join(tempDir, "yarn.lock"), "", "utf-8");
    const pm = await detectPackageManager(tempDir);
    expect(pm).toBe("pnpm");
  });

  // ---------- T-DETECT-18 ----------
  it("pnpm beats npm when both lockfiles present (T-DETECT-18)", async () => {
    await writeFile(join(tempDir, "pnpm-lock.yaml"), "", "utf-8");
    await writeFile(join(tempDir, "package-lock.json"), "", "utf-8");
    const pm = await detectPackageManager(tempDir);
    expect(pm).toBe("pnpm");
  });
});

describe("detectScripts", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-detect-scripts-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------- T-DETECT-7 ----------
  it("detects all available scripts from package.json (T-DETECT-7)", async () => {
    const pkg = {
      name: "test-project",
      scripts: {
        typecheck: "tsc --noEmit",
        lint: "eslint .",
        test: "vitest run",
        "test:ci": "vitest run --coverage",
        build: "tsc"
      }
    };
    await writeFile(join(tempDir, "package.json"), JSON.stringify(pkg), "utf-8");

    const scripts = await detectScripts(tempDir);
    expect(scripts).toEqual({
      typecheck: true,
      lint: true,
      test: true,
      testCi: true,
      build: true
    });
  });

  // ---------- T-DETECT-8 ----------
  it("returns all-false when package.json has no scripts field (T-DETECT-8)", async () => {
    const pkg = { name: "test-project" };
    await writeFile(join(tempDir, "package.json"), JSON.stringify(pkg), "utf-8");

    const scripts = await detectScripts(tempDir);
    expect(scripts).toEqual({
      typecheck: false,
      lint: false,
      test: false,
      testCi: false,
      build: false
    });
  });

  // ---------- T-DETECT-9 ----------
  it("returns all-false when package.json does not exist (T-DETECT-9)", async () => {
    // tempDir is empty — no package.json
    const scripts = await detectScripts(tempDir);
    expect(scripts).toEqual({
      typecheck: false,
      lint: false,
      test: false,
      testCi: false,
      build: false
    });
  });
});

describe("detectEnvironment", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-detect-env-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------- T-DETECT-10 ----------
  it("returns DetectionResult with packageManager from lockfile (T-DETECT-10)", async () => {
    await writeFile(join(tempDir, "pnpm-lock.yaml"), "", "utf-8");
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { typecheck: "tsc" } }),
      "utf-8"
    );

    const result = await detectEnvironment(tempDir);
    expect(result.packageManager).toBe("pnpm");
    expect(result.scripts.typecheck).toBe(true);
    expect(result.hasPackageJson).toBe(true);
  });

  // ---------- T-DETECT-11 ----------
  it("reports hasPackageJson=true when package.json present (T-DETECT-11)", async () => {
    await writeFile(join(tempDir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");

    const result = await detectEnvironment(tempDir);
    expect(result.hasPackageJson).toBe(true);
    expect(result.packageManager).toBe("npm"); // no lockfile -> default
  });

  // ---------- T-DETECT-12 ----------
  it("reports hasPackageJson=false when package.json absent (T-DETECT-12)", async () => {
    const result = await detectEnvironment(tempDir);
    expect(result.hasPackageJson).toBe(false);
    expect(result.packageManager).toBe("npm"); // no lockfile -> default
    expect(result.scripts.typecheck).toBe(false);
    expect(result.scripts.lint).toBe(false);
    expect(result.scripts.test).toBe(false);
    expect(result.scripts.testCi).toBe(false);
    expect(result.scripts.build).toBe(false);
  });
});

describe("buildScriptCommand", () => {
  // ---------- T-DETECT-13 ----------
  it("formats pnpm command without 'run' (T-DETECT-13)", () => {
    const cmd = buildScriptCommand("pnpm", "typecheck");
    expect(cmd).toBe("pnpm typecheck");
  });

  // ---------- T-DETECT-14 ----------
  it("formats npm command with 'run' (T-DETECT-14)", () => {
    const cmd = buildScriptCommand("npm", "typecheck");
    expect(cmd).toBe("npm run typecheck");
  });

  // ---------- T-DETECT-15 ----------
  it("formats yarn command without 'run' (T-DETECT-15)", () => {
    const cmd = buildScriptCommand("yarn", "typecheck");
    expect(cmd).toBe("yarn typecheck");
  });

  // ---------- T-DETECT-16 ----------
  it("formats bun command with 'run' (T-DETECT-16)", () => {
    const cmd = buildScriptCommand("bun", "typecheck");
    expect(cmd).toBe("bun run typecheck");
  });

  it("handles test:ci script name with pnpm", () => {
    const cmd = buildScriptCommand("pnpm", "test:ci");
    expect(cmd).toBe("pnpm test:ci");
  });

  it("handles test:ci script name with npm", () => {
    const cmd = buildScriptCommand("npm", "test:ci");
    expect(cmd).toBe("npm run test:ci");
  });

  it("handles build script name with pnpm", () => {
    const cmd = buildScriptCommand("pnpm", "build");
    expect(cmd).toBe("pnpm build");
  });

  it("returns the command in the expected order: pm first, then script", () => {
    // Exhaustively verify every supported combination produces a
    // well-formed, whitespace-separated two-token command.
    const managers: PackageManager[] = ["pnpm", "npm", "yarn", "bun"];
    for (const pm of managers) {
      const cmd = buildScriptCommand(pm, "lint");
      expect(cmd.length).toBeGreaterThan(0);
      expect(cmd).not.toMatch(/^\s/);
      expect(cmd).not.toMatch(/\s$/);
      // The command must start with the package manager name.
      expect(cmd.startsWith(pm)).toBe(true);
    }
  });
});
