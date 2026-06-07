# P3 Run Creation & DAG Validation — Readiness Review

日期：2026-06-07
审阅人：Phase Development Supervisor
阶段：P3 — DAG 解析、Run 创建与状态查询

---

## Inputs

**Source documents:**

| 材料 | 路径 | 状态 |
|---|---|---|
| PRD FR-004 创建 Run | `docs/prd.md §FR-004` | 完整 |
| PRD FR-005 状态管理 | `docs/prd.md §FR-005` | 完整 |
| PRD FR-015 事件日志 | `docs/prd.md §FR-015` | 完整 |
| Architecture §5.2 模块边界 (dag, engine, run, events) | `docs/architecture.md §5.2` | 完整 |
| Architecture §6.2 聚合与不变量 (Run, JobRun, StepRun) | `docs/architecture.md §6.2` | 完整 |
| Architecture §7 状态推进架构 | `docs/architecture.md §7` | 完整 |
| Architecture §8 数据所有权与持久化 | `docs/architecture.md §8` | 完整 |
| MVP Contracts §2.3 Run State Contract | `docs/mvp-contracts.md §2.3` | 完整 |
| MVP Contracts §2.4 Event Contract | `docs/mvp-contracts.md §2.4` | 完整 |
| MVP Contracts §5 模块依赖冻结 | `docs/mvp-contracts.md §5` | 完整 |
| MVP Contracts §6 核心端口清单 | `docs/mvp-contracts.md §6` | 完整 |
| MVP Contracts §7 错误分类冻结 | `docs/mvp-contracts.md §7` | 完整（含 P2 cleanup 补充 exit code 列） |
| P2 开发计划 TD-P2-001 | `docs/phases/p2-validate/02-development-plan.md` | 完整，P3.1 清偿 |

**已有代码约束（P1/P2 交付状态）：**

- `src/workflow/` — WorkflowDefinition schema + loader，schema 校验和语义检查已完整
- `src/skill-pack/` — SkillPack manifest loader + lock resolver 已完整
- `src/commands/validate.ts` — validate 命令（P2 cleanup 后：按 kind 字段分流）
- `src/utils/errors.ts` — ZigmaFlowError 错误体系完整（含 WorkflowError, ValidationError, SkillPackError）
- 其他模块目录已创建（`dag/`, `engine/`, `run/`, `events/`, `artifact/`, 等）但均为空

**P3 开始前置条件：**

- P2 cleanup PR（fix/p2-cleanup）已提交，修复 Issue #5（validate 按 kind 分流）、Issue #6（RouterAction status 枚举）、Issue #8（exit code 文档）。
- P3.1 WF-P3-DAG 开发必须在 fix/p2-cleanup 合并后启动，以确保在正确的 validate 基础上集成 DAG 校验。

---

## Stage Goal

**目标：** 实现最小运行时核心 — DAG 解析与校验、Run 目录创建、初始状态写入、事件写入，以及对应的 CLI 命令 `run` 和 `status`。

**里程碑：**

| ID | 描述 | 验收标准 |
|---|---|---|
| M-P3-1 | DAG 模块可用 | `needs`/`optional_needs` 引用校验通过，DAG 循环检测通过 |
| M-P3-2 | `validate` 命令包含 DAG 校验 | TD-P2-001 关闭；`validate` 报告 needs 引用错误和循环依赖错误 |
| M-P3-3 | Run 创建可用 | `zigma-flow run <workflow> --task <desc>` 创建 run 目录，写 state.json / run.yml / events.jsonl |
| M-P3-4 | Status 命令可用 | `zigma-flow status` 显示 run 状态、job 状态、ready jobs 和 next step 建议 |

**验收标准（总体）：**

- `typecheck`（`tsc --noEmit`）无报错
- `test`（`vitest run`）全部通过
- `zigma-flow run <workflow> --task <desc>` 创建完整 run 目录结构
- `zigma-flow status` 读取并渲染 state.json
- `zigma-flow validate` 对含 needs 引用错误或循环依赖的 workflow 正确报错

---

## Boundary

**P3 范围内：**

- P3.1 `dag/` 模块：`validateNeedsReferences`、`detectCycles`、`computeReadyJobs`（纯函数，不访问文件系统）
- P3.1 `validate` 命令集成 DAG 校验（更新 `loadWorkflow` 调用 dag 模块）
- P3.2 基础设施端口与适配器：`Clock`、`IdGenerator`、`StateStore`（`LocalStateStore`）、`EventWriter`（`JsonlEventWriter`）
- P3.2 `run/` 模块：createRunDirectory、writeRunYaml、readStateSnapshot、writeStateSnapshot、snapshotSkillLock
- P3.2 `events/` 模块：appendEvent、readLastEventId、event schema 定义
- P3.2 `engine/createRun`：orchestrates DAG + run 目录 + 初始 state + 初始事件
- P3.2 `commands/run.ts`：CLI handler（load workflow → engine.createRun → 输出 run_id 和 next action 建议）
- P3.3 `commands/status.ts`：读取 state.json → 渲染 run/job/step 状态

**P3 范围外（P4+）：**

- Agent Step 执行（FR-006 prompt 生成） — P4+
- Script Step 执行（FR-007） — P4+
- Check Step 执行（FR-008） — P4+
- Router Step（FR-009） — P4+
- Signal 机制（FR-010） — P4+
- Optional Job 激活（FR-011） — P4+
- Retry Job（FR-012） — P4+
- Artifact 管理（FR-013） — P4+
- Workspace/权限模型（FR-014） — P4+
- `engine/` 中除 createRun 之外的所有 Engine 命令 — P4+

**外部依赖：**

- `yaml` npm package（已安装，P2 引入）
- `zod` npm package（已安装，P2 引入）
- Node.js `node:fs/promises`、`node:path`、`node:crypto`（标准库，无需安装）

---

## Findings

| ID | Type | Description | Impact | Blocking |
|---|---|---|---|---|
| F-01 | Gap | run_id 格式（PRD 示例 `20260606-0001`）未在合同中正式规范。日期+计数器格式合理，但计数器在并发场景下不安全。MVP 单进程单用户，目前可接受。 | 低：仅影响 IdGenerator 实现 | 否，实现决策 |
| F-02 | Gap | `run.yml` 字段集合未正式规范（architecture §8.1 仅提及 task、workflow、创建时间、skill lock 快照）。需 Step 1 subagent 确认完整 schema。 | 低：文档化后可实现 | 否，Step 1 明确 |
| F-03 | Gap | `status` 命令输出的视觉格式未规范。PRD FR-005 规定信息内容（job 状态、ready jobs、next step 建议），但未规定显示布局。 | 低：实现可选择合理格式 | 否，Step 1 设计 |
| F-04 | Risk | Windows 平台 `rename(tmp, target)` 原子替换：Node.js `fs.rename` 在 Windows 上当 target 已存在时行为为 replace（POSIX 语义），但旧版 Windows 可能抛出 EPERM。需用 try/catch fallback。 | 中：state.json 写入安全性 | 否，Step 2 实现处理 |
| F-05 | Design | `engine/createRun` 是 P3 实现的唯一 Engine 命令。P4+ 将继续扩展 `engine/`。P3 必须定义 Engine 的 public interface（ports），即使目前只有 createRun 实现，以防止 CLI 绕过 Engine 直接写 state。 | 中：架构约束 | 否，但必须在 Step 1 中规范接口 |

---

## Decision

**Ready for development: Yes**

设计材料完整，无设计缺口，无阻塞项。

F-01 至 F-05 均为实现决策或实现风险，可在各工作流 Step 1（用例与测试设计）中明确，不阻塞 P3 启动。

**前置条件：** P2 cleanup PR（fix issues #5、#6、#8）已提交并合并后，才启动 WF-P3-DAG Step 2（实现）。WF-P3-DAG Step 1 可提前准备。

---

## Required Follow-up

| Item | Owner suggestion | Exit condition |
|---|---|---|
| P2 cleanup PR 合并（Issues #5、#6、#8） | Phase Dev Supervisor 跟进合并 | fix/p2-cleanup 合并到 main |
| TD-P2-001 清偿 | WF-P3-DAG Step 2 实现 dag/ 并集成到 validate | Issue #7 关闭 |
| run_id 生成策略（F-01） | WF-P3-RUN Step 1 明确 | Step 1 用例文档记录 |
| run.yml schema（F-02） | WF-P3-RUN Step 1 明确 | Step 1 用例文档记录 |
| status 输出格式（F-03） | WF-P3-STATUS Step 1 明确 | Step 1 用例文档记录 |
| Windows 原子替换（F-04） | WF-P3-RUN Step 2 实现时处理 | 测试在 Windows 路径下覆盖 |
| Engine port 接口定义（F-05） | WF-P3-RUN Step 1 明确接口 | Step 1 用例文档定义 Engine public interface |
