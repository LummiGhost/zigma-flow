# WF-V022-HUMANGATE Cases And Tests

## Slice Boundary

- Slice name: Human Gate Semantic Contract
- Bounded context this slice belongs to: engine / human gate
- User tasks covered (最多 3 条):
  1. 用户可以在 workflow human step 里声明 `timeout_minutes` 而不触发 schema validation error（DSL 预留，运行时不强制超时）。
  2. 用户可以对 human gate `approve` / `reject`，并让紧随其后的 router 通过 `${{ steps.<human-step-id>.outputs.decision }}` / `.comment` 表达式看到决策结果。
  3. 用户可以打开 `human-decision.json` artifact，凭一份稳定的 schema 判断字段是否齐全（下游脚本、审计工具据此消费）。
- Planned test files (最多 2 个):
  - `tests/workflow/human-step-timeout.test.ts`
  - `tests/engine/humanGate-router.test.ts`
- UX expectations source: `docs/phases/p15-human-gate/02-development-plan.md` AD-P15-001 ~ AD-P15-006（决策已冻结；v0.2.2 只做语义收敛，不改用户界面）。

## Workflow Goal

- Goal: 把 P15 遗留的 human gate 语义边界锁死——`timeout_minutes` 字段进入 zod schema（仅 DSL 预留，不做运行时强制）、`approvers` 明确标注"仅信息，不做身份校验"、`recordHumanDecision` 写出的 artifact 有明确 schema、downstream router 表达式契约有测试锚点。
- Acceptance criteria:
  - (面向用户) 用户在 human step 中写 `timeout_minutes: 10` 时 `zigma-flow validate` 返回 0；`timeout_minutes: 0 / 1.5 / "10"` 均返回 ValidationError。
  - (面向用户) 用户 `approve` 后 `state.jobs.<job>.outputs.decision === "approved"`，且 `${{ steps.<step-id>.outputs.decision }}` 通过标准 expression 解析器解析为 `"approved"`。
  - (面向用户) `reject --comment "…"` 后，job.status === "failed"，outputs 携带 `decision: "rejected"` 和逐字 comment。
  - (技术) `human-decision.json` 满足新增 zod schema：必需 `decision` (enum "approved" | "rejected") + `timestamp`；可选 `comment` / `decided_by` / `outputs`。
  - (技术) 源码内新增注释明确 `approvers` 语义（MVP 不做身份校验）。

## Spec Compliance Matrix

| 条款 ID | 规范来源 | 条款内容摘要 | 实现状态 | 备注 |
| --- | --- | --- | --- | --- |
| AD-P15-001 | `docs/phases/p15-human-gate/02-development-plan.md` §4 | step 状态枚举扩展 `awaiting_human`；job 状态维持 running | 已在 P15 实现；本工作流不改 | 仅回归覆盖 |
| AD-P15-002 | 同上 §4 | `human` step schema：`prompt` 必填、`approvers` 可选 string[] 且仅作信息用途、拒绝 `expose`/`uses`/`run` | 已在 P15 实现；本工作流补 `timeout_minutes` 预留 + `approvers` 语义注释 | 新增 `timeout_minutes` 字段（可选 positive integer） |
| AD-P15-003 | 同上 §4 | `enterHumanGate` 写 `human_gate_waiting` + `human-gate.md` artifact，置 step 状态为 `awaiting_human` | 已在 P15 实现 | 不改 |
| AD-P15-004 | 同上 §4 | CLI `approve` / `reject` 命令，读 active run 定位 awaiting_human step | 已在 P15 实现；本工作流仅补源码内 approvers 语义注释 | approvers 非身份校验 |
| AD-P15-005 | 同上 §4 | `recordHumanDecision` 写 `human_decision_record` artifact + `human_decision` event，approve→advance，reject→failed | 已在 P15 实现；本工作流为 artifact 内容新增 zod schema 单测 | 新增 schema 定义 |
| AD-P15-006 | 同上 §4 | router `switch` 可读 `${{ steps.<human-step-id>.outputs.decision }}` / `.comment`；表达式引擎负责求值 | 已在 P13 表达式扩展中提供 `${{ steps.<id>.outputs.<key> }}` 支持；router 执行器本身不解析表达式，本工作流仅锁死"outputs 可被表达式读取"这半契约 | 未实现的另一半（router 侧调用 resolveExpression）作为独立后续项跟踪 |

## Functional Points

- FP-V022-HUMANGATE-001 — `timeout_minutes` 字段作为 optional positive integer 出现在 human step zod schema，缺省时不影响既有 workflow。
- FP-V022-HUMANGATE-002 — `timeout_minutes` 非法值（0、负数、小数、字符串）在 `loadWorkflow` 阶段被 zod 拒绝，抛 ValidationError。
- FP-V022-HUMANGATE-003 — 运行时 engine 不消费 `timeout_minutes`；行为等同于未声明该字段（v0.2.2 out-of-scope）。
- FP-V022-HUMANGATE-004 — `src/engine/humanGate.ts` 与 `src/commands/approve.ts` / `reject.ts` 内含明确注释：`approvers` 仅供 UI 展示与审计参考，不参与授权判断。
- FP-V022-HUMANGATE-005 — `recordHumanDecision` 写出的 `human-decision.json` 满足独立 zod schema：required `decision` ∈ {"approved","rejected"} + `timestamp`，optional `comment` / `decided_by` / `outputs`。
- FP-V022-HUMANGATE-006 — `recordHumanDecision(approved)` 完成后，`state.jobs.<jobId>.outputs.decision === "approved"`，且 `resolveExpression("${{ steps.<step-id>.outputs.decision }}", ctx)` 返回 `"approved"`（其中 ctx 由 job.outputs 映射构造）。
- FP-V022-HUMANGATE-007 — `recordHumanDecision(rejected, comment)` 完成后，`state.jobs.<jobId>.outputs` 含 `decision: "rejected"` + `comment: <传入原文>`，且 `job.status === "failed"`；`${{ steps.<step-id>.outputs.comment }}` 表达式返回逐字 comment。

## Use Cases

| ID | Scenario | Preconditions | Expected result | Priority |
| --- | --- | --- | --- | --- |
| UC-TIMEOUT-001 | user 在 human step 声明 `timeout_minutes: 10` | workflow YAML 其余字段合法 | `loadWorkflow` 返回；step.timeout_minutes === 10 | P0 |
| UC-TIMEOUT-002 | user 声明 `timeout_minutes: 1`（下界） | workflow YAML 其余字段合法 | `loadWorkflow` 返回；step.timeout_minutes === 1 | P0 |
| UC-TIMEOUT-003 | user 未声明 `timeout_minutes`（现存 workflow） | v0.2.1 之前存量 workflow | `loadWorkflow` 返回；step.timeout_minutes === undefined | P0 |
| UC-TIMEOUT-004 | user 声明 `timeout_minutes: 0` | 任何 | `loadWorkflow` 抛 ValidationError | P0 |
| UC-TIMEOUT-005 | user 声明 `timeout_minutes: -5` | 任何 | `loadWorkflow` 抛 ValidationError | P0 |
| UC-TIMEOUT-006 | user 声明 `timeout_minutes: 1.5` | 任何 | `loadWorkflow` 抛 ValidationError（must be integer） | P0 |
| UC-TIMEOUT-007 | user 声明 `timeout_minutes: "10"` | YAML 里带引号会解析为字符串 | `loadWorkflow` 抛 ValidationError（must be number） | P1 |
| UC-ROUTER-APPROVE-001 | user `enterHumanGate` → `recordHumanDecision(approved, "Ship it")` | state.json 已就绪 | state.jobs.review-merge.outputs.decision === "approved"；outputs.comment === "Ship it" | P0 |
| UC-ROUTER-APPROVE-002 | 承接 UC-ROUTER-APPROVE-001；构造 ExpressionContext 由 outputs 映射 | outputs 见 UC-ROUTER-APPROVE-001 | `resolveExpression("${{ steps.gate-merge.outputs.decision }}", ctx)` === "approved" | P0 |
| UC-ROUTER-REJECT-001 | user `enterHumanGate` → `recordHumanDecision(rejected, "Missing tests for edge case X")` | state.json 已就绪 | job.status === "failed"；outputs.decision === "rejected"；outputs.comment === 逐字传入值 | P0 |
| UC-ROUTER-REJECT-002 | 承接 UC-ROUTER-REJECT-001；构造 ctx 后解析 comment 表达式 | 同上 | `resolveExpression("${{ steps.gate-merge.outputs.comment }}", ctx)` === "Missing tests" | P1 |
| UC-DECISION-ARTIFACT-001 | approve 后读取 `human-decision.json` 并用 zod schema 验证 | 已 `recordHumanDecision(approved)` | schema.safeParse.success === true；decision === "approved"，timestamp 非空 | P0 |
| UC-DECISION-ARTIFACT-002 | reject with comment + decided_by 后读取 artifact | 已 `recordHumanDecision(rejected, "…", decidedBy: "alice")` | schema.safeParse.success === true；comment / decided_by 字段落地 | P0 |
| UC-DECISION-ARTIFACT-003 | approve with custom outputs 后读取 artifact | outputs = { release_note: "ok" } | schema.safeParse.success === true；outputs === { release_note: "ok" } | P1 |
| UC-DECISION-ARTIFACT-004 | schema 校验 `{ decision: "maybe", timestamp: … }` | 手工构造非法记录 | schema.safeParse.success === false | P0 |
| UC-DECISION-ARTIFACT-005 | schema 校验 `{ decision: "approved" }`（缺 timestamp） | 手工构造非法记录 | schema.safeParse.success === false | P0 |
| UC-DECISION-ARTIFACT-006 | schema 校验最小记录 `{ decision: "approved", timestamp: "…" }` | 手工构造合法最小记录 | schema.safeParse.success === true | P0 |
| UC-APPROVERS-DOC-001 | 开发者阅读 `humanGate.ts` / `approve.ts` / `reject.ts` 源码 | 无 | 每个入口点均含"approvers 仅信息用途，MVP 不做身份校验"注释 | P1 |

## Test Mapping

| Test name | Covers use cases | Notes |
| --- | --- | --- |
| `human step timeout_minutes — positive cases > accepts a typical positive integer (10)` | UC-TIMEOUT-001 | RED until Step 2 加 `timeout_minutes` 到 StepBaseSchema |
| `human step timeout_minutes — positive cases > accepts the lower boundary value (1)` | UC-TIMEOUT-002 | RED 同上 |
| `human step timeout_minutes — positive cases > accepts a human step WITHOUT timeout_minutes (field is optional)` | UC-TIMEOUT-003 | GREEN 现在就通过（字段可选） |
| `human step timeout_minutes — positive cases > accepts a human step with timeout_minutes together with approvers/instructions` | UC-TIMEOUT-001 | RED 同上 |
| `human step timeout_minutes — negative cases > rejects timeout_minutes: 0` | UC-TIMEOUT-004 | RED 同上 |
| `human step timeout_minutes — negative cases > rejects a negative timeout_minutes (-5)` | UC-TIMEOUT-005 | RED 同上 |
| `human step timeout_minutes — negative cases > rejects a fractional timeout_minutes (1.5)` | UC-TIMEOUT-006 | RED 同上 |
| `human step timeout_minutes — negative cases > rejects a string timeout_minutes ("10")` | UC-TIMEOUT-007 | RED 同上 |
| `human gate → router integration: approve path > after approve, state.jobs.<job>.outputs contains decision="approved"` | UC-ROUTER-APPROVE-001 | GREEN（P15 已实现） |
| `human gate → router integration: approve path > a router switch expression resolves ${{ steps.gate-merge.outputs.decision }} to "approved"` | UC-ROUTER-APPROVE-002 | GREEN（表达式契约 P13 已提供） |
| `human gate → router integration: reject path > after reject with comment, outputs.decision="rejected" and outputs.comment carries the reason` | UC-ROUTER-REJECT-001 | GREEN（P15 已实现） |
| `human gate → router integration: reject path > a router switch expression resolves ${{ steps.gate-merge.outputs.decision }} to "rejected" and .comment carries the reason` | UC-ROUTER-REJECT-002 | GREEN |
| `human_decision_record artifact schema > recordHumanDecision(approved) produces a schema-conformant artifact with only required fields` | UC-DECISION-ARTIFACT-001 | GREEN；Step 2 会把 schema 迁移到 `src/artifact/humanDecisionRecord.ts` |
| `human_decision_record artifact schema > recordHumanDecision(rejected) with comment and decided_by produces a schema-conformant artifact` | UC-DECISION-ARTIFACT-002 | GREEN |
| `human_decision_record artifact schema > recordHumanDecision(approved) with custom outputs writes outputs field into artifact` | UC-DECISION-ARTIFACT-003 | GREEN |
| `human_decision_record artifact schema > schema rejects an arbitrary decision string` | UC-DECISION-ARTIFACT-004 | GREEN（schema 定义驱动） |
| `human_decision_record artifact schema > schema rejects a record missing the required timestamp field` | UC-DECISION-ARTIFACT-005 | GREEN |
| `human_decision_record artifact schema > schema accepts a minimal record with only decision + timestamp` | UC-DECISION-ARTIFACT-006 | GREEN |

## Test Gaps

- Gap: Router **执行器** (`src/router/executor.ts`) 目前不调用 `resolveExpression`，因此把 `switch: "${{ steps.gate-merge.outputs.decision }}"` 直接喂给 `executeRouterStep` 时会拿到字面串匹配失败。本工作流 tests 通过直接调用 `resolveExpression` 锁死"outputs 可以被表达式解析"这半契约。
  - Action: 记录为独立后续项（例如 `TD-V022-ROUTER-EXPR`）— router 执行器补 expression 展开是 v0.2.2 后续或 v0.3 范围，不在本 slice。
- Gap: `timeout_minutes` 的**运行时超时行为**（触发自动 rejected / 触发 blocked / 上报 timeout 事件等）不在 v0.2.2 scope；本工作流仅锁定 DSL 层预留。
  - Action: 该功能应立独立 workflow，前置条件是 v0.3 规划确认；本 slice 显式列为 out-of-scope 以防 Step 2 顺手实现导致 scope creep。
- Gap: `approve` / `reject` CLI 与 status 展示层的 e2e 测试仍在 `tests/dogfood/human-gate-e2e.test.ts` 归属；本 slice 不触碰。
  - Action: 若 v0.2.2 决定新增运行时 timeout 语义，则需 e2e 补 timeout 场景。当前无 action。
- Gap: `approvers` 语义注释无法直接在测试里断言（注释不影响运行时）。
  - Action: Step 2 review 阶段以 diff 检查 `humanGate.ts` / `approve.ts` / `reject.ts` 是否含约定注释；本 slice 已在 Step 1 一并补上注释以省却 red 循环。

## Step 1 Deliverables

- `tests/workflow/human-step-timeout.test.ts` — 新增 8 用例（7 red / 1 green）。
- `tests/engine/humanGate-router.test.ts` — 新增 4 用例（全部 green，锁定契约）。
- `tests/engine/humanGate.test.ts` — 追加 6 用例（全部 green，锁定 artifact schema）。
- `src/engine/humanGate.ts` — `stepApprovers` 字段追加 JSDoc 注释，明确 MVP 不做身份校验。
- `src/commands/approve.ts` — `decidedBy` 变量上方追加注释，说明 approvers 语义。
- `src/commands/reject.ts` — 同上。

## Step 2 Handover Notes

1. 在 `src/workflow/index.ts` 的 `StepBaseSchema` 中新增：
   ```ts
   timeout_minutes: z.number().int().positive().optional(),
   ```
   并在 `StepDefinition` interface 同步添加字段；无需改动 `Human step field validation` 语义块。
2. 新建 `src/artifact/humanDecisionRecord.ts`，从 `tests/engine/humanGate.test.ts` 中把 `HumanDecisionRecordSchema` 迁移过去并 export；测试改成 `import { HumanDecisionRecordSchema } from "../../src/artifact/humanDecisionRecord.js"`。这样 Step 2 也能在 CLI/status 层复用同一 schema 定义。
3. 不要在 Step 2 顺手实现 `timeout_minutes` 的运行时强制（AD-out-of-scope）。若有需要，写 ADR 或 v0.3 计划另立。
4. Router 执行器 (`src/router/executor.ts`) 补 `resolveExpression` 是独立技术债，本工作流不 in-scope，也不阻塞 Step 2 转 green。
