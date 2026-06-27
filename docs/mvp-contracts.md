# Zigma Flow MVP Contracts

文档版本：v0.1（含 v0.2 修订增量，2026-06-27）
日期：2026-06-06
适用范围：P0 契约冻结与架构边界准备；v0.2 修订扩展 §2.1/§2.3/§2.4/§2.6/§3
来源：`docs/prd.md` v0.3 + v0.2 修订、`docs/architecture.md` v0.1 + v0.2 修订

## 1. P0 结论

MVP 的边界正式冻结为：实现一个本地单进程 TypeScript CLI，用 Workflow、Job、Step、Skill Pack、Artifact、Signal、Gate 和 Event 验证 Agent Workflow Runtime 的最小内核。

MVP 不追求通用工作流平台、自动多 Agent 平台或远程协作系统。后续实现任务必须优先证明以下三件事：

- Engine 是唯一状态推进者。
- Agent Step 只接收当前 step prompt 并提交结构化 report / signal。
- Script Step、Check Step、Router Step、Artifact 和 Event 共同承担确定性执行、确定性 gate、审计和回放证据。

## 2. MVP 公共契约清单

### 2.1 Workflow Contract

Workflow 是用户编写的 published language。MVP 必须支持以下最小字段：

- 顶层字段：`name`、`version`、`on`、`skills`、`permissions`、`signals`、`jobs`。
- Job 字段：`needs`、`optional_needs`、`activation`、`retry`、`permissions`、`workspace`、`steps`。
- Step 字段：`id`、`type`、`uses` 或 `run`、`with`、`outputs`、`on_failure`、`on_pass`、`expose`。
- Step type：`agent`、`script`、`check`、`router`、`workflow`、`human`。
- Router action：`continue`、`fail`、`block`、`retry_job`、`activate_job`、`goto_job`。

【v0.2 修订】扩展字段：

- 顶层新增：`variables`、`context_blocks`（详见 §2.3）。
- Step 新增：`if`、`max_visits`、`returns`、`on_return`。
- Step 权限新增子字段：`variables.read[]` / `variables.write[]` / `context_edit`（none|read|write） / `context_blocks.read[]` / `context_blocks.write[]`，与既有 `edits` 互相独立。
- Router action 新增：`goto_step`（同 job 内跳转）。

验收证据：schema、valid / invalid fixtures、字段级 validation error、DAG 循环检测、非法 router action 失败用例；v0.2 增量：goto_step 同 job 校验、step.if 表达式语法白名单测试、max_visits 上限测试、step.returns/on_return schema 测试。

### 2.2 Skill Pack Contract

Skill Pack 是能力包，不拥有流程状态。MVP 必须支持以下 exports：

- `knowledge`
- `prompts`
- `tools`
- `scripts`
- `checks`
- `functions`
- `workflow_templates`
- `policies`
- `examples`

约束：

- `kind` 必须是 `skill-pack`。
- 所有导出路径必须位于 Skill Pack 目录内。
- `functions` 是 Agent Function 描述，不是 runtime 任意函数调用。
- Skill Pack manifest 不得声明 workflow 状态转移。

验收证据：manifest schema、pack 内路径 fixture、pack 外路径失败用例、缺少 `kind` 失败用例、exports 引用不存在文件失败用例。

### 2.3 Run State Contract

Run state 是 Engine 当前状态快照。MVP 最小状态包括：

- `run_id`
- `workflow`
- `status`
- `last_event_id`
- `signals`
- `jobs`
- job 的 `status`、`activation`、`attempt`、`needs`、`current_step`、`outputs`
- optional job 的 `activated` 和 `activation_reason`
- retry job 的 `retry_reason` 和 `retry_inputs`

【v0.2 修订】state.json 新增段：

- `variables: Record<string, unknown>` — workflow 变量当前值；可通过 `applyContextPatch` 修改。
- `context_blocks: Record<string, { current_version: number; current_artifact: string }>` — 上下文块指向当前版本 artifact 的引用。
- job 内增 `step_visits?: Record<stepId, number>` — 由 `goto_step` 与 `max_visits` 协同使用；retry 时重置。

约束：

- `state.json` 只能由 Engine 通过 State Store 写入。
- 写入顺序为 append event 后原子替换 state snapshot。
- `state.last_event_id` 必须与 event log 尾部一致。
- state 损坏或 event/state 不一致时，CLI 不得继续推进 run。

【v0.2 修订】写者职责进一步细化：

| 字段 | 唯一写者入口 | 可被 patch 修改 |
|---|---|---|
| `run_id`、`workflow`、`status`、`last_event_id` | Engine 内部（createRun、advanceJob、cancelRun 等） | 否 |
| `signals` 注册表 | Engine signal handler | 否 |
| `jobs[*].status` / `attempt` / `current_step` / `retry_*` / `activation*` / `step_visits` | Engine 内部 | 否 |
| `jobs[*].outputs` | Engine acceptAgentReport | 否（通过 outputs 字段写入，不通过 patch） |
| `variables` | Engine applyContextPatch | **是** |
| `context_blocks` | Engine applyContextPatch | **是** |

任何对"否"字段的 patch 请求一律 `ValidationError`，整批回滚。保留字段集合在 Engine 代码中硬编码 + 单测覆盖。

验收证据：state transition 单测、损坏 state fixture、event/state 一致性测试、非法状态转换失败用例；v0.2 增量：applyContextPatch 触及保留字段拒绝、批次原子回滚、`variables` / `context_blocks` 读写隔离测试。

### 2.4 Event Contract

Event 是审计事实流，不是终端展示文本。MVP event 至少包含：

- `id`
- `run_id`
- `type`
- `timestamp`
- `producer`
- `job`
- `step`
- `attempt`
- `payload`

关键事件类型：

- `run_created`
- `job_ready`
- `step_started`
- `step_completed`
- `step_failed`
- `prompt_generated`
- `agent_report_accepted`
- `script_completed`
- `check_completed`
- `signal_received`
- `router_decided`
- `job_retrying`
- `job_completed`
- `run_blocked`
- `run_failed`
- `run_completed`
- `run_cancelled`

【v0.2 修订】v0.2 新增事件类型（introduced in v0.2，详见 P13/P15 development plans）：

**Adapter 生命周期（P13）：**

- `agent_invoked` — backend 启动子进程，payload 含 backend_name、command、args_hash、timeout_ms、step_artifact_dir
- `agent_completed` — backend 成功且 report.json 合法，payload 含 duration_ms、stdout/stderr/invocation artifact ref
- `agent_timed_out` — backend 触发 timeout
- `agent_failed` — backend 非零退出或 report.json 缺失/非法
- `agent_cancelled` — Ctrl-C / AbortSignal 触发

**Step 控制流（P13）：**

- `step_returned` — status 触发 on_return action，payload 含 status、mapped_action
- `step_skipped` — `if:` 求值 false，payload 含 condition string
- `step_revisited` — router goto_step 进入 step，payload 含 source_step
- `step_visit_exceeded` — step 进入次数超过 max_visits，payload 含 visit_count、max_visits

**数据层（P13）：**

- `variable_set` — applyContextPatch 写入变量
- `variable_deleted` — applyContextPatch 删除变量
- `context_block_updated` — applyContextPatch 写新版本上下文块，payload 含 new_version、artifact_ref、producer
- `context_block_deleted` — applyContextPatch 删除上下文块

**Human Gate（P15）：**

- `human_gate_waiting` — 进入 human step
- `human_decision` — 收到 approve/reject

约束：

- 所有 v0.2 新事件都通过 `nextSequentialEventId` 获取单调 ID，与既有事件共享同一序列。
- 事件格式保持 additive only：v0.2 不修改既有事件类型或 payload schema。
- 同一次 acceptAgentReport 调用可产生多条事件（如 patch 各一条 + status 一条 + step_returned 一条），顺序由 §2.6 流水线决定。

验收证据：event schema、append-only 写入测试、状态变化对应 event 测试、事件字段快照或 contract test；v0.2 增量：每类新事件 schema 测试 + acceptAgentReport 流水线事件顺序测试。

### 2.5 Artifact Contract

Artifact 是上下文载体。MVP artifact metadata 至少包含：

- `id`
- `run_id`
- `producer`
- `kind`
- `path`
- `content_type`
- `size`
- `summary`
- `created_at`

约束：

- artifact path 必须是相对 run directory 的安全路径。
- 禁止绝对路径、`..` 越界和指向 run 外部的 symlink。
- retry 不得覆盖历史 attempt artifact。
- prompt 中只放 metadata 和摘要，大内容留在 artifact 文件。

【v0.2 修订】新增 artifact kind：

- `agent_stdout` / `agent_stderr` / `agent_invocation` — backend 子进程产物与调用元信息（P13）
- `context_block` — Agent 通过 applyContextPatch 写入的上下文块版本化内容，路径形如 `context-blocks/<block-id>/v<N>.<ext>`；新版本不覆盖旧版本，所有版本保留可审计（P13）
- `human_decision_record` — human gate 决策记录（P15）

`context_block` artifact 的写者是 Engine（applyContextPatch），不是 Agent；Agent 在 `report.context_patches` 中提供 content，Engine 决定文件名与版本号。

验收证据：pathSafe 单测、artifact metadata contract test、retry attempt 目录隔离测试、artifact 越界失败用例；v0.2 增量：context_block 版本单调测试、`agent_*` artifact 摘要 200 字节边界测试。

### 2.6 Agent Report Contract

Agent Step 输出必须写入约定 report。MVP 最小 report：

```json
{
  "outputs": {},
  "artifacts": [],
  "signals": [],
  "summary": ""
}
```

【v0.2 修订】v0.2 扩展 report schema：

```json
{
  "outputs": {},
  "artifacts": [],
  "signals": [],
  "status": "approved",
  "context_patches": [
    { "kind": "variable_set", "name": "plan_status", "value": "ready" },
    { "kind": "context_block_set", "name": "current-plan", "value": "..." }
  ],
  "summary": ""
}
```

- `status?: string` — step 结构化返回；仅当 step 声明了 `returns.status` 时才参与 action 决策。
- `context_patches?: Patch[]` — workflow 变量与上下文块的修改。Patch kinds：`variable_set` / `variable_delete` / `context_block_set` / `context_block_append` / `context_block_delete`。

acceptAgentReport 处理顺序固定：

```
1. 解析 + schema 校验 report.json
2. 写入 outputs 到 state.jobs[jobId].outputs
3. applyContextPatch(context_patches)         ← v0.2 新增
   失败：整批回滚 → step_failed
4. 若 status 存在且 step 声明了 returns.status：
   applyStatusReturn(status)                  ← v0.2 新增
   触发的 action 决定下一步推进；跳过 5
5. 否则若 signals 非空：
   handleSignals(signals)
   触发的 action 决定下一步推进
6. 否则：advanceJob()
   含 step.if 跳过与 max_visits 守门
```

约束：

- report 缺失、JSON 不合法或 schema 不匹配时，当前 step failed 或 blocked，按 gate 处理。
- signal 必须先通过 Signal Handler 校验，Agent 不能直接修改 state。
- 大文本日志、diff 和测试结果应使用 artifact ref。
- 【v0.2】context_patches 必须通过 step.permissions（variables/context_edit/context_blocks）与 workflow 顶层 allowed_writers 双重校验。
- 【v0.2】context_patches 触及保留字段（jobs/signals/attempts/last_event_id 等）一律拒绝并整批回滚。
- 【v0.2】status 必须在 `returns.status.values` 列表中；未声明 returns 时 status 仅作 outputs 字段记录，不触发 action。
- 【v0.2】status 触发的 action 优先于 signals；signals 仍记录 `signal_received` 事件。

验收证据：Agent report schema、invalid report fixture、signal allowed_from 测试、Agent 直接改 state 失败用例；v0.2 增量：context_patch 流水线顺序、批次原子回滚、status 优先级、status 与 signals 共存路径测试。

### 2.7 Script Result Contract

Script Step 只返回执行结果，不推进 workflow 状态。MVP ScriptResult：

```json
{
  "exit_code": 0,
  "timed_out": false,
  "stdout": "artifact://...",
  "stderr": "artifact://...",
  "started_at": "...",
  "ended_at": "..."
}
```

约束：

- Script Step 必须支持 timeout、cwd、env、stdout / stderr capture 和 exit_code。
- timeout 必须终止进程并记录失败结果。
- 是否 continue、failed、retry 或 blocked 由 Engine 和 Gate 决定。

验收证据：timeout 集成测试、stdout/stderr artifact 测试、exit_code 映射测试、script 不直接推进 job status 的边界测试。

### 2.8 Check Result Contract

Check Step 是确定性 gate，不依赖 LLM Judge。MVP CheckResult：

```json
{
  "passed": true,
  "check_id": "code.checks.forbidden-paths",
  "failures": [],
  "artifacts": ["artifact://..."]
}
```

MVP check 能力：

- 文件存在检查
- JSON 合法性检查
- JSON Schema 检查
- 必填字段和非空字段检查
- git diff 是否存在
- 测试命令是否通过
- 禁止路径是否被修改
- runtime state 文件是否被修改
- read-only step 是否修改工作区

验收证据：check result schema、各类 check fixture、read-only 修改检测、forbidden path 失败用例、基础 gate 不调用 LLM 的边界测试。

## 3. MVP Out-of-Scope

以下能力不属于 MVP，后续任务不得提前引入，除非先修改 PRD、架构文档和 Project scope：

- 远程 Skill Registry
- 真正动态插入 Job
- 运行时 YAML patch
- 任意循环或通用表达式语言 [^v0.2-loop]
- 自动多 Agent 并发调度
- Docker sandbox
- MCP runtime
- PR 自动化
- 自动创建 Issue 或 Project
- Web UI
- 邮件或虚拟邮件系统
- 多租户权限平台
- 复杂 LLM Judge
- 完整 event sourcing 重建
- 完整 Zigma OS 发行版

[^v0.2-loop]: 【v0.2 修订】仍禁止 `while`/`for` DSL 关键字与任意脚本表达式。v0.2 引入的 `goto_step`（同 job 跳转）+ step `max_visits`（默认 3）构成**有界循环**，由计数器兜底，不属于"任意循环"范畴。表达式扩展也仅限于等值/逻辑组合，不引入函数调用、算术或字符串拼接。详见 PRD §FR-018 与 §13。

【v0.2 修订】原"Agent 直接修改 workflow 状态"已不再列入此清单（PRD §5 已修订为限定为状态机字段）。v0.2 允许 Agent 通过 `report.context_patches` 经 Engine 入口修改新增的 `variables` 与 `context_blocks` 命名空间；保留字段（jobs/signals/attempts/last_event_id 等）仍禁止 patch。

架构可以保留适配器边界，但实现阶段不得把这些能力作为隐性依赖。

## 4. 叶子任务执行 DoD

每个 Project 叶子任务完成时必须满足以下通用 DoD：

- Scope：只完成该任务声明的交付物，不引入 MVP out-of-scope 能力。
- Contract：新增 public contract 必须有 schema、type、fixture、snapshot 或 contract test。
- Boundary：实现必须符合模块依赖方向，Engine 状态推进不得被 CLI、script、check、router 或 adapter 绕过。
- Evidence：必须留下可复查证据，例如测试、fixture、验证命令输出、文档链接或明确的非代码验收记录。
- Safety：涉及文件路径、workspace 修改、state、event、artifact 或 script 执行时，必须覆盖失败路径。
- Auditability：新增状态变化必须有 event；新增产物必须有 artifact metadata 或明确说明为何不是 artifact。
- Portability：路径、shell、时间、id 和 git 行为不得写死为单平台假设。
- Reviewability：错误信息、测试名和 fixture 名必须能说明失败原因，不依赖人工猜测。

## 5. 模块依赖冻结

MVP 采用模块化单体与 clean / hexagonal 边界。依赖方向固定为：

```text
CLI -> Application -> Runtime Core
Application -> Context / Artifact
Application -> Infrastructure Ports
Infrastructure Adapters -> Infrastructure Ports
```

禁止依赖：

- `engine` 不得 import `commander`、`chalk`、`execa`、`simple-git` 或具体 fs helper。
- `workflow` 和 `skill-pack` loader 不得写 run state。
- `script` 和 `check` 不得直接推进 job status。
- `context` 不得绕过 `expose` 读取 Skill Pack 资源。
- `prompt` 不得包含完整 workflow 全量细节。
- `artifact` 不得写入 run directory 之外。
- `events` 不得只保存人类可读文本。
- `utils` 不得成为业务规则堆放区。

实现阶段可以先用代码审查和架构测试 enforcement；如发现漂移，再补 lint/import-boundary 规则。

## 6. 核心端口清单

MVP 只为外部、易变或难测依赖定义端口：

| 端口 | 使用方 | 最小能力 | 典型适配器 |
| --- | --- | --- | --- |
| `WorkflowStore` | Application / workflow | 读取 workflow YAML | local filesystem |
| `SkillPackStore` | Application / skill-pack | 读取 manifest、导出文件和 lockfile | local filesystem |
| `StateStore` | Engine / run | 读取 snapshot、原子写 snapshot、校验 last_event_id | local filesystem |
| `EventWriter` | Engine / events | append structured event、读取尾部 event id | JSONL file writer |
| `ArtifactStore` | artifact / context | 分配安全路径、写 metadata、读取摘要 | local run directory |
| `ProcessRunner` | script | 执行命令、timeout、cwd、env、capture stdout/stderr | execa adapter |
| `GitInspector` | workspace / check | status、diff、changed files | simple-git 或 git CLI adapter |
| `Clock` | events / run | 当前时间 | system clock, fake clock |
| `IdGenerator` | run / events / artifact | run id、event id、artifact id | timestamp/uuid, deterministic fake |
| `Terminal` | CLI | stdout/stderr 渲染 | console adapter |

原则：

- Runtime Core 依赖端口或纯数据，不依赖具体适配器。
- 不为纯函数 helper 创建端口。
- 端口接口由使用方定义，适配器实现放在基础设施边界。

## 7. 错误分类冻结

MVP 错误类型用于 exit code、测试断言和用户提示。最小分类：

| 错误类型 | 触发场景 | 默认处理 | exit_code |
| --- | --- | --- | --- |
| `ValidationError` | YAML、schema、字段、DAG、router action、report schema 不合法 | 命令返回非零，不创建或推进 run | 3 |
| `WorkflowError` | workflow 定义内部不一致或引用缺失 | 命令返回非零，提示引用路径或 job/step id | 3 |
| `SkillPackError` | manifest、exports、lockfile、pack 内路径错误 | 命令返回非零，提示 skill id 和导出项 | 3 |
| `StateError` | state 损坏、非法转换、event/state 不一致 | 停止推进 run，提示恢复建议 | 1 |
| `FilesystemError` | 文件不存在、写入失败、路径越界、原子替换失败 | 停止当前命令，不删除已有产物 | 5 |
| `ScriptError` | exit_code 非零、timeout、进程启动失败 | 写入 ScriptResult，由 Engine/Gate 决定状态 | 1 |
| `CheckError` | deterministic check 失败或 check 输入缺失 | 写入 CheckResult，由 Engine/Gate 决定状态 | 1 |
| `PermissionError` | read-only job 修改工作区、禁止路径被修改、state 文件被触碰 | 阻止推进或标记 check failed | 1 |
| `ArtifactError` | artifact path 非法、metadata 写入失败、retry 覆盖风险 | 停止当前 step，不推进状态 | 1 |
| `ConfigError` | active run 缺失、config 损坏、工具配置不合法 | 命令返回非零，提示修复配置 | 4 |
| `UserInputError` | CLI 参数缺失、job id 不存在、ready jobs 多于一个但未指定 | 命令返回非零，提示明确参数 | 2 |

> **设计说明**：`ValidationError`、`WorkflowError` 和 `SkillPackError` 故意共用 exit code 3，因为三者都表示"无效的定义输入"。调用方可通过错误对象的 `kind` 字段区分具体错误类型，而不是依赖 exit code。这是明确的设计决策，不是疏漏。对于尚未在 `src/utils/errors.ts` 中实现的错误类型（`StateError`、`ScriptError`、`CheckError`、`PermissionError`、`ArtifactError`），exit code 1 为计划默认值，待对应实现任务时最终确认。

错误对象至少包含：

- `kind`
- `message`
- `details`
- `suggestion`
- `exitCode`

用户可见错误应说明原因和下一步；测试断言应使用 `kind`，避免只匹配文案。

## 8. P0 完成证据映射

| Project item | 步骤 | 证据 |
| --- | --- | --- |
| P0.1 | `P0.1.1` MVP 公共契约清单 | 本文第 2 章 |
| P0.1 | `P0.1.2` MVP 不实现清单 | 本文第 3 章 |
| P0.1 | `P0.1.3` 叶子任务执行 DoD | 本文第 4 章 |
| P0.2 | `P0.2.1` 模块依赖方向 | 本文第 5 章，`docs/architecture.md` 第 5 和第 18 章 |
| P0.2 | `P0.2.2` 核心端口清单 | 本文第 6 章 |
| P0.2 | `P0.2.3` 错误分类 | 本文第 7 章 |

P0 完成后，P1 及之后的 Project item 必须把本文作为实现前置约束。
