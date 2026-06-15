---
phase: p12-integration-quality
title: P12.3 DogFood 执行手册
status: active
date: 2026-06-15
run_id: 20260615-0003
task: 将 prompt 重构为外部可扩展提示词模板 + 自动扫描模式
---

# P12.3 DogFood 执行手册

## 目标

用 zigma-flow **自身** 的 code-change 工作流完成以下真实代码变更任务：

> **将 zigma-flow 的 prompt 生成重构为外部可扩展提示词模板 + 自动扫描模式**

当前 prompt 模板硬编码在 `src/init/templates.ts` 中。目标是将其提取为外部文件（加载自磁盘），
并实现 auto-scan（运行时自动发现模板文件），使 Skill Pack 可以覆盖或扩展 prompt 内容。

---

## 环境

| 项目 | 值 |
|------|-----|
| 工作目录 | `D:\zigma\zigma-flow` |
| Run ID | `20260615-0003` |
| 工作流 | `code-change` (`.zigma-flow/workflows/code-change.yml`) |
| CLI | `node dist/cli.js` (已构建) |

---

## 预 DogFood 发现（已修复）

在启动前发现并修复了以下问题。记录于此作为 P12.3 的 P0 发现：

### DF-P0-001：任务描述未传递给 agent 步骤

**问题**：workflow 模板生成的 `code-change.yml` 中各 agent 步骤缺少 `with: { task: ... }` 映射。
`prompt` 命令生成的 `current-step.md` 中 `## Inputs` 为 `(none)`，agent 无法知道任务是什么。

**影响**：P0 — intake 步骤无法执行，整个工作流阻塞。

**临时修复**：直接修改了 `.zigma-flow/workflows/code-change.yml`，为所有 agent 步骤添加：
```yaml
with:
  task: "${{ inputs.task }}"
```

**根因**：`src/init/templates.ts` 的 `codeChangeWorkflowYml()` 中缺少此 `with:` 映射。
**待修复**：在 P12.4.1 中修复 `templates.ts` 并添加回归测试。

### DF-P1-001：report.json 写入路径对 agent 不明确

**问题**：`current-step.md` 中 Output 节说明 "写入 step artifacts directory" 但未给出绝对路径。
agent 需要自行推断或搜索路径。

**规律**：路径始终为 `current-step.md` 所在目录，即：
```
.zigma-flow/runs/<run_id>/jobs/<job>/attempts/<attempt>/steps/<step>/report.json
```

**临时处理**：在本 runbook 的每个步骤中明确给出路径。

**待修复**：在 P12.4.1 中修改 `src/prompt/index.ts` 的 Output 节，注入实际路径。

### DF-P1-002：static-check / unit-test 仍为 placeholder

**问题**：`codeChangeWorkflowYml()` 生成的脚本为 `echo 'static-check placeholder'`，
无实际检查能力。

**临时修复**：直接修改了 `.zigma-flow/workflows/code-change.yml`，改为真实命令：
```yaml
run: "pnpm typecheck && pnpm lint"   # static-check
run: "pnpm test:ci"                  # unit-test
```

**待修复**：在 P12.4.1 中修复 `templates.ts`。

---

## 工作流 DAG

```
intake → code-map → risk-scan → plan → [architecture-design?] → implement → static-check ┐
                                                                                ↓          ├→ review → summarize
                                                                           unit-test ─────┘
```

- `architecture-design` 为 optional job，仅在 plan 发出 `needs_architecture_design` 信号时激活。
- `static-check` 和 `unit-test` 在 `implement` 完成后并行执行。

---

## 执行步骤

每个 agent 步骤的流程：
1. 生成提示词：`node dist/cli.js prompt --job <job>`
2. 读取提示词文件（见路径）
3. 将提示词内容粘贴到 Claude Code，等待执行完成
4. 确认 Claude Code 将 `report.json` 写到正确路径
5. 推进：`node dist/cli.js next --job <job>`

---

### Step 1：intake/analyze（agent）

**当前状态**：intake 已在 running，prompt 已生成。

**提示词路径**（已生成，直接读取）：
```
.zigma-flow/runs/20260615-0003/current-step.md
```
或
```
.zigma-flow/runs/20260615-0003/jobs/intake/attempts/1/steps/analyze/current-step.md
```

**report.json 写入路径**（Claude Code 需写到此处）：
```
.zigma-flow/runs/20260615-0003/jobs/intake/attempts/1/steps/analyze/report.json
```

**report.json 模板**：
```json
{
  "outputs": {
    "task_summary": "Refactor zigma-flow prompt generation from hardcoded templates.ts to external loadable files with auto-scan support",
    "scope": "medium"
  },
  "artifacts": [],
  "signals": [],
  "summary": "Task analyzed: extract prompt templates from src/init/templates.ts to external .md files; implement auto-scan mechanism."
}
```

**推进**：
```
node dist/cli.js next --job intake
```

**验证**：`node dist/cli.js status 20260615-0003` — code-map 应为 `ready`。

---

### Step 2：code-map/map（agent）

**生成提示词**：
```
node dist/cli.js prompt --job code-map
```

**提示词路径**：
```
.zigma-flow/runs/20260615-0003/current-step.md
```

**report.json 写入路径**：
```
.zigma-flow/runs/20260615-0003/jobs/code-map/attempts/1/steps/map/report.json
```

**report.json 模板**（Claude Code 根据实际探索填写）：
```json
{
  "outputs": {
    "files": "src/init/templates.ts,src/init/index.ts,src/prompt/index.ts,.zigma-flow/skills/code-change/prompts/",
    "modules": "init,prompt,context"
  },
  "artifacts": [],
  "signals": [],
  "summary": "Key files: src/init/templates.ts (hardcoded prompt generators), src/prompt/index.ts (renders ContextBundle to markdown prompt)."
}
```

**推进**：
```
node dist/cli.js next --job code-map
```

---

### Step 3：risk-scan/validate（自动 check）

```
node dist/cli.js step --job risk-scan
```

自动执行 `zigma/file-exists` check，通过后 risk-scan 完成，plan 变为 `ready`。

---

### Step 4：plan/plan（agent）

**生成提示词**：
```
node dist/cli.js prompt --job plan
```

**report.json 写入路径**：
```
.zigma-flow/runs/20260615-0003/jobs/plan/attempts/1/steps/plan/report.json
```

**report.json 模板**（不需要架构设计时）：
```json
{
  "outputs": {
    "plan_summary": "Extract prompt templates from templates.ts to external .md files; add auto-scan loader",
    "steps": "1. Create src/prompt/templates/ directory for external .md template files\n2. Move prompt content from templates.ts templateFunctions to individual .md files\n3. Implement loadPromptTemplates(dir) scanner in src/prompt/loader.ts\n4. Update buildAgentPrompt() to use loaded templates instead of inline strings\n5. Update init/index.ts to copy .md template files to .zigma-flow/\n6. Add tests for loader and template discovery"
  },
  "artifacts": [],
  "signals": [],
  "summary": "Plan: 6 steps to externalize prompt templates and implement auto-scan."
}
```

**如果需要架构设计**（plan 判断范围较大时），signals 中加入：
```json
"signals": [{"type": "needs_architecture_design"}]
```

**推进**：
```
node dist/cli.js next --job plan
```

**注意**：若发出了 `needs_architecture_design` 信号，先执行 Step 4b，再继续。

---

### [可选] Step 4b：architecture-design/design（agent）

仅在 plan 发出 `needs_architecture_design` 信号时执行。

**已知行为**（TC-DOGFOOD-5 验证）：信号触发时 architecture-design 会被设为 `waiting`（非 `ready`），
因为 plan job 尚未完成。`next --job plan` 执行后 engine 会重新评估，
architecture-design 才会变为 `ready`。

```
node dist/cli.js status 20260615-0003   # 确认 architecture-design 为 ready
node dist/cli.js prompt --job architecture-design
```

**report.json 写入路径**：
```
.zigma-flow/runs/20260615-0003/jobs/architecture-design/attempts/1/steps/design/report.json
```

**推进**：
```
node dist/cli.js next --job architecture-design
```

---

### Step 5a：implement/implement（agent）

**生成提示词**：
```
node dist/cli.js prompt --job implement
```

**report.json 写入路径**：
```
.zigma-flow/runs/20260615-0003/jobs/implement/attempts/1/steps/implement/report.json
```

**report.json 模板**（Claude Code 根据实际修改填写）：
```json
{
  "outputs": {
    "summary": "Extracted prompt templates to src/prompt/templates/*.md; implemented loadPromptTemplates(); updated buildAgentPrompt() and init.",
    "files_changed": "src/init/templates.ts,src/prompt/loader.ts,src/init/index.ts"
  },
  "artifacts": [],
  "signals": [],
  "summary": "Implementation complete. Templates extracted. Auto-scan loader implemented."
}
```

**推进到 collect-diff**：
```
node dist/cli.js next --job implement
```

---

### Step 5b：implement/collect-diff（自动 script）

```
node dist/cli.js step --job implement
```

执行 `git diff HEAD`，自动将 diff 写入 artifact，implement job 完成。

---

### Step 6a：static-check/check（自动 script）

```
node dist/cli.js step --job static-check
```

执行 `pnpm typecheck && pnpm lint`。

---

### Step 6b：unit-test/test（自动 script）

```
node dist/cli.js step --job unit-test
```

执行 `pnpm test:ci`。

**注意**：static-check 和 unit-test 并行就绪，可同时执行（两个终端），
也可顺序执行（任意顺序，两个都完成后 review 变为 ready）。

---

### Step 7：review/review（agent）

**生成提示词**：
```
node dist/cli.js prompt --job review
```

**report.json 写入路径**：
```
.zigma-flow/runs/20260615-0003/jobs/review/attempts/1/steps/review/report.json
```

**report.json 模板**（approved）：
```json
{
  "outputs": {
    "verdict": "approved",
    "issues": ""
  },
  "artifacts": [],
  "signals": [],
  "summary": "Changes reviewed: template extraction correct, auto-scan loader works, tests pass. Approved."
}
```

**如果 rejected**（需要 implement 重试）：
```json
{
  "outputs": {
    "verdict": "rejected",
    "issues": "Description of issues found"
  },
  "artifacts": [],
  "signals": [{"type": "review_rejected"}],
  "summary": "Changes rejected: <reason>."
}
```

**推进**：
```
node dist/cli.js next --job review
```

---

### Step 8：summarize/summarize（agent）

**生成提示词**：
```
node dist/cli.js prompt --job summarize
```

**report.json 写入路径**：
```
.zigma-flow/runs/20260615-0003/jobs/summarize/attempts/1/steps/summarize/report.json
```

**report.json 模板**：
```json
{
  "outputs": {
    "final_summary": "Refactored zigma-flow prompt system to use external .md template files. Implemented auto-scan loader in src/prompt/loader.ts. Updated init to copy templates. All tests pass.",
    "remaining_risks": "None identified. Template override by Skill Pack not yet tested end-to-end."
  },
  "artifacts": [],
  "signals": [],
  "summary": "Workflow complete. Summary written."
}
```

**推进**：
```
node dist/cli.js next --job summarize
```

**完成验证**：
```
node dist/cli.js status 20260615-0003   # 所有 jobs 应为 completed
```

---

## 便捷命令速查

```bash
# 检查当前状态
node dist/cli.js status 20260615-0003

# 列出所有 run
node dist/cli.js list-runs

# 查看 run 详情（含最近 5 个事件）
node dist/cli.js show 20260615-0003

# 中止 run（遇到阻塞时）
node dist/cli.js abort --reason "<原因>"

# 重试失败的 job
node dist/cli.js retry --job implement
```

---

## 观察清单（DogFood 记录项）

执行过程中观察以下项目，遇到问题立即记录：

| # | 观察点 | 预期 | 实际 | 严重度 |
|---|--------|------|------|--------|
| O1 | intake prompt 包含任务描述 | ✓ task 字段可见 | | |
| O2 | report.json 路径可推断 | 与 current-step.md 同目录 | | |
| O3 | next 命令错误提示清晰 | 明确说明缺失文件路径 | | |
| O4 | status 输出可读性 | 状态一目了然 | | |
| O5 | static-check 真实运行 | typecheck + lint 执行 | | |
| O6 | unit-test 真实运行 | test:ci 执行 | | |
| O7 | implement 双步骤流转 | agent → next → step(script) | | |
| O8 | review_rejected 触发重试 | implement retry attempt 2 | | |
| O9 | 完成后 show 输出完整 | 10 个 jobs 全部 completed | | |

**严重度定义**：
- P0：阻塞工作流无法继续
- P1：流程可继续但体验严重受损
- P2：次要问题，有 workaround
- P3：改善建议

---

## 发现记录格式

```
DF-<P0|P1|P2|P3>-NNN: <标题>
命令/步骤: <触发时执行的命令>
现象: <观察到的实际行为>
预期: <预期行为>
影响: <对工作流的影响>
可能根因: <猜测>
```

---

## 完成后

将所有发现整理后反馈，推进 P12.4：

- P12.4.1 — 修复 P0/P1 issues（重点：DF-P0-001、DF-P1-001、DF-P1-002 的 source fix）
- P12.4.2 — 全量验证 `pnpm build && pnpm typecheck && pnpm test:ci`
- P12.4.3 — 生成 MVP release notes
- P12.4.4 — tag v0.1.0
