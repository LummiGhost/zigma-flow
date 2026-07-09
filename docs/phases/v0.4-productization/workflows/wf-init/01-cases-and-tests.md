# wf-init: Cases and Tests

**Phase:** v0.4 Productization
**Workflow:** wf-init — Init experience improvements (Step 1: cases-and-tests)
**Status:** Red phase (tests written; implementation pending in Step 2)

## 0. Slice Boundary

- **Slice name:** wf-init-env-detection
- **Single bounded context:** Init module (`src/init/`) — filesystem helpers, detection, template generation, and `runInit` orchestrator. Must NOT import engine, workflow, skill-pack, DAG, context, prompt, script, check, artifact, run, events, workspace, git, or expression modules.
- **User tasks (max 3):**
  1. User can run `zigma-flow init` in a TypeScript project and get workflow script/check steps tailored to their package manager (pnpm/npm/yarn/bun) and available project scripts (typecheck, lint, test, test:ci, build).
  2. User can re-run `zigma-flow init` safely -- existing files (config, workflows, skill pack, lockfile, run data) are never overwritten, and the command reports skipped status for every pre-existing file.
  3. User can run `zigma-flow init` in a bare directory (no package.json) and still get a valid, loadable workflow YAML with reasonable defaults -- the template generation degrades gracefully.
- **Planned test files (max 2):**
  1. `tests/init/detect.test.ts` -- unit tests for package manager detection, script detection, environment detection, and script command building
  2. `tests/init/init.test.ts` -- updated with integration tests for tailored workflow generation across PM/script scenarios

## 1. Functional Points and Use Cases

### UC-DETECT-1: Package manager detection from lockfiles

**Priority:** P0
**Description:** `detectPackageManager(cwd)` scans the project root for lockfiles and returns the detected package manager. Detection order: `pnpm-lock.yaml` -> `yarn.lock` -> `package-lock.json` -> `bun.lockb`/`bun.lock`. Falls back to `"npm"` when no lockfile is present.

**Acceptance criteria:**
- AC-DETECT-1a: When `pnpm-lock.yaml` exists, return `"pnpm"` regardless of other lockfiles.
- AC-DETECT-1b: When `yarn.lock` exists (and no `pnpm-lock.yaml`), return `"yarn"`.
- AC-DETECT-1c: When `package-lock.json` exists (and no pnpm/yarn lock), return `"npm"`.
- AC-DETECT-1d: When `bun.lockb` or `bun.lock` exists (and no pnpm/yarn/npm lock), return `"bun"`.
- AC-DETECT-1e: When no lockfile exists at all, return `"npm"` (safe default).

### UC-DETECT-2: Available scripts detection from package.json

**Priority:** P0
**Description:** `detectScripts(cwd)` reads `package.json` and reports which of the known scripts (`typecheck`, `lint`, `test`, `test:ci`, `build`) are present.

**Acceptance criteria:**
- AC-DETECT-2a: When `package.json` has `scripts.typecheck`, `typecheck` is `true`; otherwise `false`.
- AC-DETECT-2b: When `package.json` has `scripts.lint`, `lint` is `true`; otherwise `false`.
- AC-DETECT-2c: When `package.json` has `scripts.test`, `test` is `true`; otherwise `false`.
- AC-DETECT-2d: When `package.json` has `scripts["test:ci"]`, `testCi` is `true`; otherwise `false`.
- AC-DETECT-2e: When `package.json` has `scripts.build`, `build` is `true`; otherwise `false`.
- AC-DETECT-2f: When no `package.json` file exists, all fields are `false`.
- AC-DETECT-2g: When `package.json` exists but has no `scripts` field, all fields are `false`.

### UC-DETECT-3: Full environment detection

**Priority:** P0
**Description:** `detectEnvironment(cwd)` combines `detectPackageManager` and `detectScripts` into a single `DetectionResult` struct that also reports whether `package.json` was found.

**Acceptance criteria:**
- AC-DETECT-3a: Returns `packageManager`, `scripts`, and `hasPackageJson` in a single call.
- AC-DETECT-3b: `hasPackageJson` is `true` when `package.json` exists and contains valid JSON, `false` otherwise.

### UC-CMD-1: Init generates tailored script steps for pnpm project

**Priority:** P0
**Description:** 用户可完成：在一个 pnpm TypeScript 项目中运行 `zigma-flow init`，生成的 `code-change.yml` 中 `static-check` 和 `unit-test` job 的 script step 使用 `pnpm` 命令而非硬编码的 `pnpm typecheck && pnpm lint`。

**Acceptance criteria:**
- AC-CMD-1a: When `pnpm-lock.yaml` is present and `package.json` has both `typecheck` and `lint`, the `static-check` job script step runs `pnpm typecheck && pnpm lint`.
- AC-CMD-1b: When only `typecheck` exists, the `static-check` script step runs just `pnpm typecheck`.
- AC-CMD-1c: When only `lint` exists, the `static-check` script step runs just `pnpm lint`.
- AC-CMD-1d: When neither `typecheck` nor `lint` exists, the `static-check` job uses an agent step with a prompt explaining that no static check scripts were found.

### UC-CMD-2: Init generates tailored script steps for npm project

**Priority:** P0
**Description:** 用户可完成：在一个 npm TypeScript 项目中运行 `zigma-flow init`，生成的 workflow 使用 `npm run <script>` 格式的命令。

**Acceptance criteria:**
- AC-CMD-2a: When `package-lock.json` is present and scripts exist, commands use `npm run <name>` format (e.g., `npm run typecheck && npm run lint`).

### UC-CMD-3: Init generates tailored script steps for yarn project

**Priority:** P0
**Description:** 用户可完成：在一个 yarn TypeScript 项目中运行 `zigma-flow init`，生成的 workflow 使用 `yarn <script>` 格式的命令。

**Acceptance criteria:**
- AC-CMD-3a: When `yarn.lock` is present, commands use `yarn <name>` format (e.g., `yarn typecheck && yarn lint`).

### UC-CMD-4: Init generates tailored script steps for bun project

**Priority:** P0
**Description:** 用户可完成：在一个 bun TypeScript 项目中运行 `zigma-flow init`，生成的 workflow 使用 `bun run <script>` 格式的命令。

**Acceptance criteria:**
- AC-CMD-4a: When `bun.lockb` or `bun.lock` is present, commands use `bun run <name>` format.

### UC-CMD-5: Init adapts unit-test job to available test scripts

**Priority:** P1
**Description:** The `unit-test` job script step uses the strongest test script that is available.

**Acceptance criteria:**
- AC-CMD-5a: When `test:ci` exists, the unit-test script step uses it (e.g., `pnpm test:ci`).
- AC-CMD-5b: When only `test` exists (no `test:ci`), the unit-test script step uses it (e.g., `pnpm test`).
- AC-CMD-5c: When neither `test` nor `test:ci` exists, the `unit-test` job uses an agent step with a prompt explaining that no test scripts were found.

### UC-CMD-6: Init generates build job when build script exists

**Priority:** P2
**Description:** When the project has a `build` script, an additional `build` job is added to the workflow DAG after `implement` and before `static-check`.

**Acceptance criteria:**
- AC-CMD-6a: When `build` script exists, a `build` job appears in the workflow with a script step running `{pm} {run} build`.
- AC-CMD-6b: When no `build` script exists, no `build` job is generated.

### UC-CMD-7: Idempotent re-run preserves existing files (existing, preserved)

**Priority:** P0
**Description:** Running `zigma-flow init` on an already-initialized project does not overwrite any existing files.
This is existing behavior that must be preserved.

**Acceptance criteria:**
- AC-CMD-7a: Second `runInit` reports `alreadyInitialized: true`.
- AC-CMD-7b: All files report status `"skipped"`.
- AC-CMD-7c: Existing file content is byte-identical after re-run.
- AC-CMD-7d: `.gitignore` is not double-appended.

### UC-CMD-8: Bare project fallback (existing, extended)

**Priority:** P0
**Description:** When no `package.json` exists, init produces a valid workflow with default pnpm commands (backward compatible with current behavior).

**Acceptance criteria:**
- AC-CMD-8a: `runInit` completes without error in a directory with no `package.json`.
- AC-CMD-8b: Generated workflow YAML is loadable via `loadWorkflow()`.
- AC-CMD-8c: Script steps use default `pnpm` commands (existing behavior).

### UC-CMD-9: skill-lock integrity after tailored generation

**Priority:** P1
**Description:** The `skill-lock.json` hash must correctly reflect the generated `skill.yml` content even when the workflow templates vary by detection result.

**Acceptance criteria:**
- AC-CMD-9a: `skill-lock.json` hash matches the SHA-256 of the written `skill.yml`.
- AC-CMD-9b: `loadSkillPack()` succeeds against the generated skill pack root.

## 2. Spec Compliance Matrix

Reference specs: `docs/prd.md` FR-001, `docs/phases/v0.4-productization/02-development-plan.md`.

| Clause | Source | Type | Requirement | Test Mapping |
|--------|--------|------|-------------|--------------|
| FR-001-init-repeat | PRD FR-001 | MUST | Re-running init must not destroy existing data | T-INIT-4 (existing), AC-CMD-7a-d |
| FR-001-config-version | PRD FR-001 | MUST | config.json must include tool version and default config | T-INIT-7 (existing) |
| FR-001-lock-hash | PRD FR-001 | MUST | skill-lock.json must record resolved path and hash | T-INIT-8 (existing), AC-CMD-9a |
| FR-001-already-init | PRD FR-001 | MUST | If directory already initialized, must indicate so | T-INIT-5 (existing), AC-CMD-7a |
| M1-pm-detect | v0.4 plan M1 | MUST | Init detects project environment (package manager, scripts) | T-DETECT-1 through T-DETECT-12 |
| M1-tailored-config | v0.4 plan M1 | MUST | Init generates appropriate config based on detection | T-INIT-15 through T-INIT-26 |
| M1-idempotent | v0.4 plan M1 | MUST | Idempotent re-run is safe | T-INIT-4 (existing) |
| M1-cross-pm | v0.4 plan M1 | MUST | Works across pnpm/npm/yarn/bun | T-INIT-15 through T-INIT-18 |
| R-graceful-fallback | v0.4 plan Risks | SHOULD | Unknown PM prompts user; unknown scripts skip with warning | T-DETECT-5 (fallback to npm), AC-CMD-1d, AC-CMD-5c |
| R-no-overwrite | v0.4 plan Quality | MUST | Init must not overwrite user files without confirmation | writeFileIfMissing contract (T-INIT-2) |

Note: The v0.4 development plan does not use RFC 2119 keywords. The "MUST"/"SHOULD" mapping above is derived from the plan's acceptance criteria and quality bar statements. Where the plan says "must work across" or "must not overwrite", these are interpreted as hard requirements.

## 3. Test Matrix

### 3.1 Unit tests: detection functions (tests/init/detect.test.ts)

| Test ID | Use Case | Description | Expected Result (red phase) |
|---------|----------|-------------|---------------------------|
| T-DETECT-1 | UC-DETECT-1 | detectPackageManager returns "pnpm" when pnpm-lock.yaml exists | FAIL -- detectPackageManager throws |
| T-DETECT-2 | UC-DETECT-1 | detectPackageManager returns "npm" when package-lock.json exists | FAIL -- throws |
| T-DETECT-3 | UC-DETECT-1 | detectPackageManager returns "yarn" when yarn.lock exists | FAIL -- throws |
| T-DETECT-4 | UC-DETECT-1 | detectPackageManager returns "bun" when bun.lockb exists | FAIL -- throws |
| T-DETECT-5 | UC-DETECT-1 | detectPackageManager returns "bun" when bun.lock exists | FAIL -- throws |
| T-DETECT-6 | UC-DETECT-1 | detectPackageManager defaults to "npm" when no lockfile found | FAIL -- throws |
| T-DETECT-7 | UC-DETECT-2 | detectScripts detects all available scripts from package.json | FAIL -- throws |
| T-DETECT-8 | UC-DETECT-2 | detectScripts returns all-false when package.json has no scripts | FAIL -- throws |
| T-DETECT-9 | UC-DETECT-2 | detectScripts returns all-false when package.json does not exist | FAIL -- throws |
| T-DETECT-10 | UC-DETECT-3 | detectEnvironment returns DetectionResult with packageManager | FAIL -- throws |
| T-DETECT-11 | UC-DETECT-3 | detectEnvironment reports hasPackageJson when package.json present | FAIL -- throws |
| T-DETECT-12 | UC-DETECT-3 | detectEnvironment reports hasPackageJson=false when absent | FAIL -- throws |
| T-DETECT-13 | UC-CMD-1/2/3/4 | buildScriptCommand formats "pnpm typecheck" correctly | FAIL -- throws |
| T-DETECT-14 | UC-CMD-1/2/3/4 | buildScriptCommand formats "npm run typecheck" correctly | FAIL -- throws |
| T-DETECT-15 | UC-CMD-1/2/3/4 | buildScriptCommand formats "yarn typecheck" correctly | FAIL -- throws |
| T-DETECT-16 | UC-CMD-1/2/3/4 | buildScriptCommand formats "bun run typecheck" correctly | FAIL -- throws |
| T-DETECT-17 | UC-DETECT-1 | Priority: pnpm beats yarn when both lockfiles present | FAIL -- throws |
| T-DETECT-18 | UC-DETECT-1 | Priority: pnpm beats npm when both lockfiles present | FAIL -- throws |

### 3.2 Integration tests: tailored init (tests/init/init.test.ts)

| Test ID | Use Case | Description | Expected Result (red phase) |
|---------|----------|-------------|---------------------------|
| T-INIT-15 | UC-CMD-1 | init in pnpm project generates pnpm-based static-check command | FAIL -- template not yet parameterized |
| T-INIT-16 | UC-CMD-2 | init in npm project generates npm-based static-check command | FAIL -- template not yet parameterized |
| T-INIT-17 | UC-CMD-3 | init in yarn project generates yarn-based static-check command | FAIL -- template not yet parameterized |
| T-INIT-18 | UC-CMD-4 | init in bun project generates bun-based static-check command | FAIL -- template not yet parameterized |
| T-INIT-19 | UC-CMD-1b | init when only typecheck exists generates typecheck-only static-check | FAIL -- template not yet parameterized |
| T-INIT-20 | UC-CMD-1c | init when only lint exists generates lint-only static-check | FAIL -- template not yet parameterized |
| T-INIT-21 | UC-CMD-1d | init when no check scripts exist: static-check is agent step or has placeholder | FAIL -- template not yet parameterized |
| T-INIT-22 | UC-CMD-5a | init when test:ci exists uses test:ci in unit-test job | FAIL -- template not yet parameterized |
| T-INIT-23 | UC-CMD-5b | init when only test exists uses test in unit-test job | FAIL -- template not yet parameterized |
| T-INIT-24 | UC-CMD-5c | init when no test scripts exist: unit-test is agent step or has placeholder | FAIL -- template not yet parameterized |
| T-INIT-25 | UC-CMD-6a | init when build script exists generates a build job | FAIL -- template not yet parameterized |
| T-INIT-26 | UC-CMD-8 | init with no package.json falls back to default pnpm commands | FAIL -- template not yet parameterized |

## 4. Design Decisions

This section records detection strategy decisions made during Step 1. These decisions are binding for Step 2 implementation.

### AD-WF-INIT-001: Lockfile priority order

**Decision:** Check lockfiles in priority order: pnpm-lock.yaml > yarn.lock > package-lock.json > bun.lockb > bun.lock.

**Rationale:** pnpm is the fastest and most strict; yarn and npm are widespread; bun is the newest. If a project has multiple lockfiles (e.g., after migration), the most modern/explicit one wins.

**Rejected alternative:** Check all lockfiles and return an array of detected managers. Rejected because init generates a single workflow -- it must commit to one command format.

### AD-WF-INIT-002: Detection function signatures

**Decision:** Detection functions are async and take `cwd: string` as their only parameter. They perform stat/readFile internally. No DI or filesystem abstraction.

**Rationale:** Matches the existing `runInit(cwd)` convention. The init module owns its filesystem access. Unit tests use real temp directories, consistent with the existing test suite pattern.

**Rejected alternative:** Inject `fs` interface for pure unit tests. Rejected because it adds complexity without benefit -- temp directories already provide isolation.

### AD-WF-INIT-003: Script step generation for missing scripts

**Decision:** When the detected package manager has no matching scripts (no typecheck, no lint, no test, no test:ci), the corresponding workflow job uses an agent step type with a prompt explaining what scripts to add, rather than a script step with a placeholder echo command.

**Rationale:** An agent step that tells the user "add a typecheck script to package.json" is more actionable than a failing `echo "no typecheck configured"` script step. The agent step runs an LLM call that can help the user set up the missing script.

**Rejected alternative:** Use a `type: human` step that pauses the workflow. Rejected because init should produce a runnable workflow; adding interactive gates to init output violates the "runnable without manual edits" exit criterion.

### AD-WF-INIT-004: buildScriptCommand interface

**Decision:** `buildScriptCommand(pm: PackageManager, scriptName: string): string` returns a ready-to-use command string.

**Rationale:** Encapsulates the `run` vs no-`run` distinction per package manager. pnpm and yarn accept `pnpm <script>` / `yarn <script>` for custom scripts; npm and bun require `npm run <script>` / `bun run <script>`. Isolating this in a pure function makes the template generation code simpler and the contracts easier to test.

### AD-WF-INIT-005: Module structure

**Decision:** New detection logic lives in `src/init/detect.ts`. Template changes to accept detection parameters are made in `src/init/templates.ts`. The `runInit` orchestrator in `src/init/index.ts` calls detection and passes results to templates.

**Rationale:** Separates concerns: detection (stat + readFile), templates (string generation), and orchestration (init flow). Each module has a single responsibility. This matches the existing structure where templates are in their own file.

### AD-WF-INIT-006: Multi-lockfile ambiguity

**Decision:** When multiple lockfiles exist, select the highest-priority one (per AD-WF-INIT-001). Do not warn.

**Rationale:** Multi-lockfile projects are valid (e.g., during migration). The priority order picks the most likely intended manager. A warning would be noise for legitimate use cases and adds complexity without changing behavior.

### AD-WF-INIT-007: skill-lock hash regeneration

**Decision:** When init is re-run on an already-initialized project, the `skill-lock.json` hash is NOT regenerated because `writeFileIfMissing` skips existing files. This means if the skill.yml template content changes between tool versions, the hash in an existing project will be stale.

**Rationale:** Consistent with the existing idempotency contract: init never overwrites user files. A future `doctor` command (wf-doctor) can detect hash mismatches and advise the user.

## 5. File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `docs/phases/v0.4-productization/workflows/wf-init/01-cases-and-tests.md` | Create | This document |
| `src/init/detect.ts` | Create | Stub module for detection functions (red phase -- throws on all exports) |
| `tests/init/detect.test.ts` | Create | Unit tests for detection functions |
| `tests/init/init.test.ts` | Update | Integration tests for tailored init behavior |
