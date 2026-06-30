# Zigma Flow — 用户文档

> v0.2.x · 本地 Agent 工作流运行时

Zigma Flow 是一个本地单进程 TypeScript CLI，用于将复杂的 AI 辅助开发任务分解为离散、可审计的步骤。它让 AI Agent（如 Claude Code）每次只处理一个步骤，避免上下文过载和跳过关键检查环节。

---

## 文档目录

| 文档 | 内容 |
|------|------|
| [快速入门](./01-getting-started.md) | 安装、初始化项目、执行第一个工作流运行 |
| [核心概念](./02-core-concepts.md) | Workflow、Job、Step、Skill Pack、Signal、Artifact、Event |
| [工作流 YAML 参考](./03-workflow-yaml-reference.md) | 工作流 YAML 完整字段说明与示例 |
| [Skill Pack 参考](./04-skill-pack-reference.md) | Skill Pack 清单结构与各类资源说明 |
| [CLI 命令参考](./05-cli-reference.md) | 所有 CLI 命令、选项和返回代码 |
| [运行生命周期](./06-run-lifecycle.md) | 运行状态机、Job 状态、Step 执行流程 |
| [Agent 报告格式](./07-agent-report-format.md) | Agent 必须返回的 report.json 结构 |
| [高级特性](./08-advanced-features.md) | 变量、上下文块、条件步骤、有界循环、并发、人工门控 |
| [目录结构](./09-directory-structure.md) | `.zigma-flow/` 目录布局详解 |

---

## 核心工作原理（一句话）

Engine 是唯一的状态写入者；Agent 只能通过 `report.json` 提交结构化输出，Engine 读取后决定是否推进、重试或激活可选 Job。

---

## 版本说明

当前版本：**v0.2.1**

v0.2 新增：结构化状态返回、工作流变量、上下文块、条件步骤、有界循环、Agent 后端配置、并发执行（`run-all`）、Human Gate 步骤。
