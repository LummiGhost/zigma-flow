---
phase: p11
title: Expression Language — Job & Step Output References
status: frozen
date: 2026-06-12
authority: docs/prd.md §13 (最小上下文表达式清单)
tech-debt-resolved: TD-P9-001, TD-P9-002
new-tech-debt: TD-P11-001
---

# P11 阶段开发计划

## 1. 阶段目标

P11 完成 PRD §13 规定的最小上下文表达式清单中尚未实现的两类引用：

- `${{ jobs.<id>.outputs.<key> }}`（TD-P9-001）
- `${{ steps.<id>.outputs.<key> }}`（TD-P9-002）

完成后，code-change workflow YAML 将更新为使用 job output 表达式传递跨 job 数据，替代 P10 中的 artifact 文件绕道方案，与 PRD §13 架构示例对齐。

**PRD 对应：** §13 "类型系统与表达式" — 最小上下文表达式清单

**核心验收标准：**

- `${{ jobs.<id>.outputs.<key> }}` 在 step.with 中被正确解析为对应 job 的 outputs 字段值。
- `${{ steps.<id>.outputs.<key> }}` 在 step.with 中被正确解析为同 job 内前序 step 的 outputs 字段值。
- 引用不存在的 job/step/key 时，表达式保持原文不替换（与现有 inputs.* 行为一致）。
- code-change workflow YAML 更新为使用 `${{ jobs.* }}` 表达式，dogfood 测试全部通过。
- 全部现有测试（348 个）继续通过。

## 2. 前置条件（已满足）

- P10 完成（PR #19–#21 merged，main CI pass，348 tests）。
- `src/expression/index.ts` — 已有 `resolveExpression` 和 `ExpressionContext` 基础结构。
- `src/run/index.ts` — `JobState.outputs` 已存在（`Record<string, unknown>`）。
- `src/engine/accept.ts` — `acceptAgentReport` 已将 report.outputs 存入 `state.jobs[jobId].outputs`。
- `src/context/index.ts` — 已有 `resolveExpression` 调用点。

## 3. 架构决策

### AD-P11-001: step_outputs 存储位置

**问题：** `${{ steps.<id>.outputs.<key> }}` 需要同 job 内前序 step 的 outputs 数据，但目前 JobState 只有 job 级别的 `outputs` 字段，没有 per-step outputs 存储。

**决策：** 在 `JobState` 增加可选字段 `step_outputs?: Record<string, Record<string, unknown>>`，key 为 stepId，value 为该 step 的 outputs。

**写入时机：**
- Agent step 完成（`acceptAgentReport` 无信号路径）时：将 `report.outputs` 写入 `step_outputs[stepId]`（与当前 job-level `outputs` 写入同时进行）。
- Script step / Check step：当前无 "outputs" 概念，暂不写入 step_outputs（对应 step 引用的值为 undefined，保持原文不替换）。

**前置设计约束：**
- Engine 是唯一状态写入者，step_outputs 只由 Engine 写入。
- step_outputs 为可选字段，不影响已有 state.json 的读取（向后兼容）。

### AD-P11-002: ExpressionContext 扩展

**扩展形式：**
```typescript
export interface ExpressionContext {
  inputs: Record<string, string>;
  run: { id: string; workflow: string };
  retry?: { inputs: Record<string, string> };
  jobs?: Record<string, { outputs: Record<string, unknown> }>;
  steps?: Record<string, { outputs: Record<string, unknown> }>;
}
```

`jobs` 由 context builder 从 `state.jobs` 构造（只传 outputs 字段，不暴露 status 等内部字段）。

`steps` 由 context builder 从当前 job 的 `step_outputs` 构造。

### AD-P11-003: 表达式解析行为

与现有 `inputs.*` 行为保持一致：

- 引用的 job 不存在：保持原文 `${{ jobs.X.outputs.Y }}`。
- 引用的 key 不存在：保持原文。
- 引用的 job 存在但 outputs 为空对象 `{}`：保持原文（key 不存在）。
- 引用的 value 为 `null`：替换为字符串 `"null"`（与 `String(null)` 一致）。
- 引用的 value 为 object/array：替换为 `JSON.stringify(value)`。

### AD-P11-004: code-change workflow 更新范围

只更新 `src/init/templates.ts` 中 `codeChangeWorkflowYml()` 函数，将跨 job 的 `with:` 参数从 artifact-workaround 模式改为 `${{ jobs.<id>.outputs.<key> }}` 模式。

dogfood 测试 `tests/dogfood/code-change.test.ts` 需要同步更新，确保在运行 `acceptAgentReport` 之前，每个 agent step 的 report.json 中写入对应 outputs，让后续 job 的 with 表达式能被正确解析。

## 4. 技术债登记

### 登记：TD-P11-001（新增）

**描述：** `${{ signals.<name>.reason }}` 表达式（PRD §13 最小上下文清单第 7 项）未实现。

**原因：** signals 在当前设计中是瞬态的（acceptAgentReport 处理后不持久化到 state.jobs 以外），没有 `state.signals` 字段可供查询。实现该表达式需要先设计 signals 持久化方案，不在 P11 范围内。

**规范条款：** PRD §13 最小上下文清单第 7 项。

**清偿期限：** P12 或 signals 持久化专项任务时处理。

## 5. 工作流拆分

### WF-P11-EXPR：表达式解析增强

**目标：** 实现 `${{ jobs.<id>.outputs.<key> }}` 和 `${{ steps.<id>.outputs.<key> }}` 的解析。

**变更边界：**
- `src/expression/index.ts` — ExpressionContext 扩展、resolveExpression 新增两个 handler
- `src/run/index.ts` — JobState.step_outputs 字段添加
- `src/engine/accept.ts` — acceptAgentReport 写入 step_outputs
- `src/context/index.ts` — exprCtx 构造时传入 jobs 和 steps 数据

**新增测试文件：** `tests/expression/expression.test.ts`（新建）

**修改测试文件：** `tests/engine/accept.test.ts`（追加 step_outputs 相关用例）

**验收标准：**
- `resolveExpression("${{ jobs.plan.outputs.summary }}", ctx)` → 返回 ctx.jobs.plan.outputs.summary 的字符串化值。
- `resolveExpression("${{ steps.intake-agent.outputs.result }}", ctx)` → 返回对应 step outputs 值。
- 不存在的引用 → 保持原文。
- acceptAgentReport（无信号路径）后，state.jobs[jobId].step_outputs[stepId] 存在且等于 report.outputs。
- 现有 accept 测试全部通过（T-ACCEPT-1..15）。

### WF-P11-WORKFLOW-UPDATE：更新 code-change workflow YAML

**目标：** 更新 `codeChangeWorkflowYml()` 中各 agent step 的 `with:` 字段，使用 `${{ jobs.<id>.outputs.<key> }}` 传递跨 job 数据。

**依赖：** WF-P11-EXPR 完成后才能进入此工作流。

**变更边界：**
- `src/init/templates.ts` — codeChangeWorkflowYml() 内各 step 的 with 字段
- `tests/dogfood/code-change.test.ts` — 更新 report.json outputs，确保 with 表达式可被解析

**验收标准：**
- 生成的 workflow YAML 中 plan job 的 step 包含 `code_map: "${{ jobs.code-map.outputs.code_map }}"` 等引用。
- `zigma-flow validate` 对新 YAML 通过。
- dogfood 测试 TC-DOGFOOD-1..4 全部通过。

## 6. 工作流依赖关系

```
WF-P11-EXPR ──────────────────── PR #22（主干）
WF-P11-WORKFLOW-UPDATE ────────── 同 PR #22
```

两个工作流合入同一 PR，分别通过 Step 1/2/3 验收。

## 7. 质量门禁

`pnpm typecheck && pnpm lint && pnpm test`

每条工作流 Step 2 完成后必须通过此门禁再提交实现报告。

## 8. 测试文件规划

| 工作流 | 新增/修改测试文件 |
|--------|-----------------|
| WF-P11-EXPR | `tests/expression/expression.test.ts`（新建，覆盖新 handler） |
| WF-P11-EXPR | `tests/engine/accept.test.ts`（追加 step_outputs 用例 T-ACCEPT-16） |
| WF-P11-WORKFLOW-UPDATE | `tests/dogfood/code-change.test.ts`（更新 outputs 写入） |

## 9. PR 结构

- **PR #22**：WF-P11-EXPR + WF-P11-WORKFLOW-UPDATE，branch `feature/p11-expression-jobs-steps`

## 10. 残余风险

| 风险 | 影响 | 应对 |
|------|------|------|
| JobState.step_outputs 破坏已有 state.json 读取 | 已有 run 的 state.json 无该字段，读取时为 undefined | 字段为可选，isValidRunState 不强制检查，向后兼容 |
| 非字符串 outputs value 的 JSON.stringify 行为 | 大对象会膨胀 step.with | MVP 阶段接受；后续可引入 artifact ref 替代 |
| signals 表达式 TD-P11-001 | workflow YAML 写 `${{ signals.* }}` 时表达式不解析 | 表达式保持原文，不崩溃；在 TD-P11-001 登记中记录 |
