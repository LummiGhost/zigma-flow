# 高级特性

## 工作流变量（Variables）

工作流变量是在工作流 YAML 中声明的共享状态，允许跨 Job 传递结构化数据。

### 声明变量

```yaml
variables:
  review_status:
    description: "Code review result"
    default: "pending"
    allowed_writers: [review]        # 只有 review Job 可以修改此变量

  implementation_notes:
    description: "Notes from implementation step"
    allowed_writers: [implement]
```

### 在条件和 Router 中使用变量

```yaml
steps:
  - id: decide
    type: router
    routes:
      - if: "${{ variables.review_status == 'approved' }}"
        action: continue
      - if: "${{ variables.review_status == 'rejected' }}"
        action: retry_job
        target: implement
```

### Agent 修改变量

Agent 在 `report.json` 的 `context_patches` 中提交变量修改：

```json
{
  "context_patches": [
    {
      "kind": "variable",
      "key": "review_status",
      "value": "approved"
    }
  ]
}
```

Engine 校验：
- 变量必须在工作流中声明
- 当前 Job 必须在 `allowed_writers` 列表中
- 违反权限的修改会被拒绝并记录错误事件

---

## 上下文块（Context Blocks）

上下文块是版本化的 Markdown 内容，用于在 Agent 步骤间传递结构化信息（如当前计划、审阅注释）。

### 声明上下文块

```yaml
context_blocks:
  - key: current-plan
    description: "Current implementation plan"
    allowed_writers: [plan, implement]

  - key: reviewer-notes
    description: "Notes from review step"
    allowed_writers: [review]
```

### 工作原理

1. Agent 在 `context_patches` 中写入内容：
   ```json
   {
     "context_patches": [
       {
         "kind": "context_block",
         "key": "current-plan",
         "content": "# Implementation Plan\n\n1. Add null check..."
       }
     ]
   }
   ```

2. Engine 将内容保存为新版本 Artifact：
   - `v1.md`（首次写入）
   - `v2.md`（第二次写入）
   - 当前版本始终可通过 `current.md` 链接访问

3. 后续步骤的提示中自动注入当前版本内容，无需手动传递。

上下文块适合需要在多个步骤间"接力"的信息，例如计划文档在 `plan → implement → review` 过程中被逐步更新和引用。

---

## 条件步骤（Conditional Steps）

Step 的 `if` 字段允许根据变量值决定是否执行该步骤。

```yaml
steps:
  - id: generate-docs
    type: agent
    if: "${{ variables.needs_docs == 'true' }}"
    skill: code-change
    function: generate-docs

  - id: skip-docs-notice
    type: script
    if: "${{ variables.needs_docs == 'false' }}"
    run: "echo 'Documentation generation skipped'"
```

`if` 为 `false` 时 Engine 跳过该步骤，记录 `step_skipped` 事件，直接执行下一步。

**支持的表达式**：

```
${{ variables.<key> == 'value' }}          # 等于
${{ variables.<key> != 'value' }}          # 不等于
${{ variables.<key> == 'a' && ... == 'b' }} # 与
${{ variables.<key> == 'a' || ... == 'b' }} # 或
${{ !variables.<key> == 'value' }}         # 非
```

所有比较值必须是字符串字面量。

---

## 有界循环（Bounded Loops）

结合 `goto_step` 和 `max_visits` 可实现受控的迭代步骤。

```yaml
steps:
  - id: write-draft
    type: agent
    max_visits: 3                  # 最多迭代 3 次
    skill: writing
    function: draft
    allowed_signals: []

  - id: check-quality
    type: check
    checks:
      - kind: json-schema
        schema_path: ".../quality.schema.json"
        data_path: "..."

  - id: quality-gate
    type: router
    routes:
      - if: "${{ variables.quality == 'pass' }}"
        action: continue
      - action: goto_step
        target: write-draft        # 返回 write-draft 步骤
```

**循环终止保证**：
- 每次 `goto_step` 返回时，目标步骤的访问计数 +1
- 达到 `max_visits`（默认 3）后，Engine 记录 `step_visit_exceeded` 事件，Job 失败
- 防止无限循环

`goto_step` 只能在**同一 Job 内**跳转，不能跨 Job。

---

## 并发执行（Concurrent Execution）

`run-all` 命令支持并发执行多个 read-only Job，缩短执行时间。

### workspace.mode 控制

```yaml
jobs:
  - id: code-map
    workspace:
      mode: read-only    # 可与其他 read-only Job 并发
    ...

  - id: implement
    workspace:
      mode: writable     # 同一时刻只有一个 writable Job 运行
    ...
```

### 调度规则

```
每次循环迭代：
1. 选取全部就绪的 read-only Job（最多 parallelism 个）
2. 若无 writable Job 运行中且有空余槽位，加入 1 个 writable Job
3. 所有选中 Job 通过 Promise.allSettled 并发执行
4. 状态写入通过 AsyncQueue 串行化（保证 state.json 原子性）
5. 读取最新 state，进入下一轮
```

### 并发配置

通过 CLI 参数：
```bash
zigma-flow run-all code-change --task "..." --parallelism 2
```

通过 `.zigma-flow/config.json`：
```json
{
  "agent": {
    "parallelism": 4
  }
}
```

CLI 参数优先于配置文件，配置文件优先于默认值（4）。

### Fail-Fast 模式

```bash
zigma-flow run-all code-change --task "..." --fail-fast
```

启用后，同批次中任意 Job 失败会立即中止其余 Job。默认行为（`--fail-fast` 为 `false`）是允许同批次其他 Job 继续完成。

---

## Human Gate 步骤（人工门控）

Human Gate 暂停工作流执行，等待人工批准或拒绝。

### 声明 Human Gate

```yaml
steps:
  - id: approval
    type: human-gate
    description: "请审阅实施计划并决定是否继续"
    outputs:
      - key: reviewer_notes
        description: "审阅意见（可选）"
    on_approve:
      action: continue
    on_reject:
      action: retry_job
      target: plan
```

### 手动执行流程

1. 运行到 Human Gate 步骤时，Engine 发出 `human_gate_waiting` 事件，运行状态变为 `blocked`

2. 用户查看当前状态：
   ```bash
   zigma-flow status
   ```

3. 批准（工作流继续）：
   ```bash
   zigma-flow approve --job plan-review --comment "计划合理，批准继续"
   ```

4. 拒绝（触发 `on_reject` 动作，如重试 `plan` Job）：
   ```bash
   zigma-flow reject --job plan-review --comment "需要重新考虑架构方案"
   ```

5. Engine 根据决定执行相应动作，记录 `human_gate_decision` 事件

### 在 run-all 中的行为

`run-all` 遇到 Human Gate 步骤时**自动暂停**，在终端打印等待提示，等待用户执行 `approve` 或 `reject` 命令后再继续。

### 输出传递

批准时可通过 `--output` 传入键值对，这些值会被注入后续步骤的提示中：

```bash
zigma-flow approve --job plan-review \
  --output reviewer_notes="建议增加错误处理" \
  --output priority="high"
```

---

## Agent 后端配置

`.zigma-flow/config.json` 控制 `run-all` 使用的 Agent 后端。

```json
{
  "agent": {
    "backend": "claude-code",
    "parallelism": 4,
    "backends": {
      "claude-code": {
        "command": "claude",
        "args": ["-p"],
        "timeout": 600000
      }
    }
  }
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `backend` | 默认使用的后端名称 | `"claude-code"` |
| `parallelism` | 最大并发 Job 数 | `4` |
| `backends.<name>.command` | 后端可执行文件 | `"claude"` |
| `backends.<name>.args` | 传给可执行文件的参数（提示内容追加在末尾） | `["-p"]` |
| `backends.<name>.timeout` | 单次调用超时（毫秒） | `600000`（10 分钟） |

通过 `--backend` 参数临时切换后端：
```bash
zigma-flow run-all code-change --task "..." --backend custom-agent
```

---

## 结构化状态返回（Status Returns）

步骤可声明返回值枚举，Engine 根据 Agent 返回的状态执行不同动作。

```yaml
steps:
  - id: review
    type: agent
    returns:
      status:
        type: enum
        values: [approved, needs_revision, escalate]
      on_return:
        approved:
          action: continue
        needs_revision:
          action: goto_step
          target: revise
        escalate:
          action: activate_job
          target: human-escalation
```

Agent 在 `report.json` 中返回：
```json
{ "status": "needs_revision" }
```

Engine 查找 `on_return.needs_revision.action` 并执行 `goto_step: revise`。

这比信号更简洁，适合步骤有明确的有限返回状态集的场景。
