---
workflow: WF-P9-ACCEPT
phase: p9-agent-report-retry
step: 1 (Cases and Tests)
date: 2026-06-11
authority: docs/mvp-contracts.md §2.3, §2.4, §2.6; docs/architecture.md §7.1, §7.2; docs/prd.md §FR-010, §20
author: subagent (workflow Step 1)
tech-debt-resolved: TD-P8-002
---

# WF-P9-ACCEPT — Cases and Tests

> **Slice name.** Agent Report acceptance. The signal vocabulary in
> this workflow refers to the **Agent-submitted signal** (mvp-contracts
> §2.6, prd §FR-010), NOT the routing-decision signal owned by
> WF-P8-SIGNALS. The two reuse the same `signal_received` event
> envelope but the payload semantics differ:
>
> - **WF-P8-SIGNALS** (workflow-driven): `signal` slot holds the
>   `RouterAction` discriminator (e.g. `"retry_job"`); producer:
>   `engine`.
> - **WF-P9-ACCEPT** (agent-driven): `signal` slot holds the workflow
>   `signals.<name>` key declared in the workflow YAML (e.g.
>   `"needs_architecture_design"`); producer: `engine` (the Engine
>   appends the event after validating the report; Agent never
>   writes events directly).

## 0. Slice Boundary

- **Slice name:** **P9-ACCEPT**
- **Bounded contexts:**
  - **Agent Report Acceptance** (mvp-contracts §2.6, prd §FR-010,
    §20) — owns the new `acceptAgentReport(opts)` Engine entry in
    `src/engine/accept.ts`. Reads `report.json` from the canonical
    artifact location, validates schema, stores `outputs` to
    `JobState.outputs`, validates signals against the workflow's
    top-level `signals.<name>.allowed_from`, dispatches the
    highest-priority signal through `applyRoutingAction`, and on
    "no-signal" paths emits `agent_report_accepted` + delegates to
    `advanceJob`.
  - **`next` CLI command** (prd §20, P5 dev plan `step`/`next`
    parity) — `src/commands/next.ts` reads the active run pointer
    from `.zigma-flow/config.json` and invokes `acceptAgentReport`
    for the requested job id.
  - **Workflow signal declaration schema** (prd §FR-010,
    mvp-contracts §2.1 `signals`) — Step 2 refines
    `WorkflowDefinition.signals` from `Record<string, unknown>` to
    a structured `Record<string, SignalDeclaration>` with
    `allowed_from: string[]` and `action: RouterAction` (plus the
    optional `severity`/`priority` metadata from FR-010).
  - **`JobState.outputs`** (mvp-contracts §2.3 `job 的 outputs`)
    — Step 2 extends the `JobState` interface in
    `src/run/index.ts` with `outputs?: Record<string, unknown>` so
    accepted reports persist their `outputs` field for downstream
    `${{ jobs.<id>.outputs.<key> }}` reads (deferred to TD-P9-001).

- **Bounded context interactions:**
  - **Consumes** `WorkflowDefinition` from
    `src/workflow/index.ts`. Step 2 must extend the existing
    `WorkflowSchema.signals` to validate the per-signal
    `allowed_from`/`action` structure.
  - **Consumes** the `RouterAction` union from
    `src/workflow/index.ts` to dispatch a validated signal's
    declared action via `applyRoutingAction`.
  - **Consumes** `applyRoutingAction` (WF-P8-SIGNALS) for the
    signal-dispatch path. NO new signal-handling state machine —
    Agent signals merely pre-empt the routing action declared by
    the workflow signal block.
  - **Consumes** `advanceJob` (WF-P8-MULTISTEP) for the
    "no-signal" continue path so multi-step Agent jobs advance
    the step pointer after `agent_report_accepted` is appended.
  - **Consumes** `artifactStepDir` from
    `src/artifact/artifactPaths.ts` to locate
    `<runDir>/jobs/<jobId>/attempts/<attempt>/steps/<stepId>/report.json`.
  - **Consumes** `readActiveRun` from `src/run/index.ts` to map
    the active run pointer in `.zigma-flow/config.json`.
  - **Produces** the `acceptAgentReport(opts)` Engine entry; the
    `next` CLI command; the `agent_report_accepted` event emission
    (the payload `AgentReportAcceptedPayload` already exists in
    `src/events/eventTypes.ts` from P4); the `JobState.outputs`
    persistence semantics.
  - **MUST NOT** be called by Adapters, Skill Packs, or CLI
    commands other than `next` (and a future `step` integration in
    a P10 acceptance pass).
  - **MUST NOT** evaluate workflow expressions
    (`${{ jobs.<id>.outputs.<key> }}`). The `outputs` field is
    persisted verbatim. Downstream expression resolution against
    `JobState.outputs` is **TD-P9-001 / TD-P9-002**.
  - **MUST NOT** allow Agent to modify `state.json` directly —
    the Agent only writes a `report.json` artifact; the Engine
    is the sole writer of state and events.
  - **MUST NOT** double-emit `agent_report_accepted` when a signal
    dispatch path is taken. The two paths are mutually exclusive:
    - **No valid signal** → emit `agent_report_accepted` + call
      `advanceJob`.
    - **A valid signal exists** → DO NOT emit
      `agent_report_accepted`; emit the signal-dispatch chain
      (`signal_received` → action-specific event) via
      `applyRoutingAction`. The Agent report has been "consumed"
      by the signal; the `outputs` are still persisted to state
      BEFORE the dispatch.
  - **MUST NOT** silently ignore an undeclared signal. An Agent
    submitting `signals: [{ type: "rogue", ... }]` when the
    workflow does not declare `signals.rogue` is a contract
    violation → `ValidationError` (per mvp-contracts §2.6 "Agent
    不能直接修改 state" and prd §FR-010 "signal 必须由 workflow
    顶层声明").
  - **MUST NOT** dispatch a signal whose `allowed_from` does not
    include the current `jobId`. This is the FR-010
    `allowed_from` guard — `WorkflowError`.
  - **MUST NOT** accept multiple signals as a batch — per FR-010
    "多个 signal 同时出现时按优先级处理", the dispatcher selects
    exactly ONE highest-priority signal whose `type` is declared
    AND whose `allowed_from` permits the current `jobId`. The
    others are recorded in the `agent_report_accepted` payload
    audit trail (extension) but only one routing action fires.

## 1. Workflow Goal

Deliver the Agent Report acceptance entry that closes the Agent
execution loop: an Agent writes `report.json` to the canonical
artifact directory, the user runs `zigma-flow next --job <id>`,
and the Engine reads the report, validates it against the MVP
report schema, persists `outputs` to job state, dispatches the
highest-priority declared signal through the existing
`applyRoutingAction`, or (if no signal applies) appends
`agent_report_accepted` and delegates to `advanceJob` for the
multi-step pointer.

**Deliverables:**

1. `acceptAgentReport(opts)` in **`src/engine/accept.ts`** — pure
   accept-and-dispatch translator that:
   - Reads the current run state via `LocalStateStore`.
   - Resolves the step id from `JobState.current_step`
     (falling back to `JobDefinition.steps[0].id` for the first
     step per the WF-P8-MULTISTEP `FP-MULTISTEP-POINTER-INIT`
     convention).
   - Locates `report.json` under
     `artifactStepDir(runDir, jobId, attempt, stepId)/report.json`.
   - Parses JSON and enforces the §2.6 minimal schema (four
     top-level fields).
   - Persists `report.outputs` to `state.jobs[jobId].outputs`.
   - Validates each `report.signals[i].type` against
     `workflow.signals` and `allowed_from`, picks the
     highest-priority valid signal, then either dispatches via
     `applyRoutingAction` OR emits `agent_report_accepted` +
     `advanceJob`.
2. `next --job <job-id>` CLI command in
   **`src/commands/next.ts`** — reads the active run pointer
   from `.zigma-flow/config.json`, calls `acceptAgentReport`,
   and maps the result to a non-zero exit code on error.
3. `WorkflowDefinition.signals` schema refinement in
   `src/workflow/index.ts` — Step 2 introduces the
   `SignalDeclaration` zod schema with `allowed_from: string[]`
   and `action: RouterAction` (reusing `RouterActionSchema`).
   Old `Record<string, unknown>` typing becomes
   `Record<string, SignalDeclaration>`.
4. `JobState.outputs?: Record<string, unknown>` added to
   `src/run/index.ts`. The field is optional; existing snapshots
   without `outputs` remain backward-compatible.
5. `tests/engine/accept.test.ts` — red-phase tests for
   `acceptAgentReport`. **This workflow Step 1 ships only the
   cases-and-tests document and the failing test file; the
   handler and CLI command ship in Step 2.**

## 2. "用户可完成" Milestones

- **M1 — 用户可在 Agent 写入 `report.json` 后执行
  `zigma-flow next --job <id>`，让引擎接受 report，根据 Agent
  提交的 signal 推动工作流。** 用户编写一个 workflow，其中包含
  一个 Agent 类型 job（如 `intake` 或 `plan`），workflow 顶层
  声明 `signals.needs_architecture_design`（`allowed_from: [plan]`，
  `action: { activate_job: architecture-design }`）。Agent 子进程
  写入 `report.json`，用户依次执行：

  1. `zigma-flow next --job intake` —— report 仅有 outputs，无
     signal：events.jsonl 追加 `agent_report_accepted`；
     `state.jobs.intake.outputs` 被写入；`advanceJob` 推进到下一
     step 或将 `intake` 标记 `completed`；`state.last_event_id`
     与 events.jsonl 尾部一致。
  2. `zigma-flow next --job plan` —— report 包含
     `signals: [{ type: "needs_architecture_design", reason: "..." }]`，
     该 signal 已声明且 `plan` 在 `allowed_from`：events.jsonl
     追加 `signal_received` (`signal: "needs_architecture_design"`,
     `from_job: "plan"`, `from_step: "plan"`) → `job_activated`
     (`job_id: "architecture-design"`)；`state.jobs.architecture-design.status`
     从 `inactive` 切到 `ready`；**没有** `agent_report_accepted`
     事件，因为 signal 路径排他。
  3. `zigma-flow next --job plan`（report 含未声明 signal）—— 命令
     退出非零，错误 `kind === "ValidationError"`；events.jsonl 与
     state.json 字节内容均未改变。
  4. `zigma-flow next --job intake`（report 含 signal 但
     `allowed_from` 不包含 `intake`）—— 命令退出非零，错误
     `kind === "WorkflowError"`；events.jsonl 与 state.json 不变。
  5. `zigma-flow next --job plan`（report 含两个声明且 allowed 的
     signal，`priority` 不同）—— 仅最高优先级 signal 的 action
     被分发；`signal_received.payload.signal` 等于该 signal 的
     `type`；次高优先级 signal 的 action 不被执行。

  这是单一 "用户可完成" 任务（"agent-driven workflow
  advancement"），其执行路径在 M1 内部展开为 5 条期望子结果。

## 3. Spec Compliance Matrix

下表覆盖 mvp-contracts.md §2.3、§2.4、§2.6 与 prd §FR-010、§20 中
**Agent Report 接收** 与 **signal 校验/分发** 的 MUST / SHALL /
强制性条款。

| Clause ID | Clause Source | Clause Text (Summary) | Status |
| --- | --- | --- | --- |
| SC-A01 | mvp-contracts §2.3 | `state.jobs.<id>.outputs` 是 MVP 最小 RunState 字段，Engine 必须持久化 Agent report 中的 `outputs`. | 已纳入本工作流 — FP-ACCEPT-OUTPUTS-PERSIST；T-ACCEPT-2 断言 `state.jobs[jobId].outputs` 与 report.json `outputs` 相等. |
| SC-A02 | mvp-contracts §2.3 | `state.json` 只能由 Engine 通过 State Store 写入；写入顺序为 append event 后原子替换 snapshot；`state.last_event_id` 必须与 events.jsonl 尾部一致. | 已纳入本工作流 — FP-ACCEPT-EVENT-FIRST, FP-ACCEPT-STATE-WRITE；T-ACCEPT-1, T-ACCEPT-11 断言 `state.last_event_id` 与 events.jsonl 尾部一致. |
| SC-A03 | mvp-contracts §2.4 | `agent_report_accepted` 是 MVP 关键事件类型；必须使用与该 event 对应的 payload 结构. | 已纳入本工作流 — FP-ACCEPT-EVENT-EMIT；T-ACCEPT-1, T-ACCEPT-11 断言 `agent_report_accepted` 事件出现且 payload 含 `job_id` / `step_id` / `report_artifact`. |
| SC-A04 | mvp-contracts §2.6 | Agent report 必须含 `outputs` / `artifacts` / `signals` / `summary` 四个顶层字段；缺失 / JSON 不合法 / schema 不匹配时当前 step `failed` 或 `blocked`. | 已纳入本工作流 — FP-ACCEPT-SCHEMA-GUARD；T-ACCEPT-7, T-ACCEPT-8, T-ACCEPT-9 覆盖 JSON 不合法 / 缺 outputs / 缺 signals 三类失败. |
| SC-A05 | mvp-contracts §2.6 | report 缺失 → 当前 step `failed` 或 `blocked`. | 已纳入本工作流 — FP-ACCEPT-REPORT-MISSING；T-ACCEPT-6 断言抛 `FilesystemError`，state 未推进. |
| SC-A06 | mvp-contracts §2.6 | signal 必须先通过 Signal Handler 校验，Agent 不能直接修改 state. | 已纳入本工作流 — FP-ACCEPT-SIGNAL-VALIDATE, FP-ACCEPT-DISPATCH；Engine 是唯一 state 写入者；T-ACCEPT-3, T-ACCEPT-4, T-ACCEPT-5 验证 Engine 校验路径. |
| SC-A07 | prd §FR-010 | workflow 顶层声明 signal schema；Agent 提交 signal 时 Engine 必须依据 `allowed_from` 与 `priority` 校验. | 已纳入本工作流 — FP-ACCEPT-ALLOWED-FROM-GUARD, FP-ACCEPT-PRIORITY-SELECT；T-ACCEPT-4 验证未声明 signal 被拒；T-ACCEPT-5 验证 `allowed_from` 守卫；T-ACCEPT-10 验证 priority 选择. |
| SC-A08 | prd §FR-010 | 多个 signal 同时出现时按优先级处理（数值越大优先级越高，例 priority: 100 高于 50）. | 已纳入本工作流 — FP-ACCEPT-PRIORITY-SELECT；T-ACCEPT-10 断言两 signal 同时合法时只有最高优先级 signal 的 action 被分发. |
| SC-A09 | prd §20 阶段9 | 用户必须能通过 `next --job <id>` 让引擎读取 Agent report 并推进工作流；这是 Agent 执行循环的最后一公里. | 已纳入本工作流 — FP-ACCEPT-CLI-NEXT；T-ACCEPT-1 在 happy path 中通过 `acceptAgentReport` 直接覆盖（CLI 命令的端到端测试由 `tests/commands/next.test.ts` 在 Step 2 同步补充；本测试文件覆盖 Engine 入口）. |
| SC-A10 | mvp-contracts §2.5 | artifact path 必须是相对 run directory 的安全路径；report.json 的预期位置为 `<runDir>/jobs/<jobId>/attempts/<attempt>/steps/<stepId>/report.json`. | 已纳入本工作流 — FP-ACCEPT-REPORT-LOCATE；测试 fixture 写入该路径并验证 Engine 在该位置读取. |
| SC-A11 | architecture §7.1 | Engine 对外暴露少量命令式入口；CLI 命令只调用这些入口，不直接改 run state. | 已纳入本工作流 — FP-ACCEPT-ENGINE-ENTRY；`acceptAgentReport` 是从 `src/engine/accept.ts` 的 named export，被 `src/commands/next.ts` 调用；CLI 不直接写 state.json. |
| SC-A12 | mvp-contracts §2.4 + WF-P8-SIGNALS Architecture Decision 9 | `signal_received` 的 payload `{ signal, from_job, from_step }` 在 Agent-driven 路径中 `signal` 字段填充的是 workflow `signals.<name>` 键名，`from_job` / `from_step` 标识 Agent 执行的源 step. | 已纳入本工作流 — FP-ACCEPT-SIGNAL-EMIT；T-ACCEPT-3 断言 `signal_received.payload.signal === "<workflow signal name>"`. |
| SC-A13 | mvp-contracts §2.6 | report.signals[i].reason 字段可选；Agent 可仅提供 `type`. | 已纳入本工作流 — FP-ACCEPT-SIGNAL-VALIDATE 容忍缺 reason；T-ACCEPT-12 验证无 reason 也能分发. |

**Spec clause count:** 13 in-scope clauses (within the ≤15 envelope);
2 technical-debt registrations below.

| TD ID | Spec Reference | Description | Deferred To |
| --- | --- | --- | --- |
| TD-P9-001 | prd §FR-007, mvp-contracts §2.3 | `${{ jobs.<id>.outputs.<key> }}` 表达式解析。P9 仅持久化 `outputs` 到 state，不实现对 outputs 的表达式语言读取。 | P10 |
| TD-P9-002 | prd §FR-007, mvp-contracts §2.3 | `${{ steps.<id>.outputs.<key> }}` 表达式解析。同上，但作用域是同 job 内 step 间。 | P10 |

> **附加说明：**`signals.<name>.severity` 字段在本工作流仅做
> **passthrough 解析**（不影响 Engine 行为），因为 mvp-contracts
> §2.6 与 prd §FR-010 都没有把 severity 列为 MUST 行为：它影响
> 的是用户可读告警分级，属于运营/可观察性范畴。Step 2 的
> `SignalDeclaration` schema 接受该字段以保证 fixture 兼容性，但
> Engine 不基于该字段做决策。

## 4. Functional Points

| FP id | Area | Source | Summary |
| --- | --- | --- | --- |
| FP-ACCEPT-ENGINE-ENTRY | Engine entry | arch §7.1 | `acceptAgentReport(opts)` is a named export of `src/engine/accept.ts` with signature `(opts: { runDir, runId, jobId, clock }) => Promise<void>`. Called by the `next` CLI command. NOT called by router/script/check executors. |
| FP-ACCEPT-STATE-READ | Pre-condition | mvp §2.3 | Reads `state.json` via `LocalStateStore`. If null → `StateError`. Reads `state.jobs[jobId]`; if absent → `StateError`. |
| FP-ACCEPT-REPORT-LOCATE | Report path resolution | mvp §2.5, §2.6 | Resolves `stepId` = `state.jobs[jobId].current_step` (or `jobDef.steps[0].id` if undefined per WF-P8-MULTISTEP `FP-MULTISTEP-POINTER-INIT`). Resolves `attempt` = `state.jobs[jobId].attempt ?? 1`. Computes `reportPath = join(artifactStepDir(runDir, jobId, attempt, stepId), "report.json")`. |
| FP-ACCEPT-REPORT-MISSING | Missing report file | mvp §2.6 | If `report.json` is missing → throw `FilesystemError` BEFORE any event is appended. state.json and events.jsonl unchanged. |
| FP-ACCEPT-REPORT-PARSE | JSON parsing | mvp §2.6 | If `report.json` is present but JSON-parse fails → throw `ValidationError` BEFORE any event. state and events unchanged. |
| FP-ACCEPT-SCHEMA-GUARD | Minimal schema | mvp §2.6 | After parse, MUST verify all four top-level fields exist: `outputs` (object), `artifacts` (array), `signals` (array), `summary` (string). Missing any → `ValidationError`. |
| FP-ACCEPT-OUTPUTS-PERSIST | outputs persistence | mvp §2.3 | After schema guard, write `state.jobs[jobId].outputs = report.outputs` BEFORE the dispatch decision. The persisted outputs survive even when the dispatch path is signal-driven (i.e., even when `agent_report_accepted` is NOT emitted). The single snapshot is written at the end of the call. |
| FP-ACCEPT-SIGNAL-VALIDATE | Signal validation | prd §FR-010, mvp §2.6 | For each entry in `report.signals` (each having `type: string` and optional `reason: string`): (a) if `workflow.signals[type]` does not exist → push into "undeclared" list. If the undeclared list is non-empty AFTER processing all signals → throw `ValidationError`. (b) if exists but `allowed_from` does not contain the current `jobId` → push into "disallowed" list; if non-empty → throw `WorkflowError`. (c) otherwise add to the "valid" list. |
| FP-ACCEPT-PRIORITY-SELECT | Priority selection | prd §FR-010 | Among "valid" signals, select the one with the highest numeric `priority` (declared in `workflow.signals[type].priority`; default 0 if absent). Ties: the first such signal in declaration order in the workflow YAML wins (zod parses object literally; we iterate `Object.keys(workflow.signals)` to find the first match). |
| FP-ACCEPT-DISPATCH | Signal dispatch | prd §FR-010, WF-P8-SIGNALS | If a valid signal was selected: call `applyRoutingAction({ runDir, runId, sourceJobId: jobId, sourceStepId: stepId, attempt, action: workflow.signals[selectedType].action, reason: selectedSignal.reason ?? "agent signal: <type>", clock })`. The `signal_received` event payload's `signal` slot will hold `<workflow signal name>` (FP-ACCEPT-SIGNAL-EMIT); Step 2 ensures `applyRoutingAction` accepts this overridden discriminator OR `acceptAgentReport` emits the `signal_received` itself and only calls `applyRoutingAction` for the action-execution sub-path. (Step 2 decides the exact factoring; the observable contract here is: events.jsonl tail = `signal_received` → action-specific event.) |
| FP-ACCEPT-NO-SIGNAL-PATH | No-signal path | mvp §2.4 | If no valid signal was selected AND no undeclared/disallowed signal triggered an error (i.e., `report.signals` was empty): emit `agent_report_accepted` event with payload `{ job_id, step_id, report_artifact }` where `report_artifact` is the workspace-relative path to `report.json`. Then call `advanceJob({ runDir, runId, jobId, clock })`. The `advanceJob` call writes its own snapshot (per WF-P8-MULTISTEP `FP-MULTISTEP-POINTER-WRITE` / `FP-MULTISTEP-JOB-COMPLETED`); `acceptAgentReport` MUST persist `outputs` BEFORE calling `advanceJob` so the persisted `outputs` are part of the snapshot `advanceJob` reads. |
| FP-ACCEPT-EVENT-EMIT | `agent_report_accepted` event | mvp §2.4 | The event uses the existing `AgentReportAcceptedPayload { job_id, step_id, report_artifact }`. The producer is `engine`. `report_artifact` is a path relative to the run directory, e.g. `jobs/plan/attempts/1/steps/plan/report.json`. |
| FP-ACCEPT-SIGNAL-EMIT | `signal_received` payload — Agent origin | mvp §2.4, WF-P8-SIGNALS AD-9 | When the dispatch path emits `signal_received`, payload `signal` slot = `<workflow signal name>` (NOT the action discriminator). `from_job` = `jobId`, `from_step` = `stepId`. This is how Agent-driven signal events are distinguished from routing-driven ones in the audit trail. |
| FP-ACCEPT-EVENT-FIRST | Event-then-snapshot ordering | arch §7.3 | All events MUST be appended BEFORE the terminal state snapshot. `state.last_event_id` MUST equal the tail of events.jsonl after the call. |
| FP-ACCEPT-STATE-WRITE | Single writer | mvp §2.3 | All snapshot writes go through `LocalStateStore.writeSnapshot`. No direct `fs.writeFile` of `state.json`. Per call: one snapshot from `acceptAgentReport` itself (the outputs persistence + signal-dispatch path), OR one snapshot delegated to `advanceJob` (the no-signal path) — Step 2 is permitted to fold both into a single write so long as the contract holds. |
| FP-ACCEPT-CLI-NEXT | `next` CLI command | prd §20 | `src/commands/next.ts` reads the active run pointer from `.zigma-flow/config.json`; if absent → `ConfigError`. Then calls `acceptAgentReport({ runDir: <runsDir>/<activeRun>, runId: activeRun, jobId: argv.job, clock: new SystemClock() })`. Errors from `acceptAgentReport` propagate to the CLI error handler (exit codes per `docs/mvp-contracts.md §7`). |
| FP-ACCEPT-IDEMPOTENT-TERMINAL | Terminal guard | mvp §2.3 | If `state.jobs[jobId].status` is `completed`, `failed`, or `blocked`, `acceptAgentReport` throws `StateError` BEFORE any event is appended. (A terminal job cannot accept a new report; recovery must go through `retry_job` via the signal handler, not via `next`.) |
| FP-ACCEPT-INVALID-JOB | Unknown job | mvp §2.3 | If `jobId` is not in `state.jobs` → `StateError`. If `jobId` is not in `workflow.jobs` → `WorkflowError`. |

## 5. Use Case Enumeration

| UC id | Actor | Trigger | Pre-conditions | Steps (happy path / failure) | Post-conditions / observable result |
| --- | --- | --- | --- | --- | --- |
| UC-ACCEPT-1 | Engine (no-signal report) | Agent has written a valid `report.json` with empty `signals: []`; user runs `zigma-flow next --job intake`. | state has `jobs.intake.status = "running"`, `current_step = "intake"`, `attempt = 1`; workflow has agent step `intake`. | `acceptAgentReport` reads report; persists `outputs`; emits `agent_report_accepted`; delegates to `advanceJob` which advances to next step or sets `completed`. | events.jsonl tail: `agent_report_accepted` then (if last step) `job_completed`. `state.jobs.intake.outputs` contains the report's outputs. `state.last_event_id` matches events tail. |
| UC-ACCEPT-2 | Engine (outputs persistence) | Agent submits report with `outputs: { summary: "..." }`. | Same shape as UC-ACCEPT-1 but with non-empty outputs. | Outputs are written to state BEFORE advanceJob. | `state.jobs[jobId].outputs.summary` equals the report's value. |
| UC-ACCEPT-3 | Engine (valid signal dispatch) | Agent submits report whose `signals: [{ type: "needs_architecture_design", reason: "uncertain coupling" }]`. Workflow declares `signals.needs_architecture_design.allowed_from = ["plan"]` and `.action = { activate_job: "architecture-design" }`. | state has `jobs.plan.status = "running"`, `current_step = "plan"`. | Validate signal: declared ✓, allowed_from contains "plan" ✓. Dispatch via `applyRoutingAction({ action: { activate_job: "architecture-design" }, reason, ... })`. | events.jsonl contains `signal_received` (`payload.signal === "needs_architecture_design"`) → `job_activated`. `state.jobs["architecture-design"].status === "ready"`. NO `agent_report_accepted` event. |
| UC-ACCEPT-4 | Engine (negative — undeclared signal) | Agent submits `signals: [{ type: "rogue" }]`; workflow does NOT declare `signals.rogue`. | state has `jobs.plan.status = "running"`. | `acceptAgentReport` throws `ValidationError` before any event. | events.jsonl unchanged; state.json unchanged. |
| UC-ACCEPT-5 | Engine (negative — disallowed source) | Agent submits `signals: [{ type: "needs_architecture_design" }]` from `intake`; workflow allows the signal only from `plan`/`review`. | state has `jobs.intake.status = "running"`. | `acceptAgentReport` throws `WorkflowError` before any event. | events.jsonl unchanged; state.json unchanged. |
| UC-ACCEPT-6 | Engine (negative — report missing) | Agent never wrote `report.json` at the expected path. | state has `jobs.<id>.status = "running"`. | `acceptAgentReport` throws `FilesystemError` before any event. | events.jsonl unchanged; state.json unchanged. |
| UC-ACCEPT-7 | Engine (negative — invalid JSON) | `report.json` exists but contains malformed JSON. | Same as UC-ACCEPT-6. | `acceptAgentReport` throws `ValidationError`. | events.jsonl and state.json unchanged. |
| UC-ACCEPT-8 | Engine (negative — missing outputs field) | `report.json` parses but lacks the `outputs` top-level field. | Same. | `acceptAgentReport` throws `ValidationError`. | events.jsonl and state.json unchanged. |
| UC-ACCEPT-9 | Engine (negative — missing signals field) | `report.json` parses but lacks the `signals` top-level field. | Same. | `acceptAgentReport` throws `ValidationError`. | events.jsonl and state.json unchanged. |
| UC-ACCEPT-10 | Engine (priority selection) | Agent submits two valid signals with `priority` 100 and 50 respectively. | Both signals declared and allowed. | Only the priority-100 signal's action is dispatched. | events.jsonl tail: `signal_received` (`payload.signal === <type of priority-100>`) → action-specific event. The priority-50 signal's action is NOT executed (e.g., no second `job_activated`). |
| UC-ACCEPT-11 | Engine (agent_report_accepted payload audit) | Same as UC-ACCEPT-1. | Same. | Same. | `agent_report_accepted` event has `payload.job_id === jobId`, `payload.step_id === stepId`, `payload.report_artifact === "jobs/<jobId>/attempts/<attempt>/steps/<stepId>/report.json"`. |
| UC-ACCEPT-12 | Engine (signal reason optional) | Agent submits `signals: [{ type: "needs_architecture_design" }]` (no `reason`). | Workflow allows. | Dispatch proceeds with synthesized reason `"agent signal: needs_architecture_design"`. | `signal_received` event emitted; `state` transitions as in UC-ACCEPT-3. |

(12 use cases — within the ≤12 envelope; UC-ACCEPT-1..3 are happy
paths; UC-ACCEPT-4..9 are negative paths; UC-ACCEPT-10..12 are
edge / variant paths.)

## 6. Test Plan

All tests live in **`tests/engine/accept.test.ts`** under
`describe("acceptAgentReport", ...)`. Vitest. Real temp directories
under `os.tmpdir()`. No filesystem mocking. The test file boots a
real run via `createRun`, writes a fixture `report.json` at the
canonical artifact location, then invokes `acceptAgentReport` and
asserts on `state.json` / `events.jsonl`. Mirrors the bootstrap
pattern of `tests/engine/signals.test.ts`.

| Test id | `it` description | What it verifies | UCs covered | FPs covered | SCs touched |
| --- | --- | --- | --- | --- | --- |
| T-ACCEPT-1 | `no-signal report — emits agent_report_accepted and advances job pointer` | Agent step finishes; report has empty signals. Assert: (a) events.jsonl contains `agent_report_accepted` with correct payload; (b) `state.jobs[jobId].current_step` advanced (or job marked completed); (c) `state.last_event_id === <tail of events.jsonl>`. | UC-ACCEPT-1, UC-ACCEPT-11 | FP-ACCEPT-ENGINE-ENTRY, FP-ACCEPT-NO-SIGNAL-PATH, FP-ACCEPT-EVENT-EMIT, FP-ACCEPT-EVENT-FIRST | SC-A02, SC-A03, SC-A09 |
| T-ACCEPT-2 | `outputs persist to JobState.outputs` | Report `outputs = { summary: "done", risks: ["x"] }`. Assert `state.jobs[jobId].outputs` deep-equals the report's outputs. | UC-ACCEPT-2 | FP-ACCEPT-OUTPUTS-PERSIST | SC-A01 |
| T-ACCEPT-3 | `valid signal — dispatches via applyRoutingAction (activate_job)` | Workflow declares `signals.needs_architecture_design` with `allowed_from: ["plan"]` and `action: { activate_job: "architecture-design" }`. Job `plan` reports that signal. Assert: (a) events tail: `signal_received` → `job_activated`; (b) `signal_received.payload.signal === "needs_architecture_design"`; (c) `state.jobs["architecture-design"].status === "ready"`; (d) NO `agent_report_accepted` event in this run. | UC-ACCEPT-3 | FP-ACCEPT-SIGNAL-VALIDATE, FP-ACCEPT-DISPATCH, FP-ACCEPT-SIGNAL-EMIT | SC-A06, SC-A07, SC-A12 |
| T-ACCEPT-4 | `undeclared signal — ValidationError; no disk mutation` | Agent submits `signals: [{ type: "rogue" }]` while workflow declares only `signals.foo`. Assert: (a) throws with `kind === "ValidationError"`; (b) events.jsonl byte-content unchanged; (c) state.json byte-content unchanged. | UC-ACCEPT-4 | FP-ACCEPT-SIGNAL-VALIDATE | SC-A06, SC-A07 |
| T-ACCEPT-5 | `signal source not in allowed_from — WorkflowError; no disk mutation` | Workflow declares `signals.needs_architecture_design.allowed_from = ["plan"]`; Agent submits from `intake`. Assert: (a) throws with `kind === "WorkflowError"`; (b) events.jsonl and state.json byte-content unchanged. | UC-ACCEPT-5 | FP-ACCEPT-SIGNAL-VALIDATE | SC-A07 |
| T-ACCEPT-6 | `report.json missing — FilesystemError; no disk mutation` | No `report.json` at canonical path. Assert: (a) throws with `kind === "FilesystemError"`; (b) byte-content unchanged. | UC-ACCEPT-6 | FP-ACCEPT-REPORT-MISSING | SC-A05 |
| T-ACCEPT-7 | `report.json malformed JSON — ValidationError; no disk mutation` | Write `report.json` with content `"{ not json"`. Assert: (a) throws with `kind === "ValidationError"`; (b) byte-content unchanged. | UC-ACCEPT-7 | FP-ACCEPT-REPORT-PARSE | SC-A04 |
| T-ACCEPT-8 | `report.json missing outputs field — ValidationError; no disk mutation` | Write `report.json` = `{ "artifacts": [], "signals": [], "summary": "" }`. Assert ValidationError; no mutation. | UC-ACCEPT-8 | FP-ACCEPT-SCHEMA-GUARD | SC-A04 |
| T-ACCEPT-9 | `report.json missing signals field — ValidationError; no disk mutation` | Write `report.json` = `{ "outputs": {}, "artifacts": [], "summary": "" }`. Assert ValidationError; no mutation. | UC-ACCEPT-9 | FP-ACCEPT-SCHEMA-GUARD | SC-A04 |
| T-ACCEPT-10 | `multiple valid signals — only highest priority dispatched` | Workflow declares two signals (`sigA` priority 100, `sigB` priority 50) both allowed from current job. Agent submits BOTH. Assert: (a) `signal_received.payload.signal === "sigA"`; (b) ONLY `sigA.action` is dispatched (e.g., events contain exactly ONE `job_activated` matching `sigA`'s target); (c) `sigB`'s declared action does NOT fire. | UC-ACCEPT-10 | FP-ACCEPT-PRIORITY-SELECT | SC-A08 |
| T-ACCEPT-11 | `agent_report_accepted payload has correct fields` | Same setup as T-ACCEPT-1. Assert: `agent_report_accepted` event has `run_id === <runId>`, `job === <jobId>`, `step === <stepId>`, `attempt === <attempt>`, `payload.job_id === <jobId>`, `payload.step_id === <stepId>`, `payload.report_artifact === "jobs/<jobId>/attempts/<attempt>/steps/<stepId>/report.json"`. | UC-ACCEPT-11 | FP-ACCEPT-EVENT-EMIT | SC-A03, SC-A10 |
| T-ACCEPT-12 | `signal with no reason — accepted; dispatched with synthesized reason` | Agent submits `signals: [{ type: "needs_architecture_design" }]` (no `reason`). Assert: (a) no error; (b) `signal_received` and `job_activated` events emitted; (c) target job status transitions. | UC-ACCEPT-12 | FP-ACCEPT-SIGNAL-VALIDATE, FP-ACCEPT-DISPATCH | SC-A13 |

**Planned test file count:** 1 (`tests/engine/accept.test.ts`).
Within budget per granularity check.

## 7. Test Design Summary

- **Test framework:** vitest (`describe` / `it` / `expect` /
  `beforeEach` / `afterEach`). Mirrors the structure of
  `tests/engine/signals.test.ts`.
- **Imports under test:**
  - `acceptAgentReport` from `../../src/engine/accept.js` (does
    not exist yet — red phase; the module file does not exist).
    Lazy-import wrapper used so the test file compiles even
    before Step 2 lands. The wrapper throws a descriptive Error
    on missing module / missing export — every red test fails
    with the same diagnostic reason.
  - `createRun` from `../../src/engine/index.js` for sandbox
    setup.
  - `LocalStateStore`, `Clock` from `../../src/run/index.js` for
    snapshot mutation helpers.
  - `artifactStepDir` from `../../src/artifact/artifactPaths.js`
    to compute the report.json fixture path.
- **Filesystem:** real temp directories under `os.tmpdir()` with
  `node:crypto.randomUUID()` suffixes; no fs mocking. Each test
  creates its own `<sandbox>/.zigma-flow/` skeleton (`config.json`,
  `skill-lock.json`, `runs/`).
- **Clock:** inline `FakeClock { now(): "2026-06-11T00:00:00.000Z" }`.
- **Workflow YAML fixtures:**
  - `AGENT_NO_SIGNAL_YAML` — single agent step in job `intake`.
    Used by T-ACCEPT-1, T-ACCEPT-2, T-ACCEPT-6, T-ACCEPT-7,
    T-ACCEPT-8, T-ACCEPT-9, T-ACCEPT-11.
  - `AGENT_WITH_SIGNAL_YAML` — workflow with top-level
    `signals.needs_architecture_design` (`allowed_from: [plan]`,
    `action: { activate_job: architecture-design }`) plus jobs
    `plan` (agent), `architecture-design` (optional). Used by
    T-ACCEPT-3, T-ACCEPT-5, T-ACCEPT-12.
  - `AGENT_UNDECLARED_YAML` — workflow with only `signals.foo`
    declared. Used by T-ACCEPT-4.
  - `AGENT_MULTI_SIGNAL_YAML` — workflow declares both `sigA`
    (priority 100) and `sigB` (priority 50). Used by T-ACCEPT-10.
- **Report fixture helper:** local
  `writeReport(runDir, jobId, attempt, stepId, body)` — JSON
  stringifies `body` and writes it to the canonical
  `report.json` location (creating parent dirs as needed). For
  malformed JSON tests, body is passed as a raw string.
- **State mutation helper:** the existing `setJobState` pattern
  from `tests/engine/signals.test.ts` is reused (Step 1 inlines
  a minimal version) to pre-set `attempt` / `current_step` /
  `status` for tests that simulate "Agent has just finished
  the step".
- **JobState.outputs cast:** the `JobState` type does not yet
  declare an `outputs` field (Step 2 adds it). Tests that read
  outputs cast through `as unknown as { outputs?: ... }` to
  avoid a Step-1 TypeScript regression.
- **Pre/post evidence:** T-ACCEPT-4 / 5 / 6 / 7 / 8 / 9
  (negative tests) capture `events.jsonl` byte-content and
  `state.json` byte-content before invoking the handler and
  re-read them after to confirm zero mutation. Same pattern as
  `tests/engine/signals.test.ts` T-SIGNALS-10..12.
- **Lazy import wrapper:** `callAcceptAgentReport(opts)` defined
  in the test file dynamically imports
  `src/engine/accept.js` and inspects the named export; throws
  a descriptive Error if the module is missing or the export is
  missing. This mirrors the `callApplyRoutingAction` wrapper in
  `tests/engine/signals.test.ts`. The wrapper keeps the test
  file compilable even during the red phase (the module does
  not exist yet, but dynamic import only fails at runtime).

## 8. Architecture Decisions

1. **`acceptAgentReport` lives in `src/engine/accept.ts`.** Same
   pattern as `applyRoutingAction` in `src/engine/routing.ts`
   (P9 dev plan AD-P9-001). Keeps `src/engine/index.ts` lean and
   localizes the new accept-and-dispatch logic next to its
   dependencies.

2. **Signal dispatch reuses `applyRoutingAction`.** The Agent's
   declared signals are merely workflow-level pointers to
   `RouterAction` values. `acceptAgentReport` resolves the
   `RouterAction` from `workflow.signals[<type>].action` and
   delegates the actual state transition + event emission to
   `applyRoutingAction`. The ONLY differentiator from
   WF-P8-SIGNALS is the `signal_received.payload.signal` slot
   carries the workflow signal name (e.g.
   `"needs_architecture_design"`) rather than the action
   discriminator (e.g. `"activate_job"`). Step 2 decides whether
   `applyRoutingAction` accepts a `signalName?` override or
   whether `acceptAgentReport` emits `signal_received` itself
   and calls a refactored inner dispatcher; both are equivalent
   at the test contract level.

3. **`outputs` are persisted unconditionally before dispatch.**
   Whether the report carries a signal or not, the `outputs`
   field of the report is written to `state.jobs[jobId].outputs`
   first. This means even on the signal-dispatch path (where
   `agent_report_accepted` is suppressed), downstream consumers
   of `JobState.outputs` (TD-P9-001) see the same data.
   Architecturally cleaner than coupling outputs persistence to
   the no-signal path.

4. **Signal-dispatch path suppresses `agent_report_accepted`.**
   The two paths are mutually exclusive: when a signal fires,
   the `signal_received` + action-specific event chain is the
   audit trail; an additional `agent_report_accepted` would
   double-record the same Agent submission. The Agent report's
   existence is implicit in the `signal_received.payload`
   (`from_job` + `from_step` resolve back to the artifact
   directory).

5. **Priority tie-breaking by declaration order.** Per FR-010
   "按优先级处理"，but ties are not explicitly addressed. We
   adopt the convention "first declared wins" because workflow
   authors control declaration order and zod preserves object
   key order during parsing. Documented here so Step 2 doesn't
   diverge.

6. **Undeclared / disallowed signals abort the entire call.**
   We do NOT pick the first valid signal and silently drop
   invalid ones, because that would mask author bugs and let
   Agents bypass `allowed_from`. Both undeclared and disallowed
   signals are hard errors. The error message includes the
   first offending type so the user can correct the report.

7. **Report path uses `attempt` from `JobState.attempt ?? 1`.**
   For first-time Agent runs, `attempt` is implicit 1 and the
   report.json lives under `attempts/1/...` per the WF-P3-RUN
   artifact convention. After a `retry_job`, `attempt` is
   `>= 2` and the Agent writes to `attempts/<attempt>/...`. The
   `next` command does not need an explicit attempt argument.

8. **CLI command name: `next`, not `accept`.** Per P9 dev plan
   "next --job <id>". This matches the user mental model:
   "advance to the next step after the agent finished". Step 2
   adds the command file `src/commands/next.ts` and wires it
   into the commander setup.

9. **`JobState.outputs` is `Record<string, unknown>` for now.**
   AD-P9-003 in the dev plan documents this as
   `Record<string, string | undefined>` with non-string values
   JSON-stringified, but we adopt the more permissive shape
   here because mvp-contracts §2.3 doesn't constrain the
   element type and the dispatcher does not interpret the
   values (TD-P9-001). Step 2 may narrow this back to string if
   downstream expression evaluation demands it.

10. **No new error classes.** Negative paths reuse
    `ValidationError` (undeclared signal, malformed JSON, schema
    miss), `WorkflowError` (allowed_from violation), `StateError`
    (missing state, terminal job, unknown job in state),
    `FilesystemError` (missing report.json). The taxonomy is
    sufficient.

## 9. Red-Phase Expectations

- `src/engine/accept.ts` does not yet exist; the test file uses
  a lazy-import wrapper (`callAcceptAgentReport`) that catches
  the dynamic-import failure and re-throws a descriptive Error.
  Every T-ACCEPT-N test should fail at runtime with the SAME
  diagnostic reason: "acceptAgentReport not yet implemented".
- `src/run/index.ts` `JobState.outputs` field does not yet exist.
  Tests that read `outputs` cast via
  `as unknown as { outputs?: ... }`. After Step 2 adds the
  field, the casts can be removed in a follow-up cleanup or
  left as defensive narrowing.
- `src/workflow/index.ts` `WorkflowDefinition.signals` is
  currently `Record<string, unknown>`. The test fixtures write
  the structured signal declarations as YAML strings; once
  Step 2 refines the schema, the YAML should parse without
  changes to the fixtures. The Step-1 red phase therefore
  exercises the runtime by feeding the YAML through `createRun`
  (which calls `loadWorkflowFile`) — if Step 2 inadvertently
  tightens the schema in a way that rejects the fixture YAML,
  T-ACCEPT-1 will surface that immediately.
- `src/commands/next.ts` does not yet exist. The Step 1 tests do
  NOT exercise the CLI command directly; they call
  `acceptAgentReport` via the Engine entry. CLI-level tests
  belong to `tests/commands/next.test.ts`, added in Step 2.
- `tests/engine/signals.test.ts` MUST keep passing after this
  slice (the `applyRoutingAction` contract is unchanged; the
  Agent-signal path simply invokes it with a different
  `signal_received` payload discriminator, owned by
  `acceptAgentReport` not by `applyRoutingAction` itself).
- `tests/engine/multistep.test.ts` MUST keep passing — the
  no-signal path delegates to `advanceJob` unchanged.

## 10. Step 2 Handoff Notes

1. **`src/engine/accept.ts`** MUST export `acceptAgentReport`
   with a signature structurally compatible with:

   ```ts
   import type { Clock } from "../run/index.js";

   export interface AcceptAgentReportOpts {
     runDir: string;
     runId: string;
     jobId: string;
     clock: Clock;
   }

   export function acceptAgentReport(opts: AcceptAgentReportOpts): Promise<void>;
   ```

   The function MUST be re-exported from `src/engine/index.ts`
   alongside `applyRoutingAction`.

2. **`src/engine/index.ts`** SHOULD add a re-export line:

   ```ts
   export { acceptAgentReport } from "./accept.js";
   export type { AcceptAgentReportOpts } from "./accept.js";
   ```

3. **`src/run/index.ts`** MUST extend `JobState` to include the
   `outputs` field used by `acceptAgentReport`:

   ```ts
   export interface JobState {
     // ... existing fields
     outputs?: Record<string, unknown>;
   }
   ```

   This is the field documented in mvp-contracts §2.3 as part of
   the per-job state. No migration required for existing
   snapshots — the field is optional.

4. **`src/workflow/index.ts`** MUST refine the `signals`
   schema. Replace:

   ```ts
   signals: z.record(z.string(), z.unknown()).optional()
   ```

   with a zod schema for `SignalDeclaration`:

   ```ts
   const SignalDeclarationSchema = z.object({
     severity: z.enum(["low", "medium", "high"]).optional(),
     priority: z.number().optional(),
     allowed_from: z.array(z.string()),
     action: RouterActionSchema,
   }).passthrough();

   // ... in WorkflowSchema:
   signals: z.record(z.string(), SignalDeclarationSchema).optional()
   ```

   And export the TypeScript type:

   ```ts
   export interface SignalDeclaration {
     severity?: "low" | "medium" | "high";
     priority?: number;
     allowed_from: string[];
     action: RouterAction;
     [key: string]: unknown;
   }

   export interface WorkflowDefinition {
     // ... existing fields
     signals?: Record<string, SignalDeclaration>;
   }
   ```

5. **`src/commands/next.ts`** MUST be created with the
   commander command shape mirroring the existing `step`
   command. It calls `acceptAgentReport` with the active run
   pointer; on `ConfigError` (no active run), it prints a
   user-actionable message and exits with code 4.

6. **Execution order in `acceptAgentReport` MUST be:**
   - Read `state.json` → if `null`, throw `StateError`.
   - Locate `state.jobs[jobId]` → if absent, throw `StateError`.
   - Guard terminal status (`completed`/`failed`/`blocked`) → `StateError`.
   - Load workflow → locate `workflow.jobs[jobId]` → if absent, throw `WorkflowError`.
   - Resolve `stepId` = `state.jobs[jobId].current_step ?? jobDef.steps[0].id`.
   - Resolve `attempt` = `state.jobs[jobId].attempt ?? 1`.
   - Compute `reportPath = join(artifactStepDir(runDir, jobId, attempt, stepId), "report.json")`.
   - Read `report.json`; if ENOENT → throw `FilesystemError`.
   - Parse JSON; on failure → throw `ValidationError`.
   - Validate the four-field schema; on failure → throw `ValidationError`.
   - Iterate `report.signals`; for each: validate `type` against `workflow.signals`. If any undeclared → throw `ValidationError`. If any disallowed_from → throw `WorkflowError`. Collect valid signals.
   - If valid signals exist: pick highest `priority` (tie: first declared); call `applyRoutingAction` for that signal's action with the `signal_received.payload.signal` slot set to the workflow signal name. (Persist `outputs` first via a snapshot or fold into the dispatcher's snapshot — Step 2 decides.)
   - If no valid signals: persist `outputs`; append `agent_report_accepted` event; call `advanceJob`.

7. **Test churn note.** No existing tests need to change. The
   new red-phase tests in `tests/engine/accept.test.ts` will
   turn green once Step 2 lands. The contract-test for
   `EVENT_TYPES.length` should already include
   `agent_report_accepted` (P4 already added this tag).

8. **CLI integration test (deferred to a separate file).**
   `tests/commands/next.test.ts` SHOULD be added by the Step 2
   author with at least one end-to-end test that runs the CLI
   binary in a temp project and asserts the exit code + state
   change. This is beyond the scope of `accept.test.ts` (which
   covers the Engine entry directly).

## 11. Test Gaps

- **Expression resolution against `JobState.outputs`**:
  TD-P9-001 / TD-P9-002 (P10). Once `outputs` are persisted,
  workflows expressing `${{ jobs.<id>.outputs.<key> }}` and
  `${{ steps.<id>.outputs.<key> }}` need a resolver path in
  `src/expression/index.ts`. Not in scope here.
- **CLI end-to-end test for `next`**: deferred to
  `tests/commands/next.test.ts` in Step 2.
- **report.json schema beyond the four MVP fields**:
  mvp-contracts §2.6 specifies the minimal shape; extended
  shapes (per-signal `severity` overrides, per-artifact
  metadata) belong to a future enhancement, not P9.
- **`severity` field on signals**: parsed but not acted on (see
  §3 附加说明).
- **`signals` field on `RunState`**: mvp-contracts §2.3 lists
  it. P9 only consumes per-report signals; a persistent
  `state.signals` history is a future audit-store concern
  beyond MVP.
- **Concurrent submissions**: not in scope (MVP single-writer
  CLI invariant). The handler assumes serial invocation.

## 12. Granularity Check Summary

| Metric | Count | Limit | Status |
|---|---|---|---|
| "用户可完成…" user task milestones | 1 (M1 agent-driven workflow advancement, expanded into 5 sub-results) | 1 | within budget |
| Spec mandatory clause references | 13 in-scope + 2 TD registrations | 15 | within budget |
| Planned test files | 1 (`tests/engine/accept.test.ts`) | 1 | within budget |
| Use case enumeration | 12 (UC-ACCEPT-1..3 happy paths, UC-ACCEPT-4..9 negative paths, UC-ACCEPT-10..12 edge/variant) | – | bounded by 4 schema fields × signal taxonomy |
| Planned test cases | 12 (T-ACCEPT-1..12) | – | one-to-one or many-to-one with UCs |
