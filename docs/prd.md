# Zigma Flow PRD

文档版本：v0.3（含 v0.2 修订增量，2026-06-27）
日期：2026-06-06
项目阶段：MVP 已发布，v0.2 设计
项目定位：本地 Agent Workflow Runtime / Workflow Harness
暂定名称：Zigma Flow
备用名称：Zigma Workflow Harness、Zigma Agent Runtime

## 0. v0.2 修订说明（2026-06-27）

本 PRD 自 2026-06-06 起冻结为 v0.3 内容。MVP v0.1.0 发布后，v0.2 阶段在 P13 中引入三类 Agent 主动控制流能力，需要扩展若干 FR 与非目标条款。修订原则：

- **加法优先**：尽量保留原文，新增条款追加在节末或新章节中，不改动 v0.3 已有判定。
- **不改变"Engine 唯一写者"的核心精神**：Agent 仍不能直接修改 `state.json` 的状态机字段（job/step status、attempts、signals 注册表、last_event_id 等）。
- **新增"工作流数据层"**：v0.2 引入 `variables` 与 `context_blocks` 两个新命名空间，作为 Agent 可通过 Engine 入口修改的数据层；它们与状态机字段隔离。

涉及的修订点集中在：§3（Signal/Gate 解释）、§5（非目标范围措辞）、§FR-006、§FR-009、§FR-010、§FR-014、新增 §FR-016/§FR-017/§FR-018、§13（表达式上下文）、§22（成功标准）、§23（风险三）。每处修订都以"v0.2 修订"字样标记，便于检视。

具体设计落在 `docs/phases/v0.2-roadmap.md` 与 `docs/phases/p13-agent-adapter-hardening/02-development-plan.md`。

## 1. 产品背景

当前在使用 Claude Code、Codex 等编程 Agent 时，复杂 Agent Skill 通常以长提示词、长文档或多段流程说明的形式存在。随着上下文增长，模型会出现注意力衰减，导致它忽略 Skill 中明确指定的工作流程，例如跳过需求理解、提前修改代码、未执行验证、未输出检查报告，或者把多个阶段混在一起完成。

v0.1 将复杂 Skill 拆成线性 workflow steps，可以快速验证提示词分段和 gate 检查，但无法自然表达并行任务，也无法区分“大流程”和“小技能”。

v0.2 引入 Workflow、Job、Step、Skill 的分层，解决了线性 steps 的一部分问题。但它仍然把 Skill 设计成 YAML 级别的“可调用步骤”，本质上还是把 Skill 压缩成 workflow/action。

v0.3 进一步修正核心模型：

```text
Workflow = 状态机 + DAG
Step = 执行单元
Skill Pack = 能力包
Agent = 一种执行器
Artifact = 上下文载体
Signal = Agent 对流程变化的请求
Gate = Engine 对流程变化的裁决
```

Zigma Flow 不应只是“把长 Skill 拆成 YAML 步骤”的工具，而应是一个小型 Agent Workflow Runtime。它通过 Workflow、Job、Step 管理任务流程，通过 Skill Pack 管理可复用能力，通过 Script Step 和 Check Step 执行确定性任务，通过 Agent Step 执行需要模型判断的任务，并允许 Agent 通过结构化 outputs 和 signals 请求流程转向。

## 2. 产品定位

Zigma Flow 是一个面向 Agent 的本地 workflow harness。它用于将复杂 Agent 工作流程拆解为可执行、可审计、可回放、可重试的 workflow。

它面向个人开发者和小型项目维护者，尤其适合在已有项目中辅助 Claude Code、Codex 或其他编程 Agent 执行复杂任务。

它当前不做邮件系统、多租户权限平台、Docker 沙箱、PR 自动创建、MCP runtime、远程 Skill Registry 和企业级代码平台集成。当前目标是小而稳定地验证 workflow 化 Agent Runtime 的核心抽象。

一句话定义：

Zigma Flow 是一个本地 Agent Workflow Runtime，它用 Workflow 管流程，用 Step 执行动作，用 Skill Pack 提供能力，用 Artifact 承载上下文，用 Signal 表达流程意图，用 Gate 和 Engine 裁决状态转移。

## 3. 核心抽象

Zigma Flow v0.3 采用以下结构：

```text
Workflow
  Job
    Step
      Agent Step
      Script Step
      Check Step
      Router Step
      Workflow Step
      Human Gate Step

Skill Pack
  Knowledge
  Prompt Fragments
  Tools
  Scripts
  Checks
  Workflow Templates
  Agent Functions
  Policies
  Examples
```

Workflow：编排文件，负责流程结构、依赖关系、状态转移、并行、重试、失败处理和可选 job 激活。

Job：一组阶段性任务，可以依赖其他 job，也可以与其他 ready job 并行。Job 是 DAG 的节点。

Step：最小执行单元。Step 不限于 Agent，可以由 Agent、脚本、检查器、子 workflow、router 或人工审批执行。

Agent Step：需要 LLM 判断、规划、撰写、修改、审阅的步骤。Agent Step 生成 prompt，并暴露有限的 Skill Pack 资源、工具和函数给 Agent。

Script Step：固定命令或 Skill Pack 脚本，例如 lint、test、build、format、静态扫描、收集 diff。

Check Step：确定性结果判定，例如检查 report.json、检查 git diff、检查测试是否通过、检查禁止路径是否被修改。

Router Step：纯流程分支，不调用 Agent。Router 根据 outputs 或 signals 决定 continue、fail、block、retry job、activate job 或 goto job。

Workflow Step：调用另一个 workflow 或 workflow template。MVP 只预留语义，不实现完整嵌套 runtime。

Human Gate Step：等待用户确认、审批、补充需求或合并 PR。MVP 只预留语义。

Skill Pack：能力包。它不直接改变 workflow 状态，也不直接接管流程，只暴露知识、提示词、工具、脚本、检查器、workflow 模板、Agent functions、策略和示例。

Agent Function：Skill Pack 中可暴露给 Agent 的能力描述。它由 prompt、知识引用、输入输出 schema 和允许工具组成，不等于 runtime 中的任意函数调用。真正执行仍由 workflow runtime 管理。

Artifact：workflow 的真实上下文载体。测试日志、diff、构建产物和报告文件应作为 artifact 引用传递，而不是直接塞进 prompt 或 report.json。

Signal：Agent 对流程变化的结构化请求。Agent 可以请求 `needs_architecture_design`、`blocked`、`review_rejected` 等 signal，但不能直接修改 workflow 状态。

Gate：Engine 对流程变化的裁决。Workflow Engine 根据预声明规则、check 结果和 signal schema 决定是否推进、阻塞、重试或激活 optional job。

> **v0.2 修订（2026-06-27）：** 此处"不能直接修改 workflow 状态"特指 `state.json` 的状态机字段（job/step status、attempts、signals 注册表、last_event_id 等），这些仍只允许 Engine 写入。v0.2 在 P13 中新增"工作流数据层"——`variables` 与 `context_blocks` 两个命名空间，Agent 可通过 `report.context_patches` 修改它们，但仍需经 Engine 入口 `applyContextPatch` 校验权限、Schema 与批次原子性；状态机字段保持禁止 patch。
>
> 同时，v0.2 引入三种与 Engine 交互的结构化通道：
> - **Step Status Return**（见 §FR-016）：step 本地决策，触发预声明的 `on_return` action（含新增 `goto_step`）。
> - **Workflow Variables / Context Blocks**（见 §FR-017）：变量与上下文块的 patch 操作。
> - **Conditional / goto_step / Bounded Loops**（见 §FR-018）：step `if:`、router `goto_step`、step `max_visits`。
>
> 三者均不绕开 Engine，且 acceptAgentReport 按固定流水线顺序处理（context_patches → status → signals → advance）。

## 4. 产品目标

核心目标有七个。

第一，降低复杂 Skill 被模型忽略的概率。流程规则写入 workflow，由 engine 负责推进，Agent 只处理当前 step。

第二，缩短单次 Agent 输入上下文。Context Builder 只暴露当前 step 必要的 inputs、artifact 摘要、知识、工具、函数和 signals。

第三，形成可审计、可回放的执行记录。所有状态变化写入 event log，state.json 只是当前状态快照。

第四，支持结构化并行。job 层通过 `needs` 表达 DAG，多个 read-only ready jobs 可以并行调度。

第五，把确定性任务交给 script 和 check。lint、test、schema、diff、路径检查不应依赖 Agent 自觉执行。

第六，支持受控动态流程。Agent 只能输出 signal，engine 通过 optional job、router、retry 和 gate 处理流程变化。

第七，验证未来 Zigma 的核心架构方向：用外部工程对象、状态机、artifact 和 context builder 治理 Agent 行为，而不依赖长对话记忆。

## 5. 非目标范围

MVP 阶段不实现以下能力：

真正并发 Agent 执行；

真正动态生成新 job；

Agent 直接修改 workflow 状态；【v0.2 修订】此条限定为：Agent 直接修改 `state.json` 的状态机字段（jobs/signals/attempts/last_event_id 等）；v0.2 在 P13 中允许 Agent 通过 `report.context_patches` 修改新增的 `variables` 与 `context_blocks` 命名空间，但必须经 Engine 入口校验，Engine 仍是状态机字段的唯一写者。

任意循环、任意表达式、运行时 YAML patch；【v0.2 修订】仍禁止 `while`/`for` DSL 关键字与任意脚本执行；v0.2 引入 `goto_step`（同 job 跳转）与每 step `max_visits`（默认 3）作为有界循环安全阀，不构成"任意循环"。运行时 YAML patch 保持禁止——workflow 定义在 run 期间不可变；`variables` 与 `context_blocks` 只在 run state 层修改，不回写 workflow YAML。表达式仍限于 `${{ ... }}` 受限插值 + 等值/逻辑组合，不支持函数调用、算术、字符串拼接、JS 求值等任意表达式。

远程 Skill Registry；

自动多 Agent 调度；

邮件或虚拟邮件；

自动创建 Issue、PR、Project；

Docker 沙箱；

MCP runtime；

复杂权限系统；

Web UI；

复杂 LLM Judge；

完整 Zigma OS 发行版。

未来如果支持动态插入 Job，应设计为 `workflow_patch_request`，并要求 Planner Agent 或人工审批。

## 6. 目标用户

第一类用户是项目开发者。用户希望用 Claude Code、Codex 等 Agent 处理复杂开发任务，但希望 Agent 按固定流程执行，并把 lint、test、diff、路径检查等确定性任务交给工具。

第二类用户是 Skill Pack 设计者。用户已经积累了一些知识库、提示词、脚本和检查器，希望把它们打包成可复用能力，而不是塞进一个长 prompt。

第三类用户是项目维护者。用户希望每次 Agent 执行都有阶段报告、artifact、event log、状态快照和可回放记录，方便复盘和改进。

## 7. 典型使用场景

场景一：代码修改任务。

用户希望 Agent 修复一个 bug。Workflow 可以拆成 intake、code-map、risk-scan、plan、implement、static-check、unit-test、review、summarize。Agent Step 负责理解、规划、实现和审阅；Script Step 执行 lint/test；Check Step 验证 report、diff 和禁止路径；Router Step 根据 review decision 决定继续、打回 implement retry，或激活 architecture-design optional job。

场景二：架构设计缺失。

Agent 在 plan 或 review 阶段发现缺少架构约束，输出 `needs_architecture_design` signal。Workflow Engine 不允许 Agent 任意插入 job，而是激活 workflow 中预声明的 `architecture-design` optional job。该 job 完成后，plan 或 implement 按预定义规则重试。

场景三：审阅失败打回。

review job 输出 `decision: rejected` 和 comments。Router Step 将 implement job 置为 retrying，并附加 `retry.inputs.review_comments`。implement job 保留 previous attempts，最多 retry 3 次，超过后进入 blocked。

场景四：复杂 Skill 迁移。

用户已有一个长 Skill，例如“高级代码修改流程”。Zigma Flow 将它拆为 workflow YAML 和 Skill Pack：workflow 负责编排，Skill Pack 负责提供知识、prompt、工具、脚本、检查器和 Agent functions。

## 8. 核心执行流程

Zigma Flow 的基本执行流程如下：

```text
用户创建 workflow 和 Skill Packs
    ↓
zigma-flow run 创建 workflow run
    ↓
Engine 解析 DAG、Skill Pack manifest、signals、optional jobs
    ↓
Engine 计算 ready jobs 和当前 step
    ↓
Agent Step: Context Builder 生成 prompt，用户或 Adapter 交给 Agent
Script Step: Engine 执行命令并保存 stdout/stderr/exit_code artifacts
Check Step: Engine 执行确定性检查并写入 check-result
Router Step: Engine 根据 outputs/signals 处理流程分支
    ↓
Engine 收集 outputs、artifacts、signals 和 events
    ↓
Engine 推进 step、完成 job、激活 optional job、retry job 或阻塞 run
    ↓
所有 required jobs completed 后生成 run summary
```

MVP 首先采用半自动 Agent 模式。Agent Step 只生成 prompt，由用户手动交给 Claude Code / Codex。Script Step、Check Step、Router Step 由 Zigma Flow 本地执行。

## 9. 文件组织

推荐目录结构：

```text
.zigma-flow/
  config.json
  skill-lock.json
  workflows/
    code-change.yml
  skills/
    code-change/
      skill.yml
      knowledge/
        coding-guidelines.md
        common-failure-patterns.md
      prompts/
        implement.md
        review.md
        summarize.md
      scripts/
        collect-diff.ts
      checks/
        report-schema.json
        forbidden-paths.yml
      workflows/
        bugfix-template.yml
      examples/
        simple-bugfix.md
  runs/
```

`skill-lock.json` 用于锁定 Skill Pack 版本和内容 hash，保证同一个 workflow 下次运行时使用相同能力包。

示例：

```json
{
  "skills": {
    "zigma.code-change": {
      "version": "1.0.0",
      "resolved": "local://skills/code-change",
      "hash": "sha256:..."
    }
  }
}
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
  runs/
  config.json
  skill-lock.json
```

生成内置示例 workflow 和 Skill Pack：

```text
.zigma-flow/workflows/code-change.yml
.zigma-flow/skills/code-change/skill.yml
.zigma-flow/skills/code-change/knowledge/coding-guidelines.md
.zigma-flow/skills/code-change/prompts/implement.md
.zigma-flow/skills/code-change/prompts/review.md
.zigma-flow/skills/code-change/scripts/collect-diff.ts
.zigma-flow/skills/code-change/checks/report-schema.json
.zigma-flow/skills/code-change/checks/forbidden-paths.yml
```

验收标准：

重复执行 init 不应破坏已有 workflow、Skill Pack、lockfile 和 run 数据；

如果目录已存在，应提示已初始化；

config.json 必须包含工具版本和默认配置；

skill-lock.json 必须记录内置 Skill Pack 的 local resolved path 和 hash。

### FR-002 Workflow 定义加载

命令：

```bash
zigma-flow validate .zigma-flow/workflows/code-change.yml
```

功能：

读取 YAML workflow 定义；

校验 name、version、on、skills、permissions、signals、jobs；

校验 workflow 顶层 `skills` 引用的 Skill Pack 存在且 lockfile 可解析；

校验 job id 唯一；

校验 `needs`、`optional_needs` 引用的 job 存在；

校验 DAG 不存在循环依赖；

校验 optional job 必须声明 `activation: optional`；

校验每个 step 的 `type` 属于 `agent`、`script`、`check`、`router`、`workflow`、`human`；

校验 Agent Step 的 `expose` 只能引用 workflow 顶层声明的 skills；

校验 Script Step 和 Check Step 的 `uses` 指向 Skill Pack 中已导出的 scripts/checks；

校验 Router Step 的控制流只使用 MVP 允许动作；

校验 retry max_attempts；

校验 outputs、artifacts 和 paths 安全。

验收标准：

合法 workflow 可以通过校验；

缺少关键字段时报错；

重复 job id 或 step id 必须报错；

`needs` 指向不存在 job 必须报错；

循环依赖必须报错；

Agent Step 暴露未声明 Skill Pack 必须报错；

Router Step 使用未支持控制流必须报错；

输出路径非法时必须报错。

### FR-003 Skill Pack manifest 加载

命令：

```bash
zigma-flow validate .zigma-flow/skills/code-change/skill.yml
```

功能：

读取 Skill Pack manifest；

校验 `kind: skill-pack`；

校验 exports：knowledge、prompts、tools、scripts、checks、functions、workflow_templates、policies、examples；

校验所有 path 存在且位于 Skill Pack 目录内；

校验 scripts 的 runtime、inputs、outputs；

校验 checks 的 kind 和 path；

校验 functions 的 prompt、knowledge、tools、inputs、outputs；

校验 policies 的 default_permissions。

验收标准：

合法 Skill Pack 可以通过校验；

Skill Pack 不允许声明 workflow 状态转移；

缺少 id、name、version、kind 时必须报错；

manifest 引用不存在文件必须报错；

manifest 引用 pack 外部路径必须报错。

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

记录 Skill Pack lockfile 快照；

初始化所有 required jobs、optional jobs 和 step 状态；

将无依赖 required job 标记为 ready；

将 optional job 标记为 inactive；

为第一个 ready job 的当前 step 准备 artifact 目录；

写入 run_created、job_ready events。

验收标准：

每次 run 创建独立目录；

state.json 记录所有 jobs 的 DAG 状态、activation、attempt 和 current_step；

run.yml 记录原始 task、workflow、创建时间和 skill lock 快照；

optional job 默认 inactive；

初始 ready jobs 由 `needs` 计算得到。

### FR-005 状态管理

命令：

```bash
zigma-flow status
```

功能：

显示当前 run 状态；

显示所有 job 状态、activation、attempt、current step；

显示 ready jobs；

显示 inactive optional jobs；

显示 waiting jobs 的阻塞依赖；

显示最近一次 check、script、router、signal 结果；

显示下一步操作建议。

run 状态枚举：

```text
created
running
blocked
completed
failed
cancelled
```

job 状态枚举：

```text
pending
waiting
ready
running
completed
failed
blocked
skipped
inactive
cancelled
retrying
```

step 状态枚举：

```text
pending
running
completed
failed
skipped
retrying
```

验收标准：

状态只能由 Zigma Flow 修改；

Agent 不应被要求修改 state.json；

state.json 损坏时工具应报错并停止推进；

event log 应包含足够信息用于未来重建 state.json。

### FR-006 Context Builder 与 Agent Prompt

命令：

```bash
zigma-flow prompt --job plan
```

功能：

只针对 Agent Step 生成 prompt；

根据 step `expose` 字段生成 Agent 可见能力清单；

包含当前职责；

包含当前输入；

包含输出 schema；

包含 artifact 摘要；

包含可用知识；

包含可用工具；

包含可调用 Agent functions；

包含可发出的 workflow signals；

包含权限和禁止动作；

包含“完成当前 step 后停止”的要求。

【v0.2 修订】Context Builder 还需注入以下内容（仅当 step 声明对应权限时）：

- **可读变量清单**：来自 workflow 顶层 `variables` 段，按 `step.permissions.variables.read` 白名单过滤后展示当前值。
- **可写变量声明**：按 `step.permissions.variables.write` 白名单告知 Agent 可通过 `report.context_patches` 修改哪些变量。
- **上下文块内容**：来自 workflow 顶层 `context_blocks` 段，按 `step.permissions.context_blocks.read` 白名单注入当前版本内容；按 `step.permissions.context_blocks.write` 告知可写性。
- **结构化返回状态约束**：如果 step 声明了 `returns.status`，必须告知 Agent 允许的 status 值及对应 on_return 行为，便于 Agent 做出合规决策。

提示词示例片段：

```md
# 可用 Skill Pack 能力

你可以使用以下能力：

1. code.implement-by-plan
   用途：按照实现计划修改代码
   输入：plan
   输出：changed_files, summary, deviations

2. project.architecture-rules
   用途：查询项目架构约束

# 可发出的 workflow signals

你可以在 report.json 中输出 signals：

- needs_architecture_design
  当任务缺少必要架构设计时使用

- blocked
  当任务无法继续且需要人工输入时使用

注意：你不能直接修改 workflow 状态。Workflow Engine 会根据 signals 决定下一步。
```

验收标准：

prompt 不包含完整 workflow 的所有步骤细节；

prompt 只暴露 step `expose` 允许的 Skill Pack 资源；

prompt 必须说明 Agent 不能直接修改 workflow 状态；

prompt 必须包含输出路径和 report schema；

prompt 必须包含完成后停止的要求。

### FR-007 Script Step 执行

功能：

执行 workflow 中声明的 script step；

支持 inline command；

支持调用 Skill Pack scripts；

支持 timeout、cwd、env、capture stdout/stderr、exit_code；

保存 stdout/stderr 为 artifact；

将结果映射到 step outputs；

根据 `allow_failure` 或 `on_failure` 决定状态。

示例：

```yaml
- id: lint
  type: script
  run: "pnpm lint"
  shell: bash
  timeout: 300s
  cwd: "."
  env:
    NODE_ENV: test
  capture:
    stdout: true
    stderr: true
  outputs:
    exit_code: result.exit_code
    log: result.stdout
  on_failure:
    status: failed
```

验收标准：

命令超时必须终止并记录失败；

stdout/stderr 必须保存为 artifact；

exit_code 必须记录到 report 或 result；

MVP 至少支持 timeout、cwd、exit_code、stdout/stderr capture。

### FR-008 Check Step 与 Gate

功能：

执行确定性检查，不依赖 LLM Judge。

MVP 支持：

文件存在检查；

JSON 合法性检查；

JSON Schema 检查；

必填字段检查；

字段非空检查；

git diff 是否存在；

测试命令是否通过；

禁止路径是否被修改；

敏感 state 文件是否被修改；

只读 step 是否修改了工作区。

示例：

```yaml
- id: check-report
  type: check
  uses: code.checks.report-schema
  with:
    file: "${{ steps.plan.artifacts.report }}"
  on_pass:
    continue
  on_fail:
    retry_job: plan
```

验收标准：

检查通过时写入 check-result artifact；

检查失败时列出失败项；

检查失败时按 on_fail 处理；

基础 gate 不依赖 LLM Judge。

### FR-009 Router Step 与受控流程分支

功能：

根据 outputs 或 signals 执行纯流程分支；

MVP 只允许以下控制流：

```text
continue
fail
block
retry_job
activate_job
goto_job
goto_step          # v0.2 新增（P13）
```

【v0.2 修订】`goto_step` 限制：

- 目标 step 必须存在于**当前 job** 内；跨 job 跳转使用既有 `goto_job`。
- 触发时写入 `step_revisited` 事件；目标 step 状态重置为 `pending`，job 的 `current_step` 指向目标 step。
- 与每 step `max_visits`（默认 3，详见 §FR-018）协同工作，作为环路安全阀。
- attempt 数不因 `goto_step` 增加（attempt 是 job 级别的概念）。

暂不支持：

```text
while
for
arbitrary script expression
agent-generated job definition
runtime YAML patch
nested dynamic DAG mutation
```

示例：

```yaml
- id: route-review
  type: router
  switch: "${{ steps.review.outputs.decision }}"
  cases:
    approved:
      continue
    rejected:
      retry_job: implement
      retry_with:
        review_comments: "${{ steps.review.outputs.comments }}"
    needs_architecture_design:
      activate_job: architecture-design
    default:
      status: failed
```

验收标准：

Router Step 不调用 Agent；

Router Step 不允许任意表达式副作用；

Router Step 只能执行预定义控制流动作；

所有 router 决策必须写入 event log。

### FR-010 Signal 机制

功能：

workflow 顶层声明 signal schema；

Agent Step 可以在 report.json 输出 signals；

Engine 校验 signal 是否允许从当前 job/step 发出；

Engine 根据 signal 的 severity、priority 和 action 处理流程；

当多个 signal 同时出现时，按优先级处理。

【v0.2 修订】Agent Report 在 v0.2 中扩展为支持三种结构化通道，处理顺序固定为 **context_patches → status → signals → advance**（详见 §FR-016/§FR-017/§FR-018 与 mvp-contracts §2.6）：

| 通道 | 字段 | 触达范围 | 引擎入口 |
|---|---|---|---|
| 变量与上下文块 patch | `context_patches[]` | workflow 数据层 | `applyContextPatch` |
| Step 结构化返回 | `status` | 当前 step 的本地决策 | `applyStatusReturn` |
| 顶层 signals | `signals[]` | 跨 step 升级 | 既有 signal handler |

三者并行存在但不冲突：

- `context_patches` 仅修改 `variables` / `context_blocks` 命名空间，不会触发 routing action。
- `status` 是 step-local 决策（如 review 的 approved/rejected），通过 step.on_return 翻译为 retry/goto/fail 等 action。
- `signals` 仍是 workflow-wide 升级（如 needs_architecture_design），按 severity/priority 处理。
- 当 `status` 已触发 action 时，`signals` 的 action 被忽略（但仍记录 `signal_received` 事件以备审计）。

示例：

```yaml
signals:
  needs_architecture_design:
    severity: medium
    priority: 50
    allowed_from:
      - plan
      - review
    action:
      activate_job: architecture-design

  blocked:
    severity: high
    priority: 100
    allowed_from:
      - intake
      - plan
      - implement
    action:
      status: blocked
```

Agent 输出示例：

```json
{
  "summary": "当前修改涉及导入管线和编码检测模块。",
  "signals": [
    {
      "type": "needs_architecture_design",
      "reason": "现有导入管线缺少明确扩展点，直接修改可能破坏后续数据源适配。"
    }
  ]
}
```

验收标准：

Agent 只能请求流程变化，不能直接写 next_job 或修改 state；

未声明 signal 必须被拒绝；

不允许从当前 job/step 发出的 signal 必须被拒绝；

signal_emitted 和 signal_handled 必须写入 event log。

### FR-011 Optional Job 激活

功能：

workflow 可以声明默认 inactive 的 optional job；

signal 或 router 可以激活 optional job；

optional job 激活后，根据 needs 进入 waiting 或 ready；

optional job 完成后，下游 optional_needs 可以读取其 outputs。

示例：

```yaml
jobs:
  architecture-design:
    activation: optional
    if: "${{ signals.needs_architecture_design }}"
    needs:
      - intake
      - code-map
      - risk-scan
    steps:
      - id: design
        type: agent
        uses: agent://architect
        expose:
          skills:
            - project
            - code
        outputs:
          adr: report.adr
          design_summary: report.design_summary
```

验收标准：

optional job 默认 inactive；

Agent 不能任意生成新 job；

激活 optional job 必须来自预定义 signal action 或 router action；

job_activated event 必须记录 reason。

### FR-012 Retry Job 与 Attempts

功能：

支持 job retry；

支持 retry inputs；

支持 max_attempts；

每次 attempt 拥有独立 artifact 目录；

超过 max_attempts 后按 on_exceeded 处理。

示例：

```yaml
jobs:
  implement:
    retryable: true
    retry:
      max_attempts: 3
      on_exceeded:
        status: blocked
    inputs:
      plan: "${{ jobs.plan.outputs.plan }}"
      review_comments:
        optional: true
```

状态示例：

```json
{
  "jobs": {
    "implement": {
      "status": "ready",
      "attempt": 2,
      "retry_reason": "review_rejected",
      "retry_inputs": {
        "review_comments": ["缺少边界测试", "异常处理不完整"]
      }
    }
  }
}
```

验收标准：

retry 不删除历史 attempt；

attempt artifact 路径必须可区分；

超过 max_attempts 后进入 blocked 或 failed；

job_retried event 必须记录 attempt、reason 和 retry inputs 摘要。

### FR-013 Artifact 管理

功能：

Artifact 是一等对象；

每个 artifact 需要 metadata；

report.json 中的大型内容应以 artifact 引用传递；

Context Builder 默认只读取 artifact 摘要，必要时按权限展开。

metadata 示例：

```json
{
  "id": "artifact://20260606-0001/jobs/unit-test/attempts/1/steps/test/stdout",
  "kind": "test_log",
  "path": "jobs/unit-test/attempts/1/steps/test/stdout.log",
  "producer": "unit-test.test",
  "created_at": "2026-06-06T10:00:00+08:00",
  "size": 10240,
  "summary": "12 tests passed, 1 failed",
  "content_type": "text/plain"
}
```

验收标准：

每个 step 输出文件都有 artifact metadata；

大型日志、diff、构建产物以 artifact 引用传递；

artifact path 必须限制在 run 目录内；

artifact 不应被自动删除。

### FR-014 Workspace 与权限模型

功能：

支持 workflow/job/step 级权限；

支持 workspace mode；

读任务可以并行；

写任务默认互斥；

MVP 规定同一时刻最多一个 writable job running。

示例：

```yaml
permissions:
  contents: read
  edits: none
  commands: none
  workflow_state: none

workspace:
  mode: read-only
```

写任务示例：

```yaml
workspace:
  mode: writable
  branch: "zigma/${{ run.id }}/implement"
```

【v0.2 修订】权限模型增加三轴，**完全独立于既有的 `edits` 文件编辑权限**：

```yaml
permissions:
  contents: read
  edits: none                # 既有：文件编辑
  commands: none             # 既有：shell 命令
  workflow_state: none       # 既有：禁止改 state.json 状态机字段
  variables:                 # v0.2 新增：workflow 变量读写白名单
    read: [plan_status, iteration_count]
    write: [plan_status]
  context_edit: read         # v0.2 新增：none | read | write
  context_blocks:            # v0.2 新增：上下文块读写白名单
    read: [current-plan, reviewer-notes]
    write: [current-plan]
```

约束：

- `variables.write` 的每项必须同时出现在 workflow 顶层 `variables.<name>.allowed_writers`（双重校验：step 自身声明 + workflow 顶层声明）。
- `context_blocks.write` 同理双重校验。
- `context_edit: none` 时 step 提交的 `report.context_patches` 整批拒绝（即使 step 列了 write 项）。
- 未声明的字段默认全部 `none`/空数组（最小权限原则）。
- 同一 step 完全允许 `edits: none, variables: write, context_edit: write`（典型 planner / reviewer 配置）或 `edits: write, variables: write, context_edit: write`（典型 implementer 配置）。

验收标准：

Prompt 必须显示当前 step 权限；

Runtime check 必须发现只读 Agent Step 修改文件；

多个 writable jobs 不允许同时 running；

未来多写 job 并行必须通过独立 branch 或 worktree；

【v0.2 修订】Engine 必须拒绝任何 patch 操作触及 `state.json` 的状态机字段（jobs/signals/attempts/last_event_id/run.status 等），即使 step 声明了 `variables.write` 或 `context_edit: write`，被保留字段不可写。

### FR-015 事件日志

功能：

所有状态变化写入 event log；

state.json 是 event log 的快照；

MVP 不要求完整 event sourcing，但事件格式从一开始按可重建状态设计。

事件示例：

```json
{"type":"run_created","run_id":"20260606-0001"}
{"type":"job_started","run_id":"20260606-0001","job":"implement","attempt":1}
{"type":"step_completed","run_id":"20260606-0001","job":"implement","step":"edit"}
{"type":"signal_emitted","run_id":"20260606-0001","signal":"review_rejected"}
{"type":"job_retried","run_id":"20260606-0001","job":"implement","attempt":2}
```

验收标准：

每行一个 JSON event；

event 必须包含 timestamp、type、run_id；

job / step 相关事件必须包含 job_id、step_id 和 attempt；

signal、router、retry、activation 必须有独立事件；

check 失败原因必须记录。

【v0.2 修订】v0.2 在 P13 中新增以下事件类型（mvp-contracts §2.4 维护权威清单）：

- adapter 生命周期：`agent_invoked` / `agent_completed` / `agent_timed_out` / `agent_failed` / `agent_cancelled` / `run_cancelled`
- step 控制流：`step_returned` / `step_skipped` / `step_revisited` / `step_visit_exceeded`
- 数据层：`variable_set` / `variable_deleted` / `context_block_updated` / `context_block_deleted`

P15 还会新增 `human_gate_waiting` / `human_decision`。

### FR-016 Step 结构化返回（Step Status Return，v0.2 新增）

功能：

step 可声明结构化返回状态，Agent 在 `report.status` 中返回，Engine 据此触发预声明的 action。

workflow 定义：

```yaml
- id: review
  type: agent
  uses: agent://reviewer
  returns:
    status:
      values: [approved, rejected, needs_clarification]
      required: true        # 强制要求 report 必须包含 status
  on_return:
    approved:
      continue: true
    rejected:
      retry_job: implement
      retry_with:
        review_comments: "${{ steps.review.outputs.comments }}"
    needs_clarification:
      goto_step: gather-context
```

Agent report 中的 status：

```json
{
  "summary": "...",
  "outputs": {...},
  "status": "rejected",
  "signals": []
}
```

Engine 行为：

1. 若 `status` 出现且 step 声明了 `returns.status`：调用 `applyStatusReturn`，按 `on_return[status]` 翻译为既有 router action（continue / retry_job / activate_job / goto_job / goto_step / fail / block）。
2. `required=true` 但 `status` 缺失 → ValidationError → step_failed。
3. `status` 不在 `returns.status.values` 中 → ValidationError → step_failed。
4. 若未声明 `returns.status`，`status` 字段被记录在 outputs 中，不触发动作。
5. status 触发的 action 优先于 signals action；signals 仍记录 `signal_received` 事件。

验收标准：

- 已声明 status 必须严格枚举校验；
- `step_returned` 事件 payload 含 status 与 mapped_action；
- 未声明 `returns` 时不破坏既有路径。

### FR-017 Workflow 变量与上下文块（v0.2 新增）

功能：

引入"工作流数据层"，作为 Agent 可通过 Engine 入口修改的命名空间，与 `state.json` 状态机字段隔离。

#### 变量声明（workflow 顶层）

```yaml
variables:
  plan_status:
    type: string
    initial: pending
    enum: [pending, ready, blocked]
    allowed_writers:
      - plan.plan
      - review.review
  open_questions:
    type: array
    initial: []
    allowed_writers:
      - plan.plan
      - review.review
  iteration_count:
    type: number
    initial: 0
    allowed_writers:
      - implement.*       # 通配整个 job
```

`type` 支持：`string` / `number` / `boolean` / `array` / `object`。v0.2 不做深层 schema 校验；顶层 type + enum（仅 string）校验。

#### 上下文块声明（workflow 顶层）

```yaml
context_blocks:
  current-plan:
    initial_artifact: null
    allowed_writers: [plan.plan, implement.edit]
  reviewer-notes:
    initial_artifact: null
    allowed_writers: [review.review]
```

每个上下文块在 run 目录下作为版本化 artifact 存在：

```
runs/<runId>/context-blocks/<block-id>/v<N>.md
```

artifact kind 为 `context_block`，metadata 含 producer、version、size、created_at；旧版本保留可审计，不被自动删除。

#### state.json 新增段

```json
{
  "variables": {
    "plan_status": "ready",
    "open_questions": [],
    "iteration_count": 2
  },
  "context_blocks": {
    "current-plan": {
      "current_version": 3,
      "current_artifact": "artifact://.../context-blocks/current-plan/v3.md"
    }
  }
}
```

#### Patch 操作

Agent report 增字段 `context_patches`：

```json
{
  "context_patches": [
    { "kind": "variable_set", "name": "plan_status", "value": "ready" },
    { "kind": "variable_delete", "name": "open_questions" },
    { "kind": "context_block_set", "id": "current-plan", "content": "..." },
    { "kind": "context_block_append", "id": "reviewer-notes", "content": "..." },
    { "kind": "context_block_delete", "id": "draft-notes" }
  ]
}
```

#### Engine 入口 `applyContextPatch`

- 在 acceptAgentReport 处理 outputs 之后、status/signals 之前执行。
- 对每条 patch：
  - 校验 step 是否在 `allowed_writers`（精确匹配 `<job>.<step>` 或 `<job>.*` 通配）；未授权 → ValidationError。
  - 校验 kind 与 schema；类型/enum 不匹配 → ValidationError。
  - 批次原子性：任一条失败整批回滚，不写 state、不写事件、不写 artifact。
- 全部校验通过后：原子写一次 state.json + 每条 patch 一条事件 + 必要的 context_block artifact 写入。

#### 状态机隔离（不变量）

`applyContextPatch` 永远不允许触及：

- `state.status`、`state.last_event_id`
- `state.jobs[*].status` / `attempt` / `current_step` / `retry_*` / `activation*` / `step_visits`
- `state.signals` 注册表

任何对这些字段的 patch 请求都是 `ValidationError`，整批回滚。

验收标准：

- 变量与上下文块只能通过 patch 修改；
- 权限不通过的 patch 整批回滚，状态/事件/artifact 三者一致；
- 历史版本 artifact 不被覆盖；
- 试图触及保留字段必须拒绝并写出明确错误。

### FR-018 条件、跳转与有界循环（v0.2 新增）

功能：

允许 workflow 通过 step `if:`、router `goto_step` 与 step `max_visits` 表达条件、跳转与有界循环，**不引入 `while`/`for` DSL，不支持任意脚本表达式**。

#### Step `if:`

```yaml
- id: gather-context
  type: agent
  if: "${{ variables.plan_status == 'needs_context' }}"
  uses: agent://researcher
```

约束：

- 表达式语法白名单：`${{ ... }}` 受限插值 + `==` / `!=` / `&&` / `||` / `!`。
- 禁止：函数调用、算术、字符串拼接、JS 求值、对象属性访问深度 > 3。
- 求值 false → step 状态 `skipped`，写 `step_skipped` 事件（payload: condition string），调用 advanceJob 推进到下一 step。
- 表达式解析失败（变量未声明、语法错） → ValidationError → step_failed。

#### Router `goto_step`

```yaml
- id: route-plan
  type: router
  switch: "${{ steps.plan.outputs.status }}"
  cases:
    incomplete:
      goto_step: gather-context
    ready:
      continue: true
```

约束（同 §FR-009）：

- 目标 step 必须存在于同一 job；跨 job 用 `goto_job`。
- 触发时写 `step_revisited` 事件，重置目标 step 状态为 pending，更新 current_step，目标 step 的 visit 计数 +1。

#### Step `max_visits`

```yaml
- id: gather-context
  max_visits: 5
```

约束：

- 每次进入 step 时 `state.jobs[<jobId>].step_visits[stepId]` 计数 +1。
- 超过 `max_visits`（默认 3） → step 状态 `blocked`、job 状态 `blocked`、写 `step_visit_exceeded` 事件。
- visit 计数随 `retryJob`（attempt+1）重置为 0；不允许通过 context_patch 重置。

验收标准：

- 表达式语法严格白名单；非白名单语法 → ValidationError；
- goto_step 跨 job → ValidationError；
- 循环超过 max_visits 必须 blocked，事件链可单独审计；
- retry 重置 visit 计数。

## 11. Skill Pack Manifest 规范

Skill Pack 是能力包，不是 workflow step。它只导出资源和能力，不直接改变 workflow 状态。

示例：`.zigma-flow/skills/code-change/skill.yml`

```yaml
id: zigma.code-change
name: Code Change Skill Pack
version: 1.0.0
kind: skill-pack

description: "用于代码修改任务的知识、提示词、脚本、检查器和流程模板集合。"

knowledge:
  - id: coding-guidelines
    path: knowledge/coding-guidelines.md
    description: "通用代码修改规范"

  - id: failure-patterns
    path: knowledge/common-failure-patterns.md
    description: "Agent 修改代码时常见失败模式"

prompts:
  - id: implement
    path: prompts/implement.md

  - id: review
    path: prompts/review.md

scripts:
  - id: collect-diff
    runtime: node
    path: scripts/collect-diff.ts
    inputs:
      repository:
        type: string
    outputs:
      diff:
        type: artifact
      changed_files:
        type: array

  - id: run-tests
    runtime: shell
    command: "pnpm test"
    timeout: 300s
    outputs:
      exit_code:
        type: number
      log:
        type: artifact

checks:
  - id: report-schema
    kind: json-schema
    path: checks/report-schema.json

  - id: forbidden-paths
    kind: path-policy
    path: checks/forbidden-paths.yml

workflow_templates:
  - id: bugfix-template
    path: workflows/bugfix-template.yml

functions:
  - id: implement-by-plan
    kind: agent-function
    prompt: prompts/implement.md
    knowledge:
      - coding-guidelines
      - failure-patterns
    tools:
      - repo.read
      - repo.edit
      - shell.run-limited
    inputs:
      plan:
        type: string
        required: true
    outputs:
      changed_files:
        type: array
      summary:
        type: string
      deviations:
        type: array

  - id: review-change
    kind: agent-function
    prompt: prompts/review.md
    knowledge:
      - coding-guidelines
    tools:
      - repo.read
      - git.diff
    inputs:
      changed_files:
        type: array
    outputs:
      decision:
        type: enum
        values:
          - approved
          - rejected
          - needs_architecture_design
      comments:
        type: array

policies:
  default_permissions:
    contents: read
    edits: none
    commands: none
    workflow_state: none
```

Skill Pack 的使用方式有两种：

第一，Engine 显式调用 Skill Pack 中的 script 或 check。

第二，Agent Step 通过 `expose` 获得 Skill Pack 的 knowledge、prompt、function、tool 等能力清单。

这两种必须区分。确定性检查不应让 Agent 自己决定是否执行。

## 12. Workflow YAML 规范

Workflow YAML 采用 Workflow、Job、Step 三层结构，并在顶层声明可用 Skill Pack、signal schema 和默认权限。

示例：`.zigma-flow/workflows/code-change.yml`

```yaml
name: code-change
version: 0.3.0

on:
  manual:
    inputs:
      task:
        type: string
        required: true
      repository:
        type: string
        default: "."

skills:
  code:
    uses: skill://zigma.code-change@1
    expose_to_agent: true

  project:
    uses: skill://datacat.project-rules@1
    expose_to_agent: true

permissions:
  contents: read
  edits: none
  commands: none
  workflow_state: none

signals:
  needs_architecture_design:
    severity: medium
    priority: 50
    allowed_from:
      - plan
      - review
    action:
      activate_job: architecture-design

  review_rejected:
    severity: medium
    priority: 40
    allowed_from:
      - review
    action:
      retry_job: implement

  blocked:
    severity: high
    priority: 100
    allowed_from:
      - intake
      - plan
      - implement
    action:
      status: blocked

jobs:
  intake:
    workspace:
      mode: read-only
    steps:
      - id: analyze
        type: agent
        uses: agent://planner
        expose:
          skills:
            - code
            - project
          knowledge:
            - code.failure-patterns
        with:
          task: "${{ inputs.task }}"
        outputs:
          summary: report.summary
          goals: report.goals
          risks: report.risks
          blocking_questions: report.blocking_questions
          signals: report.signals

      - id: route
        type: router
        switch: "${{ steps.analyze.outputs.signals }}"
        cases:
          blocked:
            status: blocked
          default:
            continue

  code-map:
    needs: intake
    workspace:
      mode: read-only
    steps:
      - id: map
        type: agent
        uses: agent://analyst
        expose:
          skills:
            - code
            - project
          tools:
            - repo.search
            - repo.read
        with:
          summary: "${{ jobs.intake.outputs.summary }}"
        outputs:
          code_map: report.code_map

  risk-scan:
    needs: intake
    workspace:
      mode: read-only
    steps:
      - id: scan
        type: agent
        uses: agent://reviewer
        expose:
          skills:
            - code
            - project
        with:
          summary: "${{ jobs.intake.outputs.summary }}"
        outputs:
          risks: report.risks
          signals: report.signals

  architecture-design:
    activation: optional
    if: "${{ signals.needs_architecture_design }}"
    needs:
      - intake
      - code-map
      - risk-scan
    steps:
      - id: design
        type: agent
        uses: agent://architect
        expose:
          skills:
            - project
            - code
          workflow_templates:
            - project.architecture-template
        with:
          task: "${{ inputs.task }}"
          code_map: "${{ jobs.code-map.outputs.code_map }}"
          risks: "${{ jobs.risk-scan.outputs.risks }}"
        outputs:
          adr: report.adr
          design_summary: report.design_summary

  plan:
    needs:
      - code-map
      - risk-scan
    optional_needs:
      - architecture-design
    steps:
      - id: plan
        type: agent
        uses: agent://planner
        expose:
          skills:
            - code
            - project
        with:
          task: "${{ inputs.task }}"
          code_map: "${{ jobs.code-map.outputs.code_map }}"
          risks: "${{ jobs.risk-scan.outputs.risks }}"
          architecture_design: "${{ jobs.architecture-design.outputs.design_summary }}"
        outputs:
          plan: report.plan
          test_plan: report.test_plan
          requires_architecture_design: report.requires_architecture_design
          signals: report.signals

      - id: route-plan
        type: router
        switch: "${{ steps.plan.outputs.signals }}"
        cases:
          needs_architecture_design:
            activate_job: architecture-design
          default:
            continue

  implement:
    needs: plan
    retryable: true
    retry:
      max_attempts: 3
      on_exceeded:
        status: blocked
    workspace:
      mode: writable
    permissions:
      contents: read
      edits: write
      commands: limited
    steps:
      - id: edit
        type: agent
        uses: agent://implementer
        expose:
          skills:
            - code
            - project
          functions:
            - code.implement-by-plan
          tools:
            - repo.read
            - repo.edit
            - shell.run-limited
        with:
          plan: "${{ jobs.plan.outputs.plan }}"
          review_comments: "${{ retry.inputs.review_comments }}"
        outputs:
          changed_files: report.changed_files
          implementation_summary: report.implementation_summary
          deviations: report.deviations

      - id: collect-diff
        type: script
        uses: code.scripts.collect-diff
        with:
          repository: "${{ inputs.repository }}"
        outputs:
          diff: result.diff
          changed_files: result.changed_files

      - id: check-diff
        type: check
        uses: code.checks.forbidden-paths
        with:
          changed_files: "${{ steps.collect-diff.outputs.changed_files }}"
        on_fail:
          status: failed

  static-check:
    needs: implement
    steps:
      - id: lint
        type: script
        run: "pnpm lint"
        shell: bash
        timeout: 300s
        outputs:
          exit_code: result.exit_code
          log: result.stdout
        on_failure:
          status: failed

      - id: typecheck
        type: script
        run: "pnpm typecheck"
        shell: bash
        timeout: 300s
        outputs:
          exit_code: result.exit_code
          log: result.stdout
        on_failure:
          status: failed

  unit-test:
    needs: implement
    steps:
      - id: test
        type: script
        run: "pnpm test"
        shell: bash
        timeout: 300s
        outputs:
          exit_code: result.exit_code
          log: result.stdout
        on_failure:
          status: failed

  review:
    needs:
      - implement
      - static-check
      - unit-test
    steps:
      - id: review
        type: agent
        uses: agent://reviewer
        expose:
          skills:
            - code
            - project
          functions:
            - code.review-change
        with:
          diff: "${{ jobs.implement.outputs.diff }}"
          lint_log: "${{ jobs.static-check.outputs.log }}"
          test_log: "${{ jobs.unit-test.outputs.log }}"
        outputs:
          decision: report.decision
          comments: report.comments
          signals: report.signals

      - id: route-review
        type: router
        switch: "${{ steps.review.outputs.decision }}"
        cases:
          approved:
            continue
          rejected:
            retry_job: implement
            retry_with:
              review_comments: "${{ steps.review.outputs.comments }}"
          needs_architecture_design:
            activate_job: architecture-design
          default:
            status: failed

  summarize:
    needs: review
    steps:
      - id: summarize
        type: agent
        uses: agent://reporter
        expose:
          skills:
            - code
        with:
          task: "${{ inputs.task }}"
          changed_files: "${{ jobs.implement.outputs.changed_files }}"
          review: "${{ jobs.review.outputs.comments }}"
        outputs:
          final_summary: report.final_summary
          remaining_risks: report.remaining_risks
```

## 13. 类型系统与表达式

所有 inputs、outputs 和 report 字段应使用统一 schema 描述。MVP 可用 JSON Schema 或 Zod Schema 实现。

最小类型：

```text
string
number
boolean
array
object
enum
file
artifact
diff
log
signal
```

`artifact` 必须和普通字符串区分。测试日志、diff、构建产物、报告文件不应直接塞进 report.json，而应以引用方式传递。

示例：

```json
{
  "changed_files": ["src/import/csv.ts"],
  "test_log": {
    "type": "artifact",
    "path": "jobs/unit-test/attempts/1/steps/test/stdout.log"
  }
}
```

MVP 支持字符串插值，不实现完整表达式语言。

最小上下文：

```text
${{ inputs.task }}
${{ inputs.repository }}
${{ run.id }}
${{ jobs.intake.outputs.summary }}
${{ steps.plan.outputs.test_plan }}
${{ retry.inputs.review_comments }}
${{ signals.needs_architecture_design.reason }}
```

【v0.2 修订】v0.2 在 P13 中扩展以下表达式上下文：

```text
${{ variables.<name> }}                     # v0.2 新增：workflow 变量当前值
${{ jobs.<id>.outputs.<key> }}              # P13 清偿 TD-P9-001：层级 outputs 访问
${{ steps.<id>.outputs.<key> }}             # P13 清偿 TD-P9-002：同 job 内 step outputs 访问
```

同时在 `if:` / `goto_step` 等条件场景支持有限组合：

- 等值/不等：`==` `!=`
- 逻辑：`&&` `||` `!`
- 括号：`( ... )`

**仍禁止**：函数调用、算术（`+` `-` `*` `/`）、字符串拼接、对象/数组方法、JS 求值。表达式解析在静态层（schema 校验）与求值层（runtime）双重过滤。

暂不支持任意脚本表达式。

## 14. Context Builder 与 Prompt Builder

长期模块边界应区分 Context Builder 和 Prompt Builder。

Context Builder 负责决定：

当前 step 能看到哪些 inputs；

能看到哪些 artifact 摘要；

能读取哪些知识库；

能使用哪些工具；

能调用哪些 Agent function；

能发出哪些 signals；

哪些内容必须隐藏；

哪些内容按需展开。

Prompt Builder 只负责把 Context Builder 的结果渲染成 Markdown。

这个边界会成为未来 Zigma 的核心能力之一。

## 15. 系统架构设计

MVP 采用本地单进程 CLI 架构。

```text
CLI Layer
  ↓
Command Handlers
  ↓
Workflow Loader
Skill Pack Loader
Skill Lock Resolver
DAG Resolver
Workflow Engine
Context Builder
Prompt Builder
Script Runner
Check Runner
Router Evaluator
Signal Handler
Artifact Manager
State Store
Event Logger
Git Inspector
Expression Resolver
Workspace Guard
```

模块说明：

Workflow Loader：读取并校验 workflow YAML。

Skill Pack Loader：读取并校验 skill.yml。

Skill Lock Resolver：解析 skill-lock.json，确保复现同一版本 Skill Pack。

DAG Resolver：解析 job needs、optional_needs 和 inactive jobs。

Workflow Engine：解释 step 类型，推进状态，处理 signal、router、retry、activation 和 failure。

Context Builder：决定 Agent Step 可见上下文和能力。

Prompt Builder：将上下文渲染为 current-step.md。

Script Runner：执行 script step，处理 timeout、cwd、env、stdout/stderr。

Check Runner：执行确定性 check step。

Router Evaluator：执行受控流程分支。

Signal Handler：校验 signal schema、allowed_from、priority 和 action。

Artifact Manager：创建 artifact、metadata 和引用。

State Store：读写 state.json 快照。

Event Logger：写入 events.jsonl。

Git Inspector：读取 git diff、changed files、仓库状态。

Expression Resolver：解析 `${{ ... }}` 字符串插值。

Workspace Guard：约束 read-only / writable job 的运行和修改范围。

核心原则：Agent 只提交结果，Engine 解释结果。

## 16. 数据目录设计

项目根目录下：

```text
.zigma-flow/
  config.json
  skill-lock.json
  workflows/
    code-change.yml
  skills/
    code-change/
      skill.yml
      knowledge/
      prompts/
      scripts/
      checks/
      workflows/
      examples/
  runs/
    20260606-0001/
      run.yml
      state.json
      skill-lock.snapshot.json
      events.jsonl
      current-step.md
      artifacts.jsonl
      jobs/
        implement/
          state.json
          attempts/
            1/
              steps/
                edit/
                  prompt.md
                  output.md
                  report.json
                  artifacts.jsonl
                collect-diff/
                  stdout.log
                  stderr.log
                  result.json
                  artifacts.jsonl
                check-diff/
                  check-result.json
            2/
              steps/
                edit/
                  prompt.md
                  output.md
                  report.json
```

run.yml 示例：

```yaml
run_id: 20260606-0001
workflow: code-change
workflow_version: 0.3.0
task: "修复 CSV 导入编码检测问题"
repository: "."
created_at: "2026-06-06T10:00:00+08:00"
```

state.json 示例：

```json
{
  "run_id": "20260606-0001",
  "workflow": "code-change",
  "status": "running",
  "signals": {
    "needs_architecture_design": {
      "active": true,
      "reason": "缺少架构约束说明",
      "emitted_by": "plan.plan"
    }
  },
  "jobs": {
    "intake": {
      "status": "completed",
      "activation": "required",
      "attempt": 1,
      "needs": [],
      "outputs": {
        "summary": "..."
      }
    },
    "architecture-design": {
      "status": "ready",
      "activation": "optional",
      "activated": true,
      "activation_reason": "signal:needs_architecture_design",
      "needs": ["intake", "code-map", "risk-scan"],
      "attempt": 1
    },
    "implement": {
      "status": "ready",
      "activation": "required",
      "attempt": 2,
      "retry_reason": "review_rejected",
      "retry_inputs": {
        "review_comments": ["缺少边界测试"]
      }
    }
  }
}
```

## 17. CLI 命令设计

MVP 命令集：

```bash
zigma-flow init
zigma-flow validate <path>
zigma-flow run <workflow-name> --task "<task>"
zigma-flow status
zigma-flow prompt --job <job-id>
zigma-flow step --job <job-id>
zigma-flow check --job <job-id>
zigma-flow next --job <job-id>
zigma-flow retry --job <job-id>
zigma-flow abort
zigma-flow list-runs
zigma-flow show <run-id>
```

命令行为要求：

所有命令默认作用于当前 active run；

active run 可以记录在 `.zigma-flow/config.json`；

用户可以通过 `--run <run-id>` 指定历史 run；

`prompt` 只适用于 Agent Step；

`step` 用于执行当前 ready job 的非 Agent Step，例如 script、check、router；

当只有一个 ready job 时，`prompt`、`step`、`check`、`next` 可以省略 `--job`；

当存在多个 ready job 时，必须显式指定 `--job`；

命令失败时必须返回非零退出码；

错误信息要说明原因和修复建议。

可选增强命令：

```bash
zigma-flow clean
zigma-flow export-summary
zigma-flow inspect-artifacts
zigma-flow replay-events
zigma-flow doctor
```

## 18. 非功能需求

稳定性：

工具不能因为 Agent 输出不完整而崩溃；

YAML 或 JSON 格式错误时应给出明确错误；

check 失败不应破坏已有状态；

DAG 状态计算必须可重复、可恢复；

script timeout 必须可控。

可审计性：

每次状态变更必须写入 events.jsonl；

state.json 是事件流快照；

每次 check、script、router、signal、retry、activation 结果必须可回溯；

artifact 不应被自动删除；

job / step / attempt 输出应能追溯到具体 producer。

可移植性：

支持 Windows、Linux、macOS；

路径处理必须跨平台；

避免依赖特定 shell；

shell 字段必须显式声明或使用平台默认策略。

可扩展性：

workflow schema 应保留 workflow step、human gate、remote skill registry 扩展位置；

Script Runner、Check Runner、Agent Adapter 应可插拔；

未来可增加 Docker、PR、邮件、MCP runtime 等能力。

可读性：

生成的 current-step.md 必须适合人类阅读；

workflow YAML 应尽量接近自然语言；

错误信息应避免只有堆栈。

安全性：

禁止 Agent 修改 state.json；

禁止 workflow outputs 使用危险路径，例如 `../../`；

禁止默认删除项目文件；

retry 不应默认覆盖历史 artifact；

abort 不应删除运行记录；

只读 step 修改文件应被检测并失败；

MVP 同一时刻只允许一个 writable job running。

## 19. 技术选型

建议使用 TypeScript 实现 CLI。理由是开发速度快，生态适合 YAML、JSON、CLI、文件系统和 git 集成。

推荐依赖：

commander：CLI 命令解析；

yaml：读取 workflow 和 skill.yml；

zod 或 ajv：校验 workflow、Skill Pack、state、report、JSON Schema；

fs-extra：文件系统操作；

execa：执行 script step；

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
    step.ts
    check.ts
    next.ts
    retry.ts
    abort.ts
  workflow/
    loadWorkflow.ts
    workflowSchema.ts
    validateWorkflow.ts
  skill-pack/
    loadSkillPack.ts
    skillPackSchema.ts
    resolveSkillPack.ts
    lockfile.ts
  engine/
    workflowEngine.ts
    advanceStep.ts
    handleSignal.ts
    evaluateRouter.ts
    activateJob.ts
    retryJob.ts
  dag/
    validateDag.ts
    resolveReadyJobs.ts
  context/
    buildContext.ts
    resolveExposedCapabilities.ts
  prompt/
    buildAgentPrompt.ts
    renderMarkdown.ts
  script/
    runScriptStep.ts
    scriptResult.ts
  check/
    runCheckStep.ts
    checks/
      requiredOutputs.ts
      reportJson.ts
      jsonSchema.ts
      gitDiff.ts
      forbiddenPaths.ts
      permissions.ts
  artifact/
    artifactPaths.ts
    writeArtifact.ts
    artifactMetadata.ts
  run/
    createRun.ts
    loadRun.ts
    loadState.ts
    saveState.ts
    activeRun.ts
  workspace/
    inspectWorkspace.ts
    enforceWorkspaceMode.ts
  git/
    inspectGit.ts
  events/
    appendEvent.ts
    eventTypes.ts
  expression/
    resolveExpression.ts
  utils/
    pathSafe.ts
    errors.ts
```

## 20. 开发计划

### 阶段 1：CLI 骨架与初始化

目标：

建立 TypeScript CLI 项目，完成基础命令结构和 `.zigma-flow/` 初始化。

任务：

创建 npm package；

配置 TypeScript、tsup、vitest；

实现 `zigma-flow --help`；

实现 `zigma-flow init`；

生成 workflow 示例、Skill Pack 示例、config.json、skill-lock.json；

实现基础单元测试。

验收标准：

本地可以通过 `npm link` 或 `pnpm link` 使用 zigma-flow；

init 后目录结构正确；

重复 init 不破坏已有文件。

### 阶段 2：Workflow / Skill Pack Loader 与校验

目标：

工具可以读取并校验 workflow YAML、Skill Pack manifest 和 lockfile。

任务：

设计 workflow schema；

设计 Skill Pack schema；

实现 skill-lock 解析；

实现 skill 引用解析；

实现 step type 校验；

实现 signal schema 校验；

实现 router 控制流校验；

实现 `validate` 命令。

验收标准：

合法 workflow 和 Skill Pack 通过；

缺少关键字段时报错；

重复 job id 或 step id 报错；

未声明 Skill Pack 暴露时报错；

非法控制流时报错。

### 阶段 3：DAG、Optional Job 与 Run 创建

目标：

支持创建 workflow run，并初始化 required / optional job 状态。

任务：

实现 job needs 校验；

实现 optional job inactive 状态；

实现 run_id 生成；

实现 run 目录创建；

实现 run.yml、state.json、skill-lock snapshot；

实现基础 event log。

验收标准：

run 后生成完整目录；

无依赖 required job 进入 ready；

optional job 默认 inactive；

events.jsonl 记录 run_created 和 job_ready。

### 阶段 4：Context Builder 与 Agent Prompt

目标：

为 Agent Step 生成受控 prompt。

任务：

实现 expose 解析；

实现 artifact 摘要注入；

实现 knowledge / functions / tools 清单渲染；

实现 signal 清单渲染；

实现 permissions 渲染；

实现 report schema 渲染；

实现 `prompt --job`。

验收标准：

prompt 只暴露当前 step 允许能力；

prompt 明确禁止修改 workflow 状态；

prompt 包含输出路径和完成后停止约束。

### 阶段 5：Artifact 与 Event Log

目标：

让 outputs、logs、diff 和 reports 都可追溯。

任务：

实现 artifact path 管理；

实现 artifact metadata；

实现 artifacts.jsonl；

实现 event types；

实现 state snapshot 更新。

验收标准：

每个 step 输出都有 artifact metadata；

事件包含 run_id、job、step、attempt；

state.json 可视为 event log 的快照。

### 阶段 6：Script Step

目标：

支持执行确定性命令。

任务：

实现 inline script；

实现 Skill Pack script；

实现 timeout、cwd、env；

捕获 stdout/stderr/exit_code；

写入 script result artifact；

实现失败处理。

验收标准：

命令超时失败；

stdout/stderr 可回溯；

exit_code 可映射到 outputs。

### 阶段 7：Check Step 与权限检查

目标：

实现确定性 gate。

任务：

实现 required_outputs；

实现 JSON 合法性；

实现 JSON Schema；

实现必填字段和非空字段；

实现 git diff；

实现 forbidden paths；

实现 read-only step 修改检测；

实现 writable job 互斥。

验收标准：

基础 gate 不依赖 LLM；

禁止路径修改失败；

只读 step 修改文件失败；

同一时刻不能有多个 writable job running。

### 阶段 8：Signal、Router、Optional Activation

目标：

实现受控动态流程。

任务：

解析 Agent report signals；

校验 signal allowed_from；

按 priority 处理 signal；

实现 router evaluator；

实现 activate_job；

实现 block / fail / continue。

验收标准：

未声明 signal 被拒绝；

plan/review 可以激活 architecture-design；

blocked signal 可阻塞 run；

router 决策写入 event log。

### 阶段 9：Retry Job 与 Attempts

目标：

支持 review rejected 等场景打回上一步。

任务：

实现 retry_job；

实现 retry inputs；

实现 attempts 目录；

实现 max_attempts；

实现 on_exceeded。

验收标准：

review rejected 可重试 implement；

每次 retry 保留独立 artifact；

超过 3 次进入 blocked。

### 阶段 10：内置 code-change Workflow 打磨

目标：

让第一个 workflow 可用于真实项目 dogfood。

任务：

完善 code-change Skill Pack；

完善 code-change workflow；

补充 README 使用说明；

用一个小型真实任务测试；

根据反馈修正 prompt、schema、signals、checks。

验收标准：

完整跑通 intake、code-map、risk-scan、plan、implement、static-check、unit-test、review、summarize；

Agent 不需要读取完整复杂 Skill；

script/check 接管确定性流程；

review rejected 能打回 implement；

optional architecture-design 可被 signal 激活。

## 21. MVP 分期边界

MVP v0.3 实现：

Workflow、Job、Step 三层；

Skill Pack manifest 解析；

Skill lockfile；

Agent Step 生成 prompt；

Script Step 执行命令；

Check Step 做硬规则检查；

Job needs DAG；

Router Step 基础分支；

Agent report 输出 signals；

optional job 条件激活；

retry job，最多 3 次；

artifact metadata；

event log。

暂时不做：

远程 Skill Registry；

真正动态插入 Job；

自动多 Agent 并发；

Docker；

邮件；

PR；

Web UI；

MCP；

复杂权限系统；

完整 event sourcing 重建。

## 22. MVP 成功标准

MVP 成功不以功能数量衡量，而以是否解决原始痛点衡量。

核心成功标准：

复杂 Skill 拆成 workflow 和 Skill Pack 后，Agent 明显减少跳步行为；

Agent 每个 Agent Step 能稳定产出约定 report；

script/check 能接管 lint、test、diff、路径检查等确定性流程；

用户能从 state、artifact 和 event log 中复盘执行过程；

任务失败时可以 retry 当前 job，无需重跑全部流程；

review rejected 能自然打回 implement；

needs_architecture_design 能激活 optional architecture-design job；

Context Builder 能限制 Agent 可见能力；

用户主观感受上，流程可控性高于长 Skill 提示词。

【v0.2 修订】v0.2 在保持上述全部标准的前提下，将"Agent 不能直接修改 workflow 状态"的口径调整为：

- Agent 通过 Engine 提供的入口（report.outputs、report.signals、report.status、report.context_patches）影响流程；
- Agent 永远不直接写 `state.json` 的状态机字段；
- `state.json` 的状态机字段（job/step status、attempts、signals 注册表、last_event_id、run.status 等）仍只能由 Engine 通过 acceptAgentReport、applyContextPatch、applyStatusReturn、advanceJob、retryJob 等内部入口写入；
- 新增"工作流数据层"（variables、context_blocks）由 Engine 入口 applyContextPatch 校验后写入，与状态机字段隔离。

v0.2 新增成功标准：

- planner / reviewer 等 Agent 可通过 status 与 context_patches 显式影响流程，而无需为每种决策都建模为顶层 signal；
- goto_step 与 max_visits 让"返工→重试→升级"模式具备结构化表达，避免靠 prompt 提醒；
- 上下文块编辑权限独立于文件编辑权限，能区分"改源码的写者"与"改 plan/notes 的写者"。

## 23. 主要风险与应对

风险一：Workflow DSL 变成通用编程语言。

应对：MVP 只保留 needs、if、optional activation、continue、fail、block、retry_job、activate_job、goto_job；不做 while、for、任意脚本表达式、运行时 YAML patch。

风险二：Skill Pack 和 Workflow 职责混淆。

应对：Skill Pack 只提供能力，不接管流程；Workflow 只编排流程，不承载大量知识。

风险三：Agent 通过 signal 过度影响流程。

应对：Agent 只能请求流程变化，signal 必须由 workflow 顶层声明，Engine 根据 allowed_from、priority 和 action 裁决。

【v0.2 修订】Agent 在 v0.2 中获得额外的影响通道（status、context_patches、status 触发的 goto_step）。新增缓解措施：

- status 必须出现在 step 的 `returns.status.values` 枚举内，未声明的 status 拒绝；
- context_patches 受 step 权限（variables/context_edit/context_blocks）与 workflow 顶层 allowed_writers 双重校验；
- 任何 patch 触及状态机字段一律拒绝（保留字段集合在 Engine 代码中硬编码 + 单测覆盖）；
- goto_step 形成的环路由每 step `max_visits` 兜底（默认 3），超出即 blocked；
- patch 操作批次原子，失败整批回滚；每条 patch 都有独立事件可审计。

风险四：并行 job 产生工作区冲突。

应对：MVP 允许 read-only job 并行，writable job 互斥；未来通过 branch/worktree 支持多个写 job。

风险五：Script Step 带来本地执行风险。

应对：MVP 支持 timeout、cwd、env、stdout/stderr capture；后续增加命令白名单、风险等级和 Docker sandbox。

风险六：Retry 形成无限循环。

应对：retry 必须声明 max_attempts，默认最多 3 次，超过后 blocked。

风险七：Artifact 过大导致 prompt 膨胀。

应对：artifact 以 metadata 和摘要传递，Context Builder 按需展开。

## 24. 后续演进方向

MVP 验证通过后，可以按以下方向演进。

第一，Agent Adapter。支持自动调用 Claude Code、Codex 或其他 CLI Agent。

第二，完整 event sourcing。支持从 events.jsonl 重建 state.json。

第三，Workflow Step。支持调用子 workflow 和 workflow template。

第四，Human Gate Step。支持人工审批、补充需求和合并确认。

第五，真正并发执行。自动并行执行多个 read-only ready jobs。

第六，Git Branch / Worktree 集成。多个 writable jobs 使用独立工作区。

第七，PR 集成。workflow 完成后自动创建 PR，并把 summarize 输出写入 PR 描述。

第八，虚拟邮件。将 step 间交接、阻塞问题、上下文请求抽象为 message。

第九，远程 Skill Registry。Skill Pack 版本化发布、解析和锁定。

第十，Docker Workspace。为每次 run 创建隔离容器环境。

第十一，MCP runtime。把 MCP 服务作为受控 tool 暴露给 Agent Step。

第十二，Zigma Core。将本地 workflow runner 扩展为服务端 Agent 编排系统。

## 25. README 摘要草案

可以在仓库 README 中这样介绍：

````md
# Zigma Flow

Zigma Flow is a local workflow runtime for coding agents.

It turns complex agent skills into auditable workflows. Workflow files define jobs, steps, dependencies, signals, checks, retries, and optional branches. Skill Packs provide reusable knowledge, prompts, tools, scripts, checks, and agent functions. Agents execute only the current Agent Step, while deterministic script and check steps are handled by the runtime.

## Why

Long-context coding agents may ignore workflow constraints in complex skills. Zigma Flow reduces this risk by keeping workflow state outside the model context, exposing only the capabilities needed for the current step, and using artifacts and gates to control progression.

## Basic Usage

```bash
zigma-flow init
zigma-flow run code-change --task "Fix CSV import encoding detection"
zigma-flow status
zigma-flow prompt --job plan
zigma-flow step --job static-check
zigma-flow next --job static-check
```

## Core Idea

Workflow = state machine + DAG.
Step = execution unit.
Skill Pack = capability package.
Agent = one executor type.
Artifact = context carrier.
Signal = agent request for flow change.
Gate = engine decision for flow change.
````

## 26. 结论

Zigma Flow v0.3 的核心修正是：Skill 不再等价于 workflow step，而是 Skill Pack 能力包；Step 不再默认等价于 Agent 行为，而是统一的执行单元。

新的核心结构是：

```text
Workflow 编排流程
Job 表达并行与阶段
Step 执行具体动作
Skill Pack 提供可复用能力
Agent Step 使用 Skill Pack 并输出 signals
Script Step 和 Check Step 接管确定性流程
Router Step 根据结果改变流程走向
Optional Job 提供可控动态扩展
Artifact 承载上下文
Event Log 保证审计和未来回放
```

这样设计后，Zigma Flow 不再只是“把长 Skill 拆成 YAML 步骤”的工具。它会变成一个小型 Agent Workflow Runtime。它既能解决 Claude Code、Codex 长上下文下忽略流程的问题，也能为未来完整 Zigma 的邮件任务、虚拟协作、自动补丁、PR 审阅和多 Agent 管理打下正确抽象。

后续设计最重要的收束原则是：把灵活性限制在可审计、可回放、可约束的范围内。Agent 可以建议流程变化，但不能修改流程状态；动态流程优先用 optional job，避免任意动态改 DAG；所有输入输出都走 schema 和 artifact 引用；所有状态变化都写 event log。
