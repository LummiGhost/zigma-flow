# WF-P1-INIT — Cases and Tests

- Workflow: WF-P1-INIT
- Phase: P1 CLI 骨架与初始化
- Step: 1 (Cases and Tests)
- Date: 2026-06-06
- Author: subagent (workflow lead)

## Slice Boundary

- Slice name: WF-P1-INIT
- Bounded context: Init / CLI Entry
- User tasks covered (3 / max 3):
  1. 用户可完成运行 `zigma-flow --help` 获得可用命令列表
  2. 用户可完成运行 `zigma-flow init` 初始化 `.zigma-flow/` 目录结构和内置模板
  3. 用户可完成重复运行 `zigma-flow init` 不破坏已有文件（幂等保护）
- Planned test files (2 / max 2):
  - `tests/cli/cli.test.ts` — CLI entry smoke tests
  - `tests/init/init.test.ts` — init filesystem helpers and integration

Slice within the 3-user-task and 2-test-file limits. No carve-out needed.

## Workflow Goal

Deliver an end-to-end runnable `zigma-flow` CLI skeleton that:

- Exposes `--help` and `--version` via commander.
- Maps known error categories to non-zero exit codes per `docs/mvp-contracts.md` §7.
- Implements `zigma-flow init`, which produces the `.zigma-flow/` directory layout described in `docs/prd.md` FR-001 / §16 — including built-in `code-change` workflow and Skill Pack templates.
- Re-running `init` is idempotent: existing files are left untouched and the command reports per-path `created` vs. `skipped` results without losing exit code 0 (no overwrites = success).

## Acceptance Criteria

1. **M1 CLI Entry**
   - `zigma-flow --help` prints a non-empty usage block listing at minimum `init` as a subcommand.
   - `zigma-flow --version` prints exactly the version string from `package.json`.
   - An unknown command (e.g. `zigma-flow no-such-command`) results in process exit code != 0.
   - Errors thrown by command handlers are mapped to exit codes per mvp-contracts §7 (`UserInputError`, `ValidationError`, `ConfigError`, `FilesystemError` → non-zero; success → 0).
2. **M2 Init Execution**
   - Running `zigma-flow init` in an empty directory creates the directory tree from PRD §16 (`workflows/`, `skills/code-change/{knowledge,prompts,scripts,checks}/`, `runs/`) plus `config.json` and `skill-lock.json`.
   - `config.json` includes the tool version (matching `package.json`) and an `active_run` placeholder field (PRD §17 active run tracking).
   - `skill-lock.json` includes a `zigma.code-change` entry with `path` (local), `version`, and a content `hash` of the skill manifest.
   - All template files listed in PRD FR-001 are present and non-empty.
   - The built-in `code-change.yml` references `skills`, `signals`, and at least one job containing `agent`, `script`, and `router` steps (per PRD §12).
   - The built-in `skill.yml` declares `knowledge`, `prompts`, `scripts`, `checks`, `functions`, and `policies` exports (per PRD §11).
   - Both prompt templates (`prompts/implement.md`, `prompts/review.md`) contain an output-report schema reference and a literal instruction "stop after completing".
3. **M3 Init Idempotency**
   - Re-running `zigma-flow init` over an already-initialized directory:
     - Does not overwrite any file modified by the user.
     - Returns exit code 0.
     - Reports each path as either `created` (first run) or `skipped` (subsequent run).
   - If `.zigma-flow/config.json` already exists, the command prints an "already initialized" hint (referencing the existing config).
   - All path operations use `node:path.join` / `node:path.normalize`; Windows back-slash and POSIX forward-slash paths normalize equivalently.

## Spec Compliance Matrix

Not applicable. There is no upper-design spec with explicit MUST/SHALL clauses beyond PRD (FR-001, §11, §12, §16, §17, §19) and `docs/mvp-contracts.md` §4 (DoD), §5 (module deps), §7 (errors). These are implementation-level requirements rather than a higher-level spec, and they are tracked directly in the Functional Points / Use Cases / Test Mapping below.

## Functional Points

| FP id    | Area                              | Source                       | Summary                                                                  |
| -------- | --------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| FP-CLI-1 | Commander root command            | PRD §17, §19; arch §5.1      | CLI built on commander; preserves exported `main(argv)`                  |
| FP-CLI-2 | `--help` output                   | PRD §17                      | Help text lists `init` (and reserves names for later commands)           |
| FP-CLI-3 | `--version` output                | PRD §17; mvp-contracts §4    | Prints version identical to `package.json`                               |
| FP-CLI-4 | Unknown command handling          | PRD §17                      | Unknown command → non-zero exit code + helpful message                   |
| FP-CLI-5 | Error → exit-code mapping         | mvp-contracts §7             | `UserInputError`, `ValidationError`, `ConfigError`, `FilesystemError` map to documented exit codes |
| FP-FS-1  | `createDirectories` helper        | plan §Technical Approach     | Recursive directory creation, idempotent (no error on existing)          |
| FP-FS-2  | `writeFileIfMissing` helper       | plan §Technical Approach     | Writes when missing; returns `{status:"skipped"}` when existing          |
| FP-FS-3  | Cross-platform path normalization | mvp-contracts §4 Portability | Use `node:path` join/normalize; mixed `\` and `/` inputs equivalent      |
| FP-TPL-1 | `config.json` template            | PRD FR-001, §17              | Contains `tool_version` and `active_run` placeholder                     |
| FP-TPL-2 | `skill-lock.json` template        | PRD FR-001, §16              | Contains `zigma.code-change` entry with `path`, `version`, `hash`        |
| FP-TPL-3 | `code-change.yml` workflow        | PRD §12                      | Declares `skills`, `signals`, jobs containing agent / script / router    |
| FP-TPL-4 | `skill.yml` skill pack            | PRD §11                      | Declares knowledge, prompts, scripts, checks, functions, policies        |
| FP-TPL-5 | `knowledge/coding-guidelines.md`  | PRD §11                      | Referenced by skill manifest `knowledge` export                          |
| FP-TPL-6 | Prompt templates                  | PRD §11; arch §9.3           | `implement.md`, `review.md` contain report schema + "stop after completing" |
| FP-TPL-7 | `scripts/collect-diff.ts`         | PRD §11, §12                 | Placeholder script referenced by skill pack scripts export               |
| FP-TPL-8 | `checks/report-schema.json`       | PRD §11; arch §9.3           | JSON Schema for the Agent report                                         |
| FP-TPL-9 | `checks/forbidden-paths.yml`      | PRD §11, §12                 | Path-policy file referenced by `forbidden-paths` check                   |
| FP-CMD-1 | `init` on empty dir               | PRD FR-001                   | Produces full layout, exit code 0, summary lists `created` per path      |
| FP-CMD-2 | Idempotent re-`init`              | PRD FR-001                   | Existing files not overwritten; summary lists `skipped` per path         |
| FP-CMD-3 | "Already initialized" hint        | PRD FR-001                   | Existing `.zigma-flow/config.json` triggers user-facing notice           |
| FP-CMD-4 | Path safety on Windows / POSIX    | mvp-contracts §4 Portability | All paths derived through `node:path` — no manual string concat          |

## Use Cases

| UC id    | Actor | Trigger                                                            | Pre-conditions                              | Steps (happy path)                                                                                                 | Post-conditions / observable result                                                                  |
| -------- | ----- | ------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| UC-CLI-1 | User  | `zigma-flow --help`                                                | CLI binary installed                        | 1. Process invoked. 2. Commander prints usage including `init`.                                                    | Exit code 0. stdout contains `Usage` and `init`.                                                     |
| UC-CLI-2 | User  | `zigma-flow --version`                                             | Same                                        | 1. Process invoked. 2. Commander prints version.                                                                   | Exit code 0. stdout equals `getPackageInfo().version`.                                               |
| UC-CLI-3 | User  | `zigma-flow no-such-command`                                       | Same                                        | 1. Process invoked. 2. Commander errors on unknown command.                                                        | Exit code != 0. stderr explains the unknown command.                                                 |
| UC-CLI-4 | User  | Command handler throws `UserInputError` / `ConfigError` / `FilesystemError` | Handler registered                          | 1. Handler throws typed error. 2. CLI maps to exit code per mvp-contracts §7.                                      | `process.exitCode != 0`; stderr includes `kind` and `suggestion`.                                    |
| UC-FS-1  | Init  | Programmatic call `createDirectories([a, a/b])` on empty temp dir | Temp dir exists                             | 1. Helper creates `a` then `a/b` recursively. 2. Second call with same paths is a no-op.                           | Both directories exist; second call returns without error.                                           |
| UC-FS-2  | Init  | `writeFileIfMissing(path, contents)`                               | Temp dir exists                             | 1. Called when file missing → writes, returns `{status:"created"}`. 2. Called again → returns `{status:"skipped"}` and content unchanged. | First call writes file; second call leaves file bytes unchanged.                                     |
| UC-CMD-1 | User  | `zigma-flow init` in empty cwd                                     | Empty cwd                                   | 1. Init creates `.zigma-flow/` layout. 2. Writes `config.json`, `skill-lock.json`, all templates. 3. Prints summary. | All paths from PRD FR-001 exist. `config.json` parses as JSON and contains `tool_version`. `skill-lock.json` contains `zigma.code-change` entry with `path`, `version`, `hash`. Exit code 0. |
| UC-CMD-2 | User  | `zigma-flow init` re-run                                           | `.zigma-flow/` already populated by previous run | 1. Init walks template list. 2. Each file is detected as existing and skipped. 3. Summary lists every entry as `skipped`. | No file bytes changed (mtime-tolerant content check). Summary contains `skipped` for each managed path. Exit code 0. |
| UC-CMD-3 | User  | `zigma-flow init` when `.zigma-flow/config.json` exists            | `config.json` already present               | 1. Init detects existing config. 2. Prints "already initialized" hint referencing the file.                        | stdout contains `already initialized` (case-insensitive). Exit code 0.                               |
| UC-CMD-4 | User  | `init` on Windows where mixed `\` and `/` paths are supplied       | Worktree path may contain `\`               | 1. Init normalizes paths via `node:path`. 2. Same resolved file regardless of separator.                           | `path.resolve(base, "skills/code-change")` and `path.resolve(base, "skills\\code-change")` resolve to the same absolute path. |

## Test Mapping

| Test id  | File                       | Test name                                                          | UCs covered            | FPs covered                                          |
| -------- | -------------------------- | ------------------------------------------------------------------ | ---------------------- | ---------------------------------------------------- |
| T-CLI-1  | `tests/cli/cli.test.ts`    | `prints help with init command listed`                             | UC-CLI-1               | FP-CLI-1, FP-CLI-2                                   |
| T-CLI-2  | `tests/cli/cli.test.ts`    | `prints version matching package info`                             | UC-CLI-2               | FP-CLI-3                                             |
| T-CLI-3  | `tests/cli/cli.test.ts`    | `exits non-zero on unknown command`                                | UC-CLI-3               | FP-CLI-4                                             |
| T-CLI-4  | `tests/cli/cli.test.ts`    | `maps typed errors to non-zero exit code`                          | UC-CLI-4               | FP-CLI-5                                             |
| T-CLI-5  | `tests/cli/cli.test.ts`    | `init command creates .zigma-flow under chosen cwd`                | UC-CMD-1               | FP-CMD-1, FP-FS-1, FP-FS-2                           |
| T-INIT-1 | `tests/init/init.test.ts`  | `createDirectories creates nested paths and is idempotent`         | UC-FS-1                | FP-FS-1                                              |
| T-INIT-2 | `tests/init/init.test.ts`  | `writeFileIfMissing creates new file then skips when present`      | UC-FS-2                | FP-FS-2                                              |
| T-INIT-3 | `tests/init/init.test.ts`  | `runInit produces full .zigma-flow layout in empty dir`            | UC-CMD-1               | FP-CMD-1, FP-TPL-1..9                                |
| T-INIT-4 | `tests/init/init.test.ts`  | `runInit is idempotent and reports skipped on re-run`              | UC-CMD-2               | FP-CMD-2                                             |
| T-INIT-5 | `tests/init/init.test.ts`  | `runInit emits already-initialized hint when config.json exists`   | UC-CMD-3               | FP-CMD-3                                             |
| T-INIT-6 | `tests/init/init.test.ts`  | `paths normalize the same across separators`                       | UC-CMD-4               | FP-FS-3, FP-CMD-4                                    |
| T-INIT-7 | `tests/init/init.test.ts`  | `config.json contains tool_version and active_run placeholder`     | UC-CMD-1               | FP-TPL-1                                             |
| T-INIT-8 | `tests/init/init.test.ts`  | `skill-lock.json records zigma.code-change with path, version, hash` | UC-CMD-1             | FP-TPL-2                                             |
| T-INIT-9 | `tests/init/init.test.ts`  | `code-change.yml contains skills, signals, agent/script/router job` | UC-CMD-1              | FP-TPL-3                                             |
| T-INIT-10| `tests/init/init.test.ts`  | `skill.yml declares knowledge, prompts, scripts, checks, functions, policies` | UC-CMD-1     | FP-TPL-4                                             |
| T-INIT-11| `tests/init/init.test.ts`  | `prompt templates include report schema and stop instruction`      | UC-CMD-1               | FP-TPL-6                                             |
| T-INIT-12| `tests/init/init.test.ts`  | `auxiliary template files exist (knowledge, script, checks)`       | UC-CMD-1               | FP-TPL-5, FP-TPL-7, FP-TPL-8, FP-TPL-9               |

## Test Gaps

- **End-to-end shelling out to the compiled binary** is *not* covered. Per task brief, tests use the `main(argv)` import path rather than subprocess execution (no `execa` available). This is intentional and aligned with the plan's testing strategy; the existing smoke test `tests/smoke/packageInfo.test.ts` continues to assert the published package metadata.
- **Filesystem permission failures** (`FilesystemError` raised by EACCES on write) are not exercised; the Windows CI environment cannot reliably simulate permission denial without elevation. Documented as residual risk; manual checks in M2/M3 will rely on cross-platform CI.
- **Hash stability across line endings**: `skill-lock.json` `hash` is asserted as a non-empty hex string of expected length, not for a specific value, because template content may be normalized for CRLF vs LF on Windows. Step-2 implementation must use a canonical encoding when hashing.
- **Active-run rotation** (writing the real `active_run` after `zigma-flow run`) is out of scope for P1 — Step 2 only sets the field as `null` placeholder; full coverage moves to P3.
- **Error-kind exhaustiveness** for §7 mapping: only `UserInputError`, `ValidationError`, `ConfigError`, and `FilesystemError` are tested (the four error kinds plausibly reachable in P1). Other kinds (`WorkflowError`, `StateError`, `ScriptError`, `CheckError`, `PermissionError`, `ArtifactError`, `SkillPackError`) are deferred until the modules that raise them are implemented (P2+).
