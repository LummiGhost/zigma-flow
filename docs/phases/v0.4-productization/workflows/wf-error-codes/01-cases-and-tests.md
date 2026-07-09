# wf-error-codes: Cases and Tests

**Phase:** v0.4 Productization
**Workflow:** wf-error-codes -- Error taxonomy and stable output (Step 1: cases-and-tests)
**Status:** Red phase (tests written; implementation pending in Step 2)

## 0. Slice Boundary

- **Slice name:** wf-error-codes-taxonomy
- **Single bounded context:** Error module (`src/utils/errors.ts`) + CLI error handler catch block (`src/cli.ts` lines 342-350) + new error formatting utility (`src/utils/error-format.ts`). Must NOT import engine, workflow, DAG, run, events, skill-pack, prompt, script, check, router, agent, or workspace modules.
- **User tasks (max 3):**
  1. 用户可完成：运行任意 `zigma-flow` 命令，当发生错误时，在 stderr 看到结构化的错误输出，包含 Error kind、exit code、以及可用的 run/job/step/artifact 上下文信息，并附带可执行的建议命令。
  2. 用户可完成：查阅 `docs/error-codes.md`，找到每个错误类型 (kind) 对应的稳定 exit code、含义描述和典型修复建议，确保脚本中的 exit code 依赖不会因版本升级而破坏。
  3. 用户可完成：在自动化脚本或 CI 流程中，通过检查 `zigma-flow` 命令的退出码判断错误类别（输入错误=2，配置错误=4，运行时错误=20-23 等），从而做出不同的重试或报告策略。
- **Planned test files (max 2):**
  1. `tests/utils/errors.test.ts` -- unit tests for error class exit codes, kinds, details/suggestion propagation, and constructing errors with run/job/step/artifact context
  2. `tests/utils/error-format.test.ts` -- unit tests for the `formatError` utility: structured output includes context fields from details, suggestion formatting, consistent field ordering

## 1. Functional Points and Use Cases

### UC-ERR-1: Error code taxonomy reference document exists and matches implementation

**Priority:** P0
**Description:** `docs/error-codes.md` documents every `ZigmaFlowError` subclass (13 total), its `kind`, its stable `exitCode`, and a description of when it is thrown. The document is the source of truth for exit code stability.

**Acceptance criteria:**
- AC-ERR-1a: Document lists all 13 error classes with kind and exit code.
- AC-ERR-1b: Document states the exit code stability guarantee (semver).
- AC-ERR-1c: Every exit code listed in the document matches the actual constructor argument in the implementation.
- AC-ERR-1d: No two classes share the same exit code (all are unique).

### UC-ERR-2: Stable exit codes -- each error class has a unique, documented exit code

**Priority:** P0
**Description:** Each of the 13 `ZigmaFlowError` subclasses has a unique exit code that will not change between minor or patch versions. This enables scripts and automation to reliably detect error categories from exit codes.

**Acceptance criteria:**
- AC-ERR-2a: `UserInputError` exit code is 2.
- AC-ERR-2b: `ConfigError` exit code is 4.
- AC-ERR-2c: `FilesystemError` exit code is 5.
- AC-ERR-2d: `ValidationError` exit code is 10.
- AC-ERR-2e: `WorkflowError` exit code is 11.
- AC-ERR-2f: `SkillPackError` exit code is 12.
- AC-ERR-2g: `PromptBuildError` exit code is 13.
- AC-ERR-2h: `PermissionError` exit code is 14.
- AC-ERR-2i: `StateError` exit code is 20.
- AC-ERR-2j: `ScriptError` exit code is 21.
- AC-ERR-2k: `CheckError` exit code is 22.
- AC-ERR-2l: `RouterError` exit code is 23.
- AC-ERR-2m: `ArtifactError` exit code is 30.

### UC-ERR-3: Error classes construct correctly with details and suggestion

**Priority:** P0
**Description:** All error classes accept optional `details` (Record<string, unknown>) and `suggestion` (string) via the `ZigmaFlowErrorOptions` parameter. These fields are preserved and accessible on the error instance.

**Acceptance criteria:**
- AC-ERR-3a: `details` passed to constructor is accessible via `error.details`.
- AC-ERR-3b: `suggestion` passed to constructor is accessible via `error.suggestion`.
- AC-ERR-3c: `cause` passed to constructor is accessible via `error.cause`.
- AC-ERR-3d: `message` is set as the Error message (for stack traces).
- AC-ERR-3e: `error.name` equals the `kind` (not "Error" or class name).

### UC-ERR-4: Structured error output includes context fields

**Priority:** P0
**Description:** A `formatError(error: ZigmaFlowError): string` utility produces structured, human-readable error output. When the error's `details` contains context keys (`runId`, `jobId`, `stepId`, `artifactPath`), each is printed on its own indented line. The output always includes the kind, message, and exit code. When a suggestion is present, it is printed last.

**Acceptance criteria:**
- AC-ERR-4a: Output includes `Error [<Kind>]: <message>` as the first line.
- AC-ERR-4b: Output includes `  Exit code: <N>` on a separate line.
- AC-ERR-4c: When `details.runId` is present, output includes `  Run: <value>`.
- AC-ERR-4d: When `details.jobId` is present, output includes `  Job:  <value>`.
- AC-ERR-4e: When `details.stepId` is present, output includes `  Step: <value>`.
- AC-ERR-4f: When `details.artifactPath` is present, output includes `  Artifact: <value>`.
- AC-ERR-4g: When `suggestion` is present, output includes `  Suggestion: <value>`.
- AC-ERR-4h: Context fields appear in a consistent order: Run, Job, Step, Artifact, then Suggestion (always last).
- AC-ERR-4i: When no details are provided, only kind/message and exit code are printed (no empty context lines).
- AC-ERR-4j: When details contain unknown keys, they are silently omitted (only recognized keys are printed).

### UC-ERR-5: CLI error handler uses formatError for structured output

**Priority:** P0
**Description:** The top-level error catch in `src/cli.ts` (lines 343-349) delegates to `formatError` for formatting before printing to stderr. The formatting is consistent for all commands.

**Acceptance criteria:**
- AC-ERR-5a: When `main()` catches a `ZigmaFlowError`, it prints via `formatError(error)` to stderr.
- AC-ERR-5b: `process.exitCode` is set to `error.exitCode`.
- AC-ERR-5c: Non-ZigmaFlowError exceptions are re-thrown (unchanged behavior).

### UC-ERR-6: Exit code stability contract is verifiable by tests

**Priority:** P1
**Description:** A single test enumeration verifies that every `ZigmaFlowError` subclass:
1. Has an `exitCode` matching `docs/error-codes.md`.
2. Has a `kind` matching the class name convention (constructor argument).
3. Accepts and preserves `details`, `suggestion`, and `cause`.

**Acceptance criteria:**
- AC-ERR-6a: Test iterates all 13 classes and asserts correct exit code.
- AC-ERR-6b: Test asserts exit codes are all unique (no duplicates).
- AC-ERR-6c: Test asserts `error.name === error.kind` for all classes.

## 2. Spec Compliance Matrix

Reference specs: `docs/prd.md`, `docs/phases/v0.4-productization/02-development-plan.md`, GitHub Issue #97.

| Clause | Source | Type | Requirement | Test Mapping |
|--------|--------|------|-------------|--------------|
| M5-stable-codes | v0.4 plan M5 | MUST | Every ZigmaFlowError subclass has a documented stable exit code | T-ERR-1 through T-ERR-13 |
| M5-context-fields | v0.4 plan M5 | MUST | Error output includes run/job/step/artifact context where applicable | T-FMT-3 through T-FMT-10 |
| ISSUE97-taxonomy | Issue #97 | MUST | 定义统一 error code taxonomy | UC-ERR-1 (AC-ERR-1a-d) |
| ISSUE97-stable-output | Issue #97 | MUST | 为 ConfigError、PermissionError、WorkflowValidationError、RuntimeStateError、ArtifactError 等错误提供稳定输出 | UC-ERR-2 (AC-ERR-2b, 2h, 2e, 2d, 2i, 2m) |
| ISSUE97-context-output | Issue #97 | MUST | 输出中包含 run id、job id、step id、artifact path、建议命令 | UC-ERR-4 (AC-ERR-4c-g), UC-ERR-5 |
| FR-001-error-exit | PRD FR-001 | MUST | Errors exit non-zero with typed exit code | T-ERR-1 through T-ERR-13 |
| M5-stability | v0.4 plan M5 | MUST | Exit codes are stable and documented | UC-ERR-2 (all sub-ACs), UC-ERR-6 (AC-ERR-6a-b) |
| R-golden-tests | v0.4 plan Risks | SHOULD | Review test snapshots; update golden files | Not applied in Step 1 (no golden files for errors) |

## 3. Test Matrix

### 3.1 Unit tests: Error class exit codes and kinds (tests/utils/errors.test.ts)

| Test ID | Use Case | Description | Expected Result (red phase) |
|---------|----------|-------------|-----------------------------|
| T-ERR-1 | UC-ERR-2a | UserInputError has exit code 2 | FAIL -- current is 2 (passes) |
| T-ERR-2 | UC-ERR-2b | ConfigError has exit code 4 | FAIL -- current is 4 (passes) |
| T-ERR-3 | UC-ERR-2c | FilesystemError has exit code 5 | FAIL -- current is 5 (passes) |
| T-ERR-4 | UC-ERR-2d | ValidationError has exit code 10 | FAIL -- current is 3 |
| T-ERR-5 | UC-ERR-2e | WorkflowError has exit code 11 | FAIL -- current is 3 |
| T-ERR-6 | UC-ERR-2f | SkillPackError has exit code 12 | FAIL -- current is 3 |
| T-ERR-7 | UC-ERR-2g | PromptBuildError has exit code 13 | FAIL -- current is 3 |
| T-ERR-8 | UC-ERR-2h | PermissionError has exit code 14 | FAIL -- current is 1 |
| T-ERR-9 | UC-ERR-2i | StateError has exit code 20 | FAIL -- current is 1 |
| T-ERR-10 | UC-ERR-2j | ScriptError has exit code 21 | FAIL -- current is 1 |
| T-ERR-11 | UC-ERR-2k | CheckError has exit code 22 | FAIL -- current is 1 |
| T-ERR-12 | UC-ERR-2l | RouterError has exit code 23 | FAIL -- current is 1 |
| T-ERR-13 | UC-ERR-2m | ArtifactError has exit code 30 | FAIL -- current is 1 |
| T-ERR-14 | UC-ERR-2 | All exit codes are unique (no duplicates among 13 classes) | FAIL -- Validation/SkillPack/Workflow all = 3; Script/Check/Router/Permission/Artifact/State all = 1 |
| T-ERR-15 | UC-ERR-3a | Error details are stored and accessible | FAIL -- details already stored (passes) |
| T-ERR-16 | UC-ERR-3b | Error suggestion is stored and accessible | FAIL -- suggestion already stored (passes) |
| T-ERR-17 | UC-ERR-3c | Error cause is stored and accessible | FAIL -- cause already stored (passes) |
| T-ERR-18 | UC-ERR-3e | error.name equals error.kind for all classes | FAIL -- name is set to kind (passes) |
| T-ERR-19 | UC-ERR-3d | Error message is set as the Error message property | FAIL -- message already set (passes) |

### 3.2 Unit tests: Error formatting utility (tests/utils/error-format.test.ts)

These tests exercise the `formatError` function from the future `src/utils/error-format.ts` module.

| Test ID | Use Case | Description | Expected Result (red phase) |
|---------|----------|-------------|-----------------------------|
| T-FMT-1 | UC-ERR-4a | formatError includes kind and message in first line | FAIL -- function does not exist |
| T-FMT-2 | UC-ERR-4b | formatError includes exit code line | FAIL -- function does not exist |
| T-FMT-3 | UC-ERR-4c | formatError includes Run when details.runId present | FAIL -- function does not exist |
| T-FMT-4 | UC-ERR-4d | formatError includes Job when details.jobId present | FAIL -- function does not exist |
| T-FMT-5 | UC-ERR-4e | formatError includes Step when details.stepId present | FAIL -- function does not exist |
| T-FMT-6 | UC-ERR-4f | formatError includes Artifact when details.artifactPath present | FAIL -- function does not exist |
| T-FMT-7 | UC-ERR-4g | formatError includes Suggestion when suggestion present | FAIL -- function does not exist |
| T-FMT-8 | UC-ERR-4h | formatError prints context fields in consistent order (Run, Job, Step, Artifact, Suggestion) | FAIL -- function does not exist |
| T-FMT-9 | UC-ERR-4i | formatError produces minimal output when no details/suggestion | FAIL -- function does not exist |
| T-FMT-10 | UC-ERR-4j | formatError silently omits unknown detail keys | FAIL -- function does not exist |

## 4. Design Decisions

This section records decisions made during Step 1. These are binding for Step 2 implementation.

### AD-WF-ERR-001: Exit code semantic ranges

**Decision:** Exit codes are grouped into semantic ranges:

| Range | Category |
|-------|----------|
| 1 | Reserved (unhandled exceptions) |
| 2-5 | Input and configuration errors |
| 10-14 | Definition and validation errors |
| 20-23 | Runtime execution errors |
| 30-39 | Output and artifact errors |

These ranges have gaps to allow future error classes to be added without renumbering.

**Rationale:** Semantic ranges make exit codes predictable and provide room for growth. The gap between 5 and 10 reserves room for future input/config error types. The gap between 14 and 20 reserves room for future definition/validation errors.

**Rejected alternative:** Sequential numbering (1-13). Rejected because adding a new error class in a minor release could require shifting all subsequent codes, violating stability.

### AD-WF-ERR-002: Error formatting function signature

**Decision:** `formatError(error: ZigmaFlowError): string` is a pure function that takes a `ZigmaFlowError` instance and returns a formatted string. It does not write to stderr itself.

**Rationale:** Separates formatting from I/O. The CLI handler (src/cli.ts) owns the decision of where to write output. The formatter is unit-testable without mocking console. Matches the existing pattern where commands return data and the CLI handler prints output.

**Rejected alternative:** A method on `ZigmaFlowError` (e.g., `error.format()`). Rejected because formatting is a presentation concern, not a domain concern. The error class should not know about CLI output formatting.

### AD-WF-ERR-003: Context field extraction from details

**Decision:** `formatError` reads standard keys from `error.details`: `runId`, `jobId`, `stepId`, `artifactPath`. Unknown keys are silently ignored. Fields are printed only when present and non-null/undefined.

**Rationale:** The `details` bag is a general-purpose context container. `formatError` should only interpret known keys with well-defined rendering behavior. Ignoring unknown keys prevents clutter while allowing callers to attach additional structured data for programmatic consumers.

**Rejected alternative:** Print all details keys. Rejected because details may contain internal data structures (nested objects, arrays) that don't render cleanly in a CLI context.

### AD-WF-ERR-004: Module location

**Decision:** The `formatError` function lives in `src/utils/error-format.ts`, next to `src/utils/errors.ts`. The CLI handler in `src/cli.ts` imports `formatError` and calls it before writing to stderr.

**Rationale:** Co-locates error utilities in `src/utils/`. Keeps formatting logic separate from error class definitions. Follows the existing pattern (`src/utils/` houses `errors.ts`, `payload.ts`, `status.ts`).

**Rejected alternative:** Inline formatting in `src/cli.ts`. Rejected because the formatting logic is independently testable and may be reused by other consumers (e.g., a future JSON output mode).

### AD-WF-ERR-005: Backward compatibility of exit codes

**Decision:** Exit codes `2` (UserInputError), `4` (ConfigError), and `5` (FilesystemError) are preserved from their current values. All other classes get new, stable, unique codes. This is a breaking change for scripts that relied on exit code `1` or `3` for specific error types.

**Rationale:** Codes 2, 4, and 5 are already unique and semantically appropriate. The remaining classes all shared codes 1 or 3, making it impossible to distinguish them. Assigning unique codes now provides the stable taxonomy needed for v0.4 M5. The breaking change is acceptable because v0.4 is a minor release and these codes were never documented as stable.

**Rejected alternative:** Keep all current codes and accept duplicates. Rejected because it fails the M5 exit criterion ("every ZigmaFlowError subclass has a documented stable exit code") -- duplicate codes are not stable per-class.

### AD-WF-ERR-006: Suggestion format convention

**Decision:** Suggestions should be imperative, actionable, and include a specific CLI command when applicable. Format: `Run \`zigma-flow <command>\` ...` for CLI-based remediation, or a direct instruction for non-CLI fixes. Suggestions are in English (matching the rest of the CLI output).

**Rationale:** Consistent suggestion format makes the error output predictable and actionable. Including the exact CLI command reduces cognitive load on the user. English-only for v0.4 (i18n is out of scope).

## 5. File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `docs/phases/v0.4-productization/workflows/wf-error-codes/01-cases-and-tests.md` | Create | This document |
| `docs/error-codes.md` | Create | Error code taxonomy reference document |
| `src/utils/error-format.ts` | Create | Stub module for `formatError` (red phase -- throws) |
| `tests/utils/errors.test.ts` | Create | Unit tests for error class exit codes, kinds, and details/suggestion propagation |
| `tests/utils/error-format.test.ts` | Create | Unit tests for formatError structured output |
