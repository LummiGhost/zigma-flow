# Agent 报告格式

当 Agent 完成一个 Agent Step 后，必须将结果写入提示中指定的 `report.json` 路径。Engine 读取此文件以推进工作流。

---

## 报告路径

路径由 `zigma-flow prompt` 命令在提示末尾的"输出契约"部分给出：

```
.zigma-flow/runs/<run-id>/jobs/<job-id>/attempts/<n>/steps/<step-id>/report.json
```

Agent 必须将文件写入**提示中显示的确切路径**。

---

## 完整 Schema

```json
{
  "outputs": {
    "<output-key>": "<value>"
  },
  "artifacts": [
    {
      "key": "string",
      "path": "string",
      "kind": "string",
      "summary": "string"
    }
  ],
  "signals": ["signal-name"],
  "status": "string",
  "context_patches": [
    {
      "kind": "variable",
      "key": "string",
      "value": "string"
    },
    {
      "kind": "context_block",
      "key": "string",
      "content": "string"
    }
  ]
}
```

---

## 字段说明

### `outputs`（必填）

步骤的输出键值对，对应工作流 YAML 中该步骤声明的 `outputs`。

```json
{
  "outputs": {
    "summary": "Added null check to parse function in src/parser.ts",
    "files_changed": "1"
  }
}
```

若步骤未声明任何 `outputs`，提供空对象 `{}`。

---

### `artifacts`（可选）

Agent 在此步骤中生成的文件列表。每个 Artifact 需提供：

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | string | Artifact 的唯一标识符（在本步骤内唯一） |
| `path` | string | 文件相对于运行目录的路径，或绝对路径 |
| `kind` | string | 类型标签（如 `markdown`、`json`、`code`） |
| `summary` | string | 简短描述，用于注入后续步骤的提示 |

```json
{
  "artifacts": [
    {
      "key": "intake-summary",
      "path": ".zigma-flow/runs/<run-id>/jobs/intake/attempts/1/steps/analyze/artifacts/intake-summary.md",
      "kind": "markdown",
      "summary": "Intake analysis: 1 file affected, low risk"
    }
  ]
}
```

Artifact 文件必须在写入 `report.json` 之前已存在于磁盘。

---

### `signals`（可选）

Agent 希望发出的信号名称列表。信号名称必须：
1. 在工作流 YAML 的 `signals` 中声明
2. 在本步骤的 `allowed_signals` 中列出

```json
{
  "signals": ["needs_architecture_design"]
}
```

不发出任何信号时，提供空数组 `[]` 或省略此字段。

Engine 收到信号后根据 `signals.<name>.action` 执行相应动作（激活可选 Job、重试 Job 等）。

---

### `status`（条件必填）

当步骤配置了 `returns.status` 时，Agent 必须返回 `values` 中声明的某个枚举值。

```json
{
  "status": "needs_revision"
}
```

Engine 根据 `on_return.<status>.action` 决定下一步动作。未配置 `returns.status` 的步骤忽略此字段。

---

### `context_patches`（可选，v0.2）

Agent 希望修改的工作流变量或上下文块。每个 patch 的格式取决于 `kind`：

**修改变量**：

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

- `key` 必须在工作流 YAML 的 `variables` 中声明
- 当前 Job 必须在该变量的 `allowed_writers` 中

**更新上下文块**：

```json
{
  "context_patches": [
    {
      "kind": "context_block",
      "key": "current-plan",
      "content": "# Implementation Plan\n\n1. Add null check...\n2. Update tests..."
    }
  ]
}
```

- `key` 必须在工作流 YAML 的上下文块声明中存在
- 每次更新会创建新版本（v1.md、v2.md…），当前内容注入后续提示

---

## 最简报告示例

```json
{
  "outputs": {},
  "signals": []
}
```

---

## 完整报告示例

```json
{
  "outputs": {
    "summary": "Implementation complete: added null guard in parse()",
    "tests_added": "2"
  },
  "artifacts": [
    {
      "key": "implementation-diff",
      "path": ".zigma-flow/runs/run-20260630-143025/jobs/implement/attempts/1/steps/code/artifacts/diff.md",
      "kind": "markdown",
      "summary": "Git diff showing null check addition in src/parser.ts"
    }
  ],
  "signals": [],
  "status": "complete",
  "context_patches": [
    {
      "kind": "context_block",
      "key": "current-plan",
      "content": "# Implementation Notes\n\nAdded null check at line 42 of src/parser.ts.\nAll existing tests pass."
    }
  ]
}
```

---

## 常见错误

| 错误 | 原因 | 解决方法 |
|------|------|---------|
| `report.json not found` | Agent 未写入文件或路径错误 | 检查提示中的确切路径，确认文件已写入 |
| `Invalid status value` | `status` 字段的值不在 `values` 枚举中 | 使用工作流 YAML 中 `returns.status.values` 声明的值 |
| `Signal not declared` | 发出的信号未在 `allowed_signals` 中 | 只发出步骤声明允许的信号 |
| `Variable not writable` | 当前 Job 不在变量的 `allowed_writers` 中 | 检查工作流变量的 `allowed_writers` 配置 |
| `Artifact file missing` | Artifact 声明的文件不存在 | 确保在写 `report.json` 前，Artifact 文件已写入磁盘 |
