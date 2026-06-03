下面是一份可直接放入仓库的正式 PRD 与开发计划。我把项目收束为一个工具级 MVP，名称暂定为 **Zigma Flow**。它是未来 Zigma 的最小验证原型，当前只解决一个核心问题：将复杂 Agent Skill 外置为可执行 workflow，降低长上下文下模型忽略流程约束的概率。

# Zigma Flow PRD

文档版本：v0.1
日期：2026-06-03
项目阶段：MVP 设计
项目定位：本地 workflow harness / Agent Skill Runner
暂定名称：Zigma Flow
备用名称：Zigma Skill Runner、Zigma Workflow Harness

## 1. 产品背景

当前在使用 Claude Code、Codex 等编程 Agent 时，复杂 Agent Skill 通常以长提示词、长文档或多段流程说明的形式存在。随着上下文增长，模型会出现注意力衰减，导致它忽略 Skill 中明确指定的工作流程，例如跳过需求理解、提前修改代码、未执行验证、未输出检查报告，或者把多个阶段混在一起完成。

Zigma Flow 的目标是把复杂 Skill 中的流程约束从模型上下文中抽离出来，放入外部 workflow 状态机中管理。Agent 每次只接收当前步骤的短提示词、输入材料、允许动作、禁止动作和交付格式。工具负责维护流程状态，检查步骤输出，并决定是否进入下一步。

Zigma Flow 是未来 Zigma 的局部原型。它优先验证一个核心假设：复杂 Agent Skill 的可靠性，可以通过外部 workflow 分解、状态管理、上下文裁剪和 gate 检查显著提升。

## 2. 产品定位

Zigma Flow 是一个本地命令行工具，用于将复杂 Agent Skill 拆解为可执行的多步骤 workflow。

它面向个人开发者和小型项目维护者，尤其适合在已有项目中辅助 Claude Code、Codex 或其他编程 Agent 执行复杂任务。

它当前不做邮件系统、多租户、权限平台、Docker 沙箱、PR 自动创建、MCP 服务调度和企业级代码平台集成。当前目标是小而稳定地验证 workflow 化 Skill 的效果。

一句话定义：

Zigma Flow 是一个面向编程 Agent 的本地 workflow runner，它用外部状态机、步骤提示词和 gate 检查机制，将复杂 Skill 拆成可控、可审计、可重试的简单步骤。

## 3. 产品目标

核心目标有四个。

第一，降低复杂 Skill 被模型忽略的概率。流程规则写入 workflow 文件，由工具负责推进，模型只处理当前步骤。

第二，缩短单次 Agent 输入上下文。每一步只包含当前任务、必要输入、输出要求和局部约束。

第三，形成可审计的任务执行记录。每一步都有输入、输出、报告、状态和检查结果。

第四，验证未来 Zigma 的核心架构方向。即使用外部工程对象和状态机治理 Agent 上下文，而不依赖长对话持续记忆。

## 4. 非目标范围

MVP 阶段不实现以下能力：

真实多 Agent 自动调度；

自动发送邮件或虚拟邮件；

自动创建 Issue、PR、Project；

Docker 隔离执行环境；

MCP 服务编排；

企业权限系统；

Web UI；

向量数据库检索；

自动化遥测分析；

复杂 LLM Judge；

完整 Zigma OS 发行版。

这些能力可以作为未来 Zigma Core 的演进方向，但不进入当前 MVP。

## 5. 目标用户

第一类用户是项目开发者。用户希望用 Claude Code、Codex 等 Agent 处理复杂开发任务，但希望 Agent 按固定流程执行。

第二类用户是 Skill 设计者。用户已经积累了一些复杂 Agent Skill，希望将长提示词改造成结构化 workflow。

第三类用户是项目维护者。用户希望每次 Agent 执行都有阶段报告、检查点和可回溯记录，方便复盘和改进。

## 6. 典型使用场景

场景一：代码修改任务。

用户希望 Agent 修复一个 bug。传统做法是把完整 Skill 和任务一起丢给 Agent，Agent 可能直接改代码并跳过测试。使用 Zigma Flow 后，任务被拆成 intake、plan、implement、verify、summarize 五步。Agent 在 intake 阶段只能理解任务，在 plan 阶段只能制定计划，在 implement 阶段才能修改代码，在 verify 阶段才能测试，在 summarize 阶段输出交付总结。

场景二：代码审查任务。

用户希望 Agent 审查一个 PR。workflow 可以拆成 diff intake、risk scan、constraint check、review comments、final decision。每一步有明确输出格式，避免 Agent 直接给出泛泛评价。

场景三：长文档解读任务。

用户希望 Agent 解读一篇复杂文档。workflow 可以拆成目录识别、摘要提取、问题生成、逐问题分析、结论合成、文章撰写。每一步保存 artifact，后续步骤只读取必要中间结果。

场景四：复杂 Skill 迁移。

用户已有一个长 Skill，例如“高级代码修改流程”。Zigma Flow 可以把它拆为 workflow YAML，使流程约束由工具执行，提示词只保留当前步骤指令。

## 7. 核心工作流

Zigma Flow 的基本执行流程如下：

```text
用户创建 workflow.yml
    ↓
zigma-flow run 创建一次 workflow run
    ↓
工具生成当前步骤提示词 current-step.md
    ↓
用户或脚本将 current-step.md 交给 Claude Code / Codex
    ↓
Agent 执行当前步骤并写入约定输出
    ↓
zigma-flow check 检查输出
    ↓
检查通过后 zigma-flow next 进入下一步
    ↓
所有步骤完成后生成 run summary
```

MVP 首先采用半自动模式。工具生成提示词，Agent 执行方式由用户控制。这样可以快速验证核心机制，避免一开始就投入外部 Agent CLI 适配。

## 8. 功能需求

### FR-001 初始化项目

命令：

```bash
zigma-flow init
```

功能：

在当前项目根目录创建 `.zigma-flow/` 目录。

生成基础目录结构：

```text
.zigma-flow/
  workflows/
  runs/
  templates/
  config.json
```

生成一个内置示例 workflow：

```text
.zigma-flow/workflows/code-change-basic.yml
```

验收标准：

重复执行 init 不应破坏已有 workflow 和 run 数据；

如果目录已存在，应提示已初始化；

config.json 必须包含工具版本和默认配置。

### FR-002 Workflow 定义加载

命令：

```bash
zigma-flow validate .zigma-flow/workflows/code-change-basic.yml
```

功能：

读取 YAML workflow 定义；

校验必填字段；

校验 steps 顺序；

校验每个 step 的 outputs、gate、prompt、allowed_actions；

发现错误时输出具体字段路径和错误原因。

验收标准：

合法 workflow 可以通过校验；

缺少 name、steps、step.id、step.prompt 等关键字段时必须报错；

重复 step.id 必须报错；

输出路径非法时必须报错。

### FR-003 创建 Run

命令：

```bash
zigma-flow run code-change-basic --task "修复 CSV 导入编码检测问题"
```

功能：

基于 workflow 创建一次运行实例；

生成唯一 run_id；

创建 run 目录；

写入 run.yml 和 state.json；

生成第一个 step 的 artifact 目录；

生成 current-step.md。

目录示例：

```text
.zigma-flow/runs/20260603-0001/
  run.yml
  state.json
  current-step.md
  artifacts/
    01-intake/
      input.md
```

验收标准：

每次 run 创建独立目录；

state.json 记录 current_step；

run.yml 记录原始 task、workflow、创建时间；

current-step.md 可直接交给 Agent 使用。

### FR-004 状态管理

命令：

```bash
zigma-flow status
```

功能：

显示当前 run 状态；

显示当前 step；

显示每一步状态；

显示最近一次 check 结果；

显示下一步操作建议。

状态枚举：

```text
pending
running
passed
failed
blocked
skipped
cancelled
```

run 状态枚举：

```text
created
running
completed
failed
cancelled
```

验收标准：

状态只能由 zigma-flow 修改；

Agent 不应被要求修改 state.json；

手动修改 state.json 导致格式错误时，工具应报错并停止推进。

### FR-005 当前步骤提示词生成

命令：

```bash
zigma-flow prompt
```

功能：

根据当前 workflow step 和 run state 生成 current-step.md；

提示词只包含当前 step 必要信息；

包含输入材料列表；

包含允许动作和禁止动作；

包含输出文件路径；

包含 report.json schema；

包含“完成当前步骤后停止”的要求。

current-step.md 基本结构：

```md
# 当前 Workflow Step

Workflow:
Run:
Step:
Role:

# 当前任务

# 输入材料

# 允许动作

# 禁止动作

# 输出要求

# report.json 格式

# 完成条件

# 完成后停止
```

验收标准：

提示词不得包含完整 workflow 的所有步骤细节；

提示词必须包含当前步骤输出路径；

提示词必须包含禁止修改 state 文件的要求；

提示词必须包含完成后停止的要求。

### FR-006 Artifact 管理

功能：

每个 step 拥有独立 artifact 目录；

每个 step 至少支持 output.md 和 report.json；

工具可根据 workflow 定义要求更多输出文件；

后续步骤通过 inputs 引用前序 artifact。

示例：

```text
artifacts/
  01-intake/
    input.md
    output.md
    report.json
  02-plan/
    input.md
    output.md
    report.json
```

验收标准：

工具自动创建当前 step 的 artifact 目录；

缺失必需 artifact 时 check 失败；

路径必须限制在当前 run 目录或项目允许范围内。

### FR-007 Gate 检查

命令：

```bash
zigma-flow check
```

功能：

检查当前 step 是否满足 gate 条件。

MVP 支持以下 gate：

文件存在检查；

report.json 合法 JSON 检查；

report.json 必填字段检查；

字段非空检查；

git diff 是否存在；

测试命令记录是否存在；

禁止修改路径检查；

禁止修改 state 文件检查。

示例 gate：

```yaml
gate:
  required_outputs:
    - output.md
    - report.json
  required_report_fields:
    - summary
    - risks
    - blocking_questions
  require_git_diff: false
```

验收标准：

检查通过时写入 check-result.json；

检查失败时列出失败项；

检查失败时不能进入下一步；

检查结果必须写入 Event Log。

### FR-008 步骤推进

命令：

```bash
zigma-flow next
```

功能：

确认当前 step 已通过 check；

将当前 step 状态改为 passed；

将下一个 step 状态改为 running；

生成下一步 current-step.md；

如果当前 step 是最后一步，则将 run 状态改为 completed。

验收标准：

未通过 check 不允许 next；

已经 completed 的 run 不允许 next；

next 必须更新 state.json；

next 必须记录事件。

### FR-009 重试当前步骤

命令：

```bash
zigma-flow retry
```

功能：

将当前 step 标记为 retrying 或 running；

保留旧 artifact；

创建 retry 记录；

重新生成 current-step.md；

可选清空当前 step 的 output.md 和 report.json。

验收标准：

retry 不应删除历史输出，除非用户显式指定；

retry 后 check 应基于最新输出；

历史失败原因应保留。

### FR-010 终止运行

命令：

```bash
zigma-flow abort
```

功能：

终止当前 run；

记录终止原因；

阻止后续 next；

保留所有 artifact。

验收标准：

abort 后状态为 cancelled；

cancelled run 不允许 check 和 next；

status 可以查看终止原因。

### FR-011 半自动 Agent 模式

功能：

MVP 不强制调用 Claude Code 或 Codex；

工具只生成 current-step.md；

用户手动让 Agent 读取并执行 current-step.md；

Agent 输出约定文件后，用户运行 check 和 next。

验收标准：

不依赖任何特定 Agent CLI；

在没有 Claude Code、Codex 的环境下也能完整使用；

能够作为通用 workflow runner 工作。

### FR-012 Git 状态检测

功能：

支持在 implement 等步骤检查 git diff；

支持检查是否修改了禁止路径；

支持检查是否存在未提交更改；

支持记录 changed_files。

验收标准：

在非 git 仓库下应给出清晰错误或跳过提示；

require_git_diff 为 true 时，无 diff 必须 check 失败；

禁止修改 `.zigma-flow/runs/*/state.json`。

### FR-013 内置 Workflow 模板

MVP 至少内置一个 workflow：

```text
code-change-basic
```

步骤：

```text
intake
plan
implement
verify
summarize
```

每一步职责：

intake：只理解任务，不修改代码；

plan：只制定计划，不修改代码；

implement：只按计划修改代码；

verify：只验证修改；

summarize：只总结交付结果。

验收标准：

init 后自动生成该模板；

该模板可以直接运行；

模板中每一步都有明确 gate。

### FR-014 事件日志

功能：

每次关键操作写入 event log。

事件包括：

run_created；

prompt_generated；

check_started；

check_passed；

check_failed；

step_advanced；

step_retried；

run_completed；

run_cancelled。

事件文件：

```text
.zigma-flow/runs/<run_id>/events.jsonl
```

验收标准：

每行一个 JSON event；

event 必须包含 timestamp、type、run_id；

check 失败原因必须记录。

## 9. Workflow YAML 规范

MVP 版 workflow 文件结构如下：

```yaml
name: code-change-basic
version: 0.1.0
description: "基础代码修改 workflow"

inputs:
  task:
    required: true
  repository:
    default: "."

global_constraints:
  - "不要修改主分支"
  - "不要跳过当前步骤"
  - "每一步完成后必须停止"
  - "不要修改 .zigma-flow/runs 下的状态文件"

steps:
  - id: intake
    title: "任务理解"
    role: "Task Analyst"
    prompt: |
      你只负责理解任务，不要修改代码。
      请输出任务摘要、目标、风险、待确认问题。
    allowed_actions:
      - read_files
      - search
    forbidden_actions:
      - edit_files
      - run_tests
    outputs:
      - output.md
      - report.json
    report_schema:
      required:
        - summary
        - goals
        - risks
        - blocking_questions
    gate:
      required_outputs:
        - output.md
        - report.json
      required_report_fields:
        - summary
        - goals
        - risks
        - blocking_questions

  - id: plan
    title: "修改计划"
    role: "Planner"
    prompt: |
      你只负责制定修改计划，不要修改代码。
    inputs:
      - step:intake/output.md
    allowed_actions:
      - read_files
      - search
    forbidden_actions:
      - edit_files
    outputs:
      - output.md
      - report.json
    report_schema:
      required:
        - files_to_modify
        - implementation_steps
        - test_plan
        - rollback_plan
    gate:
      required_outputs:
        - output.md
        - report.json
      required_report_fields:
        - files_to_modify
        - implementation_steps
        - test_plan
        - rollback_plan

  - id: implement
    title: "代码实现"
    role: "Implementer"
    prompt: |
      你只负责按照计划修改代码，不要扩大需求范围。
    inputs:
      - step:plan/output.md
    allowed_actions:
      - read_files
      - edit_files
      - run_commands
    forbidden_actions:
      - change_workflow_state
    outputs:
      - output.md
      - report.json
    report_schema:
      required:
        - changed_files
        - implementation_summary
        - deviations
    gate:
      required_outputs:
        - output.md
        - report.json
      required_report_fields:
        - changed_files
        - implementation_summary
        - deviations
      require_git_diff: true

  - id: verify
    title: "验证"
    role: "Tester"
    prompt: |
      你只负责验证修改。
      请运行测试或说明无法运行的原因。
    inputs:
      - step:implement/output.md
    allowed_actions:
      - read_files
      - run_commands
    outputs:
      - output.md
      - report.json
    report_schema:
      required:
        - commands_run
        - results
        - failures
        - confidence
    gate:
      required_outputs:
        - output.md
        - report.json
      required_report_fields:
        - commands_run
        - results
        - failures
        - confidence

  - id: summarize
    title: "交付总结"
    role: "Reporter"
    prompt: |
      你只负责总结本次任务。
      请输出面向人类审阅者的变更说明、验证结果和风险提示。
    inputs:
      - step:intake/output.md
      - step:plan/output.md
      - step:implement/output.md
      - step:verify/output.md
    allowed_actions:
      - read_files
    forbidden_actions:
      - edit_source_files
    outputs:
      - output.md
      - report.json
    report_schema:
      required:
        - final_summary
        - changed_files
        - verification_summary
        - remaining_risks
    gate:
      required_outputs:
        - output.md
        - report.json
      required_report_fields:
        - final_summary
        - changed_files
        - verification_summary
        - remaining_risks
```

## 10. 当前步骤提示词规范

Zigma Flow 生成的 current-step.md 应满足以下原则：

只包含当前 step 的信息；

包含必要输入 artifact 的路径；

包含本步骤允许动作；

包含本步骤禁止动作；

包含输出文件路径；

包含 report.json 格式要求；

禁止 Agent 修改 state 文件；

要求 Agent 完成后停止；

不要包含完整 workflow 的所有后续流程。

示例：

```md
# 当前 Workflow Step

Workflow: code-change-basic
Run: 20260603-0001
Step: implement
Role: Implementer

# 当前任务

修复 CSV 导入编码检测问题。

# 你的职责

你只负责按照计划修改代码。不要重新规划需求，不要提前执行验证总结阶段。

# 输入材料

请读取：

- .zigma-flow/runs/20260603-0001/artifacts/02-plan/output.md

# 允许动作

- 读取项目文件
- 修改项目文件
- 运行必要命令

# 禁止动作

- 不要修改 .zigma-flow/runs/20260603-0001/state.json
- 不要修改 workflow.yml
- 不要跳到 verify 或 summarize 阶段
- 不要扩大需求范围

# 输出要求

必须写入：

- .zigma-flow/runs/20260603-0001/artifacts/03-implement/output.md
- .zigma-flow/runs/20260603-0001/artifacts/03-implement/report.json

report.json 必须是合法 JSON，并包含：

{
  "changed_files": [],
  "implementation_summary": "",
  "deviations": []
}

# 完成条件

完成代码修改，写入 output.md 和 report.json。

# 完成后停止

完成当前步骤后停止，不要进入下一阶段。
```

## 11. 系统架构设计

MVP 采用本地单进程 CLI 架构。

```text
CLI Layer
  ↓
Command Handlers
  ↓
Workflow Loader
State Store
Prompt Builder
Gate Checker
Artifact Manager
Git Inspector
Event Logger
```

模块说明：

CLI Layer：解析命令和参数。

Workflow Loader：读取并校验 workflow YAML。

State Store：读写 state.json、run.yml。

Prompt Builder：生成 current-step.md。

Gate Checker：执行步骤检查。

Artifact Manager：创建目录、解析 step 输入输出路径。

Git Inspector：读取 git diff、changed files、仓库状态。

Event Logger：写入 events.jsonl。

未来可以加入 Agent Adapter：

```text
Agent Adapter
  Claude Code Adapter
  Codex Adapter
  Shell Adapter
```

但 MVP 首先使用 Manual Adapter，即生成提示词文件，由用户手动交给 Agent。

## 12. 数据目录设计

项目根目录下：

```text
.zigma-flow/
  config.json
  workflows/
    code-change-basic.yml
  runs/
    20260603-0001/
      run.yml
      state.json
      current-step.md
      events.jsonl
      check-result.json
      artifacts/
        01-intake/
          input.md
          output.md
          report.json
        02-plan/
          input.md
          output.md
          report.json
        03-implement/
          input.md
          output.md
          report.json
        04-verify/
          input.md
          output.md
          report.json
        05-summarize/
          input.md
          output.md
          report.json
```

run.yml 示例：

```yaml
run_id: 20260603-0001
workflow: code-change-basic
workflow_version: 0.1.0
task: "修复 CSV 导入编码检测问题"
repository: "."
created_at: "2026-06-03T10:00:00+08:00"
```

state.json 示例：

```json
{
  "run_id": "20260603-0001",
  "workflow": "code-change-basic",
  "status": "running",
  "current_step": "implement",
  "steps": {
    "intake": {
      "status": "passed"
    },
    "plan": {
      "status": "passed"
    },
    "implement": {
      "status": "running"
    },
    "verify": {
      "status": "pending"
    },
    "summarize": {
      "status": "pending"
    }
  }
}
```

check-result.json 示例：

```json
{
  "run_id": "20260603-0001",
  "step": "implement",
  "status": "failed",
  "checks": [
    {
      "name": "required_output_exists",
      "passed": true
    },
    {
      "name": "report_required_fields",
      "passed": true
    },
    {
      "name": "git_diff_exists",
      "passed": false,
      "message": "require_git_diff is true, but no git diff was found."
    }
  ]
}
```

## 13. CLI 命令设计

MVP 命令集：

```bash
zigma-flow init
zigma-flow validate <workflow>
zigma-flow run <workflow-name> --task "<task>"
zigma-flow status
zigma-flow prompt
zigma-flow check
zigma-flow next
zigma-flow retry
zigma-flow abort
zigma-flow list-runs
zigma-flow show <run-id>
```

可选增强命令：

```bash
zigma-flow clean
zigma-flow export-summary
zigma-flow inspect-artifacts
zigma-flow doctor
```

命令行为要求：

所有命令默认作用于当前 active run；

active run 可以记录在 `.zigma-flow/config.json`；

用户可以通过 `--run <run-id>` 指定历史 run；

命令失败时必须返回非零退出码；

错误信息要说明原因和修复建议。

## 14. 非功能需求

稳定性：

工具不能因为 Agent 输出不完整而崩溃；

YAML 或 JSON 格式错误时应给出明确错误；

check 失败不应破坏已有状态。

可审计性：

每次状态变更必须写入 events.jsonl；

每次 check 结果必须可回溯；

artifact 不应被自动删除。

可移植性：

支持 Windows、Linux、macOS；

路径处理必须跨平台；

避免依赖特定 shell。

可扩展性：

workflow schema 应保留扩展字段；

gate checker 应采用插件式结构；

Agent Adapter 应可插拔；

未来可增加 Docker、PR、邮件等能力。

可读性：

生成的 current-step.md 必须适合人类阅读；

workflow YAML 应尽量接近自然语言；

错误信息应避免只有堆栈。

安全性：

禁止 Agent 修改 state.json；

禁止 workflow outputs 使用危险路径，例如 `../../`；

禁止默认删除项目文件；

retry 不应默认覆盖历史 artifact；

abort 不应删除运行记录。

## 15. 技术选型

建议使用 TypeScript 实现 CLI。理由是开发速度快，生态适合 YAML、JSON、CLI、文件系统和 git 集成，也贴近你现有 DataCat / Node.js 技术栈。

推荐依赖：

commander：CLI 命令解析；

yaml：读取 workflow；

zod：校验 workflow、state、report；

fs-extra：文件系统操作；

execa：未来调用 Agent CLI 或测试命令；

simple-git：读取 git diff 和 changed files；

chalk：终端输出；

ora：可选的命令行状态提示；

vitest：单元测试；

tsup：打包 CLI；

eslint + prettier：代码规范。

项目结构：

```text
src/
  cli.ts
  commands/
    init.ts
    validate.ts
    run.ts
    status.ts
    prompt.ts
    check.ts
    next.ts
    retry.ts
    abort.ts
  workflow/
    loadWorkflow.ts
    workflowSchema.ts
    resolveWorkflow.ts
  run/
    createRun.ts
    loadRun.ts
    loadState.ts
    saveState.ts
    activeRun.ts
  prompt/
    buildStepPrompt.ts
    renderMarkdown.ts
  gate/
    checkStep.ts
    checkTypes.ts
    checks/
      requiredOutputs.ts
      reportJson.ts
      requiredFields.ts
      gitDiff.ts
      forbiddenPaths.ts
  artifact/
    artifactPaths.ts
    prepareStepArtifacts.ts
  git/
    inspectGit.ts
  events/
    appendEvent.ts
    eventTypes.ts
  utils/
    pathSafe.ts
    errors.ts
```

## 16. 开发计划

### 阶段 1：CLI 骨架与项目初始化

目标：

建立 TypeScript CLI 项目，完成基础命令结构。

任务：

创建 npm package；

配置 TypeScript；

配置 tsup 构建；

配置 vitest；

实现 `zigma-flow --help`；

实现 `zigma-flow init`；

生成 `.zigma-flow/` 目录；

生成示例 workflow；

生成 config.json。

交付物：

可执行 CLI；

基础目录初始化；

示例 workflow 文件；

基础单元测试。

验收标准：

本地可以通过 `npm link` 或 `pnpm link` 使用 zigma-flow；

执行 init 后目录结构正确；

重复 init 不破坏已有文件。

### 阶段 2：Workflow Loader 与 Schema 校验

目标：

让工具可以读取并校验 workflow YAML。

任务：

设计 workflow zod schema；

实现 YAML 读取；

实现 workflow 名称解析；

实现 `validate` 命令；

实现错误报告格式；

为非法 workflow 编写测试用例。

交付物：

workflow loader；

workflow validator；

示例合法 workflow；

示例非法 workflow 测试。

验收标准：

合法 workflow 通过；

缺少关键字段时报错；

重复 step id 报错；

outputs 路径不安全时报错。

### 阶段 3：Run 创建与状态管理

目标：

支持创建一次 workflow run，并维护 state.json。

任务：

实现 run_id 生成；

实现 run 目录创建；

实现 run.yml；

实现 state.json；

实现 active run 记录；

实现 `run` 命令；

实现 `status` 命令；

实现基础 event log。

交付物：

Run 创建流程；

状态展示；

events.jsonl。

验收标准：

运行 `zigma-flow run` 后生成完整 run 目录；

status 能显示当前步骤；

events.jsonl 记录 run_created。

### 阶段 4：Prompt Builder

目标：

根据当前 step 生成 current-step.md。

任务：

实现输入 artifact 路径解析；

实现 allowed_actions / forbidden_actions 渲染；

实现 report schema 渲染；

实现 current-step.md 写入；

实现 `prompt` 命令；

为 code-change-basic 生成完整步骤提示词。

交付物：

Prompt Builder；

current-step.md；

对应测试。

验收标准：

prompt 只包含当前 step 信息；

提示词包含输出路径；

提示词包含 report.json 要求；

提示词包含完成后停止的约束。

### 阶段 5：Artifact 管理与 Gate Checker

目标：

检查当前步骤输出是否满足 workflow gate。

任务：

实现 artifact 目录创建；

实现 required_outputs 检查；

实现 report.json 合法性检查；

实现 required_report_fields 检查；

实现字段非空检查；

实现 check-result.json；

实现 `check` 命令；

实现 check event。

交付物：

Gate Checker 基础版；

check-result.json；

失败原因输出。

验收标准：

缺失 output.md 时 check 失败；

report.json 非法时 check 失败；

缺少必填字段时 check 失败；

通过时状态可被 next 使用。

### 阶段 6：步骤推进与重试

目标：

实现 workflow step 推进、重试和终止。

任务：

实现 `next`；

实现 `retry`；

实现 `abort`；

实现 completed 状态；

实现状态合法性检查；

实现错误状态保护。

交付物：

完整手动运行闭环。

验收标准：

check 未通过时 next 失败；

check 通过后 next 进入下一步；

最后一步通过后 run completed；

retry 保留历史记录；

abort 后不能继续推进。

### 阶段 7：Git 检查能力

目标：

支持代码修改类 workflow 的基本检查。

任务：

集成 simple-git；

实现 git diff 检查；

实现 changed files 读取；

实现 require_git_diff gate；

实现 forbidden_paths 检查；

阻止 Agent 修改 `.zigma-flow/runs/*/state.json`。

交付物：

Git Inspector；

git 相关 gate。

验收标准：

implement 阶段无 diff 时 check 失败；

修改禁止路径时 check 失败；

changed_files 可以输出到检查结果。

### 阶段 8：内置 code-change-basic Workflow 打磨

目标：

让第一个 workflow 可用于真实项目 dogfood。

任务：

完善 intake prompt；

完善 plan prompt；

完善 implement prompt；

完善 verify prompt；

完善 summarize prompt；

优化 report schema；

补充 README 使用说明；

用一个小型真实任务测试。

交付物：

稳定的 code-change-basic.yml；

README；

示例 run 记录。

验收标准：

完整跑通五个阶段；

Agent 不需要读取完整复杂 Skill；

每一步都有 output.md 和 report.json；

summarize 能生成可读交付总结。

### 阶段 9：工具自用与反馈修正

目标：

将 Zigma Flow 用于真实 DataCat 或相关项目任务，验证效果。

测试指标：

Agent 是否跳步；

Agent 是否提前进入后续阶段；

Agent 是否稳定输出 report.json；

上下文长度是否显著降低；

任务失败后是否更容易定位问题；

workflow 是否比原复杂 Skill 更稳定。

根据反馈调整：

workflow schema；

prompt 格式；

gate 规则；

默认 workflow；

错误信息；

状态管理。

## 17. MVP 成功标准

MVP 成功不以功能数量衡量，而以是否解决原始痛点衡量。

核心成功标准：

复杂 Skill 拆成 workflow 后，Agent 明显减少跳步行为；

Agent 每一步能稳定产出约定 artifact；

用户能从 state 和 artifact 中复盘执行过程；

任务失败时可以重试当前步骤，无需重跑全部流程；

code-change-basic workflow 可以在真实项目中完成至少一次有效代码修改；

用户主观感受上，流程可控性高于长 Skill 提示词。

## 18. 主要风险与应对

风险一：Agent 仍然不按 current-step.md 写文件。

应对：在提示词中明确输出路径；check 失败后 retry；未来可加入文件模板预创建。

风险二：workflow YAML 过于复杂，使用成本高。

应对：先内置少量模板；用户主要复制修改模板；后续再做生成器。

风险三：Gate Checker 只能做形式检查，无法判断内容质量。

应对：MVP 先验证流程稳定性；内容质量由用户和后续 LLM Judge 扩展解决。

风险四：手动模式操作繁琐。

应对：先换取简单可靠；验证有效后加入 Agent Adapter 自动执行。

风险五：工具本身变成新负担。

应对：严格限制 MVP 范围，避免邮件、Docker、多 Agent、PR 集成提前进入。

## 19. 后续演进方向

MVP 验证通过后，可以按以下方向演进。

第一，Agent Adapter。支持自动调用 Claude Code、Codex 或其他 CLI Agent。

第二，Git Branch 集成。每次 run 自动创建独立分支。

第三，PR 集成。workflow 完成后自动创建 PR，并把 summarize 输出写入 PR 描述。

第四，虚拟邮件。将 step 间交接、阻塞问题、上下文请求抽象为 message。

第五，上下文预算。限制每一步可读取文件数、搜索次数和上下文大小。

第六，Docker Workspace。为每次 run 创建隔离容器环境。

第七，Skill Registry。把 workflow 和 prompt 版本化管理。

第八，Zigma Core。将本地 workflow runner 扩展为服务端 Agent 编排系统。

## 20. 第一版 README 摘要草案

可以在仓库 README 中这样介绍：

````md
# Zigma Flow

Zigma Flow is a local workflow harness for coding agents.

It converts complex agent skills into executable workflows. Instead of giving a long skill document to an agent and hoping it follows every instruction, Zigma Flow keeps the workflow state outside the model context. Each step generates a short prompt, declares required outputs, and passes through gate checks before the next step starts.

## Why

Long-context coding agents may ignore workflow constraints in complex skills. Zigma Flow reduces this risk by splitting a skill into explicit steps such as intake, plan, implement, verify, and summarize.

## Basic Usage

```bash
zigma-flow init
zigma-flow run code-change-basic --task "Fix CSV import encoding detection"
zigma-flow prompt
zigma-flow check
zigma-flow next
````

## Core Idea

Workflow state belongs to the tool.
Current-step execution belongs to the agent.
Progression belongs to gate checks.

```

## 21. 结论

Zigma Flow 的当前版本应保持非常小：

读取 workflow；

创建 run；

生成当前步骤提示词；

保存 artifact；

执行 gate 检查；

推进、重试、终止步骤；

内置一个 code-change-basic workflow。

这已经足够验证你的关键判断：把复杂 Agent Skill 拆成外部 workflow，能否缓解长上下文注意力弱点导致的流程失效问题。

从工程价值上看，这个 MVP 很适合作为 Zigma 的第一块基石。它先解决你当前最真实、最棘手的问题，同时沉淀出未来 Zigma 所需的 WorkItem、Artifact、Gate、Context Package、Workflow State 等核心抽象。
```
