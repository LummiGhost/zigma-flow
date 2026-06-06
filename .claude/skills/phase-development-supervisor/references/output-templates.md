# Output Templates

在创建阶段文档时，优先沿用下面的目录结构和模板。可以按项目习惯调整路径，但要保持编号稳定，方便主管与 subagent 协作。

## 交付物归宿规则

| 交付物 | 归宿 | 说明 |
|---|---|---|
| 阶段开发计划 / 启动阻塞说明 | **markdown 文件**（仓库） | 设计与决策产物，长期有效 |
| 预研报告 | **markdown 文件**（仓库） | 决策产物，长期有效 |
| 工作流用例文档（Step 1） | **markdown 文件**（仓库） | 测试设计，长期有效 |
| Step 1 → Step 2 架构审阅记录 | **markdown 文件**（仓库） | 架构决策，长期有效 |
| 规范偏差扫描报告 | **markdown 文件**（仓库） | 分析产物，长期有效 |
| 实现报告（每轮） | **PR 评论** | 进度产物；不得单独提交为 markdown 文件或独立 PR |
| 验收报告（每轮） | **PR 评论** | 进度产物；不得单独提交为 markdown 文件或独立 PR |
| 修复报告 | **PR 评论** | 进度产物；不得单独提交为 markdown 文件或独立 PR |
| 总验收报告 | **收尾 PR description 或 GitHub Project 条目** | 进度产物 |
| 阶段工作报告 | **收尾 PR description 或 GitHub Project 条目** | 进度产物 |
| 工作流实时状态表 | **GitHub Projects** | 不在本地维护 `00-phase-index.md` |

## Suggested Layout（仓库内 markdown 文件）

```text
docs/phases/<phase-slug>/
  01-readiness-review.md
  02-development-plan.md
  research/
    <topic>.md
  workflows/
    <workflow-id>/
      01-cases-and-tests.md
      01-step1-architecture-review-<date>.md   ← UI workflows only; required before Step 2
      spec-deviation-scan.md                   ← only when a spec deviation scan is executed
```

## 1. Readiness Review

用于"不能启动开发"的结论文档，或作为 readiness 审查记录。

```md
# <Phase Name> Readiness Review

## Inputs
- Source documents:
- Related design materials:
- Current code constraints:

## Stage Goal
- Goal:
- Milestones:
- Acceptance criteria:

## Boundary
- In scope:
- Out of scope:
- External dependencies:

## Findings
| ID | Type | Description | Impact | Blocking |
| --- | --- | --- | --- | --- |

## Decision
- Ready for development: Yes / No
- Reason:

## Required Follow-up
- Item:
- Owner suggestion:
- Exit condition:
```

## 2. Development Plan

用于"可以启动开发"的主文档。预研结束后在同一文档中追加冻结信息。

```md
# <Phase Name> Development Plan

## Objective
- Business objective:
- Technical objective:

## Scope
- In scope:
- Out of scope:

## Milestones
| Milestone | Description | Exit criteria |
| --- | --- | --- |

## Technical Approach
- Architecture and module changes:
- Data/API changes:
- Testing strategy:
- Release or migration notes:

## Workflow Breakdown
| Workflow | Goal | Dependencies | Acceptance criteria | Research needed |
| --- | --- | --- | --- | --- |

## Risks And Mitigations
| Risk | Probability | Impact | Mitigation | Owner |
| --- | --- | --- | --- | --- |

## Quality Bar
- Required automated tests:
- Required manual checks:
- Performance / reliability constraints:
- Documentation updates:

## Open Decisions
| Decision | Options | Research task | Due trigger |
| --- | --- | --- | --- |

## Freeze Record
- Plan status: Draft / Frozen
- Frozen at:
- Final decisions:
- Residual risks:
```

## 3. Research Report

每个待预研主题单独一份。

```md
# Research Report: <Topic>

## Question
- Decision to make:
- Constraints:

## Options Evaluated
| Option | Pros | Cons | Validation evidence |
| --- | --- | --- | --- |

## Recommendation
- Chosen option:
- Why:
- Rejected options:

## Risks
- Risk:
- Suggested mitigation:

## Next Action
- Plan update required:
- Implementation implication:
```

## 4. Workflow Cases And Tests

```md
# <Workflow Name> Cases And Tests

## Slice Boundary
<!-- 必填；主管在派发 Step 1 前预填；subagent 在 Step 1 开始时确认 -->
- Slice name:
- Bounded context this slice belongs to:
- User tasks covered (最多 3 条):
  1. 用户可完成…
- Planned test files (最多 2 个):
  - <test-file-1>.test.ts
- UX expectations source: <wireframe path / "product description: …" / "not provided — risk logged">

<!-- 如果用户任务超过 3 条或计划测试文件超过 2 个，STOP：此 slice 需要先拆分，不允许继续 -->

## Workflow Goal
- Goal:
- Acceptance criteria:
  - (面向用户的工作流) 用户可完成 <操作>：<验证方式>
  - (技术工作流) <技术断言>

## Spec Compliance Matrix
<!-- 若本工作流对应上位设计规范，逐条列出 MUST/SHALL 条款。面向用户且有设计规范的工作流必填。 -->
| 条款 ID | 规范来源 | 条款内容摘要 | 实现状态 | 备注 |
| --- | --- | --- | --- | --- |
| SPEC-§X.Y-01 | 规范 §X.Y | <强制条款内容摘要> | 已纳入本工作流 | — |
<!-- 实现状态取值：已纳入本工作流 / 计划外（技术债 TD-xxx）/ 规范不适用 -->

## Functional Points
- Point:

## Use Cases
| ID | Scenario | Preconditions | Expected result | Priority |
| --- | --- | --- | --- | --- |

## Test Mapping
| Test name | Covers use cases | Notes |
| --- | --- | --- |

## Test Gaps
- Gap:
- Action:
```

## 5. Implementation Report

> **交付方式：** 以 PR 评论形式提交到当前工作流所在 PR，不得单独创建 markdown 文件或独立 PR。

```md
# <Workflow Name> Implementation Report (Round <n>)

## Planned Work
- Items:

## Delivered
- Completed:
- Deferred:

## Code And Tests
- Files/modules touched:
- Tests added or updated:
- Test result summary:

## Risks / Follow-ups
- Risk:
- Follow-up:
```

## 6. Workflow Acceptance Report

> **交付方式：** 以 PR 评论形式提交到对应 PR，不得单独创建 markdown 文件或独立 PR。

```md
# <Workflow Name> Acceptance Report (Round <n>)

## Acceptance Inputs
- Acceptance criteria:
- Evidence reviewed:
- Spec compliance matrix source: (Step 1 doc path)

## Spec Compliance Check
<!-- 面向用户的工作流或有规范强制条款矩阵的工作流必填 -->
| 条款 ID | 规范来源 | 实现状态（Step 1 声明） | 本次验收核查结果 | 阻塞项 |
| --- | --- | --- | --- | --- |

## Usability Check
<!-- 面向用户的工作流必填；技术工作流留空 -->
| 里程碑（用户可完成…） | 验证方式 | 截图/录屏链接 | 规范对照结论 | 通过/不通过 |
| --- | --- | --- | --- | --- |

## Integration Verification
<!-- 有集成要求的工作流必填；纯后端/数据层工作流填 N/A -->
| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| 组件已在目标应用中消费（import + render） | Pass / Fail / N/A | import 路径或技术债登记 ID |
| 用户里程碑可演示（≥1 条可端到端走通） | Pass / Fail / N/A | 测试路径或手工走查记录 |

## Result
- Status: Pass / Fail
- Summary:

## Findings
| ID | Severity | Description | Blocking | Suggested fix |
| --- | --- | --- | --- | --- |

## Decision
- Next step:
- Rework required:
- Human intervention required:
```

## 7. Final Acceptance Report

> **交付方式：** 写入收尾 PR 的 description 或 GitHub Project 对应条目，不得单独创建 markdown 文件或独立 PR。

```md
# <Phase Name> Final Acceptance

## Scope Reviewed
- Workflows covered:
- Exclusions:

## Technical Gate Results
| Gate | Status | Notes |
| --- | --- | --- |
| typecheck | Pass / Fail | |
| lint | Pass / Fail | |
| test:ci | Pass / Fail | |
| smoke | Pass / Fail | |

## Spec Compliance Summary
<!-- 汇总各工作流规范强制条款矩阵的最终状态 -->
| 条款 ID | 规范来源 | 最终实现状态 | 技术债登记 |
| --- | --- | --- | --- |

## Product Track Result
<!-- 面向用户的阶段必填 -->
- 中途产品审阅时间：
- 最终产品审阅时间：
- 产品轨结论：Pass / Fail / Not applicable
- 主要问题（如有）：

## Design Source Verification
<!-- 面向用户的阶段必填；逐项对照原始设计规范（非派生文档） -->
| 原始设计规范 | 对照维度 | 规范定义摘要 | 实现截图匹配 | 偏差说明 |
| --- | --- | --- | --- | --- |
| <原始设计规范> §X.Y | <信息架构 / 导航结构 / 交互流程 / 领域语言> | | | |

此项不可由派生文档对照替代。对照结论写入 Phase Outcome 章节。

## Phase Outcome
- Goals achieved:
- Goals missed:
- Milestones met:

## Quality And Risk Review
- Test posture:
- Known defects:
- Residual risks:
- Technical debt registered:

## Final Decision
- Pass / Fail:
- Ready for next phase / release:
- Required repairs:
```

## 8. Phase Report

> **交付方式：** 写入收尾 PR 的 description 或 GitHub Project 对应条目，不得单独创建 markdown 文件或独立 PR。

```md
# <Phase Name> Phase Report

## Summary
- Stage objective:
- Final result:

## Deliverables
| Workflow | Output | Status |
| --- | --- | --- |

## Key Decisions
| Decision | Final choice | Why it was chosen |
| --- | --- | --- |

## Risks And Debt
- Remaining risk:
- Technical debt:

## Demo
- Demo entry:
- Demo notes:

## Recommended Next Actions
- Action:
```

## 9. Step 1 → Step 2 Architecture Review

用于 UI 工作流 Step 1 完成后、Step 2 启动前的主管架构审阅。命名建议：`<workflow-id>/01-step1-architecture-review-<date>.md`。

```md
# <Workflow Name> Step1 Architecture Review

- Date:
- Reviewer: phase-development-supervisor
- Step1 document: <path>
- Verdict: PASS / FAIL

## Check Results

| # | Check | Result | Finding |
| --- | --- | --- | --- |
| 1 | Module responsibility — each module has exactly one concern | PASS / FAIL | |
| 2 | State layering — UI interaction / draft view model / domain command result / runtime cache distinguishable | PASS / FAIL | |
| 3 | Test boundary — per-module test files; no single whole-page test file | PASS / FAIL | |
| 4 | Domain command mapping — every user action maps to a named command in a declared bounded context | PASS / FAIL | |
| 5 | Cross-workflow coupling — shared components planned as independent slices first | PASS / FAIL | |

## Required Revisions (if FAIL)

- Item:
- Required change:
- Re-review trigger:

## Decision

- PASS → dispatch Step 2 implementation subagent
- FAIL → revise Step 1 document, then re-review before Step 2
```
