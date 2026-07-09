# wf-docs-examples: Cases and Tests

**Phase:** v0.4 Productization
**Workflow:** wf-docs-examples -- Documentation and examples (Step 1: cases-and-tests, Slice A)
**Status:** Red phase (tests written; implementation pending in Step 2)

## 0. Slice Boundary

- **Slice name:** wf-docs-examples-slice-a (examples + README Quick Start)
- **Single bounded context:** The `examples/` directory at repo root and the `README.md` Quick Start section. Does NOT include docs/wiki/ edits, docs/*.md tutorial files, or the CLI reference doc (those are Slice B or separate workflows). The README rewrite touches only the sections needed for a new-user Quick Start flow under 30 minutes.
- **User tasks (max 3):**
  1. User can follow the README Quick Start from a freshly cloned repo and complete a workflow validation run in under 30 minutes, using only copy-pasteable commands with no prior knowledge of Zigma Flow.
  2. User can browse `examples/` and find a minimal runnable TypeScript project whose workflow YAML passes `zigma-flow validate`, providing a concrete reference for their own project.
  3. User can trust that every internal link in README.md resolves to an existing file (no 404s) and every code block describes commands that produce the documented output when run in the correct context.
- **Planned test files (max 2):**
  1. `tests/docs/readme-validation.test.ts` -- link resolution tests, command-block extraction tests, markdown structure validation
  2. `tests/docs/examples-structure.test.ts` -- examples/ directory structure tests, workflow YAML parseability, required file inventory checks

### Slice B (deferred)

The following items are deferred to a follow-up `wf-docs-examples-slice-b` workflow:

- `docs/getting-started.md` -- "first dogfood run" tutorial
- `docs/custom-workflow.md` -- "writing a custom workflow" tutorial
- `docs/skill-pack-authoring.md` -- "writing a Skill Pack" tutorial

The README Quick Start will include forward references (links) to these files so the navigation structure is in place; those links will point to files that do not yet exist, which is expected and documented in the test spec below as an opt-in exclusion list.

## 1. Functional Points and Use Cases

### UC-README-1: README Quick Start is followable from a fresh clone

**Priority:** P0
**Description:** The README Quick Start section provides a linear, numbered sequence of commands that a developer with Node.js and pnpm installed can run in a fresh clone of the repository. Each command is self-contained and documented with expected output. The entire Quick Start, from `pnpm install` to `zigma-flow validate`, completes in under 10 minutes of wall-clock time for experienced devs and under 30 minutes for newcomers.

**Acceptance criteria:**
- AC-README-1a: The Quick Start section is the first section after the project title/description (above the fold for GitHub's README rendering).
- AC-README-1b: The Quick Start contains at most 8 numbered steps, each with a single copy-pasteable command.
- AC-README-1c: Every command in the Quick Start is tested by a script that verifies at minimum the syntax (no unclosed quotes, command flags match the documented CLI) and at maximum the actual execution (if zigma-flow is built and available).
- AC-README-1d: The Quick Start references `pnpm` commands (matching the repo's own package manager) and notes that npm/yarn/bun users should substitute accordingly.

### UC-README-2: README structure is skimmable and navigable

**Priority:** P0
**Description:** The rewritten README uses clear section headers, a table of contents, and consistent formatting. The structure separates Quick Start (for newcomers) from reference sections (for users who need details).

**Acceptance criteria:**
- AC-README-2a: The README has a table of contents with anchor links to every major section.
- AC-README-2b: Sections appear in this order: Title/Description, Quick Start, How It Works (concise), CLI Commands (table), code-change Workflow (diagram + table), Customization, Development.
- AC-README-2c: The "How It Works" section is no more than 3 paragraphs (shorter than the current version).
- AC-README-2d: The "Development" section is at the bottom (current position preserved).

### UC-README-3: Internal links resolve to existing files

**Priority:** P0
**Description:** Every internal markdown link in README.md (links to `./docs/...`, `./examples/...`, or same-repo relative paths) points to a file that exists in the repository.

**Acceptance criteria:**
- AC-README-3a: An automated link-checking test enumerates all `[...](<path>)` links in README.md and asserts `stat(path)` succeeds.
- AC-README-3b: External links (https://...) are NOT validated by this test (only checked for URL format).
- AC-README-3c: Anchor-only links (e.g., `#section-name`) are validated against actual headings in the README.
- AC-README-3d: Links to Slice B tutorial files (`docs/getting-started.md`, `docs/custom-workflow.md`, `docs/skill-pack-authoring.md`) may appear in the README as forward references but will not resolve until Slice B is implemented. These are listed in an exclusion list in the test and produce a warning, not a failure.

### UC-EX-1: examples/ directory has a minimal runnable TypeScript project

**Priority:** P0
**Description:** The `examples/` directory at the repo root contains a single minimal TypeScript project (`examples/basic-code-change/`) that demonstrates how to use Zigma Flow with a small TypeScript codebase.

**Acceptance criteria:**
- AC-EX-1a: `examples/basic-code-change/` exists and contains: `package.json`, `tsconfig.json`, `src/index.ts`, and `.zigma-flow/` (initialized).
- AC-EX-1b: Running `zigma-flow validate examples/basic-code-change/.zigma-flow/workflows/code-change.yml` from the repo root succeeds and prints `Workflow is valid.`
- AC-EX-1c: The example project has working `typecheck`, `lint`, and `test` scripts (matching the Skill Pack's default script steps).
- AC-EX-1d: The example project's `.zigma-flow/config.json` has a valid agent backend configuration.

### UC-EX-2: Example workflow YAML is a valid, loadable DAG

**Priority:** P0
**Description:** The example workflow YAML in `examples/basic-code-change/.zigma-flow/workflows/code-change.yml` is structurally valid: it parses as YAML, passes the workflow JSON Schema, and contains a valid DAG (no cycles).

**Acceptance criteria:**
- AC-EX-2a: The YAML file can be loaded and parsed without error.
- AC-EX-2b: The parsed workflow has at minimum `name`, `jobs`, and `entry` fields.
- AC-EX-2c: The DAG formed by `needs` references has no cycles.
- AC-EX-2d: Every job referenced in `needs` and `entry` exists in the `jobs` map.

### UC-EX-3: Example project is self-documenting

**Priority:** P1
**Description:** The example project includes a README or inline comments that explain what the project is and how to use Zigma Flow with it.

**Acceptance criteria:**
- AC-EX-3a: `examples/basic-code-change/README.md` or `examples/README.md` explains the purpose of the example.
- AC-EX-3b: The explanation links back to the main README Quick Start.
- AC-EX-3c: The explanation is in English (not Chinese -- matching the README language change from zh to en).

### UC-CMD-1: README code blocks are syntactically valid

**Priority:** P0
**Description:** Every ` ```bash ` and ` ```text ` fenced code block in the README can be parsed without obvious syntax errors: balanced quotes, no truncated lines, commands match the documented CLI interface.

**Acceptance criteria:**
- AC-CMD-1a: A test extracts all bash code blocks and verifies each non-comment line is a well-formed command (balanced quotes, no mid-word line breaks).
- AC-CMD-1b: Commands that reference `zigma-flow` subcommands match the subcommands listed in the README's CLI Commands table.
- AC-CMD-1c: JSON code blocks parse successfully via `JSON.parse()`.

### UC-CMD-2: README structure validates as well-formed Markdown

**Priority:** P1
**Description:** The README has valid Markdown formatting: headers increment properly (no skipped levels), code blocks have matching fences, table rows have consistent column counts.

**Acceptance criteria:**
- AC-CMD-2a: Header levels never skip more than one level (e.g., `##` can follow `#`, but `####` should not follow `##` without `###` in between -- informational, not blocking).
- AC-CMD-2b: Every ` ``` ` fence has a matching close fence.
- AC-CMD-2c: Table rows have consistent column counts within each table.

## 2. Spec Compliance Matrix

Reference specs: `docs/prd.md`, `docs/phases/v0.4-productization/02-development-plan.md`, GitHub Issue #97.

| Clause | Source | Type | Requirement | Test Mapping |
|--------|--------|------|-------------|--------------|
| M3-clone-to-run | v0.4 plan M3 | MUST | Developer new to project can follow Quick Start from clone to first successful workflow run in under 30 minutes | AC-README-1a-d, T-README-3 (smoke) |
| ISSUE97-examples | Issue #97 | MUST | Create minimal example repository or examples/ directory | UC-EX-1, UC-EX-2 (AC-EX-1a-d, AC-EX-2a-d) |
| ISSUE97-readme | Issue #97 | MUST | README rewrite for new users (Quick Start) | UC-README-1, UC-README-2 (all sub-ACs) |
| ISSUE97-tutorials | Issue #97 | SHOULD | Tutorials for getting-started, custom-workflow, skill-pack-authoring | DEFERRED to Slice B |
| M3-docs | v0.4 plan M3 | MUST | README, examples/, and tutorials support first-time trial | UC-README-1 (README), UC-EX-1 (examples), tutorials deferred |
| R-link-integrity | v0.2 plan Quality | SHOULD | Internal links resolve to existing files | T-README-LINK-* (all) |
| FR-001-validate | PRD FR-001 | MUST | Validate command must succeed on valid workflows | T-EX-YAML-1 (example workflow validates) |

## 3. Test Matrix

### 3.1 README validation tests (tests/docs/readme-validation.test.ts)

These tests validate the README.md file itself. They run without zigma-flow installed -- they only need Node.js file APIs.

| Test ID | Use Case | Description | Expected Result (red phase) |
|---------|----------|-------------|-----------------------------|
| T-README-LINK-1 | UC-README-3a | All relative links in README resolve to existing files | FAIL -- README links not yet validated; some may be broken |
| T-README-LINK-2 | UC-README-3c | Anchor links resolve to existing headings in README | FAIL -- anchor validation not yet implemented |
| T-README-LINK-3 | UC-README-3d | Links to Slice B tutorials produce warnings, not failures | FAIL (warn) -- links may point to non-existent files |
| T-README-CMD-1 | UC-CMD-1a | All bash code blocks have syntactically well-formed commands | FAIL -- command validation not yet implemented |
| T-README-CMD-2 | UC-CMD-1c | All JSON code blocks parse successfully | FAIL -- JSON validation not yet implemented |
| T-README-MD-1 | UC-CMD-2b | All fenced code blocks have matching close fences | FAIL -- fence matching not yet validated |
| T-README-MD-2 | UC-CMD-2c | Table rows have consistent column counts | FAIL -- table validation not yet implemented |
| T-README-STRUCT-1 | UC-README-2b | Required sections exist in correct order | FAIL -- README structure not yet validated |
| T-README-STRUCT-2 | UC-README-2a | Table of contents links exist and resolve | FAIL -- ToC not yet validated |
| T-README-QUICKSTART-1 | UC-README-1b | Quick Start has at most 8 steps | FAIL -- Quick Start section not yet rewritten |
| T-README-QUICKSTART-2 | UC-README-1d | Quick Start uses pnpm commands | FAIL -- not yet rewritten |

### 3.2 Example project structure tests (tests/docs/examples-structure.test.ts)

These tests validate the examples/ directory and its contents.

| Test ID | Use Case | Description | Expected Result (red phase) |
|---------|----------|-------------|-----------------------------|
| T-EX-STRUCT-1 | UC-EX-1a | examples/ directory exists with basic-code-change/ subdir | FAIL -- examples/ does not exist |
| T-EX-STRUCT-2 | UC-EX-1a | basic-code-change/ has package.json | FAIL -- does not exist |
| T-EX-STRUCT-3 | UC-EX-1a | basic-code-change/ has tsconfig.json | FAIL -- does not exist |
| T-EX-STRUCT-4 | UC-EX-1a | basic-code-change/ has src/index.ts | FAIL -- does not exist |
| T-EX-STRUCT-5 | UC-EX-1a | basic-code-change/ has .zigma-flow/ directory | FAIL -- does not exist |
| T-EX-STRUCT-6 | UC-EX-1a | basic-code-change/.zigma-flow/ has workflows/code-change.yml | FAIL -- does not exist |
| T-EX-STRUCT-7 | UC-EX-1a | basic-code-change/.zigma-flow/ has config.json | FAIL -- does not exist |
| T-EX-YAML-1 | UC-EX-2a | Example workflow YAML parses successfully | FAIL -- file does not exist |
| T-EX-YAML-2 | UC-EX-2b | Workflow has required fields (name, jobs, entry) | FAIL -- file does not exist |
| T-EX-YAML-3 | UC-EX-2c | Workflow DAG has no cycles | FAIL -- file does not exist |
| T-EX-YAML-4 | UC-EX-2d | All job references in needs/entry exist in jobs map | FAIL -- file does not exist |
| T-EX-README-1 | UC-EX-3a | Example has README or explanation file | FAIL -- does not exist |
| T-EX-CONFIG-1 | UC-EX-1d | config.json has valid agent backend configuration | FAIL -- does not exist |
| T-EX-SCRIPTS-1 | UC-EX-1c | example package.json has typecheck, lint, test scripts | FAIL -- does not exist |

## 4. Design Decisions

This section records decisions made during Step 1. These are binding for Step 2 implementation.

### AD-WF-DOCS-001: Slice strategy

**Decision:** This workflow is split into two slices:
- **Slice A (this document):** `examples/` directory creation + README.md Quick Start rewrite. These are tightly coupled because the README links to examples/ and the example is the target of the Quick Start flow.
- **Slice B (deferred):** Three tutorial documents (`docs/getting-started.md`, `docs/custom-workflow.md`, `docs/skill-pack-authoring.md`).

**Rationale:** The combined scope (examples/ + README + 3 tutorials) exceeds the 3-user-task limit for a single Step 1. Slice A is the higher-priority "first impression" package that enables the M3 milestone. Slice B tutorials are self-contained and can be implemented independently after Slice A.

**Rejected alternative:** Single monolithic workflow. Rejected because scope exceeds bounded-context limits and makes parallel implementation impossible.

### AD-WF-DOCS-002: Test approach for documentation

**Decision:** Documentation tests are standalone vitest test files in `tests/docs/` that use only Node.js standard library APIs (`fs`, `path`) plus the `yaml` package (already a dependency) for workflow YAML parsing. They do NOT import from `src/` and do NOT require `zigma-flow` to be built or installed.

**Rationale:** Documentation tests should validate the files as static artifacts. Importing from `src/` would couple doc tests to the codebase's build system and create circular dependencies (README describes how to build, test validates README before build). Using only `fs` + `yaml` keeps the tests fast, independent, and runnable in CI before any build step.

**Rejected alternative:** Shell-script-based validation. Rejected because vitest is already the project's test runner and provides better reporting, assertions, and CI integration than shell scripts.

### AD-WF-DOCS-003: Link validation scope

**Decision:** Internal relative links (starting with `./`) and same-repo absolute links are validated by checking filesystem existence. External links (https://...) are NOT fetched -- they are only checked for valid URL format (scheme + host). Anchor links (`#section`) are validated against the headings present in the same file. Anchor links in cross-file references (e.g., `./docs/architecture.md#section`) are NOT validated (cross-file anchor resolution requires full markdown parsing of target files and is out of scope).

**Rationale:** Filesystem existence checks are fast and deterministic. External link validation adds network dependence and flakiness. Cross-file anchor resolution adds significant complexity for marginal value -- a file existing and having the anchor target requires parsing the target file's markdown AST.

**Rejected alternative:** Full HTML rendering and link crawl with a headless browser. Rejected as excessive for a README validation test.

### AD-WF-DOCS-004: Forward-reference handling for Slice B links

**Decision:** The README Quick Start may include forward links to Slice B documents (`docs/getting-started.md`, `docs/custom-workflow.md`, `docs/skill-pack-authoring.md`). These paths are listed in a test exclusion list (`SLICE_B_FORWARD_REFS`) and produce test warnings rather than failures.

**Rationale:** The README should present the complete documentation navigation from day one, even if some linked pages don't exist yet. Broken links for known forward references are intentional and temporary. The exclusion list makes the intent explicit and prevents false positives.

**Rejected alternative:** Conditionally inserting Slice B links after implementation. Rejected because it means two README edits instead of one, and a follow-up PR to add links is easily forgotten.

### AD-WF-DOCS-005: Example project scope

**Decision:** The `examples/` directory contains exactly one example: `basic-code-change/`. This is a minimal TypeScript project with a single source file, a configured tsconfig, and a pre-initialized `.zigma-flow/` directory. The workflow uses the default `code-change` Skill Pack that ships with `zigma-flow init`.

**Rationale:** One well-polished example is more valuable than multiple incomplete ones. The `code-change` workflow is the project's primary use case and the built-in workflow. A single example keeps the `examples/` directory clean and avoids maintenance burden.

**Rejected alternative:** Multiple examples (basic + advanced + custom skill pack). Rejected because multiple examples increase maintenance surface and make the "30-minute trial" harder to navigate. A custom-skill-pack example is better placed in the `skill-pack-authoring.md` tutorial (Slice B).

### AD-WF-DOCS-006: README language

**Decision:** The rewritten README is in English only (matching the current README's language). The existing Chinese wiki docs (`docs/wiki/`) remain in Chinese and are referenced but not rewritten in this phase.

**Rationale:** English is the lingua franca for open-source CLI tools. The Chinese wiki is existing documentation that will be linked from the README. Rewriting the wiki is explicitly out of scope for v0.4.

### AD-WF-DOCS-007: Command-block testing depth

**Decision:** README command blocks are tested for structural validity only (balanced quotes, known subcommand names, well-formed JSON). They are NOT executed. Execution testing is deferred to the dogfood test suite, which exercises the actual `zigma-flow` CLI in a real environment.

**Rationale:** Executing README commands requires `zigma-flow` to be built and installed, which creates a chicken-and-egg problem for CI (README describes how to build, test validates README before build). Structural validation catches copy-paste errors (typos, missing flags) without requiring a build step.

**Rejected alternative:** Full execution testing with a built binary. Rejected because it couples doc tests to the build pipeline.

### AD-WF-DOCS-008: Yaml dependency for example validation

**Decision:** The `tests/docs/examples-structure.test.ts` test imports `yaml` (already a project dependency at `dependencies["yaml"]: ^2.9.0`) for parsing workflow YAML files. No new dependencies are added.

**Rationale:** The `yaml` package is already a production dependency used by the workflow loader. Using it in tests adds no new dependency weight and ensures the YAML parsing behavior matches what `zigma-flow validate` does at runtime.

## 5. File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `docs/phases/v0.4-productization/workflows/wf-docs-examples/01-cases-and-tests.md` | Create | This document |
| `tests/docs/readme-validation.test.ts` | Create | README link, command, and structure validation tests |
| `tests/docs/examples-structure.test.ts` | Create | Example project directory structure and YAML validation tests |

### Future Step 2 files (not created yet)

| File | Action | Purpose |
|------|--------|---------|
| `examples/basic-code-change/package.json` | Create | Example project manifest |
| `examples/basic-code-change/tsconfig.json` | Create | Example TypeScript config |
| `examples/basic-code-change/src/index.ts` | Create | Example source file (a simple parser function) |
| `examples/basic-code-change/.zigma-flow/config.json` | Create | Example agent backend config |
| `examples/basic-code-change/.zigma-flow/skill-lock.json` | Create | Example skill lockfile |
| `examples/basic-code-change/.zigma-flow/workflows/code-change.yml` | Create | Example workflow definition |
| `examples/basic-code-change/.zigma-flow/skills/code-change/skill.yml` | Create | Example Skill Pack manifest |
| `examples/basic-code-change/.zigma-flow/skills/code-change/knowledge/` | Create | Example knowledge docs |
| `examples/basic-code-change/.zigma-flow/skills/code-change/prompts/` | Create | Example prompt templates |
| `examples/basic-code-change/.zigma-flow/skills/code-change/scripts/` | Create | Example scripts |
| `examples/basic-code-change/.zigma-flow/skills/code-change/checks/` | Create | Example check definitions |
| `examples/basic-code-change/README.md` | Create | Example self-documentation |
| `README.md` | Rewrite | Quick Start section and structural reorganization |
