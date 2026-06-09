# WF-P7-FILECHECK — Cases and Tests

- Workflow: WF-P7-FILECHECK
- Phase: P7 Check Step
- Step: 1 (Cases and Tests)
- Date: 2026-06-09
- Author: subagent (workflow Step 1)

## Slice Boundary

- Slice name: **P7-FILECHECK**
- Bounded contexts:
  - **Check Kind Implementations (file / JSON family)** — the four
    deterministic check functions `file-exists`, `json-parse`,
    `json-schema`, `required-fields`. Each is a pure function over its
    `with` arguments and the run directory; each returns a `CheckResult`
    in the canonical snake_case shape `{ passed, check_id, failures,
    artifacts }` (mvp-contracts §2.8, architecture §9.4).
  - **CheckRunner kind registry** in `src/check/index.ts` —
    `registerBuiltinChecks()` / built-in dispatch table that maps the
    canonical kind identifiers (`zigma/file-exists`, `zigma/json-parse`,
    `zigma/json-schema`, `zigma/required-fields`) to the concrete check
    functions delivered by this workflow.
- Bounded context interactions:
  - **Consumes** the `CheckRunner` port and `CheckResult` /
    `CheckRunnerRunOpts` types established by WF-P7-CHECK
    (`src/check/index.ts`).
  - **Consumes** Node `node:fs/promises`, `node:path`, and `ajv@8` (for
    `json-schema` only; ajv is added to `package.json` in Step 2 of this
    workflow).
  - **Produces** structured `CheckResult` values consumed by the
    executor (`executeCheckStep`) — this workflow MUST NOT touch
    `events.jsonl` or `state.json`; the executor is the sole writer of
    the artifact (per the WF-P7-CHECK orchestration contract).
  - **MUST NOT** modify `executeCheckStep` orchestration — that is a
    completed WF-P7-CHECK deliverable.
  - **MUST NOT** implement the git / path family kinds (`git-diff-exists`,
    `forbidden-paths`, `protected-runtime-files`) — those are WF-P7-GITCHECK
    and may proceed in parallel.
  - **MUST NOT** emit events, write state, or apply on_pass / on_fail
    decisions — the check kinds are pure functions returning `CheckResult`.

## Workflow Goal

Deliver the four MVP file/JSON check-kind implementations registered
into the `CheckRunner` from WF-P7-CHECK, so that an end user whose
workflow declares `uses: zigma/file-exists`, `uses: zigma/json-parse`,
`uses: zigma/json-schema`, or `uses: zigma/required-fields` on a
`type: check` step gets the expected deterministic gate behaviour:

- The check function reads its `with` arguments (file path or paths,
  schema path, fields list).
- The check function inspects the filesystem under the run's project
  workspace (paths resolved relative to the run directory).
- The check function returns a `CheckResult` whose `passed` flag and
  `failures[]` list accurately reflect the on-disk state.
- The executor (WF-P7-CHECK) writes the result as `check-result.json`,
  appends the canonical event sequence, and applies the state
  transition.

The slice satisfies architecture §13 phase 7 — "基础 gate 不依赖 LLM" —
for the file / JSON axes. The git axis lands in WF-P7-GITCHECK.

Deliverables (full workflow scope across all steps):

1. `src/check/checks/file-exists.ts` — `checkFileExists(opts)`.
2. `src/check/checks/json-parse.ts` — `checkJsonParse(opts)`.
3. `src/check/checks/json-schema.ts` — `checkJsonSchema(opts)`.
4. `src/check/checks/required-fields.ts` — `checkRequiredFields(opts)`.
5. `src/check/index.ts` — register all four kinds in the built-in
   registry so the `LocalCheckRunner` dispatches to them.
6. `package.json` — add `ajv@^8` dependency.
7. `tests/check/checks.test.ts` — fixture-driven tests for all four
   kinds, including pass and fail cases.

**Step 1 (this artifact) writes only the cases-and-tests document and
the failing test file.** Source files, the registry update, and the
ajv dependency ship in Step 2.

## "用户可完成" Milestones

- **M1 — file-exists**: 用户在 workflow 中声明
  `uses: zigma/file-exists` 且 `with: { file: <path> }` 或
  `with: { files: [<path>, ...] }`：所有路径存在时 check passed；
  任意一个缺失时 check failed，`failures[]` 列出所有缺失的路径
  字符串（人类可读）。

- **M2 — json-parse**: 用户声明 `uses: zigma/json-parse` 且
  `with: { file: <path> }`：文件内容为合法 JSON 时 check passed；
  否则 check failed，`failures[0]` 包含原路径与解析错误的位置信息
  （形如 `<path>: SyntaxError at <location>`），无需还原 ajv 行号
  细节。

- **M3 — json-schema**: 用户声明 `uses: zigma/json-schema` 且
  `with: { file: <path>, schema: <schema-path> }`：文件 JSON
  通过 schema 验证时 check passed；否则 check failed，
  `failures[]` 列出每个 ajv 错误的字段路径与错误信息
  （ajv `ErrorObject.instancePath` + `message`）。

- **M4 — required-fields**: 用户声明
  `uses: zigma/required-fields` 且
  `with: { file: <path>, fields: [<field>, ...] }`：所有顶层
  字段存在且非空时 check passed；否则 check failed，
  `failures[]` 列出每个缺失或空字段的名字。

每个 milestone 与 WF-P7-CHECK 的 executor 拼装后，最终用户可执行：

```
zigma-flow run --workflow code-change.yml
zigma-flow step --job verify
```

得到正确的 `check-result.json`、`check_completed` 事件与 job 状态。

## Spec Compliance Matrix

下表覆盖 prd.md FR-008、architecture.md §9.4 / §13 phase 7、
mvp-contracts.md §2.8 中本工作流相关的 MUST / SHALL 条款。
RC-FC-* 条款编号沿用 WF-P7-CHECK 的 RC-C* 命名约定但区分前缀避免冲突。

| Clause ID | Clause Source | Clause Text | Status |
| --- | --- | --- | --- |
| RC-FC-1 | prd §FR-008 | MVP 支持文件存在检查. | 已纳入本工作流 — FP-FC-FILE-EXISTS；T-FC-1, T-FC-2. |
| RC-FC-2 | prd §FR-008 | MVP 支持 JSON 合法性检查. | 已纳入本工作流 — FP-FC-JSON-PARSE；T-FC-3, T-FC-4. |
| RC-FC-3 | prd §FR-008 | MVP 支持 JSON Schema 检查. | 已纳入本工作流 — FP-FC-JSON-SCHEMA；T-FC-5, T-FC-6. |
| RC-FC-4 | prd §FR-008 | MVP 支持必填字段检查与字段非空检查. | 已纳入本工作流 — FP-FC-REQUIRED-FIELDS；T-FC-7, T-FC-8. |
| RC-FC-5 | prd §FR-008 | 检查通过时写入 check-result artifact. | 由 WF-P7-CHECK executor 完成；本工作流提供合规的 `CheckResult` 返回值. |
| RC-FC-6 | prd §FR-008 | 检查失败时列出失败项. | 已纳入本工作流 — `failures[]` 在所有 fail 用例中非空；T-FC-2, T-FC-4, T-FC-6, T-FC-8. |
| RC-FC-7 | prd §FR-008 | 基础 gate 不依赖 LLM Judge. | 已纳入本工作流 — 四个 check 函数仅依赖 `node:fs/promises` + `ajv`，不导入任何 LLM / prompt 模块. |
| RC-FC-8 | mvp-contracts §2.8 | `CheckResult` 字段 `{ passed, check_id, failures, artifacts }`. | 已纳入本工作流 — 所有 check 函数返回此形状；T-FC-1..8 验证返回 shape. |
| RC-FC-9 | mvp-contracts §2.8 | Check Step 是确定性 gate, 不依赖 LLM Judge. | 已纳入本工作流（同 RC-FC-7）. |
| RC-FC-10 | architecture §9.4 | Script Runner 和 Check Runner 只产出结果. | 已纳入本工作流 — 四个 check 函数无状态副作用 (no event/state writes)；T-FC-* 通过断言没有任何事件文件被检查器创建. |
| RC-FC-11 | architecture §13 phase 7 | 基础 gate 不依赖 LLM. | 同 RC-FC-7 / RC-FC-9. |
| RC-FC-12 | mvp-contracts §7 (CheckError) | `CheckError` 触发于 check 输入缺失或 check 执行失败. | 已纳入本工作流 — 缺失 `with.file`、不可读文件、解析失败等情况会通过返回 `passed: false` + 描述性 failures 报告. 区分: (a) 检查"语义失败"返回 `passed: false`；(b) 输入参数本身格式错误（如 `file` 不是 string）抛出 `CheckError`. |
| TD-FC-1 | architecture §11 (workspace) | 路径解析的根目录策略：本 slice 默认相对 `opts.runDir` 解析；项目工作区根目录的解析（cwd / repo root）由后续工作流统一. | 技术债 — TD-FC-1（在 WF-P7-GITCHECK 后统一路径解析策略）. |
| TD-FC-2 | mvp-contracts §2.8 | `required-fields` 当前只检查顶层字段。嵌套 dotted path（如 `report.summary`）暂不支持. | 技术债 — TD-FC-2（P8 或 follow-up workflow 落地）. |
| TD-FC-3 | prd FR-008 | `json-schema` 当前每次调用编译一次 schema。缓存策略 deferred. | 技术债 — TD-FC-3（P8 落地，与 Skill Pack check 缓存一起做）. |

Spec clause budget: 11 in-scope clauses (RC-FC-1..11) + 3 technical-debt
registrations (TD-FC-1..3). All MUST clauses for the file / JSON
check kinds sourced from prd FR-008, architecture §9.4 / §13 phase 7,
and mvp-contracts §2.8 are accounted for.

## Functional Points

| FP id | Area | Source | Summary |
| --- | --- | --- | --- |
| FP-FC-FILE-EXISTS | `file-exists` check kind | prd FR-008, mvp §2.8 | Accept `with.file: string` OR `with.files: string[]`. Pass iff all paths exist (`fs.stat` succeeds). Fail with `failures[]` listing the missing paths verbatim. Throws `CheckError` only on malformed input (neither `file` nor `files` provided, or wrong type). |
| FP-FC-JSON-PARSE | `json-parse` check kind | prd FR-008, mvp §2.8 | Accept `with.file: string`. Read file, attempt `JSON.parse`. Pass iff parse succeeds. Fail with `failures: ["<path>: SyntaxError at <location>"]` where `<location>` is extracted from the `SyntaxError.message` (line/column or character index). |
| FP-FC-JSON-SCHEMA | `json-schema` check kind | prd FR-008, mvp §2.8 | Accept `with.file: string`, `with.schema: string` (path to a JSON Schema file). Use `ajv@8` draft-07. Compile schema, validate file contents. Pass iff `validate()` returns true. Fail with `failures[]` listing one entry per ajv error: `"<instancePath>: <message>"`. |
| FP-FC-REQUIRED-FIELDS | `required-fields` check kind | prd FR-008, mvp §2.8 | Accept `with.file: string`, `with.fields: string[]`. Read + parse file as JSON. For each field name: pass iff present (object key exists) AND non-empty (not `null`, not empty string, not empty array). Fail with `failures[]` listing every missing-or-empty field. |
| FP-FC-RESULT-SHAPE | `CheckResult` snake_case | arch §9.4, mvp §2.8 | All four functions return `{ passed: boolean, check_id: string, failures: string[], artifacts: string[] }`. `artifacts` is always `[]` for pure logic checks. `check_id` reflects the canonical kind identifier (`"zigma/file-exists"`, etc.) — set by the registry caller. |
| FP-FC-NO-EVENTS | No state/event mutation | arch §13 phase 7 fitness | None of the four functions imports `events`, `run`, or `engine` modules. They are pure functions over `(opts) → Promise<CheckResult>`. Verified by import-graph inspection in Step 2. |
| FP-FC-REGISTRY | Built-in registration | arch §9.4 | `src/check/index.ts` registers all four kinds in a `Map<string, CheckFn>` keyed by `"zigma/<kind>"`. The `LocalCheckRunner` is updated to dispatch via this map (replacing its WF-P7-CHECK "always throw" stub). |
| FP-FC-PATH-RESOLUTION | Path resolution | arch §11 (Workspace) | `with.file` / `with.files` / `with.schema` are resolved relative to `opts.runDir`. Absolute paths are honoured as-is. TD-FC-1 tracks the cross-workflow path-root unification. |

## Use Case Enumeration

| UC id | Actor | Trigger | Pre-conditions | Steps (happy path / failure) | Post-conditions / observable result |
| --- | --- | --- | --- | --- | --- |
| UC-FC-1 | CheckRunner | `checkFileExists({ with: { file: "<existing-path>" }, runDir })` invoked. | Path resolves to an existing file under `opts.runDir`. | `fs.stat` succeeds → return `{ passed: true, check_id: "zigma/file-exists", failures: [], artifacts: [] }`. | `passed === true`; `failures.length === 0`. |
| UC-FC-2 | CheckRunner | Same but `with.files: ["a", "b", "c"]`; `b` is missing. | `a` and `c` exist; `b` does not. | `fs.stat` on each → `b` fails → return `passed: false, failures: ["b: file not found"]` (or path-only). | `passed === false`; `failures` mentions `b`. |
| UC-FC-3 | CheckRunner | `checkJsonParse({ with: { file: <valid-json> }, runDir })`. | File contains valid JSON. | Read file → `JSON.parse` succeeds → return `passed: true`. | `passed === true`. |
| UC-FC-4 | CheckRunner | Same but file is `{ "bad": ` (truncated). | File exists, contents invalid JSON. | `JSON.parse` throws `SyntaxError` → return `passed: false, failures: ["<path>: SyntaxError at <location>"]`. | `passed === false`; `failures[0]` references path AND location. |
| UC-FC-5 | CheckRunner | `checkJsonSchema({ with: { file, schema }, runDir })`; data matches schema. | File JSON satisfies the JSON Schema. | Compile schema, run `validate(data)` → true → return `passed: true`. | `passed === true`. |
| UC-FC-6 | CheckRunner | Same but data violates required field in schema. | Schema requires `"name"`; data lacks `"name"`. | `validate` returns false; `validate.errors` non-empty → return `passed: false, failures: ["/name: must have required property 'name'"]` (or similar ajv string). | `passed === false`; `failures` contains a field path / message. |
| UC-FC-7 | CheckRunner | `checkRequiredFields({ with: { file, fields: ["title", "body"] }, runDir })`; both present and non-empty. | File JSON has both fields with non-empty values. | Read + parse + per-field check → all OK → return `passed: true`. | `passed === true`. |
| UC-FC-8 | CheckRunner | Same but `body` is empty string AND `extra` requested but missing. | `with.fields: ["title", "body", "extra"]`; `body === ""`; `extra` absent. | Per-field check: `title` OK, `body` empty → fail, `extra` missing → fail → return `passed: false, failures: ["body: empty", "extra: missing"]`. | `passed === false`; `failures` enumerates the failing field names. |

## Test Plan

All tests live in **`tests/check/checks.test.ts`** under
`describe("<kind>", ...)` blocks. Vitest. Real temp dirs under
`os.tmpdir()`. No filesystem mocking. Each test creates fixtures
(JSON files, schema files) inside its own temp directory and asserts
against the function return value.

| Test id | `it` description | What it verifies | UCs covered | FPs covered | RCs touched |
| --- | --- | --- | --- | --- | --- |
| T-FC-1 | `file-exists — passes when all listed files exist on disk` | Create one or more fixture files; invoke `checkFileExists` with `with.file` (single) and again with `with.files` (array); assert `passed: true`, `failures: []`, `check_id: "zigma/file-exists"`, `artifacts: []`. | UC-FC-1 | FP-FC-FILE-EXISTS, FP-FC-RESULT-SHAPE | RC-FC-1, RC-FC-8 |
| T-FC-2 | `file-exists — fails listing missing paths when a file is absent` | Provide `with.files: ["present.txt", "absent.txt", "also-absent.txt"]` where only the first exists; assert `passed: false`, `failures.length === 2`, and each missing path appears in some `failures[i]` string. | UC-FC-2 | FP-FC-FILE-EXISTS, FP-FC-RESULT-SHAPE | RC-FC-1, RC-FC-6, RC-FC-8 |
| T-FC-3 | `json-parse — passes for valid JSON content` | Write `{"a":1,"b":[2,3]}` to a fixture file; invoke `checkJsonParse({ with: { file }, runDir })`; assert `passed: true`, `failures: []`, `check_id: "zigma/json-parse"`. | UC-FC-3 | FP-FC-JSON-PARSE, FP-FC-RESULT-SHAPE | RC-FC-2, RC-FC-8 |
| T-FC-4 | `json-parse — fails with location string when content is invalid JSON` | Write `{ "broken":` (truncated, invalid JSON); invoke and assert `passed: false`, `failures.length >= 1`, `failures[0]` includes the file path AND the substring `"SyntaxError"` AND a location indicator (case-insensitive match on `at`, `line`, `column`, or `position`). | UC-FC-4 | FP-FC-JSON-PARSE, FP-FC-RESULT-SHAPE | RC-FC-2, RC-FC-6, RC-FC-8 |
| T-FC-5 | `json-schema — passes when data validates against schema` | Write a draft-07 schema requiring `{ name: string, count: number }`; write data `{ "name": "n", "count": 3 }`; invoke `checkJsonSchema({ with: { file, schema }, runDir })`; assert `passed: true`, `failures: []`, `check_id: "zigma/json-schema"`. | UC-FC-5 | FP-FC-JSON-SCHEMA, FP-FC-RESULT-SHAPE | RC-FC-3, RC-FC-8 |
| T-FC-6 | `json-schema — fails with field-level errors when data violates schema` | Same schema; write data `{ "count": "three" }` (missing `name`, wrong type for `count`); invoke; assert `passed: false`, `failures.length >= 1`, every failure entry is a non-empty string, and at least one failure mentions `name` (the missing required field). | UC-FC-6 | FP-FC-JSON-SCHEMA, FP-FC-RESULT-SHAPE | RC-FC-3, RC-FC-6, RC-FC-8 |
| T-FC-7 | `required-fields — passes when all listed top-level fields are present and non-empty` | Write `{ "title": "T", "body": "B" }`; invoke `checkRequiredFields({ with: { file, fields: ["title","body"] }, runDir })`; assert `passed: true`, `failures: []`, `check_id: "zigma/required-fields"`. | UC-FC-7 | FP-FC-REQUIRED-FIELDS, FP-FC-RESULT-SHAPE | RC-FC-4, RC-FC-8 |
| T-FC-8 | `required-fields — fails listing each missing or empty field` | Write `{ "title": "T", "body": "" }`; invoke with `fields: ["title", "body", "extra"]`; assert `passed: false`, `failures.length === 2`, each failure entry contains the corresponding field name (`body` and `extra`). | UC-FC-8 | FP-FC-REQUIRED-FIELDS, FP-FC-RESULT-SHAPE | RC-FC-4, RC-FC-6, RC-FC-8 |

## Test Design Summary

- **Test framework**: vitest (`describe` / `it` / `expect` /
  `beforeEach` / `afterEach`). Mirrors `tests/check/executor.test.ts`
  for sandbox setup and temp-dir hygiene.
- **Imports under test** (all paths in the red phase, none exist yet):
  - `checkFileExists` from `../../src/check/checks/file-exists.js`
  - `checkJsonParse` from `../../src/check/checks/json-parse.js`
  - `checkJsonSchema` from `../../src/check/checks/json-schema.js`
  - `checkRequiredFields` from `../../src/check/checks/required-fields.js`
  - `CheckResult` type from `../../src/check/index.js` (already exists).
- **Filesystem**: real temp directories under `os.tmpdir()` with
  `node:crypto.randomUUID()` suffixes; no fs mocking. Each test creates
  its own sandbox directory, writes the fixture files it needs, calls
  the check function, then removes the sandbox in `afterEach`.
- **Function signature (uniform across all four)**:

  ```ts
  function check<Kind>(opts: {
    with: Record<string, unknown>;
    runDir: string;
  }): Promise<CheckResult>;
  ```

  Paths in `with.file` / `with.files` / `with.schema` are resolved
  relative to `opts.runDir` (absolute paths honoured as-is).
- **`check_id` value**: the returned `check_id` matches the canonical
  kind identifier per `FP-FC-RESULT-SHAPE` (`"zigma/file-exists"`,
  `"zigma/json-parse"`, `"zigma/json-schema"`,
  `"zigma/required-fields"`). The Step 2 implementation hard-codes
  these strings inside each check function.
- **No event / state side-effects**: tests do not need to assert
  absence of event-log writes — the functions never receive a path to
  `events.jsonl` or `state.json`. The architectural contract
  (`FP-FC-NO-EVENTS`) is enforced by inspection / lint, not by these
  tests.
- **ajv expectation**: T-FC-5 and T-FC-6 require ajv 8 to be
  installed. The dependency is added to `package.json` in Step 2.
  Tests will fail at module-resolution time until Step 2 lands —
  acceptable red-phase behaviour.

## Architecture Decisions

1. **Per-kind file under `src/check/checks/`**. Each kind lives in its
   own file (`file-exists.ts`, `json-parse.ts`, `json-schema.ts`,
   `required-fields.ts`). This mirrors the docs/dev-plan deliverable
   list and keeps each check's import surface minimal (e.g. only
   `json-schema.ts` imports `ajv`).

2. **Pure functions, snake_case result shape**. Each check is a pure
   function `({ with, runDir }) → Promise<CheckResult>`. The result
   uses the snake_case shape from WF-P7-CHECK; the check function sets
   `check_id` directly to the canonical kind string.

3. **`with` arguments are validated at function entry**. Wrong-type
   inputs (e.g. `with.file` is a number) throw `CheckError` with
   `details: { kind, with }`. Semantic failures (file missing, JSON
   invalid) return `passed: false` with descriptive `failures[]`
   instead of throwing. The split matches mvp-contracts §7: throw for
   "check input missing/malformed"; return `passed: false` for
   "deterministic check failed".

4. **`ajv@8` draft-07 default; compile per invocation**. The
   `json-schema` check compiles the schema each call. Caching is
   TD-FC-3 — premature optimisation in MVP. The single ajv instance
   per call is constructed with `{ allErrors: true }` so all errors
   are collected into `failures[]`.

5. **Path resolution relative to `runDir`**. The check functions are
   invoked by `executeCheckStep`, which already has `runDir` in scope.
   Absolute paths are honoured; relative paths are joined under
   `runDir`. Cross-workflow workspace-root unification is TD-FC-1.

6. **`required-fields` checks top-level keys only in MVP**. Dotted
   nested paths (`report.summary`) are TD-FC-2. A field is "present
   and non-empty" iff:
   - object key exists AND
   - value is not `null`, AND
   - value is not the empty string `""`, AND
   - value is not an empty array `[]`.

7. **Registry update is in scope for Step 2 of this workflow**. The
   `LocalCheckRunner` in `src/check/index.ts` is updated to dispatch
   the four `"zigma/<kind>"` ids to the new check functions, replacing
   the WF-P7-CHECK "always throw" stub for these kinds. Other kinds
   (git family) still throw `CheckError` and will be added by
   WF-P7-GITCHECK.

## Red-Phase Expectations

- `src/check/checks/file-exists.ts`,
  `src/check/checks/json-parse.ts`,
  `src/check/checks/json-schema.ts`,
  `src/check/checks/required-fields.ts` do not exist yet; tests fail at
  module resolution.
- `ajv` is not yet a dependency; the json-schema tests will fail at
  module-resolution time even if the check source existed.
- `CheckResult` and the `CheckRunner` port already exist in
  `src/check/index.ts` from WF-P7-CHECK and are stable across this
  workflow.
- Tests should turn green after WF-P7-FILECHECK Step 2 ships all four
  source files and adds `ajv` to dependencies.

## Step 2 Handoff Notes

1. Each check function MUST export from its own file with the
   following signatures:

   ```ts
   // src/check/checks/file-exists.ts
   import type { CheckResult } from "../index.js";
   export function checkFileExists(opts: {
     with: Record<string, unknown>;
     runDir: string;
   }): Promise<CheckResult>;

   // src/check/checks/json-parse.ts
   export function checkJsonParse(opts: {
     with: Record<string, unknown>;
     runDir: string;
   }): Promise<CheckResult>;

   // src/check/checks/json-schema.ts
   export function checkJsonSchema(opts: {
     with: Record<string, unknown>;
     runDir: string;
   }): Promise<CheckResult>;

   // src/check/checks/required-fields.ts
   export function checkRequiredFields(opts: {
     with: Record<string, unknown>;
     runDir: string;
   }): Promise<CheckResult>;
   ```

2. `check_id` MUST equal the canonical kind identifier:
   `"zigma/file-exists"`, `"zigma/json-parse"`, `"zigma/json-schema"`,
   `"zigma/required-fields"`.

3. `artifacts` MUST be the empty array `[]` for all four kinds (they
   are pure-logic checks with no artifact outputs).

4. `failures[]` entries MUST be human-readable strings. Format
   conventions:
   - `file-exists`: `"<resolved-path>: file not found"` (path can be
     relative or absolute as-passed).
   - `json-parse`: `"<resolved-path>: SyntaxError at <location>"`
     where `<location>` is whatever the `SyntaxError.message` exposes
     (`position N`, `line X column Y`, etc.).
   - `json-schema`: `"<instancePath>: <message>"` from each ajv error
     (e.g. `": must have required property 'name'"`).
   - `required-fields`: `"<field>: missing"` or `"<field>: empty"`.

5. Malformed `with` (wrong type, missing required key) MUST throw
   `CheckError` (not return `passed: false`).

6. `src/check/index.ts` MUST register all four kinds in the
   `LocalCheckRunner` so `resolveKind("zigma/file-exists")` (etc.)
   succeeds and `run(...)` dispatches to the corresponding function.

7. `package.json` MUST add `ajv@^8` to `dependencies`.

## Test Gaps

- **Cross-kind end-to-end through `executeCheckStep`**: covered by
  WF-P7-CHECK's executor tests via FakeCheckRunner; this slice's tests
  exercise the check functions directly. An optional integration test
  that wires a real check kind through the executor is deferred to
  WF-P7-FILECHECK Step 3 (acceptance) — not required for unit-level
  red/green.
- **`required-fields` nested paths**: TD-FC-2. Not exercised here.
- **`json-schema` draft selection**: only draft-07 is tested. Future
  drafts (2019-09, 2020-12) are not in MVP scope.
- **Path-escape safety (`../../`)**: relied on `executeCheckStep` /
  artifact path-safety upstream. The check functions themselves do
  not re-validate path safety in MVP.
- **`CheckError` exit code propagation**: covered indirectly by
  WF-P7-CHECK T-CHECK-5; not duplicated here.
