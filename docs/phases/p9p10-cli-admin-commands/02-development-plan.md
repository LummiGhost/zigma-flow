---
phase: p9p10-cli-admin-commands
title: CLI Admin Commands — retry, abort, list-runs, show
status: frozen
date: 2026-06-12
authority: docs/prd.md §17 (CLI 命令设计)
project-items: P9.3, P10.1, P10.2, P10.3
---

# P9.3 + P10 CLI Admin Commands 开发计划

## 1. 阶段目标

补齐 PRD §17 MVP 命令集中尚未实现的四条命令：

| 命令 | 项目条目 | 描述 |
|------|----------|------|
| `zigma-flow retry --job <id>` | P9.3.1 | 手动 retry 指定 job（传 reason + 可选 retry inputs） |
| `zigma-flow abort` | P10.1 | 取消当前 active run（状态转为 cancelled，不删除记录） |
| `zigma-flow list-runs` | P10.2 | 列出所有历史 run（run_id、workflow、status、created_at） |
| `zigma-flow show <run-id>` | P10.3 | 显示指定 run 的详细状态（jobs、attempts、recent events） |

**PRD 对应：** §17 "CLI 命令设计"；architecture.md §7.1 (`retryJob`/`abortRun`)、§7.2 state transitions

**核心验收标准：**

- `retry --job <id>` 触发 Engine retryJob，job 进入 retrying → ready，attempt++，写入 job_retrying event。
- `retry --job <id>` 在 job 状态不可 retry 时报 UserInputError，不改变状态。
- `abort` 将 active run 状态转为 cancelled，写 run_cancelled event，不删除 run 目录。
- `list-runs` 列出 `.zigma-flow/runs/*/` 下所有 run，每行显示 run_id、workflow、status、created_at。
- 单个损坏 run 不阻断 list-runs，标记为 unreadable。
- `show <run-id>` 显示 run 详细信息：jobs 状态、每 job attempt 数量、最近 5 条 event。
- 全部现有测试（348 个）继续通过。

## 2. 前置条件（已满足）

- P9.1-P9.2 完成（retry schema、attempt tracking、artifact directory isolation）。
- P10 PRD-equivalent 完成（code-change workflow、README、dogfood test）。
- Engine 接口已定义：`retryJob`（通过 applyRoutingAction/advanceJob 组合）和 `abortRun`（待实现）。
- `LocalStateStore` 可读写 `RunState`；`JsonlEventWriter` 可 append events。
- Active run 读取已在 `run/index.ts` 中实现（`readActiveRunId`）。

## 3. 架构决策

### AD-P9P10-001: retryJob — 复用现有 Engine 接口

**决策：** `retry --job` 命令直接调用现有的 Engine retry 路径：
1. 读取 state，找到 job，验证当前状态允许 retry（completed/failed/blocked）。
2. 调用 `applyRoutingAction` 以 `retry_job` action，或直接实现一个 `retryJob` engine 函数。
3. 由于现有的 retry 路径在 `routing.ts` 中已实现（作为 applyRoutingAction 的 retry_job case），可以直接重用。

**实现选择：** 新建 `src/engine/retryJob.ts`，提供 `retryJob(opts)` 函数（类似 `advanceJob` 的结构），在内部调用 `applyRoutingAction` with `retry_job` action + `advanceJob`。这样 CLI `retry.ts` 只调用 `retryJob`，保持 CLI 与 Engine 的分层。

**参数：**
- `--job <id>`: 必填，job id
- `--reason <text>`: 可选，retry 原因文本（默认 "Manual retry from CLI"）
- `--with <json>`: 可选，retry_inputs JSON 字符串

### AD-P9P10-002: abortRun — 新增 Engine 函数

**决策：** 新建 `src/engine/abort.ts`，提供 `abortRun(opts)` 函数：
1. 读取 state，验证 run status 为 running/blocked（非 completed/cancelled/failed）。
2. 将 run status 改为 "cancelled"，将所有 running/ready/waiting jobs 改为 "cancelled"（MVP 简化：只改 run 级别状态即可）。
3. 写入 `run_cancelled` event。
4. 原子写 snapshot。

**PRD 约束：** "abort 只改变 run 状态，不删除运行记录"（PRD §18）。

### AD-P9P10-003: list-runs — 读取 runs 目录

**决策：** 新建 `src/commands/list-runs.ts`，遍历 `.zigma-flow/runs/` 目录：
1. 对每个子目录，读取 `run.yml`（获取 task、created_at、workflow name）。
2. 读取 `state.json`（获取 run status）。
3. 汇总输出。
4. 单个损坏的子目录：catch error，标记为 `[unreadable]`，继续遍历。

### AD-P9P10-004: show — 读取特定 run 详情

**决策：** `show <run-id>` 命令：
1. 定位 run 目录：`.zigma-flow/runs/<run-id>/`。
2. 读取 `run.yml`、`state.json`。
3. 读取 `events.jsonl` 的最后 5 条 event。
4. 渲染：run 信息、每个 job（id、status、attempt）、recent events。

如果 `<run-id>` 省略：使用 active run id（与 `status` 命令行为一致）。

### AD-P9P10-005: 检查 `check --job` 命令

经过代码检查，PRD §17 列了 `zigma-flow check --job <job-id>` 和 `zigma-flow step --job <job-id>`。

当前实现只有 `step.ts`，它处理 script/check step。`check --job` 看起来是 `step --job` 的别名或专用变体。

**决策：** 在 CLI 中添加 `check` 命令作为 `step` 命令的别名，两者调用相同的 `stepAction`。

## 4. 工作流拆分

### WF-CLI-COMMANDS：四条命令的完整实现

**变更边界：**
- `src/engine/retryJob.ts`（新建）— engine retryJob 函数
- `src/engine/abort.ts`（新建）— engine abortRun 函数  
- `src/engine/index.ts`（修改）— 导出 retryJob, abortRun
- `src/commands/retry.ts`（新建）— retry 命令 action
- `src/commands/abort.ts`（新建）— abort 命令 action
- `src/commands/list-runs.ts`（新建）— list-runs 命令 action
- `src/commands/show.ts`（新建）— show 命令 action
- `src/commands/index.ts`（修改）— 导出新命令
- `src/cli.ts`（修改）— 注册四条新命令 + check 别名

**新增测试文件：**
- `tests/engine/retryJob.test.ts`
- `tests/engine/abort.test.ts`
- `tests/commands/list-runs.test.ts`
- `tests/commands/show.test.ts`

**修改测试文件：**
- `tests/cli/cli.test.ts`（追加命令注册验证）

## 5. 质量门禁

`pnpm typecheck && pnpm lint && pnpm test`

## 6. 测试文件规划

| 测试文件 | 新增用例 |
|---------|---------|
| `tests/engine/retryJob.test.ts` | T-RETRY-1..6（合法 retry、不可 retry 状态、max exceeded、inputs、event 写入） |
| `tests/engine/abort.test.ts` | T-ABORT-1..4（正常 abort、已完成 run abort 失败、event 写入、不删记录） |
| `tests/commands/list-runs.test.ts` | T-LISTRUN-1..4（多 run、空目录、损坏 run、状态显示） |
| `tests/commands/show.test.ts` | T-SHOW-1..3（show 指定 run-id、show active run、run 不存在错误） |

## 7. PR 结构

- **PR #22**：WF-CLI-COMMANDS，branch `feature/p9p10-cli-admin-commands`

## 8. 残余风险

| 风险 | 影响 | 应对 |
|------|------|------|
| retryJob 重用 applyRoutingAction 时 allowed_from/signal 路径不匹配 | 直接调用而非 signal 路径 | retryJob 直接操作状态，不走 signal path，避免 allowed_from 检查 |
| abort 时 jobs 状态是否需要逐个更新 | MVP 简化：只改 run.status 为 cancelled | 单元测试验证 state 读取时不会因 job status 不一致引发错误 |
| list-runs 在 runs 目录不存在时崩溃 | 空目录或首次使用 | 捕获 ENOENT，输出 "no runs found" |
