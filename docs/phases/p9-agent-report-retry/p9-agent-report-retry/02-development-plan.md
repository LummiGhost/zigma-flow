---
phase: p9
title: Agent Report Acceptance, Retry Inputs, and Attempts
status: frozen
date: 2026-06-11
authority: docs/prd.md §20 (阶段9), docs/mvp-contracts.md §2.3, §2.6
tech-debt-resolved: TD-P8-002, TD-P8-006, TD-P8-007, TD-P8-008, TD-P5-003
---

# P9 阶段开发计划

## 1. 阶段目标

P9 完成 Agent 执行循环的最后一公里：实现 `acceptAgentReport` 引擎函数和 `next` CLI 命令，让 Agent 提交的 report.json 可以被引擎读取、验证、处理 signals 并推进工作流。同时完善 retry 数据流（retry_inputs、on_exceeded.status）和 Prompt 中的 report schema 渲染。

**PRD 对应：**§20 "阶段9：Retry Job 与 Attempts"  
**核心用户场景：** review rejected → retry implement (携带 review_comments 作为 retry_inputs)

## 2. 前置条件（已满足）

- P8 完成（PR #16 merged, main CI pass, 302 tests）
- `applyRoutingAction` 存在并处理 `retry_job`/`activate_job`/`goto_job`
- `advanceJob` 存在，多步骤推进已验证
- `src/expression/index.ts` 存在，支持 `${{ inputs.* }}` 和 `${{ run.* }}`

## 3. P9 工作流拆分

### WF-P9-RETRY：Retry 数据流完善

**目标：** 完成 retry 数据流三件事：
1. `RouterAction` 增加 `retry_with` 可选字段（schema + type）
2. `applyRoutingAction` 存储 `retry_inputs` 到 `JobState`
3. `on_exceeded.status` 读 workflow retry config，而非硬编码 `blocked`
4. `ExpressionContext` 增加 `retry.inputs.*` 支持
5. TD-P8-006：为 `activate_job` 幂等性补充测试覆盖

**边界：** 只修改 routing.ts、workflow/index.ts（schema+type）、run/index.ts（JobState）、expression/index.ts。不触碰 CLI 命令和 acceptAgentReport。

**验收标准：**
- `retry_with` 字段通过 workflow schema 验证
- `applyRoutingAction` 在 retry_job 时将 `retry_with` 数据写入 `state.jobs[targetJobId].retry_inputs`
- `on_exceeded` 超出时读 `retry.on_exceeded.status`（默认 `blocked`）
- `resolveExpression("${{ retry.inputs.comments }}", ctx)` 能解析 retry inputs
- T-RETRY-* 测试全部通过，activate_job 幂等性有显式测试

### WF-P9-ACCEPT：Agent Report Acceptance + `next` 命令

**目标：** 实现 `acceptAgentReport` 引擎函数和 `next` CLI 命令：
1. 定位 report.json artifact 路径（`jobs/<jobId>/attempts/<n>/steps/<stepId>/report.json`）
2. 读取并验证 Agent Report schema（outputs, artifacts, signals, summary）
3. 存储 job outputs 到 `JobState.outputs`
4. 处理 signals：验证 type 已声明、验证 `allowed_from` 包含当前 job → 调用 `applyRoutingAction`
5. 无 signals：追加 `agent_report_accepted` 事件，调用 `advanceJob`
6. `next --job <job-id>` CLI 命令

**边界：** 新增 `src/engine/accept.ts`（acceptAgentReport），新增 `src/commands/next.ts`，扩展 `WorkflowDefinition.signals` 类型（增加 allowed_from/action 结构化 schema），为 `JobState` 添加 `outputs` 字段。

**验收标准：**
- T-ACCEPT-* 测试全部通过
- `next --job plan` 在真实临时 run 目录中能正确接受 report.json 并推进状态
- 未声明 signal → `ValidationError`，不在 allowed_from 的 signal → `WorkflowError`
- 无 signal → `agent_report_accepted` 事件 + job 推进
- 有 signal → 转给 `applyRoutingAction`

### WF-P9-SCHEMA：Report Schema in Prompt（TD-P5-003）

**目标：** 在 Agent Step prompt 中渲染 report schema 段落，告知 Agent report.json 的必填字段和 outputs 结构。

**边界：** 只修改 `src/prompt/` 和 `src/context/` 的渲染逻辑，不新增模块。

**验收标准：**
- prompt snapshot 测试中包含 report schema 段落
- 渲染内容包含 outputs 字段名称、signals 列表（来自 step expose 配置）、summary 字段

## 4. 工作流依赖关系

```text
WF-P9-RETRY  ──────────────────────────────┐
WF-P9-SCHEMA ────────────────────────────── ── PR #17
                                             │
WF-P9-ACCEPT (依赖 RETRY 的 retry_inputs)── PR #18
```

WF-P9-RETRY 和 WF-P9-SCHEMA 可并行开发，并入同一 PR #17。  
WF-P9-ACCEPT 在 PR #17 merge 后开发，开 PR #18。

## 5. 架构决策

**AD-P9-001: acceptAgentReport 位于 src/engine/accept.ts**  
理由：与 applyRoutingAction 在 routing.ts 的模式一致；独立文件避免 engine/index.ts 过大。

**AD-P9-002: WorkflowDefinition.signals 增加结构化 schema**  
目前 `signals?: Record<string, unknown>`。P9 需要读取 `allowed_from` 和 `action`，因此为 signal 声明定义 `SignalDeclaration` 类型和 zod schema。  
旧行为（passthrough 未知字段）仍保留以保持向前兼容。

**AD-P9-003: JobState.outputs 为 Record<string, string | undefined>**  
outputs 在 acceptAgentReport 时从 report.json 中提取 string 值写入。非 string 值暂时序列化为 JSON string。

**AD-P9-004: on_exceeded 默认 blocked**  
当 `retry.on_exceeded.status` 字段不存在时，默认行为维持 `blocked`（向后兼容 P8 测试）。

## 6. 技术债清偿映射

| 技术债 | 在哪个工作流清偿 |
|--------|----------------|
| TD-P8-002 | WF-P9-ACCEPT |
| TD-P8-006 | WF-P9-RETRY (activate_job 幂等性测试) |
| TD-P8-007 | WF-P9-RETRY (on_exceeded.status) |
| TD-P8-008 | WF-P9-RETRY (retry_with + retry_inputs) |
| TD-P5-003 | WF-P9-SCHEMA |

## 7. 技术债登记（遗留至 P10）

| 技术债 ID | 描述 | 来源 |
|-----------|------|------|
| TD-P9-001 | `${{ jobs.<id>.outputs.<key> }}` 表达式解析 | P9 只实现 retry.inputs.* 插值，jobs.outputs 仍 passthrough |
| TD-P9-002 | `steps.<id>.outputs.<key>` 表达式 | 同上 |
| TD-P8-001 | Router expression language (复杂条件) | 延续 |
| TD-P8-003 | Skill Pack `uses:` router resolution | 延续 |

## 8. 质量门禁

`pnpm typecheck && pnpm lint && pnpm test:ci`  
每条工作流 Step 2 完成后，subagent 必须先通过此门禁再提交实现报告。

## 9. 测试文件规划

| 工作流 | 新测试文件 |
|--------|-----------|
| WF-P9-RETRY | `tests/engine/retry.test.ts` |
| WF-P9-ACCEPT | `tests/engine/accept.test.ts` |
| WF-P9-SCHEMA | `tests/prompt/report-schema.test.ts` |

## 10. PR 结构

- **PR #17**：WF-P9-RETRY + WF-P9-SCHEMA，branch `feature/p9-retry-schema`
- **PR #18**：WF-P9-ACCEPT，branch `feature/p9-accept`
