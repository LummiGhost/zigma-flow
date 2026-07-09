/**
 * Package metadata and LICENSE validation tests for wf-release Slice A.
 *
 * Reference:
 *   - docs/phases/v0.4-productization/workflows/wf-release/01-cases-and-tests.md
 *   - docs/phases/v0.4-productization/02-development-plan.md M4
 *   - GitHub Issue #97
 *
 * These tests validate package.json fields and the LICENSE file as static
 * artifacts. They do NOT import from src/ or require zigma-flow to be built.
 * Only node stdlib is used.
 *
 * Red phase: T-PKG-NAME, T-PKG-LICENSE, T-PKG-PRIVATE, T-LIC-EXISTS,
 * and T-LIC-CONTENT all fail because the current package.json has:
 *   name: "zigma-flow" (not "@zigma/zigma-flow")
 *   private: true (not publishable)
 *   license: absent
 * and LICENSE file does not exist.
 *
 * T-PKG-VERSION passes because the current version "0.3.6" is valid semver.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const PKG_PATH = join(REPO_ROOT, "package.json");
const LICENSE_PATH = join(REPO_ROOT, "LICENSE");

/** SPDX identifier expected per Issue #97 and frozen development plan. */
const EXPECTED_LICENSE_SPDX = "Apache-2.0";

/** Expected npm package name per Issue #97. */
const EXPECTED_NAME = "@zigma/zigma-flow";

/** semver regex — allows pre-release and build metadata suffixes. */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PackageJson {
  name?: string;
  version?: string;
  license?: string;
  private?: boolean;
}

let pkg: PackageJson;

async function loadPackageJson(): Promise<PackageJson> {
  const raw = await readFile(PKG_PATH, "utf-8");
  return JSON.parse(raw) as PackageJson;
}

// ---------------------------------------------------------------------------
// Tests: package.json metadata
// ---------------------------------------------------------------------------

describe("package.json metadata", () => {
  beforeAll(async () => {
    pkg = await loadPackageJson();
  });

  it("T-PKG-NAME: name equals @zigma/zigma-flow", () => {
    expect(pkg.name).toBe(EXPECTED_NAME);
  });

  it("T-PKG-LICENSE: license field is Apache-2.0", () => {
    expect(pkg.license).toBe(EXPECTED_LICENSE_SPDX);
  });

  it("T-PKG-PRIVATE: private is not true (package must be publishable)", () => {
    // private must be absent, false, or any falsy value — but not true.
    expect(pkg.private).not.toBe(true);
  });

  it("T-PKG-VERSION: version is valid semver", () => {
    expect(pkg.version).toBeDefined();
    expect(pkg.version).toMatch(SEMVER_RE);
  });
});

// ---------------------------------------------------------------------------
// Tests: LICENSE file
// ---------------------------------------------------------------------------

describe("LICENSE file", () => {
  it("T-LIC-EXISTS: LICENSE file exists at repo root", () => {
    expect(existsSync(LICENSE_PATH)).toBe(true);
  });

  it("T-LIC-CONTENT: LICENSE contains Apache 2.0 license text", () => {
    // This test only runs if the file exists. When the file is missing the
    // previous test (T-LIC-EXISTS) already fails, so we skip content
    // validation gracefully to avoid cascading error noise.
    if (!existsSync(LICENSE_PATH)) {
      return;
    }

    const content = readFileSync(LICENSE_PATH, "utf-8");

    // Apache 2.0 license text must include these markers.
    expect(content).toContain("Apache License");
    expect(content).toContain("Version 2.0");

    // The full Apache 2.0 license is ~200+ lines. A stub would be under 20.
    const lineCount = content.split("\n").length;
    expect(lineCount).toBeGreaterThanOrEqual(20);

    // The file size should be at least a few KB (full Apache 2.0 is ~11 KB).
    const byteLength = Buffer.byteLength(content, "utf-8");
    expect(byteLength).toBeGreaterThanOrEqual(2000);
  });
});
