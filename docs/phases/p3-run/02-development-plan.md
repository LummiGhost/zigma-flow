# P3 Run Creation & DAG Validation — Development Plan

日期：2026-06-07
状态：frozen
阶段：P3 — DAG 解析、Run 创建与状态查询

---

## 1. 开发目标

**Business objective：** 用户可以通过 `zigma-flow run <workflow> --task <desc>` 在本地项目中创建一次 workflow 运行实例，查看初始 job 状态，然后通过 `zigma-flow status` 跟踪运行状态。`validate` 命令同步覆盖 DAG 校验。

**Technical objective：**

1. 实现 `dag/` 纯函数模块，清偿 TD-P2-001（DAG 循环检测 + needs 引用校验）。
2. 建立 run 创建基础设施：StateStore、EventWriter、Clock、IdGenerator 端口与本地适配器。
3. 实现 `engine.createRun` 作为唯一 Engine 入口（P3 范围），确保 Engine 是状态推进的唯一权威，CLI 不得绕过。
4. 实现 `status` 命令，读取 state.json 并渲染运行状态。

---

## 2. 技术路线

| 决策 | 选择 | 理由 |
|---|---|---|
| DAG 循环检测算法 | DFS + 颜色标记（白/grey/black） | O(V+E)，适合 MVP DAG 规模；纯函数，易测试 |
| run_id 格式 | `YYYYMMDD-NNNN`（日期 + 当天序号，4 位补零） | 与 PRD 示例一致；单进程单用户 MVP 无并发冲突 |
| state.json 原子写入 | `writeFile(tmp)` → `rename(tmp, target)` | POSIX 原子替换；Windows 需 try/catch fallback（F-04） |
| events.jsonl | Node.js `appendFile`，每行一个 JSON object | append-only，无需锁，符合 architecture §7.3 |
| IdGenerator 实现 | 按日期目录计数（扫描 runs/ 下当天 run 目录数量 +1） | 确定性，无随机依赖，易测试 |
| Engine 接口 | `engine/ports.ts` 中定义 `EnginePort`，`engine/index.ts` 实现 | CLI 只依赖接口；未来 P4+ 可替换实现 |

---

## 3. 里程碑

| ID | 描述 | 验收标准 |
|---|---|---|
| M-P3-1 | DAG 模块可用 | `validateNeedsReferences` 和 `detectCycles` 有测试；正确处理合法 DAG、引用缺失、简单环、多节点环 |
| M-P3-2 | `validate` 包含 DAG 校验 | TD-P2-001 关闭（Issue #7）；`validate` 对 needs 引用错误或循环 DAG 返回字段级错误 |
| M-P3-3 | Run 创建可用 | 用户可通过 `zigma-flow run code-change --task "..."` 创建 run 目录，生成 state.json / run.yml / events.jsonl / skill-lock.snapshot.json |
| M-P3-4 | Status 可用 | 用户可通过 `zigma-flow status` 查看 run 状态、所有 job 状态（含 activation/attempt）、ready jobs 和 next step 建议 |

---

## 4. 工作流拆分

### WF-P3-DAG — DAG 模块 + validate 集成

**业务目标：** 将 `validate` 升级为完整 workflow 合法性校验（含 DAG 约束），清偿 TD-P2-001。

**边界与依赖：**
- 只依赖 P2 的 `WorkflowDefinition` 类型（来自 `src/workflow/index.ts`）。
- 不访问文件系统，不依赖 engine、run、events 模块。
- WF-P3-RUN 依赖本工作流完成（engine.createRun 需要 `computeReadyJobs`）。

**功能点：**
- `FP-DAG-NR`: `validateNeedsReferences(jobs)` — 校验所有 `needs`/`optional_needs` 引用的 job id 存在
- `FP-DAG-CYCLE`: `detectCycles(jobs)` — DFS 颜色标记检测循环依赖，返回循环路径
- `FP-DAG-READY`: `computeReadyJobs(jobs, completedJobIds, activeJobIds)` — 计算当前 ready jobs
- `FP-DAG-INT`: 将 `validateNeedsReferences` 和 `detectCycles` 集成到 `loadWorkflow`（`src/workflow/index.ts`）

**规范强制条款（RC-07、RC-08 from P2 plan）：**

| # | 来源 | 条款 | 状态 |
|---|---|---|---|
| RC-07 | PRD FR-002 | 校验 needs/optional_needs 引用存在 job | 本工作流实现 |
| RC-08 | PRD FR-002 | 校验 DAG 不存在循环依赖 | 本工作流实现 |

**独立验收标准：**
- `typecheck` clean
- `pnpm test` — dag 测试全部通过
- `zigma-flow validate` 对含 needs 引用错误的 workflow 返回非零 + 字段级错误
- `zigma-flow validate` 对含循环依赖的 workflow 返回非零 + 循环路径信息
- Issue #7 可关闭

**预研：** 无。DFS 循环检测算法已知，无需预研。

**状态：** `planned`

---

### WF-P3-RUN — Run 创建基础设施

**业务目标：** 用户可以运行 `zigma-flow run <workflow> --task <desc>` 成功创建一次 workflow 运行实例。

**边界与依赖：**
- 依赖 WF-P3-DAG（`computeReadyJobs` 用于计算初始 ready jobs）。
- 引入新模块：`run/`、`events/`、`engine/`（createRun only）。
- 引入基础设施端口：`Clock`、`IdGenerator`、`StateStore`、`EventWriter`（定义在 `engine/ports.ts` 或对应模块）。
- CLI 只依赖 Engine 接口，不直接调用 run/ 或 events/ 内部函数。

**功能点：**

- `FP-INFRA-CLOCK`: `Clock` port + `SystemClock` adapter（返回 ISO 8601 时间戳）
- `FP-INFRA-IDGEN`: `IdGenerator` port + `LocalRunIdGenerator` adapter（`YYYYMMDD-NNNN` 格式）
- `FP-STORE-STATE`: `StateStore` port + `LocalStateStore` adapter（readSnapshot, writeSnapshot 原子替换, validateLastEventId）
- `FP-STORE-EVENT`: `EventWriter` port + `JsonlEventWriter` adapter（appendEvent, readLastEventId）
- `FP-RUN-DIR`: `createRunDirectory(runId, runsDir)` — 创建 run 目录结构
- `FP-RUN-YAML`: `writeRunYaml(runDir, meta)` — 写入 run.yml（task, workflow name/path, created_at, skill_lock_snapshot）
- `FP-RUN-LOCK`: `snapshotSkillLock(runDir, skillLockPath)` — 复制 skill-lock.json 到 run 目录作快照
- `FP-ENGINE-CREATE`: `engine.createRun(inputs)` — 完整 run 初始化，返回 run_id
- `FP-CLI-RUN`: `commands/run.ts` — 解析 workflow 参数和 --task 参数，调用 engine.createRun，输出 run_id 和 next step 建议

**P3 run 命令的明确范围边界：**

`zigma-flow run <workflow> --task <desc>` 仅创建 run 实例，不执行任何 step。Step 执行属于 P4+。

**规范强制条款（FR-004 + Contracts §2.3 §2.4）：**

| # | 来源 | 条款 | 状态 |
|---|---|---|---|
| RC-R01 | PRD FR-004 | 生成唯一 run_id | 本工作流实现 (FP-INFRA-IDGEN) |
| RC-R02 | PRD FR-004 | 创建 run 目录 | 本工作流实现 (FP-RUN-DIR) |
| RC-R03 | PRD FR-004 | 写入 run.yml（task、workflow、创建时间、skill lock 快照） | 本工作流实现 (FP-RUN-YAML, FP-RUN-LOCK) |
| RC-R04 | PRD FR-004 | 初始化所有 required jobs 状态（pending/waiting/ready） | 本工作流实现 (FP-ENGINE-CREATE) |
| RC-R05 | PRD FR-004 | 将无依赖 required job 标记为 ready | 本工作流实现（使用 dag.computeReadyJobs） |
| RC-R06 | PRD FR-004 | 将 optional job 标记为 inactive | 本工作流实现 (FP-ENGINE-CREATE) |
| RC-R07 | Contracts §2.3 | state.json 只能由 Engine 通过 StateStore 写入 | 本工作流实现（CLI 不直接写 state） |
| RC-R08 | Contracts §2.3 | `state.last_event_id` 与 event log 尾部一致 | 本工作流实现（写入顺序：append event → 写 state） |
| RC-R09 | Contracts §2.4 | `run_created` 事件写入 events.jsonl | 本工作流实现 (FP-STORE-EVENT + FP-ENGINE-CREATE) |
| RC-R10 | Contracts §2.4 | `job_ready` 事件写入 events.jsonl（每个初始 ready job） | 本工作流实现 |
| RC-R11 | Architecture §7.3 | 写入流程为：计算 transition → append event → 原子替换 state.json | 本工作流实现 |
| RC-R12 | Architecture §8.1 | skill-lock.snapshot.json 放入 run 目录 | 本工作流实现 (FP-RUN-LOCK) |

**独立验收标准：**
- `typecheck` clean
- `pnpm test` — run/createRun 和 events 测试全部通过
- 用户可运行 `zigma-flow run .zigma-flow/workflows/code-change.yml --task "test task"` 成功创建 run 目录
- `state.json` 包含正确 job 状态（ready/waiting/inactive）
- `events.jsonl` 包含 run_created 和 job_ready 事件
- state.last_event_id 与 events.jsonl 最后一行 event id 一致
- skill-lock.snapshot.json 存在于 run 目录

**预研：** 无。端口/适配器模式已在 architecture.md 中定义，无需预研。

**状态：** `planned`

---

### WF-P3-STATUS — Status 命令

**业务目标：** 用户可以运行 `zigma-flow status` 查看当前运行的状态和下一步操作建议。

**边界与依赖：**
- 依赖 WF-P3-RUN（state.json 存在，StateStore 可用）。
- 只读操作，不修改任何 state。

**功能点：**

- `FP-STATUS-FIND`: 查找 active run（默认最近一次运行，或通过 --run <run_id> 参数指定）
- `FP-STATUS-READ`: 读取 state.json（通过 StateStore）
- `FP-STATUS-RENDER`: 渲染 run 状态、所有 job 状态（activation、attempt、current_step）、ready jobs、waiting jobs 的阻塞依赖、下一步操作建议
- `FP-STATUS-ERR`: state.json 损坏或 last_event_id 不一致时报错并停止（不自动修复）

**规范强制条款（FR-005 + Contracts §2.3）：**

| # | 来源 | 条款 | 状态 |
|---|---|---|---|
| RC-S01 | PRD FR-005 | 显示 run status | 本工作流实现 |
| RC-S02 | PRD FR-005 | 显示所有 job status、activation、attempt、current_step | 本工作流实现 |
| RC-S03 | PRD FR-005 | 显示 ready jobs | 本工作流实现 |
| RC-S04 | PRD FR-005 | 显示 waiting jobs 的阻塞依赖 | 本工作流实现 |
| RC-S05 | PRD FR-005 | 显示下一步操作建议 | 本工作流实现 |
| RC-S06 | Contracts §2.3 | state.json 损坏或 event/state 不一致时 CLI 不推进 run | 本工作流实现 (FP-STATUS-ERR) |

**独立验收标准：**
- `typecheck` clean
- `pnpm test` — status 命令测试全部通过
- 用户可运行 `zigma-flow status` 看到 run 状态和 job 状态
- state.json 损坏时 `status` 命令报错（不崩溃，不推进）

**预研：** 无。

**状态：** `planned`

---

## 5. 工作流依赖关系

```text
WF-P3-DAG  →  WF-P3-RUN  →  WF-P3-STATUS
```

必须按顺序执行：
1. WF-P3-DAG 完成后，`computeReadyJobs` 可用，才能实现 engine.createRun
2. WF-P3-RUN 完成后，state.json 结构和 StateStore 可用，才能实现 status 命令

---

## 6. 质量要求

- `typecheck`（`tsc --noEmit`）无报错
- `test`（`vitest run`）全部通过
- 模块依赖方向遵守 architecture §5.2 和 mvp-contracts §5：
  - `dag/` 不访问文件系统，不 import `cli`、`commands`、`engine`、`run`、`events`
  - `engine/` 不 import `commander`、`chalk`、`execa`、`simple-git` 或具体 fs helper
  - `run/` 和 `events/` 不绕过 engine 写状态
  - CLI (`commands/`) 只通过 Engine port 接口操作，不直接调用 run/ 或 events/ 内部函数
- 错误路径：文件不存在、state 损坏、路径越界均有测试覆盖

---

## 7. 技术债登记

| ID | 描述 | 引用规范 | 推迟原因 | 清偿期限 |
|---|---|---|---|---|
| TD-P3-001 | `StateStore` 只实现本地文件系统适配器 | Architecture §5.1（Infrastructure Adapters），MVP Contracts §6 | MVP 只需本地 CLI；远程/分布式存储不在 MVP scope | P4 如需远程 state 时清偿 |
| TD-P3-002 | `EventWriter` 只实现 JSONL append；不实现完整 event sourcing 重建 | PRD FR-015，Architecture §7.3 | PRD 明确"MVP 不做完整 event sourcing 重建" | 完整 event sourcing 重建是 non-MVP out-of-scope |
| TD-P3-003 | `IdGenerator` 使用 runs 目录计数，不保证并发安全 | MVP 单进程单用户约束 | MVP 同一时刻只允许单用户本地操作，无并发 run 创建 | 如果 MVP 扩展为多用户/并发时清偿 |
| TD-P3-004 | `engine/` 只实现 createRun；其余 Engine 命令（prepareAgentStep, acceptAgentReport, executeCurrentStep, advanceJob 等）延迟到 P4+ | Architecture §7.1 Engine command model | P3 只需 run 创建；step 执行在 P4+ | P4 实现 step 执行时清偿 |

---

## 8. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| Windows `rename` 原子替换可能抛 EPERM（F-04） | state.json 写入失败 | Step 2 使用 try/catch，若 rename 失败则 unlink+rename；测试 Windows 路径 |
| `dag/` 纯函数约束被实现者误解（误引入 fs 依赖） | 架构违规 | Step 1 用例文档和 Step 2 委派说明均明确"不访问文件系统" |
| `engine/` 实现者直接调用 run/ 内部函数绕过 StateStore 接口 | 架构违规 | Step 1 明确接口，Step 3 合规审阅检查模块边界 |
| skill-lock.json 不存在时 snapshotSkillLock 失败 | run 创建失败 | 文件不存在时抛 FilesystemError；测试覆盖此路径 |

---

## 9. 当前工作流状态

| 工作流 | 状态 | 下一动作 |
|---|---|---|
| WF-P3-DAG | `planned` | 等待 fix/p2-cleanup 合并后，派发 Step 1 subagent（opus） |
| WF-P3-RUN | `planned` | 等待 WF-P3-DAG 完成后启动 |
| WF-P3-STATUS | `planned` | 等待 WF-P3-RUN 完成后启动 |
