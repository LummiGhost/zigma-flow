---
phase: p15
title: Human Gate Step
status: proposed
date: 2026-06-27
authority: docs/prd.md §3 §12 §24, docs/mvp-contracts.md §2.1 §2.3 §2.4
predecessor: P13 (PR #89), P14 (PR #90) merged
target-pr: 1
---

# P15 Human Gate Step 开发计划

## 1. 阶段目标

把 PRD §3 中"预留语义"的 `human` step type 落到可用状态：workflow 可以声明 human gate；engine 在 human step 到达时暂停 run，向用户提交决策请求；CLI 提供 `approve`/`reject` 命令；router 可以基于 human decision 分支。

**核心用户场景：** code-change workflow 在 `review` 完成后插入一个 `human` step `gate-merge`，让用户在 PR 合并前手动审批；reject 时把 comments 作为 retry_inputs 打回 implement。

## 2. 前置条件

- P13、P14 已合入 main。
- workflow schema 已经支持 `type: human` 作为 step type 枚举值（v0.1 时只是占位，无 step 级字段校验）。
- `RouterAction` 已有 `retry_job` + `retry_with`，可读取 human step 输出作为 retry inputs。

## 3. 范围与边界

### 3.1 In-scope

| 主题 | 内容 |
|---|---|
| Workflow schema | `human` step 增 `prompt`（必填）、`approvers`（可选 string[]）、`instructions`（可选 string）、`outputs`（可选 mapping）等字段，纳入 zod schema |
| Engine | 进入 human step 时不直接执行：写 `human_gate_waiting` 事件，置 step 状态为 `awaiting_human`、job 状态为 `running`（仍占用 writable 锁如适用） |
| CLI | 新增 `zigma-flow approve --job <id> [--step <id>] [--comment <c>] [--output key=value]` 和 `zigma-flow reject --job <id> [--step <id>] --comment <c>` |
| Decision artifact | 决策写入 `human_decision_record` artifact（含 decision、comment、decided_by、timestamp） |
| Engine 接受决策 | 新引擎入口 `recordHumanDecision`，写 `human_decision` 事件、step.outputs.decision/comment、调用既有 advanceJob 或 applyRoutingAction 推进 |
| run-all 行为 | 遇到 awaiting_human 的 step 时退出主循环并打印明确指引（命令、step id、artifact 路径）；不算 failed，exit code 0；可用 `--resume` 继续 |
| status 展示 | `zigma-flow status` 在 ready/running 列表外新增 "Awaiting human" 段，标 step id 与 prompt 摘要 |
| Router 集成 | router switch 可读 `${{ steps.<human-step-id>.outputs.decision }}` 和 `.comment`，配合 retry_with 把 comment 注入下游 job |
| 内置 workflow 模板 | 在 `code-change.yml` 中新增可选 `gate-merge` human step，作为示范；通过 `activation: optional` + `optional_needs` 控制默认不启用 |
| 文档 | architecture.md §6 / §7 增 human gate 章节；README 加用例；mvp-contracts.md §2.4 加 `human_gate_waiting` + `human_decision` 事件 |

### 3.2 Out-of-scope

- Web UI / 邮件 / Slack 等远程审批渠道（v0.3+ 范围）。
- 多审批人投票 / 法定人数。
- 决策超时自动失败（可作 v0.3 stretch）。
- 自动 PR 创建 / 合并（v0.3+ PR 集成）。
- 决策签名 / 审计加密。
- 允许 `human` step 在 read-only job 中"自动判定"（始终需要人决策）。

## 4. 架构决策

### AD-P15-001 — 新增 step 状态 `awaiting_human`

**决策：** 扩展 step 状态枚举：`pending → running → completed | failed | skipped | retrying`（PRD §FR-005）+ v0.2 新增 `awaiting_human`。

合法转换：

```
pending → awaiting_human   (进入 human step)
awaiting_human → completed (approve)
awaiting_human → failed    (reject 且 router 未声明 retry_job)
awaiting_human → cancelled (Ctrl-C / abort)
```

job 状态：human step 等待期间 job 保持 `running`。这与 agent step 等待 backend 返回的语义对齐。

**理由：** 不引入新的 job 状态可降低对 P13/P14 写者锁、scheduler 的影响（writable lock 仍按 job.status="running" 判断）。

**修订：** mvp-contracts.md 第 5 节、PRD §FR-005 在 v0.2 文档同步时新增 `awaiting_human` step 状态注释。

### AD-P15-002 — `human` step schema

**决策：** workflow schema 中 `human` step 字段：

```yaml
- id: gate-merge
  type: human
  prompt: |
    Review the implementation summary and approve before merging.
  instructions: |
    使用 `zigma-flow approve --job gate-merge` 推进；
    使用 `zigma-flow reject --job gate-merge --comment "原因"` 打回。
  approvers: []          # 仅做提示用，MVP 不校验
  outputs:
    decision: human.decision   # 默认就是这个，可选自定义路径
    comment: human.comment
```

约束：

- `prompt` 必填，非空字符串。
- `approvers` 可选 string[]；MVP 仅作展示，不校验调用者身份。
- `outputs` 可选，默认 `{decision: "human.decision", comment: "human.comment"}`，用法与现有 outputs mapping 一致。
- 不允许 `expose` / `uses` / `run` 字段（schema 拒绝）。

### AD-P15-003 — `awaiting_human` 进入路径

**决策：** runAll 主循环（P13 已搬到 engine）在挑出 human step 时不调用 backend 也不调用 executeCurrentStep；而是调用新 engine 入口：

```ts
export async function enterHumanGate(opts: {
  runDir: string;
  runId: string;
  jobId: string;
  stepId: string;
  clock: Clock;
}): Promise<void>;
```

行为：

1. 写 `human_gate_waiting` 事件（payload: prompt, approvers, instructions, step_artifact_dir）。
2. 置 step 状态 `awaiting_human`，job.status 维持 `running`，state.last_event_id 更新。
3. 写一份 `human-gate.md` artifact（kind=`human_gate_request`），内容是 prompt + instructions + 引用的上游 outputs 摘要，方便用户读。

runAll 收到 `awaiting_human` 后跳出主循环并打印 next-step 指引。

### AD-P15-004 — CLI approve / reject

**决策：** 新增两个 CLI 命令：

```pwsh
zigma-flow approve --job <id> [--step <id>] [--comment <text>] [--output key=value]...
zigma-flow reject  --job <id> [--step <id>] --comment <text>
```

- `--step` 可省略：active run 中如果该 job 只有一个 awaiting_human step，自动定位。
- `--comment` approve 可选、reject 必填。
- `--output key=value` 可重复，写入 step.outputs 自定义字段（必须在 workflow step.outputs 中声明）。
- 命令读取 active run（与既有 `status` 一致），找到 job 的当前 awaiting_human step，调用 `recordHumanDecision`。

互斥/错误路径：

- 没有 awaiting_human step → UserInputError exit 2，建议 `status`。
- 同 job 多个 awaiting_human → 要求显式 `--step`。
- step 状态不是 `awaiting_human` → StateError exit 1。

### AD-P15-005 — `recordHumanDecision` engine 入口

**决策：** 新建 `src/engine/humanGate.ts`：

```ts
export interface RecordHumanDecisionOpts {
  runDir: string;
  runId: string;
  jobId: string;
  stepId: string;
  decision: "approved" | "rejected";
  comment?: string;
  outputs?: Record<string, string>;
  decidedBy?: string;   // process.env.USER / USERNAME (best-effort)
  clock: Clock;
}

export async function recordHumanDecision(opts: RecordHumanDecisionOpts): Promise<void>;
```

行为：

1. 校验 state 中该 step 是 `awaiting_human`。
2. 写 `human_decision_record` artifact。
3. 写 `human_decision` 事件（payload: decision, comment, decided_by, outputs）。
4. step.outputs 写入 `decision`、`comment` 及调用方自定义 outputs。
5. step.status：
   - approved → `completed`，调用 `advanceJob` 推进。
   - rejected → `failed`，若紧随其后有 router 处理决策则不直接 fail job，由 router 决定（与 agent_report_accepted 处理 signal 的模式一致）。
6. 如果是 rejected 且 step 之后没有 router → job.status = `failed`，写 step_failed + 走既有 failed 路径。

### AD-P15-006 — Router 读取 human outputs

**决策：** 不改 router 实现；human step.outputs 写完之后，下一步 router 的 `switch: "${{ steps.gate-merge.outputs.decision }}"` 自然解析。

**前置条件已在 P13 完成：** `${{ steps.<id>.outputs.<key> }}` 表达式（原 TD-P9-002）由 P13 WF-VARIABLES 中的表达式扩张一并清偿。P15 不再需要单独工作流处理表达式问题；如 P13 未按计划清偿，P15 必须先补这一项。

### AD-P15-007 — run-all 行为

**决策：** runAll 遇到 awaiting_human：

- 跳出主循环，**不**置 run.status 为 blocked（仍是 running）。
- 退出码 0，打印：

```
Run 20260627-0001 paused on human gate.
  Job: review-merge / Step: gate-merge

To approve:
  zigma-flow approve --job review-merge --comment "..."

To reject and retry implement:
  zigma-flow reject --job review-merge --comment "..."

Then resume:
  zigma-flow run-all --resume 20260627-0001
```

`--resume`（P13 引入）可直接接续。

**理由：** awaiting_human 不是失败，不应触发 CI 失败语义；exit 0 是符合"等待人工"语义的合理选择。

### AD-P15-008 — status 显示

**决策：** `zigma-flow status` 输出新增段：

```
Awaiting human input:
  review-merge / gate-merge
    Prompt: Review the implementation summary and approve before merging.
    Approvers: (anyone with project access)
    Decide with: zigma-flow approve --job review-merge | reject --job review-merge --comment "..."
```

当多个 awaiting_human step 时按出现顺序列出。

## 5. 工作流拆分

### WF-P15-SCHEMA

**目标：** AD-P15-002 — workflow schema 支持 human step 字段。

**边界：** `src/workflow/schema.ts` 增 human step 子 schema；`src/workflow/index.ts` 校验；fixture 增 valid/invalid human step 例。

**验收：**

- 单测：缺 prompt → ValidationError；包含 expose → ValidationError；approvers 非数组 → ValidationError。
- 既有 workflow 不破坏。

### WF-P15-ENGINE

**目标：** AD-P15-001、AD-P15-003、AD-P15-005 — engine 进入/接受 human gate。

**边界：** 新增 `src/engine/humanGate.ts`，`enterHumanGate` + `recordHumanDecision`；step 状态枚举扩展；runAll 路由到 enterHumanGate。

**验收：**

- 单测：进入 human step → awaiting_human + 事件 + artifact；
- 单测：approve → completed + advanceJob；reject → step.outputs.decision = "rejected"，下游 router 触发 retry_job 时携带 comment。
- 单测：在 awaiting_human 再次 enterHumanGate（幂等）不重复事件。
- 已存在 v0.1/v0.2 测试零回归。

### WF-P15-CLI

**目标：** AD-P15-004、AD-P15-007、AD-P15-008 — CLI 命令 + status + run-all 协作。

**边界：** 新增 `src/commands/approve.ts`、`src/commands/reject.ts`；改 `src/commands/status.ts`；改 `src/engine/runAll.ts` 识别 awaiting_human。

**验收：**

- E2E：用 fake backend 跑 workflow 至 human gate，调用 `approve`，run 继续到完成；
- E2E：跑到 human gate，`reject --comment "..."`，router 把 comment 注入 implement retry_inputs，attempt 2 含 review_comments；
- `zigma-flow approve` 在没有 active run / 没有 awaiting_human 时给出可执行建议（提示用户跑 status）。

### ~~WF-P15-EXPR~~（已移交 P13）

`${{ steps.<id>.outputs.<key> }}` 表达式（TD-P9-002）在 P13 WF-VARIABLES 中一并清偿，因为 P13 的 `goto_step` 与 `step.if` 同样依赖该能力。P15 不再单独立工作流。

如 P13 在合入时未按计划清偿，P15 必须在 WF-P15-CLI 前补这一项；否则可直接复用 P13 引入的 expression 求值。

### WF-P15-WORKFLOW-TEMPLATE

**目标：** 内置 code-change workflow 增可选 human gate 示范 + 测试更新。

**边界：** `src/init/templates.ts` 增可选 `gate-merge` step；默认 `activation: optional`；`tests/init/init.test.ts` 补对应断言。

**验收：**

- `zigma-flow init` 生成的 workflow 含 gate-merge 但默认不激活；
- 文档说明如何启用。

## 6. 工作流依赖与提交顺序

```
WF-P15-SCHEMA
   └─ WF-P15-ENGINE
       └─ WF-P15-CLI
           └─ WF-P15-WORKFLOW-TEMPLATE
```

合入 **PR #91（feature/p15-human-gate）**。`steps.<id>.outputs.<key>` 表达式（原 WF-P15-EXPR）由 P13 完成，P15 直接依赖。

## 7. 测试规划

| 文件 | 新增/扩展 | 主题 |
|---|---|---|
| `tests/workflow/human-step.test.ts` | 新增 | schema 校验 |
| `tests/engine/humanGate.test.ts` | 新增 | enterHumanGate / recordHumanDecision |
| `tests/engine/runAll-humanGate.test.ts` | 新增 | runAll 暂停与 resume 互动 |
| `tests/commands/approve.test.ts` | 新增 | CLI approve |
| `tests/commands/reject.test.ts` | 新增 | CLI reject |
| `tests/commands/status.test.ts` | 扩展 | status 显示 awaiting human |
| `tests/init/init.test.ts` | 扩展 | 内置 gate-merge 模板 |
| `tests/dogfood/human-gate-e2e.test.ts` | 新增 | 完整 approve/reject 流 |

预计净增 ~35 测试用例。

## 8. 质量门禁

```pwsh
pnpm typecheck
pnpm lint
pnpm test:ci
```

新增 CLI 命令需要在 `tests/cli/help.test.ts` 中补 help 文案断言（如有该文件）。

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 引入 step 状态破坏外部消费者 | 低 | state 只供本工具读写；schema 标 "additive"；mvp-contracts 同步说明 |
| reject 与 router 结合复杂，回归点多 | 高 | WF-P15-ENGINE 提供纯 engine 单测；含 router 的 e2e 依赖 P13 已落地的 `steps.<id>.outputs.<key>` 表达式 |
| run-all 退出 0 引起 CI 误判 "通过" | 中 | 文档显式说明 awaiting_human 非终态；外部 CI 用 `status` 或 `run-completed` 事件判定 |
| approve/reject 不校验调用者身份 | 低（MVP 设计） | 文档明确"approvers 字段当前仅提示"，未来用 git config user.email 增强 |
| 多 awaiting_human step 并发（P14 并发 read-only 不应包含 human） | 中 | scheduler 中 human step 视同 writable（占写者锁），同时最多 1 个 awaiting_human；写入 AD-P14 修订 |
| Resume 时 human step 已经被外部 approve（race） | 低 | enterHumanGate 是幂等的；CLI approve 在状态非 awaiting_human 时报错 |

## 10. 技术债清偿映射

| 技术债 ID | 清偿位置 |
|---|---|
| TD-P9-002（steps.<id>.outputs.<key> 表达式） | ~~WF-P15-EXPR~~ → 已移交 P13 WF-VARIABLES |

## 11. 技术债登记（带到 v0.3）

| 技术债 ID | 描述 | 计划清偿 |
|---|---|---|
| TD-P15-001 | approvers 字段不校验调用者身份 | v0.3 引入 git config / 环境变量身份 |
| TD-P15-002 | 无审批超时 | v0.3 timeout policy |
| TD-P15-003 | 决策渠道仅 CLI；无邮件 / 远程 | v0.3+ PR 集成或邮件 |

## 12. PR 结构

- **PR #91（feature/p15-human-gate）**
  - branch from origin/main (要求 P13 + P14 已 merge)
  - PR 描述附：新增 step type / event / artifact / CLI 命令清单；内置 workflow 改动说明；TD-P9-002 清偿。
  - 关联 GitHub Project P15 条目。

## 13. v0.2 收尾

PR #91 merge 后即可：

- 打 `v0.2.0` tag。
- 撰写 `docs/release-notes/v0.2.0.md`（或在 GitHub Release 描述），覆盖 P13/P14/P15 变更概览。
- 更新 `package.json` version 至 `0.2.0`。
- 关闭 v0.2 GitHub Milestone（若已建）。
