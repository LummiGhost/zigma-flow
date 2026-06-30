# 工作流 YAML 参考

工作流文件保存在 `.zigma-flow/workflows/<name>.yml`，是整个 Zigma Flow 运行的核心配置。

---

## 顶层结构

```yaml
name: string                    # 工作流名称（唯一标识）
version: string                 # 版本号（如 "1.0"）
description: string             # 工作流描述（可选）

variables:                      # 工作流变量声明（可选，v0.2）
  <key>:
    description: string
    default: string             # 可选默认值
    allowed_writers: [job-id]   # 允许写入的 Job 列表

signals:                        # 信号声明
  <signal-name>:
    allowed_from: [job-id]      # 允许发出此信号的 Job
    action:                     # 收到信号后的动作
      activate_job: job-id      # 或 retry_job / goto_job

jobs:                           # Job 定义列表
  - id: string
    ...
```

---

## Job 字段

```yaml
jobs:
  - id: intake                          # Job 唯一 ID
    description: string                 # 可选描述
    needs: [job-id, ...]                # 前置依赖（空列表或省略 = 入口 Job）
    optional: true                      # 可选 Job（需由信号激活，默认 false）

    workspace:
      mode: writable                    # writable（默认）或 read-only
      scope: [path, ...]                # 允许写入的路径（可选）

    retry:
      max_attempts: 3                   # 最大尝试次数（含首次），默认 1

    skill: code-change                  # 引用的 Skill Pack（可选）

    steps:
      - ...                             # Step 定义列表（按顺序执行）
```

---

## Step 字段

### Agent Step

```yaml
- id: analyze                          # Step 唯一 ID（在 Job 内唯一）
  type: agent
  skill: intake                        # 使用的 Skill Pack
  function: analyze                    # 引用 Skill Pack 中的函数

  if: "${{ variables.status == 'ready' }}"   # 条件（可选，v0.2）
  max_visits: 3                        # 最大访问次数（用于循环，默认 3，v0.2）

  allowed_signals: [signal-name, ...]  # 允许发出的信号列表

  returns:                             # 结构化状态返回（可选，v0.2）
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
        target: human-review

  outputs:                             # 声明输出（可选）
    - key: summary
      description: "变更摘要"
```

### Script Step

```yaml
- id: typecheck
  type: script
  run: "pnpm typecheck && pnpm lint"   # Shell 命令（必填）
  cwd: string                          # 工作目录（可选，默认项目根目录）
  timeout: 60000                       # 超时毫秒（可选，默认 120000）
  env:                                 # 额外环境变量（可选）
    NODE_ENV: test
  if: "${{ variables.skip_lint == 'false' }}"   # 条件（可选）
```

### Check Step

```yaml
- id: validate-output
  type: check
  checks:
    - kind: file-exists
      path: ".zigma-flow/runs/.../artifacts/code-map.md"

    - kind: json-parse
      path: ".zigma-flow/runs/.../report.json"

    - kind: json-schema
      schema_path: ".zigma-flow/skills/code-change/checks/intake.schema.json"
      data_path: ".zigma-flow/runs/.../report.json"

    - kind: required-fields
      path: ".zigma-flow/runs/.../report.json"
      fields: [summary, files_analyzed]

    - kind: forbidden-paths
      paths: [".zigma-flow/", "node_modules/"]

    - kind: git-diff-exists
      repo_path: "."

    - kind: protected-runtime-files
      run_dir: ".zigma-flow/runs/<run-id>"
```

Check 步骤所有检查均通过才算成功；任一失败则 Job 进入失败状态。

### Router Step

```yaml
- id: decide
  type: router
  routes:
    - if: "${{ variables.review_result == 'approved' }}"
      action: continue

    - if: "${{ variables.review_result == 'rejected' }}"
      action: retry_job
      target: implement

    - action: fail                     # 默认分支（无 if 条件）
```

路由按顺序匹配，第一个满足条件的分支生效。若所有 `if` 条件均不满足且无默认分支，Router 步骤失败。

### Human Gate Step

```yaml
- id: approval-gate
  type: human-gate
  description: "请人工审核实施计划后批准或拒绝"
  outputs:
    - key: reviewer_notes
      description: "审阅意见"
  on_approve:
    action: continue
  on_reject:
    action: retry_job
    target: plan
```

Human Gate 暂停工作流执行，等待用户通过 CLI 执行 `approve` 或 `reject` 命令。

---

## 表达式语法

条件字段（`if`、Router `if`）支持 `${{ ... }}` 表达式语法：

```
${{ variables.<key> == 'value' }}
${{ variables.<key> != 'value' }}
${{ variables.<key> == 'a' && variables.<key2> == 'b' }}
${{ variables.<key> == 'a' || variables.<key2> == 'b' }}
${{ !variables.<key> == 'value' }}
```

**限制**：
- 只能引用 `variables.<key>`（不支持 step 输出或 artifact 路径）
- 只支持 `==`、`!=`、`&&`、`||`、`!` 运算符
- 不支持数值比较、函数调用或复杂表达式

---

## 完整示例

```yaml
name: code-change
version: "1.0"
description: "全栈代码变更工作流"

variables:
  review_status:
    description: "Review 结果"
    allowed_writers: [review]

signals:
  needs_architecture_design:
    allowed_from: [plan, review]
    action:
      activate_job: architecture-design

  review_rejected:
    allowed_from: [review]
    action:
      retry_job: implement

jobs:
  - id: intake
    description: "分析任务描述"
    needs: []
    workspace:
      mode: read-only
    steps:
      - id: analyze
        type: agent
        skill: code-change
        function: intake

  - id: implement
    description: "实施代码变更"
    needs: [intake, plan]
    retry:
      max_attempts: 3
    workspace:
      mode: writable
    steps:
      - id: code
        type: agent
        skill: code-change
        function: implement
        allowed_signals: []

  - id: static-check
    description: "静态检查"
    needs: [implement]
    workspace:
      mode: read-only
    steps:
      - id: typecheck
        type: script
        run: "pnpm typecheck && pnpm lint"
        timeout: 120000

  - id: architecture-design
    description: "架构设计（可选）"
    optional: true
    needs: []
    workspace:
      mode: writable
    steps:
      - id: design
        type: agent
        skill: code-change
        function: architecture-design
```
