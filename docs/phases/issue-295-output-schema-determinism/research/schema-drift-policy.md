# Research Report: 跨 Attempt Schema-Hash 漂移策略（D1）

- Date: 2026-08-18
- Author: 预研 subagent（issue-295 预研）
- Status: Complete
- Inputs: `docs/phases/issue-295-output-schema-determinism/02-development-plan.md`（Open Decisions D1）、[Issue #295](https://github.com/LummiGhost/zigma-flow/issues/295)、[PR #294 审阅评论](https://github.com/LummiGhost/zigma-flow/pull/294#issuecomment-5325736056)、代码取证（见下）

## Question

resume/retry 时跨 attempt schema-hash 不一致（用户在 pause/resume 之间编辑 workflow 文件导致新编译 schema 与历史 attempt 记录的 `output_schema_sha256` 不同）采用哪种策略：

- **A：warn-only** — 显式信号（事件 + system log + console 警告），继续执行当前合同。
- **B：fail-closed** — 作为 config 类失败终止该 step（`recordAgentFailure`, errorType: "config"），用户必须还原 workflow 文件才能 resume。
- **C：hybrid** — 默认 warn + 显式 strict 开关 opt-in fail-closed。

## Code Evidence（取证核查，全部为直接读码结论）

### E1. resume 复用 attempt 号；retry 递增 attempt；两者目录行为不同

- **runAll --resume**（`src/engine/runAll.ts`）：resume 只接受非终态 run（completed/failed/cancelled/blocked 在循环入口直接 break，runAll.ts:1600-1607；`tests/engine/runAll-resume.test.ts` T-RESUME-3 锁定该行为）。"running" 状态的 job 由 fallback 重新调度（runAll.ts:1708-1722），`executeJobOnce` 从 `jobState.current_step ?? steps[0]` 继续（runAll.ts:426），`executeAgentStep` 使用 `state.jobs[jobId]?.attempt ?? 1`（runAll.ts:521）——**复用原 attempt 号，写同一 stepDir**（`jobs/<jobId>/attempts/<N>/steps/<stepId>/`，runAll.ts:672-680）。上一执行段遗留的 `agent.invocation.json`（若存在）会被新执行**覆盖**。
- **retryJob**（CLI `retry --job` 与 `recordAgentFailure` 的 failure_policy retry 共用）：`nextAttempt = currentAttempt + 1`（`src/engine/retryJob.ts:130-131`），**新 attempt 目录**，旧目录保留。`tests/engine/retry.test.ts:668-693` 断言 attempt 1→2→3。
- **resetRun**（`src/engine/resetRun.ts:326`）：删除 `attempt` 字段 → 回到 attempt 1 → **同一目录再次被覆盖**，旧证据在执行后丢失。
- **humanGate resumeWithInput**（`src/engine/humanGate.ts:700-710`）：同一 attempt 目录写 `human-decision.json`，不涉及 agent invocation。
- **推论（关键）**：resume（run 续跑）场景下"上一 attempt 的 invocation.json"通常**不存在**——进程被杀时 backend 尚未写完文件；上一段执行成功则 job 已推进 current_step；pauseBefore 在 invoke 前暂停、无文件。真正可比的先例文件出现在：(a) retry 的 attempts/1..N-1 目录；(b) reset-run / 同号覆盖的**当前目录自身**（执行前读取）。因此检查必须**在 backend.execute 之前**读取（先例目录 + 当前目录既有文件），否则同号覆盖会销毁唯一证据。这正面回答了开发计划 Risks 表中"resume 复用 attempt 号导致'上一 attempt 文件'定位错误（同号覆盖）"——风险属实，缓解方案即"执行前读当前目录既有文件 + 历次 attempt 目录"。

### E2. invocation.json 的缺失边界

- **claude-code**（`src/agent/backends/claude-code.ts`）：成功路径写 hash（:183）；catch 路径写 invocation 但**不带 `output_schema_sha256`**（:286-297 字段缺失）；timeout/cancel 返回值不含 `invocationPath`（:301-325）→ runAll 不注册 artifact，但文件仍落盘（无 hash）。
- **codex-cli**（`src/agent/backends/codex-cli.ts`）：`writeInvocation` 在**所有**路径（含 timeout/cancel）写 hash（:112、:149、:213-225）。
- **runAll**（:878-881）：timeout 分支**不注册** invocation artifact（"not available on timeout" 注释）。
- **完全不写 invocation.json** 的路径：执行前 config 失败（backendResolver 失败 runAll.ts:593-609、compileAgentOutputSchema 失败 :620-640、supportsOutputSchema=false :642-660）；pauseBefore（:708-746，不执行）；引擎进程 SIGKILL（backend 无机会写）；该 step 首次执行。
- **降级规则**：无文件或无 `output_schema_sha256` 字段 → "无证据可比"，跳过检查（可选 debug 级 system log）。比较对象应从 N-1 向 1 **回溯第一个含 hash 的先例**（避免 claude-code catch 路径无 hash 的先例挡住更早的有效证据）。

### E3. 事件体系：58 个类型、无 warning 事件、新增成本中等但有先例

- `src/events/eventTypes.ts`：closed union + `EVENT_TYPES` runtime tuple（58 个）。`tests/events/eventTypes.test.ts` T-EVT-CATALOG-1 锁定 length=58 + 集合相等；T-EVT-NARROW-2 exhaustive switch 锁定判别联合。新增事件类型需改 4 处（union/tuple/payload interface/discriminated union）+ 测试 2 处（catalog 列表与长度、exhaustive switch）+ `docs/mvp-contracts.md` §2.4 提及。
- **无通用 warning 类事件可复用**。最接近的 `execution_paused`（改变状态）、`job_skipped`/`step_skipped`（跳过语义）、`job_state_override`（实际覆盖）均语义不符。开发计划 Risks 表建议"优先复用既有事件"——**没有语义匹配的既有类型**，新增 `schema_drift_detected` 是干净解（近期三批新增先例：WF-7.1 attempt 组、WF-7.2 iteration 组、Issue #268 poll 组）。
- 审计通道：`events.jsonl` 是审计事实流（mvp-contracts §2.4），`invoke --json` 通过 `eventLogUri` 暴露给宿主；`RunLogWriter.writeSystem`（`src/logs/runLogWriter.ts:96-106`）提供 system log 通道。新事件出现在 events.jsonl 不影响 `InvokeJsonOutput` 形状，无需 bump `INVOKE_CONTRACT_VERSION`（但应在事件文档注明新增类型）。

### E4. 项目先例：WARN 语义与 fail-closed 哲学的边界

- **verify-run**（`src/commands/verify-run.ts`）：读 state/events/artifacts 做一致性检查，PASS/FAIL/WARN 三级；check 4 恰好是"state.attempt 与 attempts 目录数一致性"（多目录 → **WARN** 不阻断）。**非关键一致性漂移 → 警告**是既有先例。
- **deprecationWarn**（`src/utils/deprecation.ts`）+ workflow 加载中的大量 `console.warn`：配置面"警告但继续"的成熟先例。
- **fail-closed 先例（#289/#294 系列，docs/agent-output-schema.md）**：编译期冲突 fail-closed、supportsOutputSchema=false fail-closed、config 错误 → `recordAgentFailure("config")` → **run_failed 且不重试**（`src/engine/recordAgentFailure.ts:168-236`）。**关键边界：这些 fail-closed 全部作用于"当前合同的自洽性"（引擎无法正确执行时拒绝执行，保护正确性）；跨 attempt 漂移是历史审计证据的一致性，状态不损坏**（PR #294 审阅已确认"执行侧强制的是当前合同，状态不损坏"）。
- **Engine 全局假设**：state 只存 step/job id、run.yml 只存路径、从不快照 workflow 内容（prd.md:449；per-run 快照仅存在于 skill-lock 与 caller-context）。retryJob/resetRun/recordAgentFailure 每次都从 run.yml 路径**新鲜加载** workflow（retryJob.ts:121-122、recordAgentFailure.ts:93-116）——当前行为就是"静默采用编辑后的新 workflow"。同 run 内 retry 一致性由构造保证（runAll 启动时加载一次 wf，runAll.ts:1577；recordAgentFailure 的二次加载只读 retry/failure_policy，不碰 stepDef），PR #294 证据 #1 属实。

### E5. CLI 表面

- 主命令 `invoke`（run-all 已 deprecated，`src/commands/invoke.ts`）：`--task`、`--resume`、`--pause-before`、`--stop-after`、`--json`、`--event-file` 等（invoke.ts:43-78）。
- `retry --job [--run|--latest] [--force]`（`src/commands/retry.ts`）；`reset-run`、`force-set`、human-gate `resume`（非 run 续跑）。
- hybrid strict 开关的挂载点：**invoke/run-all 的 CLI flag** 最轻（step 执行发生在 runAll 内，retry --job 只改状态不执行 step，无需透传 retry）；workflow 级字段需动 workflow zod + docs/workflow-language.md，成本高。当前均无消费者。

## Options Evaluated

| 维度 | A: warn-only | B: fail-closed | C: hybrid（默认 warn + strict 开关） |
| --- | --- | --- | --- |
| 正确性影响 | 状态不损坏（当前合同继续被强制，PR #294 已论证）；补齐缺失的信号 | 状态同样不损坏，但把"审计一致性"升级为"执行前置条件" | 默认同 A；strict 下同 B |
| 审计证据质量 | 高：显式事件（events.jsonl 审计流）+ system log + console 警告 | 最高（阻断式），但收益是对证据美学而非正确性 | 默认同 A；strict 下同 B |
| 用户操作成本 | 零：编辑 workflow 后 resume/retry 照常 | **高**：编辑 outputs 声明后无法继续（config 失败 → run_failed 且不重试，recordAgentFailure.ts:168-236），必须还原文件或新开 run。编辑 workflow 是合法日常开发行为，fail-closed 将其变成死锁 | 默认零；strict 下同 B（用户自选） |
| 实现复杂度 | 低：检查点（见 Recommendation）+ 1 个新事件 + log + console.warn | 中：复用 recordAgentFailure config 分支即可，但 run_failed 放大效应（一个 job 漂移杀死整个 run）需额外处理才合理 | 中低：A + 开关透传（invoke → runAll opts → executeAgentStep）；开关引入 CLI 表面 + 契约文档连锁 |
| fail-closed 哲学契合 | 弱于 B，但**与事实匹配**：fail-closed 先例全部保护执行正确性（E4），此处无正确性危害 | 表面契合、实质错位：保护的是证据一致性而非执行正确性 | 两全，但 strict 开关当前**无消费者**（宿主 zigma-core 未要求、issue 验收未要求） |
| 与"不快照 workflow"全局假设相容 | 完全相容 | 相容 | 相容 |

## Recommendation

**推荐 A（warn-only）。** 核心理由：

1. **正确性事实决定策略强度**。#294 审阅已确认漂移"状态不损坏，只有审计证据跨 attempt 不一致"——即问题本身是一个**信号缺失**问题，不是正确性问题。warn 恰好补齐信号，直接满足 issue 验收（"resume/retry 跨 attempt schema 变化有显式信号"）。
2. **fail-closed（B）的惩罚与事实错位**。config 类失败不重试且直接 `run_failed`（E4），意味着用户 pause 期间合法编辑 workflow 的 outputs 声明后，整个 run 被杀死且无法 resume。项目 fail-closed 先例（#289/#294）全部针对"引擎无法正确执行的合同"；把该哲学移植到"历史证据不一致"上属于过度外推。
3. **hybrid（C）的 strict 开关当前无消费者**（YAGNI），且本 slice 预算 5 个工作项；A 的事件+日志已为将来增量加开关奠定基础（届时只需在检查点加一个 fail 分支），放弃 C 的迁移成本极低。
4. **warn 先例充分**：verify-run 的 WARN 等级（E4）、deprecationWarn、workflow 加载的 console.warn 链——项目对"非关键一致性/兼容性漂移"的既定处置就是警告。
5. **与 Engine 全局假设完全相容**，不引入 per-run workflow 快照（快照被 issue 标为可选、本 slice 不做）。

**A 的实现要点（供 Step 1/2 使用）**：

- 检查点：`executeAgentStep` 中 `compileAgentOutputSchema` 成功之后、写 prompt artifact / `agent_invoked` 事件之前（runAll.ts:620-703 区域，与开发计划 W1 位置一致）。
- 证据定位（解决 E1 同号覆盖风险）：读取 `jobs/<jobId>/attempts/1..N` 中该 step 的 `agent.invocation.json`，**含当前目录（执行前读取）**；从 N 向 1 回溯**第一个含 `output_schema_sha256` 的 invocation** 与当前 `outputSchemaHash(outputSchema)` 比较。
- 降级（E2）：无文件或无 hash 字段 → 无证据，跳过（可选 debug system log）。
- 信号：新增事件 `schema_drift_detected`（payload：job_id、step_id、attempt、prior_hash、new_hash；需同步 eventTypes.ts 4 处 + eventTypes.test.ts catalog/长度/exhaustive switch + mvp-contracts.md §2.4 提及）+ `logWriter.writeSystem(...)` + `console.warn(...)`（CLI 用户可见）。
- 不改变执行语义：继续使用当前合同（编译产物、后端调用、final-line 校验全部不变）。

## Risks

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 同号覆盖销毁证据（resume/reset 复用 attempt 号） | 高（若检查点放在执行后） | 高 | 检查必须在 backend.execute 之前；读取范围含当前目录既有文件（E1） |
| 新事件类型破坏事件契约消费者 | 低 | 中 | 事件是追加式审计流（E3），不影响 InvokeJsonOutput 形状；同步更新 eventTypes 测试与 mvp-contracts §2.4 |
| warn 被忽略，审计差异仅"有信号"仍存在 | 中 | 低 | 可接受（issue 验收即"有显式信号"）；后续可选 slice：verify-run 增加 schema-hash 一致性 check |
| claude-code catch 路径不写 hash → 部分先例无证据 | 中 | 低 | 回溯下一个含 hash 的先例（E2）；后续可选：catch 路径补写 hash |
| 仅比较 N-1 漏掉更早漂移 | 低 | 低 | 每次 attempt 启动都检查 → 每次编辑在引入时即发信号；回溯规则避免"无 hash 先例挡住有效证据" |

## Next Action

1. 主管将 D1 决策（**A：warn-only**）写入 `02-development-plan.md` Freeze Record（含本报告路径与核心理由）。
2. Step 1（wf-295）用例清单（建议）：retry 跨 attempt hash 不一致 → 事件 + log + 继续执行；hash 一致 → 无信号；上一 attempt 无 invocation / 无 hash 字段 → 跳过；reset-run/resume 同号覆盖场景 → 执行前读取当前目录证据；多先例回溯（最近含 hash 者为准）。
3. 实现按"Recommendation 实现要点"执行；新增测试文件 `tests/engine/schema-determinism.test.ts`（开发计划已列）。
4. 文档更新：`docs/agent-output-schema.md` 增加跨 attempt determinism 信号一节；`docs/mvp-contracts.md` §2.4 事件列表追加新类型。
5. 后续可选 slice（不在本 slice 范围）：per-run workflow 快照；claude-code catch 路径补写 `output_schema_sha256`；verify-run 增加 schema-hash 一致性 check；若未来出现 strict 需求，在 A 基础上增量加开关。
