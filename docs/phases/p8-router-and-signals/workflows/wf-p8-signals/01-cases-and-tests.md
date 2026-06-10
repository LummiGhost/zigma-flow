---
workflow: WF-P8-SIGNALS
phase: p8-router-and-signals
step: 1 (Cases and Tests)
date: 2026-06-10
authority: docs/mvp-contracts.md §2.1, docs/architecture.md §7.1, §7.2
author: subagent (workflow Step 1)
---

# WF-P8-SIGNALS — Cases and Tests

> **Signal vocabulary note.** In this workflow "signal" refers to the
> **routing decision signal** that flows from a router step or from a
> step's `on_failure` / `on_pass` field into the Engine. It is NOT
> the same as an **Agent-submitted signal** (mvp-contracts §2.6,
> prd §FR-010), which is the structured request an Agent writes into
> `report.json`. Agent signal submission is **TD-P8-002** (deferred
> to P9). The `signal_received` event payload defined by
> mvp-contracts §2.4 is therefore reused by this slice **only** to
> record the routing decision that the Engine is about to apply —
> Agent-driven signal_received emission is out of scope.

## 0. Slice Boundary

- **Slice name:** **P8-SIGNALS**
- **Bounded contexts:**
  - **Engine signal-handler dispatch** (architecture.md §7.1, §7.2)
    — owns a new `applyRoutingAction(opts)` entry point inside
    `src/engine/index.ts` that maps a `RouterAction` to a Job-status
    transition (and the matching events).
  - **Retry lifecycle** (architecture.md §7.2, prd §FR-012, P6 dev
    plan TD-P6-002) — owns the `attempt` counter increment,
    `current_step` reset, and `max_attempts` enforcement for the
    `retry_job` action.
  - **Optional-job activation** (architecture.md §7.2, prd §FR-011)
    — owns the `inactive → ready` transition for `activate_job`,
    plus the optional / required guard.
  - **Job-skip / goto** (architecture.md §7.2) — owns the
    `running → completed` (skip-source) and `inactive|waiting →
    ready` (goto-target) double-transition for `goto_job`.
  - **Event taxonomy reuse** (mvp-contracts §2.4) — emits the
    pre-existing `signal_received`, `job_retrying`, and
    `job_completed` event types declared in
    `src/events/eventTypes.ts`. Two new payload shapes are
    introduced for `job_activated` and `job_skipped` (added to the
    Step 2 event union; see §10 Step 2 Handoff Notes).

- **Bounded context interactions:**
  - **Consumes** the `RouterAction` union from
    `src/workflow/index.ts` (the same union WF-P8-ROUTER already
    consumes). No schema change.
  - **Consumes** the `router_decided` event written by
    WF-P8-ROUTER for object-form actions (`retry_job`,
    `activate_job`, `goto_job`). The signal handler is the
    contractual consumer of the router decision that
    WF-P8-ROUTER deferred under TD-P8-005.
  - **Consumes** the step-failure path of the P6 script executor
    (`on_failure`) and P7 check executor (`on_fail`). Today both
    executors only support `status: failed | blocked` overrides;
    the rest of the action vocabulary (`retry_job`, `activate_job`,
    `goto_job`) was registered as TD-P6-002 / TD-P7-001 and is
    delivered by this slice. Both executors will route the
    `on_failure` / `on_fail` value through the signal handler when
    the action is one of the three object-form actions.
  - **Consumes** `advanceJob(opts)` (WF-P8-MULTISTEP). The
    `continue` literal action delegates to `advanceJob`; this slice
    does NOT re-implement pointer arithmetic.
  - **Produces** the `applyRoutingAction(opts)` Engine entry; the
    `job_activated` and `job_skipped` event payload types; and the
    `attempt` counter mutation rules.
  - **MUST NOT** be called by the CLI. `executeCurrentStep`,
    `executeScriptStep`, `executeCheckStep`, and `executeRouterStep`
    are the only legitimate callers. The CLI's `step`/`run`
    commands reach the signal handler only through the executor
    layer.
  - **MUST NOT** accept Agent-submitted signals. The
    `signal_received` event payload from mvp-contracts §2.4 has the
    shape `{ signal, from_job, from_step }`; in this slice the
    payload is filled with the **routing action** (e.g.
    `signal: "retry_job"`) sourced from the workflow definition,
    NOT from an Agent report. Agent-driven `signal_received`
    emission is **TD-P8-002 / P9**.
  - **MUST NOT** evaluate expressions. The action shapes are
    consumed verbatim from the workflow definition (already
    validated by `RouterActionSchema`); no `${{ steps.x.outputs.y }}`
    interpolation in this slice (TD-P8-001 / P9).
  - **MUST NOT** double-emit `step_failed`. When the P6 / P7
    executor has already emitted `step_failed` for the failing
    step, the signal handler reads the persisted failure and emits
    only the *state-transition* event (`job_retrying`,
    `job_activated`, or `job_skipped`); it does NOT re-emit
    `step_failed`.
  - **MUST NOT** mutate `state.last_event_id` independently. Every
    snapshot the signal handler writes MUST carry `last_event_id`
    equal to the tail of `events.jsonl` after its own appends.
  - **MUST NOT** advance the step pointer of the *target* job in
    `goto_job` and `activate_job`. The target job is left at its
    default `current_step` (absent → first step on next dispatch),
    matching the convention in WF-P8-MULTISTEP `FP-MULTISTEP-POINTER-INIT`.

## 1. Workflow Goal

Deliver the signal-handler entry that converts a `RouterAction` into
an Engine state transition so that a user who has defined a workflow
with multi-step jobs, retryable jobs, optional jobs, and routing
branches can drive the workflow through `retry_job`, `activate_job`,
and `goto_job` outcomes — sourced from either a router step or a
step-level `on_failure` / `on_pass` field — and observe deterministic
state.json transitions plus a complete audit trail of `signal_received`,
`job_retrying`, `job_activated`, and `job_skipped` events. All state
mutation continues to flow through the Engine; CLI commands never
write `state.json` directly; Agent signal submission remains out of
scope (TD-P8-002).

**Deliverables:**

1. `applyRoutingAction(opts)` in `src/engine/index.ts` — pure
   action-to-transition translator that:
   - Reads the current run state via `LocalStateStore`.
   - Validates that the supplied action is one of the six
     `RouterAction` shapes.
   - Emits `signal_received` recording the action that the Engine
     is about to apply (sourced from `router_decided` or from the
     executor's `on_failure` / `on_fail` field).
   - Applies the corresponding transition (see §4 Functional
     Points for the per-action contract).
   - Writes a single state snapshot per call.
2. P6 / P7 executor integration: `executeScriptStep` and
   `executeCheckStep` route their on-failure / on-pass branches
   through `applyRoutingAction` when the action is one of the
   three object-form actions (retiring TD-P6-002 / TD-P7-001).
   Status-only overrides (`status: failed | blocked`) keep their
   existing inlined behaviour.
3. Router step integration: WF-P8-ROUTER's "deferred" branch
   (`router_decided` only, job remains `running`) becomes
   "router_decided + applyRoutingAction" so object-form router
   actions complete the transition in one Engine call.
4. `job_activated` and `job_skipped` event payload types added to
   `src/events/eventTypes.ts` and re-exported from
   `src/events/index.ts`. The `signal_received` payload shape is
   reused as-is.
5. `tests/engine/signals.test.ts` — red-phase tests for
   `applyRoutingAction` covering every action / state combination
   plus the max-attempts guard. **This workflow Step 1 ships only
   the cases-and-tests document and the failing test file; the
   handler source ships in Step 2.**

## 2. "用户可完成" Milestones

- **M1 — 用户可执行一个包含多 step、retry、optional job 和 routing
  分支的 workflow，并通过 `on_fail` 重试或激活可选 job，最终完成或
  失败**: 用户编写一个 workflow，其中包含：
  - `implement` (job, retry max_attempts: 3, retryable)
    - `code` (script step)
    - `static-check` (check step with `on_fail: { retry_job: implement }`)
  - `architecture-design` (optional job, `activation: optional`)
  - `review` (job needs implement) 内含 router step，
    - `cases: { approved: continue, needs_architecture: { activate_job: architecture-design }, rejected: { retry_job: implement } }`

  用户依次执行 `zigma-flow step --job <X>` 命令，期望得到：

  - 当 `static-check` 失败且 `attempt < 3`：events.jsonl 出现
    `step_failed` → `signal_received` (signal: retry_job, target:
    implement) → `job_retrying` (attempt += 1)；`state.jobs.implement
    .status === "ready"`；`state.jobs.implement.current_step` 被清
    除；`state.jobs.implement.attempt === 2`；下一次 `zigma-flow
    step --job implement` 从 `steps[0]` 重新开始。
  - 当 `static-check` 第 3 次失败：events 中 **没有** `job_retrying`，
    而是 `step_failed` → `signal_received`（recording the would-be
    retry_job action） → `job_completed`(无) → state 进入
    `blocked`（由 workflow `retry.on_exceeded.status` 决定）。
  - 当 router 解出 `activate_job: architecture-design`：events 出现
    `router_decided` → `signal_received` (signal: activate_job,
    target: architecture-design) → `job_activated` (job_id:
    architecture-design)；`state.jobs.architecture-design.status` 从
    `"inactive"` 切到 `"ready"`；`state.jobs["architecture-design"].activation_reason`
    记录触发原因（router step id 加 case key）。
  - 当 router 解出 `goto_job: cleanup`：events 出现
    `router_decided` → `signal_received` (signal: goto_job, target:
    cleanup) → `job_skipped` (job_id: review)；review job 的 status
    从 `"running"` 切到 `"completed"`，且 `current_step` 字段被清除；
    目标 cleanup job 从 `"waiting"` 或 `"inactive"` 切到 `"ready"`
    （若依赖已满足）。
  - 所有快照写入后 `state.last_event_id` 都与 events.jsonl 尾部一致。

  这是单一 "用户可完成" 任务（"signal-driven workflow lifecycle"），
  其执行路径在 M1 内部展开为 8 条期望子结果。

## 3. Spec Compliance Matrix

下表覆盖 mvp-contracts.md §2.1、§2.3、§2.4、§2.7、§6 中关于
**routing action 处理** 和 **job 状态转换** 的 MUST / SHALL /
强制性条款，以及 architecture.md §7.1 / §7.2 / §7.3、prd.md
§FR-009 / §FR-011 / §FR-012 中与 signal handling 相关的强制条款。

| Clause ID | Clause Source | Clause Text (Summary) | Status |
| --- | --- | --- | --- |
| SC-S01 | mvp-contracts §2.1 | Router action 必须只允许 `continue` / `fail` / `block` / `retry_job` / `activate_job` / `goto_job` 六种动作. | 已纳入本工作流 — FP-SIG-ACTION-UNION；T-SIGNALS-1..7 覆盖六种 action 的处理；非法 action 由 `RouterActionSchema` 在 workflow 加载阶段拒绝（消费现有保证）. |
| SC-S02 | mvp-contracts §2.3 | `state.json` 只能由 Engine 通过 State Store 写入. | 已纳入本工作流 — FP-SIG-STATE-WRITE；`applyRoutingAction` 是唯一新增的 Engine 入口；所有快照写入走 `LocalStateStore.writeSnapshot`. |
| SC-S03 | mvp-contracts §2.3 | 写入顺序为 append event 后原子替换 state snapshot；`state.last_event_id` 必须等于 events.jsonl 尾部. | 已纳入本工作流 — FP-SIG-EVENT-FIRST；T-SIGNALS-1..7 在每个 happy-path 都断言 `state.last_event_id === events tail`. |
| SC-S04 | mvp-contracts §2.4 | 每个状态变化都必须对应 event；`signal_received`, `job_retrying`, `job_completed` 是 MVP 关键事件类型. | 已纳入本工作流 — FP-SIG-EVENT-SIGNAL-RECEIVED, FP-SIG-EVENT-RETRYING, FP-SIG-EVENT-ACTIVATED, FP-SIG-EVENT-SKIPPED；T-SIGNALS-3, T-SIGNALS-4, T-SIGNALS-5 断言对应 event 至少出现一次. |
| SC-S05 | mvp-contracts §2.7 (Script Result Contract) | "是否 continue、failed、retry 或 blocked 由 Engine 和 Gate 决定" — Script Step 不直接推进 job status. | 已纳入本工作流 — FP-SIG-EXECUTOR-DELEGATION；T-SIGNALS-9 通过 script step + `on_failure: { retry_job: <self> }` 验证 retry 经由 signal handler 推进，不在 script executor 内部完成. |
| SC-S06 | mvp-contracts §6 (JobRun) | "completed job 不应被重新执行，除非 Engine 执行合法 retry transition；retry 必须增加 attempt，并保留历史 attempt artifacts". | 已纳入本工作流 — FP-SIG-RETRY-ATTEMPT-INCREMENT；T-SIGNALS-3 断言 `state.jobs[jobId].attempt` 在 retry 后增加 1. Artifact 隔离由 P3/P4 artifact 系统保证（不在 signal slice 重新验证；交叉引用 mvp §2.5 由 P4 测试覆盖）. |
| SC-S07 | mvp-contracts §6 (JobRun) | "retry 超过 `max_attempts` 后进入 blocked 或 failed，按 workflow 声明执行". | 已纳入本工作流 — FP-SIG-RETRY-MAX-GUARD；T-SIGNALS-8 通过设置 `retry.max_attempts: 2` 并触发第 3 次 retry，断言 job 进入 `blocked`（默认）且 events 不含 `job_retrying`. |
| SC-S08 | architecture §7.1 | Engine 对外暴露少量命令式入口；CLI 命令只调用这些入口，不直接改 run state. | 已纳入本工作流 — FP-SIG-ENGINE-ENTRY；`applyRoutingAction` 是从 `src/engine/index.ts` 的 named export，被 P6/P7/Router executor 调用，不被 CLI 调用. |
| SC-S09 | architecture §7.2 | Job status 合法转换包含 `running → failed`, `running → blocked`, `completed → retrying → ready`, `inactive → ready`, `inactive → waiting → ready`. | 已纳入本工作流 — FP-SIG-TRANSITION-FAIL, FP-SIG-TRANSITION-BLOCK, FP-SIG-TRANSITION-RETRY, FP-SIG-TRANSITION-ACTIVATE, FP-SIG-TRANSITION-GOTO；T-SIGNALS-1..7 覆盖五种合法转换. 非法转换（例如 `failed → ready` 不经 retry）由 FP-SIG-INVALID-TRANSITION 守护，对应 T-SIGNALS-10. |
| SC-S10 | architecture §7.3 | 写入流程: 计算 transition, 追加 event, 写 `state.json.tmp`, 原子替换 `state.json`. | 已纳入本工作流 — FP-SIG-STATE-WRITE；遵循 P3/P6/P7 已有的单写快照模式. |
| SC-S11 | prd §FR-011 | 激活 optional job 必须来自预定义 signal action 或 router action；`job_activated` event 必须记录 reason. | 已纳入本工作流 — FP-SIG-ACTIVATE-OPTIONAL-GUARD, FP-SIG-EVENT-ACTIVATED；T-SIGNALS-5 断言 `job_activated.payload.reason` 非空；T-SIGNALS-11 断言激活 required job → `WorkflowError`. |
| SC-S12 | prd §FR-012 | 支持 `max_attempts`；每次 attempt 拥有独立 artifact 目录；超过 `max_attempts` 后按 `on_exceeded` 处理；`job_retried` event 必须记录 attempt、reason. | 已纳入本工作流 — FP-SIG-RETRY-ATTEMPT-INCREMENT, FP-SIG-RETRY-MAX-GUARD, FP-SIG-EVENT-RETRYING；T-SIGNALS-3 断言 `job_retrying.payload.attempt` 与 reason；T-SIGNALS-8 断言 max_attempts 守护. Artifact 目录隔离由 P3/P4 已实现并在 mvp §2.5 测试覆盖；本 slice 仅断言 attempt 计数器变化，不重新验证 artifact path. |
| SC-S13 | prd §FR-009 | 所有 router 决策必须写入 event log；router step 不允许任意表达式副作用. | 已纳入本工作流 — FP-SIG-EVENT-SIGNAL-RECEIVED；signal handler 在 transition 之前补一条 `signal_received` 事件，保留完整决策审计链（router_decided → signal_received → job_*）. |

**Spec clause count:** 13 in-scope clauses (within the ≤15 envelope);
2 technical-debt registrations below.

| TD ID | Spec Reference | Description | Deferred To |
| --- | --- | --- | --- |
| TD-P8-002 | prd §FR-010, mvp-contracts §2.6 | Agent-submitted signals via `report.json` (`signal_received` from an Agent Step rather than from a routing action). The `signal_received` event emitted by this slice is workflow-driven (routing decisions); Agent signal submission and validation against `signals.allowed_from` is deferred. | P9 |
| TD-P8-001 | mvp-contracts §2.1, prd §FR-009 | Router expression evaluation (`${{ steps.X.outputs.Y }}` etc.). `applyRoutingAction` consumes literal `RouterAction` values; the workflow author must inline the resolved decision into `cases` until P9. | P9 (inherits from WF-P8-ROUTER TD-P8-001) |

## 4. Functional Points

| FP id | Area | Source | Summary |
| --- | --- | --- | --- |
| FP-SIG-ENGINE-ENTRY | Engine entry | arch §7.1 | `applyRoutingAction(opts)` is a named export of `src/engine/index.ts` with signature `(opts: { runDir, runId, sourceJobId, sourceStepId, attempt, action: RouterAction, reason, clock }) => Promise<void>`. Called by P6 script executor (`on_failure` object form), P7 check executor (`on_fail` / `on_pass` object form), and WF-P8-ROUTER `executeRouterStep` (object-form router actions). NOT called by the CLI directly. |
| FP-SIG-ACTION-UNION | Action validation | mvp §2.1 | The supplied action MUST be one of the six `RouterAction` shapes. Unknown shape → throw `WorkflowError`. Reuses the existing `RouterActionSchema` (no new validator). |
| FP-SIG-EVENT-SIGNAL-RECEIVED | `signal_received` emission | mvp §2.4, prd §FR-009 | BEFORE applying the transition, append exactly one `signal_received` event with payload `{ signal, from_job, from_step }` where `signal` is the action discriminator string (`"retry_job"`, `"activate_job"`, `"goto_job"`, `"fail"`, `"block"`, `"continue"`), and `from_job` / `from_step` identify the originating step. The event provides a single canonical audit point for "which workflow decision the Engine is about to apply". |
| FP-SIG-TRANSITION-CONTINUE | `continue` action | arch §7.2 | If `action === "continue"`: emit `signal_received` then delegate to `advanceJob(runId, sourceJobId)` (WF-P8-MULTISTEP). Do NOT mutate status directly. |
| FP-SIG-TRANSITION-FAIL | `fail` action | arch §7.2 | If `action === "fail"`: emit `signal_received`, set `state.jobs[sourceJobId].status = "failed"`, write snapshot. NO additional `step_failed` emission (the executor has already emitted it for the failure path; for success-path `on_pass: fail` the executor emits `step_completed` first and the handler appends the transition snapshot). |
| FP-SIG-TRANSITION-BLOCK | `block` action | arch §7.2 | If `action === "block"`: emit `signal_received`, set `state.jobs[sourceJobId].status = "blocked"`, write snapshot. |
| FP-SIG-TRANSITION-RETRY | `retry_job` action | arch §7.2, prd §FR-012 | If `action === { retry_job: <target> }` (target may equal `sourceJobId` for self-retry, the MVP common case): (a) read workflow `jobs[<target>].retry.max_attempts`; (b) compute next attempt = `(state.jobs[<target>].attempt ?? 1) + 1`; (c) if next attempt > max_attempts → see FP-SIG-RETRY-MAX-GUARD; (d) emit `signal_received`, then `job_retrying` with payload `{ job_id, attempt: nextAttempt, reason }`; (e) update state: `status = "ready"`, `current_step = undefined`, `attempt = nextAttempt`, `retry_reason = reason` (carried from `opts.reason`). Per FP-SIG-RETRY-ATTEMPT-INCREMENT and SC-S06, prior attempt artifacts are NOT touched. |
| FP-SIG-RETRY-ATTEMPT-INCREMENT | Attempt counter | mvp §6, prd §FR-012 | `state.jobs[<target>].attempt` is incremented by exactly 1 per retry. If the field was absent (first execution: attempt logically 1), the post-retry value is 2. Initial run attempt is implicitly 1 (artifact dirs use `attempts/1/...`). |
| FP-SIG-RETRY-MAX-GUARD | Max attempts | mvp §6, prd §FR-012 | If `(state.jobs[<target>].attempt ?? 1) + 1 > retry.max_attempts`: emit `signal_received` (the would-be retry decision is still audited), then DO NOT emit `job_retrying`; set `state.jobs[<target>].status = "blocked"` (the MVP default; future: honour `retry.on_exceeded.status`); write snapshot. Caller observes the absence of `job_retrying` as the contractual "max exceeded" signal. |
| FP-SIG-TRANSITION-ACTIVATE | `activate_job` action | arch §7.2, prd §FR-011 | If `action === { activate_job: <target> }`: (a) read workflow `jobs[<target>].activation`; (b) if `activation === undefined` (i.e., target is a REQUIRED job, not optional) → throw `WorkflowError` (FP-SIG-ACTIVATE-OPTIONAL-GUARD); (c) emit `signal_received`, then `job_activated` with payload `{ job_id, reason }`; (d) update state: if current status is `"inactive"`, set to `"ready"` (or `"waiting"` if DAG needs are unmet — recomputed via `computeReadyJobs`); record `state.jobs[<target>].activated = true` and `activation_reason = opts.reason`. Idempotent: if current status is already non-`inactive`, emit only `signal_received` and a no-op snapshot (no `job_activated`). |
| FP-SIG-ACTIVATE-OPTIONAL-GUARD | Optional/required guard | prd §FR-011 | Activating a job whose workflow definition does NOT declare `activation` is a structural error → `WorkflowError`. Activating an already-active job (status not `inactive`) is idempotent — no second `job_activated` event. |
| FP-SIG-TRANSITION-GOTO | `goto_job` action | arch §7.2, P8 dev plan §5 D4 | If `action === { goto_job: <target> }`: (a) emit `signal_received`; (b) if `sourceJobId !== <target>`: set `state.jobs[sourceJobId].status = "completed"`, clear `current_step`; emit `job_skipped` with payload `{ job_id: sourceJobId, target: <target>, reason }`; (c) if target's current status is `"inactive"` or `"waiting"`: set to `"ready"` (or leave `"waiting"` if DAG needs unmet); (d) write snapshot once. Target job is NOT automatically executed — next dispatch via `zigma-flow step --job <target>` runs it. |
| FP-SIG-EVENT-RETRYING | `job_retrying` payload | mvp §2.4 | Payload shape `{ job_id, attempt, reason }`. `attempt` is the NEW attempt number (post-increment). `reason` is propagated from `opts.reason` (e.g., `"router decided: retry_job (case: rejected)"` or `"check failed: forbidden-paths"`). |
| FP-SIG-EVENT-ACTIVATED | `job_activated` payload | mvp §2.4 (new payload) | Payload shape `{ job_id, reason }`. NEW payload type added to `src/events/eventTypes.ts` in Step 2 (the event TYPE tag `job_activated` is NOT in the current 17-type union; Step 2 adds it). |
| FP-SIG-EVENT-SKIPPED | `job_skipped` payload | arch §7.2 ("waiting → skipped" transition; reused for goto skip) | Payload shape `{ job_id, target, reason }`. NEW payload type added in Step 2. |
| FP-SIG-EVENT-FIRST | Event-then-snapshot ordering | arch §7.3 | Per call: append events first (signal_received → optional state-transition event), then write a single state snapshot whose `last_event_id` matches the tail. No interim snapshots. |
| FP-SIG-STATE-WRITE | Single writer | mvp §2.3 | All snapshot writes go through `LocalStateStore.writeSnapshot`. No direct `fs.writeFile` of `state.json`. |
| FP-SIG-EXECUTOR-DELEGATION | P6/P7 delegation | mvp §2.7, P6 dev plan TD-P6-002, P7 dev plan TD-P7-001 | When the P6 script executor sees `on_failure` as an object-form action (or the P7 check executor sees `on_fail` / `on_pass` as one), the executor: (1) emits its own `step_failed` / `step_completed`; (2) does NOT write the terminal snapshot; (3) calls `applyRoutingAction` with the object-form action; (4) the handler emits the signal events and writes the terminal snapshot. Status-only overrides (`{ status: "failed" | "blocked" }`) keep their existing inlined path. |
| FP-SIG-INVALID-TRANSITION | Illegal status transition | arch §7.2 | If the supplied transition would violate the job status state machine (e.g., `failed → ready` without a retry path), throw `WorkflowError` BEFORE any event is appended. Cases covered: (a) `applyRoutingAction` invoked on a `completed`/`failed`/`blocked` source job with a non-retry action → `WorkflowError`; (b) activate target whose workflow has no `activation` field → `WorkflowError` (also covered by FP-SIG-ACTIVATE-OPTIONAL-GUARD). |
| FP-SIG-UNKNOWN-TARGET | Unknown target job | mvp §2.3 | If `action.retry_job`, `action.activate_job`, or `action.goto_job` references a job id that does NOT appear in the workflow → throw `WorkflowError` BEFORE any event is appended. |
| FP-SIG-STATE-MISSING | Missing state file | mvp §2.3 | If `LocalStateStore.readSnapshot` returns `null`, throw `StateError`. No event appended, no snapshot written. |

## 5. Use Case Enumeration

| UC id | Actor | Trigger | Pre-conditions | Steps (happy path / failure) | Post-conditions / observable result |
| --- | --- | --- | --- | --- | --- |
| UC-SIGNALS-1 | Engine (continue via on_pass) | A P7 check step passes; its `on_pass` field is the literal `"continue"`; the check is NOT the last step of a multi-step job. | Workflow defines a 2-step job (`check`, `lint`); state has `current_step = "check"`, job status `running`. | Check executor emits `step_completed`; then calls `applyRoutingAction({ action: "continue", sourceJobId, sourceStepId, … })`. Handler emits `signal_received` (`signal: "continue"`), then delegates to `advanceJob`, which writes a snapshot with `current_step = "lint"`. | events.jsonl contains `step_completed` → `signal_received` → (no `job_completed`). `state.jobs[jobId].current_step === "lint"`, status `running`. |
| UC-SIGNALS-2 | Engine (fail via on_fail) | A P7 check step fails; its `on_fail` is the literal `"fail"`. | Multi-step job in `running`; step failure. | Check executor emits `step_failed`; calls `applyRoutingAction({ action: "fail", reason: "check failed: forbidden-paths", … })`. Handler emits `signal_received` (`signal: "fail"`), then writes snapshot with `status = "failed"`. | events.jsonl tail (after handler): `step_failed` → `signal_received`. `state.jobs[jobId].status === "failed"`. |
| UC-SIGNALS-3 | Engine (block via on_fail) | Same as UC-SIGNALS-2 but `on_fail` is `"block"`. | Same. | Handler emits `signal_received` (`signal: "block"`); writes snapshot with `status = "blocked"`. | `state.jobs[jobId].status === "blocked"`. |
| UC-SIGNALS-4 | Engine (retry_job via on_fail) | P7 check step fails on `implement` job; `on_fail: { retry_job: "implement" }`; workflow has `jobs.implement.retry.max_attempts: 3`; current attempt is 1. | events.jsonl already contains `step_failed`; handler invoked with action `{ retry_job: "implement" }`, reason `"check failed: …"`. | Handler reads `state.jobs.implement.attempt = 1`; computes next attempt = 2; emits `signal_received` (`signal: "retry_job"`); emits `job_retrying` (`payload.attempt = 2`, `payload.reason = "check failed: …"`); writes snapshot with `status = "ready"`, `current_step` cleared, `attempt = 2`, `retry_reason = …`. | events.jsonl tail: `step_failed` → `signal_received` → `job_retrying`. `state.jobs.implement.status === "ready"`, `attempt === 2`, `current_step` absent, `retry_reason === "check failed: …"`. |
| UC-SIGNALS-5 | Engine (activate_job via router) | Router step in `review` job resolves to `{ activate_job: "architecture-design" }`; workflow declares `jobs.architecture-design.activation: optional`. | Workflow loaded; state has `jobs["architecture-design"].status === "inactive"`. Router emitted `router_decided`. | Handler emits `signal_received` (`signal: "activate_job"`, `from_job: "review"`); checks target activation = `"optional"` → permitted; emits `job_activated` with payload `{ job_id: "architecture-design", reason: "router decided: activate_job (case: needs_architecture_design)" }`; writes snapshot with `state.jobs["architecture-design"].status = "ready"` (DAG needs satisfied) and `activation_reason` recorded. | events.jsonl tail: `router_decided` → `signal_received` → `job_activated`. `state.jobs["architecture-design"].status === "ready"`. |
| UC-SIGNALS-6 | Engine (goto_job via router) | Router step in `review` resolves to `{ goto_job: "cleanup" }`. | `state.jobs["review"].status === "running"`; `state.jobs["cleanup"].status === "waiting"` (depends on `review`). | Handler emits `signal_received` (`signal: "goto_job"`); emits `job_skipped` with payload `{ job_id: "review", target: "cleanup", reason: "router decided: goto_job (case: stop)" }`; writes snapshot with `review.status = "completed"`, `review.current_step` cleared, `cleanup.status = "ready"`. | events.jsonl tail: `router_decided` → `signal_received` → `job_skipped`. `state.jobs.review.status === "completed"`, `cleanup.status === "ready"`. |
| UC-SIGNALS-7 | Engine (multiple sequential retries) | Three consecutive check failures with `on_fail: { retry_job: implement }`; `max_attempts: 3`. | Initial `attempt = 1`. | Failure 1 → handler emits `job_retrying` with `attempt = 2`. Failure 2 → handler reads `attempt = 2`, emits `job_retrying` with `attempt = 3`. Failure 3 → handler reads `attempt = 3`, the next computed attempt = 4 > max_attempts; handler emits `signal_received` but NO `job_retrying`; sets status to `blocked`. | After failure 3: events.jsonl contains exactly TWO `job_retrying` events (for attempts 2 and 3). `state.jobs.implement.attempt === 3`, `status === "blocked"`. |
| UC-SIGNALS-8 | Engine (max_attempts guard) | First-time invocation of retry on a job whose `attempt === max_attempts`. | `state.jobs[<target>].attempt = 3`; `workflow.jobs[<target>].retry.max_attempts = 3`. | Handler emits `signal_received` (audit), DOES NOT emit `job_retrying`, sets `status = "blocked"`. | events.jsonl tail: `signal_received`. No `job_retrying`. `state.jobs[<target>].status === "blocked"`, `attempt` unchanged. |
| UC-SIGNALS-9 | Engine (script `on_failure` retry_job) | P6 script step exits non-zero with `on_failure: { retry_job: <self> }`. | Multi-step job; script step has failed. | Script executor emits `step_failed`; calls `applyRoutingAction` with the retry_job action and reason `"exit code <N>"`. Handler emits `signal_received` → `job_retrying`; status → `ready`, attempt incremented, current_step cleared. | Same as UC-SIGNALS-4 but reason is the script exit-code message. |
| UC-SIGNALS-10 | Engine (negative — illegal transition) | Caller invokes `applyRoutingAction` on a job whose current status is `"failed"` with action `"continue"`. | `state.jobs[jobId].status === "failed"`. | Handler throws `WorkflowError` BEFORE appending events. | events.jsonl unchanged; state.json unchanged. |
| UC-SIGNALS-11 | Engine (negative — activate required job) | `applyRoutingAction({ activate_job: "implement" })` when `implement` has no `activation` field (required). | Workflow loaded; target job has no activation declaration. | Handler throws `WorkflowError` BEFORE any event. | events.jsonl unchanged; state.json unchanged. |
| UC-SIGNALS-12 | Engine (negative — unknown target) | `applyRoutingAction({ goto_job: "no-such-job" })`. | Target not in workflow. | Handler throws `WorkflowError` BEFORE any event. | events.jsonl unchanged; state.json unchanged. |

(12 use cases — within the 8–10 "core" envelope when filtered to the
nine anchor cases UC-SIGNALS-1..9, plus the three negative cases that
gate the FP / RC matrix.)

## 6. Test Plan

All tests live in **`tests/engine/signals.test.ts`** under
`describe("applyRoutingAction", ...)`. Vitest. Real temp directories
under `os.tmpdir()`. No filesystem mocking. The test file boots a real
run via `createRun` from `src/engine/index.ts`, optionally drives the
P6/P7 executor to surface `step_failed` / `step_completed`, then
invokes `applyRoutingAction` and asserts on the resulting
`state.json` / `events.jsonl`. Mirrors the bootstrap pattern of
`tests/engine/multistep.test.ts`.

| Test id | `it` description | What it verifies | UCs covered | FPs covered | SCs touched |
| --- | --- | --- | --- | --- | --- |
| T-SIGNALS-1 | `continue action — emits signal_received and delegates to advanceJob` | Multi-step job in running; call `applyRoutingAction({ action: "continue" })` directly (bypassing P7 executor). Assert: (a) events.jsonl contains a `signal_received` event with `payload.signal === "continue"`; (b) `state.jobs[jobId].current_step` advanced from `s1` → `s2`; (c) no `job_completed` event (job still running). | UC-SIGNALS-1 | FP-SIG-ENGINE-ENTRY, FP-SIG-EVENT-SIGNAL-RECEIVED, FP-SIG-TRANSITION-CONTINUE | SC-S01, SC-S04, SC-S08, SC-S09 |
| T-SIGNALS-2 | `fail action — emits signal_received and sets status to failed` | Multi-step job in running; call `applyRoutingAction({ action: "fail", reason: "router decided: fail" })`. Assert: (a) `signal_received.payload.signal === "fail"`; (b) `state.jobs[jobId].status === "failed"`; (c) `state.last_event_id === signal_received.id`. | UC-SIGNALS-2 | FP-SIG-EVENT-SIGNAL-RECEIVED, FP-SIG-TRANSITION-FAIL | SC-S03, SC-S04, SC-S09 |
| T-SIGNALS-3 | `block action — emits signal_received and sets status to blocked` | Same shape as T-SIGNALS-2 with `action: "block"`. Assert `status === "blocked"`. | UC-SIGNALS-3 | FP-SIG-TRANSITION-BLOCK | SC-S04, SC-S09 |
| T-SIGNALS-4 | `retry_job action — emits signal_received → job_retrying; resets pointer; increments attempt` | Workflow has `jobs.implement.retry.max_attempts: 3`; state has `jobs.implement.attempt = 1`, `current_step = "static-check"`, `status = "running"`. Call `applyRoutingAction({ action: { retry_job: "implement" }, reason: "check failed: forbidden-paths" })`. Assert: (a) events.jsonl tail: `signal_received` → `job_retrying`; (b) `job_retrying.payload.attempt === 2`; (c) `job_retrying.payload.reason === "check failed: forbidden-paths"`; (d) `state.jobs.implement.status === "ready"`; (e) `state.jobs.implement.current_step` is absent; (f) `state.jobs.implement.attempt === 2`. | UC-SIGNALS-4 | FP-SIG-TRANSITION-RETRY, FP-SIG-EVENT-RETRYING, FP-SIG-RETRY-ATTEMPT-INCREMENT | SC-S06, SC-S09, SC-S12 |
| T-SIGNALS-5 | `activate_job action — emits signal_received → job_activated; toggles status from inactive to ready` | Workflow has `jobs.architecture-design.activation: optional`; state has `jobs["architecture-design"].status = "inactive"`. Call `applyRoutingAction({ action: { activate_job: "architecture-design" }, reason: "router decided: activate_job (case: needs_architecture_design)" })`. Assert: (a) events.jsonl tail: `signal_received` → `job_activated`; (b) `job_activated.payload.reason` non-empty; (c) `state.jobs["architecture-design"].status === "ready"`. | UC-SIGNALS-5 | FP-SIG-TRANSITION-ACTIVATE, FP-SIG-EVENT-ACTIVATED, FP-SIG-ACTIVATE-OPTIONAL-GUARD | SC-S04, SC-S09, SC-S11 |
| T-SIGNALS-6 | `goto_job action — emits signal_received → job_skipped; completes source; readies target` | Workflow has `jobs.cleanup.needs: ["review"]`; state has `jobs.review.status = "running"`, `jobs.cleanup.status = "waiting"`. Call `applyRoutingAction({ action: { goto_job: "cleanup" }, sourceJobId: "review", reason: "router decided: goto_job (case: stop)" })`. Assert: (a) `job_skipped.payload === { job_id: "review", target: "cleanup", reason: ... }`; (b) `state.jobs.review.status === "completed"`; (c) `state.jobs.review.current_step` is absent; (d) `state.jobs.cleanup.status === "ready"`. | UC-SIGNALS-6 | FP-SIG-TRANSITION-GOTO, FP-SIG-EVENT-SKIPPED | SC-S04, SC-S09 |
| T-SIGNALS-7 | `multiple sequential retries — attempt counter monotonically increments` | Workflow with `max_attempts: 3`. Call `applyRoutingAction` with `retry_job` three times in succession (resetting attempt manually between calls only to simulate the post-execution state). Assert: (a) the first two calls each append a `job_retrying` event with `attempt` = 2 then 3; (b) the third call (attempt would become 4) appends a `signal_received` but NO `job_retrying`; (c) final `state.jobs[jobId].status === "blocked"`. | UC-SIGNALS-7, UC-SIGNALS-8 | FP-SIG-RETRY-MAX-GUARD, FP-SIG-RETRY-ATTEMPT-INCREMENT | SC-S06, SC-S07, SC-S12 |
| T-SIGNALS-8 | `retry beyond max_attempts — emits signal_received only, sets status to blocked, leaves attempt unchanged` | Single direct call with state `attempt = 3` and workflow `max_attempts = 3`. Assert: (a) events contain exactly one `signal_received` for the would-be retry; (b) NO `job_retrying`; (c) `state.jobs[jobId].status === "blocked"`; (d) `attempt` unchanged at `3`. | UC-SIGNALS-8 | FP-SIG-RETRY-MAX-GUARD | SC-S07, SC-S12 |
| T-SIGNALS-9 | `integration — script step on_failure: retry_job drives the full retry cycle via the script executor` | End-to-end: run `executeCurrentStep` on a script step whose `on_failure: { retry_job: <self> }`. The script exits with non-zero (use a fixture `run: "exit 1"`). The executor must NOT mutate state to `failed`; it must call `applyRoutingAction` which then emits `signal_received` → `job_retrying`. Assert events.jsonl contains the full `step_started` → `script_completed` → `step_failed` → `signal_received` → `job_retrying` sequence and `state.jobs[jobId].status === "ready"`, `attempt === 2`. | UC-SIGNALS-9 | FP-SIG-EXECUTOR-DELEGATION, FP-SIG-TRANSITION-RETRY | SC-S05, SC-S06, SC-S08 |
| T-SIGNALS-10 | `negative — applyRoutingAction throws WorkflowError on illegal source-state transition` | State has `jobs[jobId].status === "failed"`. Call `applyRoutingAction({ action: "continue" })`. Assert: (a) throws with `kind === "WorkflowError"`; (b) events.jsonl byte-content unchanged; (c) state.json byte-content unchanged. | UC-SIGNALS-10 | FP-SIG-INVALID-TRANSITION | SC-S09 |
| T-SIGNALS-11 | `negative — activate_job on a required job throws WorkflowError` | Target job has no `activation` field. Call `applyRoutingAction({ action: { activate_job: "implement" } })`. Assert: (a) throws with `kind === "WorkflowError"`; (b) events and state unchanged. | UC-SIGNALS-11 | FP-SIG-ACTIVATE-OPTIONAL-GUARD | SC-S11 |
| T-SIGNALS-12 | `negative — unknown target job throws WorkflowError` | `applyRoutingAction({ action: { goto_job: "ghost-job" } })`. Assert: (a) throws with `kind === "WorkflowError"`; (b) events and state unchanged. | UC-SIGNALS-12 | FP-SIG-UNKNOWN-TARGET | SC-S08, SC-S09 |
| T-SIGNALS-13 | `integration — check step on_fail: { retry_job } drives the full retry cycle via the check executor` | End-to-end: run `executeCurrentStep` on a check step that fails (e.g. file-existence check against a missing file) with `on_fail: { retry_job: <self> }`. Asserts the same event sequence as T-SIGNALS-9 but for the check executor. Demonstrates that BOTH script and check steps integrate with the signal handler. | UC-SIGNALS-9 (variant) | FP-SIG-EXECUTOR-DELEGATION | SC-S05, SC-S08 |

**Planned test file count:** 1 (`tests/engine/signals.test.ts`).
Within budget per granularity check.

## 7. Test Design Summary

- **Test framework:** vitest (`describe` / `it` / `expect` /
  `beforeEach` / `afterEach`). Mirrors the structure of
  `tests/engine/multistep.test.ts` and `tests/router/executor.test.ts`.
- **Imports under test:**
  - `applyRoutingAction` from `../../src/engine/index.js` (does
    not exist yet — red phase; module exists but the named export
    is missing). Lazy-import wrapper used so the test file compiles
    even before Step 2 lands.
  - `createRun`, `executeCurrentStep` from
    `../../src/engine/index.js` for sandbox setup and the
    integration tests.
  - `LocalStateStore`, `Clock` from `../../src/run/index.js` for
    snapshot mutation helpers.
- **Filesystem:** real temp directories under `os.tmpdir()` with
  `node:crypto.randomUUID()` suffixes; no fs mocking. Each test
  creates its own `<sandbox>/.zigma-flow/` skeleton (`config.json`,
  `skill-lock.json`, `runs/`). Same `makeSandbox` shape as
  `tests/engine/multistep.test.ts`.
- **Clock:** inline `FakeClock { now(): "2026-06-10T00:00:00.000Z" }`.
- **Workflow YAML fixtures:**
  - `RETRY_YAML` — `jobs.implement.retry.max_attempts: 3` with a
    static-check step using `on_fail: { retry_job: implement }`.
    Used by T-SIGNALS-4, T-SIGNALS-7, T-SIGNALS-8, T-SIGNALS-13.
  - `OPTIONAL_YAML` — `jobs.architecture-design.activation: optional`
    + a `review` job whose router step has
    `cases: { needs_architecture_design: { activate_job:
    architecture-design } }`. Used by T-SIGNALS-5, T-SIGNALS-11.
  - `GOTO_YAML` — `cleanup` job depends on `review`; review's
    router step has `cases: { stop: { goto_job: cleanup } }`. Used
    by T-SIGNALS-6.
  - `MULTI_STEP_YAML` — 2-step job for continue/fail/block direct
    tests. Used by T-SIGNALS-1, T-SIGNALS-2, T-SIGNALS-3,
    T-SIGNALS-10.
  - `SCRIPT_RETRY_YAML` — script step with `on_failure: { retry_job:
    <self> }`. Used by T-SIGNALS-9.
- **State mutation helper:** local `setJobState(runDir, jobId,
  patch)` reads `state.json`, deep-merges the patch into
  `state.jobs[jobId]`, and writes back via `LocalStateStore`. Used
  to pre-set `attempt`, `current_step`, `status`. Mirrors the
  helper in `tests/engine/multistep.test.ts`.
- **Pre/post evidence:** T-SIGNALS-10..12 (negative tests) capture
  `events.jsonl` byte-content and `state.json` byte-content before
  invoking the handler and re-read them after to confirm zero
  mutation. Same pattern as `tests/engine/multistep.test.ts`
  T-MULTISTEP-5..8.
- **Lazy import wrapper:** `callApplyRoutingAction(opts)` defined
  in the test file dynamically imports the engine module and
  inspects the named export; throws a descriptive Error if the
  export is missing. This mirrors the `callAdvanceJob` wrapper in
  `tests/engine/multistep.test.ts:90`. The wrapper keeps the test
  file compilable even during the red phase.

## 8. Architecture Decisions

1. **Single Engine entry point `applyRoutingAction`.** Rather than
   spread the signal-handling logic across P6/P7/Router executors,
   this slice introduces ONE function that all three call. This
   keeps the state transition rules co-located, testable in
   isolation, and ensures the `signal_received` event taxonomy is
   produced consistently. The executors retain ownership of their
   own step-level events (`step_started`, `step_completed`,
   `step_failed`, `script_completed`, `check_completed`,
   `router_decided`) — the handler ONLY owns the routing/transition
   events that follow.

2. **`signal_received` is the universal pre-transition event.**
   Per mvp-contracts §2.4, `signal_received` is a MVP key event
   type. This slice repurposes it as the canonical "Engine is about
   to apply a routing decision" marker — emitted exactly once per
   `applyRoutingAction` call, BEFORE any state-transition event.
   This gives every routing action a single audit point and lets
   downstream tooling reconstruct the decision chain
   (router_decided → signal_received → job_*) without parsing
   multiple disjoint payloads. Agent-driven `signal_received`
   emission (Agent submits signals via report.json) is **TD-P8-002**
   and will reuse the same event type but with the payload sourced
   from the report. The payload shape `{ signal, from_job,
   from_step }` is unchanged.

3. **Two new event payload types: `job_activated` and
   `job_skipped`.** Neither tag appears in the current 17-type
   `ZigmaFlowEventType` union (`src/events/eventTypes.ts:12`).
   Adding them is necessary for FR-011 (activate optional job)
   and FR-009 (goto skip semantics) to leave a complete audit
   trail. Step 2 extends the union and adds payload interfaces:
   - `JobActivatedPayload { job_id, reason }`
   - `JobSkippedPayload { job_id, target, reason }`
   `signal_received` and `job_retrying` are reused as-is.

4. **`retry_job` increments the attempt counter; does NOT touch
   artifacts.** Per mvp-contracts §6 / §2.5 and prd §FR-012, the
   attempt counter is the contract; artifact directory layout
   (`jobs/<id>/attempts/<n>/...`) is owned by the P3/P4 artifact
   system. This slice asserts the counter is incremented and
   `state.last_event_id` aligns with the appended `job_retrying`
   event; it does NOT re-test artifact directory creation
   (covered by `tests/artifact/...`).

5. **`current_step` reset on retry.** Per architecture §7.2
   (`completed → retrying → ready`) and WF-P8-MULTISTEP
   Architecture Decision 2, retry clears `current_step` so the
   next `executeCurrentStep` invocation runs `steps[0]`. WF-P8-MULTISTEP
   already documented this contract in `FP-MULTISTEP-POINTER-INIT`
   and T-MULTISTEP-9; this slice OWNS the act of clearing the
   pointer.

6. **`activate_job` is idempotent.** Multiple activate signals for
   the same target are harmless. If the target's current status is
   anything other than `"inactive"`, the handler emits
   `signal_received` (audit) but does NOT emit a second
   `job_activated` and does NOT mutate status. This protects
   against double-activation in workflows where multiple router
   steps may converge on the same optional job. Test coverage for
   the idempotent path is left as a follow-up TD (TD-P8-006); the
   first-activation happy path is covered by T-SIGNALS-5.

7. **`goto_job` is a two-job transition in a single call.** Per
   P8 dev plan §5 D4: "skip remaining steps in current job;
   prepare target for execution". The handler updates BOTH source
   (`status = "completed"`, `current_step` cleared) and target
   (`status = "ready"` if DAG needs satisfied, else `"waiting"`)
   in one snapshot write. The target is NOT auto-executed — user
   must run `zigma-flow step --job <target>`. This matches the
   "manual progression" CLI shape preserved through P6/P7.

8. **`max_attempts` exceeded → status = "blocked" (MVP default).**
   prd §FR-012 allows `on_exceeded: { status: blocked | failed }`
   to choose between the two terminals. In MVP this slice
   hard-defaults to `blocked` (matches the example in
   docs/prd.md §FR-012 lines 866–869 and architecture §7.2
   `ready → running → blocked`). Reading the workflow's
   `retry.on_exceeded.status` field is **TD-P8-007** (P9). When
   that field is honoured, T-SIGNALS-8 will expand to two cases
   (default-blocked vs explicit-failed); the current test asserts
   only the default.

9. **`signal_received` payload for routing actions.** The mvp
   payload shape `{ signal, from_job, from_step }` is reused
   verbatim. For routing actions the `signal` slot holds the
   action discriminator string (one of the six FR-009 vocabulary
   tokens). For Agent-submitted signals (TD-P8-002), the same
   field will hold the workflow-declared signal name (e.g.
   `"needs_architecture_design"`). This dual use is documented in
   the cases-and-tests for both slices; the discriminator can be
   inferred from the `producer` envelope field (`engine` vs
   `agent`) at the audit-log level.

10. **No new error classes.** All negative paths reuse
    `WorkflowError` (illegal transition, unknown target, required
    job activation) or `StateError` (missing state file). No
    `SignalError` class is needed; the routing-action vocabulary
    is closed and already validated by `RouterActionSchema`.

## 9. Red-Phase Expectations

- `src/engine/index.ts` does not yet export `applyRoutingAction`;
  the test file uses a lazy-import wrapper (`callApplyRoutingAction`)
  that throws a descriptive Error on missing export. After Step 2
  ships the named export, all T-SIGNALS-N tests should turn green
  (or remain red where the test depends on a P6/P7 executor change
  that Step 2 has not yet wired).
- `JobActivatedPayload` and `JobSkippedPayload` types are not yet
  declared in `src/events/eventTypes.ts`; Step 2 adds them and
  extends the `ZigmaFlowEventType` union (currently 17 tags;
  becomes 19 after adding `job_activated` and `job_skipped`).
- The P6 script executor `on_failure` branch and the P7 check
  executor `on_fail` / `on_pass` branches currently only honour
  `{ status: failed | blocked }`. Step 2 extends them to route
  object-form actions through `applyRoutingAction`. T-SIGNALS-9
  and T-SIGNALS-13 exercise this integration and will remain red
  until that wiring lands.
- `tests/engine/multistep.test.ts` MUST keep passing after this
  slice (the `advanceJob` contract is unchanged; `applyRoutingAction
  ({ action: "continue" })` simply delegates).
- `tests/router/executor.test.ts` T-ROUTER-4 / T-ROUTER-5 /
  T-ROUTER-6 will be UPDATED in Step 2: those tests today assert
  the deferred behaviour (router emits `router_decided` only,
  job stays `running`). After signal-handler integration, the
  router executor calls `applyRoutingAction` for object-form
  actions, so the tests must assert the full
  `router_decided → signal_received → (job_retrying | job_activated
   | job_skipped)` sequence. The Step 2 plan SHOULD document this
  test churn explicitly.

## 10. Step 2 Handoff Notes

1. `src/engine/index.ts` MUST export `applyRoutingAction` with a
   signature structurally compatible with:

   ```ts
   import type { RouterAction } from "../workflow/index.js";

   export interface ApplyRoutingActionOpts {
     runDir: string;
     runId: string;
     /** Source job id (the job whose step just completed or failed). */
     sourceJobId: string;
     /** Source step id (the step whose on_failure/on_pass triggered this). */
     sourceStepId: string;
     /** Attempt number of the source step. */
     attempt: number;
     /** The routing action to apply. */
     action: RouterAction;
     /** Human-readable reason carried to job_retrying / job_activated / job_skipped payloads. */
     reason: string;
     /** Clock for timestamping events. */
     clock: Clock;
   }

   export function applyRoutingAction(opts: ApplyRoutingActionOpts): Promise<void>;
   ```

2. The execution order MUST be:
   - Read `state.json` → if `null`, throw `StateError`.
   - Validate `opts.action` against the closed RouterAction shape
     (else `WorkflowError`).
   - Validate the source job exists in state (else `StateError`).
   - For object-form actions, resolve the target job id and
     validate it exists in the loaded `WorkflowDefinition.jobs`
     (else `WorkflowError` — FP-SIG-UNKNOWN-TARGET).
   - Compute the legal-transition guard (see FP-SIG-INVALID-TRANSITION).
     Specifically: if `sourceJobState.status` is one of
     `completed | failed | blocked` AND the action is NOT a
     `retry_job` whose target is the source job (the only legal
     `completed → retrying → ready` path), throw `WorkflowError`
     before any event.
   - Append `signal_received` event with payload `{ signal:
     <discriminator>, from_job: sourceJobId, from_step: sourceStepId }`.
   - Apply the per-action transition:
     - `"continue"`: delegate to `advanceJob`; do NOT write a
       separate snapshot here (advanceJob writes its own).
     - `"fail"`: set `sourceJob.status = "failed"`; write snapshot.
     - `"block"`: set `sourceJob.status = "blocked"`; write snapshot.
     - `{ retry_job }`:
       - Read `workflow.jobs[<target>].retry.max_attempts`
         (default: 1 → effectively no retry; treat absence as
         `1` and emit blocked on attempt 2).
       - Compute `nextAttempt = (target.attempt ?? 1) + 1`.
       - If `nextAttempt > max_attempts`: NO `job_retrying`; set
         `target.status = "blocked"`; write snapshot. (TD-P8-007:
         honour `on_exceeded.status` deferred.)
       - Else: emit `job_retrying` (`payload.attempt = nextAttempt`,
         `payload.reason`); set `target.status = "ready"`,
         `target.current_step = undefined`, `target.attempt =
         nextAttempt`, `target.retry_reason = reason`; write
         snapshot.
     - `{ activate_job }`:
       - Read `workflow.jobs[<target>].activation`; if undefined
         → `WorkflowError`.
       - If `target.status !== "inactive"`: idempotent (no
         `job_activated`); write snapshot only if `last_event_id`
         changed.
       - Else: emit `job_activated` (`payload.reason`); recompute
         readiness via `computeReadyJobs` to decide
         `"ready"` vs `"waiting"`; set `target.activated = true`,
         `target.activation_reason = reason`; write snapshot.
     - `{ goto_job }`:
       - Emit `job_skipped` (`payload.target`, `payload.reason`).
       - Set `sourceJob.status = "completed"`, clear
         `sourceJob.current_step`.
       - Recompute target readiness; if `target.status` was
         `"inactive"` or `"waiting"`, set to `"ready"` (or keep
         `"waiting"` if needs unmet).
       - Write single snapshot.
   - Write the snapshot exactly once per call (except the
     `continue` branch which delegates to `advanceJob`); the
     snapshot's `last_event_id` MUST equal the tail of
     `events.jsonl` after the appends.

3. `src/events/eventTypes.ts` MUST add the two new event tags
   and payload interfaces:

   ```ts
   export type ZigmaFlowEventType =
     | ... // existing 17
     | "job_activated"
     | "job_skipped";

   export interface JobActivatedPayload {
     job_id: string;
     reason: string;
   }

   export interface JobSkippedPayload {
     job_id: string;
     target: string;
     reason: string;
   }
   ```

   The discriminated `ZigmaFlowEvent` union and the `EVENT_TYPES`
   tuple MUST be updated correspondingly. `EVENT_TYPES.length`
   becomes 19; update any contract test that pins the length to 17.

4. `src/run/index.ts` MUST extend `JobState` to include the two
   optional retry / activation fields used by `applyRoutingAction`:

   ```ts
   export interface JobState {
     status: "ready" | "waiting" | "inactive" | "running" | "done" |
             "completed" | "failed" | "blocked";
     activation?: string;
     attempt?: number;
     current_step?: string;
     activated?: boolean;             // NEW: WF-P8-SIGNALS
     activation_reason?: string;      // NEW: WF-P8-SIGNALS
     retry_reason?: string;           // NEW: WF-P8-SIGNALS
   }
   ```

   These are optional fields per mvp-contracts §2.3 ("optional job
   `activated` and `activation_reason`; retry job `retry_reason`
   and `retry_inputs`"). MVP omits `retry_inputs` (TD-P8-008 / P9
   — depends on report-driven retry).

5. `src/script/executor.ts` `on_failure` branch and
   `src/check/executor.ts` `on_fail` / `on_pass` branches MUST
   detect object-form actions and route through
   `applyRoutingAction`. Status-only overrides retain their
   existing inlined path. Step 2 author updates the executor
   tests if assertion shapes shift.

6. `src/router/executor.ts` MUST replace the "deferred" branch
   for object-form actions (currently writes a snapshot with
   `last_event_id = routerDecidedId` and leaves status `running`)
   with a call to `applyRoutingAction`. The router slice's
   T-ROUTER-4 / T-ROUTER-5 / T-ROUTER-6 expectations need to be
   adjusted in Step 2 to assert the full event sequence.

7. The new event types require a contract-test update at
   `tests/events/eventTypes.test.ts` (if such a length pin
   exists). Step 2 author audits the existing event-taxonomy
   tests.

## 11. Test Gaps

- **Agent-submitted signals**: TD-P8-002 (P9). This slice's
  `signal_received` event is workflow-driven; Agent signal
  submission and `signals.allowed_from` validation belong to P9.
- **`retry.on_exceeded.status` field**: TD-P8-007 (P9). MVP
  defaults to `blocked`; honouring the workflow-declared
  on_exceeded status will be added when the retry contract is
  expanded.
- **`retry_inputs`**: TD-P8-008 (P9). Per mvp-contracts §2.3 and
  prd §FR-012, retry can carry `retry_inputs` (e.g.
  `review_comments`). The retry_with field on router actions and
  the input plumbing into the next attempt's context is deferred.
- **Activate idempotency**: documented in Architecture Decision
  6 but not tested in this slice. A follow-up TD-P8-006 will add
  T-SIGNALS-14 to assert double-activation is a no-op.
- **Concurrent transitions**: not in scope (MVP single-writable-job
  constraint). The handler assumes serial invocation.
- **Expression-driven action selection**: TD-P8-001 inherited
  from WF-P8-ROUTER. Workflow author inlines literal action
  values; no `${{ ... }}` evaluation at the signal layer either.
- **End-to-end CLI flow**: the full pipeline (`zigma-flow step
  --job <job>` → executor → applyRoutingAction → next step
  dispatch) is integration-level evidence that belongs in
  `tests/commands/step.test.ts` (or a new
  `tests/engine/pipeline.test.ts`). WF-P8-SIGNALS owns the
  `applyRoutingAction` contract surface plus two executor-level
  integration tests (T-SIGNALS-9, T-SIGNALS-13); the full
  CLI loop is left to a phase-level acceptance pass.

## 12. Granularity Check Summary

| Metric | Count | Limit | Status |
|---|---|---|---|
| "用户可完成…" user task milestones | 1 (M1 signal-driven workflow lifecycle, expanded into 8 sub-results) | 1 | within budget |
| Spec mandatory clause references | 13 in-scope + 2 TD registrations | 15 | within budget |
| Planned test files | 1 (`tests/engine/signals.test.ts`) | 1 | within budget |
| Use case enumeration | 12 (UC-SIGNALS-1..9 happy paths covering six action shapes + integration variants, UC-SIGNALS-10..12 negative paths) | – | bounded by 6 actions × source-state matrix |
| Planned test cases | 13 (T-SIGNALS-1..13) | – | one-to-one or many-to-one with UCs |
