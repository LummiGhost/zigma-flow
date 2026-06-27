---
phase: p13
title: Agent Adapter Hardening and Agent-Driven Flow Control
status: proposed
date: 2026-06-27
last-revised: 2026-06-27 (scope expansion: structured returns, context variables, conditional flow)
authority: docs/prd.md §FR-005 §FR-009 §FR-010 §FR-012 §FR-014 §FR-015 §13 §24, docs/mvp-contracts.md §2.1 §2.3 §2.4 §2.5 §2.6
predecessor: PR #87 (run-all + Claude Code backend), PR #88 (v0.2 roadmap docs)
target-pr: 1（如体量超 2500 行可拆为 P13a/P13b，见 §12）
---

# P13 Agent Adapter Hardening + Agent-Driven Flow Control 开发计划

## 1. 阶段目标

P13 的初始范围是把 PR #87 引入的 Claude Code backend 和 `run-all` 命令打磨为可生产使用的自动执行路径。**本次评审在初始范围之上新增三条 Agent 主动控制流能力**（详见 §1.1 与 §3.1）：

1. **结构化返回状态**：Agent 在 report 中可输出 `status`，workflow 在 step 上声明 `returns` + `on_return` 映射，由 Engine 翻译为 `continue` / `retry_job` / `goto_step` / `fail` / `block`。
2. **Workflow 变量与上下文块编辑**：Agent 可在 report 中输出 `context_patches`，对 workflow 声明的"变量"或"上下文块"做新增/修改/删除。**Engine 仍是 state.json 的唯一写者**，patch 只能修改新增的"变量命名空间"和"上下文块命名空间"，不能修改 job/step status、attempts、signals 等状态机字段。
3. **条件、跳转与有界循环**：step 支持 `if:` 跳过；router 增加 `goto_step` 动作；每个 step 设 `max_visits`（默认 3）作为环路安全阀，防止无限循环。

**核心命题：**

- Agent backend 是 Engine 的一个适配器，其生命周期事件必须可审计、失败必须遵循 workflow 声明的 retry 语义、产物必须落 artifact、取消必须保留干净的 run 状态。
- Agent 通过 **结构化 report 字段** 控制流程，而非直接写 state.json；Engine 通过新增的 `applyContextPatch`、`applyStatusReturn`、`evaluateStepCondition` 三个入口翻译 Agent 的意图为合法状态转移。
- 新增能力**全部走数据契约**：workflow YAML 声明 + report schema + Engine 入口，不引入任意脚本、任意循环或运行时 YAML patch。

### 1.1 与 PRD 既有约束的关系

新增能力需要修订以下 PRD/合同条款（见 §13）：

| 条款 | 现状 | 修订方向 |
|---|---|---|
| PRD §5 非目标 "Agent 直接修改 workflow 状态" | 禁止 | 限定为禁止 Agent 修改"状态机字段"（job/step status、attempts、signals 注册表）；新增"变量与上下文块"命名空间允许 Agent 通过 patch 修改 |
| PRD §5 非目标 "任意循环" | 禁止 | 仍禁止 `while`/`for` DSL；本阶段引入的循环走 `goto_step` + 每 step `max_visits` 上限，无 DSL 关键字 |
| PRD §5 非目标 "运行时 YAML patch" | 禁止 | 保持禁止；workflow 定义在 run 期间不可变；变量/上下文块只在 run state 层修改，不回写 workflow YAML |
| mvp-contracts §2.6 "Agent 不能直接修改 state" | 不变 | 不变；patch 走 Engine 入口；Engine 是唯一写者 |
| PRD §FR-009 Router action 集合 | `continue` / `fail` / `block` / `retry_job` / `activate_job` / `goto_job` | 新增 `goto_step`（同 job 内、有 `max_visits` 限制） |

## 2. 前置条件

- main 在 d579b42（v0.1.0 MVP RC + PR #87 + run-all 续跑修复）。
- v0.2 roadmap 已合入 main。
- 没有 open issue。
- `src/agent/` 已具备 `AgentBackend` 接口、`AgentBackendFactory`、`ClaudeCodeBackend`。
- `src/commands/run-all.ts` 已有主循环骨架（450+ 行单文件）。

## 3. 范围与边界

### 3.1 In-scope

**A. Adapter 硬化（初始范围，对应 v0.2-roadmap D-1..D-3, D-6, D-7）**

| 主题 | 内容 |
|---|---|
| 编排归位 | 把 `run-all.ts` 主循环里业务规则（attempt 推进、state 转移、event 写入）下沉到 `src/engine/runAll.ts`；`commands/run-all.ts` 退化为 CLI 适配 + 日志 |
| Agent 调用事件 | 新增 `agent_invoked` / `agent_completed` / `agent_timed_out` / `agent_failed` / `agent_cancelled` 五类事件（schema 与写入路径） |
| Agent 产物落地 | backend 执行结果落 `agent_stdout`、`agent_stderr`、`agent_invocation` 三类 artifact，metadata 进 `artifacts.jsonl` |
| 失败 → retry | agent_failed / agent_timed_out 不再直接 `run.failed`；走 `attempt + 1` 直到 `retry.max_attempts`，再按 `on_exceeded` 处理 |
| 续跑 | `run-all --resume <run-id>` 跳过 createRun，从现有 state 接着跑；与 `--task` 互斥 |
| 取消 | Ctrl-C / SIGINT 进入 `cancelRun` 路径：终止 backend 子进程、追加 `agent_cancelled` + `run_cancelled` 事件、状态写为 `cancelled` |
| 事件 ID 端口 | `src/events/index.ts` 暴露 `nextSequentialEventId(runDir)`，删除所有 `parseInt(lastId.replace("evt-", ""), 10)` 散点 |
| Backend 配置 | 允许 step 级 backend 覆盖（`step.agent.backend`），允许 step 级 timeout 覆盖；配置加载从 `loadAgentConfig` 抽到 `src/agent/config.ts` |
| 诊断 | `claude` 命令不存在、退出码 401/403、stderr 含 `not logged in` 等情况返回带 `suggestion` 的 `ConfigError`/`PermissionError`，而非裸字符串 |
| 文档 | `docs/architecture.md` §11 安全章节新增 "Agent backend" 节；README 增 `run-all --resume` 说明 |

**B. 结构化返回状态（扩展范围 §1.1.1）**

| 主题 | 内容 |
|---|---|
| Step `returns` schema | workflow step 增 `returns: { status: { values: [...], required } }` 字段，声明合法 `status` 集合 |
| Step `on_return` 映射 | step 内或紧随其后的 router 中声明 `on_return: { <status>: <action> }`；action 复用既有 router action 集合 + 新增 `goto_step` |
| Agent report 扩展 | `report.json` schema 增 `status: string` 顶层字段；与 signals 并存（先处理 status，未匹配再处理 signals）|
| Engine 入口 | 新增 `applyStatusReturn({ runDir, runId, jobId, stepId, status, ... })`：校验 status 是否在 `returns.status.values` 中，找到对应 action 并复用 `applyRoutingAction` |
| 事件 | 新增 `step_returned`（payload: status, mapped_action） |
| 默认行为 | 未声明 `returns` 时，Agent 返回的 status 视为日志、不触发行为；与 signals 互不影响 |

**C. Workflow 变量与上下文块（扩展范围 §1.1.2）**

| 主题 | 内容 |
|---|---|
| 变量命名空间 | workflow 顶层 `variables:` 声明类型化变量（name、type、initial、allowed_writers）；运行时 state.json 增 `variables: Record<string, unknown>` 段 |
| 上下文块命名空间 | workflow 顶层 `context_blocks:` 声明命名上下文块（id、initial、allowed_writers）；运行时存为 artifact（kind=`context_block`）+ state.json 中保存 `context_blocks: Record<string, ArtifactRef>` 段 |
| Patch 操作 | Agent report 增 `context_patches: Array<Patch>`；Patch 类型：`variable_set` / `variable_delete` / `context_block_set` / `context_block_append` / `context_block_delete` |
| 权限模型 | step 权限增 `variables: { read: [...], write: [...] }` 和 `context_edit: read \| write \| none`；与 `edits`（文件编辑）**完全独立** |
| Engine 入口 | 新增 `applyContextPatch({ runDir, runId, jobId, stepId, patches, clock })`：逐条校验权限和 schema，串行写入 state.json + artifact；任意一条失败整批回滚 |
| 事件 | 新增 `variable_set` / `variable_deleted` / `context_block_updated` / `context_block_deleted` |
| 表达式 | `${{ variables.<name> }}` 表达式（继 P15 同时引入 `${{ steps.<id>.outputs.<key> }}`，本阶段把这两项一起做） |
| Context Builder | 把 `variables` 与 `context_blocks` 注入 Agent prompt，受 step 权限白名单约束 |

**D. 条件、跳转与有界循环（扩展范围 §1.1.3）**

| 主题 | 内容 |
|---|---|
| Step `if:` | step 顶层支持 `if: <expression>`；表达式为 false 时跳过该 step（状态 `skipped`），写 `step_skipped` 事件 |
| Router `goto_step` | router action 增 `goto_step: <step-id>` + 可选 `goto_with: { ... }`；仅允许跳到**当前 job** 内的 step；跨 job 走 `goto_job`（已有） |
| `max_visits` | step 顶层支持 `max_visits: N`（默认 3）；每次进入 step 增计数；超过上限 → step 进入 `blocked`，写 `step_visit_exceeded` 事件 |
| Workflow 校验 | `goto_step` 目标必须存在、必须在同 job；表达式中变量必须已声明；DAG 校验不强制 step 之间无环（环允许，由 `max_visits` 兜底） |
| 事件 | 新增 `step_skipped`（含 if-表达式）、`step_visit_exceeded`、`step_revisited`（goto 进入） |

### 3.2 Out-of-scope（保留给 P14/P15/v0.3）

- 并发执行（P14）。
- Human gate step（P15）。
- 多 backend 同时存在（factory 已支持注册，但 P13 只实测 Claude Code）。
- Codex、Gemini 或其他 backend 实现。
- backend 子进程沙箱（Docker、worktree）—— PRD §24 v0.3+ 项。
- 真正的 event sourcing 回放（仍只追加事件，不重建 state）。
- **Agent 直接修改 state.json 的 jobs/signals/attempts 字段** —— 永久 out-of-scope；状态机字段只允许 Engine 写。
- **任意脚本表达式**（如 JS 求值、字符串拼接函数）—— 表达式仅支持 `${{ ... }}` 受限插值 + 等值/存在性比较，不引入 sandbox。
- **`while:` / `for:` DSL 关键字** —— 不引入；循环走 `goto_step` + `max_visits`。
- **运行时 YAML patch**（Agent 修改 workflow 定义）—— 保持禁止；变量与上下文块只在 run state 层修改。
- **跨 job goto_step** —— 跨 job 跳转走 `goto_job`（已有，PRD §FR-009）。
- **变量类型系统的完备性**（嵌套校验、引用类型）—— 本阶段只支持 `string` / `number` / `boolean` / `array` / `object` 顶层 schema 检查，深层 schema 留 v0.3。

## 4. 架构决策

### AD-P13-001 — run-all 主循环下沉到 engine

**决策：** 新建 `src/engine/runAll.ts`，导出 `runAll(opts: RunAllOpts): Promise<RunAllSummary>`。`commands/run-all.ts` 只负责：参数解析、配置加载、日志渲染、`process.on("SIGINT", ...)` 注册、调用 `runAll`。

**理由：** `commands/run-all.ts` 当前 460 行，CLI 渲染 + 业务规则混杂。Engine 是唯一状态推进者（mvp-contracts §2.3），把 attempt/事件/state 写入挪进 engine 是合规要求。

**实现要点：**

- `RunAllOpts` 字段：`runId | task`、`workflowPath`、`runsDir`、`zigmaflowDir`、`skillLockPath`、`backendResolver: (stepBackendName?) => AgentBackend`、`clock`、`signal?: AbortSignal`、`maxIterations?: number`、`onEvent?: (e) => void`（仅日志钩子，不参与状态）。
- `RunAllSummary` 字段：`runId`、`status`、`jobs: Array<{ id, status, attempts }>`、`iterations`。

### AD-P13-002 — Agent 调用生命周期事件

**决策：** 每次 backend 调用前后必须产生事件链：

```
agent_invoked  (在 backend.execute 之前)
  └─ agent_completed | agent_timed_out | agent_failed | agent_cancelled  (二选一)
```

随后才是既有的 `agent_report_accepted` 或 `step_failed`。

**事件 payload 最小集合：**

| 事件 | payload 字段 |
|---|---|
| `agent_invoked` | `backend_name`、`command`、`args_hash`（不存 token）、`timeout_ms`、`step_artifact_dir` |
| `agent_completed` | `duration_ms`、`stdout_artifact`、`stderr_artifact`、`invocation_artifact` |
| `agent_timed_out` | `duration_ms`、`timeout_ms`、`stdout_artifact`、`stderr_artifact` |
| `agent_failed` | `duration_ms`、`exit_code`、`reason`、`stdout_artifact`、`stderr_artifact` |
| `agent_cancelled` | `duration_ms`、`reason`（"signal:SIGINT" / "abort"） |

**理由：** 满足 mvp-contracts §2.4 的可审计要求，使 events.jsonl 能单独复盘 backend 行为。

### AD-P13-003 — Backend 产物作为 artifact

**决策：** `ClaudeCodeBackend.execute` 不再把 stdout/stderr 嵌进 error message；改为：

- backend 写入 `${stepDir}/agent.stdout.log` 和 `${stepDir}/agent.stderr.log`。
- backend 返回结构化结果：`{ success, exitCode, stdoutPath, stderrPath, invocationPath, durationMs }`。
- runAll 调用 `artifact/index.ts` 把这三个文件登记为 artifact（kind=`agent_stdout` / `agent_stderr` / `agent_invocation`），写入 `artifacts.jsonl`。
- 错误消息只携带摘要 + artifact ref。

**理由：** PRD §13 要求大型日志走 artifact 引用而不是塞进 report/error；当前实现把 stdout 截尾 1000 字符当 error 内容，违反契约。

### AD-P13-004 — Agent 失败走 retry 而不是 run.failed

**决策：** Backend 失败时（agent_timed_out / agent_failed），runAll 调用新增的 engine 入口 `recordAgentFailure({ runDir, runId, jobId, stepId, reason, attempt })`。该入口：

1. 写 `step_failed` 事件。
2. 读取 `JobDefinition.retry`：若当前 attempt < max_attempts，调用既有 `retryJob`（attempt += 1，新建 attempt 目录，状态回 `ready`）。
3. 若达到 max_attempts，按 `retry.on_exceeded.status`（默认 `blocked`）置 job 状态，并按 v0.1 既有路径处理。

**理由：** 现行 run-all 把任何 backend 失败直接置 run 为 failed，等同绕过 FR-012 retry 契约。这是 P13 最重要的语义修复。

**例外：** `ConfigError`（如 backend 不存在）/ `PermissionError`（如 claude 未登录）属于配置类错误，不应触发 retry；直接 `run.failed` 退出码 4。

### AD-P13-005 — 续跑模式

**决策：** `zigma-flow run-all` 增加互斥参数：

- `--task <text>`：等同当前行为，创建新 run。
- `--resume <run-id>`：跳过 createRun；读取已有 state 后进入主循环。

约束：

- `--resume` 必须指向 `runs/<run-id>/state.json` 存在的 run。
- 当 state 是终态（completed/failed/blocked/cancelled）时拒绝续跑，提示用 `retry`/新 run。
- 续跑不重新 snapshot skill-lock；若 skill-lock 已变，比较 hash 并在不一致时拒绝（默认）或在 `--allow-skill-drift` 时记 `skill_lock_drift` warning（暂不实现 warning event，stretch）。

**理由：** 长 run 中断后无回收路径；续跑是最低成本的恢复机制，不要求 event sourcing。

### AD-P13-006 — 取消语义

**决策：** runAll 接收 AbortSignal；CLI 在 SIGINT 上 abort。取消触发：

1. 调用当前 backend.execute 的 cancelSignal，等待最多 5 秒后强杀（execa 已支持）。
2. 写 `agent_cancelled` 事件（如果正在 agent 调用中）。
3. 写 `run_cancelled` 事件。
4. state.status = `cancelled`，运行中 job.status = `cancelled`。
5. exit code 130（Unix 惯例：128 + SIGINT）。

**理由：** 当前 SIGINT 直接 kill 进程，留下 `running` job 和不一致的 state.json。

### AD-P13-007 — 事件 ID 序列号端口

**决策：** `src/events/index.ts` 新增：

```ts
export async function nextSequentialEventId(
  runDir: string,
  eventWriter?: EventWriter,
): Promise<string>;
```

实现读 `events.jsonl` 尾部、parseInt、+1、格式化为 `evt-NNN`。所有调用点改用它，删除散落的 parseInt。

**理由：** 现状 5+ 处重复实现，是回归温床。这是 housekeeping，但与 P13 新事件类型一并完成成本最低。

### AD-P13-008 — 配置加载抽离

**决策：** `src/agent/config.ts` 暴露：

```ts
loadAgentConfig(zigmaflowDir): Promise<AgentConfig>
resolveBackendForStep(agentConfig, stepDef, cliOverride): { name, config }
createBackend(name, config): AgentBackend
```

`commands/run-all.ts` 和未来 `commands/step.ts`、`commands/next.ts` 都可调用。

**理由：** P14 并发执行会复用 backend 解析逻辑；P15 暂不复用但保持一致接口。

### AD-P13-009 — 结构化返回状态

**决策：** workflow step 声明可选 `returns` + `on_return`：

```yaml
- id: review
  type: agent
  uses: agent://reviewer
  returns:
    status:
      values: [approved, rejected, needs_clarification]
      required: true       # report.status 必须出现且在 values 内
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

Agent report schema 在 v0.2 扩展为：

```json
{
  "outputs": {},
  "artifacts": [],
  "signals": [],
  "status": "rejected",            // NEW (optional unless step.returns.status.required)
  "context_patches": [],            // NEW — see AD-P13-010
  "summary": ""
}
```

Engine 接受 report 流程（修订 `acceptAgentReport`）：

1. 解析 report，校验 schema。
2. 若 `status` 存在且 step 声明了 `returns.status`：调用 `applyStatusReturn`，根据 `on_return` 映射执行 action（`continue` / `retry_job` / `activate_job` / `goto_job` / `goto_step` / `fail` / `block`）；写 `step_returned` 事件。
3. 若 `status` 缺失但 `returns.status.required=true`：ValidationError，按 step_failed 路径。
4. 若 `status` 存在但 step 未声明 `returns.status`：写入 outputs（`status=approved`）并按既有 signal/无 signal 路径推进；不解释为 action。
5. signals 仍按既有规则处理（priority 排序后 dispatch）。**status 优先于 signals**：status 已触发 action 则忽略 signals 触发的 action（但 signal 仍记录 `signal_received` 事件）。

**理由：**

- signals 是 workflow 顶层声明的"跨 step 升级机制"（如 `needs_architecture_design`、`blocked`）；status 是"当前 step 的本地决策"（如 review 的 approved/rejected）。两者语义不同，硬塞进 signal 会让 schema 越来越胖。
- status 配合 `goto_step` 直接表达"planner 返回 ready / partial / blocked，分别推进/重做/升级 review"等模式，不必预先把每种决策都建模为顶层 signal。

### AD-P13-010 — Workflow 变量与上下文块命名空间

**决策：** 引入两个新命名空间，作为 Agent 可控的"工作流数据层"，**与状态机字段隔离**：

**1) 变量（`variables`）**：

workflow 顶层声明：

```yaml
variables:
  plan_status:
    type: string
    initial: pending
    enum: [pending, ready, blocked]
    allowed_writers:
      - plan.plan        # 形如 <job_id>.<step_id>
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
      - implement.*       # 通配符允许整个 job 写
```

state.json 增段：

```json
{
  "variables": {
    "plan_status": "ready",
    "open_questions": [...],
    "iteration_count": 2
  }
}
```

**2) 上下文块（`context_blocks`）**：

workflow 顶层声明：

```yaml
context_blocks:
  current-plan:
    initial_artifact: null      # 或指向 Skill Pack 中的初始模板
    allowed_writers: [plan.plan, implement.edit]
  reviewer-notes:
    initial_artifact: null
    allowed_writers: [review.review]
```

每个上下文块在 run 目录下作为 artifact 存在：
```
runs/<runId>/context-blocks/<block-id>/v<N>.md
```

state.json 增段：

```json
{
  "context_blocks": {
    "current-plan": {
      "current_version": 3,
      "current_artifact": "artifact://.../context-blocks/current-plan/v3.md"
    }
  }
}
```

**Patch 操作**：

Agent report `context_patches` 字段为数组，每条形如：

```json
[
  { "kind": "variable_set", "name": "plan_status", "value": "ready" },
  { "kind": "variable_delete", "name": "open_questions" },
  { "kind": "context_block_set", "id": "current-plan", "content": "..." },
  { "kind": "context_block_append", "id": "reviewer-notes", "content": "..." }
]
```

**Engine 入口 `applyContextPatch`**：

- 在 `acceptAgentReport` 处理 outputs 之后、处理 status/signals 之前执行。
- 对每条 patch：
  - 校验 step 是否在 `allowed_writers`（精确匹配或 `<job>.*` 通配）；权限拒绝 → ValidationError。
  - 校验 `kind` 与 schema：variable_set 的 value 必须符合 variable.type 与 enum；context_block_set 的 content 是 string。
  - **批次原子性**：任意一条失败整批回滚，不写 state、不写事件、不写 artifact。
  - 校验通过后：
    - variable_set / variable_delete → 修改 state.variables 段（in-memory）。
    - context_block_set / context_block_append → 写新版本 artifact（kind=`context_block`），更新 state.context_blocks 段。
- 全部成功后：原子写一次 state.json + 多条事件（每条 patch 一条事件）。
- 事件类型：`variable_set`、`variable_deleted`、`context_block_updated`（payload 含 new_version、artifact_ref、producer）、`context_block_deleted`。

**与状态机的边界（强约束）**：

`applyContextPatch` 永远不修改：

- `state.status`（run status）
- `state.jobs[*].status` / `attempt` / `current_step` / `retry_*` / `activation*`
- `state.signals`
- `state.last_event_id`（仅由 EventWriter + StateStore 协同管理）

任何对这些字段的 patch 请求都是 `ValidationError`，整批回滚。

**Context Builder 注入**：

`buildContext` 把 variables 与 context_blocks 注入 prompt：

- 变量：以 `## Variables` section 渲染，仅展示 step 的 `permissions.variables.read` 允许的项；未声明 read 权限的变量不出现在 prompt 中。
- 上下文块：以 `## Context Blocks` section 渲染，按 `context_edit` 权限决定是 read 还是 read+write 注解（write 时 prompt 提示 Agent 可通过 `context_patches` 修改）。

**理由：**

- variables 给 planner/reviewer 一个把决策结果传给后续 step 的轻量通道，避免把所有上下文都堆进 outputs 或 signals。
- context_blocks 是"动态文档"，承担之前 PRD §13 artifact 一等公民的延伸：artifact 不可变（PRD §13 "artifact 不应被自动删除"），而 context_block 是版本化的可写文档，每次写都是新 artifact 版本，旧版本保留可审计。
- patch 模式（vs Agent 直接写文件）确保所有修改走 Engine，可被 event log 完整重建，符合 mvp-contracts §2.3。

### AD-P13-011 — 权限模型扩张（`context_edit` 与 `variables` 独立于文件编辑）

**决策：** step 权限扩张为：

```yaml
permissions:
  contents: read          # 已有：文件读
  edits: none             # 已有：文件写（执行 `repo.edit` 等工具）
  commands: none          # 已有：shell 命令权限
  workflow_state: none    # 已有：禁止改 state.json 状态机字段（语义不变）
  variables:              # NEW
    read: [plan_status, iteration_count]
    write: [plan_status]
  context_edit: read      # NEW: none | read | write
  context_blocks:         # NEW (write 模式时声明哪些块可写)
    read: [current-plan, reviewer-notes]
    write: [current-plan]
```

约束：

- `variables.write` 列表中的每一项必须是 workflow 顶层 `variables.<name>.allowed_writers` 也允许的（双重校验：step 自身声明 + workflow 顶层声明）。
- `context_blocks.write` 同理双重校验。
- `context_edit: none` 时整批 `context_patches` 都被拒绝（即使 step 列了 write 项）。
- 未声明的字段默认全部 `none`/空数组（最小权限原则）。

**理由：**

- 用户明确要求"上下文编辑功能的权限独立于文件编辑"。我们把它实现为独立的权限轴：一个 step 可以 `edits: write`（改源码）但 `context_edit: none`（不能改 context blocks），反之亦然。
- planner 通常 `edits: none, variables: write, context_edit: write`；implement 通常 `edits: write, variables: write, context_edit: write`；review 通常 `edits: none, variables: write, context_edit: write`。

### AD-P13-012 — `if:` 条件、`goto_step` 与有界循环

**决策：** step 与 router 各扩展一项：

**Step `if:`**

```yaml
- id: gather-context
  type: agent
  if: "${{ variables.plan_status == 'needs_context' }}"
  uses: agent://researcher
```

求值规则：

- 表达式只能是受限的等值/存在/逻辑组合：`==` / `!=` / `&&` / `||` / `!` + 既有 `${{ ... }}` 插值。
- 不允许函数调用、不允许字符串拼接、不允许任意 JS。
- false → step 直接 `skipped`，写 `step_skipped` 事件（payload: condition），调用 advanceJob 跳到下一 step。
- 表达式解析失败（变量未声明、语法错） → ValidationError，job 进入 failed。

**Router `goto_step`**

```yaml
- id: route-plan
  type: router
  switch: "${{ steps.plan.outputs.status }}"
  cases:
    incomplete:
      goto_step: gather-context     # 同 job 内跳回
    ready:
      continue: true
```

约束：

- `goto_step` 目标必须存在于**同一 job** 的 `steps` 中；跨 job 用 `goto_job`（已有）。
- 触发 `goto_step` 时：写 `step_revisited` 事件、写 `router_decided`、重置目标 step 的状态为 `pending`、`current_step` 指向目标 step、增加目标 step 的 visit count。
- 目标 step 的 attempts 不增加（attempt 是 job 级别的概念，不变）。

**`max_visits`**

```yaml
- id: gather-context
  max_visits: 5
```

约束：

- 每次进入 step 时，Engine 在 `state.jobs[<jobId>].step_visits: Record<stepId, number>` 计数 +1。
- 超过 `max_visits`（默认 3） → step 状态 `blocked`、job 状态 `blocked`、写 `step_visit_exceeded` 事件。
- visit 计数随 `retryJob`（attempt+1）重置为 0（新 attempt 一切重来）。

**理由：**

- `if:` 是 PRD §11 已示意的能力（`optional_job` 有 `if: ${{ signals.needs_architecture_design }}`），这里扩到 step 级。
- `goto_step` 让 planner/reviewer 通过 status 把流程指向 job 内的特定 step，而不必动用 retry_job 整体重做。
- `max_visits` 是 PRD §5 "禁止任意循环" 的合规边界：不引入循环 DSL，但允许 goto 形成环，由计数器兜底，符合"所有动态流程都有上界"的原则。

### AD-P13-013 — 接受 Agent Report 的修订流水线

**决策：** `acceptAgentReport` 在 P9 已经存在；本阶段把它扩张为一条线性流水线，所有新机制按固定顺序应用：

```
1. Read & validate report.json (schema)
2. Persist outputs to state.jobs[jobId].outputs   ← 已有
3. applyContextPatch(report.context_patches)      ← NEW (AD-P13-010)
   ↳ 失败：整批回滚，step_failed，结束
4. If report.status declared:
       applyStatusReturn(report.status)            ← NEW (AD-P13-009)
       ↳ 触发的 action 决定下一步推进；status 已处理则跳过 5
5. If signals non-empty:
       handleSignals(report.signals)               ← 已有
       ↳ 触发的 action 决定下一步推进
6. Otherwise:
       advanceJob()                                ← 已有
       ↳ 含 step-level if 跳过逻辑
       ↳ 含 max_visits 守门逻辑
```

每一步失败都触发整体 step_failed（不部分提交），保持 step 原子性。

**理由：** 显式排序消除新机制与既有 signal 路径的歧义；所有 patch 类操作集中在一个入口便于审计与回滚。

## 5. 工作流拆分（同 PR 内部按文件域切）

### WF-P13-ENGINE-RUNALL

**目标：** AD-P13-001、AD-P13-007 落地 — 把 run-all 主循环搬进 engine，事件 ID 端口可用。

**边界：** 新增 `src/engine/runAll.ts`、`src/events/sequence.ts`。修改 `src/commands/run-all.ts` 仅保留 CLI 壳。其他模块不动。

**验收：**

- `runAll()` 在测试里可直接调用，对 fake clock / 内存 stateStore 可注入。
- 既有 `tests/cli/run-all.*` 行为不变（绿）。
- 新增 `tests/engine/runAll.test.ts`：覆盖 happy path（agent → script → router 完成）、空 ready 场景、MAX_ITERATIONS 守门。

### WF-P13-EVENTS-ARTIFACTS

**目标：** AD-P13-002、AD-P13-003 — 新增 5 类 agent 事件 + 3 类 artifact kind。

**边界：** `src/events/types.ts` 增 event 枚举；`src/agent/backends/claude-code.ts` 改返回结构；`src/engine/runAll.ts` 在 backend 调用前后写事件并登记 artifact。

**验收：**

- `ClaudeCodeBackend.execute` 不再在 error 内嵌截尾字符串；改为产出文件路径。
- runAll 调用 backend 后必产出至少一个 agent_invoked + agent_completed/failed/... 事件对。
- artifacts.jsonl 含三条 agent_* artifact。
- mvp-contracts.md §2.4 同步追加事件列表（标 "introduced in v0.2"）。

### WF-P13-RETRY

**目标：** AD-P13-004 — agent 失败走 retry。

**边界：** 新增 `src/engine/recordAgentFailure.ts`；改 runAll 在失败时调用它而不是直接置 run.failed。

**验收：**

- 单测：mock backend 第一次失败、第二次成功，job 最终 completed，attempts 目录有 1 和 2。
- 单测：mock backend 连续失败超过 max_attempts，job 进入 `on_exceeded.status`，run 不是 failed（默认 blocked）。
- 单测：ConfigError（backend not found）不触发 retry，直接 run.failed exit 4。

### WF-P13-RESUME-CANCEL

**目标：** AD-P13-005、AD-P13-006 — `--resume` + SIGINT 取消。

**边界：** `commands/run-all.ts` 增 `--resume` / `--allow-skill-drift` 参数；`src/engine/runAll.ts` 接收 AbortSignal；新增 `cancelRun` 引擎入口。

**验收：**

- 单测：在 backend.execute 进行中触发 abort，事件链含 `agent_cancelled` + `run_cancelled`，state.status = cancelled。
- 集成测：先 createRun + 部分推进，再用 `--resume <id>` 跑到完成，attempts 数量正确。
- `--resume` 指向已 completed run 时返回 UserInputError，exit code 2，明确建议。

### WF-P13-BACKEND-CONFIG

**目标：** AD-P13-008 + 诊断增强。

**边界：** 新增 `src/agent/config.ts`；refactor `commands/run-all.ts` 调用新模块；`ClaudeCodeBackend.execute` 内部对常见失败模式分类（command not found / not logged in / rate limited）。

**验收：**

- 单测：step 级 `backend` 覆盖全局 backend；step 级 timeout 覆盖全局 timeout。
- 单测：command not found 返回 `ConfigError` with suggestion "install claude CLI 或检查 PATH"。
- 文档：README 一节列出 `.zigma-flow/config.json` 的 agent 字段示例。

### WF-P13-RETURNS

**目标：** AD-P13-009 — Step 结构化返回状态。

**边界：**

- `src/workflow/schema.ts` 增 `returns` + `on_return` step 字段 schema。
- `src/engine/applyStatusReturn.ts`（新）。
- `src/engine/accept.ts` 中接受 status 字段并按流水线（AD-P13-013）分发；既有 signal 路径不变。
- Agent report schema (zod) 增 `status?: string`。

**验收：**

- 单测：返回声明的 status → 触发 `on_return` 中对应 action；事件链含 `step_returned`。
- 单测：required=true 但 report.status 缺失 → ValidationError → step_failed。
- 单测：status 未在 values 中 → ValidationError → step_failed。
- 单测：未声明 `returns` 时 status 字段被记录在 outputs 中，不触发动作；signals 仍按既有路径运行。
- 集成测：planner step 返回 `incomplete` → `goto_step: gather-context`，再返回 `ready` → 继续 implement。

### WF-P13-VARIABLES

**目标：** AD-P13-010、AD-P13-011 — variables / context_blocks 命名空间、Patch、权限、Context Builder 注入。

**边界：**

- `src/workflow/schema.ts` 增 `variables` / `context_blocks` 顶层段、step `permissions` 子字段。
- `src/run/index.ts` 的 `RunState` 类型增 `variables` / `context_blocks` 段；初始化逻辑读 workflow `initial`。
- `src/engine/applyContextPatch.ts`（新）：校验、批次原子、写 state + artifact + events。
- `src/artifact/index.ts` 新增 `context_block` artifact kind 写入路径（含 v<N> 文件名）。
- `src/context/index.ts` 在 buildContext 中按权限注入 variables 与 context_blocks。
- `src/expression/index.ts` 增 `variables.<name>` 解析（顺便清偿 TD-P9-001 `jobs.<id>.outputs.<key>` 与 TD-P9-002 `steps.<id>.outputs.<key>`）。
- `src/engine/accept.ts` 在 outputs 写入之后、status/signals 之前调用 applyContextPatch。

**验收：**

- 单测：variable_set 通过权限 → 写入；不通过 → 整批回滚，state/事件/artifact 三者都未变化。
- 单测：context_block_set 写出 v2 artifact，state.context_blocks.<id>.current_version === 2。
- 单测：试图 patch 保留字段（如 `state.jobs.implement.status`）→ ValidationError。
- 单测：未声明 `context_edit` 权限的 step 给出 patches → ValidationError。
- 单测：`${{ variables.plan_status }}` 在 router switch / step `if` / `with` 都能解析。
- 集成测：planner 写 `plan_status=ready`、implement 在 step `if: ${{ variables.plan_status == 'ready' }}` 通过；planner 写 `plan_status=blocked` → implement step 被 skipped。

### WF-P13-FLOW

**目标：** AD-P13-012 — step `if:`、router `goto_step`、`max_visits`。

**边界：**

- `src/workflow/schema.ts` 增 `step.if`、`step.max_visits`、`RouterAction.goto_step`。
- `src/workflow/validateDag.ts` 增 goto_step 目标存在性 + 同 job 校验；不强制无环（环允许）。
- `src/engine/routing.ts` 新增 `goto_step` 分支；写 `step_revisited` 事件，重置目标 step 状态、推进 visit 计数。
- `src/engine/advanceJob.ts` 在选定下一 step 后求值 `if` 表达式；false → `step_skipped` 事件 + 继续推进。
- `src/expression/index.ts` 增等值/逻辑组合（受限）。
- `src/run/index.ts` 的 `JobState` 类型增 `step_visits?: Record<string, number>`；retryJob 重置该字段。

**验收：**

- 单测：`if` false 的 step → status=skipped，事件链 step_skipped → 下一 step started。
- 单测：goto_step 同 job 内跳到目标 step → 目标 step pending、current_step 更新、visit 计数 +1。
- 单测：goto_step 目标不存在或跨 job → ValidationError。
- 单测：连续 goto_step 至超过 max_visits → step blocked + step_visit_exceeded + job blocked。
- 单测：max_visits 未声明时使用默认 3。
- 单测：retryJob 后 step_visits 清零。
- 集成测：构造含环 workflow（plan → goto_step → plan）跑到 max_visits 触发 blocked，整体可审计。

## 6. 工作流依赖与提交顺序

扩张后 P13 共 8 个 WF。建议依赖关系：

```
WF-P13-ENGINE-RUNALL (refactor 骨架, 不改外观)
   └─ WF-P13-EVENTS-ARTIFACTS (在新骨架上加事件+artifact)
       ├─ WF-P13-RETRY (重接失败路径)
       │     ├─ WF-P13-RESUME-CANCEL
       │     └─ WF-P13-BACKEND-CONFIG
       └─ WF-P13-RETURNS (status + on_return + step_returned 事件)
             └─ WF-P13-VARIABLES (variables / context_blocks / patch / 权限 / 表达式)
                   └─ WF-P13-FLOW (if + goto_step + max_visits)
```

设计要点：

- RETURNS 在 EVENTS-ARTIFACTS 之后：要复用新事件 ID 端口与 acceptAgentReport 的修订流水线（AD-P13-013）。
- VARIABLES 在 RETURNS 之后：context_patches 处理必须先于 status 决策（流水线第 3 步），所以两者必须同 PR 落，不能跨 PR。
- FLOW 在 VARIABLES 之后：`if:` 与 `goto_step` 中的表达式可能引用 variables，必须有 variables namespace 才能完成端到端测试。

全部并入 **PR #90（feature/p13-agent-adapter-hardening）**，但因范围扩张允许拆分（见下）。

### 6.1 PR 拆分指引

如果实现过程中 PR diff 超过 ~2500 行或 review 困难：

- **PR #90a（feature/p13-adapter-hardening）** = 初始范围：ENGINE-RUNALL + EVENTS-ARTIFACTS + RETRY + RESUME-CANCEL + BACKEND-CONFIG。
- **PR #90b（feature/p13-agent-flow-control）** = 扩展范围：RETURNS + VARIABLES + FLOW。

拆分后两 PR 顺序合并，#90b 依赖 #90a。仍保持单 PR 为首选；拆分需 reviewer 同意。

不拆 PR 的理由（仍优先）：

- 事件/Artifact 契约 + accept 流水线改造若分 PR，CI 中间状态会出现"流水线有第 3 步但无 patch 操作处理"的不可用版本。
- 重构 + 契约扩张同 PR 时，回归测试可以一次锁定新行为。

## 7. 测试规划

**A. Adapter 硬化部分（初始范围）：**

| 文件 | 新增/扩展 | 主题 |
|---|---|---|
| `tests/engine/runAll.test.ts` | 新增 | runAll 主循环、终止条件、MAX_ITERATIONS |
| `tests/engine/runAll-events.test.ts` | 新增 | agent_invoked/completed/failed/timed_out/cancelled 事件链 |
| `tests/engine/recordAgentFailure.test.ts` | 新增 | retry 推进、on_exceeded、ConfigError 直通 |
| `tests/engine/runAll-resume.test.ts` | 新增 | --resume happy path + 拒绝路径 |
| `tests/engine/runAll-cancel.test.ts` | 新增 | AbortSignal → cancelled state |
| `tests/agent/config.test.ts` | 新增 | loadAgentConfig + resolveBackendForStep |
| `tests/agent/claude-code-backend.test.ts` | 扩展 | stdout/stderr 落 artifact、分类错误 |
| `tests/events/sequence.test.ts` | 新增 | nextSequentialEventId 单调性 |
| `tests/cli/run-all.test.ts` | 修订 | 输出格式新增 backend / event / artifact 摘要 |
| `tests/dogfood/run-all-e2e.test.ts` | 扩展 | 模拟 backend 用 stub command（如 `node tests/fixtures/fake-claude.mjs`） |

**B. Agent 主动控制流（扩展范围）：**

| 文件 | 新增/扩展 | 主题 |
|---|---|---|
| `tests/workflow/returns-schema.test.ts` | 新增 | step.returns / step.on_return schema 校验 |
| `tests/workflow/variables-schema.test.ts` | 新增 | workflow.variables / context_blocks 顶层 schema |
| `tests/workflow/permissions-schema.test.ts` | 扩展 | step.permissions.variables / context_edit / context_blocks |
| `tests/workflow/flow-schema.test.ts` | 新增 | step.if / step.max_visits / goto_step 校验 |
| `tests/engine/applyStatusReturn.test.ts` | 新增 | status → on_return action 翻译；未声明 returns 时降级为 outputs |
| `tests/engine/applyContextPatch.test.ts` | 新增 | variable_set / delete / context_block_set / append / delete；权限校验；批次原子性；保留字段拒绝 |
| `tests/engine/accept-pipeline.test.ts` | 新增 | context_patch → status → signals → advance 流水线顺序与失败处理 |
| `tests/engine/goto-step.test.ts` | 新增 | router goto_step + step_revisited + visit 计数 |
| `tests/engine/step-if.test.ts` | 新增 | if false → skipped 事件 + 继续推进 |
| `tests/engine/max-visits.test.ts` | 新增 | 超过 max_visits → blocked + step_visit_exceeded |
| `tests/expression/variables.test.ts` | 新增 | `${{ variables.x }}`、`==`、`!=`、`&&`、`||`、`!` |
| `tests/expression/steps-outputs.test.ts` | 新增 | `${{ steps.<id>.outputs.<key> }}` 与 `${{ jobs.<id>.outputs.<key> }}`（TD-P9-001/002 清偿）|
| `tests/context/variables-injection.test.ts` | 新增 | Variables 段按 read 权限注入；context_blocks 段按权限注入并标注可写性 |
| `tests/artifact/context-blocks.test.ts` | 新增 | context_block artifact 命名（v1/v2/...）、metadata、不覆盖历史版本 |
| `tests/dogfood/agent-flow-control-e2e.test.ts` | 新增 | planner 用 variables+goto_step 控制流转的端到端流 |

**C. 回归：**

- 既有 ~464 测试零回归。`tests/engine/accept.test.ts`、`tests/engine/multistep.test.ts` 因流水线扩张可能需要小修订（保留语义一致）。
- 内置 code-change workflow 模板**不**在 P13 立即启用新机制，保持现状；新机制示范放在 `tests/fixtures/workflow-flow-control.yml`。

预计净增 ~120 个测试用例（adapter 部分 ~40，主动控制流部分 ~80）。

## 8. 质量门禁

```pwsh
pnpm typecheck
pnpm lint
pnpm test:ci
```

每个 WF 完成后必须本地全绿，PR push 后必须等 `gh pr checks 89` 全绿才能 merge（CI Linux ≠ 本地 Windows，见 memory feedback）。

## 9. 文档同步

**初始范围相关：**

- `docs/architecture.md` §11（安全章节）追加 "Agent Backend Lifecycle" 节，说明 invoked/completed/failed 事件契约与子进程权限边界。
- `docs/mvp-contracts.md` §2.4 在事件类型列表追加全部 v0.2 新事件（adapter 5 条 + status/variable/context/flow 共 ~10 条），并标注 "introduced in v0.2"。
- `README.md` 增 `run-all --resume` 段、`.zigma-flow/config.json` agent 字段示例。
- `CHANGELOG.md`（若未建则在本 PR 创建）记录 v0.2.0 中 P13 段。

**扩展范围相关（PRD / 合同修订，必须与代码同 PR 合入）：见 §13。**

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 拆分 run-all 触发既有 cli/run-all 集成测试连锁失败 | 中 | 重构在前，行为不变；先跑既有测试集再加新行为 |
| Windows 上 SIGINT 行为差异 | 中 | execa cancelSignal 在 Windows 下走 taskkill；测试用注入 AbortController，不依赖真实 SIGINT |
| Backend 调用顺序事件被中间状态写穿 | 高 | 所有事件写入 + state 写入串行，runAll 内部不引入 Promise.all |
| stdout/stderr 文件巨大撑爆 artifact 摘要 | 低 | artifact summary 只存首/尾各 200 字节摘要 + 字节数；正文留文件 |
| `--resume` 暴露 skill-lock drift 风险 | 中 | 默认拒绝；显式 `--allow-skill-drift` 才允许，且记 warning |
| event 类型新增破坏外部消费者 | 低 | 外部消费者目前不存在；mvp-contracts 标注 "additive only" |
| **范围扩张超出"硬化"原始定位** | 高 | 显式重命名为 "Adapter Hardening + Agent-Driven Flow Control"；提供 §6.1 拆分指引；roadmap 同步更新 |
| **Agent 通过 patch 绕过 state 写者约束** | 高 | applyContextPatch 显式拒绝任何对 state 状态机字段的写入；批次原子；每条 patch 走事件；保留字段集合在代码中硬编码并有单测覆盖 |
| **goto_step 形成无限循环** | 高 | 每 step 强制 `max_visits`（默认 3）；超出后 step+job 进入 blocked；不允许通过 patch 重置 step_visits 计数 |
| **变量类型 schema 在 Agent 输出中漂移** | 中 | applyContextPatch 对每条 variable_set 做类型 + enum 校验；类型不匹配 → ValidationError，批次回滚 |
| **context_block 历史版本无限增长** | 中 | v0.2 文档建议手动清理；v0.3 引入保留策略；本阶段不自动 GC |
| **`if:` 表达式被滥用成通用 DSL** | 中 | parser 白名单：仅 `==`/`!=`/`&&`/`||`/`!` + 受限插值；其他符号 → ValidationError；专门测试覆盖 |
| **PRD 修订与代码不一致** | 中 | PRD/contracts 修订必须**与代码同 PR**；§13 列出全部修订点；reviewer 必须同时审阅 docs diff |
| **patch 与 signals 同 step 并发** | 中 | 流水线（AD-P13-013）明确顺序：patch → status → signals → advance；同 PR 测试覆盖混合 report |

## 11. 技术债登记

### 11.1 本阶段一并清偿

| 技术债 ID | 来源 | 在哪个 WF 清偿 |
|---|---|---|
| TD-P9-001 | `${{ jobs.<id>.outputs.<key> }}` 表达式 | WF-P13-VARIABLES（表达式扩张同次完成） |
| TD-P9-002 | `${{ steps.<id>.outputs.<key> }}` 表达式 | WF-P13-VARIABLES |

> P15 原计划在 WF-P15-EXPR 清偿 TD-P9-002；本阶段提前到 P13 因为 router goto_step 与 `if:` 求值依赖该能力。P15 plan 在 v0.2 roadmap 同步合入时已记录该变更（见 v0.2-roadmap §3 与 P15 §6）。

### 11.2 带到 v0.3 的新技术债

| 技术债 ID | 描述 | 计划清偿 |
|---|---|---|
| TD-P13-001 | run-all 日志渲染仍是 console.log，未走 chalk/ora | P15 顺手清理 |
| TD-P13-002 | recordAgentFailure 不区分 timeout 与 exit code 失败的重试策略 | v0.3 引入 backend-aware policy |
| TD-P13-003 | skill-lock drift 仅日志、不入事件 | v0.3 完整 event sourcing 阶段 |
| TD-P13-004 | context_block 历史版本无自动 GC | v0.3 retention policy |
| TD-P13-005 | variable schema 只校验顶层 type/enum，不递归 | v0.3 引入完整 JSON Schema |
| TD-P13-006 | step.if 表达式仅支持等值/逻辑组合，不支持算术 | v0.3 视实际需求决定是否扩 |
| TD-P13-007 | goto_step 不支持事务（goto 到一半失败如何回滚） | v0.3 引入 step transaction |

## 12. PR 结构

- **PR #90（feature/p13-agent-adapter-hardening-and-flow）**
  - branch from origin/main
  - 包含全部 8 个 WF：ENGINE-RUNALL / EVENTS-ARTIFACTS / RETRY / RESUME-CANCEL / BACKEND-CONFIG / RETURNS / VARIABLES / FLOW
  - PR 描述需附：
    - 新增事件列表（adapter 5 条 + 控制流 ~10 条）
    - 新增 artifact 列表（agent_stdout/stderr/invocation + context_block）
    - `--resume` 用法
    - **新增 schema 字段清单**（returns、on_return、variables、context_blocks、permissions.variables、permissions.context_edit、step.if、step.max_visits、RouterAction.goto_step）
    - **PRD / mvp-contracts 修订点（§13）**
    - 迁移说明：v0.1 workflows 全部向前兼容；新字段全部 optional，默认行为不变
  - 关联 GitHub Project 条目 P13。

如 §6.1 拆分为 #90a / #90b，则在两 PR 描述间相互引用，并要求两 PR 顺序合并、不分开发布。

## 13. PRD 与 MVP Contracts 同步修订（必须与代码同 PR）

扩展范围与 PRD/contract 既有非目标存在直接冲突，必须在 P13 PR 中**同时修订文档**，否则代码与规范不一致。下表列出所有修订点；reviewer 必须同时审阅 docs diff：

| 文件 | 位置 | 现状 | 修订方向 |
|---|---|---|---|
| `docs/prd.md` | §3 核心抽象 - Signal 段 (~L95) | "Agent 可以请求 signal，但不能直接修改 workflow 状态" | 增补一句"workflow 状态机字段（job/step status、attempts、signals 注册表）仅 Engine 写；workflow 变量与上下文块由 Agent 通过 context_patches 修改，Engine 校验后落盘。" |
| `docs/prd.md` | §5 非目标范围 (~L125) | "Agent 直接修改 workflow 状态" 被列为非目标 | 改写为"Agent 直接修改 state.json 的状态机字段（jobs / signals / attempts）"，明确仅状态机部分受约束 |
| `docs/prd.md` | §5 非目标范围 (~L127) | "任意循环、任意表达式、运行时 YAML patch" | 保留；新增脚注：v0.2 引入 goto_step + 每 step max_visits 作为受控有界循环，不属于任意循环 |
| `docs/prd.md` | §6 FR-009 Router 控制流 (~L688-708) | 列出 `continue`/`fail`/`block`/`retry_job`/`activate_job`/`goto_job` | 增加 `goto_step` 与示例；标注"同 job 内跳转" |
| `docs/prd.md` | §6 FR-010 Signal 机制 (~L739) | Agent 只能输出 signals 控制流程 | 增补一段说明 status / context_patches 的位置：status 是 step-local 决策、signals 是 workflow-wide 升级、patches 是变量/上下文块修改；三者并行存在并按流水线顺序处理 |
| `docs/prd.md` | §6 FR-014 Workspace 与权限 (~L944-980) | permissions 字段仅含 contents/edits/commands/workflow_state | 增加 `variables` / `context_edit` / `context_blocks` 子字段说明 |
| `docs/prd.md` | §6 FR-006 Context Builder (~L506) | 列出 Context Builder 注入项 | 增补 variables / context_blocks 注入 |
| `docs/prd.md` | §6 新增 FR-016 / FR-017 / FR-018（可选） | — | 给三项新能力各起一节：FR-016 Step Status Return、FR-017 Workflow Variables and Context Blocks、FR-018 Conditional Steps and goto_step |
| `docs/prd.md` | §11 Skill Pack manifest 规范 | — | 不动；Skill Pack 仍不参与 workflow 状态转移 |
| `docs/prd.md` | §13 类型系统与表达式 (~L1486-1530) | 列出表达式上下文 | 增补 `${{ variables.<name> }}`、`${{ steps.<id>.outputs.<key> }}`、`${{ jobs.<id>.outputs.<key> }}`；说明等值/逻辑组合 |
| `docs/prd.md` | §22 MVP 成功标准 (~L2311) | "Agent 不能直接修改 workflow 状态" 列入成功标准 | 维持核心精神不变；调整为"Agent 通过 Engine 提供的入口（report outputs、signals、status、context_patches）影响流程，不直接写 state.json" |
| `docs/prd.md` | §23 主要风险与应对 - 风险三 (~L2343) | "Agent 通过 signal 过度影响流程" | 增补"通过 status/patch 也可能过度影响流程，靠 schema 白名单 + 权限模型约束" |
| `docs/mvp-contracts.md` | §2.1 Workflow Contract | 列出 step type 与 router action | 增补 `goto_step` action；增补 `step.if` / `step.max_visits` / `step.returns` / `step.on_return` 字段；增补 workflow 顶层 `variables` / `context_blocks` 段 |
| `docs/mvp-contracts.md` | §2.3 Run State Contract | 列出 state 字段 | 增补 `variables` 和 `context_blocks` 段；明确这两段允许通过 `applyContextPatch` 修改，**其余字段仍只能由 Engine 内部入口写入** |
| `docs/mvp-contracts.md` | §2.4 Event Contract | 列出关键事件类型 | 增补本阶段所有新事件（见 §3.1） |
| `docs/mvp-contracts.md` | §2.6 Agent Report Contract | 列出 outputs/artifacts/signals/summary | 增补 `status?: string` 与 `context_patches?: Patch[]` 字段；明确处理流水线顺序 |
| `docs/mvp-contracts.md` | §3 MVP Out-of-Scope | 列出 v0.3+ 项 | 移除 "Agent 直接修改 workflow 状态"（改为 "Agent 直接修改 state.json 的状态机字段"）；保留 "任意循环、任意表达式、运行时 YAML patch" 并加脚注 |
| `docs/architecture.md` | §5.2 模块边界 | engine/context/run 模块边界 | 增补 `applyContextPatch`、`applyStatusReturn`、`evaluateStepCondition` 三个 engine 入口 |
| `docs/architecture.md` | §6.2 Aggregates and invariants | Run / JobRun / StepRun 不变量 | 增补 Variables / ContextBlock 聚合的不变量（命名空间隔离、写者校验、版本单调） |
| `docs/architecture.md` | §7.1 Engine command model | 列出 Engine 入口 | 追加 `applyContextPatch`、`applyStatusReturn`、`evaluateStepCondition` |
| `docs/architecture.md` | §7.2 状态转换规则 | Step status 转换图 | 增补 `pending → skipped`（via if=false）、`running → blocked`（via max_visits 超限）|

修订原则：

- **加法优先**：尽量在既有段落后追加新条款，而不是改写既有定义；保留旧文本利于阅读历史决策。
- **保留口径**：PRD §5 "Agent 不能直接修改 workflow 状态" 的核心精神（Engine 唯一写者）保留；明确"状态机字段"与"工作流数据字段"的界线。
- **示例先行**：每一处修订都尽量带 YAML/JSON 示例，避免抽象描述。

文档修订**必须**与代码同 PR；如发生分歧（如 reviewer 要求改设计），代码改完后必须回头同步文档，禁止"文档下个 PR 跟上"。
