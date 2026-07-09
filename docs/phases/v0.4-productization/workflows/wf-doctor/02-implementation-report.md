# wf-doctor: Implementation Report

**Phase:** v0.4 Productization
**Workflow:** wf-doctor -- Doctor command (Step 2: implementation)
**Status:** Complete

## Delivered Scope

All five check functions and the orchestrator specified in the cases-and-tests
document were implemented:

### Check functions (each exported for unit testing)

1. **checkNodeVersion()** -- Reads the tool's own `package.json` to find
   `engines.node` (default `>=20.11.0` when absent) and compares the current
   `process.versions.node` using a pure-JS version comparator. No external
   dependencies. Returns PASS when satisfied, FAIL otherwise.

2. **checkConfigJson(zigmaflowDir)** -- Validates that `config.json` exists,
   is parseable JSON, and contains both `tool_version` (string) and `agent`
   (object) fields. Returns FAIL with specific messages for each failure mode
   (not found, invalid JSON, missing fields).

3. **checkSkillLockJson(zigmaflowDir)** -- Validates that `skill-lock.json`
   exists, is parseable JSON, has a `skills` field, and for each skill entry
   checks whether the resolved path (with `local://` prefix stripping) exists
   on disk. Returns FAIL for structural issues and WARN for individual path
   resolution failures, plus PASS for structural validity.

4. **checkWorkflowYaml(zigmaflowDir)** -- Lists `.yml`/`.yaml` files under
   `workflows/`, parses each with `loadWorkflow()`, and reports per-file
   PASS/FAIL results. Returns WARN when the workflows directory is missing
   or empty.

5. **checkSkillPacks(zigmaflowDir)** -- Reads `skill-lock.json` independently,
   resolves each skill entry's pack root (stripping `local://`), and calls
   `loadSkillPack()` on each. Returns PASS for valid manifests, FAIL for
   parse/validation errors or missing manifests. When `skill-lock.json` is
   unreadable or invalid, returns WARN (not silently omitted).

### Orchestrator

- **doctorAction(opts)** -- Accepts `{ zigmaflowDir, stdout?, stderr? }`.
  Runs all five checks independently (a failure in config.json does not
  prevent workflow YAML checks). When `.zigma-flow/` is missing, skips
  project-specific checks and reports FAIL with a suggestion to run
  `zigma-flow init`.

### CLI registration

- Doctor subcommand registered in `src/cli.ts` as `zigma-flow doctor`.
  Uses `process.exitCode` for exit code propagation.

### Output format

- Line-oriented `[LEVEL] message` format (PASS/FAIL/WARN).
- Summary line: `Summary: N passed, M failed, K warnings`.
- Exit code: 0 = all PASS; 1 = any FAIL or WARN.

## Deferred Scope

- `--json` output flag (not requested in MVP; can be added in future).
- Network/git checks (excluded by AD-WF-DOCTOR-001).
- Performance benchmark (planned for Step 2 per Q-doctor-speed).
- Windows-specific path normalization beyond what `node:path` provides natively.

## Technical Debt Registered

- `checkNodeVersion()` uses synchronous `readFileSync`/`existsSync` because
  the function signature is synchronous (no Promise). If the function were
  made async in the future, it could use `readFile` from `node:fs/promises`
  and avoid the `node:fs` import entirely.
- The `findToolRoot()` logic uses `import.meta.url` relative resolution,
  which assumes the source file stays at `src/commands/doctor.ts`. A future
  bundler change (e.g., moving to `dist/` with flat layout) would break this.
  A `process.cwd()` fallback is not needed currently but could be added.

## Risks

- **Low**: If the tool's `package.json` moves relative to `src/commands/doctor.ts`,
  the `TOOL_ROOT` constant will resolve to the wrong directory. Mitigation:
  the path is only used for `engines.node` lookup; failure falls back to
  `20.11.0` with no crash.
- **Low**: `loadWorkflow()` and `loadSkillPack()` catch and rethrow typed
  errors. The doctor's catch blocks convert all errors to FAIL results -- if
  a future version of those functions throws a new error type, the doctor
  will report it as FAIL rather than crashing, which is acceptable behavior.

## Validation Gates

| Gate | Status |
|------|--------|
| `tsc --noEmit` | PASS |
| `vitest run tests/doctor/` (20 unit tests) | PASS |
| `vitest run tests/commands/doctor.test.ts` (10 integration tests) | PASS |
| `vitest run tests/commands/` (100 tests, no regressions) | PASS |
| `vitest run` (1013 tests, full suite) | PASS |

## Touched Files

| File | Action |
|------|--------|
| `src/commands/doctor.ts` | CREATE -- Doctor command implementation (~380 lines) |
| `src/cli.ts` | EDIT -- Added doctor subcommand import and registration (8 lines) |
