# WF-P7-GITCHECK — Cases and Tests

- Workflow: WF-P7-GITCHECK
- Phase: P7 Check Step
- Step: 1 (Cases and Tests)
- Date: 2026-06-09
- Author: subagent (workflow Step 1)

## Slice Boundary

- Slice name: **P7-GITCHECK**
- Bounded contexts:
  - **GitInspector port + adapter** — `GitInspector` interface and the
    `SimpleGitInspector` adapter that wraps `simple-git` v3.x. Lives in
    `src/git/index.ts`. The port exposes two operations:
    `changedFiles(cwd): Promise<string[]>` and
    `diffExists(cwd): Promise<boolean>`. The adapter is the only place
    in the runtime that imports `simple-git`.
  - **Check Kind Implementations (git / path family)** — three
    deterministic check functions `git-diff-exists`, `forbidden-paths`,
    `protected-runtime-files`. Each is a pure function over
    `(opts) → Promise<CheckResult>`, accepts an optional `GitInspector`
    for injection, and returns the canonical snake_case `CheckResult`
    shape `{ passed, check_id, failures, artifacts }` (mvp-contracts
    §2.8, architecture §9.4).
  - **CheckRunner kind registry** — `LocalCheckRunner` in
    `src/check/index.ts` is extended to dispatch the three new
    `"zigma/<kind>"` ids to these check functions. Default
    `SimpleGitInspector` is constructed by the check functions when no
    inspector is injected (see D5 below).
- Bounded context interactions:
  - **Consumes** `CheckResult` and `CheckRunnerRunOpts` types from
    `src/check/index.ts` (delivered by WF-P7-CHECK; stable).
  - **Consumes** `CheckError` and `PermissionError` classes from
    `src/utils/errors.ts` (delivered by WF-P7-CHECK; stable).
  - **Consumes** Node `node:fs/promises`, `node:path`, `node:os`,
    `node:child_process` (only in `tests/git/inspector.test.ts` for
    creating a temp git repo), `simple-git` (only in
    `src/git/index.ts`), and `micromatch` (only in
    `src/check/checks/forbidden-paths.ts`).
  - **Produces** `CheckResult` values consumed by `executeCheckStep`
    (WF-P7-CHECK), which is the sole writer of `check-result.json`,
    `events.jsonl`, and `state.json`. This workflow MUST NOT touch
    those files.
  - **MUST NOT** modify `executeCheckStep` orchestration — that is a
    completed WF-P7-CHECK deliverable.
  - **MUST NOT** implement the file / JSON family kinds
    (`file-exists`, `json-parse`, `json-schema`, `required-fields`) —
    those are WF-P7-FILECHECK.
  - **MUST NOT** emit events, write state, or apply `on_pass` /
    `on_fail` decisions — the check kinds are pure functions returning
    `CheckResult`.
  - **MUST NOT** be imported by `src/engine/index.ts` directly;
    `simple-git` lives behind the `GitInspector` port (architecture
    §18 fitness function: `engine` does not import `simple-git`).

## Workflow Goal

Deliver the three MVP git / path check-kind implementations + the
`GitInspector` port and `SimpleGitInspector` adapter, so that an end
user whose workflow declares `uses: zigma/git-diff-exists`,
`uses: zigma/forbidden-paths`, or `uses: zigma/protected-runtime-files`
on a `type: check` step gets the expected deterministic gate
behaviour:

- The adapter calls `simple-git`'s `status()` and returns the flat list
  of changed files (staged + unstaged + untracked) and a boolean for
  whether any changes exist at all.
- The check function reads its `with` arguments (optional `cwd`,
  `paths` glob list for forbidden-paths, optional `run_dir` for
  protected-runtime-files).
- The check function consults the injected `GitInspector` (defaults to
  `SimpleGitInspector`) and returns a `CheckResult` whose `passed`
  flag and `failures[]` list accurately reflect the working-tree
  state.
- The executor (WF-P7-CHECK) writes the result as `check-result.json`,
  appends the canonical event sequence, and applies the state
  transition.

The slice satisfies architecture §13 phase 7 — "基础 gate 不依赖 LLM；
禁止路径修改失败；只读 step 修改文件失败" — for the git / path axes.

Deliverables (full workflow scope across all steps):

1. `src/git/index.ts` — `GitInspector` port interface +
   `SimpleGitInspector` adapter.
2. `src/check/checks/git-diff-exists.ts` — `checkGitDiffExists(opts)`.
3. `src/check/checks/forbidden-paths.ts` — `checkForbiddenPaths(opts)`.
4. `src/check/checks/protected-runtime-files.ts` —
   `checkProtectedRuntimeFiles(opts)`.
5. `src/check/index.ts` — `LocalCheckRunner` updated to register the
   three new kinds (replacing the WF-P7-CHECK "unknown kind" branch
   for these ids).
6. `package.json` — add `simple-git@^3` and `micromatch@^4`
   dependencies.
7. `tests/git/inspector.test.ts` — integration test using a real temp
   git repo (no mocking).
8. `tests/check/git-checks.test.ts` — unit tests using a local
   `FakeGitInspector` (dependency injection; no real git).

**Step 1 (this artifact) writes only the cases-and-tests document and
the two failing test files.** Source files, the registry update, and
the new dependencies ship in Step 2.

## "用户可完成" Milestones

Milestone count is capped at three (≤3 user task milestones budget).

- **M1 — diff-exists gate**: 用户在 workflow 中声明
  `uses: zigma/git-diff-exists` （可选 `with: { cwd: <repo> }`）：
  工作树存在任意 staged / unstaged / untracked 改动时
  check passed；完全没有改动时 check failed，`failures[0]` 描述为
  `"no diff in <cwd>"`. 这条 gate 用于 review job 校验"上游 step
  确实产出了改动"。

- **M2 — forbidden-paths gate**: 用户声明
  `uses: zigma/forbidden-paths` 且 `with: { paths: [<glob>, ...] }`
  （可选 `cwd`）：working tree 改动文件命中任一 glob pattern 时
  check failed，`failures[]` 列出每个命中的文件 +
  matched pattern；没有命中时 check passed. 这条 gate 用于
  阻止 secrets / 生成文件 / lockfile 被意外修改。

- **M3 — protected-runtime-files gate**: 用户声明
  `uses: zigma/protected-runtime-files`（可选 `cwd`、
  `run_dir`）：working tree 改动命中
  `.zigma-flow/runs/*/state.json` 或
  `.zigma-flow/runs/*/events.jsonl` 时 check failed，
  `failures[]` 列出每个被触碰的 runtime 文件；没有命中时
  check passed. 这条 gate 直接落 architecture §11
  "`.zigma-flow/runs/*/state.json`、`events.jsonl` 和 lock snapshot
  属于 runtime 保护路径" 的硬约束。

每个 milestone 与 WF-P7-CHECK 的 executor 拼装后，最终用户可执行：

```
zigma-flow run --workflow code-change.yml
zigma-flow step --job verify
```

得到正确的 `check-result.json`、`check_completed` 事件与 job 状态。

## Spec Compliance Matrix

下表覆盖 prd.md FR-008、architecture.md §9.4 / §11 / §13 phase 7 /
§16, mvp-contracts.md §2.8 / §7 中本工作流相关的 MUST / SHALL 条款。
RC-GC-* 条款编号沿用 WF-P7-FILECHECK 的 RC-FC-* 命名约定但区分前缀避免
冲突。Spec clause budget: 13 in-scope clauses (RC-GC-1..13) + 2
technical-debt registrations (TD-GC-1, TD-GC-2)；total = 15
references，符合 ≤15 spec mandatory clause references 预算。

| Clause ID | Clause Source | Clause Text | Status |
| --- | --- | --- | --- |
| RC-GC-1 | prd §FR-008 | MVP 支持 git diff 是否存在 check. | 已纳入本工作流 — FP-GC-DIFF-EXISTS；T-GC-1, T-GC-2. |
| RC-GC-2 | prd §FR-008 | MVP 支持禁止路径是否被修改 check. | 已纳入本工作流 — FP-GC-FORBIDDEN-PATHS；T-GC-3, T-GC-4. |
| RC-GC-3 | prd §FR-008 | MVP 支持敏感 state 文件是否被修改 check. | 已纳入本工作流 — FP-GC-PROTECTED-RUNTIME；T-GC-5, T-GC-6. |
| RC-GC-4 | prd §FR-008 | 检查通过时写入 check-result artifact. | 由 WF-P7-CHECK executor 完成；本工作流提供合规 `CheckResult` 返回值. |
| RC-GC-5 | prd §FR-008 | 检查失败时列出失败项. | 已纳入本工作流 — `failures[]` 在 T-GC-1, T-GC-4, T-GC-6 非空且语义化. |
| RC-GC-6 | prd §FR-008 | 基础 gate 不依赖 LLM Judge. | 已纳入本工作流 — 三个 check 函数仅依赖 `GitInspector` 端口 + `micromatch`. |
| RC-GC-7 | mvp-contracts §2.8 | `CheckResult` 字段 `{ passed, check_id, failures, artifacts }`. | 已纳入本工作流 — `expectCheckResultShape()` 在所有测试中显式验证返回 shape. |
| RC-GC-8 | mvp-contracts §2.8 | Check Step 是确定性 gate, 不依赖 LLM Judge. | 同 RC-GC-6. |
| RC-GC-9 | mvp-contracts §7 (CheckError) | `CheckError` 触发于 check 输入缺失或 check 执行失败. | 已纳入本工作流 — 输入参数格式错误 (`paths` 不是 string[]、`cwd` 不是 string) 抛出 `CheckError`；working-tree 语义失败返回 `passed: false`. |
| RC-GC-10 | mvp-contracts §7 (PermissionError) | `PermissionError` 触发于禁止路径修改、state 文件被触碰. | 接受为 design choice：MVP 下 `forbidden-paths` 和 `protected-runtime-files` 通过 `passed: false` + `failures[]` 报告，不抛 `PermissionError`. 是否在 executor 层升级为 `PermissionError` 由 WF-P7-CHECK gate 处理决定，本 slice 不做映射；记 TD-GC-2. |
| RC-GC-11 | architecture §9.4 | Script Runner 和 Check Runner 只产出结果. | 已纳入本工作流 — 三个 check 函数无 event/state 副作用. |
| RC-GC-12 | architecture §11 | `.zigma-flow/runs/*/state.json` 和 `events.jsonl` 是 runtime 保护路径. | 已纳入本工作流 — `protected-runtime-files` check 硬编码这两条 glob pattern；T-GC-6 验证 fail 行为. |
| RC-GC-13 | architecture §13 phase 7 / §16 | 禁止路径修改失败；只读 step 修改文件失败；临时 git repo 集成测试. | 已纳入本工作流 — T-GC-7 在真实临时 git repo 内创建+修改文件，断言 `SimpleGitInspector.changedFiles()` / `diffExists()` 返回正确结果. |
| TD-GC-1 | architecture §11 (workspace) | `cwd` 解析的根目录策略：本 slice 默认采纳 `with.cwd` 若提供，否则使用 `opts.runDir`. 项目工作区根目录的统一解析（cwd / repo root）由后续 WF-P8-WORKSPACE 收敛. | 技术债 — TD-GC-1（P8 落地）. |
| TD-GC-2 | mvp-contracts §7 (PermissionError) | `forbidden-paths` / `protected-runtime-files` 失败是否在 executor 层映射为 `PermissionError`（而非 `CheckError`）由 P8 Workspace Guard 决定. | 技术债 — TD-GC-2（P8 落地, TD-P7-003 carry）. |

## Functional Points

| FP id | Area | Source | Summary |
| --- | --- | --- | --- |
| FP-GC-INSPECTOR-PORT | `GitInspector` port interface | arch §9.4, §18 | `interface GitInspector { changedFiles(cwd: string): Promise<string[]>; diffExists(cwd: string): Promise<boolean>; }`. 在 `src/git/index.ts` 导出. 不接受任何配置；纯查询接口. |
| FP-GC-INSPECTOR-ADAPTER | `SimpleGitInspector` adapter | arch §9.4, §18 | `class SimpleGitInspector implements GitInspector`. 内部调用 `simpleGit(cwd).status()`. `changedFiles()` 返回 `not_added ∪ modified ∪ created ∪ renamed.to ∪ deleted ∪ staged ∪ conflicted` 的 deduped 数组 (`simple-git` 的 `StatusResult.files` 字段已经聚合了这些路径，使用 `files.map(f => f.path)` 即可). `diffExists()` 实现为 `(await changedFiles(cwd)).length > 0`. |
| FP-GC-DIFF-EXISTS | `git-diff-exists` check kind | prd FR-008, mvp §2.8 | Accept `with.cwd?: string`. 调用 `git.diffExists(cwd ?? opts.runDir)`. Pass iff `true`. Fail with `failures: ["no diff in <cwd>"]`. Optional `GitInspector` 注入参数 (`opts.git`); 默认构造 `new SimpleGitInspector()`. |
| FP-GC-FORBIDDEN-PATHS | `forbidden-paths` check kind | prd FR-008, mvp §2.8 | Accept `with.cwd?: string`, `with.paths: string[]`. `paths` 是 glob pattern 列表 (e.g. `["**/*.secret", "node_modules/**"]`). 调用 `git.changedFiles(cwd ?? opts.runDir)` → `string[]`. 使用 `micromatch(changedFiles, paths)` 取交集. Pass iff 交集为空. Fail with `failures[]` 列出每个命中的 `<file>` (matched against `<pattern>`). 输入校验失败 (`paths` 缺失或非 string[]) 抛 `CheckError`. |
| FP-GC-PROTECTED-RUNTIME | `protected-runtime-files` check kind | prd FR-008, mvp §2.8, arch §11 | Accept `with.cwd?: string`, `with.run_dir?: string`. 调用 `git.changedFiles(cwd ?? opts.runDir)` → `string[]`. 硬编码 patterns: `.zigma-flow/runs/*/state.json`, `.zigma-flow/runs/*/events.jsonl` (使用 `micromatch` 验证). Pass iff 没有命中. Fail with `failures[]` 列出每个被触碰的 runtime 文件. `with.run_dir` 在 MVP 仅作记录用，不改变 patterns（见 D3 architecture decision）. |
| FP-GC-RESULT-SHAPE | `CheckResult` snake_case | arch §9.4, mvp §2.8 | 三个函数均返回 `{ passed: boolean, check_id: string, failures: string[], artifacts: string[] }`. `artifacts` 始终是 `[]`. `check_id` 为 canonical kind id (`"zigma/git-diff-exists"` etc.). |
| FP-GC-NO-EVENTS | No state/event mutation | arch §13 phase 7 fitness | 三个函数均不 import `events`、`run`、`engine` 模块；只 import `GitInspector` interface + `node:path` + 可选 `micromatch`. 由 Step 2 实现时通过 import-graph 检查保证. |
| FP-GC-DI-DEFAULT | Default inspector | arch §6 (ports) | 三个函数签名带可选 `git?: GitInspector` 参数. 未注入时使用 `new SimpleGitInspector()`. 测试通过 `FakeGitInspector` 注入；生产代码由 `LocalCheckRunner.run()` 透传（或不传，让 check 自取默认）. |
| FP-GC-REGISTRY | Built-in registration | arch §9.4 | `LocalCheckRunner` (`src/check/index.ts`) 在 `KNOWN_KINDS` 集合中追加 `"zigma/git-diff-exists"`, `"zigma/forbidden-paths"`, `"zigma/protected-runtime-files"` 三个 ids；`run()` switch 追加对应分支，调用本 slice 三个 check 函数. |
| FP-GC-PATH-RESOLUTION | cwd resolution | arch §11 (Workspace) | `with.cwd` 若提供且为 string 即直接使用；否则 fallback 到 `opts.runDir`. Absolute paths 透传，relative paths 由调用方（执行 cwd 时 `simple-git` 会内部处理）保持原样. TD-GC-1 追踪跨工作流统一. |

## Use Case Enumeration

| UC id | Actor | Trigger | Pre-conditions | Steps (happy path / failure) | Post-conditions / observable result |
| --- | --- | --- | --- | --- | --- |
| UC-GC-1 | CheckRunner | `checkGitDiffExists({ with: {}, runDir, git: fake })` invoked; `fake.diffExists()` returns `false`. | Working tree clean (or fake says so). | `git.diffExists(runDir)` → `false` → return `{ passed: false, failures: ["no diff in <runDir>"], ... }`. | `passed === false`; `failures[0]` 描述无 diff. |
| UC-GC-2 | CheckRunner | Same with fake returning `true`. | Working tree dirty. | `git.diffExists()` → `true` → return `passed: true, failures: []`. | `passed === true`. |
| UC-GC-3 | CheckRunner | `checkForbiddenPaths({ with: { paths: ["**/*.secret"] }, runDir, git: fake })`; fake returns `["src/main.ts", "README.md"]`. | No changed file matches `**/*.secret`. | `micromatch(["src/main.ts", "README.md"], ["**/*.secret"])` → `[]` → return `passed: true`. | `passed === true`; `failures: []`. |
| UC-GC-4 | CheckRunner | Same with fake returning `["config/api.secret", "src/util.ts"]`. | `config/api.secret` matches `**/*.secret`. | `micromatch(...)` → `["config/api.secret"]` → return `passed: false, failures: ["config/api.secret: matched forbidden pattern **/*.secret"]`. | `passed === false`; `failures` 至少包含被命中文件名. |
| UC-GC-5 | CheckRunner | `checkProtectedRuntimeFiles({ with: {}, runDir, git: fake })`; fake returns `["src/main.ts", "docs/notes.md"]`. | No changed file matches `.zigma-flow/runs/*/state.json` or `events.jsonl`. | `micromatch(...)` → `[]` → return `passed: true`. | `passed === true`. |
| UC-GC-6 | CheckRunner | Same with fake returning `[".zigma-flow/runs/abc/state.json", "src/x.ts"]`. | `.zigma-flow/runs/abc/state.json` matches the hardcoded protected pattern. | `micromatch(...)` → `[.zigma-flow/runs/abc/state.json]` → return `passed: false, failures: [".zigma-flow/runs/abc/state.json: protected runtime file modified"]`. | `passed === false`; `failures` 至少包含被命中的 state.json 路径. |
| UC-GC-7 | Test harness | `SimpleGitInspector.changedFiles(tempRepo)` invoked. | Temp dir contains `git init` + identity config; a file is created, staged, then modified on disk. | `simpleGit(tempRepo).status()` → 返回包含该文件的 `StatusResult` → adapter 输出 `string[]` 含该文件路径. | `changedFiles().length >= 1` AND `diffExists() === true`. Clean repo（无文件改动）下 `changedFiles() === []` AND `diffExists() === false`. |

## Test Plan

Two test files. Total of 9 `it` cases mapped to the 7 mandated test
IDs (T-GC-1..T-GC-7); T-GC-7 expands into two `it` cases inside one
test ID because the integration test asserts both the "with changes"
and the "clean repo" branches against a single temp-repo setup (kept
under the ≤2 test-file budget).

### `tests/check/git-checks.test.ts` (T-GC-1..T-GC-6)

Vitest. Local `FakeGitInspector implements GitInspector`. Each test
constructs the fake with canned `changedFiles` / `diffExists` return
values, instantiates the check function with the fake injected, and
asserts on the returned `CheckResult`.

| Test id | `it` description | What it verifies | UCs covered | FPs covered | RCs touched |
| --- | --- | --- | --- | --- | --- |
| T-GC-1 | `git-diff-exists — fails when no diff is present` | Fake returns `diffExists: false`; assert `passed === false`, `check_id === "zigma/git-diff-exists"`, `failures.length >= 1` mentioning "no diff", `artifacts: []`. | UC-GC-1 | FP-GC-DIFF-EXISTS, FP-GC-DI-DEFAULT, FP-GC-RESULT-SHAPE | RC-GC-1, RC-GC-5, RC-GC-7, RC-GC-8 |
| T-GC-2 | `git-diff-exists — passes when working tree has changes` | Fake returns `diffExists: true`; assert `passed === true`, `failures: []`. | UC-GC-2 | FP-GC-DIFF-EXISTS, FP-GC-RESULT-SHAPE | RC-GC-1, RC-GC-7, RC-GC-8 |
| T-GC-3 | `forbidden-paths — passes when no changed file matches any pattern` | Fake returns `["src/main.ts", "README.md"]`; `paths: ["**/*.secret"]`; assert `passed === true`, `failures: []`. | UC-GC-3 | FP-GC-FORBIDDEN-PATHS, FP-GC-RESULT-SHAPE | RC-GC-2, RC-GC-7, RC-GC-8 |
| T-GC-4 | `forbidden-paths — fails listing each matched file with its pattern` | Fake returns `["config/api.secret", "src/util.ts"]`; `paths: ["**/*.secret"]`; assert `passed === false`, `failures.length >= 1`, `failures[i]` contains `config/api.secret`. | UC-GC-4 | FP-GC-FORBIDDEN-PATHS, FP-GC-RESULT-SHAPE | RC-GC-2, RC-GC-5, RC-GC-7, RC-GC-8 |
| T-GC-5 | `protected-runtime-files — passes when no runtime file is touched` | Fake returns `["src/main.ts", "docs/notes.md"]`; assert `passed === true`, `failures: []`. | UC-GC-5 | FP-GC-PROTECTED-RUNTIME, FP-GC-RESULT-SHAPE | RC-GC-3, RC-GC-7, RC-GC-8, RC-GC-12 |
| T-GC-6 | `protected-runtime-files — fails when state.json under .zigma-flow/runs/* is changed` | Fake returns `[".zigma-flow/runs/abc/state.json", "src/x.ts"]`; assert `passed === false`, at least one `failures[i]` contains `.zigma-flow/runs/abc/state.json`. | UC-GC-6 | FP-GC-PROTECTED-RUNTIME, FP-GC-RESULT-SHAPE | RC-GC-3, RC-GC-5, RC-GC-7, RC-GC-8, RC-GC-12 |

### `tests/git/inspector.test.ts` (T-GC-7)

Vitest. Integration test using a real temp directory + child-process
`git` invocations. NO mocking of `simple-git`. Two `it` cases under
one test ID, covering the "with changes" and "clean repo" branches.

| Test id | `it` description | What it verifies | UCs covered | FPs covered | RCs touched |
| --- | --- | --- | --- | --- | --- |
| T-GC-7 (a) | `SimpleGitInspector — reports modified files and diffExists=true in a dirty temp repo` | `git init` + identity config; create file `notes.txt`; `git add` it; modify it on disk (now both staged and unstaged); assert `changedFiles(cwd)` returns array containing `notes.txt`; assert `diffExists(cwd) === true`. | UC-GC-7 | FP-GC-INSPECTOR-PORT, FP-GC-INSPECTOR-ADAPTER | RC-GC-13 |
| T-GC-7 (b) | `SimpleGitInspector — reports no changes for a freshly committed repo` | `git init` + identity config; create + add + commit a single file; assert `changedFiles(cwd)` is `[]` and `diffExists(cwd) === false`. | UC-GC-7 | FP-GC-INSPECTOR-PORT, FP-GC-INSPECTOR-ADAPTER | RC-GC-13 |

## Test Design Summary

- **Test framework**: vitest (`describe` / `it` / `expect` /
  `beforeEach` / `afterEach`). Mirrors the existing
  `tests/check/checks.test.ts` for sandbox setup and temp-dir hygiene.
- **Imports under test** (red phase — none exist yet):
  - `GitInspector` interface from `../../src/git/index.js`
  - `SimpleGitInspector` from `../../src/git/index.js`
  - `checkGitDiffExists` from `../../src/check/checks/git-diff-exists.js`
  - `checkForbiddenPaths` from `../../src/check/checks/forbidden-paths.js`
  - `checkProtectedRuntimeFiles` from `../../src/check/checks/protected-runtime-files.js`
  - `CheckResult` type from `../../src/check/index.js` (already exists).
- **`FakeGitInspector`**: declared locally in
  `tests/check/git-checks.test.ts`. Stores two arrays (`changedFiles`,
  `diffExists`) provided at construction; the
  `changedFiles(cwd)` / `diffExists(cwd)` methods return the canned
  values regardless of `cwd`. This satisfies the `GitInspector`
  contract for unit tests without depending on real git state.
- **Temp git repo construction (T-GC-7)**: uses `node:child_process`
  `execFileSync("git", [...], { cwd: tmpDir })` to run `git init`,
  `git config user.email "test@local"`, `git config user.name "Test"`,
  `git add`, `git commit`. `simple-git` itself is exercised only via
  `SimpleGitInspector`. Tests run sequentially; each test creates +
  removes its own temp dir.
- **Function signature (uniform across all three kinds)**:

  ```ts
  function check<Kind>(opts: {
    with: Record<string, unknown>;
    runDir: string;
    git?: GitInspector;
  }): Promise<CheckResult>;
  ```

- **`check_id` values**: `"zigma/git-diff-exists"`,
  `"zigma/forbidden-paths"`, `"zigma/protected-runtime-files"` — hard
  coded inside the check functions in Step 2.
- **No event / state side-effects**: tests do not need to assert
  absence of event-log writes — the functions never receive paths to
  `events.jsonl` or `state.json`. Architectural contract
  (`FP-GC-NO-EVENTS`) is enforced by Step 2 inspection / lint.

## Architecture Decisions

1. **Per-kind file under `src/check/checks/`** (D1). Each kind lives
   in its own file (`git-diff-exists.ts`, `forbidden-paths.ts`,
   `protected-runtime-files.ts`). Matches the precedent set by
   WF-P7-FILECHECK and keeps each check's import surface minimal —
   only `forbidden-paths.ts` and `protected-runtime-files.ts` import
   `micromatch`; only the `GitInspector` interface is imported
   from `../../git/index.js` (NOT the concrete `SimpleGitInspector`,
   unless used as the default factory).

2. **`GitInspector` is a port, `SimpleGitInspector` is the adapter**
   (D2). The port lives in `src/git/index.ts` alongside the adapter
   so that the check functions only need one import. The architectural
   rule (arch §18) "engine 不得 import `simple-git`" is upheld by
   importing the interface, not the class. `executeCheckStep` does
   not transitively pick up `simple-git` because it does not import
   check function modules directly — it goes through
   `LocalCheckRunner.run()`, which is the only construction site of
   `SimpleGitInspector` if the executor opts to inject one.

3. **Glob library: `micromatch@^4`** (D3 — **the load-bearing
   architecture decision for this slice**). The forbidden-paths and
   protected-runtime-files kinds need glob pattern matching against
   the changed-files list. Candidates considered:

   | Library | Pros | Cons |
   | --- | --- | --- |
   | **`micromatch`** | Battle-tested (used by webpack, jest, vitest indirectly); fast (no regex compilation per match); supports `**` and negation; pure JS, no native deps; well-typed via `@types/micromatch`. | Adds one runtime dep + one dev dep (`@types/micromatch`). |
   | `minimatch` | Classic, simpler API; smaller. | Slower; weaker `**` semantics in older versions; npm wants v9+ for ESM. |
   | `simple-git`'s own path filtering | Reuses already-loaded dep. | Not a documented public API; couples check kind to simple-git's behaviour; brittle. |
   | Manual `RegExp` | Zero dep. | Re-implementing glob correctly is a security/correctness footgun; rejected. |

   **Decision: use `micromatch@^4`.** Reasons:
   - It is the de-facto npm glob matcher and has stable `**`
     semantics that work cross-platform (Windows path separators are
     handled internally).
   - It is already a transitive dep of `vitest` and `tsup`, so the
     bundle-size impact is essentially zero.
   - It supports the `paths: string[]` input shape directly:
     `micromatch(changedFiles, patterns)` returns the matched subset
     in one call.
   - Forward-compatible with future check kinds that need glob
     matching (e.g. `read-only-paths`).

   Step 2 will add `"micromatch": "^4.0.5"` to `dependencies` and
   `"@types/micromatch": "^4.0.9"` to `devDependencies`.

4. **`protected-runtime-files` patterns are hardcoded** (D4). The two
   patterns `.zigma-flow/runs/*/state.json` and
   `.zigma-flow/runs/*/events.jsonl` are constants inside the check
   function. The `with.run_dir` field is accepted (so a future
   workflow can pass the runtime root explicitly) but in MVP it is
   **only used for the error message context** — the patterns
   themselves are not parameterised. Rationale: architecture §11
   declares these paths as runtime-protected globally; making them
   per-call configurable would create a way for a workflow author to
   "opt out" of the protection by passing a custom `run_dir`. The
   hardcoded patterns close that hole. (If a future user needs a
   custom runtime root, they can use `forbidden-paths` instead.)

5. **Default `GitInspector` factory** (D5). The three check functions
   accept an optional `git?: GitInspector` parameter. When absent,
   each function constructs `new SimpleGitInspector()` internally.
   Alternative design (rejected): require the executor / runner to
   inject the inspector. Reason for current design: keeps the check
   function's public contract simple (matches the
   `({ with, runDir }) → CheckResult` shape of WF-P7-FILECHECK while
   adding only an optional injection knob); `LocalCheckRunner` can
   continue to call the check functions without knowing about
   `simple-git`. Tests inject a `FakeGitInspector` and never touch
   real git.

6. **`cwd` resolution** (D6). `with.cwd` is honoured if it is a
   string; otherwise the check uses `opts.runDir`. Absolute paths
   are passed straight to `simple-git`; relative paths are passed
   as-is and resolved by `simple-git` against `process.cwd()` at
   call time. The cross-workflow path-root unification is TD-GC-1
   (carry of TD-FC-1 from WF-P7-FILECHECK).

7. **Result shape** (D7). All three checks return:

   ```ts
   {
     passed: boolean,
     check_id: "zigma/<kind>",
     failures: string[],
     artifacts: []
   }
   ```

   `artifacts` is always `[]` — these are pure-logic checks. Failure
   strings are human-readable and reference both the matched file and
   the matched pattern (forbidden-paths) or the protected path label
   (protected-runtime-files).

8. **Input validation** (D8). Wrong-type `with` inputs throw
   `CheckError` (NOT `passed: false`). Examples:
   - `forbidden-paths` with `paths` missing or not a `string[]` →
     `CheckError("forbidden-paths: with.paths must be a string[]")`.
   - `git-diff-exists` with `cwd` provided but not a string →
     `CheckError("git-diff-exists: with.cwd must be a string")`.
   - `protected-runtime-files` with `run_dir` provided but not a
     string → `CheckError("protected-runtime-files: with.run_dir must be a string")`.

   Semantic failures (no diff, matched forbidden file, touched
   protected file) return `passed: false`. This matches the
   mvp-contracts §7 split. The red-phase tests do not assert the
   `CheckError` paths (no T-GC ID for it) — covered indirectly by
   WF-P7-CHECK T-CHECK-5 and Step 2 may add explicit assertions if
   the implementor wishes.

9. **`SimpleGitInspector.changedFiles()` source field**. The adapter
   uses `simpleGit(cwd).status()` and returns `status.files.map(f =>
   f.path)`. The `StatusResult.files` field in simple-git v3 already
   aggregates `not_added`, `modified`, `created`, `deleted`,
   `renamed`, `staged`, and `conflicted`. This is exactly the union
   required by the dev-plan ("staged + unstaged + untracked"). For
   renames, `f.path` is the new path; the old path is in
   `status.renamed[i].from` and is intentionally NOT included in
   MVP.

## Red-Phase Expectations

- `src/git/index.ts` does not exist yet — both test files fail at
  module resolution on the `GitInspector` and `SimpleGitInspector`
  imports.
- `src/check/checks/git-diff-exists.ts`,
  `src/check/checks/forbidden-paths.ts`,
  `src/check/checks/protected-runtime-files.ts` do not exist yet —
  `tests/check/git-checks.test.ts` fails at module resolution.
- `simple-git` and `micromatch` are not yet dependencies —
  `tests/git/inspector.test.ts` would also fail at runtime even if
  the source existed.
- `CheckResult` type is already exported from
  `src/check/index.ts` (WF-P7-CHECK) and is stable across this
  workflow.
- Tests should turn green after WF-P7-GITCHECK Step 2 ships the
  source files, registers the kinds in `LocalCheckRunner`, and adds
  the two new dependencies.

## Step 2 Handoff Notes

1. **`src/git/index.ts` MUST export the following surface**:

   ```ts
   export interface GitInspector {
     changedFiles(cwd: string): Promise<string[]>;
     diffExists(cwd: string): Promise<boolean>;
   }

   export class SimpleGitInspector implements GitInspector {
     async changedFiles(cwd: string): Promise<string[]> { ... }
     async diffExists(cwd: string): Promise<boolean> { ... }
   }
   ```

   `SimpleGitInspector` MAY take an optional constructor argument
   (e.g. a factory for `simpleGit()`) for advanced testing; not
   required for MVP.

2. **`src/check/checks/<kind>.ts` MUST export the following
   signatures**:

   ```ts
   // src/check/checks/git-diff-exists.ts
   import type { CheckResult } from "../index.js";
   import type { GitInspector } from "../../git/index.js";

   export async function checkGitDiffExists(opts: {
     with: Record<string, unknown>;
     runDir: string;
     git?: GitInspector;
   }): Promise<CheckResult>;

   // src/check/checks/forbidden-paths.ts
   export async function checkForbiddenPaths(opts: {
     with: Record<string, unknown>;
     runDir: string;
     git?: GitInspector;
   }): Promise<CheckResult>;

   // src/check/checks/protected-runtime-files.ts
   export async function checkProtectedRuntimeFiles(opts: {
     with: Record<string, unknown>;
     runDir: string;
     git?: GitInspector;
   }): Promise<CheckResult>;
   ```

3. **`check_id` MUST equal the canonical kind identifier**:
   `"zigma/git-diff-exists"`, `"zigma/forbidden-paths"`,
   `"zigma/protected-runtime-files"`.

4. **`artifacts` MUST be the empty array `[]`** for all three kinds.

5. **`failures[]` entries MUST be human-readable strings**. Format
   conventions:
   - `git-diff-exists`: `"no diff in <cwd>"`.
   - `forbidden-paths`: `"<file>: matched forbidden pattern <pattern>"`
     — one entry per (file, matched pattern) pair; if a file matches
     multiple patterns, list only the first match.
   - `protected-runtime-files`:
     `"<file>: protected runtime file modified"` — one entry per
     touched file.

6. **Malformed `with` MUST throw `CheckError`** (NOT return
   `passed: false`). See D8 for the matrix.

7. **`src/check/index.ts` MUST register all three kinds in the
   `LocalCheckRunner`**:

   ```ts
   const KNOWN_KINDS = new Set([
     "zigma/file-exists",
     "zigma/json-parse",
     "zigma/json-schema",
     "zigma/required-fields",
     // New in WF-P7-GITCHECK:
     "zigma/git-diff-exists",
     "zigma/forbidden-paths",
     "zigma/protected-runtime-files",
   ]);
   ```

   And add the corresponding `switch` branches in `run()`:

   ```ts
   case "zigma/git-diff-exists":
     return checkGitDiffExists({ with: w, runDir });
   case "zigma/forbidden-paths":
     return checkForbiddenPaths({ with: w, runDir });
   case "zigma/protected-runtime-files":
     return checkProtectedRuntimeFiles({ with: w, runDir });
   ```

   The runner does NOT pass a `git` parameter; each check function
   constructs `new SimpleGitInspector()` itself when absent (D5).

8. **`package.json` MUST add**:
   - `"simple-git": "^3.27.0"` to `dependencies`.
   - `"micromatch": "^4.0.5"` to `dependencies`.
   - `"@types/micromatch": "^4.0.9"` to `devDependencies`.

9. **Architecture-fitness checks** (Step 2 self-review):
   - `src/engine/index.ts` does NOT import `simple-git` (direct or
     transitive). Verify by `grep -n 'simple-git' src/engine/`.
   - `src/check/executor.ts` does NOT import `simple-git` or
     `SimpleGitInspector`. It MAY import the `GitInspector`
     interface type for future use, but currently does not need to.
   - `src/check/checks/*.ts` import the `GitInspector` interface from
     `../../git/index.js`; only the new git checks may also import
     `SimpleGitInspector` as a default factory.

## Test Gaps

- **Cross-kind end-to-end through `executeCheckStep`**: covered by
  WF-P7-CHECK's executor tests via `FakeCheckRunner`; this slice's
  tests exercise the check functions directly. An optional end-to-end
  integration test that wires the real `SimpleGitInspector` through
  `LocalCheckRunner.run()` → `executeCheckStep` is deferred to
  WF-P7-GITCHECK Step 3 (acceptance) — not required for unit-level
  red/green.
- **`CheckError` paths**: the three "malformed `with`" branches (D8)
  are not asserted in the red-phase tests; Step 2 may add three more
  `it` cases if desired, or rely on indirect coverage via T-CHECK-5.
- **`PermissionError` mapping**: TD-GC-2. The executor-level mapping
  of forbidden-paths / protected-runtime-files failures to
  `PermissionError` (vs. `CheckError`) is deferred to P8 with the
  Workspace Guard work.
- **Path resolution under absolute vs. relative `cwd`**: covered
  implicitly — the temp-repo integration test passes the absolute
  temp-dir path; the FakeGitInspector tests do not need to validate
  cwd resolution because the fake ignores `cwd`. A dedicated
  cwd-resolution test is deferred.
- **`simple-git` rename / conflict handling**: D9 captures the chosen
  semantics (use `f.path`, ignore old path in renames; conflicted
  files are still listed). No dedicated test in MVP.
- **Cross-platform path separators**: `micromatch` is documented to
  normalise to POSIX separators internally; the test fixture file
  paths in T-GC-3..T-GC-6 use POSIX separators. A dedicated Windows-
  separator test is deferred to TD-GC-1.
