# wf-init Implementation Report

**Workflow:** wf-init — Init environment detection and tailored workflow generation
**Phase:** v0.4 Productization
**Status:** Implemented
**Date:** 2026-07-09

## Delivered Scope

### 1. Package manager detection (`detectPackageManager`)

Scans project root for lockfiles in priority order: `pnpm-lock.yaml` > `yarn.lock` > `package-lock.json` > `bun.lockb` > `bun.lock`. Falls back to `"npm"` when no lockfile is present. Implements UC-DETECT-1 and AD-WF-INIT-001.

### 2. Script detection (`detectScripts`)

Reads `package.json` and reports which of `typecheck`, `lint`, `test`, `test:ci`, `build` are present in the `scripts` field. Returns all-false when `package.json` is missing, has no `scripts` field, or contains invalid JSON. Implements UC-DETECT-2.

### 3. Environment detection (`detectEnvironment`)

Combines package manager and script detection into a single `DetectionResult` struct with `hasPackageJson` flag. Implements UC-DETECT-3.

### 4. Script command builder (`buildScriptCommand`)

Returns PM-specific run commands:
- `pnpm <script>` / `yarn <script>` (no `run` prefix)
- `npm run <script>` / `bun run <script>` (with `run` prefix)

Implements AD-WF-INIT-004 and UC-CMD-1/2/3/4.

### 5. Tailored workflow generation (`codeChangeWorkflowYml`)

The template function now accepts an optional `DetectionResult` parameter and generates a `code-change.yml` workflow with:

- **PM-tailored script steps**: static-check and unit-test jobs use the detected package manager's command format (UC-CMD-1 through UC-CMD-4).
- **Partial script handling**: When only `typecheck` or `lint` is available, a single script step is generated. When neither exists, an **agent step** is used with an explanatory prompt (AD-WF-INIT-003, UC-CMD-1d).
- **Test script priority**: Prefers `test:ci` over `test`, falls back to agent step when neither exists (UC-CMD-5).
- **Build job**: Added when `build` script is detected, placed between `implement` and `static-check` in the DAG (UC-CMD-6). `static-check` depends on `build` when present; depends on `implement` otherwise.
- **Backward compatibility**: When no `package.json` exists, the template produces the original hardcoded pnpm commands (UC-CMD-8).

## Deferred Scope

Nothing deferred. All planned detection and template changes are delivered.

## Technical Debt Registered

1. **Double file read**: `detectEnvironment` reads `package.json` separately from `detectScripts`. A future optimization could share the parsed result.
2. **Fast workflow not parameterized**: `codeChangeFastWorkflowYml` continues to use hardcoded pnpm commands. Not covered by tests. If users expect detection-based output for the fast workflow, update in a follow-up.
3. **No `code-change-fast.yml` parameterization**: The fast workflow template was intentionally left unmodified since no tests assert on its detection-dependent behavior.

## Risks

1. **Multi-lockfile ambiguity**: Per AD-WF-INIT-006, when multiple lockfiles exist the highest-priority PM is selected without warning. This is intentional but could confuse users mid-migration.
2. **Invalid `package.json`**: If the file exists but contains invalid JSON, `detectScripts` returns all-false and `detectEnvironment` reports `hasPackageJson=false`. The template falls back to default pnpm commands. This is graceful degradation.
3. **New package managers**: Adding future PMs (e.g., `deno`, `bun v2` format changes) requires updating `detectPackageManager` and `buildScriptCommand`.

## Tests Passed

| Suite | Tests | Status |
|-------|-------|--------|
| `tests/init/detect.test.ts` (unit) | 22 | All passed |
| `tests/init/init.test.ts` (integration) | 50 | All passed |
| Full suite (80 files) | 983 | All passed |

### detect.test.ts test coverage

- **detectPackageManager**: 8 tests (T-DETECT-1..6, 17, 18) — priority, fallback, multi-lockfile
- **detectScripts**: 3 tests (T-DETECT-7, 8, 9) — full scripts, no scripts field, no package.json
- **detectEnvironment**: 3 tests (T-DETECT-10, 11, 12) — combined result, hasPackageJson
- **buildScriptCommand**: 8 tests (T-DETECT-13..16 + extra) — all 4 PMs, colon scripts, exhaustive prefix check

### init.test.ts v0.4 coverage

- T-INIT-15 through T-INIT-18: PM-tailored static-check (pnpm/npm/yarn/bun)
- T-INIT-19, T-INIT-20: Partial script availability (typecheck-only, lint-only)
- T-INIT-21: Agent step when no check scripts exist
- T-INIT-22, T-INIT-23: Test script priority (test:ci > test)
- T-INIT-24: Agent step when no test scripts exist
- T-INIT-25, T-INIT-25b: Build job conditional generation
- T-INIT-26: Bare directory fallback
- T-INIT-27: npm `run` format for test:ci
- T-INIT-28: skill-lock integrity after tailored generation

## Touched Files

| File | Action | Purpose |
|------|--------|---------|
| `src/init/detect.ts` | Modified | Replaced stubs with detection logic (4 functions) |
| `src/init/templates.ts` | Modified | Parameterized `codeChangeWorkflowYml` to accept `DetectionResult` and generate tailored YAML |
| `src/init/index.ts` | Modified | Added `detectEnvironment` call in `runInit` and passes result to `codeChangeWorkflowYml` |
| `docs/phases/v0.4-productization/workflows/wf-init/02-implementation-report.md` | Created | This report |
