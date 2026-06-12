---
phase: p12-integration-quality
title: Integration Tests, Quality Gates, and MVP Release Candidate
status: frozen
date: 2026-06-12
authority: docs/prd.md §22 §23 §24
project-items: P12.1, P12.2, P12.3, P12.4
---

# P12 集成测试与质量验收开发计划

## 1. 阶段目标

验证 MVP 能在真实小任务中跑通，建立 release candidate 质量验收流程。

| 项目条目 | 描述 | 执行方式 |
|---------|------|---------|
| P12.1 | 端到端 fixture | 自动（大部分已由 TC-DOGFOOD-1..4 覆盖） |
| P12.2 | Quality gates | 自动 |
| P12.3 | Dogfood 真实流程 | **人工执行**（需要 Claude Code + 真实项目） |
| P12.4 | MVP 发布候选 | 部分自动（依赖 P12.3 结果） |

**核心验收标准：**

- TC-DOGFOOD-5: `needs_architecture_design` 信号激活 architecture-design optional job 并推进工作流（P12.1.5）。
- package.json 增加 `test:unit`、`test:integration`、`test:e2e` 分类命令（P12.2.1）。
- `pnpm build && zigma-flow --help` 可正常执行（P12.2.3）。
- 全部现有测试（376 个）继续通过。

## 2. 已完成状态分析（P12.1 覆盖度）

| P12.1 子任务 | 是否已覆盖 | 覆盖来源 |
|------------|---------|---------|
| P12.1.1 创建临时项目 fixture | ✓ 已覆盖 | `makeSandbox()` in TC-DOGFOOD-3 |
| P12.1.2 validate -> run e2e | ✓ 已覆盖 | TC-DOGFOOD-1, TC-DOGFOOD-2 |
| P12.1.3 prompt -> report -> next e2e | ✓ 已覆盖 | TC-DOGFOOD-3 |
| P12.1.4 script/check e2e | ✓ 已覆盖 | TC-DOGFOOD-3 (risk-scan check + static-check/unit-test script) |
| P12.1.5 signal optional e2e | ✗ 缺失 | **TC-DOGFOOD-5 待补充** |
| P12.1.6 review rejected retry e2e | ✓ 已覆盖 | TC-DOGFOOD-4 |

**结论：** P12.1 唯一缺口是 P12.1.5 — needs_architecture_design 信号激活 optional job 路径。

## 3. 架构决策

### AD-P12-001: WF-P12-QUALITY 合并 P12.1 缺口 + P12.2

**决策：** 将 TC-DOGFOOD-5 和 P12.2 quality gates 合并为单个工作流 WF-P12-QUALITY。

**理由：** TC-DOGFOOD-5 是一个单一测试用例；P12.2 是 package.json + 构建工具链变更。合并成一个 PR 减少协调开销。

### AD-P12-002: P12.3 需要人工执行

**决策：** P12.3 (Dogfood 真实流程) 标记为需要人工介入。流程：
1. 用户在真实项目中执行 `zigma-flow init`
2. 用户用真实 Claude Code 执行每个 job 的 prompt/step/next 命令
3. 用户记录发现的 P0/P1 问题
4. 报告映射到 P12.4.1 bugfix

### AD-P12-003: P12.2 质量门禁范围

**决策：**
- P12.2.1: 在 `package.json` 增加 `test:unit`、`test:integration`、`test:e2e` 脚本（vitest 目录过滤）
- P12.2.2: 在 `docs/` 增加 golden snapshot 更新说明（轻量文档）
- P12.2.3: 在 CI 或 package.json 增加 build smoke script（`node dist/cli.js --help`）
- P12.2.4: 跳过（npm link 需要 global install，CI 环境不可控，标记为 TD-P12-001 延期）
- P12.2.5: 已有路径兼容测试（T-INIT-6）；跨平台路径回归已覆盖

**技术债：**
- TD-P12-001: npm link smoke test 延期到 P13 或 release testing checklist

### AD-P12-004: P12.4 发布候选策略

**决策：**
- P12.4.1: Bugfix 依赖 P12.3 结果，暂时不启动
- P12.4.2-P12.4.4: 在 P12.3 完成后执行 release checklist

## 4. 工作流

### WF-P12-QUALITY

**目标：** 补充 TC-DOGFOOD-5 + 实现 P12.2 质量门禁。

**变更边界：**
- `tests/dogfood/code-change.test.ts` — 追加 TC-DOGFOOD-5
- `package.json` — 增加 test:unit、test:integration、test:e2e、smoke 脚本
- `.github/workflows/ci.yml` 或类似（如有 smoke 步骤）

**新增测试：**
- TC-DOGFOOD-5: needs_architecture_design 信号路径（plan 发出信号 → architecture-design 激活 → implement 等待 optional_needs 完成后执行）

**验收标准：**
- TC-DOGFOOD-5 通过
- `pnpm test:e2e` 执行 tests/dogfood/ 下所有测试
- `pnpm build` 成功，`node dist/cli.js --help` 输出正常
- 全部 376+ 测试继续通过

## 5. 质量门禁

`pnpm typecheck && pnpm lint && pnpm test`

## 6. 技术债登记

| ID | 描述 | 清偿期限 |
|----|------|---------|
| TD-P12-001 | npm link smoke test 未实现 | P13 或 release testing checklist |
| TD-P9-001 | ${{ jobs.<id>.outputs.<key> }} 表达式 | P13 |
| TD-P9-002 | ${{ steps.<id>.outputs.<key> }} 表达式 | P13 |

## 7. PR 结构

- **PR #24**: WF-P12-QUALITY，branch `feature/p12-integration-quality`

## 8. P12.3 人工介入说明

P12.3 Dogfood 真实流程需要用户：
1. 在一个真实小项目中安装/link zigma-flow
2. 执行 `zigma-flow init` 和 `zigma-flow run --task "..."`
3. 通过 `zigma-flow prompt --job <id> --step <id>` 获取提示词，用真实 Claude Code 执行 Agent 步骤
4. 用 `zigma-flow step --job <id>` / `zigma-flow next` 推进工作流
5. 记录遇到的问题

完成后反馈给主管，推进 P12.4。
