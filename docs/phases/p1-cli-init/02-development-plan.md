# P1 CLI 骨架与初始化 Development Plan

- Date: 2026-06-06
- Author: phase-development-supervisor

## Objective

- Business objective: 用户可以通过 `zigma-flow init` 在本地项目中快速建立 `.zigma-flow/` 骨架，并得到可用的内置 code-change workflow 和 Skill Pack 示例，后续 P2+ 任务可以直接在这个骨架上继续实现。
- Technical objective: 建立 commander-based CLI 入口、模块化 init 文件系统能力、内置模板静态资产，以及支撑后续任务的错误类型基础设施。

## Scope

- In scope:
  - P1.2 CLI 入口（commander, version, error→exit code, CLI test harness, smoke tests）
  - P1.3 Init 文件系统能力（目录创建 helper, 非覆盖写文件 helper, config.json 模板, skill-lock.json 模板, init 摘要）
  - P1.4 内置示例模板（code-change.yml, skill.yml, knowledge/, prompts/, scripts/collect-diff.ts, checks/ 文件）
  - P1.5 Init 命令验收（接入 init command handler, 幂等测试, 已有目录提示测试, 跨平台路径测试）
- Out of scope:
  - validate 命令（P2）
  - run/status/prompt 命令（P3+）
  - eslint/prettier 配置（P1.1 已约定 lint=typecheck，不扩展）
  - Docker、MCP、远程 Skill Registry（MVP out-of-scope）

## Milestones

| Milestone | Description | Exit criteria |
| --- | --- | --- |
| M1 CLI Entry | commander 根命令运行 | `zigma-flow --help` 输出命令列表；`--version` 与 package.json 一致；未知命令非零退出 |
| M2 Init Execution | init 命令执行 | `zigma-flow init` 生成 `.zigma-flow/workflows/`、`skills/code-change/`、`runs/`、`config.json`、`skill-lock.json` 及所有模板文件 |
| M3 Init Idempotency | init 命令幂等 | 重复执行不覆盖已有文件；输出 created/skipped 摘要 |

## Technical Approach

- Architecture and module changes:
  - 新增 `commander` 依赖
  - 重写 `src/cli.ts` 使用 commander，保留 `main()` 导出
  - 新增 `src/commands/init.ts` — init command handler
  - 新增 `src/init/` 子模块：`createDirectories.ts`、`writeFileIfMissing.ts`、`templates.ts`、`runInit.ts`
  - 新增 `src/utils/errors.ts` — ZigmaFlowError 及各子类，按 mvp-contracts §7
  - 内置模板作为 TypeScript 字符串常量嵌入 `src/init/templates.ts`（避免打包时依赖静态文件路径）
- Data/API changes: N/A（P1 不涉及 run state、event log 或 artifact）
- Testing strategy:
  - 单元测试：`tests/init/createDirectories.test.ts`（filesystem helpers）
  - 集成测试：`tests/cli/cli.test.ts`（CLI smoke: --help, --version, unknown command, init command）
  - 使用 `node:fs/promises` + `node:os.tmpdir()` 创建临时目录做 init 集成测试，用后清理
  - 路径 fixture：Windows POSIX 混合路径规范化测试
- Release or migration notes: 需要 `pnpm add commander` 更新 lockfile

## Workflow Breakdown

| Workflow | Goal | Dependencies | Acceptance criteria | Research needed |
| --- | --- | --- | --- | --- |
| WF-P1-INIT | 实现 CLI 入口 + init 命令完整能力（P1.2–P1.5） | P1.1 skeleton（done） | M1+M2+M3 milestone 全部达成；typecheck+lint+test 通过 | No |

## Risks And Mitigations

| Risk | Probability | Impact | Mitigation | Owner |
| --- | --- | --- | --- | --- |
| 模板内容与后续 P2 validator 不兼容 | Medium | 中：模板 YAML/JSON 若不合法则 P2 测试失败 | 模板内容严格按 PRD §11–12 的最小合法示例编写，P2 测试可以引用这些模板 fixture | subagent |
| Windows 路径分隔符差异导致 init 路径非法 | Low | 高：Windows 上路径包含 `\` 可能绕过路径安全检查 | 所有路径操作使用 `node:path.join` + `node:path.normalize`，不使用字符串拼接 | subagent |
| commander 版本与 Node ESM 不兼容 | Low | 低：commander v12+ 支持 ESM | 使用 commander@12.x，确认 ESM import 方式 | subagent |

## Quality Bar

- Required automated tests:
  - `tests/init/createDirectories.test.ts` — 创建目录幂等、已有目录 skip
  - `tests/init/writeFileIfMissing.test.ts` — 新文件创建、已有文件 skip
  - `tests/cli/cli.test.ts` — --help, --version, unknown command, init smoke
  - `tests/init/init.integration.test.ts` — 空目录 init, 重复 init, 跨平台路径
- Required manual checks: N/A（纯 CLI 命令，无 UI）
- Performance / reliability constraints: init 命令不超过 3 秒（本地文件系统）
- Documentation updates: 无需更新 PRD/architecture，模板文件即为文档

## Open Decisions

| Decision | Options | Research task | Due trigger |
| --- | --- | --- | --- |
| 模板嵌入方式 | TS 字符串常量 vs 静态文件 | 无（选 TS 字符串常量，打包友好） | 已决定 |

## Freeze Record

- Plan status: **Frozen**
- Frozen at: 2026-06-06
- Final decisions:
  - 模板以 TypeScript 字符串常量嵌入 `src/init/templates.ts`
  - 错误类型实现在 `src/utils/errors.ts`，按 mvp-contracts §7 最小分类
  - lint script 维持 `tsc --noEmit`，不引入 eslint（scope freeze）
- Residual risks:
  - 模板与 P2 validator 的兼容性将在 P2 step 1 验证时确认，技术债 TD-P1-001（如有不兼容须在 P2 修正模板）
