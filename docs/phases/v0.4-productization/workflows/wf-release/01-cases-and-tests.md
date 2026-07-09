# wf-release: Cases and Tests

**Phase:** v0.4 Productization
**Workflow:** wf-release -- Release strategy (Step 1: cases-and-tests)
**Status:** Red phase (tests written; implementation pending in Step 2)

## 0. Slice Boundary

- **Slice name:** wf-release-slice-a (package metadata, CHANGELOG catch-up, release documentation)
- **Single bounded context:** The set of files that define Zigma Flow as a publishable npm package and documentable project. This includes `package.json` metadata (name, license, private flag, version), `LICENSE` file, `CHANGELOG.md` entries for published versions, and `docs/release-checklist.md` as the documented release process. Does NOT cover npm registry publishing, CI release workflows, or npm org setup (those are out of scope for this phase per the development plan).
- **User tasks (max 3):**
  1. User can inspect `package.json` and confirm that Zigma Flow is a properly-licensed, publishable package with the scoped name `@zigma/zigma-flow` under Apache 2.0, not marked private, and carrying a valid semver version.
  2. User can read `CHANGELOG.md` and find every published version from v0.2.2 through v0.3.6 documented with entries classified by change type (runtime, DSL, CLI, docs, tests, breaking).
  3. User can consult `docs/release-checklist.md` and follow a step-by-step release process to publish a new version of Zigma Flow, including pre-release verification, version bump, changelog update, tag creation, and post-release validation.
- **Planned test files (max 2):**
  1. `tests/release/package.test.ts` -- package.json metadata validation (name, license, private, semver version) and LICENSE file existence/content verification
  2. `tests/release/changelog.test.ts` -- CHANGELOG.md version coverage (v0.2.2 through v0.3.6), classification tag validation, and release-checklist.md existence

## 1. Functional Points and Use Cases

### UC-PKG-1: package.json has publishable metadata

**Priority:** P0
**Description:** The `package.json` at the repo root is configured for publishing to the npm registry as a scoped public package under the Apache 2.0 license.

**Acceptance criteria:**
- AC-PKG-1a: `name` field equals `"@zigma/zigma-flow"` (scoped under @zigma).
- AC-PKG-1b: `license` field exists and equals `"Apache-2.0"` (SPDX identifier).
- AC-PKG-1c: `private` field is either absent, `false`, or any falsy value (not `true`).
- AC-PKG-1d: `version` field is a valid semver string (matches `^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$`).

### UC-LIC-1: LICENSE file exists with Apache 2.0 text

**Priority:** P0
**Description:** The repository root contains a `LICENSE` file with the full Apache License 2.0 text.

**Acceptance criteria:**
- AC-LIC-1a: `LICENSE` file exists at the repo root.
- AC-LIC-1b: The file contains the string `"Apache License"` and `"Version 2.0"`.
- AC-LIC-1c: The file contains the standard Apache 2.0 copyright notice boilerplate and the full license terms (minimum 200 lines or 10 KB to distinguish from a stub).

### UC-CHG-1: CHANGELOG covers all published versions from v0.2.2 through v0.3.6

**Priority:** P0
**Description:** `CHANGELOG.md` contains entries for every version tag from v0.2.2 to v0.3.6. Each version section is marked with the version number and date.

**Acceptance criteria:**
- AC-CHG-1a: CHANGELOG has a `## [v0.2.2]` section header.
- AC-CHG-1b: CHANGELOG has a `## [v0.3.0]` section header.
- AC-CHG-1c: CHANGELOG has a `## [v0.3.1]` section header.
- AC-CHG-1d: CHANGELOG has a `## [v0.3.2]` section header.
- AC-CHG-1e: CHANGELOG has a `## [v0.3.3]` section header.
- AC-CHG-1f: CHANGELOG has a `## [v0.3.4]` section header.
- AC-CHG-1g: CHANGELOG has a `## [v0.3.5]` section header.
- AC-CHG-1h: CHANGELOG has a `## [v0.3.6]` section header.
- AC-CHG-1i: Each version section includes a date in ISO format (`YYYY-MM-DD`).

### UC-CHG-2: CHANGELOG entries use classification tags

**Priority:** P0
**Description:** Every changelog entry under a version section is classified with a standard tag indicating the type of change.

**Acceptance criteria:**
- AC-CHG-2a: At least one entry in each version section (for versions that have non-trivial changes) carries a classification tag from the set: `[runtime]`, `[DSL]`, `[CLI]`, `[docs]`, `[tests]`, `[breaking]`.
- AC-CHG-2b: Classification tags appear at the beginning of changelog bullet points or sub-headings (consistent placement).
- AC-CHG-2c: The classification tag set is documented at the top of CHANGELOG.md so readers understand the scheme.

### UC-REL-1: Release process is documented

**Priority:** P0
**Description:** A release checklist document exists that describes the step-by-step process for publishing a new version of Zigma Flow.

**Acceptance criteria:**
- AC-REL-1a: `docs/release-checklist.md` exists.
- AC-REL-1b: The document contains sections covering: pre-release verification (tests pass, CI green), version bump (npm version / manual), changelog update, git tag creation, and post-release validation.
- AC-REL-1c: The document is at least 20 lines (not a stub).

## 2. Spec Compliance Matrix

Reference specs: `docs/prd.md`, `docs/phases/v0.4-productization/02-development-plan.md`, GitHub Issue #97.

| Clause | Source | Type | Requirement | Test Mapping |
|--------|--------|------|-------------|--------------|
| M4-license | v0.4 plan M4 | MUST | package.json has license, no `private: true` | T-PKG-LICENSE, T-PKG-PRIVATE |
| M4-name | Issue #97 | MUST | Package name is `@zigma/zigma-flow` | T-PKG-NAME |
| M4-changelog | v0.4 plan M4 | MUST | CHANGELOG is current through v0.3.6 | T-CHG-VERSIONS-* |
| M4-release-doc | v0.4 plan M4 | MUST | Release process is documented | T-CHG-RELEASE-DOC |
| ISSUE97-license | Issue #97 | MUST | License is Apache 2.0 | T-LIC-EXISTS, T-LIC-CONTENT |
| ISSUE97-version | Issue #97 | MUST | Version policy and stability declaration | T-CHG-VERSION-POLICY |
| ISSUE97-classify | Issue #97 | MUST | CHANGELOG classification rules: runtime, DSL, CLI, docs, tests, breaking | T-CHG-CLASSIFY-* |
| ISSUE97-checklist | Issue #97 | MUST | Release checklist document | T-CHG-RELEASE-DOC |
| R-semver | General engineering | MUST | version field is valid semver | T-PKG-VERSION |

## 3. Test Matrix

### 3.1 Package metadata tests (tests/release/package.test.ts)

These tests validate `package.json` and the `LICENSE` file. They use only Node.js standard library (`fs`, `path`) and run without requiring a build step.

| Test ID | Use Case | Description | Expected Result (red phase) |
|---------|----------|-------------|-----------------------------|
| T-PKG-NAME | UC-PKG-1a | package.json `name` equals `"@zigma/zigma-flow"` | FAIL -- currently `"zigma-flow"` |
| T-PKG-LICENSE | UC-PKG-1b | package.json `license` equals `"Apache-2.0"` | FAIL -- license field is absent |
| T-PKG-PRIVATE | UC-PKG-1c | package.json `private` is not `true` | FAIL -- currently `true` |
| T-PKG-VERSION | UC-PKG-1d | package.json `version` is valid semver | PASS -- current version "0.3.6" is valid semver |
| T-LIC-EXISTS | UC-LIC-1a | `LICENSE` file exists at repo root | FAIL -- LICENSE file does not exist |
| T-LIC-CONTENT | UC-LIC-1b,1c | LICENSE contains "Apache License" and "Version 2.0" | FAIL -- LICENSE file does not exist |

### 3.2 CHANGELOG and release checklist tests (tests/release/changelog.test.ts)

These tests validate `CHANGELOG.md` and `docs/release-checklist.md`. They use only Node.js standard library.

| Test ID | Use Case | Description | Expected Result (red phase) |
|---------|----------|-------------|-----------------------------|
| T-CHG-EXISTS | UC-CHG-1 | CHANGELOG.md exists and is readable | PASS -- file exists |
| T-CHG-VERSION-v0.2.2 | UC-CHG-1a | CHANGELOG has `## [v0.2.2]` section | FAIL -- v0.2.2 entry missing |
| T-CHG-VERSION-v0.3.0 | UC-CHG-1b | CHANGELOG has `## [v0.3.0]` section | FAIL -- v0.3.0 entry missing |
| T-CHG-VERSION-v0.3.1 | UC-CHG-1c | CHANGELOG has `## [v0.3.1]` section | FAIL -- v0.3.1 entry missing |
| T-CHG-VERSION-v0.3.2 | UC-CHG-1d | CHANGELOG has `## [v0.3.2]` section | FAIL -- v0.3.2 entry missing |
| T-CHG-VERSION-v0.3.3 | UC-CHG-1e | CHANGELOG has `## [v0.3.3]` section | FAIL -- v0.3.3 entry missing |
| T-CHG-VERSION-v0.3.4 | UC-CHG-1f | CHANGELOG has `## [v0.3.4]` section | FAIL -- v0.3.4 entry missing |
| T-CHG-VERSION-v0.3.5 | UC-CHG-1g | CHANGELOG has `## [v0.3.5]` section | FAIL -- v0.3.5 entry missing |
| T-CHG-VERSION-v0.3.6 | UC-CHG-1h | CHANGELOG has `## [v0.3.6]` section | FAIL -- v0.3.6 entry missing |
| T-CHG-CLASSIFY-TAGS | UC-CHG-2a,2c | Classification tag legend is documented at top of CHANGELOG | FAIL -- classification scheme not yet documented |
| T-CHG-CLASSIFY-PER-VERSION | UC-CHG-2a,2b | Each version section from v0.2.2+ uses classification tags on entries | FAIL -- version sections missing, no classification |
| T-CHG-VERSION-POLICY | UC-CHG-1i | Version policy or stability declaration is mentioned in CHANGELOG or docs/ | FAIL -- version policy not documented |
| T-CHG-RELEASE-DOC | UC-REL-1a-c | `docs/release-checklist.md` exists with required sections | FAIL -- file does not exist |

## 4. Design Decisions

This section records decisions made during Step 1. These are binding for Step 2 implementation.

### AD-WF-REL-001: Test approach for release assets

**Decision:** Release asset tests are standalone vitest test files in `tests/release/` that use only Node.js standard library APIs (`fs`, `path`). They do NOT import from `src/` and do NOT require `zigma-flow` to be built or installed. All file paths are computed relative to `import.meta.dirname` so the repo root is found via `join(import.meta.dirname, "..", ".."`).

**Rationale:** These tests validate static project metadata files (package.json, CHANGELOG.md, LICENSE, release-checklist.md). These files exist independently of the build. Using only stdlib keeps the tests fast (sub-second), CI-friendly, and free of circular dependencies.

**Rejected alternative:** Importing semver library for version validation. Rejected because a simple regex (`/^\d+\.\d+\.\d+/`) is sufficient for validating semver format and avoids adding a dependency solely for tests.

### AD-WF-REL-002: CHANGELOG classification tags follow Keep a Changelog principles

**Decision:** CHANGELOG classification tags are based on Keep a Changelog's change categories, adapted for Zigma Flow's domain:
- `[runtime]` -- Engine, scheduler, state machine, job execution, agent lifecycle
- `[DSL]` -- Workflow schema, expression language, variables, context blocks
- `[CLI]` -- Command-line interface, flags, subcommands, output formatting
- `[docs]` -- Documentation, README, tutorials, comments
- `[tests]` -- Test additions, test fixes, test infrastructure
- `[breaking]` -- Breaking changes to public APIs, schema, or behavior (must also carry another tag)

**Rationale:** Standard classification enables automated changelog tooling and helps users quickly find relevant changes. The `[breaking]` tag is additive (e.g., `[DSL] [breaking]` means a breaking change in the DSL layer).

**Rejected alternative:** Free-form categories. Rejected because unstructured changelogs are harder to scan and tool-consume.

### AD-WF-REL-003: Version range for CHANGELOG catch-up

**Decision:** CHANGELOG entries are added for versions v0.2.2 through v0.3.6. The v0.2.0 entry already in CHANGELOG.md is preserved as-is. Versions v0.2.1 (a CI-only release with no code changes) and v0.3.4 (tag missing, changes absorbed into v0.3.5) may be documented as brief notes or combined with adjacent versions.

**Rationale:** The current CHANGELOG covers v0.1.0 through v0.2.0. The next tagged release after v0.2.0 that had substantive changes is v0.2.2 (v0.2.1 was CI-only). v0.3.4 tag is missing from the repository (commit `90ca471` exists but no tag), so its changes are documented under v0.3.5.

**Rejected alternative:** Regenerating CHANGELOG from scratch. Rejected because the existing v0.2.0 entries are detailed and well-written; rewriting them wastes effort and risks losing detail.

### AD-WF-REL-004: LICENSE file format

**Decision:** The LICENSE file contains the full Apache License 2.0 text as published at https://www.apache.org/licenses/LICENSE-2.0.txt, with the copyright line `Copyright 2026 Zigma`. The file is placed at the repo root named `LICENSE` (no extension), matching npm conventions.

**Rationale:** The full license text is required by the Apache 2.0 license itself (Appendix: "To apply the Apache License to your work, attach the following boilerplate notice..."). A stub or SPDX-only file is insufficient. npm automatically detects the LICENSE file at the package root.

**Rejected alternative:** LICENSE.md with Markdown formatting. Rejected because the canonical Apache 2.0 text is plaintext, and npm's license detection works best with a plain LICENSE file.

### AD-WF-REL-005: Release checklist scope

**Decision:** The `docs/release-checklist.md` document covers the manual steps a maintainer performs to publish a release: (1) verify CI pass and local test pass, (2) update CHANGELOG.md with the new version entry, (3) bump version in package.json, (4) create and push git tag, (5) create GitHub Release with changelog notes. It does NOT cover automated CI/CD release workflows (those are out of scope for v0.4).

**Rationale:** The release process today is manual (per v0.2.0 and v0.3.x releases). Documenting what exists now is more honest and immediately useful than designing an automated process that doesn't exist. The checklist can be updated when CI/CD release automation is added in a future phase.

**Rejected alternative:** Full CI/CD release pipeline documentation. Rejected because it would document a process that doesn't exist, creating confusion for maintainers.

### AD-WF-REL-006: Test file split

**Decision:** Two test files:
1. `tests/release/package.test.ts` -- package.json metadata (name, license, private, version) + LICENSE file existence and content
2. `tests/release/changelog.test.ts` -- CHANGELOG.md version coverage, classification tags, version policy, and release-checklist.md existence

**Rationale:** Package metadata and LICENSE are tightly coupled (both define the package's publishable identity). CHANGELOG and release checklist are coupled (both define the release documentation surface). Splitting this way keeps each file under 150 lines and avoids monolithic test files.

**Rejected alternative:** Single `release-validation.test.ts` or three separate files. Single file rejected because it would mix unrelated concerns (package identity vs. changelog content). Three files rejected because it exceeds the 2-file gate count.

## 5. File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `docs/phases/v0.4-productization/workflows/wf-release/01-cases-and-tests.md` | Create | This document |
| `tests/release/package.test.ts` | Create | package.json metadata and LICENSE validation tests |
| `tests/release/changelog.test.ts` | Create | CHANGELOG version coverage, classification, release checklist tests |

### Future Step 2 files (not created yet)

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | Change name to `@zigma/zigma-flow`, add `license: "Apache-2.0"`, remove `"private": true` |
| `LICENSE` | Create | Apache 2.0 full license text |
| `CHANGELOG.md` | Modify | Add entries for v0.2.2 through v0.3.6 with classification tags |
| `docs/release-checklist.md` | Create | Step-by-step release process documentation |
