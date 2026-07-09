# wf-error-codes: Implementation Report

**Phase:** v0.4 Productization
**Workflow:** wf-error-codes -- Error taxonomy and stable output
**Date:** 2026-07-09
**Status:** Complete

## Delivered Scope

### 1. Stable exit code taxonomy (10 classes updated)

All 13 `ZigmaFlowError` subclasses now have unique, documented exit codes matching `docs/error-codes.md`:

| Class | Old Code | New Code | Status |
|-------|----------|----------|--------|
| UserInputError | 2 | 2 | Unchanged |
| ConfigError | 4 | 4 | Unchanged |
| FilesystemError | 5 | 5 | Unchanged |
| ValidationError | 3 | 10 | Changed |
| WorkflowError | 3 | 11 | Changed |
| SkillPackError | 3 | 12 | Changed |
| PromptBuildError | 3 | 13 | Changed |
| PermissionError | 1 | 14 | Changed |
| StateError | 1 | 20 | Changed |
| ScriptError | 1 | 21 | Changed |
| CheckError | 1 | 22 | Changed |
| RouterError | 1 | 23 | Changed |
| ArtifactError | 1 | 30 | Changed |

Exit code ranges follow the semantic grouping:
- 2-5: Input and configuration errors
- 10-14: Definition and validation errors
- 20-23: Runtime execution errors
- 30: Output and artifact errors

### 2. Structured error formatting utility (`formatError`)

Implemented `src/utils/error-format.ts` with the `formatError(error: ZigmaFlowError): string` function. Output format:

```
Error [<Kind>]: <message>
  Exit code: <N>
  Run: <runId>           (when present in details)
  Job: <jobId>           (when present in details)
  Step: <stepId>         (when present in details)
  Artifact: <artifactPath>  (when present in details)
  Suggestion: <suggestion>  (when present, always last)
```

Key behaviors:
- Recognized detail keys: `runId`, `jobId`, `stepId`, `artifactPath`
- Unknown keys in `details` are silently omitted
- Fields printed only when present and non-null/undefined
- Consistent field ordering: Run, Job, Step, Artifact, Suggestion (always last)
- Minimal output (2 lines) when no details or suggestion are provided

### 3. CLI integration

Wired `formatError` into `src/cli.ts` catch block (line 355-360):
- `ZigmaFlowError` instances are formatted via `formatError` and printed to stderr
- `process.exitCode` is set to `error.exitCode`
- Non-ZigmaFlowError exceptions are re-thrown (unchanged behavior)

### 4. Exported from utils index

`formatError` is re-exported from `src/utils/index.ts` alongside the error classes.

## Deferred Scope

None. All items from the cases-and-tests document are implemented.

## Technical Debt

- The `formatError` function currently hard-codes the recognized detail keys (`runId`, `jobId`, `stepId`, `artifactPath`). Adding new context fields requires modifying the function. A registry-based approach could be considered if the set of context fields grows.
- Tests that checked hardcoded old exit codes (1 and 3) in three test files had to be updated: `tests/check/executor.test.ts`, `tests/router/executor.test.ts`, `tests/commands/step.test.ts`.

## Risks

- **Breaking change:** Exit codes changed for 10 error classes. Any scripts or CI pipelines that relied on exit codes 1 or 3 for specific error types (e.g., distinguishing ScriptError from RouterError) will break. Mitigation: `docs/error-codes.md` now documents the codes as stable (semver), and all 13 codes are unique.
- No backward compatibility shim is provided. Consumers must update their exit code dependencies.

## Validation Gates

All gates pass:

```
npx tsc --noEmit                               # Passes (0 errors)
npx vitest run tests/utils/errors.test.ts       # 23/23 passed
npx vitest run tests/utils/error-format.test.ts # 10/10 passed
npx vitest run                                  # 84/84 files, 1046/1046 passed (full suite)
```

## Touched Files

| File | Action |
|------|--------|
| `src/utils/errors.ts` | Modified -- updated exit codes for 10 error classes |
| `src/utils/error-format.ts` | Implemented -- `formatError` function |
| `src/utils/index.ts` | Modified -- added `formatError` export |
| `src/cli.ts` | Modified -- wired `formatError` into catch block |
| `tests/check/executor.test.ts` | Modified -- updated expected exit code (1 to 22) |
| `tests/router/executor.test.ts` | Modified -- updated expected exit codes (1 to 23) |
| `tests/commands/step.test.ts` | Modified -- updated expected exit code (3 to 11) |
