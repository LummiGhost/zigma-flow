# 快速入门

## 环境要求

- Node.js >= 20.11.0
- pnpm 10+（本地开发用）或 npm（全局安装用）
- 若使用 `run-all` 自动模式，需要 Claude Code CLI（`claude`）已安装并登录

---

## 安装

### 全局安装（推荐）

```bash
npm install -g zigma-flow
```

安装后验证：

```bash
zigma-flow --version
```

### 从源码运行（开发模式）

```bash
git clone <repo-url>
cd zigma-flow
pnpm install
pnpm build
node dist/cli.js --version
```

---

## 初始化项目

在你的项目根目录执行：

```bash
cd my-project
zigma-flow init
```

这会在当前目录下创建 `.zigma-flow/` 目录，内含：

```
.zigma-flow/
  config.json                        ← Agent 后端与并发配置
  skill-lock.json                    ← Skill Pack 版本锁定文件
  workflows/
    code-change.yml                  ← 内置代码变更工作流
  skills/
    code-change/
      skill.yml                      ← Skill Pack 清单
      knowledge/                     ← 背景知识文档
      prompts/                       ← 步骤提示模板
      scripts/                       ← 可执行脚本
      checks/                        ← 检查定义
```

---

## 验证工作流

```bash
zigma-flow validate .zigma-flow/workflows/code-change.yml
```

输出 `Workflow is valid.` 表示 YAML 格式正确且 DAG 无环。

---

## 执行第一个工作流

Zigma Flow 提供两种执行模式：

### 模式一：手动步进（Manual）

适合需要完全控制每个步骤的场景。

```bash
# 1. 创建运行
zigma-flow run code-change --task "Add null check to parse function in src/parser.ts"

# 2. 查看运行状态（找到当前就绪的 Job）
zigma-flow status

# 3. 为 intake Job 生成 Agent 提示
zigma-flow prompt --job intake

# 4. 将提示粘贴到 Claude Code（或其他 Agent）。
#    Agent 完成工作后会把 report.json 写入提示中显示的路径。

# 5. 接受报告并推进到下一步
zigma-flow next --job intake

# 6. 对后续 Job 重复上述步骤…
#    Script/Check 步骤用 step 命令自动执行：
zigma-flow step --job risk-scan

# 7. 完成后查看最终状态
zigma-flow status
```

### 模式二：全自动执行（Automated，推荐）

`run-all` 会自动驱动整个工作流，无需手动交互。

```bash
zigma-flow run-all code-change --task "Add null check to parse function in src/parser.ts"
```

Engine 会：
1. 创建新运行
2. 循环选取就绪 Job 批次
3. 对 Agent 步骤自动调用已配置的 Agent 后端（默认 Claude Code）
4. 对 Script/Check/Router 步骤直接执行
5. 直至工作流完成或进入终止状态

若执行被中断，可用 `--resume` 继续：

```bash
zigma-flow run-all code-change --resume <run-id>
```

---

## 查看运行结果

```bash
# 简要状态（默认显示最新运行）
zigma-flow status

# 详细信息（含最近 5 条事件）
zigma-flow show

# 列出所有历史运行
zigma-flow list-runs
```

---

## 下一步

- [核心概念](./02-core-concepts.md) — 了解 Workflow、Job、Step 等基本抽象
- [CLI 命令参考](./05-cli-reference.md) — 查看所有命令和选项
- [工作流 YAML 参考](./03-workflow-yaml-reference.md) — 自定义或编写新的工作流
