# Zigma Flow PRD

文档版本：v0.2
日期：2026-06-03
项目阶段：MVP 设计
项目定位：本地 Agent Workflow Runner / Workflow Harness
暂定名称：Zigma Flow
备用名称：Zigma Workflow Harness、Zigma Skill Runner

## 1. 产品背景

当前在使用 Claude Code、Codex 等编程 Agent 时，复杂 Agent Skill 通常以长提示词、长文档或多段流程说明的形式存在。随着上下文增长，模型会出现注意力衰减，导致它忽略 Skill 中明确指定的工作流程，例如跳过需求理解、提前修改代码、未执行验证、未输出检查报告，或者把多个阶段混在一起完成。

上一版设计将 workflow 简化为线性 steps，可以快速验证提示词分段和 gate 检查，但会带来三个结构性问题：

1. 复用能力弱。一个 workflow 内的 step 很难被其他 workflow 复用。
2. 无法自然表达并行任务。代码地图、风险扫描、文档约束读取等任务本应在 intake 后并行展开。
3. 无法区分“大流程”和“小技能”。完整流程、阶段任务、复合动作、单个 Agent 能力都混在 step 概念里。

Zigma Flow v0.2 将核心抽象调整为类似 GitHub Actions 的 Workflow、Job、Step 分层，并引入 Skill 作为最小可复用 Agent 能力单元。工具负责维护 workflow run、job run、step run 状态，Agent 每次只接收当前 step 的短提示词、输入材料、允许动作、禁止动作和交付格式。

Zigma Flow 是未来 Zigma 的局部原型。它优先验证一个核心假设：复杂 Agent 工作流的可靠性，可以通过外部 workflow 分解、DAG 状态管理、上下文裁剪和 gate 检查显著提升。

## 2. 产品定位

Zigma Flow 是一个本地命令行工具，用于将复杂 Agent 工作流程拆解为可执行、可审计、可重试的 workflow。

它面向个人开发者和小型项目维护者，尤其适合在已有项目中辅助 Claude Code、Codex 或其他编程 Agent 执行复杂任务。

它当前不做邮件系统、多租户、权限平台、Docker 沙箱、PR 自动创建、MCP 服务调度和企业级代码平台集成。当前目标是小而稳定地验证 workflow 化 Agent Skill 的效果。

一句话定义：

Zigma Flow 是一个面向编程 Agent 的本地 workflow runner，它用外部状态机、job 依赖、step 提示词和 gate 检查机制，将复杂 Agent 流程拆成可控、可审计、可重试的简单执行单元。

## 3. 核心抽象

Zigma Flow v0.2 采用以下分层：

```text
Workflow
  Job
    Step
      uses Skill
      uses Composite Skill
      run Prompt
  Job
    uses Reusable Workflow
```

核心概念如下：

Workflow：完整流程，可以包含多个 job。Workflow 可以直接运行，也可以在后续阶段作为 reusable workflow 被其他 workflow 调用。

Job：可独立调度的阶段性任务单元。Job 之间通过 `needs` 建立依赖关系。没有依赖关系的 job 可以并行执行。

Step：job 内部的顺序执行单元。Step 可以调用 Skill、Composite Skill，也可以使用内联 prompt。

Skill：最小可复用 Agent 能力单元，类似函数或 action。Skill 声明 inputs、outputs、prompt、gate、permissions。

Composite Skill：由多个 step 组成的复合动作，适合复用较小的顺序过程。它在外层 workflow 中表现为单个 step。

Reusable Workflow：可被其他 workflow 调用的完整流程。它可以包含多个 jobs、steps、并行和依赖关系，适合复用复杂流程。

Gate：完成检查。工具通过 gate 判断当前 step 是否满足输出要求，是否可以推进。

Artifact：执行输出文件和结构化报告。

Run / Job Run / Step Run：一次 workflow、job、step 的执行实例。

不要把所有可复用对象都命名为 Skill。Skill 应保留为最小 Agent 能力函数；完整流程应称为 Workflow；复合动作应称为 Composite Skill。

## 4. 产品目标

核心目标有五个。

第一，降低复杂 Skill 被模型忽略的概率。流程规则写入 workflow 文件，由工具负责推进，模型只处理当前 step。

第二，缩短单次 Agent 输入上下文。每一步只包含当前任务、必要输入、输出要求和局部约束。

第三，形成可审计的任务执行记录。每个 run、job、step 都有输入、输出、报告、状态和检查结果。

第四，支持结构化并行。job 层通过 `needs` 表达 DAG，允许多个 ready job 同时存在。

第五，验证未来 Zigma 的核心架构方向。即使用外部工程对象和状态机治理 Agent 上下文，而不依赖长对话持续记忆。

## 5. 非目标范围

MVP 阶段不实现以下能力：

真实多 Agent 自动调度；

真正并发执行 ready jobs；

Composite Skill 执行；

Reusable Workflow 执行；

Matrix；

Secrets；

自动发送邮件或虚拟邮件；

自动创建 Issue、PR、Project；

Docker 隔离执行环境；

MCP 服务编排；

企业权限系统；

Web UI；

向量数据库检索；

复杂 LLM Judge；

完整 Zigma OS 发行版。

这些能力可以作为未来 Zigma Core 的演进方向，但不进入当前 MVP。

## 6. 目标用户

第一类用户是项目开发者。用户希望用 Claude Code、Codex 等 Agent 处理复杂开发任务，但希望 Agent 按固定流程执行。

第二类用户是 Skill 设计者。用户已经积累了一些复杂 Agent Skill，希望将长提示词改造成结构化 workflow、skills 和 gates。

第三类用户是项目维护者。用户希望每次 Agent 执行都有阶段报告、检查点和可回溯记录，方便复盘和改进。

## 7. 典型使用场景

场景一：代码修改任务。

用户希望 Agent 修复一个 bug。workflow 可以拆成 intake、code-map、risk-scan、plan、implement、verify、summarize。`code-map` 和 `risk-scan` 都依赖 `intake`，但互相不依赖，因此在 DAG 中可以并行 ready。Agent 在 intake 阶段只能理解任务，在 plan 阶段只能制定计划，在 implement 阶段才能修改代码，在 verify 阶段才能测试。

场景二：代码审查任务。

用户希望 Agent 审查一个 PR。workflow 可以拆成 diff intake、policy check、risk scan、test impact、review comments、final decision。多个检查 job 可以并行展开，再汇总为最终审查结论。

场景三：长文档解读任务。

用户希望 Agent 解读一篇复杂文档。workflow 可以拆成目录识别、章节摘要、概念提取、问题生成、逐问题分析、结论合成、文章撰写。每个 job 保存 artifact，后续 step 只读取必要中间结果。

场景四：复杂 Skill 迁移。

用户已有一个长 Skill，例如“高级代码修改流程”。Zigma Flow 可以把它拆为 workflow YAML 和多个 skill YAML，使流程约束由工具执行，提示词只保留当前 step 指令。

## 8. 核心执行流程

Zigma Flow 的基本执行流程如下：

```text
用户创建 workflow 和 skills
    ↓
zigma-flow run 创建一次 workflow run
    ↓
工具计算 DAG 状态，找出 ready jobs
    ↓
zigma-flow prompt --job <job-id> 生成当前 job 当前 step 提示词
    ↓
用户或脚本将提示词交给 Claude Code / Codex
    ↓
Agent 执行当前 step 并写入约定输出
    ↓
zigma-flow check --job <job-id> 检查输出
    ↓
检查通过后 zigma-flow next --job <job-id> 推进 step 或完成 job
    ↓
下游 job 的 needs 满足后进入 ready
    ↓
所有 jobs 完成后生成 run summary
```

MVP 首先采用半自动模式。工具生成提示词，Agent 执行方式由用户控制。MVP 可以先不真正并发执行，但状态模型必须按 job DAG 设计。也就是说，`zigma-flow status` 可以显示多个 ready jobs，用户可以选择推进其中一个。

## 9. 文件组织

推荐目录结构：

```text
.zigma-flow/
  config.json
  workflows/       # 可直接 run 的完整流程，也可在未来被 workflow_call 调用
    code-change.yml
    pr-review.yml
  skills/          # 最小可复用 Skill
    task-intake.yml
    code-map.yml
    risk-scan.yml
    implementation-plan.yml
    implement-by-plan.yml
    verify-change.yml
    summarize-delivery.yml
  actions/         # Composite Skill，MVP 预留
    basic-analysis.yml
  runs/            # 执行记录
```

复用层级对应如下：

```text
GitHub Actions          Zigma Flow
workflow                workflow
job                     job
step                    step
action                  skill
composite action        composite skill
reusable workflow       reusable workflow
```

## 10. 功能需求

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
  skills/
  actions/
  runs/
  config.json
```

生成内置示例 workflow 和 skills：

```text
.zigma-flow/workflows/code-change.yml
.zigma-flow/skills/task-intake.yml
.zigma-flow/skills/code-map.yml
.zigma-flow/skills/risk-scan.yml
.zigma-flow/skills/implementation-plan.yml
.zigma-flow/skills/implement-by-plan.yml
.zigma-flow/skills/verify-change.yml
.zigma-flow/skills/summarize-delivery.yml
```

验收标准：

重复执行 init 不应破坏已有 workflow、skill 和 run 数据；

如果目录已存在，应提示已初始化；

config.json 必须包含工具版本和默认配置。

### FR-002 Workflow 定义加载

命令：

```bash
zigma-flow validate .zigma-flow/workflows/code-change.yml
```

功能：

读取 YAML workflow 定义；

校验必填字段；

校验 `jobs` 结构；

校验 job id 唯一；

校验 `needs` 引用的 job 存在；

校验 DAG 不存在循环依赖；

校验每个 job 至少包含 `steps` 或 job-level `uses` 之一；

校验每个 step 的 `uses` 或 `run`；

校验 skill 引用存在；

校验 outputs、gate、permissions 和 artifact 路径安全。

验收标准：

合法 workflow 可以通过校验；

缺少 name、jobs、job.steps、step.id 等关键字段时必须报错；

重复 job id 或 step id 必须报错；

`needs` 指向不存在 job 必须报错；

循环依赖必须报错；

输出路径非法时必须报错。

### FR-003 Skill 定义加载

命令：

```bash
zigma-flow validate .zigma-flow/skills/task-intake.yml
```

功能：

读取 YAML skill 定义；

校验 `kind: skill`；

校验 inputs、outputs、prompt、permissions、gate；

校验 output 映射路径；

校验 report schema；

校验 gate required fields。

验收标准：

合法 skill 可以通过校验；

缺少 name、version、kind、prompt、outputs、gate 时必须报错；

skill 输出字段必须能从 report 或文件中解析；

权限字段必须属于已知枚举。

### FR-004 创建 Run

命令：

```bash
zigma-flow run code-change --task "修复 CSV 导入编码检测问题"
```

功能：

基于 workflow 创建一次运行实例；

生成唯一 run_id；

创建 run 目录；

写入 run.yml 和 state.json；

初始化所有 job 状态；

将无依赖 job 标记为 ready；

为第一个 ready job 的当前 step 准备 artifact 目录；

生成可选的 current-step.md。

目录示例：

```text
.zigma-flow/runs/20260603-0001/
  run.yml
  state.json
  current-step.md
  events.jsonl
  jobs/
    intake/
      state.json
      steps/
        intake/
          input.md
```

验收标准：

每次 run 创建独立目录；

state.json 记录所有 jobs 的 DAG 状态；

run.yml 记录原始 task、workflow、创建时间；

初始 ready jobs 由 `needs` 计算得到；

current-step.md 可直接交给 Agent 使用。

### FR-005 状态管理

命令：

```bash
zigma-flow status
```

功能：

显示当前 run 状态；

显示所有 job 状态；

显示每个 job 的当前 step；

显示 ready jobs；

显示 waiting jobs 的阻塞依赖；

显示最近一次 check 结果；

显示下一步操作建议。

job / step 状态枚举：

```text
pending
waiting
ready
running
passed
failed
blocked
skipped
cancelled
completed
```

run 状态枚举：

```text
created
running
completed
failed
cancelled
```

状态示例：

```text
Run: 20260603-0001
Status: running

Jobs:
  intake       completed
  code-map     ready
  risk-scan    ready
  plan         waiting: code-map, risk-scan
  implement    pending
  verify       pending
  summarize    pending

Ready jobs:
  code-map
  risk-scan
```

验收标准：

状态只能由 zigma-flow 修改；

Agent 不应被要求修改 state.json；

手动修改 state.json 导致格式错误时，工具应报错并停止推进。

### FR-006 当前 Step 提示词生成

命令：

```bash
zigma-flow prompt --job code-map
```

功能：

根据当前 workflow、job、step 和 run state 生成 current-step.md；

提示词只包含当前 step 必要信息；

包含输入材料列表；

包含允许动作和禁止动作；

包含输出文件路径；

包含 report.json schema；

包含“完成当前 step 后停止”的要求。

current-step.md 基本结构：

```md
# 当前 Workflow Step

Workflow:
Run:
Job:
Step:
Skill:
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

提示词必须包含当前 job 和 step；

提示词必须包含当前 step 输出路径；

提示词必须包含禁止修改 state 文件的要求；

提示词必须包含完成后停止的要求。

### FR-007 Artifact 管理

功能：

每个 job 拥有独立 job run 目录；

每个 step 拥有独立 step run 目录；

每个 step 至少支持 output.md 和 report.json；

工具可根据 skill 或 inline step 定义要求更多输出文件；

后续 job / step 通过表达式引用前序 outputs。

示例：

```text
jobs/
  intake/
    state.json
    steps/
      intake/
        prompt.md
        output.md
        report.json
        check-result.json
  code-map/
    state.json
    steps/
      map/
        prompt.md
        output.md
        report.json
        check-result.json
```

验收标准：

工具自动创建当前 step 的 artifact 目录；

缺失必需 artifact 时 check 失败；

路径必须限制在当前 run 目录或项目允许范围内。

### FR-008 Gate 检查

命令：

```bash
zigma-flow check --job code-map
```

功能：

检查指定 job 当前 step 是否满足 gate 条件。

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

检查通过时写入该 step 的 check-result.json；

检查失败时列出失败项；

检查失败时不能推进 step 或完成 job；

检查结果必须写入 event log。

### FR-009 Job / Step 推进

命令：

```bash
zigma-flow next --job code-map
```

功能：

确认指定 job 当前 step 已通过 check；

如果 job 内还有下一个 step，则推进到下一个 step；

如果当前 step 是 job 最后一步，则将 job 状态改为 completed；

计算下游 jobs 的 `needs` 是否全部 completed；

将满足依赖的下游 job 标记为 ready；

如果所有 jobs completed，则将 run 状态改为 completed。

验收标准：

未通过 check 不允许 next；

waiting 或 pending job 不允许 next；

已经 completed 的 job 不允许 next；

next 必须更新 state.json；

next 必须记录事件。

### FR-010 重试当前 Step

命令：

```bash
zigma-flow retry --job code-map
```

功能：

将指定 job 当前 step 标记为 retrying 或 running；

保留旧 artifact；

创建 retry 记录；

重新生成 prompt；

可选清空当前 step 的 output.md 和 report.json。

验收标准：

retry 不应删除历史输出，除非用户显式指定；

retry 后 check 应基于最新输出；

历史失败原因应保留。

### FR-011 终止运行

命令：

```bash
zigma-flow abort
```

功能：

终止当前 run；

记录终止原因；

阻止后续 check 和 next；

保留所有 artifact。

验收标准：

abort 后 run 状态为 cancelled；

cancelled run 不允许继续推进；

status 可以查看终止原因。

### FR-012 半自动 Agent 模式

功能：

MVP 不强制调用 Claude Code 或 Codex；

工具只生成 current-step.md；

用户手动让 Agent 读取并执行 current-step.md；

Agent 输出约定文件后，用户运行 check 和 next。

验收标准：

不依赖任何特定 Agent CLI；

在没有 Claude Code、Codex 的环境下也能完整使用；

能够作为通用 workflow runner 工作。

### FR-013 Git 状态检测

功能：

支持在 implement 等 step 检查 git diff；

支持检查是否修改了禁止路径；

支持检查是否存在未提交更改；

支持记录 changed_files。

验收标准：

在非 git 仓库下应给出清晰错误或跳过提示；

require_git_diff 为 true 时，无 diff 必须 check 失败；

禁止修改 `.zigma-flow/runs/*/state.json`。

### FR-014 内置 Workflow 与 Skills

MVP 至少内置一个 workflow：

```text
code-change
```

jobs：

```text
intake
code-map
risk-scan
plan
implement
verify
summarize
```

依赖关系：

```text
intake
  ├─ code-map
  └─ risk-scan
       ↓
      plan
       ↓
   implement
       ↓
     verify
       ↓
   summarize
```

注意：`code-map` 和 `risk-scan` 都依赖 `intake`，但它们之间没有依赖，因此可以同时进入 ready。MVP 可先手动选择执行顺序，不需要真实并发。

验收标准：

init 后自动生成该 workflow 和所需 skills；

该 workflow 可以直接运行；

每个 skill 都有明确 inputs、outputs、permissions、gate。

### FR-015 事件日志

功能：

每次关键操作写入 event log。

事件包括：

run_created；

job_ready；

prompt_generated；

check_started；

check_passed；

check_failed；

step_advanced；

job_completed；

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

job / step 相关事件必须包含 job_id 和 step_id；

check 失败原因必须记录。

## 11. Workflow YAML 规范

Workflow YAML 采用 Workflow、Job、Step 三层结构。

示例：`.zigma-flow/workflows/code-change.yml`

```yaml
name: code-change
version: 0.2.0
description: "基础代码修改 workflow"

on:
  manual:
    inputs:
      task:
        type: string
        required: true
      repository:
        type: string
        default: "."

permissions:
  contents: read
  edits: none
  commands: none
  workflow-state: none

defaults:
  runner: manual-agent
  artifact_dir: ".zigma-flow/runs/${{ run.id }}/jobs"

jobs:
  intake:
    name: "Task Intake"
    steps:
      - id: intake
        uses: skill://task-intake@v1
        with:
          task: "${{ inputs.task }}"
          repository: "${{ inputs.repository }}"

  code-map:
    name: "Code Map"
    needs: intake
    steps:
      - id: map
        uses: skill://code-map@v1
        with:
          task_summary: "${{ jobs.intake.outputs.summary }}"
          repository: "${{ inputs.repository }}"

  risk-scan:
    name: "Risk Scan"
    needs: intake
    steps:
      - id: scan
        uses: skill://risk-scan@v1
        with:
          task_summary: "${{ jobs.intake.outputs.summary }}"
          repository: "${{ inputs.repository }}"

  plan:
    name: "Implementation Plan"
    needs:
      - intake
      - code-map
      - risk-scan
    steps:
      - id: plan
        uses: skill://implementation-plan@v1
        with:
          task_summary: "${{ jobs.intake.outputs.summary }}"
          code_map: "${{ jobs.code-map.outputs.code_map }}"
          risks: "${{ jobs.risk-scan.outputs.risks }}"

  implement:
    name: "Implementation"
    needs: plan
    permissions:
      contents: read
      edits: write
      commands: limited
      workflow-state: none
    steps:
      - id: implement
        uses: skill://implement-by-plan@v1
        with:
          plan: "${{ jobs.plan.outputs.plan }}"

  verify:
    name: "Verification"
    needs: implement
    permissions:
      contents: read
      edits: none
      commands: limited
      workflow-state: none
    steps:
      - id: verify
        uses: skill://verify-change@v1
        with:
          changed_files: "${{ jobs.implement.outputs.changed_files }}"
          test_plan: "${{ jobs.plan.outputs.test_plan }}"

  summarize:
    name: "Delivery Summary"
    needs:
      - intake
      - plan
      - implement
      - verify
    steps:
      - id: summarize
        uses: skill://summarize-delivery@v1
        with:
          task_summary: "${{ jobs.intake.outputs.summary }}"
          plan: "${{ jobs.plan.outputs.plan }}"
          changed_files: "${{ jobs.implement.outputs.changed_files }}"
          verification: "${{ jobs.verify.outputs.verification }}"
```

## 12. Skill YAML 规范

Skill 是最小可复用 Agent 能力单元。它不关心自己处于哪个 workflow，只关心输入、输出、权限、prompt 和 gate。

示例：`.zigma-flow/skills/task-intake.yml`

```yaml
name: task-intake
version: 1.0.0
kind: skill

description: "理解用户任务，提取目标、风险、待确认问题。"

inputs:
  task:
    type: string
    required: true
  repository:
    type: string
    default: "."

outputs:
  summary:
    type: string
    from: report.summary
  goals:
    type: array
    from: report.goals
  risks:
    type: array
    from: report.risks
  blocking_questions:
    type: array
    from: report.blocking_questions

permissions:
  contents: read
  edits: none
  commands: none
  workflow-state: none

prompt: |
  你只负责理解任务，不要修改代码，也不要制定实现方案。

  请基于输入任务，输出：
  1. 任务摘要
  2. 明确目标
  3. 可能风险
  4. 阻塞性问题

  如果没有阻塞性问题，blocking_questions 输出空数组。

report:
  schema:
    type: object
    required:
      - summary
      - goals
      - risks
      - blocking_questions
    properties:
      summary:
        type: string
      goals:
        type: array
      risks:
        type: array
      blocking_questions:
        type: array

gate:
  required_outputs:
    - output.md
    - report.json
  required_report_fields:
    - summary
    - goals
    - risks
    - blocking_questions
```

示例：`.zigma-flow/skills/implement-by-plan.yml`

```yaml
name: implement-by-plan
version: 1.0.0
kind: skill

description: "严格按照计划进行代码修改。"

inputs:
  plan:
    type: string
    required: true

outputs:
  changed_files:
    type: array
    from: report.changed_files
  implementation_summary:
    type: string
    from: report.implementation_summary
  deviations:
    type: array
    from: report.deviations

permissions:
  contents: read
  edits: write
  commands: limited
  workflow-state: none

prompt: |
  你只负责按照输入计划修改代码。

  必须遵守：
  1. 不要扩大需求范围
  2. 不要重新设计 workflow
  3. 不要修改 .zigma-flow/runs 下的状态文件
  4. 如果发现计划不可执行，请停止并在 deviations 中说明原因

report:
  schema:
    type: object
    required:
      - changed_files
      - implementation_summary
      - deviations
    properties:
      changed_files:
        type: array
      implementation_summary:
        type: string
      deviations:
        type: array

gate:
  required_outputs:
    - output.md
    - report.json
  required_report_fields:
    - changed_files
    - implementation_summary
    - deviations
  require_git_diff: true
  forbidden_paths:
    - ".zigma-flow/runs/**/state.json"
    - ".zigma-flow/workflows/**"
    - ".zigma-flow/skills/**"
```

## 13. Step 执行方式

Step 支持三种形式。

第一种，调用 Skill：

```yaml
- id: intake
  uses: skill://task-intake@v1
  with:
    task: "${{ inputs.task }}"
```

第二种，调用 Composite Skill：

```yaml
- id: analysis
  uses: action://basic-analysis@v1
  with:
    task: "${{ inputs.task }}"
```

第三种，内联 prompt：

```yaml
- id: custom-note
  run: |
    请阅读前面的分析结果，输出一个简短的人工审阅提示。
  outputs:
    note:
      from: report.note
```

MVP 优先实现 `uses: skill://` 和 `run:`。`action://` 可以第二阶段实现，`workflow://` 可以作为 job-level uses 第三阶段实现。

## 14. Composite Skill 设计

Composite Skill 用于复用一组 step。它类似 GitHub composite action，在调用者看来是一个 step，但内部可以展开多个子 step。

示例：`.zigma-flow/actions/basic-analysis.yml`

```yaml
name: basic-analysis
version: 1.0.0
kind: composite-skill

description: "对任务进行基础分析，输出任务摘要、代码地图和风险扫描。"

inputs:
  task:
    type: string
    required: true
  repository:
    type: string
    default: "."

outputs:
  summary:
    value: "${{ steps.intake.outputs.summary }}"
  code_map:
    value: "${{ steps.code-map.outputs.code_map }}"
  risks:
    value: "${{ steps.risk-scan.outputs.risks }}"

steps:
  - id: intake
    uses: skill://task-intake@v1
    with:
      task: "${{ inputs.task }}"
      repository: "${{ inputs.repository }}"

  - id: code-map
    uses: skill://code-map@v1
    with:
      task_summary: "${{ steps.intake.outputs.summary }}"
      repository: "${{ inputs.repository }}"

  - id: risk-scan
    uses: skill://risk-scan@v1
    with:
      task_summary: "${{ steps.intake.outputs.summary }}"
      repository: "${{ inputs.repository }}"
```

MVP 可以先不实现 Composite Skill。因为它被视为 job 内 step，语义上顺序执行更简单。如果需要并行，应提升为 reusable workflow。

## 15. Reusable Workflow 设计

Reusable Workflow 适合复用一套完整流程，里面可以包含多个 jobs、并行和依赖关系。

示例：`.zigma-flow/workflows/reusable-basic-code-change.yml`

```yaml
name: reusable-basic-code-change
version: 1.0.0

on:
  workflow_call:
    inputs:
      task:
        type: string
        required: true
      repository:
        type: string
        default: "."
    outputs:
      changed_files:
        value: "${{ jobs.implement.outputs.changed_files }}"
      verification:
        value: "${{ jobs.verify.outputs.verification }}"
      summary:
        value: "${{ jobs.summarize.outputs.final_summary }}"

jobs:
  analyze:
    steps:
      - id: analysis
        uses: action://basic-analysis@v1
        with:
          task: "${{ inputs.task }}"
          repository: "${{ inputs.repository }}"

  plan:
    needs: analyze
    steps:
      - id: plan
        uses: skill://implementation-plan@v1
        with:
          task_summary: "${{ jobs.analyze.outputs.summary }}"
          code_map: "${{ jobs.analyze.outputs.code_map }}"
          risks: "${{ jobs.analyze.outputs.risks }}"
```

主 workflow 可通过 job-level `uses` 调用：

```yaml
jobs:
  code-change:
    uses: workflow://reusable-basic-code-change@v1
    with:
      task: "${{ inputs.task }}"
      repository: "."
```

MVP 只在 schema 和命名上预留 reusable workflow，不实现执行。

## 16. 表达式与上下文

Zigma Flow 需要最小表达式系统，用于连接输入输出。

MVP 支持字符串插值，不实现完整表达式语言。

最小上下文：

```text
${{ inputs.task }}
${{ inputs.repository }}
${{ run.id }}
${{ jobs.intake.outputs.summary }}
${{ steps.plan.outputs.test_plan }}
${{ env.NAME }}
```

MVP 支持上下文：

```text
inputs
run
jobs
steps
env
```

后续可增加：

```text
secrets
matrix
vars
github
zigma
```

`secrets` MVP 阶段禁用。

## 17. 当前 Step 提示词规范

Zigma Flow 生成的 current-step.md 应满足以下原则：

只包含当前 job / step 的信息；

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

Workflow: code-change
Run: 20260603-0001
Job: implement
Step: implement
Skill: implement-by-plan@v1
Role: Implementer

# 当前任务

修复 CSV 导入编码检测问题。

# 你的职责

你只负责按照计划修改代码。不要重新规划需求，不要提前执行验证总结阶段。

# 输入材料

请读取：

- .zigma-flow/runs/20260603-0001/jobs/plan/steps/plan/output.md

# 允许动作

- 读取项目文件
- 修改项目文件
- 运行必要命令

# 禁止动作

- 不要修改 .zigma-flow/runs/20260603-0001/state.json
- 不要修改 .zigma-flow/runs/20260603-0001/jobs/**/state.json
- 不要修改 workflow 或 skill 定义
- 不要跳到 verify 或 summarize 阶段
- 不要扩大需求范围

# 输出要求

必须写入：

- .zigma-flow/runs/20260603-0001/jobs/implement/steps/implement/output.md
- .zigma-flow/runs/20260603-0001/jobs/implement/steps/implement/report.json

report.json 必须是合法 JSON，并包含：

{
  "changed_files": [],
  "implementation_summary": "",
  "deviations": []
}

# 完成条件

完成代码修改，写入 output.md 和 report.json。

# 完成后停止

完成当前 step 后停止，不要进入下一阶段。
```

## 18. 系统架构设计

MVP 采用本地单进程 CLI 架构。

```text
CLI Layer
  ↓
Command Handlers
  ↓
Workflow Loader
Skill Loader
DAG Resolver
State Store
Prompt Builder
Gate Checker
Artifact Manager
Expression Resolver
Git Inspector
Event Logger
```

模块说明：

CLI Layer：解析命令和参数。

Workflow Loader：读取并校验 workflow YAML。

Skill Loader：读取并校验 skill YAML。

DAG Resolver：解析 job needs，计算 ready / waiting 状态。

State Store：读写 run-level state.json、job-level state.json、run.yml。

Prompt Builder：生成 current-step.md 和 step prompt.md。

Gate Checker：执行 step 检查。

Artifact Manager：创建目录、解析 step 输入输出路径。

Expression Resolver：解析 `${{ ... }}` 字符串插值。

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

## 19. 数据目录设计

项目根目录下：

```text
.zigma-flow/
  config.json
  workflows/
    code-change.yml
  skills/
    task-intake.yml
    code-map.yml
    risk-scan.yml
    implementation-plan.yml
    implement-by-plan.yml
    verify-change.yml
    summarize-delivery.yml
  actions/
  runs/
    20260603-0001/
      run.yml
      state.json
      current-step.md
      events.jsonl
      jobs/
        intake/
          state.json
          steps/
            intake/
              prompt.md
              output.md
              report.json
              check-result.json
        code-map/
          state.json
          steps/
            map/
              prompt.md
              output.md
              report.json
              check-result.json
        risk-scan/
          state.json
          steps/
            scan/
              prompt.md
              output.md
              report.json
              check-result.json
        plan/
          state.json
          steps/
            plan/
              prompt.md
              output.md
              report.json
              check-result.json
```

run.yml 示例：

```yaml
run_id: 20260603-0001
workflow: code-change
workflow_version: 0.2.0
task: "修复 CSV 导入编码检测问题"
repository: "."
created_at: "2026-06-03T10:00:00+08:00"
```

state.json 示例：

```json
{
  "run_id": "20260603-0001",
  "workflow": "code-change",
  "status": "running",
  "jobs": {
    "intake": {
      "status": "completed",
      "needs": [],
      "outputs": {
        "summary": "..."
      }
    },
    "code-map": {
      "status": "ready",
      "needs": ["intake"],
      "current_step": "map"
    },
    "risk-scan": {
      "status": "ready",
      "needs": ["intake"],
      "current_step": "scan"
    },
    "plan": {
      "status": "waiting",
      "needs": ["intake", "code-map", "risk-scan"],
      "waiting_for": ["code-map", "risk-scan"]
    }
  }
}
```

check-result.json 示例：

```json
{
  "run_id": "20260603-0001",
  "job": "implement",
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

## 20. CLI 命令设计

MVP 命令集：

```bash
zigma-flow init
zigma-flow validate <path>
zigma-flow run <workflow-name> --task "<task>"
zigma-flow status
zigma-flow prompt --job <job-id>
zigma-flow check --job <job-id>
zigma-flow next --job <job-id>
zigma-flow retry --job <job-id>
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

当只有一个 ready job 时，`prompt`、`check`、`next` 可以省略 `--job`；

当存在多个 ready job 时，必须显式指定 `--job`；

命令失败时必须返回非零退出码；

错误信息要说明原因和修复建议。

## 21. 非功能需求

稳定性：

工具不能因为 Agent 输出不完整而崩溃；

YAML 或 JSON 格式错误时应给出明确错误；

check 失败不应破坏已有状态；

DAG 状态计算必须可重复、可恢复。

可审计性：

每次状态变更必须写入 events.jsonl；

每次 check 结果必须可回溯；

artifact 不应被自动删除；

job / step 输出应能追溯到具体 run。

可移植性：

支持 Windows、Linux、macOS；

路径处理必须跨平台；

避免依赖特定 shell。

可扩展性：

workflow schema 应保留 composite skill 和 reusable workflow 扩展位置；

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

## 22. 技术选型

建议使用 TypeScript 实现 CLI。理由是开发速度快，生态适合 YAML、JSON、CLI、文件系统和 git 集成。

推荐依赖：

commander：CLI 命令解析；

yaml：读取 workflow 和 skill；

zod：校验 workflow、skill、state、report；

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
  skill/
    loadSkill.ts
    skillSchema.ts
    resolveSkill.ts
  dag/
    validateDag.ts
    resolveReadyJobs.ts
    advanceJob.ts
  run/
    createRun.ts
    loadRun.ts
    loadState.ts
    saveState.ts
    activeRun.ts
  prompt/
    buildStepPrompt.ts
    renderMarkdown.ts
  expression/
    resolveExpression.ts
    buildContext.ts
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

## 23. 开发计划

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

生成示例 workflow 和 skills；

生成 config.json。

验收标准：

本地可以通过 `npm link` 或 `pnpm link` 使用 zigma-flow；

执行 init 后目录结构正确；

重复 init 不破坏已有文件。

### 阶段 2：Workflow / Skill Loader 与 Schema 校验

目标：

让工具可以读取并校验 workflow YAML 和 skill YAML。

任务：

设计 workflow zod schema；

设计 skill zod schema；

实现 YAML 读取；

实现 workflow 名称解析；

实现 skill 引用解析；

实现 `validate` 命令；

实现错误报告格式；

为非法 workflow / skill 编写测试用例。

验收标准：

合法 workflow 和 skill 通过；

缺少关键字段时报错；

重复 job id 或 step id 报错；

outputs 路径不安全时报错。

### 阶段 3：DAG 校验与 Run 创建

目标：

支持创建一次 workflow run，并初始化 job DAG 状态。

任务：

实现 job needs 校验；

实现循环依赖检测；

实现 run_id 生成；

实现 run 目录创建；

实现 run.yml；

实现 run-level state.json；

实现 job-level state.json；

实现 active run 记录；

实现 `run` 命令；

实现基础 event log。

验收标准：

运行 `zigma-flow run` 后生成完整 run 目录；

无依赖 job 自动进入 ready；

waiting job 能显示阻塞依赖；

events.jsonl 记录 run_created。

### 阶段 4：Status 与 Ready Job 显示

目标：

让用户清楚看到 DAG 状态和可执行 job。

任务：

实现 `status` 命令；

显示 run 状态；

显示 jobs 状态；

显示 ready jobs；

显示 waiting jobs 的 unmet needs；

显示当前 step；

显示最近 check 结果。

验收标准：

status 能显示多个 ready jobs；

status 能说明 plan 等待 code-map / risk-scan；

状态展示适合人工调度。

### 阶段 5：Prompt Builder

目标：

根据指定 job 的当前 step 生成 current-step.md。

任务：

实现输入 artifact 路径解析；

实现表达式上下文；

实现 skill prompt 渲染；

实现 inline run prompt 渲染；

实现 permissions 渲染；

实现 report schema 渲染；

实现 current-step.md 和 step prompt.md 写入；

实现 `prompt --job` 命令。

验收标准：

prompt 只包含当前 job / step 信息；

提示词包含输出路径；

提示词包含 report.json 要求；

提示词包含完成后停止的约束。

### 阶段 6：Artifact 管理与 Gate Checker

目标：

检查当前 step 输出是否满足 gate。

任务：

实现 step artifact 目录创建；

实现 required_outputs 检查；

实现 report.json 合法性检查；

实现 required_report_fields 检查；

实现字段非空检查；

实现 check-result.json；

实现 `check --job` 命令；

实现 check event。

验收标准：

缺失 output.md 时 check 失败；

report.json 非法时 check 失败；

缺少必填字段时 check 失败；

通过时状态可被 next 使用。

### 阶段 7：Job / Step 推进与 DAG 解锁

目标：

实现 step 推进、job 完成和下游 job 解锁。

任务：

实现 `next --job`；

实现 job 内 step 顺序推进；

实现 job completed；

实现下游 needs 计算；

实现 ready jobs 更新；

实现 run completed；

实现状态合法性检查。

验收标准：

check 未通过时 next 失败；

check 通过后 next 进入下一 step 或完成 job；

code-map 和 risk-scan 完成后 plan 进入 ready；

所有 jobs 完成后 run completed。

### 阶段 8：重试、终止与恢复

目标：

支持失败后的局部恢复。

任务：

实现 `retry --job`；

实现 `abort`；

保留历史 artifact；

记录 retry / abort event；

处理状态文件损坏时的错误提示。

验收标准：

retry 保留历史记录；

abort 后不能继续推进；

状态异常时工具停止并给出修复建议。

### 阶段 9：Git 检查能力

目标：

支持代码修改类 workflow 的基本检查。

任务：

集成 simple-git；

实现 git diff 检查；

实现 changed files 读取；

实现 require_git_diff gate；

实现 forbidden_paths 检查；

阻止 Agent 修改 `.zigma-flow/runs/*/state.json`。

验收标准：

implement 阶段无 diff 时 check 失败；

修改禁止路径时 check 失败；

changed_files 可以输出到检查结果。

### 阶段 10：内置 code-change Workflow 打磨

目标：

让第一个 workflow 可用于真实项目 dogfood。

任务：

完善 task-intake skill；

完善 code-map skill；

完善 risk-scan skill；

完善 implementation-plan skill；

完善 implement-by-plan skill；

完善 verify-change skill；

完善 summarize-delivery skill；

优化 report schema；

补充 README 使用说明；

用一个小型真实任务测试。

验收标准：

完整跑通 intake、code-map、risk-scan、plan、implement、verify、summarize；

Agent 不需要读取完整复杂 Skill；

每一步都有 output.md 和 report.json；

summarize 能生成可读交付总结。

### 阶段 11：工具自用与反馈修正

目标：

将 Zigma Flow 用于真实项目任务，验证效果。

测试指标：

Agent 是否跳步；

Agent 是否提前进入后续阶段；

Agent 是否稳定输出 report.json；

上下文长度是否显著降低；

多个 ready jobs 是否清晰可调度；

任务失败后是否更容易定位问题；

workflow 是否比原复杂 Skill 更稳定。

根据反馈调整：

workflow schema；

skill schema；

prompt 格式；

gate 规则；

默认 workflow；

错误信息；

状态管理。

## 24. MVP 分期边界

MVP 1：Workflow、Job、Step 基础结构。

实现 workflow YAML 解析、skill YAML 解析、jobs 解析、steps 顺序执行、job needs DAG 状态、step uses skill、step run inline prompt、prompt 生成、artifact 保存、gate 检查、job outputs、workflow outputs。

暂不实现真正并发执行、composite skill、reusable workflow、matrix、secrets、自动 Agent 调用。

MVP 2：并行 Ready Jobs 与手动调度。

实现多个 ready job、`zigma-flow prompt --job <job-id>`、`zigma-flow check --job <job-id>`、`zigma-flow next --job <job-id>`、job 全部完成后解锁下游 job、status 显示 DAG 状态。

MVP 3：Composite Skill。

实现 `action://xxx@v1`、composite 内部 steps、composite outputs、composite 作为单个 step 出现在外层 job。

MVP 4：Reusable Workflow。

实现 `on.workflow_call`、job-level `uses: workflow://xxx@v1`、workflow inputs / outputs、子 workflow run、嵌套调用深度限制。

## 25. MVP 成功标准

MVP 成功不以功能数量衡量，而以是否解决原始痛点衡量。

核心成功标准：

复杂 Skill 拆成 workflow 和 skills 后，Agent 明显减少跳步行为；

Agent 每一步能稳定产出约定 artifact；

用户能从 state 和 artifact 中复盘执行过程；

任务失败时可以重试当前 step，无需重跑全部流程；

code-change workflow 可以在真实项目中完成至少一次有效代码修改；

status 能清晰显示多个 ready jobs 和 waiting dependencies；

用户主观感受上，流程可控性高于长 Skill 提示词。

## 26. 主要风险与应对

风险一：Agent 仍然不按 current-step.md 写文件。

应对：在提示词中明确输出路径；check 失败后 retry；未来可加入文件模板预创建。

风险二：workflow YAML 和 skill YAML 过于复杂，使用成本高。

应对：先内置少量模板；用户主要复制修改模板；后续再做生成器。

风险三：DAG 状态引入实现复杂度。

应对：MVP 只做 job-level DAG，不做 step-level DAG；同一 job 内 steps 严格顺序执行；不做真实并发。

风险四：Gate Checker 只能做形式检查，无法判断内容质量。

应对：MVP 先验证流程稳定性；内容质量由用户和后续 LLM Judge 扩展解决。

风险五：手动模式操作繁琐。

应对：先换取简单可靠；验证有效后加入 Agent Adapter 自动执行。

风险六：工具本身变成新负担。

应对：严格限制 MVP 范围，避免邮件、Docker、多 Agent、PR 集成提前进入。

## 27. 后续演进方向

MVP 验证通过后，可以按以下方向演进。

第一，Agent Adapter。支持自动调用 Claude Code、Codex 或其他 CLI Agent。

第二，Composite Skill。将常见顺序 step 组合为可复用 action。

第三，Reusable Workflow。将完整流程作为 job-level callable workflow 复用。

第四，真正并发执行。自动并行执行多个 ready jobs。

第五，Git Branch 集成。每次 run 自动创建独立分支。

第六，PR 集成。workflow 完成后自动创建 PR，并把 summarize 输出写入 PR 描述。

第七，虚拟邮件。将 step 间交接、阻塞问题、上下文请求抽象为 message。

第八，上下文预算。限制每一步可读取文件数、搜索次数和上下文大小。

第九，Docker Workspace。为每次 run 创建隔离容器环境。

第十，Skill Registry。把 workflow、skill、composite skill 版本化管理。

第十一，Zigma Core。将本地 workflow runner 扩展为服务端 Agent 编排系统。

## 28. README 摘要草案

可以在仓库 README 中这样介绍：

````md
# Zigma Flow

Zigma Flow is a local workflow runner for coding agents.

It converts complex agent skills into executable workflows. Instead of giving a long skill document to an agent and hoping it follows every instruction, Zigma Flow keeps workflow state outside the model context. Each job and step generates a short prompt, declares required outputs, and passes through gate checks before downstream jobs can continue.

## Why

Long-context coding agents may ignore workflow constraints in complex skills. Zigma Flow reduces this risk by splitting a task into explicit jobs and steps such as intake, code-map, risk-scan, plan, implement, verify, and summarize.

## Basic Usage

```bash
zigma-flow init
zigma-flow run code-change --task "Fix CSV import encoding detection"
zigma-flow status
zigma-flow prompt --job intake
zigma-flow check --job intake
zigma-flow next --job intake
```

## Core Idea

Workflow state belongs to the tool.
Current-step execution belongs to the agent.
Progression belongs to gate checks.
Job dependencies belong to the workflow DAG.
````

## 29. 结论

Zigma Flow 不应只是线性步骤执行器，而应是一个轻量的 Agent Workflow Runner。

v0.2 采用 Workflow、Job、Step 三层模型；Step 通过 `uses` 调用 Skill；Job 通过 `needs` 表达依赖与并行；Skill 作为最小可复用 Agent 能力函数；Composite Skill 和 Reusable Workflow 作为后续扩展预留在 schema 和命名体系中。

MVP 仍然保持小范围：先实现 workflow、jobs、steps、skill call、needs DAG、手动 prompt 生成、artifact 保存和 gate check。Composite Skill 与 Reusable Workflow 可以放到后续阶段，但产品抽象从一开始就避免被线性 steps 锁死。

从工程价值上看，这个 MVP 更适合作为 Zigma 的第一块基石。它先解决当前最真实的问题：把复杂 Agent 工作流从长上下文里抽出来，交给外部状态机和可审计 artifact 管理，同时沉淀出未来 Zigma 所需的 Workflow、Job、Step、Skill、Gate、Artifact、Run 和 Context Package 等核心抽象。
