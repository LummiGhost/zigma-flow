---
phase: p14
title: Concurrent Read-Only Job Execution
status: proposed
date: 2026-06-27
authority: docs/prd.md §4 §14 §24, docs/mvp-contracts.md §2.3 §2.4 §5, docs/architecture.md §6.2 §7
predecessor: P13 (PR #90) merged
target-pr: 1
---

# P14 Concurrent Read-Only Execution 开发计划

## 1. 阶段目标

让 `workspace.mode: read-only` 的 ready jobs 在 `run-all` 中并行执行，保持 Engine 是唯一状态推进者、State Store 是单写者、Event Log 仍是单调追加。

**目标度量：** 在内置 code-change workflow 上，`code-map`、`risk-scan`（read-only）与 `architecture-design`（如激活）能并行；wall-clock 实测下降 ≥ 30%（基线为 P13 完成后的顺序执行）。

**不目标：** writable job 并行（需要 git worktree 隔离，PRD §24 第 6 项，留给 v0.3）。

## 2. 前置条件

- P13 已合入 main，runAll 已搬到 engine、事件契约扩张到位。
- `src/dag/index.ts` 已具备 `computeReadyJobs(jobs, completed, active)`，返回数组。
- `src/run/index.ts` 已具备 `LocalStateStore.writeSnapshot`（当前**没有显式 mutex**，依赖单进程串行调用）。

## 3. 范围与边界

### 3.1 In-scope

| 主题 | 内容 |
|---|---|
| 并发调度器 | 新增 `src/engine/scheduler.ts`，提供 `selectExecutable(state, wf, options): ExecutableBatch` |
| 写者锁 | 同一时刻只允许 1 个 `workspace.mode: writable` job running |
| 状态写串行 | `LocalStateStore.writeSnapshot` 加进程内 mutex（`p-limit(1)` 或自实现 AsyncQueue），事件追加同理 |
| runAll 并发循环 | 改写 runAll 主循环为"每轮选一个可执行批次 → Promise.allSettled → 收尾"模式 |
| CLI 配置 | `--parallelism N`（默认 4）；`agent.parallelism` 也可写在 `.zigma-flow/config.json` |
| 取消传播 | 一个 job 失败后，是否取消同批次其他 job 由 `--fail-fast`（默认 false）控制 |
| 事件顺序契约 | 同一批次的 `step_started`/`step_completed` 仍按完成时间串行写入，事件 ID 单调；payload 中加 `batch_id`（可选）便于回放 |
| 文档 | architecture.md §7 增 "Concurrency model" 节 |

### 3.2 Out-of-scope

- writable job 并行 / git worktree —— v0.3。
- 自动多 Agent 并发（同一 step 多 backend 投票）—— 不在 PRD MVP。
- 集群 / 分布式执行 —— 永久 out-of-scope。
- 真正抢占式取消（一个 job stuck 时强杀其他 job）—— v0.3 stretch。
- 并发执行 script step 与 agent step 混排时的 IO 资源限流（节流策略） —— v0.3 待数据驱动。

## 4. 架构决策

### AD-P14-001 — Scheduler 与 Engine 解耦

**决策：** 新建 `src/engine/scheduler.ts`，纯函数：

```ts
export interface SchedulerInput {
  state: RunState;
  workflow: WorkflowDefinition;
  config: { parallelism: number; runningWritableLimit: 1 };
}

export interface ExecutableBatch {
  jobs: Array<{ jobId: string; mode: "read-only" | "writable" }>;
  rationale: string; // for event payload / debugging
}

export function selectExecutable(input: SchedulerInput): ExecutableBatch;
```

规则：

1. 收集所有 `status: ready` 的 job。
2. 计算 `running` 中是否已有 writable job。若有 → 本批次仅允许 read-only；写者排队。
3. 取 ready 中 read-only 部分，截到 `parallelism - 已运行 read-only 数`。
4. 若 read-only 不足 parallelism 且无 writable 在跑，可补 1 个 writable。
5. 返回 batch。`rationale` 是人类可读字符串，写入 `batch_selected` 事件 payload（可选）。

**理由：** Scheduler 纯函数，无 IO，便于单测覆盖各种竞争场景（4 read-only + 1 writable + parallelism=2 等）。

### AD-P14-002 — 写者锁语义

**决策：** writable 锁是 run state 层面的并发限制，不引入文件锁。判定路径：

- 启动一个 job 之前，scheduler 已根据 state 中 `running` writable 数量决定是否给出 writable job。
- runAll 在调用 `executeCurrentStep` 之前再做一次 race 检查（读最新 state）—— 双重保险，避免 state.json 在多进程下被外部修改时的竞态（虽然 MVP 仍只允许单进程跑）。
- 不实现 OS 文件锁；外部进程并发跑同一 run 不在 v0.2 范围。

**理由：** PRD §FR-014 明确 "MVP 同一时刻最多一个 writable job running"。Scheduler 实现该规则即可。

### AD-P14-003 — State 写串行通过 Mutex

**决策：** `LocalStateStore` 内部维护一个 per-runDir 的 AsyncQueue（实现见 `src/run/asyncQueue.ts` 新增）。所有 `writeSnapshot` 调用排队执行。

EventWriter 同理：`JsonlEventWriter.appendEvent` 也走 per-runDir 队列。

**理由：** 即使 v0.2 不做跨进程并发，Promise.all 多 job 并发时仍会触发同进程 reentrancy；最稳的实现是在写者层串行，业务代码无须感知。

**实现要点：**

- AsyncQueue 接受 `() => Promise<T>`，按 FIFO 串行 await。
- 每个 runDir 一把锁，存于 module-level WeakMap 或 Map<string, AsyncQueue>。
- 不是 OS 锁；进程退出锁随之消失。

### AD-P14-004 — runAll 并发主循环

**决策：** runAll 主循环改造为：

```ts
while (!terminal(state) && iterations++ < MAX) {
  const batch = selectExecutable({ state, workflow: wf, config });
  if (batch.jobs.length === 0) {
    // 推进点：可能等待 retry 冷却 / 多步 job 中间态
    if (allWaitingOrInactive(state)) break;
    // sleep 短 backoff（仅在没有任何可执行项时）
    continue;
  }

  const results = await Promise.allSettled(
    batch.jobs.map(j => executeJobOnce({ ...ctx, jobId: j.jobId }))
  );

  for (const r of results) {
    // 失败传播 / fail-fast 决策
  }

  state = await stateStore.readSnapshot(runDir);
}
```

`executeJobOnce` 推进单个 job 的当前 step（agent backend、script、check、router）并返回结果；不调用 scheduler、不写循环控制状态。

**理由：** Promise.allSettled 而非 Promise.all：单个 job 失败不影响同批次其他 job 继续走完自己的 step；失败累积到批次完成后统一裁决。

### AD-P14-005 — fail-fast 策略

**决策：** `--fail-fast` 默认 false。

- false：同批次失败的 job 各自走 `recordAgentFailure` / `step_failed` 路径；其他 job 完成自身后批次结束。下一轮 scheduler 重新计算。
- true：同批次出现失败时，立即向同批次其他 job 传播 AbortSignal（每个 job 持有独立的 AbortController）。被中断的 job 视为 `cancelled`（不是 failed），保留 partial artifact，事件写 `agent_cancelled` + reason="fail_fast"。

**理由：** dogfood 时往往希望尽可能多收集失败证据再回头改提示词，因此默认 false；CI 场景偏好 fail-fast。

### AD-P14-006 — 并发场景的事件 ID 与顺序

**决策：**

- `nextSequentialEventId`（P13 引入）保证串行单调。
- 同批次 job 写事件时各自 await 事件队列，因此事件 ID 仍是全局单调。
- 事件 payload 增加可选 `batch_id`（uuid string）；同批次所有事件共享同一 batch_id，方便回放工具按批次分组。
- 不引入"事件并发"或乱序补偿机制。

**理由：** 顺序串行成本最低；事件量级远小于 IO 瓶颈。

### AD-P14-007 — 默认 parallelism

**决策：**

- CLI `--parallelism N`（≥1）。
- 未指定时：读 `.zigma-flow/config.json` 的 `agent.parallelism`。
- 仍未指定时：默认 4。
- 实际 batch size = min(parallelism, ready 队列长度)。
- 上限不做强制，但建议文档中标注 Claude CLI 速率限制风险。

**理由：** 4 是 dogfood workflow 中 read-only ready jobs 的典型上限（intake 完成后 code-map + risk-scan 并行；激活 architecture-design 后再加一个）。

### AD-P14-008 — 配置层与 step 级 override 暂不做

**决策：** P14 不引入 job 级或 step 级的并发开关；并发由 scheduler 全局决定。若某个 read-only job 实测不能并行（如本地 git lock），用户应改 step 为 writable 或自行串行；P14 不增 step 级旋钮。

**理由：** 避免引入新的 workflow schema 字段；保持 PRD §FR-014 既定边界（job 级 workspace mode 决定并发资格）。

## 5. 工作流拆分

### WF-P14-SCHEDULER

**目标：** AD-P14-001、AD-P14-002 — Scheduler 纯函数 + 写者锁规则。

**边界：** 新增 `src/engine/scheduler.ts`、`tests/engine/scheduler.test.ts`。不改 runAll。

**验收：**

- 单测覆盖：仅 read-only ready；read-only + writable 混合，writable 已在跑；ready 为空；parallelism=1；parallelism=8 而 ready=2。
- Scheduler 不调用文件系统、不读 state.json，输入是已经反序列化的 RunState + WorkflowDefinition。

### WF-P14-LOCKS

**目标：** AD-P14-003 — StateStore + EventWriter 加 AsyncQueue。

**边界：** 新增 `src/run/asyncQueue.ts`；改 `LocalStateStore.writeSnapshot`、`JsonlEventWriter.appendEvent` 各包一层 queue.run。

**验收：**

- 单测：并发 5 次写入同一 runDir，输出文件最后是最后一次写入的内容；中间没有部分写出错（用 fake fs 验证 rename 顺序）。
- 单测：并发 append 100 个 event，文件按 await 顺序追加，无丢失。
- 既有 ~464 测试零回归。

### WF-P14-RUN-ALL-CONCURRENT

**目标：** AD-P14-004、AD-P14-005、AD-P14-006 — runAll 接入 scheduler，并发主循环 + fail-fast。

**边界：** 改 `src/engine/runAll.ts`；改 `src/commands/run-all.ts` 增 `--parallelism` / `--fail-fast` 参数；新增 `tests/engine/runAll-concurrent.test.ts`。

**验收：**

- 集成测：workflow 含 3 个 read-only ready jobs，每个 agent backend 用 fake 等待 50ms，总耗时 < 100ms（并发证据）。
- 集成测：1 个 writable + 2 个 read-only ready，writable 跑完前 read-only 也跑完。
- 集成测：fail-fast=true 时一个失败 → 同批次另一个收到 abort，事件含 `agent_cancelled` reason="fail_fast"。
- 集成测：fail-fast=false 时一个失败不影响同批次其他 job 推进。

### WF-P14-CONFIG-DOCS

**目标：** AD-P14-007 + 文档同步。

**边界：** `src/agent/config.ts`（P13 已建）增 `parallelism` 字段；架构与 README 增并发模型说明；mvp-contracts.md §5 模块依赖增"scheduler 不持有外部 IO"约束（如有偏离）。

**验收：**

- README 增 "并发执行" 段，包含 `--parallelism` 用例。
- architecture.md §7.4 新增 "Concurrency model" 子节。
- 配置示例：`.zigma-flow/config.json` agent 字段补 `"parallelism": 4`。

## 6. 工作流依赖与提交顺序

```
WF-P14-SCHEDULER (纯函数)
   └─ WF-P14-LOCKS (并发安全的写者)
       └─ WF-P14-RUN-ALL-CONCURRENT (主循环接入)
           └─ WF-P14-CONFIG-DOCS
```

合入 **PR #91（feature/p14-concurrent-execution）**。

## 7. 测试规划

| 文件 | 新增/扩展 | 主题 |
|---|---|---|
| `tests/engine/scheduler.test.ts` | 新增 | 调度规则、writable 互斥、parallelism 边界 |
| `tests/run/asyncQueue.test.ts` | 新增 | FIFO 保序、错误传播 |
| `tests/run/stateStore-concurrent.test.ts` | 新增 | 并发 writeSnapshot 不破坏文件 |
| `tests/events/eventWriter-concurrent.test.ts` | 新增 | 并发 appendEvent 顺序与完整性 |
| `tests/engine/runAll-concurrent.test.ts` | 新增 | 并发 happy path、fail-fast、writable 排队 |
| `tests/dogfood/run-all-parallel.test.ts` | 新增 | 用 fake backend stub 验证 code-map + risk-scan 并行 |

预计净增 ~30 测试用例。

## 8. 质量门禁

```pwsh
pnpm typecheck
pnpm lint
pnpm test:ci
```

并发测试可能在 CI 环境表现不同（Linux scheduler vs Windows）。所有并发测试必须使用 fake clock 或 deterministic 时间，不用 setTimeout 真实等待来断言"并发发生"。判定方式：

- 记录每次 backend.execute 的"进入时间"；断言两次"进入时间"差 < 5ms（注入 monotonic counter）。
- 避免 `await sleep(50)` 之类的 flakey 断言。

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| AsyncQueue 实现 bug 导致死锁 | 高 | 用 well-tested 实现：要么自写 + 90% 覆盖率 + 异常路径单测，要么引入 `p-queue` deps |
| Promise.allSettled 吞掉异常类型 | 中 | executeJobOnce 内部捕获并显式返回 Result 类型，不让 reject 漏给 allSettled |
| writable job 在 read-only 批次完成前未排进队列 | 低 | scheduler 每轮重新计算，runAll 不持久化 batch 决策 |
| 并发触发 backend rate limit（Claude CLI） | 中 | 文档建议 `parallelism ≤ 4`；P14 不实现自动节流，留 v0.3 |
| `state.json` 写顺序被外部 watcher（如 IDE）干扰 | 低 | 仍用 tmp + rename 原子写；watcher 看到的是最终态 |
| fail-fast 与 retry 互动 | 中 | 明确：fail-fast 触发的 cancelled 不进入 retry 计数；agent_failed 才进入 retry |

## 10. 性能预期

- 内置 code-change workflow 单 dogfood：
  - 基线（顺序）：intake 1m → code-map 3m + risk-scan 3m（串行）→ plan 2m → implement 5m → static-check 1m + unit-test 2m（串行）→ review 2m → summarize 1m ≈ 20m
  - P14 后：code-map + risk-scan 并行 → 3m；static-check + unit-test 并行 → 2m ≈ 16m
  - 节省 ~20%（保守，实际 dogfood backend 时长方差大）

dogfood 阶段对比测量：在 P14 PR 描述中附上 baseline run 和 P14 run 的两次 events.jsonl 时间戳对比表。

## 11. 技术债登记

| 技术债 ID | 描述 | 计划清偿 |
|---|---|---|
| TD-P14-001 | 无 backend 速率限制感知 | v0.3 引入 rate-limit aware backoff |
| TD-P14-002 | writable job 仍单点串行；多 worktree 缺位 | v0.3 git worktree 集成 |
| TD-P14-003 | scheduler 不感知 step 估算耗时 | v0.4 估算调度 stretch |

## 12. PR 结构

- **PR #91（feature/p14-concurrent-execution）**
  - branch from origin/main (要求 P13 已 merge)
  - PR 描述附：调度规则总结、性能对比表、`--parallelism` 默认值理由
  - 关联 GitHub Project P14 条目
