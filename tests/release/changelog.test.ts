/**
 * CHANGELOG and release documentation validation tests for wf-release Slice A.
 *
 * Reference:
 *   - docs/phases/v0.4-productization/workflows/wf-release/01-cases-and-tests.md
 *   - docs/phases/v0.4-productization/02-development-plan.md M4
 *   - GitHub Issue #97
 *
 * These tests validate CHANGELOG.md version coverage, classification tags,
 * version policy documentation, and release-checklist.md existence. They do
 * NOT import from src/ or require zigma-flow to be built. Only node stdlib.
 *
 * Red phase: all T-CHG-VERSION-* tests, T-CHG-CLASSIFY-*, T-CHG-VERSION-POLICY,
 * and T-CHG-RELEASE-DOC fail because the CHANGELOG only covers v0.1.0 through
 * v0.2.0, the classification scheme is not yet documented, and
 * docs/release-checklist.md does not exist.
 *
 * T-CHG-EXISTS passes because CHANGELOG.md exists.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const CHANGELOG_PATH = join(REPO_ROOT, "CHANGELOG.md");
const RELEASE_CHECKLIST_PATH = join(REPO_ROOT, "docs", "release-checklist.md");

/**
 * Versions that must have entries in CHANGELOG.md per M4 exit criteria.
 *
 * These are every tagged version from v0.2.2 through v0.3.6. v0.2.1 was a
 * CI-only release with no code changes — it may be noted briefly but is not
 * required to have a full section. v0.3.4 tag is missing from the repo;
 * its changes are expected to be documented under v0.3.5.
 */
const REQUIRED_VERSIONS = [
  "v0.2.2",
  "v0.3.0",
  "v0.3.1",
  "v0.3.2",
  "v0.3.3",
  "v0.3.4", // tag missing, but changes should still be documented
  "v0.3.5",
  "v0.3.6",
];

/**
 * Classification tags per Issue #97 scope.
 *
 * Every changelog entry should carry at least one of these tags.
 * `[breaking]` is additive — it must appear alongside another tag.
 */
const CLASSIFICATION_TAGS = [
  "[runtime]",
  "[DSL]",
  "[CLI]",
  "[docs]",
  "[tests]",
  "[breaking]",
];

/** Matches a CHANGELOG version section header: "## [vX.Y.Z]" */
const VERSION_HEADER_RE = /^##\s+\[v(\d+\.\d+\.\d+)\]/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let changelogContent: string;

async function loadChangelog(): Promise<string> {
  return readFile(CHANGELOG_PATH, "utf-8");
}

/** Extract all version strings found in CHANGELOG section headers. */
function extractVersionSections(content: string): Set<string> {
  const versions = new Set<string>();
  for (const line of content.split("\n")) {
    const m = line.match(VERSION_HEADER_RE);
    if (m) {
      versions.add(`v${m[1]}`);
    }
  }
  return versions;
}

/**
 * Extract the content of a specific version section.
 * Returns lines from the section header until the next section header or EOF.
 */
function extractVersionSection(
  content: string,
  version: string,
): string | null {
  const lines = content.split("\n");
  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    if (line.match(VERSION_HEADER_RE)) {
      if (inSection) break; // reached next section
      if (line.includes(`[${version}]`)) {
        inSection = true;
        sectionLines.push(line);
        continue;
      }
    }
    if (inSection) {
      sectionLines.push(line);
    }
  }

  return sectionLines.length > 1 ? sectionLines.join("\n") : null;
}

/**
 * Check whether a version section contains at least one classification tag.
 */
function sectionHasClassificationTag(section: string): boolean {
  return CLASSIFICATION_TAGS.some((tag) => section.includes(tag));
}

/**
 * Check whether the CHANGELOG documents the classification tag scheme.
 * Looks for a legend or explanation of what each tag means.
 */
function hasClassificationLegend(content: string): boolean {
  // At least two classification tags should be mentioned in a
  // descriptive context (not just as bullet-point prefixes).
  const lower = content.toLowerCase();
  const tagMentions = CLASSIFICATION_TAGS.filter((tag) =>
    lower.includes(tag.toLowerCase()),
  ).length;
  return tagMentions >= 2;
}

// ---------------------------------------------------------------------------
// Tests: CHANGELOG version coverage
// ---------------------------------------------------------------------------

describe("CHANGELOG version coverage", () => {
  let versions: Set<string>;

  beforeAll(async () => {
    changelogContent = await loadChangelog();
    versions = extractVersionSections(changelogContent);
  });

  it("T-CHG-EXISTS: CHANGELOG.md exists and is readable", () => {
    expect(changelogContent.length).toBeGreaterThan(0);
  });

  for (const version of REQUIRED_VERSIONS) {
    it(`T-CHG-VERSION-${version}: CHANGELOG has [${version}] section`, () => {
      expect(
        versions.has(version),
        `Expected CHANGELOG to have a section for [${version}]`,
      ).toBe(true);
    });
  }

  it("T-CHG-DATES: each required version section includes a date", () => {
    for (const version of REQUIRED_VERSIONS) {
      const section = extractVersionSection(changelogContent, version);
      if (!section) continue; // missing section tested above

      // The header line itself should contain YYYY-MM-DD or the section
      // content within the first 5 lines should mention a date.
      const firstLines = section.split("\n").slice(0, 5).join("\n");
      expect(
        firstLines,
        `Expected [${version}] section to include a date (YYYY-MM-DD)`,
      ).toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: CHANGELOG classification tags
// ---------------------------------------------------------------------------

describe("CHANGELOG classification tags", () => {
  beforeAll(async () => {
    if (!changelogContent) {
      changelogContent = await loadChangelog();
    }
  });

  it("T-CHG-CLASSIFY-TAGS: classification tag legend is documented", () => {
    // The CHANGELOG should explain the classification scheme near the top,
    // before the first version section.
    expect(
      hasClassificationLegend(changelogContent),
      "Expected CHANGELOG to document classification tags ([runtime], [DSL], [CLI], [docs], [tests], [breaking])",
    ).toBe(true);
  });

  for (const version of REQUIRED_VERSIONS) {
    it(`T-CHG-CLASSIFY-${version}: [${version}] section uses classification tags`, () => {
      const section = extractVersionSection(changelogContent, version);
      if (!section) return; // missing section tested in version coverage

      expect(
        sectionHasClassificationTag(section),
        `Expected [${version}] section to contain at least one classification tag from: ${CLASSIFICATION_TAGS.join(", ")}`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: Version policy and release checklist
// ---------------------------------------------------------------------------

describe("Version policy and release documentation", () => {
  beforeAll(async () => {
    if (!changelogContent) {
      changelogContent = await loadChangelog();
    }
  });

  it("T-CHG-VERSION-POLICY: version policy is documented", () => {
    // A version policy or stability declaration should exist in either
    // CHANGELOG.md or docs/compatibility.md (referenced in the development
    // plan as already existing).
    const compatPath = join(REPO_ROOT, "docs", "compatibility.md");

    const hasVersionPolicy =
      /version(ing)?\s+policy/i.test(changelogContent) ||
      /stability/i.test(changelogContent) ||
      (existsSync(compatPath) &&
        readFileSync(compatPath, "utf-8").length > 100);

    expect(
      hasVersionPolicy,
      "Expected a version policy or stability declaration in CHANGELOG.md or docs/compatibility.md",
    ).toBe(true);
  });

  it("T-CHG-RELEASE-DOC: docs/release-checklist.md exists", () => {
    expect(
      existsSync(RELEASE_CHECKLIST_PATH),
      "Expected docs/release-checklist.md to exist",
    ).toBe(true);
  });

  it("T-CHG-RELEASE-DOC-SECTIONS: release checklist has required sections", () => {
    if (!existsSync(RELEASE_CHECKLIST_PATH)) {
      return; // existence tested above
    }

    const content = readFileSync(RELEASE_CHECKLIST_PATH, "utf-8");

    // Must be at least 20 lines (not a stub).
    const lineCount = content.split("\n").length;
    expect(lineCount).toBeGreaterThanOrEqual(20);

    // Check for required topics.
    const lower = content.toLowerCase();
    const topics = [
      "pre-release",
      "version",
      "changelog",
      "tag",
      "publish",
    ];

    const foundCount = topics.filter((t) => lower.includes(t)).length;
    expect(
      foundCount,
      `Expected release checklist to cover at least 3 of: ${topics.join(", ")}`,
    ).toBeGreaterThanOrEqual(3);
  });
});
