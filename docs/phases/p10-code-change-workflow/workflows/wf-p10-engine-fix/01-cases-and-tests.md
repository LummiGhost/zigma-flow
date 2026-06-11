---
workflow: WF-P10-ENGINE-FIX
title: acceptAgentReport 信号路径 source job 推进修复 — 用例与失败测试
phase: P10
status: red (Step 1)
date: 2026-06-11
authority: docs/prd.md §20, docs/mvp-contracts.md §2.3, §2.4, §2.6, docs/architecture.md §7.1, §7.2
tech-debt-resolved: TD-P10-ACCEPT-ADVANCE
spec-source:
  - docs/phases/p10-code-change-workflow/02-development-plan.md §3 AD-P10-003, §4 WF-P10-ENGINE-FIX
  - src/engine/accept.ts (P9 baseline — bug carrier)
  - src/engine/routing.ts (P9 baseline)
  - src/engine/index.ts (P8/P9 baseline, advanceJob)
  - tests/engine/accept.test.ts (P9 baseline T-ACCEPT-1..13)
---

# WF-P10-ENGINE-FIX — 用例与失败测试

## 0. 目的

P9 交付的 `acceptAgentReport` 在信号路径中调用 `applyRoutingAction` 后即返回，
导致提交报告的 source job 在 `retry_job` / `activate_job` 两种 RouterAction 下永远
停留在 `"running"`，CLI 没有任何命令能将其推进到 terminal 状态。本工作流目标是
为该路径补齐 source job 推进的最后一步，使 source job 在信号处理完成后能正确进入
`"completed"`（或保持原有终态语义）。

本文档列出该修复必须覆盖的功能点、用例、与 red-phase 失败测试清单。Step 2 (green)
必须使本文档列出的所有 T-ACCEPT-14 / T-ACCEPT-15 测试通过，且不破坏现有
T-ACCEPT-1..13 测试。

## 1. 功能点清单

| 编号                    | 功能点                                                                                                | 来源                  | 影响文件               |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | --------------------- | ---------------------- |
| FP-ENGFIX-RETRY-ADV     | 信号路径分发 `retry_job` 动作后，对 source job 调用 `advanceJob`，使其进入 `"completed"`              | TD-P10-ACCEPT-ADVANCE | `src/engine/accept.ts` |
| FP-ENGFIX-ACTIVATE-ADV  | 信号路径分发 `activate_job` 动作后，对 source job 调用 `advanceJob`，使其进入 `"completed"`           | TD-P10-ACCEPT-ADVANCE | `src/engine/accept.ts` |
| FP-ENGFIX-CONTINUE-NOOP | `continue` 已由 `applyRoutingAction` 内部推进 source job，新增 `advanceJob` 必须保持幂等无副作用      | TD-P10-ACCEPT-ADVANCE | `src/engine/accept.ts` |
| FP-ENGFIX-GOTO-NOOP     | `goto_job` 已在 `applyRoutingAction` 内将 source 置 `"completed"`；新增 `advanceJob` 必须无副作用     | TD-P10-ACCEPT-ADVANCE | `src/engine/accept.ts` |
| FP-ENGFIX-FAIL-NOOP     | `fail` / `block` 终态下 `advanceJob` 必须无副作用（既有 advanceJob FP-MULTISTEP-FAILED-GATE 已保证）   | TD-P10-ACCEPT-ADVANCE | `src/engine/accept.ts` |
| FP-ENGFIX-NO-REGRESSION | 现有 T-ACCEPT-1..13（含 T-ACCEPT-3 的 `activate_job`、T-ACCEPT-13 的 `continue`）保持通过             | TD-P10-ACCEPT-ADVANCE | `src/engine/accept.ts` |

## 2. 规范强制条款矩阵

| 条款                                                                                                       | 来源              | 状态        | 落点                                              |
| ---------------------------------------------------------------------------------------------------------- | ----------------- | ----------- | ------------------------------------------------- |
| `state.jobs.<id>.status` 必须可从 `"running"` 推进到 `"completed"`，无 orphan running                      | §2.3 状态机       | 修复中      | FP-ENGFIX-RETRY-ADV, FP-ENGFIX-ACTIVATE-ADV       |
| `applyRoutingAction` 在 retry/activate 路径下只触达 target，不应负责 source 推进                           | §2.4 RouterAction | 沿用 P8/P9  | 修复在 `acceptAgentReport` 层补齐 source 推进     |
| `state.last_event_id` 必须与 events.jsonl 尾部一致                                                         | §2.3 约束 3       | 必须保持    | T-ACCEPT-14/15 末尾断言 tail 与 `last_event_id`   |
| 写入顺序：append event → 原子替换 state snapshot                                                            | §2.3 约束 2       | 必须保持    | `advanceJob` 内部已有顺序由 P8 守护               |
| `state.json` 只能由 Engine 通过 State Store 写入                                                            | §2.3 约束 1       | 不变更      | `LocalStateStore.writeSnapshot`                   |
| 单 agent step 的 job 在 source 推进后必须发 `job_completed` 事件                                            | §2.4 事件契约     | 修复中      | FP-ENGFIX-RETRY-ADV, FP-ENGFIX-ACTIVATE-ADV       |

## 3. 用例

每个用例对应一个或多个 T-ACCEPT-* 测试。"设置 / 触发 / 断言" 是 vitest 测试结构
的语义化映射。

### UC-ACCEPT-14 — `retry_job` 信号后 source job (review) 推进到 completed

- **设置**：
  - workflow 声明两个 job：`implement`（1 agent step，`retry: { max_attempts: 3 }`）
    与 `review`（1 agent step，`needs: [implement]`）。
  - 顶层 `signals.review_rejected: { allowed_from: [review], action: { retry_job: implement } }`。
  - 初始 state：`implement` 状态 `"completed"`（attempt 1，模拟首次实现已完成），
    `review` 状态 `"running"`，`current_step = "review-step"`，`attempt = 1`。
  - 在 `review` step 1 attempt 的 canonical 路径写入 `report.json`，`signals: [{ type: "review_rejected" }]`，
    带 `outputs: { decision: "rejected" }`。
- **触发**：调用 `acceptAgentReport({ runDir, runId, jobId: "review", clock })`。
- **断言**：
  - `state.jobs["review"].status === "completed"`（修复前为 `"running"`，红测点）。
  - `state.jobs["implement"].status === "ready"`，`attempt === 2`。
  - `events.jsonl` 顺序包含：`signal_received`（payload.signal = `"review_rejected"`）→
    `job_retrying`（target=implement，attempt=2）→ `job_completed`（source=review）。
  - `state.last_event_id` 指向最后一条 `job_completed`（review 的）。
  - 不发出 `agent_report_accepted`（信号路径契约）。

覆盖：FP-ENGFIX-RETRY-ADV, FP-ENGFIX-NO-REGRESSION → T-ACCEPT-14。

### UC-ACCEPT-15 — `activate_job` 信号后 source job (plan) 推进到 completed

- **设置**：
  - workflow 声明两个 job：`plan`（1 agent step）与 `architecture-design`
    （1 agent step，`activation: "manual"`，`needs: [plan]`）。
  - 顶层 `signals.needs_architecture_design: { allowed_from: [plan], action: { activate_job: architecture-design } }`。
  - 初始 state：`plan` 状态 `"running"`，`current_step = "plan-step"`，`attempt = 1`；
    `architecture-design` 状态 `"inactive"`。
  - 在 `plan` step 1 attempt 的 canonical 路径写入 `report.json`，
    `signals: [{ type: "needs_architecture_design" }]`，
    带 `outputs: { suggested_design: "module-split" }`。
- **触发**：调用 `acceptAgentReport({ runDir, runId, jobId: "plan", clock })`。
- **断言**：
  - `state.jobs["plan"].status === "completed"`（修复前为 `"running"`，红测点）。
  - `state.jobs["architecture-design"].status` ∈ `{ "ready", "waiting" }`：
    - 因为 `architecture-design.needs = [plan]`，且 `plan` 在 source 推进后已 `"completed"`，
      期望 `"ready"`；保留 `"waiting"` 作为 DAG 顺序敏感行为的兜底（若 routing 在 plan
      置 completed 之前评估）。
  - `events.jsonl` 顺序包含：`signal_received`（payload.signal = `"needs_architecture_design"`）→
    `job_activated`（target=architecture-design）→ `job_completed`（source=plan）。
  - `state.last_event_id` 指向最后一条 `job_completed`（plan 的）。
  - 不发出 `agent_report_accepted`。

覆盖：FP-ENGFIX-ACTIVATE-ADV, FP-ENGFIX-NO-REGRESSION → T-ACCEPT-15。

### 回归用例 — T-ACCEPT-3 / T-ACCEPT-10 / T-ACCEPT-12（既有 `activate_job` 信号）

- T-ACCEPT-3 / T-ACCEPT-10 / T-ACCEPT-12 已断言信号路径行为，但**未**断言 source job
  最终状态（断言只覆盖 target 与 events）。修复后这些用例的 target/事件断言保持
  通过；source job 由 `"running"` 变为 `"completed"` 不破坏既有断言。
- 这些用例不需要修改；Step 2 必须保证它们继续绿。

### 回归用例 — T-ACCEPT-13（信号路径 `outputs` 持久化，action 实为 `activate_job`）

- T-ACCEPT-13 使用 `AGENT_WITH_SIGNAL_YAML`，其 `needs_architecture_design.action`
  是 `activate_job: architecture-design`（**不是** `continue`）。该测试只断言
  `state.jobs["plan"].outputs` 等于 report 内 outputs，不断言 plan 的 status。
- 修复后 plan 由 `"running"` 进入 `"completed"`，`outputs` 字段不受影响，
  既有断言保持通过。Step 2 必须保证 T-ACCEPT-13 继续绿。

### 安全性检查 — 边界场景

- **B-1**：source job 在 signal 处理后已无下一 step（单 step 的 agent job），
  `advanceJob` 走 terminal 分支：append `job_completed` + status → `"completed"`。
  T-ACCEPT-14 / T-ACCEPT-15 均覆盖该路径。
- **B-2**：source job 是多 step（agent 步骤排在 router/check 之前），
  `advanceJob` 走 pointer 推进分支：写 `current_step = next.id`，不发新事件。
  本工作流的 retry/activate 信号默认终结 source job 当前 attempt 的执行链，因此
  典型使用是单 step 终结；多 step 情形不属于本修复的目标语义，但 `advanceJob`
  天然提供向后兼容的 pointer 推进，无副作用。
- **B-3**：`advanceJob` 自带终态闭门器（`completed/failed/blocked` 早返回），
  对于 `fail` / `block` / `goto_job` 三个动作，`advanceJob` 的二次调用是幂等
  no-op。T-ACCEPT-14 / T-ACCEPT-15 不直接覆盖，但既有 P8 测试
  T-SIGNALS-* + P9 T-ACCEPT-* 已守护。
- **B-4**：`continue` 已在 `applyRoutingAction` 内部调用 `advanceJob`，新增的
  二次 `advanceJob` 因 source 已 `"completed"` 走 FP-MULTISTEP-IDEMPOTENT-TERMINAL
  早返回，不发新事件。无需新增测试，T-ACCEPT-1 等既有用例（含 advanceJob 路径）
  继续守护。

## 4. 失败测试清单

| 测试 ID       | 描述                                                       | 失败原因（red）                                                          | 覆盖功能点                              |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------- |
| T-ACCEPT-14   | review 提交 `retry_job` 信号 → source review 推进到 completed | 修复前 `acceptAgentReport` 信号路径 return 后 review 停留 `"running"`    | FP-ENGFIX-RETRY-ADV, FP-ENGFIX-NO-REGRESSION |
| T-ACCEPT-15   | plan 提交 `activate_job` 信号 → source plan 推进到 completed  | 修复前 `acceptAgentReport` 信号路径 return 后 plan 停留 `"running"`      | FP-ENGFIX-ACTIVATE-ADV, FP-ENGFIX-NO-REGRESSION |

## 5. 实现指引（Step 2 边界）

- **唯一变更点**：`src/engine/accept.ts` 信号分发块。
- **修改方式**：在 `applyRoutingAction(...)` 调用之后、`return` 之前，
  对 `retry_job` / `activate_job` 两种 object-form action 追加一次
  `await advanceJob({ runDir, runId, jobId: sourceJobId, clock })` 调用。
  其余 action 形式（`continue` / `fail` / `block` / `goto_job`）可同样调用，
  依赖 `advanceJob` 自身的幂等终态闭门器实现 no-op 语义。
- **不得变更**：
  - `applyRoutingAction` 实现 / 事件顺序。
  - `advanceJob` 实现 / 终态闭门器。
  - 既有 T-ACCEPT-1..13 行为。
- **事件顺序**：`signal_received → job_retrying|job_activated|job_skipped → job_completed`
  （source job 的 `job_completed` 必须在 routing 事件之后）。
  这由 `advanceJob` 内部的 append-event-then-snapshot 顺序天然保证。

## 6. 验收清单

- T-ACCEPT-14 / T-ACCEPT-15 在 Step 2 实现后转绿。
- T-ACCEPT-1..13 全部保持绿。
- `pnpm typecheck && pnpm lint && pnpm test:ci` 通过。
- 无新增技术债。
