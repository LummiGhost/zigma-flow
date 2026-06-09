# WF-P7-CHECK — Cases and Tests

- Workflow: WF-P7-CHECK
- Phase: P7 Check Step
- Step: 1 (Cases and Tests)
- Date: 2026-06-09
- Author: subagent (workflow Step 1)

## Slice Boundary

- Slice name: **P7-CHECK**
- Bounded contexts:
  - **Check Executor / Engine command body** (architecture.md §7.1, §12.3,
    §13 phase 7). Owns the body of `executeCurrentStep` for
    `type: "check"` and the new `executeCheckStep(opts)` orchestrator in
    `src/check/executor.ts`.
  - **Event Sequencer** for check-step events (architecture.md §7.3,
    mvp-contracts.md §2.4) — sequences `step_started` →
    `check_completed` → `step_completed | step_failed` (and
    `job_completed` for single-step jobs).
  - **Step Schema extension** in `src/workflow/index.ts` —
    `StepBaseSchema` gains explicit `on_pass`, `on_fail` fields (both
    `RouterAction`).
  - **Error taxonomy extension** in `src/utils/errors.ts` — adds
    `CheckError` (exit code 1) and `PermissionError` (exit code 1).
- Bounded context interactions:
  - **Consumes** a `CheckRunner` port (introduced by this workflow) —
    structurally analogous to the `ProcessRunner` consumed by P6. The
    port surfaces a single `run(opts)` method that returns a
    `CheckResult`. The actual check-kind implementations
    (file-exists, json-parse, json-schema, required-fields, git-diff
    exists, forbidden-paths, etc.) are **not** in this slice —
    WF-P7-CHECK supplies only the executor and the kind registry
    interface. A `FakeCheckRunner` is injected from tests; the
    `LocalCheckRunner` adapter ships alongside the executor as a thin
    stub that throws `CheckError` for any unregistered kind.
  - **Consumes** `JsonlEventWriter`, `LocalStateStore`, `nextEventId`
    from `src/run/index.js` and `src/events/index.js` for events and
    state snapshots.
  - **Consumes** `artifactStepDir` / `artifactId` from
    `src/artifact/index.js` to persist `check-result.json`.
  - **Produces** the only legal `ready → running →
    completed | failed | blocked` transition for a check step.
    Architecture §5.2, ADR-003, fitness rule §18 ("`script` 和 `check`
    不得直接推进 job status") — Engine is the sole state mutator; the
    CheckRunner only returns data.
  - **MUST NOT** be called directly by the CLI — `stepAction` from
    WF-P6-DISPATCH is the only caller. `executeCurrentStep` is the
    public surface; `executeCheckStep` is the check-specific worker
    invoked by it.
  - **MUST NOT** include the actual check-kind implementations
    (file-exists, json-parse, json-schema, required-fields, git-diff
    exists, forbidden-paths, sensitive-state, read-only modified, etc.)
    — those are **TD-P7-002**, deferred to a follow-on workflow.
  - **MUST NOT** advance `current_step` to a sibling step within the
    same job — multi-step progression remains TD-P6-004 (P8). P7
    validates single-step jobs end-to-end.
  - **MUST NOT** implement the object forms of `on_pass` / `on_fail`
    (`retry_job`, `activate_job`, `goto_job`) — TD-P7-003 (P8). P7
    supports the literal `continue` (treated as success), the literal
    `fail` and `block`, and the object literal forms
    `{ status: "failed" }` / `{ status: "blocked" }`.

## Workflow Goal

Deliver the complete deterministic check execution pipeline so that a
user who has already created a run (WF-P3-RUN) and ran
`zigma-flow step --job <job>` (WF-P6-DISPATCH, extended in this phase to
recognise `type: "check"`) sees their workflow's check step execute as
a deterministic gate without invoking an LLM: the check kind is
dispatched through the injected `CheckRunner`, the result is persisted
as a `check-result.json` artifact, the corresponding `step_started` /
`check_completed` / `step_completed | step_failed` events are appended
in order, a `job_completed` event is emitted on success when no further
steps remain, and the job state advances exactly once from
`ready → running → completed | failed | blocked`. All state mutations
occur inside the Engine — no CLI, no Skill Pack, no CheckRunner writes
`state.json` or `events.jsonl` directly. The slice satisfies
architecture §13 phase 7 verification: *"基础 gate 不依赖 LLM,
read-only 修改被检测"* (the read-only / workspace check kinds land in a
follow-on workflow per TD-P7-002, but the executor scaffold proves the
gate path is LLM-free).

Deliverables:

1. `executeCheckStep(opts)` in `src/check/executor.ts` — orchestration
   function that calls the injected `CheckRunner.run(opts)`, persists
   the `CheckResult` to `check-result.json`, writes events, and applies
   the on_pass / on_fail / success / failure transition.
2. `CheckResult` type and `CheckRunner` port in `src/check/index.ts`
   (or co-located with the executor) with the snake_case shape
   `{ passed, check_id, failures, artifacts }`.
3. `executeCurrentStep(opts)` body in `src/engine/index.ts` extended to
   dispatch `type: "check"` to `executeCheckStep`; non-script /
   non-check types continue to throw `WorkflowError` (TD-P7-001).
4. `StepBaseSchema` extension in `src/workflow/index.ts` adding
   `on_pass` and `on_fail` (both optional `RouterAction`).
5. `CheckError` and `PermissionError` classes in
   `src/utils/errors.ts` (both exit code 1) plus index re-exports.
6. `tests/check/executor.test.ts` — integration tests against real
   temp directories, with an injected `FakeCheckRunner`. **This
   workflow Step 1 writes only the cases-and-tests document and the
   failing test file; the executor source ships in Step 2.**

## "用户可完成" Milestones

- **M1 — 成功的 check step**: 用户可完成 `zigma-flow step --job <job>`
  后，对一个 `type: check` 且 `uses: "<skill>/<check>"` 的 step，得到：
  - `events.jsonl` 末尾包含按顺序排列的 `step_started` →
    `check_completed`(`passed: true`) → `step_completed` →
    `job_completed`；
  - `state.json` 中该 job 的 `status` 从 `ready` 变为 `completed`；
  - `<runDir>/jobs/<jobId>/attempts/<attempt>/steps/<stepId>/check-result.json`
    真实存在并包含 `{ passed: true, check_id, failures: [], artifacts: [] }`；
  - `state.json.last_event_id` 等于 events.jsonl 尾部 event id；
  - `state.json` 仅被写入一次（在事件序列结束后）。

- **M2 — 失败的 check step**: 用户可完成
  `zigma-flow step --job <job>` 后，对一个 `passed: false` 的 check
  step，得到：
  - `events.jsonl` 末尾包含 `step_started` → `check_completed`
    (`passed: false`, `failures: [...]`) → `step_failed`；
  - `state.json` 中该 job 的 `status` 从 `ready` 变为 `failed`；
  - `check-result.json` 仍被持久化，其 `failures` 字段非空；
  - 没有 `step_completed` 事件，没有 `job_completed` 事件；
  - `state.json.last_event_id` 等于 events.jsonl 尾部 event id。

- **M3 — on_fail override**: 用户可完成 `zigma-flow step --job <job>`
  后，对一个声明 `on_fail: { status: "failed" }` 的失败 check step，
  得到与 M2 完全相同的可观察结果（验证显式声明与默认行为等价，为
  TD-P7-003 中其他 on_fail 对象形式提供 baseline）。

- **M4 — Unknown kind**: 用户使用未注册的 check kind 时，`step --job`
  立即抛出 `CheckError`，**任何事件被追加之前**即失败，
  `state.json` 不被修改。

## Spec Compliance Matrix

下表覆盖 prd.md FR-008、architecture.md §7 / §9.4 / §12.3 / §16、
mvp-contracts.md §2.8 / §6 / §7 中与 WF-P7-CHECK 相关的
MUST / SHALL / 强制性条款。

| Clause ID | Clause Source | Clause Text | Status |
| --- | --- | --- | --- |
| RC-C1 | prd §FR-008 | Check Step 必须执行确定性检查，不依赖 LLM Judge. | 已纳入本工作流 — FP-CHECK-RUNNER-CALL, FP-CHECK-NO-LLM；T-CHECK-1, T-CHECK-2 (FakeCheckRunner 完全 deterministic, 无 LLM 注入路径) |
| RC-C2 | prd §FR-008 | MVP 支持文件存在 / JSON 合法 / JSON Schema / 必填字段 / 字段非空 / git diff exists / 测试通过 / 禁止路径 / 敏感 state / read-only 修改检查. | 本工作流定义 kind registry 接口；具体 kind 实现为 TD-P7-002（在后续工作流落地，按 prd 列表逐项添加 FakeCheckRunner 等价测试）. |
| RC-C3 | prd §FR-008 | 检查通过时写入 check-result artifact. | 已纳入本工作流 — FP-CHECK-RESULT-JSON；T-CHECK-1, T-CHECK-3 |
| RC-C4 | prd §FR-008 | 检查失败时列出失败项. | 已纳入本工作流 — FP-CHECK-RESULT-JSON, FP-CHECK-EVENT-CHECK-COMPLETED；T-CHECK-2, T-CHECK-3 (`failures` 数组在 result.json 与 `check_completed` payload 中均出现) |
| RC-C5 | prd §FR-008 | 检查失败时按 on_fail 处理. | 部分纳入本工作流 — 字面量 `fail` / 对象 `{ status: "failed" \| "blocked" }` 落地；`retry_job` / `activate_job` / `goto_job` 形式为 TD-P7-003. T-CHECK-4 验证 `{ status: "failed" }` baseline. |
| RC-C6 | prd §FR-008 | 基础 gate 不依赖 LLM Judge. | 已纳入本工作流 — 同 RC-C1；执行器不引入任何 LLM 适配器依赖；运行器接口仅声明 `run(opts) → CheckResult`，没有 prompt 或 model 参数. |
| RC-C7 | mvp-contracts §2.8 | `CheckResult` 字段 `{ passed, check_id, failures, artifacts }`. | 已纳入本工作流 — FP-CHECK-RESULT-SHAPE；T-CHECK-3 |
| RC-C8 | mvp-contracts §2.8 | Check Step 是确定性 gate, 不依赖 LLM Judge. | 已纳入本工作流（同 RC-C1 / RC-C6）；T-CHECK-1, T-CHECK-2 |
| RC-C9 | mvp-contracts §2.8 | MVP check 能力清单与 prd FR-008 一致. | 同 RC-C2 — 本工作流提供 dispatch 接口，具体 kind 实现 TD-P7-002. |
| RC-C10 | mvp-contracts §7 (CheckError) | `CheckError` 触发于 deterministic check 失败或 check 输入缺失；写入 CheckResult, 由 Engine/Gate 决定状态；exit code 1. | 已纳入本工作流 — FP-CHECK-ERROR-CLASS；T-CHECK-5 (unknown kind → CheckError before any events appended) |
| RC-C11 | mvp-contracts §7 (PermissionError) | `PermissionError` 触发于 read-only job 修改工作区 / 禁止路径被修改 / state 文件被触碰；阻止推进或标记 check failed；exit code 1. | 类已纳入 (`src/utils/errors.ts`) — 但触发它的具体 kind 实现是 TD-P7-002. 本 slice 仅保证类存在并可被未来 kind 实现使用. |
| RC-C12 | mvp-contracts §2.4 | event 至少包含 `id` / `run_id` / `type` / `timestamp` / `producer` / `job` / `step` / `attempt` / `payload`. | 已纳入本工作流 — FP-CHECK-EVENT-STARTED, FP-CHECK-EVENT-CHECK-COMPLETED；T-CHECK-1 |
| RC-C13 | mvp-contracts §2.4 | 关键事件类型集合包含 `step_started` / `step_completed` / `step_failed` / `check_completed` / `job_completed`. | 已纳入本工作流 — FP-CHECK-EVENT-*；T-CHECK-1, T-CHECK-2 |
| RC-C14 | mvp-contracts §2.4 | `check_completed.payload` 必须含 `{ job_id, step_id, check_id, passed, failures? }`. | 已纳入本工作流 — FP-CHECK-EVENT-CHECK-COMPLETED；T-CHECK-1, T-CHECK-2 |
| RC-C15 | architecture §7.1 | Engine 对外暴露 `executeCurrentStep(runId, jobId)`；CLI 命令只调用这些入口, 不直接改 run state. | 已纳入本工作流 — FP-CHECK-ENGINE-ENTRY (`executeCurrentStep` 内为 `type: check` 调用 `executeCheckStep`). |
| RC-C16 | architecture §7.2 | Job status 合法转换 `ready → running → completed`；`ready → running → failed`；`ready → running → blocked`. | 已纳入本工作流 — FP-CHECK-TRANSITION-SUCCESS / FAILURE；T-CHECK-1 (completed), T-CHECK-2 (failed), T-CHECK-4 (failed via explicit on_fail status). `blocked` 由 on_fail `{ status: "blocked" }` 路径覆盖, 测试在 implementation phase 补 (登记 TD-P7-004). |
| RC-C17 | architecture §7.3 | 写入流程为: 计算 transition, 追加 event, 写 `state.json.tmp`, 原子替换 `state.json`. | 已纳入本工作流（复用 `LocalStateStore.writeSnapshot`）— FP-CHECK-STATE-WRITE；T-CHECK-1 (snapshot 在 events 之后写) |
| RC-C18 | architecture §7.3 | `state.last_event_id` 必须与 event log 尾部一致. | 已纳入本工作流 — FP-CHECK-STATE-WRITE；T-CHECK-1 (snapshot tail = events.jsonl tail). |
| RC-C19 | architecture §9.4 | `CheckResult` 必须包含 `passed` / `check_id` / `failures` / `artifacts`. | 已纳入本工作流 — FP-CHECK-RESULT-SHAPE；T-CHECK-3 |
| RC-C20 | architecture §9.4 | Script Runner 和 Check Runner 只产出结果. 是否继续 / 失败 / retry / block 由 Engine 和 Gate 处理. | 已纳入本工作流 — FP-CHECK-RUNNER-CALL (runner 只返回 CheckResult) + FP-CHECK-TRANSITION-* (执行器才发起 transition)；T-CHECK-2, T-CHECK-4 |
| RC-C21 | architecture §12.3 | `Command Handler -> check: CheckRunner evaluates deterministic gate -> write artifacts -> Engine applies transition -> append events and write state snapshot`. | 已纳入本工作流 — FP-CHECK-ORCHESTRATION；T-CHECK-1 |
| RC-C22 | architecture §13 phase 7 | 基础 gate 不依赖 LLM, read-only 修改被检测. | 部分纳入本工作流 — gate-without-LLM 已纳入 (T-CHECK-1, T-CHECK-2)；read-only 修改 kind 是 TD-P7-002. |
| RC-C23 | architecture §16 | Contract tests: CheckResult schema. | 已纳入本工作流 — FP-CHECK-RESULT-SHAPE；T-CHECK-3 |
| RC-C24 | architecture §18 fitness rule | `script` 和 `check` 不得直接推进 job status. | 已纳入本工作流 — FP-CHECK-RUNNER-CALL (runner 接口纯函数 `(opts) → CheckResult`, 无状态变更副作用)；FP-CHECK-TRANSITION-* 仍由 executor 持有. |
| RC-C25 | mvp-contracts §2.5 | artifact path 必须是相对 run directory 的安全路径；retry 不得覆盖历史 attempt artifact. | 已纳入本工作流（通过复用 `artifactStepDir` / 路径安全检查）— FP-CHECK-RESULT-JSON；T-CHECK-3 |
| RC-C26 | mvp-contracts §2.3 | `state.json` 只能由 Engine 通过 State Store 写入；写入顺序为 append event 后原子替换 state snapshot. | 已纳入本工作流 — FP-CHECK-STATE-WRITE；T-CHECK-1 |
| TD-P7-001 | architecture §7.1, §12.3 | `executeCurrentStep` MUST 在 MVP 处理 script / check / router / human / workflow 五种 step type. 本 phase 实现 `script` + `check`；其余仍抛 `WorkflowError`. | 技术债 — TD-P7-001（router / human / workflow 在 P8+ 落地）继承 TD-P6-001. |
| TD-P7-002 | prd §FR-008, mvp-contracts §2.8 | 具体 check kind 实现（file-exists / json-parse / json-schema / required-fields / non-empty-fields / git-diff exists / 测试通过 / forbidden-paths / sensitive-state / read-only-modified）必须落地. 本 slice 只完成 dispatch 框架, kind 实现 deferred. | 技术债 — TD-P7-002（在 P7 的后续工作流逐项实现, 或 P8 完成） |
| TD-P7-003 | prd §FR-008, mvp-contracts §2.8 | `on_pass` / `on_fail` 对象形式 `retry_job` / `activate_job` / `goto_job` MUST 由 Engine 实现. 本 slice 只支持字面量 `continue` / `fail` / `block` 与对象 `{ status: "failed" \| "blocked" }`. | 技术债 — TD-P7-003（P8 落地，继承 TD-P6-002） |
| TD-P7-004 | architecture §7.2 | `on_fail: { status: "blocked" }` 走 `ready → running → blocked` 转换. 本 slice 的 failure-path 测试只覆盖 `failed`；`blocked` 转换在 implementation phase 增补一个 T-CHECK-4b 用例. | 技术债 — TD-P7-004（在本 phase Step 2 / Step 3 增补，无需新 workflow） |
| TD-P6-004 | architecture §7.2 | 多 step job 在 step 完成后 MUST 推进 `current_step` 指针到下一个 step. 本 slice 只验证单 step job 的 `job_completed` 触发条件. | 技术债 — 沿用 TD-P6-004（P8 落地） |

Spec clause budget within plan envelope: 26 in-scope clauses + 4
technical-debt registrations. All MUST clauses sourced from prd
FR-008, architecture §7 / §9.4 / §12.3 / §16, and mvp-contracts §2.4 /
§2.5 / §2.8 / §7 are accounted for.

## Functional Points

| FP id | Area | Source | Summary |
| --- | --- | --- | --- |
| FP-CHECK-RESOLVE | Check kind resolution | prd FR-008, mvp §2.8 | Resolve `step.uses` (or `step.kind`) to a registered check kind. Unknown kind → throw `CheckError` BEFORE appending any event. |
| FP-CHECK-NO-LLM | LLM-free gate | prd FR-008, mvp §2.8 | `executeCheckStep` MUST NOT import any LLM / prompt module; the `CheckRunner` port surface contains no prompt / model parameter. |
| FP-CHECK-EVENT-STARTED | `step_started` emission | arch §12.3, mvp §2.4 | `executeCheckStep` appends a `step_started` event with `{ job_id, step_id, attempt }` BEFORE invoking the runner. |
| FP-CHECK-RUNNER-CALL | CheckRunner invocation | arch §12.3, mvp §2.8 | `executeCheckStep` calls `runner.run({ checkId, stepId, jobId, with, runDir })` exactly once per step. Runner is injected via `opts.runner` (defaults to `LocalCheckRunner`). |
| FP-CHECK-RESULT-SHAPE | `CheckResult` snake_case shape | arch §9.4, mvp §2.8 | The `CheckResult` returned by the runner has fields `passed: boolean`, `check_id: string`, `failures: string[]`, `artifacts: string[]`. |
| FP-CHECK-RESULT-JSON | `check-result.json` persistence | arch §9.4, mvp §2.5 / §2.8 | The CheckResult is written verbatim to `<runDir>/jobs/<jobId>/attempts/<attempt>/steps/<stepId>/check-result.json`. The file content is the JSON-stringified CheckResult (snake_case). |
| FP-CHECK-EVENT-CHECK-COMPLETED | `check_completed` emission | mvp §2.4 | After writing `check-result.json`, append `check_completed` with payload `{ job_id, step_id, check_id, passed, failures? }`. `failures` is included only when non-empty. |
| FP-CHECK-TRANSITION-SUCCESS | Success transition | arch §7.2 | If `result.passed === true`: append `step_completed`, then (no remaining steps) append `job_completed`; set `state.jobs[jobId].status = "completed"`. |
| FP-CHECK-TRANSITION-FAILURE | Failure transition | arch §7.2, prd FR-008 | If `result.passed === false`: append `step_failed` with `reason` containing `"check failed"` and (if available) the first failure string. Apply `on_fail`: literal `fail` or absent → `failed`; `block` or `{ status: "blocked" }` → `blocked`; `{ status: "failed" }` → `failed`. |
| FP-CHECK-STATE-WRITE | Atomic state snapshot | arch §7.3, mvp §2.3 | `state.json` is written exactly once (initial running snapshot during the started step, plus the final terminal snapshot — same single-write pattern as the script executor). `state.last_event_id` equals the tail event id of `events.jsonl`. |
| FP-CHECK-EVENT-SEQUENCE | Event ordering | arch §12.3, mvp §2.4 | Append order is `step_started` → `check_completed` → (`step_completed` + `job_completed` \| `step_failed`). |
| FP-CHECK-ENGINE-ENTRY | Engine integration | arch §7.1 | `executeCurrentStep(opts)` dispatches `type: "check"` to `executeCheckStep(opts)`. Other types throw `WorkflowError` (TD-P7-001). |
| FP-CHECK-ERROR-CLASS | Error class additions | mvp §7 | `CheckError` (exit code 1) and `PermissionError` (exit code 1) are added to `src/utils/errors.ts` and re-exported from `src/utils/index.ts`. |
| FP-CHECK-ORCHESTRATION | End-to-end pipeline | arch §12.3 | The full pipeline (resolve → started → runner → check-result → check_completed → completed/failed → job_completed → snapshot) executes in this order on every invocation. |

## Use Case Enumeration

| UC id | Actor | Trigger | Pre-conditions | Steps (happy path / failure) | Post-conditions / observable result |
| --- | --- | --- | --- | --- | --- |
| UC-CHECK-1 | Engine | `executeCheckStep` called on a `ready` single-step `check` job; runner returns `{ passed: true, check_id, failures: [], artifacts: [] }`. | Run dir exists with valid `state.json` + `events.jsonl`; FakeCheckRunner is configured to return `passed: true`. | Append `step_started`; call runner; write `check-result.json` artifact; append `check_completed` (payload includes `passed: true`); append `step_completed`; append `job_completed`; write state snapshot with `jobs[jobId].status === "completed"`. | events.jsonl tail = `job_completed`; state.last_event_id matches tail; check-result.json file exists; result contents match `{ passed: true, check_id, failures: [], artifacts: [] }`. |
| UC-CHECK-2 | Engine | Same as UC-CHECK-1 but runner returns `{ passed: false, check_id, failures: ["missing field 'report'"], artifacts: [] }`. | Same. | Append `step_started`; call runner; write check-result.json with `failures` populated; append `check_completed` (payload includes `passed: false`, `failures: [...]`); append `step_failed` (reason references "check failed"); write state snapshot with `jobs[jobId].status === "failed"`. NO `step_completed`, NO `job_completed`. | events.jsonl tail = `step_failed`; state.last_event_id matches tail; state.jobs[jobId].status === "failed"; check-result.json `failures` matches. |
| UC-CHECK-3 | Engine | Same as UC-CHECK-1 but verifying the on-disk `check-result.json` artifact contents. | runner returns canonical CheckResult. | Standard happy-path pipeline. | `<runDir>/jobs/<jobId>/attempts/<attempt>/steps/<stepId>/check-result.json` exists; the parsed JSON exactly matches the runner's returned CheckResult (snake_case keys `passed`, `check_id`, `failures`, `artifacts`). |
| UC-CHECK-4 | Engine | `executeCheckStep` called on a check step whose YAML declares `on_fail: { status: "failed" }`; runner returns `passed: false`. | Same as UC-CHECK-2 but the workflow declares the explicit override. | Same as UC-CHECK-2. | Same as UC-CHECK-2 — confirms the explicit declaration is equivalent to the default for the `failed` outcome (baseline before TD-P7-003 lands the other on_fail forms). |
| UC-CHECK-5 | Engine | `executeCheckStep` invoked when the resolved check kind is not registered with the runner. | The FakeCheckRunner is instantiated with no registered kinds (or with a kind whose name does not match the workflow's `uses`). | Resolution fails inside the executor → `CheckError` is thrown BEFORE any `step_started` event is appended. | events.jsonl tail remains the original `job_ready` (or whatever was last); state.json is unchanged; no `check-result.json` is written; the error has `kind === "CheckError"` and exit code 1. |
| UC-CHECK-6 | Engine (negative — TD-P7-001) | `executeCurrentStep` called on a non-script / non-check step. | Workflow current step is `router` / `human` / `workflow`. | Engine wrapper throws `WorkflowError` BEFORE invoking `executeCheckStep`. | No events appended; no state change. (Covered indirectly by WF-P6-DISPATCH T-DISPATCH-3 reuse and extension in Step 2; not duplicated in `tests/check/executor.test.ts`.) |
| UC-CHECK-7 | Engine (negative — TD-P7-004) | `executeCheckStep` invoked with `on_fail: { status: "blocked" }`; runner returns `passed: false`. | Workflow declares the blocked override. | Standard failure path but with `state.jobs[jobId].status === "blocked"`. | (Registered as TD-P7-004; assertion not written in this Step 1 file — added in Step 2 alongside the implementation.) |

## Test Plan

All tests live in **`tests/check/executor.test.ts`** under
`describe("executeCheckStep", ...)`. Vitest. Real temp dirs under
`os.tmpdir()`. No filesystem mocking. A local `FakeCheckRunner` class
implements the `CheckRunner` shape and is injected via `opts.runner`.

| Test id | `it` description | What it verifies | UCs covered | FPs covered | RCs touched |
| --- | --- | --- | --- | --- | --- |
| T-CHECK-1 | `happy path — passing check emits step_started → check_completed(passed:true) → step_completed → job_completed and persists check-result.json` | Run end-to-end on a single-step check job. Assert: (a) events.jsonl contains `step_started`, `check_completed` (with `payload.passed === true`), `step_completed`, `job_completed` in that order; (b) `state.json.jobs[jobId].status === "completed"`; (c) `check-result.json` exists on disk; (d) `state.json.last_event_id` equals the tail event id of `events.jsonl`. | UC-CHECK-1 | FP-CHECK-RESOLVE, FP-CHECK-NO-LLM, FP-CHECK-EVENT-STARTED, FP-CHECK-RUNNER-CALL, FP-CHECK-RESULT-JSON, FP-CHECK-EVENT-CHECK-COMPLETED, FP-CHECK-TRANSITION-SUCCESS, FP-CHECK-EVENT-SEQUENCE, FP-CHECK-STATE-WRITE, FP-CHECK-ORCHESTRATION | RC-C1, RC-C3, RC-C6, RC-C8, RC-C12, RC-C13, RC-C14, RC-C15, RC-C16, RC-C17, RC-C18, RC-C20, RC-C21, RC-C26 |
| T-CHECK-2 | `failing check emits step_failed and transitions job to failed; check_completed payload carries failures` | runner returns `passed: false, failures: [...]`. Assert: events.jsonl contains `step_started`, `check_completed` (payload `passed: false`, `failures` matches), `step_failed`; NO `step_completed` / `job_completed`; `state.jobs[jobId].status === "failed"`; `check-result.json` exists with non-empty `failures`. | UC-CHECK-2 | FP-CHECK-RUNNER-CALL, FP-CHECK-RESULT-JSON, FP-CHECK-EVENT-CHECK-COMPLETED, FP-CHECK-TRANSITION-FAILURE, FP-CHECK-EVENT-SEQUENCE | RC-C4, RC-C5, RC-C13, RC-C14, RC-C16, RC-C20 |
| T-CHECK-3 | `check-result.json is written to the canonical artifact path with the runner's CheckResult contents (snake_case)` | runner returns a fully populated CheckResult. Assert: `<runDir>/jobs/<jobId>/attempts/<attempt>/steps/<stepId>/check-result.json` exists; the parsed JSON has snake_case keys `passed`, `check_id`, `failures`, `artifacts` and matches the runner's return value byte-for-byte (after JSON normalisation). | UC-CHECK-3 | FP-CHECK-RESULT-SHAPE, FP-CHECK-RESULT-JSON | RC-C7, RC-C19, RC-C23, RC-C25 |
| T-CHECK-4 | `on_fail: { status: "failed" } is equivalent to the default failure transition` | runner returns `passed: false`; the workflow YAML declares `on_fail: { status: "failed" }`. Assert: same observable outcome as T-CHECK-2. Confirms the baseline before TD-P7-003 retrofits the other on_fail object forms. | UC-CHECK-4 | FP-CHECK-TRANSITION-FAILURE | RC-C5 |
| T-CHECK-5 | `unknown check kind throws CheckError BEFORE any events are appended` | FakeCheckRunner is configured with no registered kinds. Invoke `executeCheckStep`. Assert: an error is thrown; the error's `kind === "CheckError"`; the error's `exitCode === 1`; `events.jsonl` does NOT contain a `step_started` line referring to the failing step; `state.json` is unchanged from the pre-execution snapshot. | UC-CHECK-5 | FP-CHECK-RESOLVE, FP-CHECK-ERROR-CLASS | RC-C10 |

## Test Design Summary

- **Test framework**: vitest (`describe` / `it` / `expect` / `beforeEach`
  / `afterEach`). Mirrors the structure of
  `tests/script/executor.test.ts` (P6) and `tests/commands/step.test.ts`.
- **Imports under test**:
  - `executeCheckStep` from `../../src/check/executor.js` (does not
    exist yet — red phase).
  - `createRun` from `../../src/engine/index.js` for sandbox setup.
  - `Clock` from `../../src/run/index.js`.
- **Filesystem**: real temp directories under `os.tmpdir()` with
  `node:crypto.randomUUID()` suffixes; no fs mocking. Each test creates
  its own `<sandbox>/.zigma-flow/` skeleton (`config.json`,
  `skill-lock.json`, `runs/`).
- **Clock**: inline `FakeClock { now(): "2026-06-09T00:00:00.000Z" }`.
- **CheckRunner injection**: tests pass a local `FakeCheckRunner`
  class. The fake implements `run(opts): Promise<CheckResult>` and is
  parameterised by a canned `CheckResult` plus an `unknownKind` flag
  used to drive T-CHECK-5. The runner records `calls[]` for invocation
  assertions. The fake's interface is the **authoritative**
  CheckRunner shape going forward; the Step 2 source MUST expose a
  structurally compatible port.
- **Workflow YAML fixtures**: a minimal single-step `type: check`
  workflow is used for T-CHECK-1 / T-CHECK-2 / T-CHECK-3 / T-CHECK-5
  (using `uses: code.checks.report-schema` as a placeholder check
  identifier). A second fixture declares
  `on_fail: { status: failed }` for T-CHECK-4. `uses` does not need a
  matching Skill Pack entry because the FakeCheckRunner ignores the
  `with` and Skill Pack lookup — it only honours the `check_id`
  registered in its constructor.
- **Pre/post evidence**: T-CHECK-1 / T-CHECK-2 / T-CHECK-4 read
  events.jsonl line-by-line and parse each line as JSON; T-CHECK-3
  reads `check-result.json` and verifies the keys; T-CHECK-5 captures
  the events.jsonl size and the state.json contents before invoking
  the executor and re-reads them after to confirm zero mutation.

## Architecture Decisions

1. **`CheckResult` is snake_case** in both the runner's return value
   and the on-disk artifact. Unlike the P6 split (camelCase
   `ProcessRunner.run()` result mapped to snake_case `ScriptResult`),
   the P7 `CheckRunner` returns the on-disk shape directly. Rationale:
   `CheckResult` is a small, simple structure with no camelCase JS
   conventions in the field names; introducing a camel-to-snake mapping
   layer adds friction without value. The Engine still wraps the
   runner output before persisting (it is the single writer of disk
   state), so the boundary is preserved.

2. **`CheckRunner` is a port, kinds are a registry.** The port has a
   single `run(opts)` method. The runner internally dispatches to a
   kind registry keyed by `check_id`. WF-P7-CHECK ships the port and
   a `LocalCheckRunner` stub that throws `CheckError` for any
   unregistered kind. Specific kinds (file-exists, json-parse,
   json-schema, …) ship in subsequent workflows under TD-P7-002. This
   keeps the executor's responsibility scoped to orchestration and
   state, not check semantics.

3. **Unknown kinds fail before any event is appended.** Per
   mvp-contracts §7, `CheckError` covers "check input missing". A
   missing kind is treated the same way: the executor resolves the
   kind first, and if resolution fails, no `step_started` is emitted.
   This preserves the invariant that every `step_started` is paired
   with a terminal `step_completed | step_failed` event.

4. **`on_pass: continue` is the default success transition;
   `on_fail` defaults to `fail` (which lands the job in `failed`).**
   The literal `fail` / `block` and the object forms
   `{ status: "failed" }` / `{ status: "blocked" }` are honoured in
   this slice. The control-flow forms `retry_job` / `activate_job` /
   `goto_job` are registered as TD-P7-003.

5. **Reuse the P6 single-write snapshot pattern.** The executor writes
   the running snapshot once (after `step_started`) and the terminal
   snapshot once (after the last event of the sequence). This matches
   the P6 script executor and is the established convention; no new
   snapshot-write strategy is introduced.

6. **`PermissionError` ships in this slice but is not yet thrown by any
   in-scope code path.** It is added to `src/utils/errors.ts` so the
   forthcoming TD-P7-002 kind implementations (forbidden-paths,
   read-only-modified, sensitive-state) can throw it without
   re-touching the error taxonomy. T-CHECK-5 verifies `CheckError`;
   `PermissionError` gains its first call-site test together with the
   read-only kind that produces it.

## Red-Phase Expectations

- `src/check/executor.ts` does not exist; tests fail at module
  resolution. After WF-P7-CHECK Step 2 ships the file, all T-CHECK-N
  tests should turn green.
- `StepBaseSchema` does not yet declare `on_pass` / `on_fail` as
  first-class fields. The workflow loader currently passes them through
  under the `[key: string]: unknown` index signature on
  `StepDefinition`, so `createRun` succeeds even before Step 2 extends
  the schema. Step 2 must extend the schema to make `on_pass` /
  `on_fail` first-class (D2 in the upcoming development plan).
- `executeCurrentStep` does not yet route `type: "check"` to
  `executeCheckStep`; `tests/check/executor.test.ts` imports
  `executeCheckStep` directly, so the dispatch wiring is independent of
  the red-phase test surface.
- `CheckError` and `PermissionError` may already exist in
  `src/utils/errors.ts` (Step 1 stubs from the broader error taxonomy
  effort) or may need to be added in Step 2. T-CHECK-5 imports the
  class via the public utils re-export; if the class is missing the
  import fails, which is acceptable red-phase behaviour.

## Step 2 Handoff Notes

1. `src/check/executor.ts` MUST export `executeCheckStep` with a
   signature structurally compatible with:

   ```ts
   export interface CheckResult {
     passed: boolean;
     check_id: string;
     failures: string[];
     artifacts: string[];
   }

   export interface CheckRunnerRunOpts {
     checkId: string;
     jobId: string;
     stepId: string;
     runDir: string;
     with?: Record<string, unknown>;
   }

   export interface CheckRunner {
     run(opts: CheckRunnerRunOpts): Promise<CheckResult>;
   }

   export interface ExecuteCheckStepOpts {
     runDir: string;
     zigmaflowDir: string;
     runId: string;
     jobId: string;
     clock: Clock;
     runner: CheckRunner;
   }

   export function executeCheckStep(opts: ExecuteCheckStepOpts): Promise<void>;
   ```

   When called from `executeCurrentStep`, the wrapper supplies
   `runner ?? new LocalCheckRunner()`.

2. The orchestration order MUST be: resolve check kind (throw
   `CheckError` on unknown) → append `step_started` → call
   `runner.run(...)` → write `check-result.json` → append
   `check_completed` → (success) append `step_completed` →
   (if no remaining steps) append `job_completed` /
   (failure) append `step_failed` → atomic snapshot write.

3. `check-result.json` written under
   `<runDir>/jobs/<jobId>/attempts/<attempt>/steps/<stepId>/check-result.json`
   MUST use snake_case fields `{ passed, check_id, failures, artifacts }`.

4. `step_failed.payload.reason` MUST contain the substring
   `"check failed"`. If `result.failures.length > 0`, the first
   failure string SHOULD be appended for diagnostic detail.

5. `executeCurrentStep` in `src/engine/index.ts` MUST dispatch
   `type: "check"` to `executeCheckStep` (with the same
   `zigmaflowDir` / `clock` / `runner` plumbing as the script branch).
   Non-script / non-check types continue to throw `WorkflowError`
   (TD-P7-001).

6. Schema extension in `src/workflow/index.ts` MUST add the explicit
   `on_pass` and `on_fail` fields (both optional `RouterAction`) to
   `StepBaseSchema` and to the `StepDefinition` interface.

7. `src/utils/errors.ts` MUST export `CheckError` (exit code 1) and
   `PermissionError` (exit code 1); `src/utils/index.ts` re-exports
   both.

## Test Gaps

- **Concrete check kind behaviour**: T-CHECK-1..5 use a FakeCheckRunner
  with a single registered kind. The full Skill Pack check kind list
  (file-exists, json-parse, json-schema, required-fields, git-diff,
  forbidden-paths, sensitive-state, read-only-modified) is TD-P7-002
  and lands in a follow-on workflow.
- **`on_fail: { status: "blocked" }` transition**: TD-P7-004; tracked
  for inclusion in Step 2 / Step 3 of this phase as T-CHECK-4b.
- **`on_pass` object forms**: not exercised — `continue` is the only
  literal supported in this slice; object forms (`retry_job`,
  `activate_job`, `goto_job`) are TD-P7-003.
- **PermissionError call sites**: class is added but no test triggers
  it; the read-only modified kind (TD-P7-002) is the first call site.
- **Multi-step job step pointer advancement**: TD-P6-004 (inherited);
  T-CHECK-1's `job_completed` assertion is valid only for single-step
  jobs.
- **Engine dispatch for non-script/non-check types**: covered
  indirectly by the existing WF-P6-DISPATCH T-DISPATCH-3 (extended in
  Step 2 to recognise check as well as script).
