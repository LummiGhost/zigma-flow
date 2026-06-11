---
phase: p10
title: Built-in code-change Workflow Refinement
status: frozen
date: 2026-06-11
authority: docs/prd.md §20 (阶段10)
tech-debt-resolved: TD-P10-ACCEPT-ADVANCE
---

# P10 阶段开发计划

## 1. 阶段目标

P10 完成 Zigma Flow 第一个可用于真实 dogfood 的内置工作流：code-change Skill Pack + workflow。
让用户可以通过 `zigma-flow init` 获得完整的代码变更工作流骨架，并能走通全流程。

**PRD 对应：** §20 "阶段10：内置 code-change Workflow 打磨"

**核心验收标准：**
- 完整走通：intake → code-map → risk-scan → plan → [architecture-design] → implement → static-check → unit-test → review → summarize
- Agent 每步只能看到该步所需的 Skill Pack 内容（不读完整复杂 Skill）
- script/check step 接管 static-check、unit-test 确定性流程
- review rejected 信号能打回 implement（retry_job）
- optional architecture-design 可被 plan/review 发出的信号激活

## 2. 前置条件（已满足）

- P9 完成（PR #17 + #18 merged, main CI pass, 332 tests）
- `acceptAgentReport` 存在，处理信号并调用 `applyRoutingAction`
- `applyRoutingAction` 支持 retry_job / activate_job / goto_job / continue / fail / block
- `advanceJob` 存在，处理多步推进和 job_completed
- Signal 声明支持 `allowed_from` 和 `action` 字段（SignalDeclaration 类型）
- `init` 命令已有 code-change 骨架模板（但需要完全重写）

## 3. 前置设计决策

### AD-P10-001: 工作流只使用已实现的表达式特性

P10 workflow YAML 只使用：`${{ inputs.* }}`、`${{ run.* }}`、`${{ retry.inputs.* }}`。

不依赖未实现的 `${{ jobs.<id>.outputs.<key> }}`（TD-P9-001）或 `${{ steps.<id>.outputs.<key> }}`（TD-P9-002）。

**跨 Job 数据流通过 artifact 文件传递：** 每个 Agent Step 将结果写入标准 artifact 路径，后续 step 从 past artifacts 中读取。

### AD-P10-002: Script step 使用内联 `run:` 命令

不依赖 TD-P8-003（Skill Pack `uses:` 解析），所有 script/check step 使用内联 `run:` 或 `kind:` 字段。

### AD-P10-003: acceptAgentReport 信号路径需修复 source job 推进

**当前 bug（P9 遗留）：** `acceptAgentReport` 在信号路径中调用 `applyRoutingAction(retry_job/activate_job)` 后直接 return，source job 停留在 "running" 状态，无法通过任何命令推进到 terminal state。

**修复方案（WF-P10-ENGINE-FIX）：** 在信号路径的 `applyRoutingAction` 调用之后，如果 action 是 object-form 的路由动作（retry_job / activate_job），额外调用 `advanceJob(sourceJobId)` 将 source job 推进到 completed。

注意：`continue` 已在 `applyRoutingAction` 内部调用 `advanceJob`；`fail`/`block` 已将 source job 设为终态，`advanceJob` 是幂等空操作。`goto_job` 已在 `applyRoutingAction` 内完成 source job。仅 retry_job 和 activate_job 需要额外调用。

### AD-P10-004: architecture-design 是 optional job

workflow 声明：
```yaml
architecture-design:
  activation: "manual"
  needs: [plan]
```

`implement` 有 `optional_needs: [architecture-design]`，保证若 arch-design 被激活则 implement 等待其完成。

信号 `needs_architecture_design` 的 action 为 `activate_job: architecture-design`，allowed_from: [plan, review]。

### AD-P10-005: review rejected → retry implement

信号 `review_rejected` 的 action 为 `retry_job: implement`，allowed_from: [review]。

`implement` job 配置 `retry: { max_attempts: 3, on_exceeded: { status: failed } }`。

## 4. P10 工作流拆分

### WF-P10-ENGINE-FIX：修复信号路径的 source job 推进

**目标：** 在 `acceptAgentReport` 信号路径中，对 retry_job 和 activate_job 动作追加 `advanceJob` 调用，使 source job 能正确推进到 completed。

**边界：** 只修改 `src/engine/accept.ts`。新增测试 T-ACCEPT-14、T-ACCEPT-15。不影响其他执行路径。

**验收标准：**
- T-ACCEPT-14：review job 提交含 retry_job 信号的 report → source job (review) 变为 completed，target job (implement) 变为 ready（attempt++）
- T-ACCEPT-15：plan job 提交含 activate_job 信号的 report → source job (plan) 变为 completed，architecture-design job 变为 ready/waiting
- 现有 T-ACCEPT-1..13 全部通过

### WF-P10-WORKFLOW：完善 code-change workflow + Skill Pack templates

**目标：** 重写 `src/init/templates.ts` 中的所有模板函数，实现完整的 code-change workflow YAML 和 Skill Pack 内容文件。

**workflow YAML 结构（10 jobs）：**

```
intake
  └── code-map (needs: intake)
        └── risk-scan (needs: code-map)
              └── plan (needs: risk-scan)
                    ├── architecture-design [optional] (needs: plan)
                    └── implement (needs: plan, optional_needs: architecture-design)
                          ├── static-check (needs: implement)
                          ├── unit-test (needs: implement)
                          └── review (needs: static-check, unit-test)
                                └── summarize (needs: review)
```

**每个 job 的 step 设计：**
- intake: 1 agent step（读 inputs.task，输出 intake-summary artifact）
- code-map: 1 agent step（分析代码结构，输出 code-map artifact）
- risk-scan: 1 check step（json-schema 检查 code-map artifact 格式）
- plan: 1 agent step（制定计划，输出 plan artifact；可发 needs_architecture_design 信号）
- architecture-design: 1 agent step（可选，输出 arch-design artifact）
- implement: 1 agent step（实现代码，有 retry 配置）
- static-check: 1 script step（`run: pnpm typecheck && pnpm lint`，`on_failure: fail`）
- unit-test: 1 script step（`run: pnpm test:ci`，`on_failure: fail`）
- review: 1 agent step（审阅，可发 review_rejected 信号）
- summarize: 1 agent step（输出总结 artifact）

**Skill Pack 内容（写入 templates.ts）：**
- `skill.yml`：更新 exports，移除不支持的 uses: 引用
- `knowledge/workflow-guide.md`：工作流执行指南（每步怎么写 report.json）
- `knowledge/coding-guidelines.md`：已有，无需大改
- `prompts/intake.md`、`prompts/code-map.md`、`prompts/plan.md`、`prompts/implement.md`、`prompts/review.md`、`prompts/summarize.md`
- `checks/report-schema.json`：已有，确认格式正确

**边界：** 只修改 `src/init/templates.ts`；更新 `tests/init/init.test.ts` 以验证新文件列表正确。不修改 engine 代码。

**验收标准：**
- `zigma-flow init` 成功创建所有预期文件
- 创建的 workflow YAML 通过 `zigma-flow validate` 校验
- init 测试全部通过

### WF-P10-README：用户文档

**目标：** 写 `README.md` 包含：安装、初始化、运行工作流、各 CLI 命令、信号流程图、FAQ。

**边界：** 只新增 `README.md`。不修改源码。

**验收标准：**
- README 涵盖 init → run → prompt → step → next 的完整操作路径
- 有 code-change workflow 的 job 依赖图说明
- 有 review rejected / architecture-design 信号激活的操作说明

### WF-P10-DOGFOOD：端到端冒烟测试

**目标：** 在一个测试目录中完整跑通 code-change workflow，记录执行过程和问题。

**执行步骤：**
1. 在临时目录运行 `zigma-flow init`
2. 运行 `zigma-flow run code-change --task "Add a hello function to src/hello.ts"`
3. 对每个 agent step：生成 prompt，构造最小 report.json，运行 `next`
4. 对 script/check step：运行 `step`
5. 验证最终 state.json 和 events.jsonl 正确

**边界：** 不涉及真实 Claude 调用，用预构造的 report.json 模拟 Agent。

**验收标准：**
- 完整走通 10 个 job
- review_rejected 信号打回 implement 并重试（attempt 2）
- 最终 all jobs completed / summarize completed
- 记录在 docs/phases/p10-code-change-workflow/dogfood-report.md

## 5. 工作流依赖关系

```
WF-P10-ENGINE-FIX ──────────────────────────────┐
WF-P10-WORKFLOW ──────────────────────────────── ── PR #19
                                                 │
WF-P10-README ──────────────────────────────────── PR #20
WF-P10-DOGFOOD (依赖 PR #19 merged) ────────────── PR #20
```

WF-P10-ENGINE-FIX 和 WF-P10-WORKFLOW 可并行开发，合入 PR #19。
WF-P10-README 和 WF-P10-DOGFOOD 在 PR #19 merge 后开发，开 PR #20。

## 6. 技术债登记（遗留至 P11）

| 技术债 ID | 描述 | 来源 |
|-----------|------|------|
| TD-P9-001 | `${{ jobs.<id>.outputs.<key> }}` 表达式 | 延续 |
| TD-P9-002 | `${{ steps.<id>.outputs.<key> }}` 表达式 | 延续 |
| TD-P8-001 | Router expression language（复杂条件） | 延续 |
| TD-P8-003 | Skill Pack `uses:` router resolution | 延续 |

## 7. 质量门禁

`pnpm typecheck && pnpm lint && pnpm test:ci`
每条工作流 Step 2 完成后必须通过此门禁再提交实现报告。

## 8. 测试文件规划

| 工作流 | 新增/修改测试文件 |
|--------|-----------------|
| WF-P10-ENGINE-FIX | `tests/engine/accept.test.ts`（追加 T-ACCEPT-14、T-ACCEPT-15） |
| WF-P10-WORKFLOW | `tests/init/init.test.ts`（更新 file list 断言） |

## 9. PR 结构

- **PR #19**：WF-P10-ENGINE-FIX + WF-P10-WORKFLOW，branch `feature/p10-workflow-polish`
- **PR #20**：WF-P10-README + WF-P10-DOGFOOD，branch `feature/p10-readme-dogfood`
