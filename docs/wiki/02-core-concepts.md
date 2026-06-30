# 核心概念

## Workflow（工作流）

工作流是一个 **有向无环图（DAG）**，由若干 Job 组成，通过 `needs` 字段声明依赖关系。工作流定义保存在 `.zigma-flow/workflows/<name>.yml`，由 Engine 在运行时读取。

```
intake → code-map → risk-scan → plan ──► implement → static-check → review → summarize
                                    └──► architecture-design ──►┘
```

---

## Job（作业）

Job 是工作流的执行单元，包含一个或多个 Step。Job 的关键属性：

| 属性 | 说明 |
|------|------|
| `id` | 唯一标识符（如 `intake`、`implement`） |
| `needs` | 依赖的 Job 列表；被依赖 Job 全部完成后本 Job 才就绪 |
| `workspace.mode` | `"writable"`（默认）或 `"read-only"`；read-only Job 可并发执行 |
| `retry.max_attempts` | 最大尝试次数（含首次），默认 1（不重试） |
| `optional` | `true` 时 Job 不在初始 DAG 中，需由信号激活 |

### Job 状态

```
pending → ready → running → completed
                          → failed
                          → blocked (人工门控等待)
                          → cancelled
```

---

## Step（步骤）

Step 是最小执行单元，一个 Job 按顺序执行多个 Step。Step 有四种类型：

### 1. Agent Step

需要 AI Agent 判断的步骤。

- Engine 生成结构化提示（`prompt.md`）
- Agent 读取提示，执行工作，将结果写入 `report.json`
- 用户运行 `zigma-flow next` 让 Engine 读取报告并推进

```yaml
steps:
  - id: analyze
    type: agent
    skill: intake
    function: analyze
```

### 2. Script Step

执行 Shell 命令的步骤，不涉及 Agent。

```yaml
steps:
  - id: typecheck
    type: script
    run: "pnpm typecheck && pnpm lint"
    timeout: 60000
```

- 支持 `cwd`（工作目录）、`env`（环境变量）、`timeout`（毫秒）
- 命令的 stdout/stderr 作为 Artifact 记录

### 3. Check Step

确定性验证步骤，不调用 LLM。

```yaml
steps:
  - id: gate
    type: check
    checks:
      - kind: file-exists
        path: ".zigma-flow/runs/{{run_id}}/jobs/code-map/artifacts/code-map.md"
      - kind: json-schema
        schema_path: ".zigma-flow/skills/code-change/checks/intake-report.schema.json"
        data_path: "..."
```

内置 Check 类型：

| 类型 | 说明 |
|------|------|
| `file-exists` | 验证文件存在 |
| `forbidden-paths` | 确保路径不在禁止列表中 |
| `git-diff-exists` | 验证有未提交的 Git 变更 |
| `json-parse` | 验证文件是合法 JSON |
| `json-schema` | 用 JSON Schema 校验 JSON 文件 |
| `required-fields` | 验证 JSON 对象包含必需字段 |
| `protected-runtime-files` | 确保运行时文件未被修改 |

### 4. Router Step

条件分支步骤，根据当前状态决定执行路径。

```yaml
steps:
  - id: route
    type: router
    routes:
      - if: "${{ variables.review_status == 'approved' }}"
        action: continue
      - if: "${{ variables.review_status == 'needs_revision' }}"
        action: retry_job
        target: implement
```

Router 支持的动作：

| 动作 | 说明 |
|------|------|
| `continue` | 继续到当前 Job 的下一个 Step |
| `fail` | 将当前 Job 标记为失败 |
| `block` | 将当前 Job 标记为 blocked |
| `retry_job` | 重试指定 Job（需指定 `target`） |
| `activate_job` | 激活一个可选 Job |
| `goto_job` | 跳转到指定 Job（需指定 `target`） |
| `goto_step` | 跳转到同一 Job 内的指定 Step（需指定 `target`） |

---

## Skill Pack（技能包）

Skill Pack 是附加到 Job 的能力包，为 Agent 提供：

- **knowledge**：背景知识文档（Markdown）
- **prompts**：步骤提示模板（Markdown）
- **scripts**：可复用脚本
- **checks**：JSON Schema 检查定义
- **functions**：逻辑单元（Agent 步骤引用的函数）

Skill Pack 通过 `skill.yml` 清单定义，版本锁定在 `skill-lock.json` 中。

---

## Signal（信号）

Signal 是 Agent 在 `report.json` 中发出的事件，Engine 根据工作流中声明的规则处理信号。

```yaml
# 工作流中声明信号
signals:
  needs_architecture_design:
    allowed_from: [plan, review]
    action:
      activate_job: architecture-design

  review_rejected:
    allowed_from: [review]
    action:
      retry_job: implement
```

Agent 只能发出在 Step 的 `allowed_signals` 中声明的信号。Engine 接收到信号后执行对应动作，Agent 无法直接修改工作流状态。

---

## Artifact（产物）

Artifact 是步骤执行过程中生成或消费的文件。

- 存储于 `.zigma-flow/runs/<run-id>/jobs/<job-id>/attempts/<n>/steps/<step-id>/artifacts/`
- 全局索引记录在 `.zigma-flow/runs/<run-id>/artifacts.jsonl`
- 每个 Artifact 有元数据：producer（生产者）、kind（类型）、size、summary

Agent 通过在 `report.json` 的 `artifacts` 字段中声明已写入的文件来注册 Artifact。

---

## Event（事件）

Engine 的每一次状态变更都写入不可变的事件日志（`events.jsonl`），用于审计和调试。

常见事件类型：

| 事件 | 触发时机 |
|------|---------|
| `run_created` | 新运行开始 |
| `job_started` | Job 进入 running 状态 |
| `job_completed` | Job 成功完成 |
| `job_failed` | Job 失败 |
| `step_completed` | Step 完成 |
| `step_skipped` | 条件 Step 被跳过（`if` 为 false） |
| `agent_invoked` | Agent 后端被调用 |
| `agent_completed` | Agent 后端返回结果 |
| `signal_received` | 收到 Agent 信号 |
| `variable_set` | 工作流变量被设置 |
| `context_block_updated` | 上下文块被更新 |
| `human_gate_waiting` | Human Gate 步骤等待人工操作 |
| `human_gate_decision` | 人工操作完成（批准或拒绝） |
| `run_completed` | 工作流运行成功完成 |
| `run_aborted` | 工作流运行被取消 |

---

## Variable（工作流变量）

工作流变量是在工作流 YAML 中声明的共享状态，可在步骤条件（`if`）和 Router 条件中引用。

```yaml
variables:
  review_status:
    description: "Review outcome"
    allowed_writers: [review]
```

Agent 通过 `report.json` 中的 `context_patches` 修改变量：

```json
{
  "context_patches": [
    { "kind": "variable", "key": "review_status", "value": "approved" }
  ]
}
```

---

## Context Block（上下文块）

上下文块是版本化的 Markdown 内容，用于在 Job 间传递结构化信息（如当前计划、审阅注释）。

- 每次更新会生成新版本文件（`v1.md`、`v2.md`…）
- 当前版本内容会注入到后续 Agent 步骤的提示中
- 存储为特殊类型的 Artifact（`context_block`）

---

## Engine 的核心职责

Engine 是工作流状态的唯一写入者：

- 所有状态变更通过 Engine 的接口（`acceptAgentReport`、`applyContextPatch` 等）进行
- Agent 不能直接修改 `state.json`，只能通过 `report.json` 提交结果
- Engine 评估信号、条件、Router 规则后决定下一步动作
