# 运行生命周期

## 概述

一次"运行（Run）"是工作流的一次具体执行实例。Engine 维护运行的完整状态，所有变更都记录在不可变事件日志中。

---

## 运行状态

```
running ──► completed
        ──► failed
        ──► blocked
        ──► cancelled
```

| 状态 | 说明 |
|------|------|
| `running` | 运行进行中，至少有一个 Job 处于 pending/ready/running 状态 |
| `completed` | 所有必需 Job 均已完成 |
| `failed` | 至少一个 Job 失败且重试次数耗尽 |
| `blocked` | 运行被 Human Gate 或 Router `block` 动作暂停 |
| `cancelled` | 用户执行 `abort` 命令取消 |

---

## Job 状态机

```
pending ──► ready ──► running ──► completed
                              ──► failed
                              ──► blocked
                              ──► cancelled
```

| 状态 | 含义 |
|------|------|
| `pending` | 前置依赖尚未全部完成 |
| `ready` | 所有依赖完成，可以开始执行 |
| `running` | 当前正在执行 |
| `completed` | 所有步骤成功完成 |
| `failed` | 步骤失败且超出最大重试次数 |
| `blocked` | Human Gate 等待中或 Router `block` 动作 |
| `cancelled` | 运行被中止 |

可选 Job（`optional: true`）初始处于 `pending` 状态，只有收到对应激活信号后才变为 `ready`。

---

## Step 执行流程

### Agent Step 手动模式

```
Job 就绪
  ↓
zigma-flow prompt --job <id>
  → Engine 生成 prompt.md
  → 打印提示内容和 report.json 路径
  ↓
用户将提示粘贴到 Agent（Claude Code 等）
Agent 执行工作，将结果写入 report.json
  ↓
zigma-flow next --job <id>
  → Engine 读取并验证 report.json
  → 应用 context_patches（变量/上下文块）
  → 处理 status 返回（on_return 动作）
  → 处理 signals
  → 推进到下一 Step 或完成 Job
```

### Agent Step 自动模式（run-all）

```
Job 就绪
  ↓
Engine 生成 prompt.md
  ↓
Engine 调用 Agent 后端（如 claude -p <prompt>）
  → 记录 agent_invoked 事件
  → 等待后端返回（最多 timeout 毫秒）
  → 记录 agent_completed 或 agent_timed_out 事件
  ↓
Engine 读取 report.json（后端写入）
  → 应用 context_patches
  → 处理 status/signals
  → 推进或重试
```

### Script Step

```
zigma-flow step --job <id>
  → Engine 找到当前 Script Step
  → 执行 run 命令（带 cwd/env/timeout）
  → 将 stdout/stderr 注册为 Artifact
  → 命令退出码 0 → Step 完成
  → 命令退出码非 0 → Job 失败
```

### Check Step

```
zigma-flow step --job <id>
  → Engine 按顺序执行每个 Check
  → 全部通过 → Step 完成
  → 任一失败 → 记录失败原因，Job 失败
```

### Router Step

```
zigma-flow step --job <id>
  → Engine 按顺序评估每个 route 的 if 条件
  → 第一个满足条件的 route → 执行 action
  → 无满足条件的 route 且无默认分支 → Job 失败
```

---

## 重试机制

当 Job 失败时，Engine 根据 `retry.max_attempts` 决定是否重试：

```
Job 失败（attempt N）
  ↓
N < max_attempts ?
  是 → 创建新 Attempt（N+1），清空 step_visits，Job 恢复 running
  否 → Job 进入 failed 终止状态
```

信号触发的重试（`retry_job`）也遵循同样的计数规则。

每次 Attempt 的数据独立存储：
```
.zigma-flow/runs/<run-id>/jobs/<job-id>/attempts/
  1/steps/<step-id>/
  2/steps/<step-id>/
  ...
```

---

## 条件步骤与有界循环

### 条件步骤（if）

```yaml
- id: revise
  type: agent
  if: "${{ variables.review_status == 'needs_revision' }}"
  ...
```

`if` 表达式为 `false` 时，Step 被跳过，Engine 记录 `step_skipped` 事件并移至下一步。

### 有界循环（goto_step + max_visits）

```yaml
- id: write-code
  type: agent
  max_visits: 3         # 同一步骤最多访问 3 次（默认 3）
  ...

- id: check-quality
  type: router
  routes:
    - if: "${{ variables.quality == 'ok' }}"
      action: continue
    - action: goto_step
      target: write-code
```

当 `goto_step` 指向已访问次数达到 `max_visits` 的步骤时，Engine 记录 `step_visit_exceeded` 事件，Job 失败。

---

## 信号处理顺序

`zigma-flow next` 处理 Agent 报告时，信号按以下顺序处理：

1. 验证信号名称是否在 `allowed_signals` 中声明
2. 验证信号是否在工作流 `signals` 中声明
3. 验证发出信号的 Job 是否在 `allowed_from` 中
4. 按顺序执行每个信号的 `action`
5. 同一批信号中冲突的动作（如同时 `retry_job` 和 `activate_job`）按声明顺序处理

---

## 状态快照与事件日志

运行状态以两种形式持久化：

| 文件 | 用途 |
|------|------|
| `state.json` | 当前快照（可直接读取） |
| `events.jsonl` | 不可变事件日志（用于审计和调试） |

Engine 每次状态变更时：
1. 追加事件到 `events.jsonl`（含自增序列号和时间戳）
2. 更新 `state.json` 快照

并发写入（多个 read-only Job 同时完成时）通过 AsyncQueue 串行化，保证 `state.json` 的原子性写入。

---

## 终止状态

运行进入以下状态后不再自动推进：

- `completed` — 工作流正常完成
- `failed` — Job 失败且重试耗尽，需人工介入（`retry` 或 `abort`）
- `blocked` — Human Gate 等待批准，或 Router 执行了 `block` 动作
- `cancelled` — 用户中止

`blocked` 状态下可通过 `approve`/`reject` 解除阻塞；`failed` 状态下可通过 `retry --job` 手动重试。
