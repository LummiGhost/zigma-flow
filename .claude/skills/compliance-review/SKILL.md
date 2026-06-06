---
name: compliance-review
description: >
  审阅 Agent 执行的变更是否符合项目 ADR、设计规范、
  开发流程和 AGENTS.md 约束。执行前必须提供原始任务提示词和参考依据
  （GitHub Project 条目编号或任务计划文档路径），否则输出错误并中止。
  无问题时只输出一行"规范化检查通过"；有问题时输出完整裁定、问题明细和下一步操作。
  所有审阅发现均记录到内部日志；同类问题重复出现时自动写入 Agent Memory。
  用法：/compliance-review --task "<提示词>" --project <N> [--pr <N>|--branch <name>|<file>...]
---

# Compliance Review

## Role

作为项目规范合规审阅员，判断 Agent 执行的变更是否满足项目流程、
设计权威源和 AGENTS.md 约束。不评价代码逻辑好坏，不提风格建议；只判断
"这个变更是否做了它不该做的事，或者没做它必须做的事"。

---

## Step 0 — 输入验证（必须最先执行）

解析 `$ARGUMENTS`，提取以下字段：

| 字段 | 参数形式 | 是否必需 |
|---|---|---|
| 任务提示词 | `--task "..."` 或 `--task-file <路径>` | **必需** |
| 参考依据 | `--project <N>`（GitHub Project 条目）或 `--plan <路径>`（本地计划文档）| **必需** |
| 审阅目标 | `--pr <N>`、`--branch <name>`、或文件路径 | 可选；默认：`git diff HEAD` |

**如果任务提示词或参考依据任意一项缺失，立即输出以下错误并中止，不执行任何后续步骤：**

```
错误：compliance-review 缺少必要输入，无法执行。

必须同时提供：
  1. 原始任务提示词
       --task "..."            提示词文本（直接内联）
       --task-file <路径>      提示词文件路径

  2. 目标参考依据（二选一）
       --project <N>          GitHub Project 条目编号
       --plan <路径>           本地任务计划文档路径

可选（不提供则默认审阅当前工作区未提交变更）：
       --pr <N>               GitHub PR 编号
       --branch <name>        分支名称
       <文件路径>...           一个或多个文件

示例：
  /compliance-review --task "实现工作流引擎核心状态机 Step 1" --project 5
  /compliance-review --task-file docs/phases/p1/plan.md --plan docs/phases/p1/plan.md --pr 42
```

---

## Step 1 — 收集证据

### 1a. 任务与参考

- 读取任务提示词（内联或文件）。
- 如果是 `--project <N>`：执行 `gh project item-list <N> --owner <repo-owner> --format json` 获取条目详情。
- 如果是 `--plan <路径>`：读取该文档全文。
- 提取以下信息：任务目标、预期范围、已声明的文件/模块所有权、明确禁止的事项。

### 1b. 实际变更

根据审阅目标收集变更内容：

| 目标 | 命令 |
|---|---|
| 当前工作区（默认）| `git diff HEAD` |
| 分支 | `git diff main...<branch>` |
| PR | `gh pr diff <N>` + `gh pr view <N>` |
| 文件列表 | 逐一完整读取 |

记录变更涉及的文件集合和包边界。

### 1c. 约束来源文档

按以下优先级读取；只读与变更相关的部分，不要批量加载整个 `docs/`：

1. `CLAUDE.md` — 全局规则、Guardrails、工作区与 PR 工作流约束。
2. 变更所在包的 `AGENTS.md`（如存在）。
3. `docs/mvp-contracts.md` — MVP 执行合同（MVP scope 的主要权威源）。
4. 若变更声称实现某个设计规范：读取对应的原始权威文档（`docs/architecture.md`、`docs/prd.md` 等）中被引用的条款，不读取派生文档。
5. 若任务/计划文档引用了具体 ADR 或阶段计划：读取对应文档中相关章节。

**不读取**：未被引用的设计文档、`node_modules`、构建产物。

---

## Step 2 — 合规性检查

对变更逐项检查以下维度。每项检查的结果：**通过 / 违规 / 不适用**。

### 维度列表

**[SC] 任务范围符合性**
- 变更内容是否在任务提示词/计划文档声明的范围内？
- 是否存在超出范围的额外变更（文件、包、功能）？
- 是否存在任务要求但未完成的关键部分？

**[OW] 包所有权与文件边界**
- 变更是否限于任务所有权声明或包 `AGENTS.md` 允许的文件范围内？
- 是否修改了其他 Agent 或任务的所有权文件而未经声明？

**[WF] 工作区与 PR 流程**
- 实现是否在独立 worktree 中进行（而非直接在主工作区操作）？
- 分支是否从 `origin/main` 创建？
- 是否存在未经允许的直接提交到 main 分支？

**[MV] MVP 范围约束**
- 变更是否引入了 `docs/mvp-contracts.md` 明确排除在 MVP 之外的功能？
- 是否在用户未明确变更范围的情况下扩展了 MVP 边界？
- 是否违反了 MVP 合同中规定的约束条款？

**[S1] Step 1 粒度约束**（仅当变更是某个工作流 Step 1 时适用）
- 用户任务条数 ≤ 3？
- 规范强制条款引用数 ≤ 15？
- 计划测试文件数 ≤ 2？

**[DA] 设计权威源**
- 实现是否参照了原始规范（`docs/architecture.md`、`docs/mvp-contracts.md`、`docs/prd.md`），而非只参照派生文档？
- 派生文档是否声明了其权威源并列出差异？

**[AR] 架构守则**
- 变更是否遵守了 CLAUDE.md 中规定的架构 Guardrails？
- Engine 是否仍然拥有状态转换权（CLI、script、check、router、adapter 不得绕过 Engine 状态机）？
- Skill Pack 定义是否擅自持有工作流状态？
- 新的运行时行为是否保留了 artifact 和 event 的可审计性？

**[DL] 领域语言**（仅适用于含用户可见文本的变更）
- 用户可见的标签、按钮、提示、`aria-label`、`data-testid` 中是否泄露了内部工程术语（原始枚举名、内部 ID、模块内部状态名等）？

**[TX] 文本/测试一致性**（仅适用于含文本标签变更的情况）
- 标签、`aria-label`、`data-testid` 变更是否同步更新了相关测试文件？

**[DO] 定义即完成谬误**
- 是否存在"规则/API 已定义但实现路径未消费"的情况被标记为完成？
- 验收证据是否仅为单元测试（缺少集成、冒烟或端到端验证）？

---

## Step 3 — 读取并更新问题日志

问题日志路径：`.claude/skills/compliance-review/records/issue-log.md`

### 3a. 读取现有日志

执行：读取 `.claude/skills/compliance-review/records/issue-log.md`。

如果文件不存在，以空日志初始化（见下方格式）。

### 3b. 对每条新发现的违规

1. 计算其**指纹**（从下方规范指纹列表中选最匹配的一个；不在列表中的用 `custom/<简短描述>`）。
2. 在日志中查找相同指纹的历史记录。
3. 追加本次发现（日期、上下文简述）并将该指纹的 `count` +1。
4. 如果更新后 `count >= 2`，标记该条目需要提升到 Memory（见 Step 4）。

### 3c. 写回日志

将更新后的完整 issue-log.md 写回。

---

## Step 4 — Memory 提升（count >= 2 时执行）

对所有 `count >= 2` 且 `memory_promoted = false` 的指纹：

1. 在 `.claude/skills/compliance-review/records/memory/` 下创建或更新对应 feedback 文件，
   文件名格式：`feedback_compliance_<fingerprint>.md`。
   内容格式：
   ```markdown
   ---
   name: 合规反复问题 — <指纹>
   description: <一句话描述该问题的模式，用于决策相关性>
   type: feedback
   ---

   <规则陈述：Agent 不应做什么，或必须做什么>

   **Why:** <该问题在 compliance-review 中被发现 N 次的简要背景，引用对应规范条款>

   **How to apply:** <在什么情况下这条规则生效，覆盖哪些场景>
   ```
2. 更新 `.claude/skills/compliance-review/records/memory/MEMORY.md` 索引，追加一行：
   `- [合规反复问题 — <指纹>](feedback_compliance_<fingerprint>.md) — <一行说明>`。
   如果该条目已存在，只更新其说明，不重复添加。
3. 在 issue-log.md 中将该条目的 `memory_promoted` 设为 `true`。

---

## Step 5 — 输出

### 无问题时（所有维度通过或不适用）

```
规范化检查通过。
```

仅此一行，不输出任何其他内容。

### 有问题时

按以下格式输出完整报告：

---

```
## 合规审阅报告

**审阅目标**：<PR / 分支 / 文件列表 / 当前变更>
**任务依据**：<任务提示词摘要，一句话>
**参考依据**：<GitHub Project 条目 N / 计划文档路径>
**裁定**：<PASS WITH FOLLOW-UP | FAIL>

<2–3 句总结：变更做了什么，发现了哪些类别的违规，为何判定该裁定级别>
```

**裁定定义：**
- **PASS WITH FOLLOW-UP**：无 Blocking 违规；存在 Major 或 Minor 违规，有明确修复路径。
- **FAIL**：存在至少一个 Blocking 违规，或存在 3 个以上 Major 违规。

---

```
## 问题明细

### [<严重性>] <简短标题>

**位置**：`<文件:行>` 或 `<模块/包>`
**维度**：<[SC] / [OW] / [WF] / [MV] / [S1] / [DA] / [AR] / [DL] / [TX] / [DO]>
**规范依据**：<CLAUDE.md §Guardrail N / AGENTS.md §N / docs/mvp-contracts.md §N>

<问题描述：发现了什么违规，后果是什么>

**修复建议**：
<具体可操作的修复步骤或说明>
```

严重性等级：

| 等级 | 标签 | 判定条件 |
|---|---|---|
| Blocking | **[B]** | 直接提交 main；非 origin/main 作为分支基；在 main workspace 而非 worktree 中实现；MVP 合同明确排除的实质功能变更；Engine 被绕过或 Skill Pack 擅自持有工作流状态 |
| Major | **[M]** | 显著超出任务范围；违反设计权威源规则；领域语言违规；Step 1 超出粒度上限；定义即完成谬误；audit trail 被破坏 |
| Minor | **[m]** | 轻微超出范围；注释/文档与实现不一致；文本变更未同步 spec 文件 |

---

```
## 下一步操作

1. <最高优先级操作，针对 Blocking 问题（如存在）>
2. <第二项操作>
3. <可选：整体建议>
```

最多 5 条，每条具体可执行。

---

## 规范指纹列表

使用以下标准指纹标记日志条目，保持跨审阅的可比性：

| 指纹 | 描述 |
|---|---|
| `direct-main-commit` | 直接提交到 main 分支 |
| `wrong-branch-base` | 分支未从 origin/main 创建 |
| `file-copy-integration` | 用文件复制替代 git merge/cherry-pick 集成 |
| `main-workspace-impl` | 在 main workspace 而非 worktree 中执行实现 |
| `scope-overflow` | 变更超出任务/计划文档声明范围 |
| `mvp-scope-overflow` | 引入 MVP 合同明确排除的功能 |
| `engine-bypass` | CLI/script/check/router/adapter 绕过 Engine 状态转换 |
| `skill-pack-state-owner` | Skill Pack 定义擅自持有工作流状态 |
| `audit-trail-broken` | 新运行时行为破坏 artifact/event 可审计性 |
| `step1-size-exceeded` | Step 1 超出粒度上限（用户任务/规范条款/测试文件） |
| `wrong-design-authority` | 参照派生文档而非原始权威规范 |
| `domain-language-violation` | 用户可见文本含内部工程术语 |
| `definition-is-done` | 规则/API 已定义但实现路径未消费，却被标记为完成 |
| `text-spec-desync` | 文本/标签变更未同步更新 spec/test 文件 |
| `missing-step3-evidence` | Step 3 验收报告缺失或未在 Step 2 完成后立即执行 |
| `custom/<描述>` | 不在上表中的自定义问题 |

---

## 问题日志格式

`.claude/skills/compliance-review/records/issue-log.md` 的结构：

```markdown
# Compliance Review Issue Log

_最后更新：<date>_

## 指纹汇总

| 指纹 | count | 首次发现 | 最近发现 | memory_promoted |
|---|---|---|---|---|
| <fingerprint> | <N> | <date> | <date> | true / false |

## 详细记录

### <fingerprint>

| 日期 | 上下文 | 裁定 |
|---|---|---|
| <date> | <任务简述 + 文件/模块> | FAIL / PASS WITH FOLLOW-UP |
```

---

## Hard Rules

- 缺少必要输入时立即中止，不进行任何审阅。
- 不审阅代码逻辑质量（那是 `/tech-review` 的职责）。
- 不读取未被当前变更引用的设计文档。
- 问题日志在每次审阅后必须更新，无论是否发现问题（更新最后更新日期）。
- Memory 提升只对 `count >= 2` 且 `memory_promoted = false` 的指纹执行，不重复提升。
- 无问题时严格只输出一行，不附加任何解释或统计数字。
