---
workflow: WF-P8-ROUTER
phase: p8-router-and-signals
step: 1 (Cases and Tests)
date: 2026-06-10
authority: docs/mvp-contracts.md §2.1, docs/prd.md §20 (FR-009), docs/architecture.md §9.4, §7.1, §7.3
author: subagent (workflow Step 1)
---

# WF-P8-ROUTER — Cases and Tests

> **Authority alignment note.** The user-supplied task brief references
> "prd §20 (FR-008)" for the router clauses. In `docs/prd.md` itself
> the router section is **FR-009** (`### FR-009 Router Step 与受控流程
> 分支`, lines 681–736), while FR-008 is the Check Step / Gate section
> consumed by WF-P7-CHECK. This document treats the router-related
> clauses sourced from prd §FR-009 as the authoritative router source.
> Clause IDs below cite `prd §FR-009` accordingly; the substantive
> content is identical to what the task brief intended.

## 0. Slice Boundary

- **Slice name:** **P8-ROUTER**
- **Bounded contexts:**
  - **Router Executor / Engine command body** (architecture.md §7.1,
    §12.3, §13 phase 8). Owns the body of `executeRouterStep(opts)` in
    `src/router/executor.ts` and the `type: "router"` branch of
    `executeCurrentStep(opts)` in `src/engine/index.ts`.
  - **Event Sequencer** for router-step events (architecture.md §7.3,
    mvp-contracts.md §2.4) — sequences `step_started` →
    `router_decided` → `step_completed` (single-step router job
    completion / `job_completed` reuses the same convention as
    WF-P7-CHECK).
  - **Router type surface** in `src/router/index.ts` —
    `RouterDecision` type that wraps the chosen `RouterAction` plus
    the matched case key for audit.
  - **Error taxonomy extension** in `src/utils/errors.ts` —
    `RouterError` class (exit code 1) for invalid route definitions
    and no-matching-route conditions.

- **Bounded context interactions:**
  - **Consumes** the existing `RouterAction` union and the
    `switch` / `cases` schema fields on `StepBaseSchema` /
    `StepDefinition` (already defined in `src/workflow/index.ts`
    since P2; no schema change required by this slice).
  - **Consumes** `JsonlEventWriter`, `LocalStateStore`,
    `nextEventId` from `src/run/index.js` and `src/events/index.js`
    for events and state snapshots.
  - **Consumes** the existing `RouterDecidedPayload`
    `{ job_id, step_id, action, target? }` from
    `src/events/eventTypes.ts` (lines 121–126). No payload extension
    in this slice.
  - **Produces** the `ready → running → completed` transition
    for a single-step router job whose chosen action is `continue`
    (no remaining steps remain and the router is the terminal step
    in the job — the MVP slice scopes router execution to this
    surface; multi-step advancement is owned by WF-P8-MULTISTEP).
  - **MUST NOT** be called directly by the CLI — `stepAction` →
    `executeCurrentStep` is the only caller, identical to the
    WF-P7-CHECK contract.
  - **MUST NOT** evaluate any expression language: only literal
    field comparisons sourced from explicit `step.switch` and
    `step.cases` definitions are honoured. Expression evaluation
    (e.g. `${{ steps.review.outputs.decision }}`-style interpolation)
    is **TD-P8-001**.
  - **MUST NOT** apply the side effects of `retry_job`,
    `activate_job`, or `goto_job` actions — emission of the
    `router_decided` event is the only contractual output for these
    object-form actions in this slice; their **execution** is owned
    by WF-P8-SIGNALS. This slice surfaces the decision as a
    structured event so WF-P8-SIGNALS can consume it; the Engine
    leaves the job in `running` state for object-form actions and
    relies on the signals slice to apply the transition.
  - **MUST NOT** advance `current_step` to a sibling step within
    the same job — that is **TD-P6-004 / WF-P8-MULTISTEP**. This
    slice validates single-step router jobs end-to-end. The
    `continue` literal on a single-step router job is treated as the
    terminal "success" outcome (job → `completed`).
  - **MUST NOT** evaluate `outputs` from prior steps — only the
    explicit literal value supplied by `step.switch` (a literal
    string) is matched against `step.cases` keys. Reading prior step
    outputs as a router input is **TD-P8-001** (deferred to P9 with
    the expression language).
  - **MUST NOT** consume Agent Signal submissions — Agent signal
    routing is **TD-P8-002** (P9). This slice's `signal_received`
    event is **not** emitted by router; routing is purely
    workflow-defined.

## 1. Workflow Goal

Deliver the deterministic router execution pipeline so that a user who
has already created a run (WF-P3-RUN) and ran `zigma-flow step --job
<job>` (WF-P6-DISPATCH, extended in this phase to recognise
`type: "router"`) sees their workflow's router step execute as a pure
control-flow gate without invoking an LLM or running a script: the
router selects a matching case using literal-field comparison, decides
the corresponding `RouterAction`, persists the decision as a
`router_decided` event, and (for the `continue` literal on a
single-step job) advances the job from `ready → running → completed`
via the Engine. All state mutations occur inside the Engine — no CLI,
no Skill Pack, no router code writes `state.json` or `events.jsonl`
directly. The slice satisfies architecture §13 phase 8 verification
*"router step 分流"* and prd §FR-009 *"所有 router 决策必须写入 event
log"* by ensuring every invocation of `executeRouterStep` produces
exactly one `router_decided` event whose payload contains the chosen
action and target.

**Deliverables:**

1. `executeRouterStep(opts)` in `src/router/executor.ts` —
   orchestration function that reads the router step definition,
   resolves the literal switch value, selects the matching case (or
   `default`), emits `router_decided`, and (for `continue` on the
   terminal step) applies the success transition.
2. `RouterDecision` type in `src/router/index.ts` with the shape
   `{ caseKey: string; action: RouterAction }`. Re-exports the
   `RouterAction` union from `src/workflow/index.ts` so consumers
   have a single import surface.
3. `executeCurrentStep(opts)` body in `src/engine/index.ts` extended
   to dispatch `type: "router"` to `executeRouterStep`; non-script /
   non-check / non-router types continue to throw `WorkflowError`
   (TD-P8-X-001, inheriting TD-P7-001).
4. `RouterError` class in `src/utils/errors.ts` (exit code 1) plus
   index re-export; thrown for (a) missing `switch` or `cases`
   fields, (b) no matching case and no `default`, (c) cases value
   that is not a valid `RouterAction`.
5. `tests/router/executor.test.ts` — integration tests against real
   temp directories. **This workflow Step 1 writes only the
   cases-and-tests document and the failing test file; the
   executor source ships in Step 2.**

## 2. "用户可完成" Milestones

> Router steps are workflow-author-facing rather than end-user-facing.
> The "user" in these milestones is the workflow author / runner who
> defines a router step in YAML and exercises it through the CLI.

- **M1 — `continue` action on a single-step router job**: 用户可完
  成 `zigma-flow step --job <job>` 后，对一个 `type: router` 且
  `switch: "approved"`, `cases: { approved: continue }` 的 step，
  得到：
  - `events.jsonl` 末尾按顺序包含 `step_started` → `router_decided`
    (`payload.action === "continue"`) → `step_completed` →
    `job_completed`；
  - `state.json` 中该 job 的 `status` 从 `ready` 变为 `completed`；
  - `state.json.last_event_id` 等于 events.jsonl 尾部 event id；
  - `state.json` 只在事件序列结束后被写入一次（与 P6/P7 单写快照
    模式一致）。

- **M2 — `fail` action on a single-step router job**: 用户可完成
  `zigma-flow step --job <job>` 后，对一个 `cases: { rejected:
  fail }` 且 `switch: "rejected"` 的 step，得到：
  - `events.jsonl` 末尾按顺序包含 `step_started` → `router_decided`
    (`payload.action === "fail"`) → `step_failed`；
  - `state.json` 中该 job 的 `status` 从 `ready` 变为 `failed`；
  - 没有 `step_completed`，没有 `job_completed`；
  - `state.json.last_event_id` 等于 events.jsonl 尾部 event id。

- **M3 — `block` action on a single-step router job**: 同 M2，但
  目标 status 为 `blocked`：
  - `router_decided.payload.action === "block"`；
  - `step_failed.reason` 包含 `"router decided: block"`；
  - `state.jobs[jobId].status === "blocked"`。

- **M4 — Object-form action emits decision event without applying
  transition**: 用户对一个 `cases: { rejected: { retry_job:
  implement } }` 的 router step，得到：
  - `events.jsonl` 包含 `step_started` → `router_decided`
    (`payload.action === "retry_job"`, `payload.target ===
    "implement"`)；
  - **没有** `step_completed` 或 `step_failed` 事件；
  - `state.json` 仅记录 `last_event_id` 推进到 `router_decided` 这
    条事件，且 job 状态保持为 `running`（等待 WF-P8-SIGNALS 应用
    转换）；
  - 此 milestone 文档化"路由决策已落盘，等待 signals slice 接力"
    的契约，便于跨工作流验证。

- **M5 — Invalid router definition fails before any events are
  appended**: 用户提交一个 `type: router` 但缺少 `switch` 或
  `cases` 的 step，或者 switch 值与所有 case 键 + `default` 都不
  匹配，得到：
  - `executeRouterStep` 立即抛出 `RouterError`；
  - **任何事件被追加之前** 即失败；
  - `state.json` 不被修改，`events.jsonl` 不增长；
  - 错误对象的 `kind === "RouterError"`、`exitCode === 1`。

## 3. Spec Compliance Matrix

下表覆盖 prd.md FR-009、architecture.md §6 / §7 / §9.4 / §12.3、
mvp-contracts.md §2.1 / §2.4 中与 WF-P8-ROUTER 相关的 MUST / SHALL
/ 强制性条款，以及 P8 开发计划中明确写入的 boundary 约束。

| Clause ID | Clause Source | Clause Text (Summary) | Status |
| --- | --- | --- | --- |
| RC-R01 | mvp-contracts §2.1 | Step type 必须支持 `router`. | 已纳入本工作流 — `executeCurrentStep` dispatch (FP-RTR-DISPATCH); 由 T-ROUTER-1 / T-ROUTER-2 / T-ROUTER-3 间接验证（任何 router step 都走 dispatch）. |
| RC-R02 | mvp-contracts §2.1 | Router action MUST 只允许 `continue` / `fail` / `block` / `retry_job` / `activate_job` / `goto_job`. | 已纳入本工作流 — FP-RTR-ACTION-UNION；T-ROUTER-1..6 覆盖六种 action。`RouterActionSchema` 自 P2 起已强制；本 slice 仅消费. |
| RC-R03 | mvp-contracts §2.1 (验收证据) | 非法 router action 必须有失败用例. | 已纳入本工作流 — FP-RTR-INVALID-ROUTE；T-ROUTER-7 (no matching case + no default → `RouterError`). |
| RC-R04 | mvp-contracts §2.4 | Event 至少包含 `id` / `run_id` / `type` / `timestamp` / `producer` / `job` / `step` / `attempt` / `payload`. | 已纳入本工作流 — FP-RTR-EVENT-STARTED, FP-RTR-EVENT-DECIDED；T-ROUTER-1 (envelope shape 断言). |
| RC-R05 | mvp-contracts §2.4 | 关键事件类型集合包含 `step_started` / `step_completed` / `step_failed` / `router_decided` / `job_completed`. | 已纳入本工作流 — FP-RTR-EVENT-*；T-ROUTER-1 / T-ROUTER-2 / T-ROUTER-3 / T-ROUTER-6. |
| RC-R06 | mvp-contracts §2.4 (`router_decided`) | `router_decided` 是 MVP 关键事件类型，每次 router 决策都必须发出. | 已纳入本工作流 — FP-RTR-EVENT-DECIDED；T-ROUTER-1..6 都断言 `router_decided` 出现且 payload 形态正确. |
| RC-R07 | prd §FR-009 | Router Step 不调用 Agent. | 已纳入本工作流 — FP-RTR-NO-AGENT；T-ROUTER-1 (executor 不引入任何 Agent / LLM 适配器；runner 接口面没有 prompt / model 参数). 静态保证 + test design summary. |
| RC-R08 | prd §FR-009 | Router Step 不允许任意表达式副作用. | 已纳入本工作流 — FP-RTR-LITERAL-SWITCH；T-ROUTER-1 / T-ROUTER-2 (`step.switch` 必须是字面量字符串; 任何 `${{ ... }}` 模板不在本 slice 解析). 复杂表达式 → TD-P8-001. |
| RC-R09 | prd §FR-009 | Router Step 只能执行预定义控制流动作. | 已纳入本工作流 — FP-RTR-ACTION-UNION；通过消费 P2 已经冻结的 `RouterActionSchema` 强制；T-ROUTER-7b 验证未注册字面量 → `RouterError`. |
| RC-R10 | prd §FR-009 | 所有 router 决策必须写入 event log. | 已纳入本工作流 — FP-RTR-EVENT-DECIDED, FP-RTR-NO-DECISION-SILENCE；T-ROUTER-1..6 (每个 happy-path UC 断言 `router_decided` 至少一次). |
| RC-R11 | architecture §7.1 | Engine 对外暴露 `executeCurrentStep(runId, jobId)`；CLI 命令只调用这些入口, 不直接改 run state. | 已纳入本工作流 — FP-RTR-DISPATCH (`executeCurrentStep` 内 `type: router` → `executeRouterStep`). T-ROUTER-1 通过 high-level pipeline 验证. |
| RC-R12 | architecture §7.2 | Job status 合法转换 `ready → running → completed`；`ready → running → failed`；`ready → running → blocked`. | 已纳入本工作流 — FP-RTR-TRANSITION-CONTINUE / -FAIL / -BLOCK；T-ROUTER-1 / T-ROUTER-2 / T-ROUTER-3. |
| RC-R13 | architecture §7.3 | 写入流程: 计算 transition, 追加 event, 写 `state.json.tmp`, 原子替换 `state.json`. `state.last_event_id` 必须与 event log 尾部一致. | 已纳入本工作流 — FP-RTR-STATE-WRITE；T-ROUTER-1 (snapshot 在 events 之后写; tail = last_event_id). |
| RC-R14 | architecture §9.4 等价类比 | Router 决策结果由 Engine 处理 transition；CLI / runner 不得直接推进 job status. | 已纳入本工作流 — FP-RTR-DISPATCH + FP-RTR-TRANSITION-*；T-ROUTER-1..6. 与架构 §18 fitness rule (`script` 和 `check` 不得直接推进 job status) 同构延伸到 router. |
| RC-R15 | architecture §12.3 / §13 phase 8 | Router step 分流 — phase 8 verification target. | 已纳入本工作流 — FP-RTR-ACTION-UNION + FP-RTR-EVENT-DECIDED；T-ROUTER-1..6 覆盖 6 种 action 的事件 payload. |

**Spec clause count:** 15 in-scope clauses (matches the granularity
budget); 3 technical-debt registrations below.

| TD ID | Spec Reference | Description | Deferred To |
| --- | --- | --- | --- |
| TD-P8-001 | mvp-contracts §2.1, prd §FR-009 | Router 表达式语言与复杂条件求值（`${{ steps.X.outputs.Y }}` 模板、字段比较、`>=` / `==` / `!=` 等运算）. 本 slice 仅支持字面量 switch (`switch: "approved"`) 与字面量 case 键. | P9 (继承 P8 开发计划 §7 已登记的 TD-P8-001) |
| TD-P8-005 | architecture §7.2, P8 dev plan §4 WF-P8-SIGNALS | 对象形态 action (`retry_job` / `activate_job` / `goto_job`) 的 **状态转换执行** — 本 slice 只发出 `router_decided` 事件, transition 由 WF-P8-SIGNALS 落地. T-ROUTER-4 / T-ROUTER-5 / T-ROUTER-6 仅断言事件 payload 正确, 不断言 job retry/activated/skipped 转换. | P8 / WF-P8-SIGNALS |
| TD-P6-004 | architecture §7.2 | 多 step job 在 step 完成后 MUST 推进 `current_step` 指针到下一个 step. 本 slice 只验证单 step router job 的 `job_completed` 触发条件. | P8 / WF-P8-MULTISTEP (沿用 TD-P6-004) |

## 4. Functional Points

| FP id | Area | Source | Summary |
| --- | --- | --- | --- |
| FP-RTR-RESOLVE-SWITCH | Switch value resolution | prd §FR-009, P8 plan §4 D1 | `executeRouterStep` reads `stepDef.switch`. MUST be a literal string (no `${{ ... }}` interpolation in this slice). Missing or non-string → throw `RouterError` BEFORE any event is appended. |
| FP-RTR-CASE-MATCH | Case selection | prd §FR-009 (cases example) | Look up `stepDef.cases[switchValue]`. If absent, fall back to `stepDef.cases["default"]` (per FR-009 example syntax). If neither exists → throw `RouterError` BEFORE any event is appended. |
| FP-RTR-ACTION-UNION | RouterAction validation | mvp-contracts §2.1 | The selected action MUST be one of the six `RouterAction` shapes (`continue` / `fail` / `block` / `{retry_job}` / `{activate_job}` / `{goto_job}`). Validation reuses the existing `RouterActionSchema` (no new validator). Invalid → `RouterError`. |
| FP-RTR-LITERAL-SWITCH | No expression evaluation | prd §FR-009, P8 plan §3 (out of scope) | `executeRouterStep` MUST NOT evaluate any template / expression syntax (no `${{ ... }}`, no field access against `state.jobs[...].outputs`). A `switch` value that contains a literal `${{` or `}}` substring is still matched as a literal string; this slice does not detect/strip template syntax. |
| FP-RTR-NO-AGENT | LLM-free executor | prd §FR-009, mvp-contracts §2.1 | `executeRouterStep` MUST NOT import any Agent / LLM / prompt module; no Skill Pack `uses` resolution; no prompt rendering. Pure control flow. |
| FP-RTR-EVENT-STARTED | `step_started` emission | arch §12.3, mvp-contracts §2.4 | Append `step_started` with `{ job_id, step_id, attempt }` BEFORE selecting the action (after resolve/validation so that invalid definitions fail without emitting). |
| FP-RTR-EVENT-DECIDED | `router_decided` emission | mvp-contracts §2.4, prd §FR-009 | After case selection, append `router_decided` with `payload = { job_id, step_id, action, target? }`. `action` is the string discriminator (`"continue"` / `"fail"` / `"block"` / `"retry_job"` / `"activate_job"` / `"goto_job"`). `target` is included for `retry_job` / `activate_job` / `goto_job` and equals the referenced job id; omitted for the three literal forms. |
| FP-RTR-NO-DECISION-SILENCE | Mandatory event | prd §FR-009 | Every successful invocation of `executeRouterStep` (i.e. every code path that does NOT throw `RouterError`) MUST emit exactly one `router_decided` event. |
| FP-RTR-TRANSITION-CONTINUE | `continue` transition | arch §7.2 | If selected action is `"continue"` and the router step is the last step in its job (`stepDef === jobDef.steps[jobDef.steps.length - 1]`): append `step_completed`, then `job_completed`, set `state.jobs[jobId].status = "completed"`. If not the last step → throw `WorkflowError` (TD-P6-004; multi-step advancement deferred). |
| FP-RTR-TRANSITION-FAIL | `fail` transition | arch §7.2 | If selected action is `"fail"`: append `step_failed` with `reason = "router decided: fail"` (plus matched case key for diagnostics), set `state.jobs[jobId].status = "failed"`. |
| FP-RTR-TRANSITION-BLOCK | `block` transition | arch §7.2 | If selected action is `"block"`: append `step_failed` with `reason = "router decided: block"`, set `state.jobs[jobId].status = "blocked"`. |
| FP-RTR-TRANSITION-DEFER | Object-form decision | P8 plan §4 WF-P8-SIGNALS boundary | If selected action is an object form (`retry_job` / `activate_job` / `goto_job`): emit `router_decided` only; DO NOT emit `step_completed` / `step_failed` / `job_*`; DO NOT mutate `state.jobs[jobId].status` (job remains `running`). The state snapshot is still rewritten so `last_event_id` advances. TD-P8-005 documents that WF-P8-SIGNALS picks up the decision from the event log and applies the transition. |
| FP-RTR-STATE-WRITE | Atomic state snapshot | arch §7.3, mvp-contracts §2.3 | `state.json` is written following the WF-P7-CHECK single-writer pattern: one running-snapshot after `step_started`, one terminal-snapshot after the last event of the sequence. `state.last_event_id` equals the tail event id. |
| FP-RTR-EVENT-SEQUENCE | Event ordering | arch §12.3, mvp-contracts §2.4 | Append order: `step_started` → `router_decided` → (`step_completed` + `job_completed`  \| `step_failed` \| ∅ for object forms). |
| FP-RTR-DISPATCH | Engine integration | arch §7.1 | `executeCurrentStep(opts)` dispatches `type: "router"` to `executeRouterStep(opts)`. Other types continue to throw `WorkflowError` (TD inherited from P7). |
| FP-RTR-INVALID-ROUTE | RouterError taxonomy | mvp-contracts §2.1, §7 | `RouterError` (exit code 1) is thrown for: (a) missing/non-string `switch`; (b) missing `cases`; (c) no matching case AND no `default`; (d) cases value that fails `RouterActionSchema`. Thrown BEFORE any `step_started` is appended so the event log is preserved when the route definition is invalid. |

## 5. Use Case Enumeration

| UC id | Actor | Trigger | Pre-conditions | Steps (happy path / failure) | Post-conditions / observable result |
| --- | --- | --- | --- | --- | --- |
| UC-ROUTER-1 | Engine | `executeRouterStep` called on a `ready` single-step router job; `switch: "approved"` matches `cases: { approved: continue }`. | Run dir exists with valid `state.json` + `events.jsonl`; workflow defines one router step with literal switch and continue case. | Resolve switch → "approved"; match case "approved" → action `continue`; append `step_started`; append `router_decided` (`payload.action = "continue"`); append `step_completed`; append `job_completed`; write state snapshot with `jobs[jobId].status === "completed"`. | events.jsonl tail = `job_completed`; state.last_event_id matches tail; `state.jobs[jobId].status === "completed"`; no `step_failed` event. |
| UC-ROUTER-2 | Engine | Same as UC-ROUTER-1 but `cases: { rejected: fail }` and `switch: "rejected"`. | Same. | Append `step_started`; append `router_decided` (`payload.action = "fail"`); append `step_failed` (`reason` contains `"router decided: fail"`); write state snapshot with `jobs[jobId].status === "failed"`. NO `step_completed` / `job_completed`. | events.jsonl tail = `step_failed`; state.last_event_id matches tail; `state.jobs[jobId].status === "failed"`. |
| UC-ROUTER-3 | Engine | Same as UC-ROUTER-1 but `cases: { blocked_path: block }` and `switch: "blocked_path"`. | Same. | Append `step_started`; append `router_decided` (`payload.action = "block"`); append `step_failed` (`reason` contains `"router decided: block"`); write state snapshot with `jobs[jobId].status === "blocked"`. | events.jsonl tail = `step_failed`; state.last_event_id matches tail; `state.jobs[jobId].status === "blocked"`. |
| UC-ROUTER-4 | Engine | `executeRouterStep` invoked with `cases: { rejected: { retry_job: implement } }` and `switch: "rejected"`. | workflow declares object-form `retry_job` action. | Append `step_started`; append `router_decided` (`payload.action = "retry_job"`, `payload.target = "implement"`); DO NOT append any terminal event; write state snapshot with `last_event_id = router_decided.id` and `state.jobs[jobId].status === "running"` (TD-P8-005 — WF-P8-SIGNALS will pick up). | events.jsonl tail = `router_decided`; `state.jobs[jobId].status === "running"`; payload carries `action: "retry_job"`, `target: "implement"`. |
| UC-ROUTER-5 | Engine | Same as UC-ROUTER-4 but `cases: { needs_architecture_design: { activate_job: architecture-design } }` and `switch: "needs_architecture_design"`. | Same. | Same sequence; `router_decided.payload.action === "activate_job"`, `target === "architecture-design"`. | Same; payload carries activate_job + target. |
| UC-ROUTER-6 | Engine | Same as UC-ROUTER-4 but `cases: { stop: { goto_job: cleanup } }` and `switch: "stop"`. | Same. | Same sequence; `router_decided.payload.action === "goto_job"`, `target === "cleanup"`. | Same; payload carries goto_job + target. |
| UC-ROUTER-7 | Engine (negative) | `executeRouterStep` invoked with a `switch` value not present in `cases` and no `default` case defined. | router step with `switch: "unmatched"`, `cases: { foo: continue }` (no `default`). | Resolution fails before any event is appended → throw `RouterError` with `kind === "RouterError"`, `exitCode === 1`. | events.jsonl unchanged; state.json unchanged; no `router_decided` event. |
| UC-ROUTER-8 | Engine (negative, optional) | `executeRouterStep` invoked with a router step missing `switch` and/or `cases` entirely. | Step definition: `{ id, type: "router" }` only. | Throw `RouterError` BEFORE any event is appended; error message references the missing field. | events.jsonl unchanged; state.json unchanged. |

UC-ROUTER-6 covers the `goto_job` symmetric case; UC-ROUTER-8 is
the catch-all malformed-route case (separate from UC-ROUTER-7 which
covers the "no matching route" case). Tests below collapse these into
two distinct test IDs: T-ROUTER-7 (no matching route) and T-ROUTER-7b
(missing switch).

## 6. Test Plan

All tests live in **`tests/router/executor.test.ts`** under top-level
`describe("executeRouterStep", ...)` blocks (one per Test ID). Vitest.
Real temp directories under `os.tmpdir()`. No filesystem mocking. The
test file uses the same sandbox / `createRun` bootstrap pattern as
`tests/check/executor.test.ts`.

| Test id | `it` description | What it verifies | UCs covered | FPs covered | RCs touched |
| --- | --- | --- | --- | --- | --- |
| T-ROUTER-1 | `continue action — emits step_started → router_decided(action:"continue") → step_completed → job_completed and transitions job to completed` | Single-step router job; switch matches a continue case. Assert: (a) events.jsonl contains the four events in order; (b) `router_decided.payload.action === "continue"`; (c) `router_decided.payload` has no `target`; (d) `state.jobs[jobId].status === "completed"`; (e) `state.last_event_id` equals events tail id. | UC-ROUTER-1 | FP-RTR-RESOLVE-SWITCH, FP-RTR-CASE-MATCH, FP-RTR-ACTION-UNION, FP-RTR-EVENT-STARTED, FP-RTR-EVENT-DECIDED, FP-RTR-TRANSITION-CONTINUE, FP-RTR-EVENT-SEQUENCE, FP-RTR-STATE-WRITE, FP-RTR-DISPATCH | RC-R01, RC-R02, RC-R04, RC-R05, RC-R06, RC-R07, RC-R10, RC-R11, RC-R12, RC-R13, RC-R14, RC-R15 |
| T-ROUTER-2 | `fail action — emits step_failed and transitions job to failed; router_decided payload carries action "fail"` | Router selects literal `fail` action. Assert: events contain `step_started`, `router_decided` (`action === "fail"`), `step_failed`; NO `step_completed` / `job_completed`; `state.jobs[jobId].status === "failed"`. | UC-ROUTER-2 | FP-RTR-EVENT-DECIDED, FP-RTR-TRANSITION-FAIL, FP-RTR-EVENT-SEQUENCE | RC-R02, RC-R05, RC-R06, RC-R10, RC-R12, RC-R15 |
| T-ROUTER-3 | `block action — emits step_failed and transitions job to blocked` | Router selects literal `block` action. Assert: events contain `step_started`, `router_decided` (`action === "block"`), `step_failed`; `state.jobs[jobId].status === "blocked"`. | UC-ROUTER-3 | FP-RTR-EVENT-DECIDED, FP-RTR-TRANSITION-BLOCK, FP-RTR-EVENT-SEQUENCE | RC-R02, RC-R05, RC-R06, RC-R10, RC-R12, RC-R15 |
| T-ROUTER-4 | `retry_job action — emits router_decided with target and leaves job status running (TD-P8-005)` | Router selects `{ retry_job: "implement" }`. Assert: events contain `step_started` and `router_decided` (`action === "retry_job"`, `target === "implement"`); NO `step_completed` / `step_failed` / `job_completed`; `state.jobs[jobId].status === "running"`; `state.last_event_id === router_decided.id`. | UC-ROUTER-4 | FP-RTR-EVENT-DECIDED, FP-RTR-TRANSITION-DEFER | RC-R02, RC-R05, RC-R06, RC-R10, RC-R15 |
| T-ROUTER-5 | `activate_job action — emits router_decided with target and leaves job status running (TD-P8-005)` | Router selects `{ activate_job: "architecture-design" }`. Same assertions as T-ROUTER-4 with `action === "activate_job"`, `target === "architecture-design"`. | UC-ROUTER-5 | FP-RTR-EVENT-DECIDED, FP-RTR-TRANSITION-DEFER | RC-R02, RC-R05, RC-R06, RC-R10, RC-R15 |
| T-ROUTER-6 | `goto_job action — emits router_decided with target and leaves job status running (TD-P8-005)` | Router selects `{ goto_job: "cleanup" }`. Same assertions as T-ROUTER-4 with `action === "goto_job"`, `target === "cleanup"`. | UC-ROUTER-6 | FP-RTR-EVENT-DECIDED, FP-RTR-TRANSITION-DEFER | RC-R02, RC-R05, RC-R06, RC-R10, RC-R15 |
| T-ROUTER-7 | `no matching case and no default → RouterError BEFORE any events are appended` | switch value does not appear in `cases`; no `default` key. Assert: an error is thrown; `error.kind === "RouterError"`; `error.exitCode === 1`; `events.jsonl` does NOT contain a `step_started` referring to the failing step (events count unchanged from pre-execution); `state.json` is unchanged from the pre-execution snapshot. | UC-ROUTER-7 | FP-RTR-CASE-MATCH, FP-RTR-INVALID-ROUTE | RC-R03, RC-R09 |
| T-ROUTER-7b | `missing switch field → RouterError BEFORE any events are appended` | Router step definition lacks `switch` entirely. Assert: same shape as T-ROUTER-7 (no events appended, state unchanged, `RouterError` thrown). | UC-ROUTER-8 | FP-RTR-RESOLVE-SWITCH, FP-RTR-INVALID-ROUTE | RC-R03, RC-R09 |

**Planned test file count:** 1 (`tests/router/executor.test.ts`).
Within budget per granularity check.

## 7. Test Design Summary

- **Test framework:** vitest (`describe` / `it` / `expect` /
  `beforeEach` / `afterEach`). Mirrors the structure of
  `tests/check/executor.test.ts` (P7) and `tests/script/executor.test.ts`
  (P6).
- **Imports under test:**
  - `executeRouterStep` from `../../src/router/executor.js` (does
    not exist yet — red phase).
  - `createRun` from `../../src/engine/index.js` for sandbox setup.
  - `Clock` from `../../src/run/index.js`.
  - `RouterError` from `../../src/utils/index.js` (added in Step 2).
- **Filesystem:** real temp directories under `os.tmpdir()` with
  `node:crypto.randomUUID()` suffixes; no fs mocking. Each test
  creates its own `<sandbox>/.zigma-flow/` skeleton (`config.json`,
  `skill-lock.json`, `runs/`). Same `makeSandbox()` helper as
  `tests/check/executor.test.ts`.
- **Clock:** inline `FakeClock { now(): "2026-06-10T00:00:00.000Z" }`.
- **No runner injection:** unlike the P6 / P7 executors, the router
  executor has **no external port** to inject (router is pure
  control flow over `step.switch` and `step.cases`). All test
  variability is driven by workflow YAML fixtures.
- **Workflow YAML fixtures:** seven minimal single-step `type:
  router` workflows, one per Test ID, varying only the `switch`
  literal and the `cases` map. Job id `review` (per FR-009
  example). Step id `route-decision`. Each fixture is declared
  inline in the test file as a tagged template string for
  readability.
- **Pre/post evidence:** every test reads events.jsonl line-by-line
  and parses each line as JSON; failure-path tests (T-ROUTER-7,
  T-ROUTER-7b) capture the events.jsonl size and the state.json
  contents before invoking the executor and re-read them after to
  confirm zero mutation.

## 8. Architecture Decisions

1. **Router executor has no injectable port.** Unlike `CheckRunner`
   (P7) and `ProcessRunner` (P6), `executeRouterStep` consumes only
   workflow definition fields (`step.switch`, `step.cases`) plus the
   shared `JsonlEventWriter` / `LocalStateStore`. There is no
   external system to mock; the executor is purely a deterministic
   string-match-and-emit pipeline. Adding a "RouterEvaluator" port
   for testability would be pure indirection.

2. **Literal switch only — no expression evaluation in this slice.**
   The MVP router operates on a literal `switch` string and literal
   `cases` keys. Workflow authors who need to route on prior step
   outputs MUST defer to TD-P8-001 (P9). The P8 dev plan §4 explicitly
   says *"MVP router only supports literal field comparisons (e.g.,
   `outputs.status == "approved"` as explicit step definition
   fields)"* — interpreted here as: the step author writes the
   resolved literal directly into `switch`. The `${{ ... }}`
   template syntax is preserved through validation (the schema
   already allows arbitrary strings in `switch`) but not interpreted
   in this slice.

3. **Object-form actions emit decision events only.** `retry_job`,
   `activate_job`, and `goto_job` decisions are persisted via
   `router_decided` but the executor does NOT apply the resulting
   state transition. WF-P8-SIGNALS owns the consumption side of
   that contract. This decision keeps WF-P8-ROUTER focused on the
   prd §FR-009 mandate *"所有 router 决策必须写入 event log"* and
   leaves retry/activate/goto semantics to a dedicated slice.

4. **`router_decided.payload` shape reuses the existing
   `RouterDecidedPayload` type** (`{ job_id, step_id, action,
   target? }`) already exported from `src/events/eventTypes.ts`
   since the P4 event taxonomy. The `action` field is the
   discriminator string (`"continue"` / `"fail"` / `"block"` /
   `"retry_job"` / `"activate_job"` / `"goto_job"`). The `target`
   field is included only for the three object-form actions and
   equals the referenced job id. Literal actions omit `target`.

5. **Invalid route definitions fail BEFORE `step_started`.** Per
   the WF-P7-CHECK precedent (unknown check kinds throw `CheckError`
   before any event), an invalid router definition (missing
   `switch`, missing `cases`, no match + no default, invalid action
   schema) throws `RouterError` before any event is appended. This
   preserves the invariant that every `step_started` event is paired
   with a terminal `step_completed` / `step_failed` / `router_decided`
   (or in the object-form case, with `router_decided` alone)
   downstream event.

6. **Reuse the WF-P7-CHECK single-write snapshot pattern.** The
   executor writes the intermediate snapshot once (after
   `step_started`, so the job's `status` is `running` and
   `last_event_id` references `step_started`) and the terminal
   snapshot once (after the last event of the sequence). For
   object-form actions, the terminal snapshot is written after
   `router_decided` and leaves `status === "running"`.

7. **Single-step router jobs only in this slice.** A router step
   that is NOT the last step in its job triggers `WorkflowError`
   referencing TD-P6-004 / WF-P8-MULTISTEP. The cases-and-tests
   matrix covers single-step jobs only; multi-step router scenarios
   land when WF-P8-MULTISTEP exposes `advanceJob`.

8. **`step_failed.payload.reason` for `fail` / `block` literal
   actions** MUST contain the substring `"router decided: <action>"`
   (e.g. `"router decided: fail"`, `"router decided: block"`). The
   matched case key SHOULD be appended for diagnostic detail
   (`"router decided: fail (case: rejected)"`). This mirrors the
   WF-P7-CHECK convention `"check failed: <failure>"`.

## 9. Red-Phase Expectations

- `src/router/executor.ts` does not exist; tests fail at module
  resolution. After WF-P8-ROUTER Step 2 ships the file, all
  T-ROUTER-N tests should turn green.
- `src/router/index.ts` does not exist (the workflow loader already
  defines `RouterAction` locally in `src/workflow/index.ts`; Step 2
  introduces a separate router module to host `RouterDecision`).
- `RouterError` does not yet exist in `src/utils/errors.ts`; the
  test file imports it from `../../src/utils/index.js`, so the
  import fails until Step 2 adds the class and the re-export.
- `executeCurrentStep` in `src/engine/index.ts` does not yet route
  `type: "router"` to `executeRouterStep`; `tests/router/executor.test.ts`
  imports `executeRouterStep` directly, so the dispatch wiring is
  independent of the red-phase test surface.
- `RouterDecidedPayload` is already declared in
  `src/events/eventTypes.ts` (P4) — no event-type change in Step 2.

## 10. Step 2 Handoff Notes

1. `src/router/executor.ts` MUST export `executeRouterStep` with a
   signature structurally compatible with:

   ```ts
   export interface ExecuteRouterStepOpts {
     runDir: string;
     zigmaflowDir: string;
     runId: string;
     jobId: string;
     clock: Clock;
   }

   export function executeRouterStep(opts: ExecuteRouterStepOpts): Promise<void>;
   ```

   (No `runner` field — see Architecture Decision §8.1.)

2. The orchestration order MUST be:
   - Read `state.json`; locate `jobState.current_step` (default to
     first step in job).
   - Load workflow; locate the step definition; assert `type ===
     "router"` (else `WorkflowError`).
   - Validate `step.switch` is a string; validate `step.cases` is a
     `Record<string, RouterAction>`. Failure → `RouterError` BEFORE
     any event is appended.
   - Resolve case: look up `cases[switch]`; fall back to
     `cases["default"]` if absent. Both missing → `RouterError`.
   - Append `step_started` event.
   - Write intermediate running snapshot.
   - Append `router_decided` event.
   - Apply terminal transition:
     - `continue` → `step_completed` + `job_completed`; `status →
       completed` (only when the router is the last step in the
       job; otherwise `WorkflowError` TD-P6-004).
     - `fail` → `step_failed` with reason `"router decided: fail
       (case: <key>)"`; `status → failed`.
     - `block` → `step_failed` with reason `"router decided: block
       (case: <key>)"`; `status → blocked`.
     - `{ retry_job | activate_job | goto_job }` → no terminal
       event; `status` remains `running`.
   - Write terminal state snapshot once.

3. `RouterError` (exit code 1) added to `src/utils/errors.ts`; index
   re-export added.

4. `executeCurrentStep` in `src/engine/index.ts` MUST dispatch
   `type: "router"` to `executeRouterStep`. Other types continue to
   throw `WorkflowError`.

5. `router_decided.payload` MUST conform to the existing
   `RouterDecidedPayload` interface in `src/events/eventTypes.ts`.
   No type changes in this slice.

6. `RouterDecision` type added to `src/router/index.ts` for downstream
   consumers (WF-P8-SIGNALS will read events back and reconstruct
   the decision):

   ```ts
   import type { RouterAction } from "../workflow/index.js";

   export interface RouterDecision {
     caseKey: string;
     action: RouterAction;
   }
   export type { RouterAction };
   ```

## 11. Test Gaps

- **Multi-step router scenarios**: TD-P6-004 (WF-P8-MULTISTEP). The
  current slice rejects router steps that are not the last step in
  their job.
- **Object-form action transition execution**: TD-P8-005
  (WF-P8-SIGNALS). T-ROUTER-4 / T-ROUTER-5 / T-ROUTER-6 only assert
  the `router_decided` event payload; the resulting `job_retrying`
  / `job_activated` / `job_skipped` events and state transitions
  are owned by WF-P8-SIGNALS.
- **Expression-driven switch values**: TD-P8-001. `switch: "${{ ... }}"`
  is not evaluated in this slice; it is treated as a literal string
  for case matching (which will almost always fail — workflow
  authors must inline the resolved literal).
- **Agent Signal routing**: TD-P8-002. Agent-submitted signals do
  not flow through the router in this slice; `signal_received`
  events are not emitted by the router executor.
- **Engine dispatch for non-script/non-check/non-router types**:
  covered indirectly by WF-P6-DISPATCH T-DISPATCH-3 (extended in
  Step 2 to recognise router as well).

## 12. Granularity Check Summary

| Metric | Count | Limit | Status |
|---|---|---|---|
| "用户可完成…" user task milestones | 5 (M1 continue, M2 fail, M3 block, M4 object-form defer, M5 invalid → RouterError) | 5 | within budget |
| Spec mandatory clause references | 15 in-scope + 3 TD registrations | 15 | within budget |
| Planned test files | 1 (`tests/router/executor.test.ts`) | 1 | within budget |
| Use case enumeration | 8 (UC-ROUTER-1..6 happy paths covering six actions, UC-ROUTER-7 + UC-ROUTER-8 invalid routes) | – | bounded by 6 action × 2 paths |
| Planned test cases | 8 (T-ROUTER-1..6, T-ROUTER-7, T-ROUTER-7b) | – | one-to-one with UCs |
