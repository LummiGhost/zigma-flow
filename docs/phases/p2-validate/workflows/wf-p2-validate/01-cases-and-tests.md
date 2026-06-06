# WF-P2-VALIDATE — Cases and Tests

- Workflow: WF-P2-VALIDATE
- Phase: P2 Validate (workflow + skill-pack manifest validation)
- Step: 1 (Cases and Tests)
- Date: 2026-06-07
- Author: subagent (workflow lead)

## Slice Boundary

- Slice name: WF-P2-VALIDATE
- Bounded context: Workflow loader / Skill Pack loader / `validate` CLI command
- User tasks covered (3 / max 3):
  1. 用户可完成运行 `zigma-flow validate <workflow.yml>` 校验 workflow YAML，看到字段级错误或成功
  2. 用户可完成运行 `zigma-flow validate <skill.yml>` 校验 Skill Pack manifest，包括 pack 内路径约束
  3. 用户可完成对 `skill-lock.json` 中 `local://` 引用的 Skill Pack 进行解析（CLI 后续命令依赖）
- Planned test files (2 / max 2):
  - `tests/workflow/workflow.test.ts` — Workflow schema、加载、语义校验、validate CLI 对 workflow 的测试
  - `tests/skill-pack/skill-pack.test.ts` — Skill Pack schema、加载、pack 内路径校验、skill-lock schema、解析、validate CLI 对 skill.yml 的测试

Slice within 3-user-task and 2-test-file budget. DAG cycle detection and `needs` reference checks are carved out to P3.1 (see TD-P2-001) to keep scope predictable.

## Workflow Goal

Deliver `zigma-flow validate <path>` plus the underlying loader libraries:

- Read workflow YAML and validate the field-level shape with Zod (name / version / on / skills / permissions / signals / jobs / steps).
- Read Skill Pack `skill.yml` and validate manifest shape (kind, exports) plus pack-relative path safety.
- Resolve `skill-lock.json` and translate `local://` URIs into on-disk paths.
- Dispatch `validate` by file kind (workflow vs. skill-pack) and surface field-level errors with non-zero exit code; success returns 0.
- All errors flow through the typed error taxonomy (`ValidationError`, `FilesystemError`, `SkillPackError`, `UserInputError`) defined in `docs/mvp-contracts.md` §7.

## Acceptance Criteria

1. **M1 Workflow Schema (FP-WF-SCH + FP-WF-LOAD)**
   - A canonical workflow YAML (single `jobs.intake` with one agent step) parses and validates.
   - Missing `name`, `version`, or `jobs` produce `ValidationError` whose details include a `path` array pointing at the missing field.
   - A step with an unknown `type` (`bogus` instead of `agent|script|check|router|workflow|human`) produces `ValidationError` whose path resolves to that step's `type` key.
   - A router step with an unknown action verb (e.g. `cases.default.delete_job`) produces `ValidationError`.
   - YAML syntax errors return `ValidationError`; their details include enough position info that line/column is preserved when present.
   - Pointing the loader at a non-existent file returns `FilesystemError`.

2. **M2 Workflow Semantic (FP-WF-SEM)**
   - Duplicate job ids (two jobs both named `intake`) produce `ValidationError` with details locating the duplicates.
   - Duplicate step ids inside the same job (two `analyze` steps under `jobs.intake`) produce `ValidationError`.
   - An Agent Step whose `expose.skills` references an alias absent from the top-level `skills` map produces `ValidationError`.

3. **M3 Skill Pack Schema (FP-SP-SCH)**
   - Canonical `skill.yml` parses and validates.
   - Missing `kind` produces `ValidationError`.
   - `kind: something-else` (anything other than `skill-pack`) produces `ValidationError`.

4. **M4 Skill Pack Loader and Path Safety (FP-SP-LOAD + FP-SP-PATH)**
   - Manifest exports referencing non-existent files (e.g. `knowledge.path: missing.md` when no such file exists) produce `SkillPackError`.
   - Manifest exports whose `path` walks out of the pack root via `../` produce `SkillPackError`.
   - Manifest exports whose `path` is absolute (e.g. `C:/elsewhere/foo.md` or `/etc/passwd`) produce `SkillPackError`.
   - A complete, well-formed pack on disk yields a definition object exposing `exports` arrays for at least `knowledge` and `scripts`.

5. **M5 Skill Lock Schema and Resolution (FP-LK-SCH + FP-LK-RES)**
   - A lockfile with `skills.<id>.resolved = "local://skills/<name>"`, `version`, and `hash` validates; the resolver returns the absolute path `<base>/.zigma-flow/skills/<name>`.
   - A lockfile missing the requested skill id returns `SkillPackError`.
   - A missing lockfile returns `FilesystemError`.

6. **M6 validate CLI (FP-CLI-VAL + FP-CLI-ERR + FP-CLI-EXIT)**
   - `zigma-flow validate <legal-workflow.yml>` exits 0 and writes a success line to stdout.
   - `zigma-flow validate <legal-skill.yml>` exits 0 and writes a success line.
   - `zigma-flow validate <illegal-workflow.yml>` exits non-zero and stderr lists each error as `path: message`.
   - `zigma-flow validate <missing-file>` exits non-zero with a `FilesystemError`-shaped message.
   - The dispatcher distinguishes workflow vs. skill-pack input. The MVP rule: top-level `kind: skill-pack` -> skill pack, otherwise -> workflow.

## Spec Compliance Matrix

PRD FR-002 and FR-003 enumerate the mandatory checks. Below maps each clause to a Functional Point or explicitly defers it. Per the frozen technical decision (TD-P2-001), DAG cycle detection and `needs` reference checks slip to P3.1; this is reflected here.

| #     | Clause (PRD origin)                                                                       | Status                |
| ----- | ----------------------------------------------------------------------------------------- | --------------------- |
| RC-01 | Validate `name`, `version`, `on`, `skills`, `permissions`, `signals`, `jobs` (FR-002)     | Covered by FP-WF-SCH  |
| RC-02 | Job ids unique (FR-002)                                                                   | Covered by FP-WF-SEM  |
| RC-03 | Step ids unique within a job (FR-002)                                                     | Covered by FP-WF-SEM  |
| RC-04 | Step `type` is one of six categories (FR-002)                                             | Covered by FP-WF-SCH  |
| RC-05 | Agent Step `expose.skills` may only reference top-level `skills` aliases (FR-002)         | Covered by FP-WF-SEM  |
| RC-06 | Router Step control-flow uses only MVP allowed actions (FR-002, §12)                      | Covered by FP-WF-SCH  |
| RC-07 | `needs`/`optional_needs` refer to existing jobs (FR-002)                                  | Deferred (P3.1, TD-P2-001) |
| RC-08 | DAG has no cycles (FR-002)                                                                | Deferred (P3.1, TD-P2-001) |
| RC-09 | Skill manifest `kind: skill-pack` (FR-003)                                                | Covered by FP-SP-SCH  |
| RC-10 | Skill manifest `exports` field shape (FR-003)                                             | Covered by FP-SP-SCH  |
| RC-11 | All export `path` values stay inside the Skill Pack directory (FR-003)                    | Covered by FP-SP-PATH |
| RC-12 | Lockfile entries record `resolved`, `version`, `hash` (FR-003, §9)                        | Covered by FP-LK-SCH  |
| RC-13 | Schema validator emits field-level errors (`docs/mvp-contracts.md` §7)                    | Covered by FP-CLI-ERR |

Out-of-scope and deferred clauses are recorded in **Test Gaps** below so the P3 phase plan can absorb them.

## Functional Points

| FP id       | Area                                  | Source                  | Summary                                                                                          |
| ----------- | ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| FP-WF-SCH   | Workflow Zod schema                   | PRD FR-002, §12         | Validate `name`, `version`, `on`, `skills`, `permissions`, `signals`, `jobs`, step types, router cases |
| FP-WF-LOAD  | Workflow YAML reader                  | PRD FR-002              | Read file, parse YAML (preserve line/col on error), wrap errors as `ValidationError` / `FilesystemError` |
| FP-WF-SEM   | Workflow semantic checks              | PRD FR-002              | Job id unique, step id unique within job, Agent `expose.skills` references declared aliases       |
| FP-SP-SCH   | Skill Pack Zod schema                 | PRD FR-003, §11         | Validate `id`, `name`, `version`, `kind=skill-pack`, exports shape                                |
| FP-SP-LOAD  | Skill Pack manifest reader            | PRD FR-003              | Read + parse skill.yml, return `SkillDefinition`                                                  |
| FP-SP-PATH  | Pack-internal path safety             | PRD FR-003              | All `path` fields must resolve inside the pack root; reject `../` traversal and absolute paths    |
| FP-LK-SCH   | Skill-lock Zod schema                 | PRD §9, FR-003          | Each `skills.<id>` has `version`, `resolved`, `hash`                                              |
| FP-LK-RES   | Skill-lock resolver                   | PRD §9                  | `local://skills/<name>` -> `<base>/.zigma-flow/skills/<name>`                                     |
| FP-CLI-VAL  | `validate` CLI command                | PRD §17                 | `zigma-flow validate <path>` dispatches workflow vs. skill-pack and runs the appropriate loader  |
| FP-CLI-ERR  | Field-level error output              | mvp-contracts §7        | Validation failures print `path: message` lines on stderr                                         |
| FP-CLI-EXIT | Exit code mapping                     | mvp-contracts §7        | `ValidationError` -> 3, `FilesystemError` -> 5, `SkillPackError` -> non-zero (taxonomy-defined)   |

## Use Cases

| UC id     | Actor | Trigger                                                              | Pre-conditions                                            | Steps (happy path)                                                                                                  | Post-conditions / observable result                                                                                  |
| --------- | ----- | -------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| UC-WF-1   | Lib   | `loadWorkflow(yamlText)` with canonical workflow                     | None                                                      | Parse YAML; validate via Zod schema.                                                                                | Returns a `WorkflowDefinition` typed value; no throw.                                                                |
| UC-WF-2   | Lib   | `loadWorkflow(yamlText)` missing `name`                              | YAML otherwise legal                                      | Parse YAML; Zod reports missing field.                                                                              | Throws `ValidationError`; `details.issues[0].path` contains `"name"`.                                                |
| UC-WF-3   | Lib   | `loadWorkflow(yamlText)` missing `version`                           | YAML otherwise legal                                      | Same as UC-WF-2 for `version`.                                                                                       | Throws `ValidationError`; path contains `"version"`.                                                                 |
| UC-WF-4   | Lib   | `loadWorkflow(yamlText)` missing `jobs`                              | YAML otherwise legal                                      | Same as UC-WF-2 for `jobs`.                                                                                          | Throws `ValidationError`; path contains `"jobs"`.                                                                    |
| UC-WF-5   | Lib   | `loadWorkflow` with step type `bogus`                                | Single job with one step                                  | Schema fails on `jobs.intake.steps[0].type`.                                                                         | Throws `ValidationError`; path joins to `jobs.intake.steps.0.type`.                                                  |
| UC-WF-6   | Lib   | `loadWorkflow` with router action `delete_job`                       | Router step under a job                                   | Schema fails on router action.                                                                                       | Throws `ValidationError`.                                                                                            |
| UC-WF-7   | Lib   | `loadWorkflowFile(path)` on a path that does not exist               | Path missing                                              | Reader fails ENOENT.                                                                                                 | Throws `FilesystemError`.                                                                                            |
| UC-WF-8   | Lib   | `loadWorkflow(yamlText)` where YAML is syntactically invalid         | Bad YAML                                                  | YAML parser throws.                                                                                                  | Throws `ValidationError` whose details preserve line info when supplied by parser.                                   |
| UC-WF-9   | Lib   | Two jobs share the same id                                           | Otherwise legal YAML                                      | Semantic pass detects duplicate.                                                                                     | Throws `ValidationError` referencing the duplicate.                                                                  |
| UC-WF-10  | Lib   | Two steps in the same job share the same id                          | Otherwise legal YAML                                      | Semantic pass detects duplicate.                                                                                     | Throws `ValidationError` referencing the duplicate step id.                                                          |
| UC-WF-11  | Lib   | Agent Step `expose.skills` includes an alias not in top-level skills | Otherwise legal YAML                                      | Semantic pass detects unknown alias.                                                                                 | Throws `ValidationError` referencing the offending skill alias.                                                      |
| UC-SP-1   | Lib   | `loadSkillPack(packRoot)` on canonical pack                          | Pack root contains skill.yml + referenced files            | Read manifest, validate, walk exports verifying each `path` is inside `packRoot` and exists.                         | Returns `SkillDefinition` with exports populated.                                                                    |
| UC-SP-2   | Lib   | `loadSkillPack` with skill.yml missing `kind`                        | Manifest lacks `kind`                                     | Zod fails.                                                                                                           | Throws `ValidationError`; path contains `"kind"`.                                                                    |
| UC-SP-3   | Lib   | `loadSkillPack` with `kind: not-a-pack`                              | Manifest declares wrong kind                              | Zod literal check fails.                                                                                             | Throws `ValidationError`.                                                                                            |
| UC-SP-4   | Lib   | Manifest references a knowledge path that doesn't exist on disk      | Pack root present, missing file                           | Path-existence walk fails.                                                                                           | Throws `SkillPackError`.                                                                                             |
| UC-SP-5   | Lib   | Manifest export `path: ../escape.md`                                 | Pack root present                                          | Path resolves outside the pack root.                                                                                | Throws `SkillPackError`.                                                                                             |
| UC-SP-6   | Lib   | Manifest export `path: /etc/passwd` (or `C:/`)                       | Pack root present                                          | Absolute path rejected.                                                                                              | Throws `SkillPackError`.                                                                                             |
| UC-LK-1   | Lib   | `resolveSkillLock(base, "zigma.code-change")` for `local://`         | `.zigma-flow/skill-lock.json` valid                       | Read lockfile; convert `local://skills/code-change` to `<base>/.zigma-flow/skills/code-change`.                       | Returns absolute path; matches `fs.stat` of pack root.                                                               |
| UC-LK-2   | Lib   | `resolveSkillLock(base, id)` when lockfile missing                   | No lockfile                                               | Reader fails ENOENT.                                                                                                 | Throws `FilesystemError`.                                                                                            |
| UC-LK-3   | Lib   | `resolveSkillLock(base, id)` when id absent from lockfile            | Lockfile present but no entry                              | Lookup misses.                                                                                                       | Throws `SkillPackError`.                                                                                             |
| UC-CLI-V1 | User  | `zigma-flow validate <legal workflow.yml>`                           | File exists                                                | CLI loads and validates workflow.                                                                                    | Exit code 0; stdout contains a success marker.                                                                       |
| UC-CLI-V2 | User  | `zigma-flow validate <legal skill.yml>`                              | File exists                                                | CLI detects `kind: skill-pack`; validates manifest and pack files.                                                   | Exit code 0; stdout contains a success marker.                                                                       |
| UC-CLI-V3 | User  | `zigma-flow validate <illegal workflow.yml>`                         | File exists                                                | CLI loads and validates; errors propagate.                                                                           | Exit code non-zero; stderr lists each error as `path: message`.                                                      |
| UC-CLI-V4 | User  | `zigma-flow validate <missing file>`                                 | File does not exist                                        | CLI tries to read.                                                                                                   | Exit code non-zero; stderr mentions the path.                                                                        |

## Test Mapping

| Test id    | File                                  | Test name                                                                                  | UCs covered           | FPs covered                                          |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------- | ---------------------------------------------------- |
| T-WF-1     | `tests/workflow/workflow.test.ts`     | `loadWorkflow accepts canonical workflow YAML`                                             | UC-WF-1               | FP-WF-SCH, FP-WF-LOAD                                |
| T-WF-2     | `tests/workflow/workflow.test.ts`     | `loadWorkflow rejects missing name with field path`                                        | UC-WF-2               | FP-WF-SCH                                            |
| T-WF-3     | `tests/workflow/workflow.test.ts`     | `loadWorkflow rejects missing version with field path`                                     | UC-WF-3               | FP-WF-SCH                                            |
| T-WF-4     | `tests/workflow/workflow.test.ts`     | `loadWorkflow rejects missing jobs with field path`                                        | UC-WF-4               | FP-WF-SCH                                            |
| T-WF-5     | `tests/workflow/workflow.test.ts`     | `loadWorkflow rejects illegal step type with field path`                                   | UC-WF-5               | FP-WF-SCH                                            |
| T-WF-6     | `tests/workflow/workflow.test.ts`     | `loadWorkflow rejects router step with illegal action`                                     | UC-WF-6               | FP-WF-SCH                                            |
| T-WF-7     | `tests/workflow/workflow.test.ts`     | `loadWorkflowFile returns FilesystemError when file missing`                               | UC-WF-7               | FP-WF-LOAD                                           |
| T-WF-8     | `tests/workflow/workflow.test.ts`     | `loadWorkflow surfaces YAML syntax errors as ValidationError`                              | UC-WF-8               | FP-WF-LOAD                                           |
| T-WF-9     | `tests/workflow/workflow.test.ts`     | `loadWorkflow rejects duplicate job ids`                                                   | UC-WF-9               | FP-WF-SEM                                            |
| T-WF-10    | `tests/workflow/workflow.test.ts`     | `loadWorkflow rejects duplicate step ids within a job`                                     | UC-WF-10              | FP-WF-SEM                                            |
| T-WF-11    | `tests/workflow/workflow.test.ts`     | `loadWorkflow rejects Agent expose.skills referencing undeclared alias`                    | UC-WF-11              | FP-WF-SEM                                            |
| T-WF-CLI-1 | `tests/workflow/workflow.test.ts`     | `validate CLI returns 0 on legal workflow file`                                            | UC-CLI-V1             | FP-CLI-VAL, FP-CLI-EXIT                              |
| T-WF-CLI-2 | `tests/workflow/workflow.test.ts`     | `validate CLI returns non-zero on illegal workflow with field-level errors`                | UC-CLI-V3             | FP-CLI-VAL, FP-CLI-ERR, FP-CLI-EXIT                  |
| T-WF-CLI-3 | `tests/workflow/workflow.test.ts`     | `validate CLI returns non-zero on missing file`                                            | UC-CLI-V4             | FP-CLI-VAL, FP-CLI-EXIT                              |
| T-SP-1     | `tests/skill-pack/skill-pack.test.ts` | `loadSkillPack accepts canonical pack`                                                     | UC-SP-1               | FP-SP-SCH, FP-SP-LOAD                                |
| T-SP-2     | `tests/skill-pack/skill-pack.test.ts` | `loadSkillPack rejects manifest missing kind`                                              | UC-SP-2               | FP-SP-SCH                                            |
| T-SP-3     | `tests/skill-pack/skill-pack.test.ts` | `loadSkillPack rejects manifest with kind other than skill-pack`                           | UC-SP-3               | FP-SP-SCH                                            |
| T-SP-4     | `tests/skill-pack/skill-pack.test.ts` | `loadSkillPack rejects manifest referencing non-existent file`                             | UC-SP-4               | FP-SP-LOAD, FP-SP-PATH                               |
| T-SP-5     | `tests/skill-pack/skill-pack.test.ts` | `loadSkillPack rejects manifest with path that escapes pack root`                          | UC-SP-5               | FP-SP-PATH                                           |
| T-SP-6     | `tests/skill-pack/skill-pack.test.ts` | `loadSkillPack rejects manifest with absolute path`                                        | UC-SP-6               | FP-SP-PATH                                           |
| T-LK-1     | `tests/skill-pack/skill-pack.test.ts` | `resolveSkillLock turns local URI into absolute pack root`                                 | UC-LK-1               | FP-LK-SCH, FP-LK-RES                                 |
| T-LK-2     | `tests/skill-pack/skill-pack.test.ts` | `resolveSkillLock throws FilesystemError when lockfile missing`                            | UC-LK-2               | FP-LK-RES                                            |
| T-LK-3     | `tests/skill-pack/skill-pack.test.ts` | `resolveSkillLock throws SkillPackError when skill id absent from lockfile`                | UC-LK-3               | FP-LK-SCH, FP-LK-RES                                 |
| T-SP-CLI-1 | `tests/skill-pack/skill-pack.test.ts` | `validate CLI returns 0 on legal skill.yml`                                                | UC-CLI-V2             | FP-CLI-VAL, FP-CLI-EXIT                              |
| T-SP-CLI-2 | `tests/skill-pack/skill-pack.test.ts` | `validate CLI returns non-zero on skill.yml with bad kind`                                 | UC-CLI-V3             | FP-CLI-VAL, FP-CLI-ERR, FP-CLI-EXIT                  |

## Test Gaps

- **DAG cycle detection (RC-08)** and **`needs`/`optional_needs` reference checks (RC-07)** are intentionally deferred. They depend on the engine's DAG topology code, which lands in P3.1. TD-P2-001 records the carve-out; P3 readiness must restore these tests.
- **`uses` resolution into Skill Pack scripts/checks** (PRD FR-002 bullet on `uses` pointing to exported items) requires linking workflow validation to a loaded Skill Pack. That cross-document link lands once `zigma-flow run` exists in P3; for P2, only intra-document references are checked.
- **Retry `max_attempts`, outputs path safety, optional `activation` rules** (PRD FR-002 tail) are partial: schema enforces shape (covered by FP-WF-SCH), but stronger semantic rules will be re-examined in P3 alongside engine wiring.
- **`hash` integrity verification** of `skill-lock.json` entries is out of scope. P2 only validates the schema shape (RC-12); checking the hash against on-disk content is queued for P3 (engine load path).
- **Cross-pack `expose.skills` resolution into actual Skill Pack manifests** is out of scope. P2 only confirms the alias is declared at workflow top-level (FP-WF-SEM); pack-level export visibility is engine-level (P3).
- **`prompts/*.md` content requirements** (e.g. `stop after completing`) are P1 init-template tests; not re-tested here.
- **Permissions and signals semantics** (severity/priority interaction, `allowed_from` referencing existing jobs) only have shape coverage; richer cross-checks are queued for P3.
