# 目录结构

## `.zigma-flow/` 总览

```
.zigma-flow/
├── config.json                    ← Agent 后端与并发配置
├── skill-lock.json                ← Skill Pack 版本锁定文件
├── workflows/
│   └── code-change.yml            ← 工作流定义（可添加多个）
├── skills/
│   └── code-change/               ← Skill Pack 目录（名称与 workflow 引用一致）
│       ├── skill.yml              ← Skill Pack 清单
│       ├── knowledge/             ← 背景知识文档
│       │   └── *.md
│       ├── prompts/               ← 步骤提示模板
│       │   └── *.md
│       ├── scripts/               ← 可执行脚本
│       │   └── *.sh / *.ts
│       └── checks/                ← JSON Schema 检查定义
│           └── *.schema.json
└── runs/
    └── <run-id>/                  ← 一次工作流运行的数据
        ├── run.yml                ← 运行元数据
        ├── state.json             ← 当前状态快照
        ├── events.jsonl           ← 不可变事件日志
        ├── artifacts.jsonl        ← Artifact 全局索引
        ├── skill-lock.snapshot.json   ← 运行时 Skill Pack 版本快照
        └── jobs/
            └── <job-id>/
                └── attempts/
                    └── <n>/       ← 第 n 次尝试（从 1 开始）
                        └── steps/
                            └── <step-id>/
                                ├── prompt.md      ← 生成的 Agent 提示
                                ├── report.json    ← Agent 输出（手动模式）
                                ├── stdout.log     ← Script 步骤标准输出
                                ├── stderr.log     ← Script 步骤标准错误
                                └── artifacts/     ← 步骤产物文件
```

---

## config.json

Agent 后端与并发配置。

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

| 字段 | 说明 |
|------|------|
| `agent.backend` | 默认使用的后端名称 |
| `agent.parallelism` | `run-all` 的最大并发 Job 数 |
| `agent.backends.<name>.command` | Agent 可执行文件路径或命令名 |
| `agent.backends.<name>.args` | 传给命令的参数（提示追加在末尾） |
| `agent.backends.<name>.timeout` | 单次调用超时（毫秒） |

---

## skill-lock.json

锁定已使用的 Skill Pack 版本和内容哈希，保证可重现性。

```json
{
  "version": "1",
  "packs": {
    "code-change": {
      "version": "1.0.0",
      "hash": "sha256:abc123..."
    }
  }
}
```

提交到版本控制中，确保团队成员使用相同版本的 Skill Pack。

---

## run.yml

每次运行的元数据文件，在 `zigma-flow run` 时创建，此后只读。

```yaml
runId: run-20260630-143025-abc123
workflow: code-change
task: "Add null check to parse function in src/parser.ts"
createdAt: "2026-06-30T14:30:25.000Z"
skillLockHash: "sha256:def456..."
```

---

## state.json

当前运行的状态快照，由 Engine 在每次状态变更时原子更新。

```json
{
  "runId": "run-20260630-143025-abc123",
  "status": "running",
  "jobs": {
    "intake": {
      "status": "completed",
      "attempts": 1,
      "currentAttempt": 1
    },
    "implement": {
      "status": "running",
      "attempts": 2,
      "currentAttempt": 2
    }
  },
  "variables": {
    "review_status": "pending"
  },
  "context_blocks": {
    "current-plan": {
      "version": 2,
      "path": "jobs/plan/attempts/1/steps/draft/artifacts/current-plan-v2.md"
    }
  },
  "signals": ["needs_architecture_design"],
  "last_event_id": 42
}
```

---

## events.jsonl

不可变的追加式事件日志，每行一个 JSON 事件。

```jsonl
{"id":1,"type":"run_created","timestamp":"2026-06-30T14:30:25.000Z","runId":"run-...","workflow":"code-change","task":"..."}
{"id":2,"type":"job_started","timestamp":"2026-06-30T14:30:26.000Z","jobId":"intake"}
{"id":3,"type":"step_completed","timestamp":"2026-06-30T14:31:10.000Z","jobId":"intake","stepId":"analyze"}
{"id":4,"type":"job_completed","timestamp":"2026-06-30T14:31:10.000Z","jobId":"intake"}
{"id":5,"type":"variable_set","timestamp":"2026-06-30T14:35:00.000Z","key":"review_status","value":"approved"}
```

每个事件包含：
- `id`：自增序列号
- `type`：事件类型（见[核心概念 → Event](./02-core-concepts.md)）
- `timestamp`：ISO 8601 时间戳
- 事件特定字段

---

## artifacts.jsonl

运行内所有 Artifact 的全局索引，由 Engine 在 Agent 提交报告时更新。

```jsonl
{"key":"intake-summary","path":"jobs/intake/attempts/1/steps/analyze/artifacts/summary.md","kind":"markdown","producer":"intake","summary":"Task analysis: 1 file affected, low risk","size":1024,"registeredAt":"2026-06-30T14:31:10.000Z"}
{"key":"code-map","path":"jobs/code-map/attempts/1/steps/map/artifacts/code-map.md","kind":"markdown","producer":"code-map","summary":"Relevant files: src/parser.ts, src/types.ts","size":2048,"registeredAt":"2026-06-30T14:35:00.000Z"}
```

---

## 各步骤目录

### prompt.md

`zigma-flow prompt` 生成的 Agent 提示，包含：
- 系统上下文
- 任务描述
- 当前步骤说明
- 注入的知识文档
- 当前上下文块内容
- 输出契约（report.json 路径）
- 权限边界

Agent 读取此文件后执行工作。

### report.json

Agent 写入的输出文件，包含 `outputs`、`artifacts`、`signals`、`status`、`context_patches`。详见 [Agent 报告格式](./07-agent-report-format.md)。

### stdout.log / stderr.log

Script Step 执行时的标准输出和标准错误，由 Engine 捕获并注册为 Artifact。

### artifacts/

步骤产物文件存放目录。Artifact 文件在此创建后，路径写入 `report.json`。

---

## 运行 ID 格式

```
run-<YYYYMMDD>-<HHMMSS>-<random>
```

示例：`run-20260630-143025-abc123`

---

## 版本控制建议

提交到版本控制的文件：
- `.zigma-flow/config.json`
- `.zigma-flow/skill-lock.json`
- `.zigma-flow/workflows/*.yml`
- `.zigma-flow/skills/**`

**不应提交**的文件（建议加入 `.gitignore`）：
- `.zigma-flow/runs/`（运行数据通常是临时的）

```gitignore
.zigma-flow/runs/
```
