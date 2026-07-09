# wf-doctor: Cases and Tests

**Phase:** v0.4 Productization
**Workflow:** wf-doctor -- Doctor command (Step 1: cases-and-tests)
**Status:** Red phase (tests written; implementation pending in Step 2)

## 0. Slice Boundary

- **Slice name:** wf-doctor-env-config
- **Single bounded context:** Doctor command (`src/commands/doctor.ts`) -- environment diagnostics, config validation, workflow/skill validation. Must NOT import engine, DAG, run, events, workspace, or git modules. May use existing `loadWorkflow` (from `src/workflow/`) and `loadSkillPack` (from `src/skill-pack/`) for validation checks.
- **User tasks (max 3):**
  1. 用户可完成：在健康的已初始化项目中运行 `zigma-flow doctor`，所有检查通过 (exit 0)。
  2. 用户可完成：在损坏的项目中运行 `zigma-flow doctor`，看到可操作的诊断报告，明确指出每个问题的具体文件和修复建议 (exit 1)。
  3. 用户可完成：在未初始化的目录中运行 `zigma-flow doctor`，得到提示信息建议先运行 `zigma-flow init` (exit 1)。
- **Planned test files (max 2):**
  1. `tests/doctor/doctor.test.ts` -- unit tests for individual doctor check functions (Node version, config. json, skill-lock.json, workflow YAML, skill pack manifest)
  2. `tests/commands/doctor.test.ts` -- integration tests for the `doctorAction` function (full healthy project, broken project scenarios, missing .zigma-flow/ directory)

## 1. Functional Points and Use Cases

### UC-DOCTOR-1: Full healthy project passes all checks

**Priority:** P0
**Description:** 用户可完成：在健康的已初始化项目中运行 `zigma-flow doctor`，所有检查通过 (exit 0)。A healthy project is one where `.zigma-flow/` directory exists with valid `config.json`, valid `skill-lock.json`, parseable workflow YAML files, and loadable skill pack manifests.

**Acceptance criteria:**
- AC-DOCTOR-1a: `doctorAction` returns exit code 0 when all checks pass.
- AC-DOCTOR-1b: Output includes `[PASS]` for each check category (node version, config, lockfile, workflows, skill packs).
- AC-DOCTOR-1c: Summary line reports `N passed, 0 failed, 0 warnings` where N is the number of checks.
- AC-DOCTOR-1d: No stderr output on a healthy project.

### UC-DOCTOR-2: Missing .zigma-flow/ directory

**Priority:** P0
**Description:** 用户可完成：在未初始化的目录中运行 `zigma-flow doctor`，得到提示信息建议先运行 `zigma-flow init`。

**Acceptance criteria:**
- AC-DOCTOR-2a: When `.zigma-flow/` directory does not exist, doctor reports `[FAIL]` for the project check.
- AC-DOCTOR-2b: The failure message includes the suggestion to run `zigma-flow init`.
- AC-DOCTOR-2c: Exit code is 1.

### UC-DOCTOR-3: Invalid config.json

**Priority:** P0
**Description:** When `config.json` exists but is malformed (invalid JSON or missing required fields), the doctor reports the specific issue.

**Acceptance criteria:**
- AC-DOCTOR-3a: When `config.json` contains invalid JSON, doctor reports `[FAIL]` with "invalid JSON" in the message.
- AC-DOCTOR-3b: When `config.json` is missing `tool_version` field, doctor reports `[FAIL]`.
- AC-DOCTOR-3c: When `config.json` is missing `agent` field, doctor reports `[FAIL]`.
- AC-DOCTOR-3d: Damaged `config.json` does not prevent remaining checks from executing (each check is independent).

### UC-DOCTOR-4: Invalid skill-lock.json

**Priority:** P0
**Description:** When `skill-lock.json` is missing, malformed, or references non-existent skill packs, the doctor reports the issue.

**Acceptance criteria:**
- AC-DOCTOR-4a: When `skill-lock.json` is missing, doctor reports `[FAIL]`.
- AC-DOCTOR-4b: When `skill-lock.json` contains invalid JSON, doctor reports `[FAIL]` with the parse error.
- AC-DOCTOR-4c: When `skill-lock.json` is missing the `skills` field, doctor reports `[FAIL]`.
- AC-DOCTOR-4d: When `skill-lock.json` references a skill path that does not exist on disk, doctor reports `[WARN]` (the lock entry is present but the resolved path is broken).

### UC-DOCTOR-5: Workflow YAML file validation

**Priority:** P0
**Description:** All `.yml` and `.yaml` files under `.zigma-flow/workflows/` must be parseable as valid workflow definitions. The doctor reports per-file results.

**Acceptance criteria:**
- AC-DOCTOR-5a: When a workflow YAML file is syntactically valid, doctor reports `[PASS]` for that file.
- AC-DOCTOR-5b: When a workflow YAML file has a YAML syntax error, doctor reports `[FAIL]` with the file path and parse error.
- AC-DOCTOR-5c: When a workflow YAML file parses but fails `loadWorkflow()` validation (e.g., missing required fields), doctor reports `[FAIL]` with the specific validation error.
- AC-DOCTOR-5d: When the `workflows/` directory is empty, doctor reports `[WARN]` (no workflows to validate).
- AC-DOCTOR-5e: When the `workflows/` directory does not exist, doctor reports `[WARN]`.

### UC-DOCTOR-6: Skill pack manifest validation

**Priority:** P1
**Description:** Each skill pack referenced in `skill-lock.json` should have a loadable `skill.yml` manifest. The doctor verifies each resolved skill path.

**Acceptance criteria:**
- AC-DOCTOR-6a: When a skill pack manifest parses and validates successfully via `loadSkillPack()`, doctor reports `[PASS]` for that pack.
- AC-DOCTOR-6b: When a skill pack manifest has a YAML parse error, doctor reports `[FAIL]`.
- AC-DOCTOR-6c: When a skill pack manifest passes YAML parse but fails schema validation (e.g., missing `kind: skill-pack`), doctor reports `[FAIL]` with the validation error.
- AC-DOCTOR-6d: When a skill pack directory exists but has no `skill.yml`, doctor reports `[FAIL]`.

### UC-DOCTOR-7: Node.js version check

**Priority:** P0
**Description:** The doctor verifies the current Node.js version satisfies the `engines.node` requirement from the project's `package.json` (>=20.11.0).

**Acceptance criteria:**
- AC-DOCTOR-7a: When running Node >=20.11.0, doctor reports `[PASS]` with the detected version.
- AC-DOCTOR-7b: When running Node <20.11.0, doctor reports `[FAIL]` with the detected version and the required minimum.
- AC-DOCTOR-7c: The check is always executed regardless of project initialization status.

### UC-DOCTOR-8: Check independence

**Priority:** P1
**Description:** Each doctor check runs independently. A failure in one check does not prevent subsequent checks from executing.

**Acceptance criteria:**
- AC-DOCTOR-8a: When `config.json` is invalid, workflow YAML checks still execute.
- AC-DOCTOR-8b: When `skill-lock.json` is missing, skill pack manifest checks report their own results (skipped with WARN, not silently omitted).
- AC-DOCTOR-8c: The summary counts all executed checks, not just those that passed.

### UC-DOCTOR-9: Exit code reflects health

**Priority:** P0
**Description:** The doctor exit code summarizes the overall health: 0 when all checks pass, 1 when any FAIL is present, 2 when a critical precondition fails (e.g., EACCES preventing file reads).

**Acceptance criteria:**
- AC-DOCTOR-9a: Exit code 0 when every check is `PASS`.
- AC-DOCTOR-9b: Exit code 1 when at least one `FAIL` is present (even if other checks pass).
- AC-DOCTOR-9c: Exit code 1 when only `WARN` results are present (no FAIL but also not fully clean).

## 2. Spec Compliance Matrix

Reference specs: `docs/prd.md` FR-001, `docs/phases/v0.4-productization/02-development-plan.md`.

| Clause | Source | Type | Requirement | Test Mapping |
|--------|--------|------|-------------|--------------|
| M2-doctor-exists | v0.4 plan M2 | MUST | `zigma-flow doctor` command exists | T-DOC-INT-1 (CLI integration) |
| M2-healthy-passes | v0.4 plan M2 | MUST | Doctor passes in a healthy project | T-DOC-1 (unit), T-DOC-INT-3 (integration) |
| M2-actionable-errors | v0.4 plan M2 | MUST | Common failure modes produce actionable output | T-DOC-2 through T-DOC-9 (unit), T-DOC-INT-4 through T-DOC-INT-9 (integration) |
| M2-exit-health | v0.4 plan M2 | MUST | Exit code reflects health | T-DOC-1 (exit 0), T-DOC-INT-3 (exit 0), T-DOC-INT-4 through T-DOC-INT-9 (exit 1) |
| Q-doctor-speed | v0.4 plan Quality | SHOULD | Doctor must complete in under 2 seconds | Not tested in Step 1 (performance test in Step 2) |
| Q-no-network | v0.4 plan Risks | SHOULD | No network calls (fast, offline-safe) | Implicit (no imports that would trigger network) |
| R-check-scope | v0.4 plan Open Decisions | DECIDED | Standard scope: env + config + workflows + skills | UC-DOCTOR-1 through UC-DOCTOR-8 |

Note: The v0.4 development plan does not use RFC 2119 keywords. The "MUST"/"SHOULD" mapping above is derived from the plan's acceptance criteria and quality bar statements. Where the plan says "must pass" or "must complete", these are interpreted as hard requirements.

## 3. Test Matrix

### 3.1 Unit tests: doctor check functions (tests/doctor/doctor.test.ts)

These tests exercise individual check functions exportable from the future `src/commands/doctor.ts` module. Each check is expected to return a `CheckResult` with `{ level, message }`.

Expected check function signatures (subject to change in Step 2):

```typescript
type CheckLevel = "PASS" | "FAIL" | "WARN";
interface CheckResult { level: CheckLevel; message: string; }

checkNodeVersion(): CheckResult;
checkConfigJson(zigmaflowDir: string): Promise<CheckResult>;
checkSkillLockJson(zigmaflowDir: string): Promise<CheckResult[]>;
checkWorkflowYaml(zigmaflowDir: string): Promise<CheckResult[]>;
checkSkillPacks(zigmaflowDir: string): Promise<CheckResult[]>;
```

| Test ID | Use Case | Description | Expected Result (red phase) |
|---------|----------|-------------|---------------------------|
| T-DOC-1 | UC-DOCTOR-7 | checkNodeVersion returns PASS for valid Node version | FAIL -- function does not exist |
| T-DOC-2 | UC-DOCTOR-7 | checkNodeVersion detects unsupported Node version (too low) | FAIL -- function does not exist |
| T-DOC-3 | UC-DOCTOR-7 | checkNodeVersion detects patched versions matching engine range | FAIL -- function does not exist |
| T-DOC-4 | UC-DOCTOR-3 | checkConfigJson returns PASS for valid config.json | FAIL -- function does not exist |
| T-DOC-5 | UC-DOCTOR-3 | checkConfigJson returns FAIL when config.json does not exist | FAIL -- function does not exist |
| T-DOC-6 | UC-DOCTOR-3 | checkConfigJson returns FAIL for invalid JSON in config.json | FAIL -- function does not exist |
| T-DOC-7 | UC-DOCTOR-3 | checkConfigJson returns FAIL for missing required fields | FAIL -- function does not exist |
| T-DOC-8 | UC-DOCTOR-4 | checkSkillLockJson returns PASS for valid skill-lock.json | FAIL -- function does not exist |
| T-DOC-9 | UC-DOCTOR-4 | checkSkillLockJson returns FAIL when skill-lock.json is missing | FAIL -- function does not exist |
| T-DOC-10 | UC-DOCTOR-4 | checkSkillLockJson returns FAIL for invalid JSON in skill-lock.json | FAIL -- function does not exist |
| T-DOC-11 | UC-DOCTOR-4 | checkSkillLockJson returns FAIL when `skills` field is missing | FAIL -- function does not exist |
| T-DOC-12 | UC-DOCTOR-4 | checkSkillLockJson returns WARN when resolved skill path does not exist | FAIL -- function does not exist |
| T-DOC-13 | UC-DOCTOR-5 | checkWorkflowYaml returns PASS for valid YAML | FAIL -- function does not exist |
| T-DOC-14 | UC-DOCTOR-5 | checkWorkflowYaml returns FAIL for YAML syntax error | FAIL -- function does not exist |
| T-DOC-15 | UC-DOCTOR-5 | checkWorkflowYaml returns FAIL for workflow validation error | FAIL -- function does not exist |
| T-DOC-16 | UC-DOCTOR-5 | checkWorkflowYaml returns WARN when workflows dir is empty | FAIL -- function does not exist |
| T-DOC-17 | UC-DOCTOR-5 | checkWorkflowYaml returns WARN when workflows dir is missing | FAIL -- function does not exist |
| T-DOC-18 | UC-DOCTOR-6 | checkSkillPacks returns PASS for valid skill pack | FAIL -- function does not exist |
| T-DOC-19 | UC-DOCTOR-6 | checkSkillPacks returns FAIL for invalid skill pack YAML | FAIL -- function does not exist |
| T-DOC-20 | UC-DOCTOR-6 | checkSkillPacks returns FAIL when skill.yml is missing | FAIL -- function does not exist |

### 3.2 Integration tests: doctorAction (tests/commands/doctor.test.ts)

These tests exercise the `doctorAction` orchestrator, which calls all check functions, formats output, and returns an exit code.

| Test ID | Use Case | Description | Expected Result (red phase) |
|---------|----------|-------------|---------------------------|
| T-DOC-INT-1 | UC-DOCTOR-1/UC-DOCTOR-2 | doctorAction rejects missing .zigma-flow/ directory (exit 1) | FAIL -- module does not exist |
| T-DOC-INT-2 | UC-DOCTOR-1/UC-DOCTOR-2 | doctorAction missing .zigma-flow message suggests running init | FAIL -- module does not exist |
| T-DOC-INT-3 | UC-DOCTOR-1 | doctorAction returns exit 0 in healthy initialized project | FAIL -- module does not exist |
| T-DOC-INT-4 | UC-DOCTOR-3 | doctorAction returns exit 1 with broken config.json (invalid JSON) | FAIL -- module does not exist |
| T-DOC-INT-5 | UC-DOCTOR-4 | doctorAction returns exit 1 with broken skill-lock.json | FAIL -- module does not exist |
| T-DOC-INT-6 | UC-DOCTOR-5 | doctorAction returns exit 1 with broken workflow YAML | FAIL -- module does not exist |
| T-DOC-INT-7 | UC-DOCTOR-6 | doctorAction returns exit 1 with broken skill pack manifest | FAIL -- module does not exist |
| T-DOC-INT-8 | UC-DOCTOR-8 | doctorAction reports independent check results (config failure doesn't block workflow check) | FAIL -- module does not exist |
| T-DOC-INT-9 | UC-DOCTOR-9 | doctorAction exit code 1 when any FAIL is present | FAIL -- module does not exist |
| T-DOC-INT-10 | UC-DOCTOR-9 | doctorAction exit code reflects WARN-only scenario (exit 1) | FAIL -- module does not exist |

## 4. Design Decisions

This section records decisions made during Step 1. These are binding for Step 2 implementation.

### AD-WF-DOCTOR-001: Doctor check scope

**Decision:** Standard scope: Node version + .zigma-flow/ directory check + config.json validity + skill-lock.json validity + workflow YAML parse + skill pack load. No git or network checks.

**Rationale:** Matches the v0.4 development plan's "Standard" option for doctor check scope. All checks are local, fast (file reads and JSON/YAML parse), and actionable. Network checks add latency and false positives for offline users.

**Rejected alternative:** Comprehensive scope (git state + network connectivity). Rejected as out of scope for v0.4 M2; can be added in a future phase.

### AD-WF-DOCTOR-002: Check independence

**Decision:** Each check runs independently. Failures in early checks do not short-circuit later checks.

**Rationale:** A broken `config.json` should not prevent the user from learning that their workflow YAML also has problems. Independent checks maximize the information returned in a single `doctor` run.

**Rejected alternative:** Short-circuit on first failure. Rejected because fixing all issues in one iteration is more efficient than fix-run-fix-run cycles.

### AD-WF-DOCTOR-003: Output format

**Decision:** Line-oriented `[LEVEL] message` format, same as `verify-run`. Summary line at bottom: `Summary: N passed, M failed, K warnings`. Exit code 0 when all PASS; exit code 1 when any FAIL or WARN is present.

**Rationale:** Consistent with existing `verify-run` command output format. Line-oriented output is grep-friendly and testable. WARN counts as non-zero exit so that warnings (e.g., empty workflows directory) are not silently ignored.

**Rejected alternative:** JSON output. Rejected because the primary use case is human readability; JSON output can be added as a flag (`--json`) in a future enhancement.

### AD-WF-DOCTOR-004: Module location and exports

**Decision:** The doctor command lives in `src/commands/doctor.ts`. It exports a `doctorAction` function (async, returns exit code) and individual check functions (for unit testing). The CLI registration in `src/cli.ts` adds a `doctor` subcommand.

**Rationale:** Matches the existing command pattern (`src/commands/verify-run.ts` exports `verifyRunAction`). Individual check functions are exported (not internal) to enable unit testing without going through the full CLI stack.

**Rejected alternative:** Private check functions with only integration tests. Rejected because unit tests are faster and provide more precise failure attribution.

### AD-WF-DOCTOR-005: Node version check source

**Decision:** The doctor reads the `engines.node` field from the nearest `package.json` (the tool's own package.json, not the user project's). If `engines.node` is absent or unparseable, the minimum is hardcoded to `20.11.0`.

**Rationale:** The tool's own engine requirement is what matters for correct operation. The user project may have a different Node requirement, but the doctor's concern is whether Zigma Flow itself can run. The hardcoded fallback prevents a missing `engines` field from producing a false PASS.

**Rejected alternative:** Check the user project's `engines.node`. Rejected because the user project may have looser or absent engine requirements, and Zigma Flow's own compatibility is what the doctor should verify.

### AD-WF-DOCTOR-006: skill-lock.json path resolution

**Decision:** For each entry in `skill-lock.json`'s `skills` map, the `resolved` field is interpreted relative to `.zigma-flow/`. If the resolved path starts with `local://`, the prefix is stripped. The resulting path is joined with `.zigma-flow/` to locate the skill directory.

**Rationale:** Matches the existing `skill-lock.json` format generated by `init` (see `src/init/templates.ts` `skillLockJsonTemplate`). The `local://` prefix distinguishes local skills from future remote skill registries.

## 5. File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `docs/phases/v0.4-productization/workflows/wf-doctor/01-cases-and-tests.md` | Create | This document |
| `tests/doctor/doctor.test.ts` | Create | Unit tests for individual doctor check functions (red phase -- all fail) |
| `tests/commands/doctor.test.ts` | Create | Integration tests for doctorAction orchestrator (red phase -- all fail) |
