# wf-295 Cases And Tests

- Date: 2026-08-18
- Author: wf-295 Step 1 subagent（用例与测试设计）
- Source issue: [#295](https://github.com/LummiGhost/zigma-flow/issues/295) — fix: output-schema cross-attempt determinism + fail-closed gaps（#294 后续 slice）
- Authority sources:
  - `docs/agent-output-schema.md`（#289/#294 合同的权威文档）
  - `docs/mvp-contracts.md` §2.4 Event Contract / §2.6 Agent Report Contract
  - `docs/phases/issue-295-output-schema-determinism/02-development-plan.md`（frozen）
  - `docs/phases/issue-295-output-schema-determinism/research/schema-drift-policy.md`（D1 = A warn-only）

## Slice Boundary

- Slice name: wf-295（单 slice）
- Bounded context this slice belongs to: Agent output-schema contract / engine execution（runAll 执行路径 + workflow 加载 zod 层 + 事件体系）
- User tasks covered: 不适用 —— 本 slice 是后端技术工作流，5 个工作项（W1–W5）全部面向内部正确性与审计证据（跨 attempt schema 漂移信号、zod 静默 strip、ENOENT 裸 rejection、事件顺序、死代码），无可演示的面向用户操作。UX expectations source: not applicable — 技术工作流，无 UI/wireframe。
- Planned test files（新文件 ≤2 约束：本 slice 仅 1 个新文件）:
  - 新增 `tests/engine/schema-determinism.test.ts`（W1）
  - 扩展 `tests/workflow/on-output-schema.test.ts`（W2）
  - 扩展 `tests/engine/output-schema-enforcement.test.ts`（W3/W4）
  - `tests/events/eventTypes.test.ts`（W1 事件类型 catalog 58→59 + exhaustive switch）—— 经判定由 **Step 2** 修改：在 Step 1 加入 `"schema_drift_detected"` 字面量会导致 `ZigmaFlowEventType` 未包含该类型而 **typecheck 失败**（RED 只允许断言失败，不允许编译失败）。本步只在用例文档与测试映射中登记该改动清单。
  - `tests/agent/config.test.ts`（W5）—— 本步不动；Step 2 删除 724–727 死代码分支，断言不变。

## Workflow Goal

- Goal: 关闭 #294 审阅遗留的下一 slice —— resume/retry 跨 attempt schema determinism 显式信号 + 四处 fail-closed 缺口（zod 静默 strip、裸 ENOENT、事件顺序、RED-PHASE 死代码）。
- Acceptance criteria（技术断言）:
  - W1：跨 attempt schema hash 不一致时发出显式信号（新事件 `schema_drift_detected` + system log + console.warn），继续执行当前合同（warn-only，策略 D1=A）；hash 一致 / 无证据时无信号。
  - W2：`outputs_schema` 声明的 `enum`/`description` 经 zod 层到达编译器并出现在编译 schema 中（无静默丢弃）。
  - W3：backend 成功但未写 report.json → `recordAgentFailure(errorType: "execution")`，job 转 failed，无裸 ENOENT rejection。
  - W4：非法 report 的事件序列为（无 `agent_completed`）→ 失败事件链；无 "completed" system log。
  - W5：删除 tests/agent/config.test.ts T-CONFIG-14 RED-PHASE 逃生分支后断言仍成立。
  - 门禁：`pnpm typecheck && pnpm test` 全绿；新增测试覆盖每项（至少一个正例 + 一个负例）。

## Spec Compliance Matrix

| 条款 ID | 规范来源 | 条款内容摘要 | 实现状态 | 备注 |
| --- | --- | --- | --- | --- |
| SPEC-295-01 | agent-output-schema.md L3-6 | Declared output keys are required; `type`, `values`/`enum`, and `description` are preserved | 已纳入本工作流 | W2：`outputs`（z.record unknown）已保留，`outputs_schema` 的 zod（src/workflow/index.ts:286-290）静默 strip `enum`/`description`，与文档宣称相反 |
| SPEC-295-02 | agent-output-schema.md L81-82 | 编译 schema 写入 `agent-output-schema.json`，其 SHA-256 记录于 `agent.invocation.json` | 规范不适用（已在 #294 实现）— W1 作为证据消费 | 证据：src/agent/backends/claude-code.ts:183（成功路径）、codex-cli.ts:112/149（全路径）；本 slice 只读该证据做跨 attempt 比较，不改写 |
| SPEC-295-03 | agent-output-schema.md "Compile-time validation" | 非法声明（非对象、unsupported type、values/enum 非数组、status 冲突）在编译期 fail-closed | 规范不适用（已在 #294 实现） | 证据：src/agent/outputSchema.ts parseOutputDeclaration/mergeStatusDeclaration + tests/engine/output-schema-enforcement.test.ts |
| SPEC-295-04 | agent-output-schema.md "Backend capability contract" | supportsOutputSchema=false → 执行前 fail-closed，无 prompt-only fallback | 规范不适用（已在 #294 实现） | 证据：src/engine/runAll.ts:642-660 + 测试 "fails closed when the backend does not support output-schema enforcement" |
| SPEC-295-05 | agent-output-schema.md "Final-line enforcement" L129-131 | Engine 在改变 workflow 状态前校验 report.json（每一条 accept 路径） | 已纳入本工作流 | W3/W4：状态变更本就在校验之后，但 `agent_completed` 事件与 "completed" system log 在校验前发出，且 report.json 缺失时 ENOENT 裸 rejection 绕过 recordAgentFailure 路径 |
| SPEC-295-06 | agent-output-schema.md L139-142 | Autonomous runAll：违规经 recordAgentFailure（errorType "execution"），被拒 outputs 永不持久化、不触发路由 | 已纳入本工作流 | W3：readFile 纳入 try → ValidationError → 既有 execution 分支（src/engine/runAll.ts:1041-1059） |
| SPEC-295-07 | agent-output-schema.md L71-79 | artifacts 编译为 string refs 数组，非 string 项在每一条 accept 路径被拒绝 | 规范不适用（已在 #294 实现） | 证据：outputSchema.ts:212 + tests（T-#294 artifacts string ref） |
| SPEC-295-08 | mvp-contracts §2.4 L106-109 | Event 是审计事实流，至少含 id/run_id/type/timestamp/producer/job/step/attempt/payload | 已纳入本工作流 | W1 新事件走既有 envelope + nextSequentialEventId 单调 ID，出现在 events.jsonl |
| SPEC-295-09 | mvp-contracts §2.4 L143 | `agent_completed` — backend 成功且 report.json 合法 | 已纳入本工作流 | W4：当前实现 backend 成功即发 agent_completed，report 非法时产生 agent_completed → step_failed 的矛盾序列；修复后事件定义与实际序列一致 |
| SPEC-295-10 | mvp-contracts §2.4 L169-171 | 事件格式 additive only：不修改既有事件类型或 payload schema；共享同一事件序列 | 已纳入本工作流 | W1 追加新类型 `schema_drift_detected`（不改既有类型）；W4 修正的是"何时发出"而非类型/payload schema。mvp-contracts §2.4 事件列表提及由 Step 2 文档更新 |
| SPEC-295-11 | mvp-contracts §2.6 L257 | report 缺失、JSON 不合法或 schema 不匹配时，当前 step failed 或 blocked，按 gate 处理 | 已纳入本工作流 | W3（缺失）/W4（不合法）均经 recordAgentFailure → failed/blocked/retry 按 job policy |
| SPEC-295-12 | mvp-contracts §2.5 L193 | retry 不得覆盖历史 attempt artifact | 已纳入本工作流（检查只读） | W1 只读 prior attempts 的 invocation.json；同号覆盖风险（resume/reset）由"执行前读当前目录"缓解（见 UC-295-004） |
| SPEC-295-13 | 02-development-plan.md Out of scope | per-run workflow 文件快照（issue 标"可选"，与 Engine 不快照 workflow 的全局假设冲突） | 计划外（技术债 TD-295-01） | 后续可选 slice |
| SPEC-295-14 | schema-drift-policy.md Next Action 5 | claude-code catch 路径补写 `output_schema_sha256`（部分先例无证据，回溯规则缓解） | 计划外（技术债 TD-295-02） | 后续可选 slice |
| SPEC-295-15 | schema-drift-policy.md Next Action 5 | verify-run 增加 schema-hash 一致性 check；若出现 strict 需求在 A 基础上增量加开关 | 计划外（技术债 TD-295-03 / TD-295-04） | warn 信号可能被忽略（可接受：issue 验收即"有显式信号"） |

## Functional Points

- FP-295-W1-CHECK: 跨 attempt schema-hash 一致性检查点 —— `compileAgentOutputSchema` 成功之后、prompt artifact / `agent_invoked` 事件之前（runAll.ts 620–703 区域）。
- FP-295-W1-EVIDENCE: 证据定位与降级 —— 读 `jobs/<jobId>/attempts/1..N` 中该 step 的 `agent.invocation.json`（含当前 attempt 目录、backend.execute 前读取）；从 N 向 1 回溯第一个含 `output_schema_sha256` 的先例；无文件/无 hash 字段 → 跳过（可选 debug system log）。
- FP-295-W1-SIGNAL: warn-only 信号 —— 新事件 `schema_drift_detected`（payload: job_id、step_id、attempt、prior_hash、new_hash）+ `logWriter.writeSystem` + `console.warn`；不改变任何执行语义（继续当前合同）。
- FP-295-W1-CATALOG: 事件契约连锁 —— src/events/eventTypes.ts 4 处（union/tuple/payload interface/discriminated union）+ tests/events/eventTypes.test.ts（catalog 58→59、exhaustive switch）+ docs/mvp-contracts.md §2.4 提及（Step 2 执行）。
- FP-295-W2-ZOD: `outputs_schema` zod 增加 `enum: z.array(z.string()).optional()`、`description: z.string().optional()`（与 values 一致；编译器对非 string description 忽略、非数组 enum 抛 ValidationError——语义对齐 outputSchema.ts:38-46,57）。
- FP-295-W3-READFILE: `readFile(reportPath)`（runAll.ts:1018）纳入 try → ValidationError → 既有 recordAgentFailure(errorType "execution") 分支。
- FP-295-W4-ORDER: report 读取 + final-line 校验移至 `agent_completed` 事件（runAll.ts:983-1003）与 "completed" system log（1005-1012）之前。
- FP-295-W5-CLEANUP: 删除 tests/agent/config.test.ts:724-727 T-CONFIG-14 RED-PHASE "not yet implemented" 逃生分支（Step 2）。

## Use Cases

| ID | Scenario | Preconditions | Expected result | Priority |
| --- | --- | --- | --- | --- |
| UC-295-001 | resume/reset 同号覆盖：同一 attempt 目录已有带旧 hash 的 invocation.json，执行前检查发现与新编译 hash 不一致 | job running + current_step 指向 agent step + attempt N 目录含带 `output_schema_sha256` 的 agent.invocation.json（旧值） | 发 `schema_drift_detected`（payload job_id/step_id/attempt/prior_hash/new_hash）+ system log + console.warn；继续执行当前合同，run 正常完成（warn-only） | P0 |
| UC-295-002 | retry 跨 attempt：attempt N-1 的 invocation hash 与 attempt N 新编译 hash 不一致 | attempts/1..N-1 存在带 hash 的 invocation；当前 attempt = N | 同上信号（payload.attempt = N）；`schema_drift_detected` 先于 `agent_invoked` | P0 |
| UC-295-003 | hash 一致 → 无信号 | prior invocation 的 hash == 新编译 hash | 无 `schema_drift_detected`、无 console.warn；run 正常完成 | P0 |
| UC-295-004 | 无 invocation / 无 hash 字段 → 跳过 | 所有先例目录无 agent.invocation.json，或文件不含 `output_schema_sha256` | 检查静默跳过（无事件）；run 正常完成 | P0 |
| UC-295-005 | 多先例回溯：较新的先例无 hash（decoy），更早先例有 hash | attempts/1 带 hash、attempts/2 不带、当前 attempt=3 | 回溯到 attempts/1 的 hash 作为 prior_hash（decoy 不遮蔽更早证据） | P1 |
| UC-295-006 | 多先例回溯：多个带 hash 的先例取最近者 | attempts/1 与 attempts/2 各带不同 hash、当前 attempt=3 | prior_hash = attempts/2 的 hash（N→1 第一个命中） | P1 |
| UC-295-007 | outputs_schema 声明 enum/description 的工作流加载 | workflow 的 outputs_schema 条目含 `enum: [...]` 与 `description: "..."` | loadWorkflow 后编译 schema 含 `enum`/`description`（与 outputs 声明一致） | P0 |
| UC-295-008 | backend 返回成功但未写 report.json | backend 子进程退出 0、reportPath 无文件 | runAll 不产生裸 ENOENT rejection；经 recordAgentFailure(errorType "execution")，job → failed，事件链（无 agent_completed）→ step_failed 等 | P0 |
| UC-295-009 | 非法 report 的事件序列 | backend 成功且写了 report.json，但 final-line 校验失败（如 enum 越界） | 事件序列：无 `agent_completed` → `step_failed`（+ job/run 失败事件）；无 "completed" system log | P0 |
| UC-295-010 | T-CONFIG-14 死代码移除 | tests/agent/config.test.ts 逃生分支删除（Step 2） | 未注册 backend 名仍抛 ConfigError 且 message 含 name 与 "not registered"；无 "not yet implemented" 分支 | P1 |

> 说明：开发计划 W4 文案"非法 report 的事件序列变为（无 agent_completed）→ agent_failed"中的 `agent_failed` 是宽松表述 —— 实际机制上 final-line 失败路径由 `recordAgentFailure` 发出 `step_failed`（+job_failed/run_failed），`agent_failed` 只存在于 backend 执行失败路径（runAll.ts:884-903）。本用例与测试按代码事实断言 `step_failed`。

> 说明（W3 现状实测，T-295-W3-1 RED 取证）：开发计划 W3 文案"裸 ENOENT rejection"的内层机制属实 —— `readFile(reportPath)` 在 try 外抛出，`executeJobOnce` 的 promise 被 `Promise.allSettled` 吞掉，每轮迭代 console.error "Job promise rejected (unexpected error in executeJobOnce)"。但外层可观察症状与"裸 rejection 逃逸 runAll"不同：running-job fallback 每轮重新派发该 job，循环打满全部 100 次 `maxIterations`（100 条 console.error），随后因迭代上限退出；job 始终 stuck 在 "running"，runAll resolve 且 summary 中 job 状态为 "running" —— 即"静默卡死 + 错误刷屏"，无任何失败事件。修复后的 Expected result（job → failed 经 recordAgentFailure）不变。

## Test Mapping

| Test name | Covers use cases | Notes |
| --- | --- | --- |
| tests/engine/schema-determinism.test.ts（新增）T-295-W1-1 同号覆盖 drift（RED） | UC-295-001 | resume 场景：attempt=1 当前目录预置 invocation；断言事件 + payload 精确字段 + 顺序（先于 agent_invoked）+ system log + console.warn + run completed |
| T-295-W1-2 retry 跨 attempt drift（RED） | UC-295-002 | state attempt=2、attempts/1 预置 hash；断言 payload.attempt=2、prior_hash、new_hash=重编译期望值 |
| T-295-W1-3 hash 一致无信号 | UC-295-003 | 预置 hash = compileAgentOutputSchema+outputSchemaHash 实算值；负例守卫（两阶段皆绿） |
| T-295-W1-4 无证据跳过 | UC-295-004 | 无任何 invocation 文件；负例守卫 |
| T-295-W1-5 回溯跳过无 hash decoy（RED） | UC-295-005 | attempts/2 无 hash decoy、attempts/1 带 hash、attempt=3 |
| T-295-W1-6 回溯取最近含 hash 者（RED） | UC-295-006 | attempts/1=old1、attempts/2=old2、attempt=3 → prior_hash=old2 |
| tests/workflow/on-output-schema.test.ts（扩展）T-295-W2-1 enum 保留（RED）/ T-295-W2-2 description 保留（RED） | UC-295-007 | loadWorkflow → compileAgentOutputSchema → 断言编译 schema 的 enum/description；负例：description 非法类型被编译器忽略不炸 |
| tests/engine/output-schema-enforcement.test.ts（扩展）T-295-W3-1 缺 report.json（RED） | UC-295-008 | 新增 NoReportBackend；断言 runAll resolve、job failed、step_failed 存在、无 agent_completed |
| T-295-W4-1 非法 report 事件序列（RED） | UC-295-009 | ReportingBackend 写 enum 越界 report；断言无 agent_completed、step_failed 存在、run.log.jsonl 无 "completed" system 行 |
| tests/events/eventTypes.test.ts（Step 2 改） | SPEC-295-10 | T-EVT-CATALOG-1 列表+长度 58→59；T-EVT-NARROW-2 exhaustive switch 增 case "schema_drift_detected"；T-EVT-RT 新增 round-trip（可选）。本步改会 typecheck 失败，故留给 Step 2 |
| tests/agent/config.test.ts（Step 2 改） | UC-295-010 | 删除 724-727 死代码分支，断言不变 |

## Test Gaps

- Gap: W1 用预写 invocation.json 模拟先例证据，未覆盖真实 backend（claude-code/codex-cli）子进程写出 invocation 的端到端跨 attempt 场景（单元层已覆盖两 backend 的写入逻辑，见 SPEC-295-02 证据）。
- Action: residual risk 记录；不阻塞本 slice（e2e/dogfood 层后续可选覆盖）。
- Gap: W1 检查点的性能约束（仅一次小文件读取、无额外网络/重试）无自动化断言。
- Action: 由 Step 3 tech-review 人工核查（Quality Bar 已声明约束）。
- Gap: 事件类型 catalog/exhaustive switch 测试更新、mvp-contracts §2.4 文档提及（新事件类型）未在本步落盘。
- Action: 已登记 Step 2 改动清单（见 Test Mapping 末两行与 FP-295-W1-CATALOG）。
