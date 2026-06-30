# CLI 命令参考

所有命令在项目根目录（含 `.zigma-flow/` 的目录）下执行。

---

## 全局选项

```
zigma-flow [options] <command>

选项：
  -V, --version    显示版本号
  -h, --help       显示帮助信息
```

---

## init

初始化当前目录的 `.zigma-flow/` 脚手架。

```bash
zigma-flow init
```

创建内容：
- `.zigma-flow/config.json` — Agent 后端与并发配置
- `.zigma-flow/skill-lock.json` — Skill Pack 版本锁定文件
- `.zigma-flow/workflows/code-change.yml` — 内置代码变更工作流
- `.zigma-flow/skills/code-change/` — 对应的 Skill Pack

已存在 `.zigma-flow/` 时命令安全退出，不会覆盖现有文件。

---

## validate

验证工作流 YAML 或 Skill Pack 清单文件。

```bash
zigma-flow validate <path>
```

| 参数 | 说明 |
|------|------|
| `<path>` | 工作流 YAML 文件路径或 Skill Pack 的 `skill.yml` 路径 |

验证内容：
- YAML 格式正确
- 所有必填字段存在
- DAG 无环（工作流验证）
- 信号和可选 Job 的引用一致
- Skill Pack 函数引用的文件存在

成功输出：`Workflow is valid.`

---

## run

创建新的工作流运行实例。

```bash
zigma-flow run <workflow> --task <description>
```

| 参数/选项 | 说明 |
|-----------|------|
| `<workflow>` | 工作流名称或 YAML 文件路径 |
| `--task <description>` | 本次运行的任务描述（必填） |

输出：运行 ID（如 `run-20260630-143025-abc123`）。

运行状态保存在 `.zigma-flow/runs/<run-id>/`，初始状态为入口 Job 就绪。

---

## run-all

自动执行整个工作流，无需手动交互。

```bash
# 创建新运行并全自动执行
zigma-flow run-all <workflow> --task <description> [options]

# 恢复已中断的运行
zigma-flow run-all <workflow> --resume <run-id> [options]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--task <description>` | 任务描述（与 `--resume` 互斥） | — |
| `--resume <run-id>` | 恢复指定运行（与 `--task` 互斥） | — |
| `--backend <name>` | 使用的 Agent 后端 | config.json 中的值或 `claude-code` |
| `--parallelism <N>` | 最大并发 Job 数 | config.json 中的值或 `4` |
| `--fail-fast` | 任意 Job 失败时立即中止同批次其他 Job | `false` |

`--task` 和 `--resume` 必须且只能指定一个。

**行为说明**：
- 对 Agent 步骤：调用配置的 Agent 后端（默认 Claude Code CLI）
- 对 Script/Check/Router 步骤：直接执行，无需 Agent
- 对 Human Gate 步骤：暂停执行，等待用户手动批准或拒绝
- 失败的 Agent 步骤按 Job 的 `retry.max_attempts` 自动重试
- 配置错误（后端不存在、未登录）跳过重试直接失败

---

## status

显示当前（最新）运行的状态摘要。

```bash
zigma-flow status [--run <run-id>]
```

| 选项 | 说明 |
|------|------|
| `--run <run-id>` | 指定运行 ID（默认显示最新运行） |

输出内容：运行 ID、工作流、任务描述、整体状态、各 Job 状态。

---

## prompt

为当前就绪 Job 的当前步骤生成 Agent 提示。

```bash
zigma-flow prompt [--job <job-id>]
```

| 选项 | 说明 |
|------|------|
| `--job <job-id>` | 指定 Job ID（若只有一个就绪 Job 则可省略） |

输出：完整的 Markdown 提示，包含：
- 系统上下文和角色定义
- 任务描述
- 当前步骤说明
- 注入的知识文档内容
- 当前上下文块（如有）
- 输出契约（report.json 路径和格式要求）
- 权限边界（允许/禁止的操作）

将此提示粘贴到 Agent（Claude Code 等），Agent 执行工作后将结果写入提示中指定的 `report.json` 路径。

---

## step

执行当前就绪 Job 的 Script、Check 或 Router 步骤。

```bash
zigma-flow step [--job <job-id>]
```

| 选项 | 说明 |
|------|------|
| `--job <job-id>` | 指定 Job ID（若只有一个就绪 Job 则可省略） |

仅适用于 Script、Check、Router 和 Human Gate 步骤。若当前步骤是 Agent 步骤，命令会报错提示使用 `prompt` 和 `next`。

`check` 是 `step` 的别名：
```bash
zigma-flow check --job risk-scan
```

---

## next

接受 Agent 报告并推进运行到下一步。

```bash
zigma-flow next --job <job-id>
```

| 选项 | 说明 |
|------|------|
| `--job <job-id>` | 指定 Job ID（必填） |

**前提条件**：Agent 已将 `report.json` 写入提示中指定的路径。

Engine 执行流程：
1. 读取并验证 `report.json`
2. 应用 `context_patches`（更新变量和上下文块）
3. 处理 `status` 返回（触发 `on_return` 动作）
4. 处理 `signals`（激活可选 Job、触发重试等）
5. 推进 Job 到下一步或标记完成

---

## retry

手动重试处于终止状态的 Job。

```bash
zigma-flow retry --job <job-id> [--reason <text>] [--with <json>]
```

| 选项 | 说明 |
|------|------|
| `--job <job-id>` | 要重试的 Job ID（必填） |
| `--reason <text>` | 人工可读的重试原因（可选） |
| `--with <json>` | JSON 格式的重试输入（整体替换，可选） |

`--with` 示例：
```bash
zigma-flow retry --job implement --reason "修复测试失败" --with '{"hint": "关注 null 处理"}'
```

---

## abort

取消当前运行，不删除已有 Artifact。

```bash
zigma-flow abort [--reason <text>]
```

| 选项 | 说明 |
|------|------|
| `--reason <text>` | 人工可读的取消原因（可选） |

运行状态变为 `cancelled`，所有未完成 Job 标记为 `cancelled`。

---

## list-runs

列出 `.zigma-flow/runs/` 下的所有历史运行。

```bash
zigma-flow list-runs
```

输出：运行 ID、工作流名称、任务描述、状态、创建时间。

---

## show

显示运行的详细信息（含最近 5 条事件）。

```bash
zigma-flow show [<run-id>]
```

| 参数 | 说明 |
|------|------|
| `<run-id>` | 指定运行 ID（省略则显示最新运行） |

输出：运行基本信息、所有 Job 状态详情、最近 5 条事件日志。

---

## approve

批准 Human Gate 步骤。

```bash
zigma-flow approve --job <job-id> [--step <step-id>] [--comment <text>] [--output key=value ...]
```

| 选项 | 说明 |
|------|------|
| `--job <job-id>` | 包含 Human Gate 步骤的 Job ID（必填） |
| `--step <step-id>` | 指定 Step ID（若 Job 中只有一个等待步骤可省略） |
| `--comment <text>` | 批准备注（可选） |
| `--output key=value` | 输出键值对（可重复指定多个，可选） |

示例：
```bash
zigma-flow approve --job plan-review --comment "架构合理，批准继续" --output reviewer_notes="建议增加错误处理"
```

---

## reject

拒绝 Human Gate 步骤。

```bash
zigma-flow reject --job <job-id> --comment <text> [--step <step-id>]
```

| 选项 | 说明 |
|------|------|
| `--job <job-id>` | 包含 Human Gate 步骤的 Job ID（必填） |
| `--comment <text>` | 拒绝原因（必填） |
| `--step <step-id>` | 指定 Step ID（可选） |

拒绝后 Engine 根据 `on_reject` 配置执行相应动作（如重试、失败等）。

---

## 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 状态错误（运行状态不合法，如重试已成功的 Job） |
| `2` | 用法错误（缺少必填参数、选项冲突等） |
| `3` | 验证错误（YAML 格式错误、Schema 不合法等） |
| `4` | 配置错误（找不到 Skill Pack、后端配置错误等） |
