---
date: 2026-06-10
authority: docs/prd.md §20 (FR-014), docs/architecture.md §6.2, docs/mvp-contracts.md §2.8
---

# WF-P8-WSGUARD — Cases and Tests

- Workflow: WF-P8-WSGUARD
- Phase: P8 Router Step, Multi-step Advancement, Signal Handling, Workspace Guard
- Step: 1 (Cases and Tests)
- Date: 2026-06-10
- Author: subagent (workflow Step 1)

## Slice Boundary

- Slice name: **P8-WSGUARD**
- Bounded contexts:
  - **WorkspaceGuard port + adapter** — `WorkspaceGuard` interface and
    the `SimpleWorkspaceGuard` adapter that wraps `GitInspector`
    (delivered by WF-P7-GITCHECK). Lives in `src/workspace/index.ts`.
    The port exposes one query operation:
    `detectModifications(cwd, opts?): Promise<WorkspaceModification[]>`.
    The adapter is the only place in `src/workspace/` that constructs
    `SimpleGitInspector`. The runtime always treats the two protected
    runtime patterns
    (`.zigma-flow/runs/*/state.json`,
    `.zigma-flow/runs/*/events.jsonl`)
    as forbidden in addition to the read-only blanket constraint.
  - **Read-only Job Constraint** — the `workspace: { mode: "read-only" }`
    job-level field (PRD FR-014; mvp-contracts §2.1) translates to a
    post-step gate that runs `WorkspaceGuard.detectModifications(cwd)`.
    Any non-empty modification list fails the step.
- Bounded context interactions:
  - **Consumes** `GitInspector` interface from `src/git/index.ts`
    (delivered by WF-P7-GITCHECK; stable).
  - **Consumes** `PermissionError` class from `src/utils/errors.ts`
    (already defined; mvp-contracts §7).
  - **Produces** a `WorkspaceModification[]` value (or empty array)
    consumed by the Engine integration point delivered by
    WF-P8-SIGNALS. This workflow does NOT call the Engine, write
    state.json, emit events, or apply on_pass / on_fail decisions —
    it is a pure query function on top of `GitInspector`.
  - **MUST NOT** modify `src/engine/index.ts` orchestration — Engine
    invocation timing is owned by WF-P8-SIGNALS (or the existing
    `executeCurrentStep` in subsequent integration work).
  - **MUST NOT** modify the P7 check kinds (`zigma/git-diff-exists`,
    `zigma/forbidden-paths`, `zigma/protected-runtime-files`) — they
    remain reusable as explicit gates inside any workflow.
  - **MUST NOT** be imported by `src/engine/index.ts` as a concrete
    adapter — Engine depends on `WorkspaceGuard` interface only;
    `SimpleWorkspaceGuard` is wired at the CLI/composition root
    (mirrors the GitInspector pattern from P7).
  - **MUST NOT** silently bypass the protected runtime patterns even
    when the job's `workspace.mode` is `writable` — the protected
    patterns from architecture §11 remain enforced by the P7
    `protected-runtime-files` check, which is independent of this
    guard. This slice's reach is the read-only job constraint.

## Workflow Goal

Deliver the `WorkspaceGuard` port and `SimpleWorkspaceGuard` adapter
so that an end user whose job declares
`workspace: { mode: "read-only" }` gets the expected deterministic
post-step behaviour:

- The adapter queries the injected (or constructed default)
  `GitInspector` for the working tree's changed files.
- The guard returns the modification list (file path + classification
  hint such as `"git-changed"` or `"protected-runtime"`); an empty
  array means the working tree is clean and the read-only step may be
  marked completed.
- A non-empty list signals the Engine integration point to emit
  `step_failed` with reason `"workspace_guard_detected_modifications"`,
  transition the job to `failed`, and optionally raise
  `PermissionError` per mvp-contracts §7.
- The protected runtime patterns
  (`.zigma-flow/runs/*/state.json`, `.zigma-flow/runs/*/events.jsonl`)
  are always reported as modifications in read-only mode, even if the
  job definition does not explicitly list them — this closes the
  "opt-out by silence" hole.

This slice satisfies architecture §13 phase 7 (carried into P8) —
"基础 gate 不依赖 LLM；只读 step 修改文件失败" — for the workspace
axis.

Deliverables (full workflow scope across all steps):

1. `src/workspace/index.ts` — `WorkspaceGuard` port interface,
   `WorkspaceModification` type, `SimpleWorkspaceGuard` adapter,
   `PROTECTED_RUNTIME_PATTERNS` constant.
2. `tests/workspace/guard.test.ts` — unit tests using a local
   `FakeGitInspector` (dependency injection; no real git) plus an
   integration smoke against a real temp git repo for the adapter.

**Step 1 (this artifact) writes only the cases-and-tests document and
one failing test file.** The source file ships in Step 2. Engine
integration (calling `detectModifications` after step execution and
mapping the result to `step_failed` + `PermissionError`) is owned by
WF-P8-SIGNALS or by the Engine integration follow-up; this workflow
does NOT modify `src/engine/index.ts`.

## "用户可完成" Milestones

Milestone count is capped at one (task brief: "至少 1 个"; the
underlying user task is single-axis).

- **M1 — read-only job workspace guard**: 用户在 workflow YAML 中声明
  job 级 `workspace: { mode: "read-only" }`，job 内任意 step 执行后
  Engine 调用 `WorkspaceGuard.detectModifications(cwd)`；返回非空
  列表时该 step 立即失败、job 状态变 `failed`、event log 记录
  `step_failed` reason `"workspace_guard_detected_modifications"`，
  且包含被修改文件清单。空列表时 step 按正常路径推进
  （执行成功 → `step_completed`；执行失败 → 按 `on_failure` 路由）。
  Writable job 不触发本 guard。protected runtime 文件
  （`state.json`、`events.jsonl`）即使 read-only job 未显式声明也
  必然被报告为 modification。

  执行示意：

  ```
  zigma-flow run --workflow review.yml
  zigma-flow step --job review     # workspace.mode = read-only
  # → WorkspaceGuard 在 step 执行后检测 cwd 是否被修改
  # → 任意改动 → step_failed + job failed + PermissionError 可选
  ```

## Spec Compliance Matrix

下表覆盖 prd.md FR-014、architecture.md §6.2 / §11 / §13 phase 7 /
§16，mvp-contracts.md §2.1 / §2.8 / §7 中本工作流相关的 MUST / SHALL
条款。RC-WG-* 条款编号沿用 WF-P7-GITCHECK 的命名约定（`WG` =
**W**orkspace **G**uard）。Spec clause budget: 13 in-scope clauses
(RC-WG-1..13) + 2 technical-debt registrations (TD-WG-1, TD-WG-2)；
total = 15 references，符合 ≤15 spec mandatory clause references 预算。

| Clause ID | Clause Source | Clause Text | Status |
| --- | --- | --- | --- |
| RC-WG-1 | prd §FR-014 | Workflow/job/step 必须支持 `workspace` mode 声明，至少包含 `read-only` 与 `writable`. | 已纳入本工作流 — guard 只对 `read-only` job 触发；`writable` job 不调用本 guard. T-WG-6 验证 negative path. |
| RC-WG-2 | prd §FR-014 | Runtime check 必须发现只读 Agent Step 修改文件（不能只依赖 prompt）. | 已纳入本工作流 — FP-WG-DETECT 通过 `GitInspector` 主动检测，与 prompt 解耦. T-WG-2/3/4/5 覆盖创建/修改/删除/重命名. |
| RC-WG-3 | prd §FR-014 | Runtime 验证只读约束必须基于 deterministic check，不调用 LLM. | 已纳入本工作流 — guard 仅依赖 `GitInspector` 端口，与 LLM Judge 无交互. 见 RC-WG-6 / RC-WG-8. |
| RC-WG-4 | arch §6.2 (Workspace Safety aggregate) | `WorkspaceMode` 与 `ChangedFiles`、`ForbiddenPath`、`PathPolicy` 同属 Workspace Safety bounded context；workspace guard、git inspector、check runner 共同拥有. | 已纳入本工作流 — `WorkspaceGuard` 接口和 `SimpleWorkspaceGuard` 适配器落地于 `src/workspace/index.ts`，复用 `GitInspector` 端口. |
| RC-WG-5 | arch §11 (runtime protected paths) | `.zigma-flow/runs/*/state.json`、`events.jsonl` 和 lock snapshot 属于 runtime 保护路径. | 已纳入本工作流 — `PROTECTED_RUNTIME_PATTERNS` 在 guard 内硬编码，read-only job 必然报告这些文件为 modification. T-WG-7 验证. |
| RC-WG-6 | arch §13 phase 7 / §16 (fitness functions) | 基础 gate 不依赖 LLM；read-only step 修改文件必须被检测；临时 git repo 集成测试覆盖. | 已纳入本工作流 — guard 实现纯端口查询；T-WG-INTEG（temp repo）验证. |
| RC-WG-7 | arch §10 (quality attributes) "read-only job 修改工作区" | 响应：Workspace Guard 检测 changed files、check failed；证据：临时 git repo 集成测试. | 已纳入本工作流 — 同 RC-WG-6；T-WG-INTEG 在真实 temp repo 内验证. |
| RC-WG-8 | mvp-contracts §2.8 | Check Step 是确定性 gate，不依赖 LLM Judge；MVP check 能力包含 "read-only step 是否修改工作区". | 已纳入本工作流 — 本 guard 是该能力的运行时落地. 与 P7 `protected-runtime-files` check 互补：P7 check 是显式 gate；本 guard 是 read-only job 的隐式 post-step gate. |
| RC-WG-9 | mvp-contracts §2.1 (Workflow YAML) | Job 字段必须支持 `workspace`. | 已纳入本工作流 — guard 触发条件读取 job-level `workspace.mode === "read-only"`. Schema 强制由 `src/workflow/` 负责（不在本 slice 范围）；TD-WG-1 追踪. |
| RC-WG-10 | mvp-contracts §7 (PermissionError) | `PermissionError` 触发于 read-only job 修改工作区、禁止路径被修改、state 文件被触碰. | 接受为本 slice 的下游契约：guard 返回 `WorkspaceModification[]`（非 throw），由 Engine 集成层（WF-P8-SIGNALS 或后续）决定是否升级为 `PermissionError`. T-WG-FAKE 验证 guard 自身不抛出（保持 pure function 语义）；executor-level 映射 TD-WG-2 追踪. |
| RC-WG-11 | arch §6.2 / §9.4 (port-adapter discipline) | Workspace guard 与 git inspector 由 Workspace Safety context 拥有；`engine` 不得 import 具体 `simple-git` 或 `simpleGit` 客户端. | 已纳入本工作流 — `SimpleWorkspaceGuard` 通过 `GitInspector` 端口间接使用 `simple-git`；`src/engine/index.ts` 仍只依赖 `WorkspaceGuard` 接口. Step 2 通过 import-graph 检查保证. |
| RC-WG-12 | prd §FR-014 / mvp-contracts §2.8 | 检测语义必须包含：新建、删除、修改、重命名文件（"任何 git status 报告的改动"）. | 已纳入本工作流 — FP-WG-DETECT 复用 `GitInspector.changedFiles()`，后者通过 `simple-git` `status()` 聚合 `not_added ∪ modified ∪ created ∪ renamed.to ∪ deleted ∪ staged ∪ conflicted`. T-WG-2/3/4/5 各覆盖一种 mutation 类型. |
| RC-WG-13 | mvp-contracts §2.8 / arch §13 phase 7 | "read-only step 修改工作区"用例验收证据：read-only 修改检测、临时 git repo 集成测试. | 已纳入本工作流 — T-WG-INTEG 在真实 temp repo 中创建文件 + 删除 + 修改 + 重命名，断言 guard 各自报告对应 path. |
| TD-WG-1 | mvp-contracts §2.1 / arch §16 (workflow schema) | `workspace.mode` 的 YAML schema 强制、读取 default、与 job 级权限的交叉校验由 `src/workflow/` 收敛. | 技术债 — TD-WG-1 (P8-WORKFLOW-SCHEMA carry, 后续 phase 落地). |
| TD-WG-2 | mvp-contracts §7 (PermissionError) | `WorkspaceGuard.detectModifications()` 结果在 Engine 集成层升级为 `PermissionError` 且映射到 `step_failed` event 的精确 wiring 由 WF-P8-SIGNALS 决定. | 技术债 — TD-WG-2 (P8-SIGNALS carry of TD-P7-003). |

## Functional Points

| FP id | Area | Source | Summary |
| --- | --- | --- | --- |
| FP-WG-PORT | `WorkspaceGuard` port interface | arch §6.2, §9.4 | `interface WorkspaceGuard { detectModifications(cwd: string, opts?: { includeProtected?: boolean }): Promise<WorkspaceModification[]>; }`. 导出于 `src/workspace/index.ts`. 不接受文件系统副作用、不抛领域错误（只抛 IO error 由调用方处理）. |
| FP-WG-MODIFICATION-TYPE | `WorkspaceModification` shape | mvp-contracts §2.8, prd FR-014 | `interface WorkspaceModification { path: string; kind: "git-changed" \| "protected-runtime"; }`. `path` 是相对 cwd 的 POSIX 路径（来源 `GitInspector`）；`kind` 区分一般 read-only 违规与触碰 runtime 保护文件，便于 Engine 集成层生成更精准的失败信息. |
| FP-WG-DETECT | `SimpleWorkspaceGuard.detectModifications()` | prd FR-014, arch §11, §16 | (1) 调用 `git.changedFiles(cwd)` 获取 `string[]`. (2) 每条 path 映射为 `{ path, kind: "git-changed" }`. (3) 对 `PROTECTED_RUNTIME_PATTERNS` 做 `micromatch` 命中（复用 P7 已经依赖的 lib），命中的 path 把 `kind` 升级为 `"protected-runtime"`（注意：不重复出现）. (4) 返回去重列表. 空数组 = 工作树干净 = 通过. |
| FP-WG-PROTECTED-PATTERNS | `PROTECTED_RUNTIME_PATTERNS` constant | arch §11 | `export const PROTECTED_RUNTIME_PATTERNS = [".zigma-flow/runs/*/state.json", ".zigma-flow/runs/*/events.jsonl"];`. 与 P7 `protected-runtime-files` check 的 hardcoded 常数语义一致；Step 2 可以选择从 `src/check/checks/protected-runtime-files.ts` 导入复用，也可以独立维护（D5 决策）. |
| FP-WG-DI-DEFAULT | Default inspector | arch §6, §9.4 | `SimpleWorkspaceGuard` 构造函数接受可选 `git?: GitInspector`. 未注入时构造 `new SimpleGitInspector()`. 测试通过 `FakeGitInspector` 注入；生产代码由 CLI 组合根注入实例（或不注入，让 guard 自取默认）. |
| FP-WG-NO-EVENTS | No state/event mutation | arch §13 phase 7 fitness | `SimpleWorkspaceGuard` 不 import `events`、`run`、`engine` 模块；只 import `GitInspector` interface + `micromatch`（如果选 D5 独立常数路线）+ `node:path`（仅 normalize）. Step 2 通过 import-graph 检查保证. |
| FP-WG-READ-ONLY-ONLY | Triggered only for read-only jobs | prd FR-014, mvp-contracts §2.1 | Guard 自身是查询函数，对 mode 无感知；触发判定（`if job.workspace.mode === "read-only"`）由 Engine 集成层（WF-P8-SIGNALS 或后续）执行. 本 slice 仅交付端口 + 适配器；T-WG-NEGATIVE 在文档层面声明 negative path 的契约位置. |
| FP-WG-WRITABLE-NOOP | Writable job not invoked | prd FR-014 | Writable job 不调用本 guard；guard 不主动判断 mode. 测试用例 UC-WG-6 / T-WG-6 在 Engine 集成测试层（后续 phase）落地，本 slice 通过文档明确该契约方向但不在 `guard.test.ts` 内重复 assert. |
| FP-WG-PORT-EXPORT | Public API surface | arch §9.4 (public api only via index.ts) | `src/workspace/index.ts` 同时 export `WorkspaceGuard` interface、`WorkspaceModification` type、`SimpleWorkspaceGuard` class、`PROTECTED_RUNTIME_PATTERNS` constant. 不导出内部 helper. |
| FP-WG-CWD-RESOLUTION | cwd handling | arch §11 (Workspace) | `detectModifications(cwd)` 直接透传 cwd 给 `GitInspector`. Absolute paths 直传；relative paths 由 `simple-git` 内部对 `process.cwd()` 解析（与 P7 相同）. 调用方传入 absolute 是 best practice. TD-WG-1 carries cross-workflow path-root unification. |

## Use Case Enumeration

| UC id | Actor | Trigger | Pre-conditions | Steps (happy path / failure) | Post-conditions / observable result |
| --- | --- | --- | --- | --- | --- |
| UC-WSGUARD-1 | Engine post-step | `guard.detectModifications(cwd)` invoked with FakeGitInspector returning `[]`. | Working tree clean (or fake says so); read-only job; step finished. | `git.changedFiles(cwd)` → `[]` → 无 protected 命中 → 返回 `[]`. | 返回值是空数组；Engine 集成层据此把 step 标 completed. |
| UC-WSGUARD-2 | Engine post-step | Same with fake returning `["new-file.txt"]`. | Read-only step 在 cwd 创建了一个新文件（git status: `??`）. | `changedFiles` 包含 `new-file.txt` → 无 protected 命中 → 返回 `[{ path: "new-file.txt", kind: "git-changed" }]`. | 返回值长度 1；Engine 集成层据此发 `step_failed` + 可选 `PermissionError`. |
| UC-WSGUARD-3 | Engine post-step | Same with fake returning `["src/existing.ts"]`. | Read-only step 修改了一个已存在文件（git status: ` M`）. | `changedFiles` 包含 `src/existing.ts` → `kind: "git-changed"`. | 返回值包含 `src/existing.ts`；step fails. |
| UC-WSGUARD-4 | Engine post-step | Same with fake returning `["docs/legacy.md"]` (the file was deleted). | Read-only step 删除了一个文件（git status: ` D`）. | `changedFiles` 包含 `docs/legacy.md` → `kind: "git-changed"`. | 返回值包含 `docs/legacy.md`；step fails. |
| UC-WSGUARD-5 | Engine post-step | Same with fake returning `["src/renamed.ts"]` (rename from `src/old.ts`). | Read-only step 重命名了一个文件（git status: `R`；`f.path` 是新名）. | `changedFiles` 包含 `src/renamed.ts` → `kind: "git-changed"`. | 返回值包含新名（`src/renamed.ts`）；step fails. （重命名旧路径不在 MVP 列举范围，与 P7 一致.） |
| UC-WSGUARD-6 | Engine post-step (writable mode) | Job has `workspace.mode: "writable"`; Engine integration layer does NOT invoke `guard.detectModifications`. | Writable job 修改文件是允许行为. | Guard 不被调用；step 直接根据脚本 / agent 返回值推进. | 没有 modification 报告；step 完成. （契约层 — 实际 Engine 集成测试由 WF-P8-SIGNALS 收敛.） |
| UC-WSGUARD-7 | Engine post-step | `guard.detectModifications(cwd)` invoked with fake returning `[".zigma-flow/runs/abc/state.json", "src/x.ts"]`. | Read-only step 触碰了 protected runtime 文件 + 一般文件. | `changedFiles` 包含 `.zigma-flow/runs/abc/state.json` → 命中 `PROTECTED_RUNTIME_PATTERNS` → `kind: "protected-runtime"`；`src/x.ts` 不命中 → `kind: "git-changed"`. | 返回值长度 2，其中 protected 的 `kind` 是 `"protected-runtime"`；Engine 集成层据此可以选择升级为 `PermissionError`. |

## Test Plan

One test file, `tests/workspace/guard.test.ts`. The file ships
**eight** `it` cases mapped to seven user case ids (UC-WSGUARD-1..7);
UC-WSGUARD-7 produces one fake-based unit case (T-WG-7) and one
integration smoke case (T-WG-INTEG) that exercises
`SimpleWorkspaceGuard` against a real temp git repo to satisfy
RC-WG-6 / RC-WG-7 / RC-WG-13.

| Test id | `it` description | What it verifies | UCs covered | FPs covered | RCs touched |
| --- | --- | --- | --- | --- | --- |
| T-WG-1 | `detectModifications — returns empty array for a clean working tree` | Fake returns `[]`; assert `result === []`. | UC-WSGUARD-1 | FP-WG-DETECT, FP-WG-MODIFICATION-TYPE | RC-WG-2, RC-WG-3, RC-WG-8 |
| T-WG-2 | `detectModifications — reports a newly-created file as git-changed` | Fake returns `["new-file.txt"]`; assert one `{ path: "new-file.txt", kind: "git-changed" }`. | UC-WSGUARD-2 | FP-WG-DETECT, FP-WG-MODIFICATION-TYPE | RC-WG-2, RC-WG-12 |
| T-WG-3 | `detectModifications — reports a modified existing file as git-changed` | Fake returns `["src/existing.ts"]`; assert one git-changed entry. | UC-WSGUARD-3 | FP-WG-DETECT | RC-WG-2, RC-WG-12 |
| T-WG-4 | `detectModifications — reports a deleted file as git-changed` | Fake returns `["docs/legacy.md"]`; assert one git-changed entry. | UC-WSGUARD-4 | FP-WG-DETECT | RC-WG-2, RC-WG-12 |
| T-WG-5 | `detectModifications — reports a renamed file (new path) as git-changed` | Fake returns `["src/renamed.ts"]`; assert one git-changed entry on the new path. | UC-WSGUARD-5 | FP-WG-DETECT | RC-WG-2, RC-WG-12 |
| T-WG-6 | `detectModifications — pure function: does not consult job mode` | Guard does not throw or branch on `workspace.mode`; calling it on a "writable" scenario still returns whatever the inspector reports. Asserts the guard is a pure query, not a policy decision. | UC-WSGUARD-6 (contract assertion only) | FP-WG-READ-ONLY-ONLY, FP-WG-WRITABLE-NOOP | RC-WG-1, RC-WG-3 |
| T-WG-7 | `detectModifications — flags protected runtime files with kind: "protected-runtime"` | Fake returns `[".zigma-flow/runs/abc/state.json", "src/x.ts"]`; assert two entries with the protected one having `kind: "protected-runtime"`. | UC-WSGUARD-7 | FP-WG-DETECT, FP-WG-PROTECTED-PATTERNS, FP-WG-MODIFICATION-TYPE | RC-WG-5, RC-WG-8, RC-WG-12 |
| T-WG-INTEG | `SimpleWorkspaceGuard — flags untracked, modified, deleted, and renamed files against a real temp git repo` | Real `git init` + identity config; create + commit a baseline file, then in one fresh state: add an untracked file, modify an existing file, delete another, and rename a fourth. Assert `detectModifications(repoDir)` returns entries whose `path`s include each of the four affected paths (or their new names for the rename case). | UC-WSGUARD-2..5 (integration) | FP-WG-DETECT, FP-WG-DI-DEFAULT, FP-WG-CWD-RESOLUTION | RC-WG-6, RC-WG-7, RC-WG-13 |

### `FakeGitInspector` (declared locally in the test file)

```ts
class FakeGitInspector implements GitInspector {
  constructor(private readonly changed: readonly string[]) {}
  async changedFiles(_cwd: string): Promise<string[]> { return [...this.changed]; }
  async diffExists(_cwd: string): Promise<boolean> { return this.changed.length > 0; }
}
```

Identical to the P7 fake in `tests/check/git-checks.test.ts`. The fake
ignores `cwd` and returns canned data — sufficient for unit-level
guard semantics.

### Test framework and conventions

- **Framework**: vitest (`describe` / `it` / `expect` / `beforeEach`
  / `afterEach`). Mirrors existing `tests/check/git-checks.test.ts`
  and `tests/git/inspector.test.ts` for sandbox setup and temp-dir
  hygiene.
- **Imports under test** (red phase — `src/workspace/index.ts` is
  currently `export {}`):
  - `WorkspaceGuard`, `WorkspaceModification`, `SimpleWorkspaceGuard`,
    `PROTECTED_RUNTIME_PATTERNS` from
    `../../src/workspace/index.js`.
  - `GitInspector` type from `../../src/git/index.js` (already
    delivered by P7).
- **Temp-repo construction (T-WG-INTEG)**: uses `node:child_process`
  `execFileSync("git", [...], { cwd: tmpDir })` — same recipe as
  `tests/git/inspector.test.ts`. Identity is set locally; hooks are
  silenced via `core.hooksPath`. Each `it` creates and tears down its
  own temp dir.
- **No event / state side-effects**: guard never writes to disk; tests
  do not need to assert absence of state writes — the function never
  receives paths to `events.jsonl` or `state.json`. Architectural
  contract (`FP-WG-NO-EVENTS`) is enforced by Step 2 import-graph
  inspection.

## Architecture Decisions

1. **`WorkspaceGuard` is a port, `SimpleWorkspaceGuard` is the
   adapter** (D1). The port lives in `src/workspace/index.ts`
   alongside the adapter so that callers (Engine integration) only
   need one import. The architectural rule (arch §16, fitness function
   "engine 不得 import simple-git") is upheld by importing the
   interface, not the class. Mirrors the `GitInspector` /
   `SimpleGitInspector` shape from P7.

2. **`WorkspaceModification` is a struct, not just `string[]`** (D2).
   Each entry carries both `path` and `kind`. Rationale:
   - The Engine integration layer needs to distinguish "user wrote a
     forbidden runtime file" (potentially upgrade to
     `PermissionError`) from "user touched their own file in a
     read-only step" (still fails the step, but the error message and
     remediation hint differ).
   - Forward-compatible with future kinds (e.g.
     `"ignored-but-modified"`, `"symlink-target"`) without breaking
     callers.
   - Cost: one extra TypeScript interface. Pays off the first time
     the Engine wants to fork on kind.
   - **Decision: use a struct.** Tests assert on the struct fields,
     not on positional string format.

3. **Guard returns array; never throws** (D3). The function returns
   the modification list (possibly empty). It does NOT throw
   `PermissionError`. Reasons:
   - Keeps `WorkspaceGuard` a pure query port (mirrors `GitInspector`).
   - The decision "what to do with modifications" belongs to the
     Engine state machine (emit event, transition job, upgrade
     to `PermissionError` per mvp-contracts §7).
   - Tests are simpler — no try/catch boilerplate.
   - TD-WG-2 tracks the executor-level upgrade to `PermissionError`.

4. **Reuse `GitInspector` from P7; no separate filesystem scan** (D4).
   `simple-git`'s `status()` already covers untracked files, so
   `GitInspector.changedFiles()` is the complete signal for MVP.
   Future "ignored-but-modified" detection is out of scope (would
   require explicit filesystem walk against `.gitignore`; not in
   FR-014 MVP scope). This avoids a parallel code path for non-git
   workspaces; non-git workspaces are out of MVP scope (PRD assumes
   git-backed working trees throughout the code-change workflow).

5. **Protected runtime patterns: import or duplicate?** (D5 — load-
   bearing decision for this slice). Two options:

   | Option | Pros | Cons |
   | --- | --- | --- |
   | (a) Import `PROTECTED_RUNTIME_PATTERNS` constant from `src/check/checks/protected-runtime-files.ts` and re-export from `src/workspace/index.ts`. | Single source of truth; future changes auto-propagate. | Creates a `workspace → check` import edge. Architecturally legal (both modules are in the runtime safety axis) but inverts the usual direction (check uses workspace, not the other way round). |
   | (b) Duplicate the two glob strings in `src/workspace/index.ts`. | Zero cross-module coupling; trivial to read. | Two-place maintenance — if architecture §11 ever adds a third runtime path, both sites must be updated. |

   **Decision: (b) duplicate, with a comment**. Two patterns are
   small enough to maintain in two places; the architectural document
   (arch §11) is the canonical source. Step 2 will leave a
   `// see also src/check/checks/protected-runtime-files.ts` comment
   above the constant so a grep for either location finds the other.
   This keeps the module dependency graph clean: `workspace` does NOT
   depend on `check`. If a third pattern is ever added, the two-line
   diff is acceptable.

6. **`micromatch` for protected-pattern matching** (D6). Already a
   transitive runtime dep via P7; reuse for consistency. The two
   protected patterns are stable globs (`*` not `**`), so even a
   manual regex would be acceptable, but `micromatch` matches the
   P7 precedent exactly. Step 2 imports `micromatch` directly (no new
   package.json change required — P7 already added it).

7. **`opts.includeProtected`** (D7). The `detectModifications` signature
   includes an optional `opts?: { includeProtected?: boolean }`.
   Default behaviour (and the only behaviour tested in this slice) is
   `includeProtected: true`. The knob is reserved for future cases
   (e.g. running the guard as part of an explicit `forbidden-paths`
   check that wants to dedupe responsibilities). MVP tests assert the
   default path only; the parameter is forward-compat scaffolding.

8. **No Engine integration in this slice** (D8). This workflow's
   deliverable is the port + adapter only. The "when to call" wiring
   (read-only job post-step hook) is owned by WF-P8-SIGNALS or by the
   Engine integration follow-up. This isolates the guard from state
   machine complexity and lets it ship as a stable, deterministic
   query.

9. **`SimpleGitInspector` factory: default-construct on demand** (D9).
   `SimpleWorkspaceGuard`'s constructor accepts an optional
   `git?: GitInspector`; when absent, it lazy-constructs
   `new SimpleGitInspector()` on the first `detectModifications()`
   call. This matches the P7 check-function pattern (D5 of WF-P7-
   GITCHECK).

## Red-Phase Expectations

- `src/workspace/index.ts` currently re-exports `{}` (placeholder).
  Test imports of `WorkspaceGuard`, `WorkspaceModification`,
  `SimpleWorkspaceGuard`, `PROTECTED_RUNTIME_PATTERNS` fail at
  module resolution / TypeScript compile.
- All seven unit `it` cases (T-WG-1..7) fail because the imported
  symbols are undefined.
- T-WG-INTEG additionally fails because `SimpleWorkspaceGuard` is not
  yet exported. The `simple-git` and `micromatch` deps are already
  in `package.json` (P7 added them).
- `GitInspector` type is already exported from `src/git/index.ts`
  (WF-P7-GITCHECK Step 2) and is stable across this workflow.
- Tests turn green after WF-P8-WSGUARD Step 2 ships the source file.

## Step 2 Handoff Notes

1. **`src/workspace/index.ts` MUST export the following surface**:

   ```ts
   import type { GitInspector } from "../git/index.js";
   import { SimpleGitInspector } from "../git/index.js";
   import micromatch from "micromatch";

   export interface WorkspaceModification {
     readonly path: string;
     readonly kind: "git-changed" | "protected-runtime";
   }

   export interface WorkspaceGuard {
     detectModifications(
       cwd: string,
       opts?: { includeProtected?: boolean },
     ): Promise<WorkspaceModification[]>;
   }

   // See also src/check/checks/protected-runtime-files.ts — arch §11
   // is the canonical source for these patterns.
   export const PROTECTED_RUNTIME_PATTERNS: readonly string[] = [
     ".zigma-flow/runs/*/state.json",
     ".zigma-flow/runs/*/events.jsonl",
   ];

   export class SimpleWorkspaceGuard implements WorkspaceGuard {
     constructor(private readonly git?: GitInspector) {}

     async detectModifications(
       cwd: string,
       opts: { includeProtected?: boolean } = {},
     ): Promise<WorkspaceModification[]> {
       const includeProtected = opts.includeProtected !== false;
       const git = this.git ?? new SimpleGitInspector();
       const changed = await git.changedFiles(cwd);

       // Classify; dedupe by path.
       const seen = new Set<string>();
       const result: WorkspaceModification[] = [];
       for (const p of changed) {
         if (seen.has(p)) continue;
         seen.add(p);
         const isProtected =
           includeProtected &&
           micromatch.isMatch(p, [...PROTECTED_RUNTIME_PATTERNS]);
         result.push({
           path: p,
           kind: isProtected ? "protected-runtime" : "git-changed",
         });
       }
       return result;
     }
   }
   ```

2. **No event / state side-effects.** The class only consults the
   injected (or constructed) `GitInspector`; no fs writes, no event
   emits, no engine imports.

3. **`PROTECTED_RUNTIME_PATTERNS` MUST match the patterns enforced
   by `src/check/checks/protected-runtime-files.ts`.** Step 2 must
   either visually compare the two constant lists or add a runtime
   assertion in a test fixture if they diverge. If a future PR adds a
   third runtime path, BOTH locations must be updated (and ideally
   the consolidation TD removed).

4. **No new dependencies.** `micromatch` and `simple-git` are
   already in `package.json` (P7). No `package.json` change required.

5. **Architecture-fitness checks** (Step 2 self-review):
   - `src/engine/index.ts` does NOT import the concrete
     `SimpleWorkspaceGuard` class; only the `WorkspaceGuard`
     interface (and only if/when the Engine integration follow-up
     ships). Verify by `grep -n "SimpleWorkspaceGuard" src/engine/`
     once integration lands.
   - `src/workspace/index.ts` does NOT import from `src/check/`,
     `src/engine/`, `src/events/`, or `src/run/`. Verify by
     `grep -n "^import" src/workspace/index.ts`.
   - `src/workspace/index.ts` MAY import from `src/git/index.js`
     (interface + adapter) and from `micromatch`.

6. **Tests stay co-located.** The test file is
   `tests/workspace/guard.test.ts`. Other Engine-side integration
   tests (read-only job triggers post-step guard) belong to
   WF-P8-SIGNALS or the Engine integration follow-up, not here.

## Test Gaps

- **Engine integration**: This slice does NOT verify that the Engine
  actually calls `guard.detectModifications()` after a read-only
  step. That integration test belongs to WF-P8-SIGNALS (or the Engine
  step-execution loop extension). Captured by TD-WG-2.
- **`PermissionError` mapping**: TD-WG-2. The executor-level mapping
  of guard results to `step_failed` event + `PermissionError` raise
  is deferred to WF-P8-SIGNALS.
- **YAML schema enforcement of `workspace.mode`**: TD-WG-1. Verifying
  that `workspace: { mode: "read-only" }` is recognised by
  `src/workflow/` schema validation is out of scope for this slice.
- **Non-git workspaces**: Out of MVP scope (D4). PRD assumes
  git-backed working trees.
- **Symlinks and hidden files**: `simple-git`'s `status()` already
  reports symlinks (as the path of the link, not the target) and
  hidden files (no special treatment). No dedicated assertion in this
  slice; if a future bug surfaces, a regression test is added under
  TD-WG-1.
- **Git-ignored files**: `.gitignore`-matched files are NOT reported
  by `git status` and therefore are NOT flagged by this guard. This
  is intentional and matches the PRD scope ("git status reports"); a
  stricter "any filesystem change" guard would be a future TD.
- **Cross-platform path separators**: same as P7 — `simple-git` and
  `micromatch` normalise to POSIX internally. T-WG-INTEG uses POSIX
  path fragments in assertions.
