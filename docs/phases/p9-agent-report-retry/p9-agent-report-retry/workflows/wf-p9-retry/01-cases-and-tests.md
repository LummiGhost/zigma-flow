---
workflow: WF-P9-RETRY
title: Retry 数据流完善 — 用例与失败测试
phase: P9
status: red (Step 1)
date: 2026-06-11
authority: docs/prd.md §20, docs/mvp-contracts.md §2.3, §2.6, docs/architecture.md §7.3
tech-debt-cleared: TD-P8-006, TD-P8-007, TD-P8-008
spec-source:
  - docs/phases/p9-agent-report-retry/02-development-plan.md §3 WF-P9-RETRY
  - src/engine/routing.ts (P8 baseline)
  - src/workflow/index.ts (P8 baseline)
  - src/run/index.ts (P8 baseline)
  - src/expression/index.ts (P5 baseline)
---

# WF-P9-RETRY — 用例与失败测试

## 0. 目的

WF-P9-RETRY 关闭 P8 在 retry 路径上遗留的三项技术债，并补齐 retry 数据流，使核心
用户场景 "review rejected → retry implement (携带 review_comments 作为 retry_inputs)"
能在引擎层端到端流动。本文档列出本工作流必须实现的功能点、规范条款覆盖矩阵、
全部用例以及 red-phase 失败测试清单。Step 2 (green) 必须使本文档列出的所有
T-RETRY-* 测试通过且不破坏 P8 既有的 T-SIGNALS-* 测试。

## 1. 功能点清单

本工作流交付如下功能点（FP）。每条功能点既是设计约束，也是 Step 2 的实现清单。

| 编号               | 功能点                                                                                       | 来源        | 影响文件                                |
| ------------------ | -------------------------------------------------------------------------------------------- | ----------- | --------------------------------------- |
| FP-RETRY-WITH-1    | `RouterAction.retry_job` 变体新增可选 `retry_with?: Record<string, string>` 字段             | TD-P8-008   | `src/workflow/index.ts`                 |
| FP-RETRY-WITH-2    | Workflow schema 接受并保留 `cases.<name>.retry_with` 子字段                                  | TD-P8-008   | `src/workflow/index.ts`                 |
| FP-RETRY-INPUTS-1  | `JobState` 新增 `retry_inputs?: Record<string, string>` 字段                                 | TD-P8-008   | `src/run/index.ts`                      |
| FP-RETRY-INPUTS-2  | `applyRoutingAction` 在执行 retry_job 且 `retry_with` 存在时，将其写入目标 job 的 `retry_inputs` | TD-P8-008   | `src/engine/routing.ts`                 |
| FP-RETRY-INPUTS-3  | 同一 job 二次 retry 时，`retry_inputs` 整体替换为新 payload，不与旧 payload 合并             | TD-P8-008   | `src/engine/routing.ts`                 |
| FP-ON-EXCEEDED-1   | 超出 `max_attempts` 时，读取 `workflow.jobs[targetJobId].retry.on_exceeded.status`           | TD-P8-007   | `src/engine/routing.ts`                 |
| FP-ON-EXCEEDED-2   | `on_exceeded` 缺省或 `status` 未声明时，默认进入 `blocked`（向后兼容）                       | TD-P8-007   | `src/engine/routing.ts`                 |
| FP-ON-EXCEEDED-3   | 只接受 `status ∈ { "blocked", "failed" }`；其他值视同未声明                                  | TD-P8-007   | `src/engine/routing.ts`                 |
| FP-EXPR-RETRY-1    | `ExpressionContext` 新增可选字段 `retry?: { inputs: Record<string, string> }`                | New (P9)    | `src/expression/index.ts`               |
| FP-EXPR-RETRY-2    | `resolveExpression` 支持 `${{ retry.inputs.<key> }}`；命中即替换                             | New (P9)    | `src/expression/index.ts`               |
| FP-EXPR-RETRY-3    | `${{ retry.inputs.<key> }}` 在 ctx 缺失 retry/缺失 key 时 passthrough 原始 token             | New (P9)    | `src/expression/index.ts`               |
| FP-ACTIVATE-IDEM-1 | `applyRoutingAction` 对已激活/已 ready/已 running 的目标 job 执行 `activate_job` 时幂等无报错 | TD-P8-006   | `src/engine/routing.ts`（P8 已实现，本工作流补测试） |

## 2. 规范强制条款矩阵（docs/mvp-contracts.md §2.3 Run State Contract）

下表逐条列出与本工作流相关的 MUST 条款及实现状态。"已纳入"指本工作流的 Step 2
将提供实现并由测试守护；"计划外"指明确不在 P9 范围内的项目，会作为遗留技术债登记。

| 条款                                                                                          | 来源              | 状态        | 落点                                              |
| --------------------------------------------------------------------------------------------- | ----------------- | ----------- | ------------------------------------------------- |
| `state.jobs.<id>` 包含 retry 相关字段 `retry_reason` 和 `retry_inputs`                        | §2.3 列表第 8 项  | 已纳入      | FP-RETRY-INPUTS-1, FP-RETRY-INPUTS-2              |
| `state.jobs.<id>` 包含 `outputs`                                                              | §2.3 列表第 7 项  | 计划外      | 转交 WF-P9-ACCEPT（AD-P9-003）                    |
| optional job 包含 `activated` 和 `activation_reason`                                          | §2.3 列表第 7 项  | 已在 P8 实现 | 本工作流 T-RETRY-6 验证 P8 幂等行为               |
| `state.json` 只能由 Engine 通过 State Store 写入                                              | §2.3 约束 1       | 已在 P3 实现 | `LocalStateStore.writeSnapshot`                   |
| 写入顺序为 append event 后原子替换 state snapshot                                             | §2.3 约束 2       | 已在 P8 实现 | `applyRoutingAction` 保持原顺序，本工作流不变更   |
| `state.last_event_id` 必须与 event log 尾部一致                                               | §2.3 约束 3       | 已在 P8 实现 | T-RETRY-1/2/3/8 末尾断言 `snap.last_event_id` 与 tail 一致 |
| state 损坏或 event/state 不一致时，CLI 不得继续推进 run                                       | §2.3 约束 4       | 已在 P4 实现 | 本工作流不变更                                    |
| retry 不得覆盖历史 attempt artifact                                                           | §2.5 约束 3       | 计划外      | Artifact 隔离由 P11 阶段负责                      |

技术债登记：本工作流不改动 `state.jobs.<id>.outputs`；该字段在 WF-P9-ACCEPT 实现。

## 3. 用例

每个用例对应一个或多个 T-RETRY-* 测试。"设置 / 触发 / 断言" 是 vitest 测试结构
的语义化映射。

### UC-RETRY-1 — `retry_with` 数据写入 `retry_inputs`

- **设置**：workflow 中 `implement` job 配置 `retry: { max_attempts: 3 }`；初始
  state 中 `implement` 处于 `running`，`attempt = 1`，`current_step = static-check`。
- **触发**：以源 job `implement` 调用 `applyRoutingAction({ action: { retry_job: "implement", retry_with: { review_comments: "too few tests" } }, ... })`。
- **断言**：写盘后 `state.jobs["implement"].retry_inputs` 严格等于
  `{ review_comments: "too few tests" }`；`attempt = 2`；`status = "ready"`；
  events.jsonl 末尾为 `job_retrying`；`snap.last_event_id` 指向该 tail。

覆盖：FP-RETRY-WITH-1, FP-RETRY-INPUTS-1, FP-RETRY-INPUTS-2 → T-RETRY-1。

### UC-RETRY-2 — `on_exceeded.status = "failed"` 超出后进入 `failed`

- **设置**：workflow 中 `implement` job 配置 `retry: { max_attempts: 2, on_exceeded: { status: "failed" } }`；
  state 中 `implement` 处于 `running`，`attempt = 2`（即下一次为 3，超出）。
- **触发**：以源 job `implement` 调用 `applyRoutingAction({ action: { retry_job: "implement" }, ... })`。
- **断言**：写盘后 `state.jobs["implement"].status === "failed"`（而非
  `"blocked"`）；events.jsonl 中 `job_retrying` 计数为 0；`attempt` 不变；
  `snap.last_event_id` 仅指向 `signal_received`。

覆盖：FP-ON-EXCEEDED-1 → T-RETRY-2。

### UC-RETRY-3 — `on_exceeded` 未声明时默认进入 `blocked`（向后兼容）

- **设置**：workflow 中 `implement` job 配置 `retry: { max_attempts: 1 }`，不
  声明 `on_exceeded`；state 中 `implement` 处于 `running`，`attempt = 1`。
- **触发**：调用 `applyRoutingAction({ action: { retry_job: "implement" }, ... })`。
- **断言**：`state.jobs["implement"].status === "blocked"`；`attempt = 1`；无
  `job_retrying`。

覆盖：FP-ON-EXCEEDED-2 → T-RETRY-3。该用例与 P8 既有 T-SIGNALS-7/8 行为一致，
P9 实现必须保持向后兼容。

### UC-RETRY-4 — `${{ retry.inputs.<key> }}` 解析

- **设置**：构造 `ctx = { inputs: {}, run: { id: "r1", workflow: "w" }, retry: { inputs: { review_comments: "fix edge cases" } } }`。
- **触发**：`resolveExpression("${{ retry.inputs.review_comments }}", ctx)`。
- **断言**：返回 `"fix edge cases"`。

覆盖：FP-EXPR-RETRY-1, FP-EXPR-RETRY-2 → T-RETRY-4。

### UC-RETRY-5 — `${{ retry.inputs.<missing> }}` passthrough

- **设置**：`ctx.retry.inputs` 不含 `review_comments`，或 `ctx.retry` 整体缺失。
- **触发**：`resolveExpression("${{ retry.inputs.review_comments }}", ctx)`。
- **断言**：返回原始 token `"${{ retry.inputs.review_comments }}"`，不抛错。

覆盖：FP-EXPR-RETRY-3 → T-RETRY-5。

### UC-RETRY-6 — `activate_job` 幂等

- **设置**：workflow 中 `architecture-design` 为 `activation: optional`；先把
  state 中该 job 手动改为 `waiting`（模拟已被激活但 needs 未满足）。
- **触发**：再次以源 job `review` 调用 `applyRoutingAction({ action: { activate_job: "architecture-design" }, ... })`。
- **断言**：调用不抛错；events.jsonl 中 `job_activated` 计数仍为 0（仅 `signal_received` 追加）；
  `architecture-design.status` 保持 `waiting`；`snap.last_event_id` 指向新写入的 `signal_received`。

覆盖：FP-ACTIVATE-IDEM-1 → T-RETRY-6。该用例显式登记 TD-P8-006 测试覆盖。

### UC-RETRY-7 — `retry_with` 通过 workflow schema 解析

- **设置**：YAML 字符串声明 router step：
  ```yaml
  cases:
    rejected:
      retry_job: implement
      retry_with:
        review_comments: "${{ inputs.comments }}"
  ```
- **触发**：`loadWorkflow(yamlText)`。
- **断言**：`wf.jobs["review"].steps[0].cases!["rejected"]` 含 `retry_with` 字段，
  并且其值为 `{ review_comments: "${{ inputs.comments }}" }`。

覆盖：FP-RETRY-WITH-1, FP-RETRY-WITH-2 → T-RETRY-7。

### UC-RETRY-8 — 第二次 retry 时 `retry_inputs` 整体替换

- **设置**：workflow 中 `implement` job 配置 `retry: { max_attempts: 5 }`；初
  始 state 中 `implement` 处于 `running`，`attempt = 1`。
- **触发**：
  1. 第一次：`applyRoutingAction({ action: { retry_job: "implement", retry_with: { a: "1" } }, ... })`，
     断言写盘后 `retry_inputs = { a: "1" }`，`attempt = 2`。
  2. 把 state 改回 `running`，`attempt = 2`，然后第二次调用：
     `applyRoutingAction({ action: { retry_job: "implement", retry_with: { a: "2", b: "3" } }, ... })`。
- **断言**：写盘后 `retry_inputs = { a: "2", b: "3" }`（不残留旧 key、不与旧 payload 合并）；
  `attempt = 3`。

覆盖：FP-RETRY-INPUTS-3 → T-RETRY-8。

## 4. 失败测试清单（red-phase）

测试文件：`tests/engine/retry.test.ts`。Step 1 完成时所有测试必须因功能未实现
而失败（非语法/导入错误）。Step 2 完成后全部通过。

| 测试编号  | 覆盖用例    | 覆盖 FP                                              | 失败原因（red）                                                     |
| --------- | ----------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| T-RETRY-1 | UC-RETRY-1  | FP-RETRY-INPUTS-1/2, FP-RETRY-WITH-1                 | `applyRoutingAction` 当前未读取 `retry_with`，不写 `retry_inputs`   |
| T-RETRY-2 | UC-RETRY-2  | FP-ON-EXCEEDED-1                                     | 当前实现硬编码 `status: "blocked"`，不读 `on_exceeded.status`       |
| T-RETRY-3 | UC-RETRY-3  | FP-ON-EXCEEDED-2                                     | 行为已正确，但通过本测试守护向后兼容                                |
| T-RETRY-4 | UC-RETRY-4  | FP-EXPR-RETRY-1/2                                    | `ExpressionContext` 当前无 `retry` 字段；`resolveExpression` 不识别 |
| T-RETRY-5 | UC-RETRY-5  | FP-EXPR-RETRY-3                                      | 同上                                                                |
| T-RETRY-6 | UC-RETRY-6  | FP-ACTIVATE-IDEM-1                                   | P8 已实现幂等，但缺失测试；此测试登记覆盖（应直接通过或在 green 中补丁） |
| T-RETRY-7 | UC-RETRY-7  | FP-RETRY-WITH-1/2                                    | Zod schema 当前 `RouterActionObjectSchema.retry_job` 无 `retry_with` 字段，会被 strict union 拒绝或剥离 |
| T-RETRY-8 | UC-RETRY-8  | FP-RETRY-INPUTS-3                                    | 同 T-RETRY-1，且二次写入需要保证整体替换                            |

T-RETRY-6 特别说明：P8 `applyRoutingAction` 中 `activate_job` 已对非 `inactive`
状态走幂等分支（routing.ts L318-326）。本测试是为 TD-P8-006 补充缺失的回归覆盖，
red 阶段如确实直接通过亦可接受，但仍需作为本工作流交付物的一部分。

## 5. 不在范围内

- WF-P9-ACCEPT 的 `acceptAgentReport`、`next` 命令、`agent_report_accepted` 事件
- WF-P9-SCHEMA 的 prompt 渲染
- Retry artifact 目录隔离（属于 P11）
- `JobState.outputs`（属于 WF-P9-ACCEPT）
- Signal `allowed_from` 校验（属于 WF-P9-ACCEPT）

## 6. 验收标准

- T-RETRY-1 至 T-RETRY-8 全部通过。
- 既有 `tests/engine/signals.test.ts` 中 T-SIGNALS-1 至 T-SIGNALS-13 仍全部通过
  （向后兼容）。
- `npm test -- tests/engine/` 全绿。
- **用户可完成里程碑**：用户可在 review job 的 router step 中声明
  `cases: { rejected: { retry_job: implement, retry_with: { review_comments: "${{ inputs.comments }}" } } }`；
  当 review 触发 rejected 时，引擎将 `review_comments` 写入
  `state.jobs.implement.retry_inputs`，并把 `implement` 重置到 `ready` 状态以
  待 `next` 命令推进。Agent 在下一轮 attempt 启动时（WF-P9-ACCEPT/WF-P9-SCHEMA
  完成后），prompt 中通过 `${{ retry.inputs.review_comments }}` 即可读到上一轮
  review 的反馈意见。

## 7. 风险

- **R-1**：`retry_with` 取值类型若被实现者放宽为 `Record<string, unknown>`，会
  破坏 `retry_inputs` 与 `ExpressionContext.retry.inputs: Record<string, string>`
  的类型契约。Step 2 必须保持值为 `string`。
- **R-2**：`on_exceeded` 是 `retry` 子对象，当前 zod schema 把 `retry` 当作
  `z.record(z.string(), z.unknown())`，未结构化。Step 2 在 routing.ts 读取时
  需要做形状守卫（typeof 检查），避免类型断言污染。
- **R-3**：T-RETRY-6 的 setup 直接修改 state.json 把 `architecture-design`
  改为 `waiting` —— 这模拟"上一次 activate 已生效"。如果未来 `JobState` 引入
  `activated` 必填，本测试需要同步设置 `activated: true`。

