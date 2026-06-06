# P1 CLI 骨架与初始化 Readiness Review

- Date: 2026-06-06
- Reviewer: phase-development-supervisor

## Inputs

- Source documents:
  - `docs/prd.md` v0.3 — FR-001, §17 CLI 命令设计, §19 技术选型, §20 阶段 1 计划
  - `docs/architecture.md` v0.1 — §5.1 逻辑层, §5.2 模块边界, §8.1 目录所有权, §9.1–9.2 集成契约
  - `docs/mvp-contracts.md` v0.1 — §4 叶子任务 DoD, §5 模块依赖冻结, §6 核心端口, §7 错误分类
- Related design materials: P1.1 工程骨架（Done，PR #1）
- Current code constraints:
  - TypeScript CLI with tsup build + vitest tests
  - `src/cli.ts` currently uses manual arg parsing (no commander)
  - `package.json` has no `commander` dependency yet
  - All module directories exist as stubs with empty `index.ts`

## Stage Goal

- Goal: 建立 commander 入口、实现 `zigma-flow init` 命令完整能力（目录创建、模板生成、幂等保护）
- Milestones:
  - M1: `zigma-flow --help` / `--version` 通过 commander 运行，错误返回非零 exit code
  - M2: `zigma-flow init` 生成完整 `.zigma-flow/` 目录结构和内置模板
  - M3: 重复 `zigma-flow init` 不覆盖已有文件，输出 created/skipped 摘要
- Acceptance criteria:
  - commander 根命令带版本和帮助
  - 未知命令返回非零 exit code
  - 错误类型按 mvp-contracts §7 映射 exit code
  - init 生成所有 FR-001 规定目录和文件
  - init 重复执行幂等
  - 路径处理跨平台安全

## Boundary

- In scope: P1.2 CLI 入口, P1.3 Init 文件系统能力, P1.4 内置示例模板, P1.5 Init 命令验收
- Out of scope: validate 命令（P2），run 命令（P3），任何 Engine 状态推进逻辑，eslint/prettier 配置
- External dependencies: commander（需新增依赖）; fs-extra（可选，也可用 node:fs/promises）

## Findings

| ID | Type | Description | Impact | Blocking |
| --- | --- | --- | --- | --- |
| F-01 | Gap | `commander` 未在 package.json 中声明 | 需安装后才能实现 P1.2.1 | Yes — P1.2 前必须安装 |
| F-02 | Risk | `lint` script 与 `typecheck` 相同（均为 `tsc --noEmit`），无 eslint | MVP 代码规范依赖 tsup+tsc，可接受，但文档中写明 | No — 不阻塞 |
| F-03 | Assumption | 跨平台路径采用 `node:path` + `node:url`，不依赖 shell | PRD §18 要求跨平台，已有 `pathToFileURL` 用例 | No |
| F-04 | Gap | `src/utils/index.ts` 未导出 `errors.ts`，需要按 mvp-contracts §7 实现错误类型 | P1.2.3 依赖此模块 | Yes — P1.2 前须实现 |

## Decision

- Ready for development: **Yes**
- Reason: 设计文档完整且足够具体，P1.1 骨架到位，所有缺口（F-01、F-04）在工作流内可解决，无需外部决策

## Required Follow-up

- Item: 安装 commander 依赖
  - Owner suggestion: P1.2 实现 subagent
  - Exit condition: `pnpm add commander` 且 package.json 含 `commander`

- Item: 实现 ZigmaFlowError 等错误类型（mvp-contracts §7）
  - Owner suggestion: P1.2 实现 subagent
  - Exit condition: `src/utils/errors.ts` 导出所有错误类型并有单测
