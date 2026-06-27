---
phase: p13
title: Agent Adapter Hardening
status: proposed
date: 2026-06-27
authority: docs/prd.md §FR-012 §FR-015 §13 §24, docs/mvp-contracts.md §2.3 §2.4 §2.5 §2.6
predecessor: PR #87 (run-all + Claude Code backend)
target-pr: 1
---

# P13 Agent Adapter Hardening 开发计划

## 1. 阶段目标

把 PR #87 引入的 Claude Code backend 和 `run-all` 命令打磨为可生产使用的自动执行路径。修复 v0.2 痛点诊断 D-1 / D-2 / D-3 / D-6 / D-7（详见 `docs/phases/v0.2-roadmap.md §2`）。

**核心命题：** Agent backend 是 Engine 的一个适配器，其生命周期事件必须可审计、失败必须遵循 workflow 声明的 retry 语义、产物必须落 artifact、取消必须保留干净的 run 状态。

## 2. 前置条件

- main 在 d579b42（v0.1.0 MVP RC + PR #87 + run-all 续跑修复）。
- v0.2 roadmap 已合入 main。
- 没有 open issue。
- `src/agent/` 已具备 `AgentBackend` 接口、`AgentBackendFactory`、`ClaudeCodeBackend`。
- `src/commands/run-all.ts` 已有主循环骨架（450+ 行单文件）。

## 3. 范围与边界

### 3.1 In-scope

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

### 3.2 Out-of-scope（保留给 P14/P15/v0.3）

- 并发执行（P14）。
- Human gate step（P15）。
- 多 backend 同时存在（factory 已支持注册，但 P13 只实测 Claude Code）。
- Codex、Gemini 或其他 backend 实现。
- backend 子进程沙箱（Docker、worktree）—— PRD §24 v0.3+ 项。
- 真正的 event sourcing 回放（仍只追加事件，不重建 state）。

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

## 6. 工作流依赖与提交顺序

```
WF-P13-ENGINE-RUNALL (refactor骨架, 不改外观)
   └─ WF-P13-EVENTS-ARTIFACTS (在新骨架上加事件+artifact)
       └─ WF-P13-RETRY (重接失败路径)
           ├─ WF-P13-RESUME-CANCEL
           └─ WF-P13-BACKEND-CONFIG
```

全部并入 **PR #88（feature/p13-agent-adapter-hardening）**。

不拆 PR 的理由：

- 事件/Artifact 契约变更若分多 PR，CI 中间状态会出现"主循环已搬走但事件没补全"的不可用版本。
- 重构和契约扩张同 PR 时，回归测试可以一次锁定新行为；分 PR 反而要写中间过渡测试。

如果 PR 体量过大（>2000 行），允许临阵拆为 PR #88a（ENGINE-RUNALL + EVENTS-ARTIFACTS + 事件端口）+ PR #88b（RETRY + RESUME-CANCEL + BACKEND-CONFIG）；保留单 PR 为首选。

## 7. 测试规划

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

预计净增 ~40 个测试用例。

## 8. 质量门禁

```pwsh
pnpm typecheck
pnpm lint
pnpm test:ci
```

每个 WF 完成后必须本地全绿，PR push 后必须等 `gh pr checks 88` 全绿才能 merge（CI Linux ≠ 本地 Windows，见 memory feedback）。

## 9. 文档同步

- `docs/architecture.md` §11（安全章节）追加 "Agent Backend Lifecycle" 节，说明 invoked/completed/failed 事件契约与子进程权限边界。
- `docs/mvp-contracts.md` §2.4 在事件类型列表追加 5 条 v0.2 新事件，并标注 "introduced in v0.2"。
- `README.md` 增 `run-all --resume` 段、`.zigma-flow/config.json` agent 字段示例。
- `CHANGELOG.md`（若未建则在本 PR 创建）记录 v0.2.0 中 P13 段。

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 拆分 run-all 触发既有 cli/run-all 集成测试连锁失败 | 中 | 重构在前，行为不变；先跑既有测试集再加新行为 |
| Windows 上 SIGINT 行为差异 | 中 | execa cancelSignal 在 Windows 下走 taskkill；测试用注入 AbortController，不依赖真实 SIGINT |
| Backend 调用顺序事件被中间状态写穿 | 高 | 所有事件写入 + state 写入串行，runAll 内部不引入 Promise.all |
| stdout/stderr 文件巨大撑爆 artifact 摘要 | 低 | artifact summary 只存首/尾各 200 字节摘要 + 字节数；正文留文件 |
| `--resume` 暴露 skill-lock drift 风险 | 中 | 默认拒绝；显式 `--allow-skill-drift` 才允许，且记 warning |
| event 类型新增破坏外部消费者 | 低 | 外部消费者目前不存在；mvp-contracts 标注 "additive only" |

## 11. 技术债登记（v0.2 内消化或带到 P14/P15）

| 技术债 ID | 描述 | 计划清偿 |
|---|---|---|
| TD-P13-001 | run-all 日志渲染仍是 console.log，未走 chalk/ora | P15 顺手清理 |
| TD-P13-002 | recordAgentFailure 不区分 timeout 与 exit code 失败的重试策略 | v0.3 引入 backend-aware policy |
| TD-P13-003 | skill-lock drift 仅日志、不入事件 | v0.3 完整 event sourcing 阶段 |

## 12. PR 结构

- **PR #88（feature/p13-agent-adapter-hardening）**
  - branch from origin/main
  - 包含 WF-P13-ENGINE-RUNALL → ... → WF-P13-BACKEND-CONFIG 全部内容
  - PR 描述需附：新增事件列表、新增 artifact 列表、`--resume` 用法、迁移说明（无 breaking change，但新 event 类型）
  - 关联 GitHub Project 条目 P13。
