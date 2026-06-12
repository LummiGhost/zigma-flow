---
phase: p11-skill-pack-refinement
title: Skill Pack Content + Code-change Workflow Refinement
status: frozen
date: 2026-06-12
authority: docs/prd.md §9 §10 §11 §12 §20
project-items: P11.1, P11.2, P11.3
---

# P11 Skill Pack Refinement 开发计划

## 1. 阶段目标

补齐 Skill Pack 内容质量和 code-change workflow 结构，使 `zigma-flow init` 生成的默认模板可用于真实项目 dogfood。

| 项目条目 | 描述 |
|---------|------|
| P11.1 | Skill Pack 内容 — knowledge 文件、prompt 模板、skill.yml functions |
| P11.2 | Skill Pack scripts/checks — collect-diff 实现、报告 schema、forbidden-paths |
| P11.3 | Code-change workflow 定义 — implement 多步、static-check/unit-test 脚本 |

**核心验收标准：**

- `zigma-flow init` 生成 `common-failure-patterns.md` knowledge 文件。
- `coding-guidelines.md` 包含"小步修改"和"禁止修改 state 文件"指导。
- `implement.md` 明确输入、输出、禁止动作、停止条件。
- `review.md` 输出规范明确 approved / rejected / needs_architecture_design 信号语义。
- `summarize.md` 要求输出 `final_summary` 和 `remaining_risks` 字段。
- `skill.yml` functions 部分包含 implement-by-plan 和 review-change 函数定义及输入/输出 schema。
- `collect-diff.ts` 包含可运行的 git diff 实现（非空 placeholder）。
- implement job 包含多步（agent edit + script collect-diff + check check-diff）。
- static-check 和 unit-test job 的 script step run 命令包含真实工具调用模板（非 echo placeholder）。
- 全部现有测试（367 个）继续通过；更新/新增与 P11 相关的测试。

## 2. 前置条件（已满足）

- P9.3 + P10.1-P10.3 完成（PR #22 merged, 367/367 tests）。
- `src/init/templates.ts` 完整实现了 P10 阶段文件集。
- `src/init/index.ts` 写出全部 15 个模板文件。
- `tests/init/init.test.ts` 覆盖了 P10 阶段验收场景（TC-WORKFLOW-1..10）。

## 3. 架构决策

### AD-P11-S-001: 变更范围限于模板层

**决策：** P11.1-P11.3 的全部变更仅触及 `src/init/templates.ts` 和 `src/init/index.ts`，不修改 Engine、Schema、CLI 或其他模块。

**理由：** Skill Pack 内容是模板文件，由 `init` 命令写出到用户项目目录。内容改进不需要任何 Engine 能力变更。

### AD-P11-S-002: implement job 多步实现

**决策：** implement job 增加三步：
1. `id: edit`，`type: agent` — 执行代码修改（expose code skill）
2. `id: collect-diff`，`type: script`，`run: "git diff HEAD"` — 收集 diff 输出
3. `id: check-diff`，`type: check`，`uses: zigma/file-exists`，`with: {file: "."}`，`on_fail: continue` — 校验工作目录

**理由：** multi-step 已由 Engine 支持（`tests/engine/multistep.test.ts`）；script step 使用 inline `run:` 而非 `skill://` URI（与 AD-P10-002 一致）。

注意：TC-WORKFLOW-4 检查 implement job 的 steps[0] 为 agent 类型，多步不破坏该测试。

### AD-P11-S-003: skill.yml functions schema

**决策：** functions 字段添加两个条目：
```yaml
functions:
  - id: implement-by-plan
    description: Execute plan steps to modify code
    inputs:
      plan: { type: string, description: "Implementation plan to execute" }
      context: { type: string, description: "Additional context or constraints" }
    outputs:
      summary: { type: string, description: "Summary of changes made" }
      files_changed: { type: string, description: "List of modified files" }
  - id: review-change
    description: Review code changes for quality and correctness
    inputs:
      diff: { type: string, description: "Git diff of changes to review" }
      plan: { type: string, description: "Original implementation plan" }
    outputs:
      verdict: { type: string, description: "approved or rejected" }
      issues: { type: string, description: "Issues found, if any" }
```

**注意：** TC-WORKFLOW-10 当前断言 `def.functions ?? []).toEqual([])` — 此测试必须随实现同步更新。

### AD-P11-S-004: collect-diff.ts 实现

**决策：** 提供可运行的 git diff 收集实现。脚本输出结构化 JSON 到 stdout，包含 `changed_files` 和 `diff` 字段。使用 `node:child_process` 执行 `git diff HEAD`。这是用户可自定义的模板。

### AD-P11-S-005: static-check / unit-test 占位符策略

**决策：** 将 echo placeholder 替换为注释化的真实命令模板：
- `static-check`: `"echo 'Replace with: pnpm typecheck && pnpm lint' && exit 0"`
- `unit-test`: `"echo 'Replace with: pnpm test' && exit 0"`

这些 run 命令包含真实工具名，方便用户直接启用，同时不会因项目无 pnpm 而导致 init 时崩溃。

## 4. 工作流

### WF-P11-SKILL-PACK

**目标：** 完成 P11.1 + P11.2 + P11.3 全部内容改进。

**变更边界：**
- `src/init/templates.ts` — 7 个函数修改/新增
- `src/init/index.ts` — 添加 `common-failure-patterns.md` 到文件列表

**新增/修改测试文件：**
- `tests/init/init.test.ts` — 追加 8 个 P11 验收用例（T-P11-1..8）

**验收标准：**
见第 1 节"核心验收标准"。

## 5. 质量门禁

`pnpm typecheck && pnpm lint && pnpm test`

## 6. 测试文件规划

| 测试文件 | 新增/修改用例 |
|---------|-------------|
| `tests/init/init.test.ts` | T-P11-1: common-failure-patterns.md 存在 |
| | T-P11-2: coding-guidelines.md 包含"small step"/"state"关键词 |
| | T-P11-3: implement.md 包含"forbidden"/"禁止"/"must not" |
| | T-P11-4: review.md 包含 approved/rejected 输出规范 |
| | T-P11-5: summarize.md 包含 final_summary/remaining_risks |
| | T-P11-6: skill.yml functions 非空，包含 implement-by-plan |
| | T-P11-7: implement job steps 数量 ≥ 3 |
| | T-P11-8: collect-diff.ts 包含 git diff 逻辑（非 placeholder 注释行） |
| | 更新 TC-WORKFLOW-10: functions 断言改为 functions.length ≥ 2 |

## 7. PR 结构

- **PR #23**: WF-P11-SKILL-PACK，branch `feature/p11-skill-pack-refinement`

## 8. 残余风险

| 风险 | 影响 | 应对 |
|------|------|------|
| multi-step implement job 导致 TC-WORKFLOW-4/7 失败 | 现有测试仅检查 steps[0]，不检查步骤总数 | 运行测试验证无回归 |
| functions 字段变更导致 TC-WORKFLOW-10 失败 | 该测试硬断言 functions === [] | 必须同步更新测试 |
| collect-diff.ts 中 git 命令在 CI 环境失败 | 模板脚本为用户侧文件，init 测试不执行脚本内容 | 测试仅验证文件内容包含特定字符串 |
