# Skill Pack 参考

Skill Pack 是一个可复用的能力包，为 Agent 步骤提供提示模板、背景知识、脚本和检查定义。Skill Pack 存储在 `.zigma-flow/skills/<pack-name>/`。

---

## 目录结构

```
.zigma-flow/skills/<pack-name>/
  skill.yml                # 清单文件（必填）
  knowledge/               # 背景知识文档
    *.md
  prompts/                 # 步骤提示模板
    *.md
  scripts/                 # 可执行脚本
    *.sh / *.ts / *.js
  checks/                  # JSON Schema 检查定义
    *.schema.json
```

---

## skill.yml 清单

```yaml
name: code-change            # Skill Pack 名称（必须与目录名一致）
version: "1.0.0"             # 语义版本
description: string          # 描述（可选）

# 导出的函数（供 Agent Step 的 function 字段引用）
functions:
  - id: intake               # 函数 ID
    description: string      # 描述
    prompt: prompts/intake.md        # 提示模板路径（相对于 Skill Pack 根目录）
    knowledge:                       # 注入的知识文档列表（可选）
      - knowledge/project-context.md
      - knowledge/coding-standards.md

  - id: implement
    description: "实施代码变更"
    prompt: prompts/implement.md
    knowledge:
      - knowledge/project-context.md

# 脚本声明（可选）
scripts:
  - id: run-tests
    path: scripts/run-tests.sh
    description: "执行测试套件"

# 检查声明（可选）
checks:
  - id: intake-report
    schema: checks/intake-report.schema.json
    description: "验证 Intake 报告格式"
```

---

## knowledge/（知识文档）

知识文档是 Markdown 文件，会被注入到 Agent 步骤的提示中作为背景知识。适合放入：

- 项目架构概述
- 编码规范
- API 参考片段
- 领域背景信息

示例 `knowledge/project-context.md`：

```markdown
# Project Context

This is a TypeScript monorepo using pnpm workspaces.
Main entry: `src/index.ts`.
Test framework: vitest.
Lint: ESLint with @typescript-eslint.
```

---

## prompts/（提示模板）

提示模板是 Markdown 文件，描述 Agent 在该步骤需要完成的工作和输出要求。模板会与 Engine 生成的系统提示、任务描述、上下文块等合并。

提示模板最佳实践：

1. 用明确的标题说明任务目标
2. 列出输出物要求（文件、格式、字段）
3. 说明信号发出条件
4. 说明输出约束（不允许修改哪些文件等）

示例 `prompts/intake.md`：

```markdown
# Intake Analysis

Analyze the task description and produce an intake summary.

## Your task

1. Read the task description from the prompt context
2. Identify the files most likely to be involved
3. Estimate the risk level (low / medium / high)
4. Write a structured intake summary as an artifact

## Output

Write the summary to the artifact path shown in the output contract section.
The artifact must be a Markdown file with the following sections:
- **Task**: One-sentence summary
- **Files**: List of affected files with brief reason
- **Risk**: low / medium / high with justification
```

---

## checks/（检查 Schema）

用于 Check Step 的 `json-schema` 类型检查。文件格式为标准 JSON Schema（Draft 7+）。

示例 `checks/intake-report.schema.json`：

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["outputs", "signals"],
  "properties": {
    "outputs": {
      "type": "object",
      "properties": {
        "summary": { "type": "string", "minLength": 1 }
      },
      "required": ["summary"]
    },
    "signals": {
      "type": "array",
      "items": { "type": "string" }
    }
  }
}
```

---

## skill-lock.json

`skill-lock.json` 锁定 Skill Pack 的版本和内容哈希，确保多次运行使用相同版本的 Skill Pack。

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

修改 Skill Pack 内容后需要更新此文件（通过 `zigma-flow validate` 触发重新计算）。

---

## 编写自定义 Skill Pack

1. 在 `.zigma-flow/skills/` 下创建目录：
   ```bash
   mkdir -p .zigma-flow/skills/my-skill/prompts
   mkdir -p .zigma-flow/skills/my-skill/knowledge
   ```

2. 创建 `skill.yml`：
   ```yaml
   name: my-skill
   version: "1.0.0"
   functions:
     - id: my-function
       prompt: prompts/my-function.md
   ```

3. 创建提示模板 `prompts/my-function.md`

4. 在工作流 YAML 中引用：
   ```yaml
   steps:
     - id: my-step
       type: agent
       skill: my-skill
       function: my-function
   ```

5. 运行验证：
   ```bash
   zigma-flow validate .zigma-flow/workflows/my-workflow.yml
   ```
