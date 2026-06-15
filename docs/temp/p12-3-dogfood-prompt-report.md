# P12.3 DogFood 阶段性测试报告：Agent Prompt 可执行性问题

报告日期：2026-06-15

## 1. 结论

本轮 P12.3 DogFood 不建议继续把当前 prompt 提交给 Claude 做真实执行。当前 `current-step.md` 已经足以判定为阶段性失败样本：Zigma Flow 成功生成了一个结构化 prompt artifact，但没有生成一个可由外部 Agent 明确执行的任务说明。

这不是外部 Agent 能力问题，而是 Zigma Flow 在 Context Builder / Prompt Builder / Skill Pack prompt 汇入上的产品质量问题。如果继续让 Claude 执行，测试结果会主要反映 Claude 的补全和猜测能力，不能证明 Zigma Flow 的 workflow harness 已经可靠。

阶段性判定：

- Run 创建、job ready、prompt artifact 写入链路可用。
- Prompt 的机械结构基本存在。
- Prompt 的任务可读性、可执行性和交接完整性不足。
- P12.3 应记录为“prompt handoff quality failed”，进入修复迭代后再重新 DogFood。

## 2. 测试范围与证据

测试对象：

- Workflow：`code-change`
- Run：`20260615-0003`
- 当前 job / step：`intake` / `analyze`
- 任务输入：`将 prompt 重构为外部可扩展提示词模板 + 自动扫描模式`
- Prompt mirror：`.zigma-flow/runs/20260615-0003/current-step.md`
- Step-scoped prompt artifact：`.zigma-flow/runs/20260615-0003/jobs/intake/attempts/1/steps/analyze/current-step.md`

关键证据：

- `state.json` 显示 `intake` 处于 `running`，其余 job 尚未推进。
- `events.jsonl` 只记录到 `prompt_generated`，尚无 `agent_report_accepted`。
- `artifacts.jsonl` 记录 prompt artifact，summary 为 `Agent prompt for intake/analyze`。
- 当前 prompt 只包含任务输入、能力清单、权限、report schema 和停止要求，缺少可执行任务上下文。

对应契约：

- `docs/prd.md` 要求生成的 `current-step.md` 必须适合人类阅读。
- `docs/prd.md` FR-006 要求 prompt 包含当前职责、当前输入、输出 schema、artifact 摘要、可用知识、可用工具、可调用 Agent functions、可发出的 workflow signals、权限和禁止动作。
- `docs/architecture.md` 要求 prompt 只含当前 step 允许能力、输出 schema、artifact 摘要和停止要求，并且 Prompt Builder 输出的人类可读 prompt 不泄漏未授权能力。
- `docs/mvp-contracts.md` 要求 Agent Step 只接收当前 step prompt 并提交结构化 report / signal。

## 3. 观察到的问题

### P0：Prompt 不是可执行任务书

当前 prompt 中真正描述任务的内容只有：

```text
task: 将 prompt 重构为外部可扩展提示词模板 + 自动扫描模式
```

这不足以让 Agent 判断：

- 为什么要做这个改动。
- 当前代码的相关入口在哪里。
- `intake/analyze` 这个 step 的预期输出是什么。
- 后续 step 需要从本 step 获得哪些结构化 outputs。
- 什么条件下应判定 blocked 或 needs_architecture_design。

结果是外部 Agent 只能依赖自己的猜测来补全任务，而不是执行 Zigma Flow 提供的 workflow step。

### P0：Skill Pack prompt 模板没有进入最终 prompt

`.zigma-flow/skills/code-change/prompts/intake.md` 已经包含更明确的 intake 指令，例如任务分析、读取内容和输出要求。但生成的 `current-step.md` 只列出了：

```text
- intake (skill: code)
- code-map (skill: code)
- plan (skill: code)
```

它没有把当前 step 对应的 prompt 模板内容渲染进去，也没有说明 Agent 应该如何使用这些 prompt fragment。能力清单变成了目录索引，而不是可执行上下文。

### P0：报告写入路径不明确

当前 prompt 要求：

```text
write your report to report.json in the step artifacts directory
```

但没有给出完整相对路径，例如：

```text
.zigma-flow/runs/20260615-0003/jobs/intake/attempts/1/steps/analyze/report.json
```

对于半自动 handoff 模式，这会增加写错位置的概率。README 也强调 `prompt` 输出应包含 report path；当前 prompt 只给了概念路径，没有给出可复制的目标路径。

### P0：权限语义存在冲突

Prompt 显示：

```text
contents: read
edits: write
commands: none
workflow_state: none
```

但当前 job 在 workflow 中是 read-only workspace，同时 prompt 又要求写 `report.json`。这会让 Agent 难以区分：

- 是否允许修改目标仓库代码。
- 是否允许写 step artifact。
- 是否允许创建额外 artifact 文件。
- `edits: write` 是仓库编辑权限，还是 artifact 输出权限。

MVP 需要明确区分 repository workspace 权限和 runtime artifact 输出权限。Agent 写 `report.json` 是 step contract，不应被普通 `commands/edits` 权限混淆。

### P1：能力暴露缺少内容摘要和使用方式

Knowledge、Prompts、Functions 被列出，但没有内容摘要、路径、适用时机或选择规则。比如：

- `coding-guidelines`
- `workflow-guide`
- `common-failure-patterns`

这些名称对人类和 Agent 都不足以形成行动。Prompt 应至少提供每个暴露能力的用途摘要，或者提供安全的 artifact/path 引用，并明确“本 step 必须读取 / 可选读取 / 仅供参考”。

### P1：Workflow step 与 Skill Pack prompt 没有建立强映射

`intake/analyze` 应自然映射到 `prompts/intake.md`。但当前 expose 是按整个 skill 暴露所有 prompts，而不是按 step 选择主 prompt，再列出辅助 prompt。结果是 Agent 看到六个 prompt 名称，却不知道本 step 的主指令是哪一个。

### P1：缺少 prompt handoff 自检 gate

当前系统能生成 prompt，但没有在提交给外部 Agent 前检测 prompt 是否可交接。至少应能检测：

- 是否包含当前 step 的主指令。
- 是否包含明确的 report path。
- 是否包含当前 step 的输出字段要求。
- 是否包含 task 的可读复述。
- 是否没有出现互相矛盾的权限说明。

## 4. 影响评估

对 P12.3 DogFood 的影响：

- 当前 run 不适合作为 Claude 实际执行样本。
- 如果继续执行，外部 Agent 很可能自己搜索仓库、理解任务、决定输出结构；这会让 Zigma Flow 的 prompt 质量问题被掩盖。
- 后续 `code-map`、`plan`、`implement` 等 step 可能重复出现同类问题，尤其是在需要跨 step 传递 outputs/artifacts 时。

对 MVP 成功标准的影响：

- “Agent 不需要读取完整复杂 Skill”尚未成立，因为当前 prompt 没有提供足够上下文。
- “Agent 每个 Agent Step 能稳定产出约定 report”存在风险，因为 report path 和 outputs 要求不清晰。
- “Context Builder 能限制 Agent 可见能力”部分成立，但目前更像限制了内容本身，而不是提供受控可用上下文。

## 5. 根因分析

根因一：Prompt Builder 目前偏向固定模板渲染，缺少 step-specific instruction slot。它生成了通用章节，但没有把 Skill Pack 中的当前 prompt fragment 作为主任务正文。

根因二：Context Builder 暴露的是能力 metadata，而不是可执行上下文。能力 id 被传入 prompt，但相关内容、摘要、路径和使用规则没有进入 prompt。

根因三：Artifact 输出契约没有在 prompt 中具体化。系统知道 step artifact 目录，但 prompt 只写了概念描述，没有渲染 canonical report path。

根因四：权限模型在展示层没有区分 workspace write 与 artifact write。对 Agent 来说，“不能改 workflow state”和“必须写 report.json”需要被同时说明，并且不能与 read-only workspace 混淆。

根因五：缺少 prompt quality acceptance。当前测试主要验证包含某些字段，而没有验证“人类是否能看懂并执行”这一 DogFood 关键指标。

## 6. 修复方案

### 6.1 立即修复：让 prompt 成为可执行任务书

1. 在 Context Bundle 中增加 `primaryPrompt` 或 `stepInstructions` 字段。
   - 对 `intake/analyze`，应解析并嵌入 `prompts/intake.md`。
   - 如果 workflow step 显式声明 `uses` 或 `prompt`，按声明选择。
   - 如果未声明，按 job id 或 step id 与 Skill Pack prompt id 匹配，匹配失败时给出清晰 warning 或 fallback。

2. 在最终 prompt 中新增 `## Step Instructions`。
   - 放在 Inputs 之后、Exposed Capabilities 之前。
   - 内容来自当前 step 的主 prompt 模板。
   - 明确当前 step 应做什么、不应做什么、输出什么。

3. 渲染 canonical report path。
   - 示例：
     ```text
     Write report.json to:
     .zigma-flow/runs/20260615-0003/jobs/intake/attempts/1/steps/analyze/report.json
     ```
   - 同时说明这是允许写入的 runtime artifact 文件，不等于修改 workflow state。

4. 为每个 Agent step 渲染 step-specific outputs。
   - `intake` 应明确 `outputs.task_summary` 和 `outputs.scope`。
   - `plan` 应明确 `outputs.plan`、风险、验证项等。
   - `review` 应明确 verdict/comments/signals 的结构。

5. 修正权限展示文案。
   - 分成 `Repository workspace permissions` 和 `Runtime artifact permissions`。
   - read-only job 应显示“不得修改仓库文件；允许写本 step 的 report.json 和声明的 artifact 文件”。

### 6.2 中期优化：提升 Context Builder 的可用上下文质量

1. Knowledge 暴露增加摘要和读取策略。
   - `required`：本 step 必须阅读。
   - `optional`：按需阅读。
   - `reference`：仅在判断异常时阅读。

2. Prompt fragment 暴露改为“主 prompt + 辅助 prompt”。
   - 当前 step 只嵌入一个主 prompt。
   - 其他 prompt 只作为参考列出，避免制造选择噪音。

3. Function 暴露增加调用语义。
   - 明确 Agent Function 是能力描述，不是 runtime callable API。
   - 如果当前系统没有函数执行器，不应写成“可调用函数”，而应写成“可遵循的能力模式”。

4. Artifact summary 应进入 prompt。
   - 对已有上游 step 输出，提供 artifact id、路径、summary 和必要字段摘要。
   - 不把大文件全文塞进 prompt，符合 MVP artifact contract。

### 6.3 自动扫描模式建议

本次任务本身提到“自动扫描模式”。建议把它拆成可审计的 deterministic + Agent 边界：

1. Deterministic scan 由 script/check step 执行。
   - 扫描仓库结构、相关文件候选、测试脚本、package metadata、git status。
   - 输出结构化 artifact，例如 `repo-scan.json`。

2. Agent step 只消费 scan summary。
   - 不要求 Agent 从零开始搜索整个仓库。
   - Prompt 中列出 scan artifact 和关键摘要。

3. 自动扫描不得绕过 workflow expose。
   - Context Builder 只能把 workflow 允许的 scan artifact 暴露给当前 step。
   - 大内容继续留 artifact，只渲染摘要。

4. 为 scan 建立失败路径。
   - 扫描命令失败时写 ScriptResult。
   - Engine 根据 gate 判定 block/fail/retry，而不是让 Agent 猜测。

### 6.4 Prompt Handoff Quality Gate

建议新增一个轻量 check 或测试用例，专门验证 prompt handoff 质量：

必须满足：

- 包含当前 job / step / run id。
- 包含 task 原文和可读任务说明。
- 包含当前 step 的主 prompt 指令。
- 包含明确的 report.json 相对路径。
- 包含当前 step 的 outputs 字段要求。
- 包含 workspace 权限和 artifact 写入权限的区别。
- 当 `commands: none` 时，不要求 Agent 运行 shell 命令。
- 当 job 是 read-only 时，不暗示 Agent 可修改仓库代码。

建议测试：

- `tests/prompt/prompt.test.ts` 增加主 prompt 嵌入断言。
- `tests/prompt/report-schema.test.ts` 增加 canonical report path 断言。
- `tests/context/context.test.ts` 增加 step-to-primary-prompt 解析断言。
- `tests/dogfood` 增加 P12.3 失败样本回归测试，确保修复后 `current-step.md` 可读性达标。

## 7. 验证计划

修复后建议按以下顺序验证：

1. 单元测试：
   ```bash
   pnpm test:unit
   ```

2. Prompt 相关聚焦测试：
   ```bash
   pnpm vitest run tests/prompt tests/context
   ```

3. 重新生成同类 run：
   ```bash
   pnpm build
   node dist/cli.js run code-change --task "将 prompt 重构为外部可扩展提示词模板 + 自动扫描模式"
   node dist/cli.js prompt --job intake
   ```

4. 人工验收 `current-step.md`：
   - 不看仓库代码，仅阅读 prompt，能否知道当前 step 要做什么。
   - 能否准确写出 `report.json`。
   - 能否判断哪些文件可以改、哪些不能改。
   - 能否知道完成后应停止。

5. 再进入外部 Claude handoff：
   - 只有当 prompt 自身可读且可执行时，再把 prompt 交给 Claude。
   - 否则继续停留在本地修复，不消耗外部 Agent 测试。

## 8. 建议拆分的后续任务

### Task A：Primary Prompt Resolution

目标：Context Builder 能为每个 Agent step 解析唯一主 prompt。

交付：

- workflow step 到 Skill Pack prompt 的解析规则。
- 匹配失败的明确错误或 fallback。
- 单元测试覆盖 job id、step id、显式声明三种路径。

### Task B：Step Instructions Rendering

目标：Prompt Builder 将当前 step 主 prompt 渲染为 `## Step Instructions`。

交付：

- 当前 step 指令进入最终 prompt。
- 其他 prompt 仅作为辅助能力列出。
- snapshot 或 contract test 覆盖 intake/plan/review。

### Task C：Canonical Report Path Rendering

目标：Prompt 明确给出 report 写入路径。

交付：

- `report.json` 完整相对路径。
- path 与 `acceptAgentReport` 实际读取位置一致。
- Windows/POSIX 路径渲染稳定。

### Task D：Permission Wording Cleanup

目标：消除 workspace 权限与 artifact 输出权限混淆。

交付：

- read-only workspace prompt 不再显示容易误解的 `edits: write`。
- 明确允许写当前 step artifact。
- 增加 read-only prompt snapshot test。

### Task E：Prompt Handoff Quality Gate

目标：DogFood 前自动发现不可交接 prompt。

交付：

- prompt quality check helper 或测试 fixture。
- P12.3 当前失败样本转为回归测试。
- README 更新 DogFood 判定标准。

## 9. 临时处置建议

对 run `20260615-0003`：

- 不继续提交当前 prompt 给 Claude。
- 保留 `.zigma-flow/runs/20260615-0003/` 作为失败样本证据。
- 不手动补写 `report.json` 来强行推进 run，因为这会污染 DogFood 证据。

对 P12.3：

- 将本报告作为阶段性测试产物。
- 先修复 prompt handoff quality，再重新创建新 run 进行 DogFood。
- 新 run 应从 `intake` 开始验证，确认 prompt 可读后再进入 Claude handoff。

## 10. 完成标准

下一轮 P12.3 重新测试通过的最低标准：

- 用户无需阅读源码，仅凭 `current-step.md` 能理解当前 step 要做什么。
- 外部 Agent 无需猜测 report 路径。
- 外部 Agent 能按 prompt 写出符合 schema 的 `report.json`。
- Prompt 中不会出现权限自相矛盾。
- 当前 step 的 Skill Pack prompt 内容实际进入最终 prompt。
- DogFood 可以继续推进到 `code-map`，并在上游 artifact 基础上形成清晰交接。
