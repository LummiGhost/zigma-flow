# Issue #295 Output-Schema Determinism Development Plan

- Date: 2026-08-18
- Author: phase-development-supervisor
- Source issue: [ISSUE #295](https://github.com/LummiGhost/zigma-flow/issues/295) — fix: output-schema cross-attempt determinism + fail-closed gaps (follow-up to #294)
- Authority source: `docs/agent-output-schema.md`（#289/#294 合同的权威文档）+ [PR #294 审阅评论](https://github.com/LummiGhost/zigma-flow/pull/294#issuecomment-5325736056)
- GitHub Project: #39 "zigna-flow features"（item 状态 Backlog，需在开发中更新为 In Progress）

## Objective

- Business objective: 关闭 #294 审阅判定的下一 slice —— resume/retry 跨 attempt 的 schema determinism 显式信号 + 四处 fail-closed 缺口。使审计证据在 workflow 文件被编辑后仍有显式信号，并消除 zod 静默 strip、裸 ENOENT rejection、事件顺序瑕疵与 RED-PHASE 死代码。
- Technical objective:
  1. resume/retry 时跨 attempt schema-hash 一致性检查（策略经预研决定）。
  2. `outputs_schema` zod 增加 `enum`/`description`（编译器已支持，消除静默 strip）。
  3. `readFile(reportPath)` 纳入 try → `recordAgentFailure`（消除 ENOENT 裸 rejection）。
  4. `agent_completed` 事件移至 final-line 校验通过之后。
  5. 清理 tests/agent/config.test.ts T-CONFIG-14 RED-PHASE 死代码分支。

## Scope

- In scope: 上述 5 项。
- Out of scope:
  - per-run workflow 文件快照（issue 标注"可选"；属于 Engine 全局假设（state 只存 id、从不快照 workflow 内容）的更大架构变更，不在本 slice）。
  - native 边界与 Engine 在 legacy 形态上的容忍度差异（#294 审阅判定无正确性漏洞）。

## Milestones

| Milestone | Description | Exit criteria |
| --- | --- | --- |
| M1 计划冻结 | 预研完成、决策落定、计划状态 frozen | 预研报告落盘；D1 决策写入 Freeze Record |
| M2 用例与测试 | wf-295 Step 1 完成 | 用例文档 + 规范强制条款矩阵 + 测试落盘（≤2 个计划测试文件） |
| M3 实现 | wf-295 Step 2 完成 | 最小门禁包（typecheck + lint + 相关测试）通过；实现报告为 PR 评论 |
| M4 工作流验收 | wf-295 Step 3 完成 | 技术审阅 + 合规审阅 + 矩阵逐条核查全部通过 |
| M5 总验收与发布 | PR 合并、CI 全绿 | 总验收报告写入收尾 PR；Project 状态更新；工作树清理 |

## Technical Approach

### 工作项 W1：跨 attempt schema-hash 一致性检查（核心）

- 位置：`src/engine/runAll.ts` `compileAgentOutputSchema` 成功之后、prompt artifact / `agent_invoked` 事件之前（约 620–703 行区域）。
- 机制：读取 `jobs/<jobId>/attempts/1..N` 中该 step 的 `agent.invocation.json`，**含当前 attempt 目录（backend.execute 之前读取，防同号覆盖销毁证据）**；从 N 向 1 回溯第一个含 `output_schema_sha256` 的 invocation，与新编译 hash（`outputSchemaHash(outputSchema)`）比较。
- 降级边界：所有先例均无文件或无 `output_schema_sha256` 字段 → 无证据可比，跳过（可选 debug system log）。
- **策略（D1 已决）：A warn-only** —— 不一致时发显式信号（新事件 `schema_drift_detected` + `logWriter.writeSystem` + `console.warn`），继续执行当前合同，不改变任何执行语义。理由见 `research/schema-drift-policy.md`（漂移只损审计证据不损状态；fail-closed 会把合法 workflow 编辑变成 run_failed 死锁；hybrid 开关无消费者）。
- 新事件契约连锁：`src/events/eventTypes.ts` 4 处（union/tuple/payload/discriminated union）+ `tests/events/eventTypes.test.ts` catalog 长度与 exhaustive switch + `docs/mvp-contracts.md` §2.4 提及。

### 工作项 W2：`outputs_schema` zod 消除静默 strip

- 位置：`src/workflow/index.ts:286-290`。
- 证据：编译器 `parseOutputDeclaration`/`outputProperty`（src/agent/outputSchema.ts）已支持 `enum`/`description`，`docs/agent-output-schema.md` 宣称 "type, values/enum, and description are preserved"；zod 层静默丢弃与 fail-closed 意图相反。
- 修复：zod 增加 `enum: z.array(z.string()).optional()`、`description: z.string().optional()`（与 `values` 一致；编译器对非 string description 忽略、对非数组 enum 抛 ValidationError）。
- 文档：无需改（文档已宣称支持，实现补齐即可）；若 Step 1 发现文档与实现仍有偏差则同步修正。

### 工作项 W3：`readFile(reportPath)` 纳入 try

- 位置：`src/engine/runAll.ts:1018`。
- 修复：将 `readFile` 移入下方 try 块，ENOENT/读取失败包装为 `ValidationError` → 走既有 `recordAgentFailure(errorType: "execution")` 分支。
- 实测症状修正（Step 1 取证 T-295-W3-1）：外层可观察症状不是"裸 rejection 逃逸 runAll"，而是 ENOENT 被 `Promise.allSettled` 吞掉后 running-job fallback 每轮重派发、循环打满 100 次 `maxIterations`（100 条 console.error）、job 静默 stuck "running"、runAll resolve —— 静默卡死 + 错误刷屏，无任何失败事件。修复目标不变。

### 工作项 W4：`agent_completed` 事件顺序

- 位置：`src/engine/runAll.ts:983-1003`（事件发出）与 1014+（report 读取与校验）。
- 修复：将 report 读取 + final-line 校验移至 `agent_completed` 事件与 "completed" system log 之前；非法 report 的事件序列变为（无 agent_completed）→ 失败事件链。
- 措辞修正（Step 1 按代码事实核查）：失败链事件是 `step_failed`（recordAgentFailure.ts:150）+ 按 policy 的 `attempt_failed`/`job_failed`/`run_failed`；`agent_failed` 只存在于 backend 执行失败路径（runAll.ts:884-903），与 final-line 校验失败无关。测试按 `step_failed` 断言。
- Step 1 核查结论：既有测试中依赖旧事件顺序的断言均为成功路径，无需修改。

### 工作项 W5：T-CONFIG-14 死代码清理

- 位置：`tests/agent/config.test.ts:724-727`。删除 RED-PHASE "not yet implemented" 逃生分支（实现早已落地）。

### 测试策略

- W1：新增测试文件 `tests/engine/schema-determinism.test.ts`（≤2 个计划新测试文件约束内）：resume 场景 hash 一致（无告警）、hash 不一致（按选定策略断言事件/失败）、上一 attempt 无 invocation 的降级。
- W2：扩展 `tests/workflow/on-output-schema.test.ts` 与/或 `tests/agent/output-schema.test.ts`：`enum`/`description` 经 zod 后到达编译器并进入编译 schema。
- W3/W4：扩展 `tests/engine/output-schema-enforcement.test.ts`：缺 report.json 的 backend 成功路径 → agent_failed（非裸 rejection）；非法 report 事件序列断言。
- W5：`tests/agent/config.test.ts` 本体清理，断言不变。
- 全量门禁：`pnpm typecheck && pnpm test`。

### 文档更新

- `docs/agent-output-schema.md`：补充跨 attempt determinism 信号一节（含选定策略的语义）。
- 若 W1 引入新事件类型：更新事件文档与 `tests/events/eventTypes.test.ts`。

## Workflow Breakdown

| Workflow | Goal | Dependencies | Acceptance criteria | Research needed |
| --- | --- | --- | --- | --- |
| wf-295 | 完成 5 个工作项，通过双轨审阅 | M1 预研结论 | issue 验收条件：跨 attempt schema 变化有显式信号；`enum`/`description` 无静默丢弃；新增测试覆盖每项；`pnpm typecheck && pnpm test` 通过 | D1：策略决策（W1） |

单工作流单 slice 的理由：5 个工作项均为 #294 审阅遗留的小型独立缺口，issue 本身即一个 slice；分两 slice 会增加一倍委派开销而无评审收益。实现 agent 须按工作项原子提交。

## Risks And Mitigations

| Risk | Probability | Impact | Mitigation | Owner |
| --- | --- | --- | --- | --- |
| 既有测试依赖旧事件顺序（agent_completed → agent_failed），W4 改动破坏大量断言 | 中 | 中 | Step 1 枚举受影响测试；Step 2 同步更新断言并注明理由 | wf-295 |
| resume 复用 attempt 号导致"上一 attempt 文件"定位错误（同号覆盖） | 中 | 高 | Step 1 必须实测核对 resume 的 attempt 目录行为，用例覆盖该边界 | wf-295 |
| fail-closed 策略导致用户在 pause/resume 间编辑 workflow 后无法 resume | 低（若选 fail-closed） | 高 | 预研 D1 显式权衡；若 fail-closed 需提供绕过信号 | 预研 |
| 新事件类型破坏事件契约消费者 | 低 | 中 | 优先复用既有事件 payload 字段而非新增类型；若新增则更新 eventTypes 测试 | wf-295 |

## Quality Bar

- Required automated tests: 见"测试策略"；每项至少一个正例 + 一个负例。
- Required manual checks: 无（后端技术工作流，无 UI）。
- Performance / reliability constraints: 跨 attempt 检查仅一次文件读取（invocation.json 为小文件），不得引入对 agent 执行路径的额外网络/重试。
- Documentation updates: `docs/agent-output-schema.md` 同步；事件/合同文档如有变更同步。

## Open Decisions

| Decision | Options | Research task | Due trigger |
| --- | --- | --- | --- |
| D1 跨 attempt schema hash 不一致的策略 | A: warn-only（事件+日志，继续执行）；B: fail-closed（config 失败）；C: hybrid（默认 warn + 显式 strict 开关） | research/schema-drift-policy.md | M1，Step 1 启动前 |

## Freeze Record

- Plan status: Frozen
- Frozen at: 2026-08-18
- Final decisions:
  - **D1 → A（warn-only）**：跨 attempt schema hash 不一致时发显式信号（新事件 `schema_drift_detected` + system log + console.warn），继续执行当前合同。依据：`research/schema-drift-policy.md`（E1–E5 取证）。放弃 B（fail-closed 惩罚与事实错位：config 失败 → run_failed 不重试，合法编辑 workflow 会变成死锁）与 C（strict 开关无消费者，YAGNI；A 的事件基础使将来增量加开关成本极低）。
  - 检查点证据定位采用"执行前读当前目录 + 回溯 1..N 中第一个含 hash 的先例"（解决 resume/reset-run 同号覆盖风险）。
  - W2 直接定案：zod 增加 `enum`/`description`（编译器已支持，证据决定性，无需预研）。
  - per-run workflow 快照：本 slice 不做（issue 标注可选；与 Engine 不快照 workflow 的全局假设冲突，属更大架构变更）。
- Residual risks:
  - 新事件类型需同步 eventTypes 4 处 + 测试 + mvp-contracts §2.4（中等成本，有三次先例）。
  - warn 信号可能被忽略（可接受：issue 验收即"有显式信号"；后续可选 slice：verify-run 增加 schema-hash check）。
  - claude-code catch 路径不写 hash → 部分先例无证据（回溯规则缓解；后续可选：catch 路径补写 hash）。
