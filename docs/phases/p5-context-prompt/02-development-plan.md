# P5 — Context Builder and Agent Prompt: Development Plan

- Authority source: docs/prd.md §14, §20 (阶段 4), FR-006; docs/architecture.md §5, §12.2
- Date: 2026-06-08
- Status: Frozen

## Objective

### Business Objective
用户运行 `zigma-flow prompt --job <job>` 后，能在 `current-step.md` 中得到一份受控 Agent prompt：只暴露当前 step 允许的能力，明确禁止修改 workflow 状态，包含输出路径和完成后停止约束。

### Technical Objective
实现 Context Builder（`src/context/`）和 Prompt Builder（`src/prompt/`），并通过 `src/commands/prompt.ts` 将两者接入 CLI。同时实现 `src/expression/` 的最小表达式解析器，并扩展 engine 追踪 active run。

## Scope

### In Scope
- `ContextBundle` 数据模型 (P5.1)
- `expose` 能力解析：knowledge、functions、tools、prompts (P5.2)
- Artifact 摘要注入 (P5.3 partial)
- 权限渲染 (P5.3 partial)
- Signal 清单渲染（按 `allowed_from` 过滤）(P5.3 partial)
- 最小表达式解析器（`${{ inputs.* }}`、`${{ run.id }}`、`${{ run.workflow }}`）
- Active run 追踪（`createRun` 写入 `.zigma-flow/config.json` active_run 字段）
- `buildAgentPrompt()` — Markdown 渲染 (P5.4)
- `zigma-flow prompt --job <job>` CLI 命令 (P5.4)
- `prompt_generated` 事件写入 (P5.4)
- 单元测试 + snapshot 测试

### Out of Scope
- `${{ jobs.*.outputs.* }}`、`${{ steps.*.outputs.* }}`、`${{ retry.* }}`、`${{ signals.* }}` 表达式（延至 P6+）
- Knowledge 文件内容注入（只注入名称和描述）
- Artifact 内容展开（只用 metadata summary 字段）
- Step 报告 schema 渲染（spec 中提到，但 schema 定义属于 P6 agent step execution）
- Web UI、多租户、MCP

## Milestones

| Milestone | Description | Exit Criteria |
| --- | --- | --- |
| M5.1 | ContextBundle 类型 + buildContext() | `buildContext()` 返回包含 capabilities/inputs/artifacts/signals/permissions 5 个字段的 bundle；TypeScript 类型完整；单测覆盖 |
| M5.2 | buildAgentPrompt() 渲染 Markdown | 给定 ContextBundle 产出符合 FR-006 格式的 Markdown；snapshot 测试通过 |
| M5.3 | zigma-flow prompt --job 端到端 | 用户在含有 Agent step 的真实 run 目录下执行 `prompt --job plan`，在 run 目录产出 `current-step.md`，事件日志追加 `prompt_generated` |

## Technical Approach

### Architecture and Module Changes
```text
src/expression/index.ts         — 新增：最小表达式解析器（public: resolveExpression）
src/context/index.ts            — 新增：ContextBundle 类型 + buildContext() (currently export {})
src/prompt/index.ts             — 新增：buildAgentPrompt() + renderMarkdown() (currently export {})
src/commands/prompt.ts          — 新增：prompt 命令 handler
src/commands/index.ts           — 新增导出 promptAction
src/engine/index.ts             — 修改：createRun 写 config.json active_run
src/cli.ts                      — 新增 prompt 子命令
```

### Data/API Changes
- `.zigma-flow/config.json` 新增 `active_run: string` 字段，由 `createRun` 写入
- `ContextBundle` 新接口（见 WF-P5-CONTEXT 用例文档）
- `runs/<run-id>/current-step.md` — prompt 输出产物
- `runs/<run-id>/artifacts.jsonl` — 新增 prompt artifact 条目

### Testing Strategy
- `tests/context/context.test.ts` — ContextBundle 单测（buildContext 各字段）
- `tests/prompt/prompt.test.ts` — prompt 快照测试（buildAgentPrompt 输出格式）
- `tests/commands/prompt.test.ts` — prompt 命令集成测试（tmpdir + fake run）

### Release/Migration Notes
- 无破坏性改动；`config.json` 向后兼容（active_run 字段可选）
- `src/run/index.ts` 和 `src/engine/index.ts` 轻微扩展，不影响 P4 测试

## Workflow Breakdown

| Workflow | Goal | Dependencies | Acceptance Criteria | Research Needed |
| --- | --- | --- | --- | --- |
| WF-P5-CONTEXT | 实现 ContextBundle 类型和 buildContext()；含最小表达式解析器 | P4 artifacts/events/run, P2 workflow/skill-pack loader | 单测覆盖所有字段路径；typecheck 0 错误；lint clean | 无 |
| WF-P5-PROMPT | 实现 buildAgentPrompt() Markdown 渲染 + prompt --job 命令 + active run 追踪 + 事件写入 | WF-P5-CONTEXT, P3 run creation | `zigma-flow prompt --job <job>` 在真实 run 目录产出 current-step.md；prompt 内容符合 FR-006 要求；prompt_generated 事件写入；snapshot 测试通过 | 无 |

## Risks and Mitigations

| Risk | Probability | Impact | Mitigation | Owner |
| --- | --- | --- | --- | --- |
| Skill pack 加载路径：P5 用 zigma-flow 目录而非 run snapshot | Low | Medium | 明确依赖 baseDir 参数；测试用 tmpdir 构造 | Step 2 agent |
| 表达式 resolve 未涵盖的 with 字段导致 inputs 显示空 | Medium | Low | 未解析表达式显示为字面量（`${{ ... }}`），不崩溃 | Step 2 agent |
| `config.json` active_run 被多 run 覆盖 | Low | Low | MVP 声明 last-writer-wins；后续加锁 | Step 2 agent |
| prompt 意外暴露完整 workflow 细节 | Medium | High | snapshot 测试验证 prompt 不包含 job 定义全量；合规审阅检查 | Step 3 acceptance |

## Quality Bar

- Required: typecheck 0 errors; lint clean; all P4 157 tests still pass; new P5 tests pass
- Prompt output: does NOT include complete workflow YAML; ONLY exposes `expose` capabilities; includes "完成当前 step 后停止" requirement; includes output path
- No breaking changes to existing interfaces

## Open Decisions — Resolved

| Decision | Resolution | Rationale |
| --- | --- | --- |
| 表达式解析范围 | MVP 只支持 `${{ inputs.* }}`、`${{ run.id }}`、`${{ run.workflow }}`；其余保留字面量 | P5 只需展示 run 创建时已知的 inputs，其他引用属于 step execution 上下文 |
| Active run 定位 | `createRun` 扩展写入 `config.json` `active_run`；`prompt --job` 从 config 读取 | 清晰、幂等；避免扫描目录的不确定性 |
| Skill pack 加载 | 从 zigmaflowDir（项目 `.zigma-flow/` 父目录）+ skill-lock.json 加载；snapshot 留待未来 | 现有 `resolveSkillLock` API 与此匹配；snapshot 一致性属于 P8+ 范围 |
| Knowledge/function 内容 | 只注入名称、描述、inputs/outputs schema；不加载文件全文 | 避免 prompt 膨胀；符合 PRD §18 "artifact 以 metadata 传递" 原则 |

## Technical Debt Registered

| ID | 引用规范条款 | 推迟原因 | 清偿期限 |
| --- | --- | --- | --- |
| TD-P5-001 | PRD §14 Context Builder "按需展开"；expression resolver `${{ jobs.*.outputs.* }}` 等 | step execution（P6+）才能产生 job outputs | P6 engine step execution |
| TD-P5-002 | PRD §14 "artifact 摘要注入" — summary 自动生成 | MVP 只用 metadata summary 字段；LLM summary 明确 out-of-scope | P10 dogfood 阶段 |
| TD-P5-003 | PRD FR-006 report schema 渲染 | report schema 属于 Agent Step 的 outputs contract，P6 定义 | P6 agent step execution |
| TD-P3-001..004 | 延续 P3 已登记技术债 | 不变 | 对应计划清偿期 |
| TD-P4-001 | 延续 P4 已登记技术债（SC-S05/S07/S08/S09） | 不变 | P6+ |

## Freeze Record

- Plan status: **Frozen**
- Frozen at: 2026-06-08
- Final decisions: 全部 Open Decisions 已在上表解决
- Residual risks: prompt 内容偏差（通过 snapshot 测试 + 合规审阅控制）
