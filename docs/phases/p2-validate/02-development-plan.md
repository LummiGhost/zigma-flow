# P2 阶段开发计划

日期：2026-06-07
状态：frozen
阶段：P2 — Workflow / Skill Pack Loader 与校验

## 1. 开发目标

实现 `zigma-flow validate <path>` 命令，支持：
1. 读取和校验 workflow YAML（字段级错误，schema + 语义）
2. 读取和校验 Skill Pack manifest（字段级错误，pack 内路径校验）
3. 解析 skill-lock.json（local:// 路径解析，lockfile 完整性）
4. CLI 命令分流 workflow vs. skill.yml，输出字段级错误，退出码规范

## 2. 技术路线

| 决策 | 选择 | 理由 |
|---|---|---|
| YAML 解析 | `yaml` npm package | ESM 原生，行列号错误，稳定 |
| Schema 校验 | `zod` | 路径级错误，TypeScript 类型推导，ESM 兼容 |
| 模块边界 | `workflow/`、`skill-pack/`、`commands/validate.ts` | 遵循 architecture.md §5.2 |
| DAG 校验 | **不在 P2 范围** | P3.1 实现，schema 预留字段 |

## 3. 里程碑

| ID | 描述 | 验收标准 |
|---|---|---|
| M-P2-1 | Workflow schema 可用 | 合法/非法 fixture 经 schema 校验通过/失败 |
| M-P2-2 | Workflow loader 可用 | YAML 读取 + schema + 语义校验可测试 |
| M-P2-3 | Skill Pack loader 可用 | skill.yml 读取 + path 校验可测试 |
| M-P2-4 | Skill lock resolver 可用 | local:// 路径解析 + lockfile 错误可测试 |
| M-P2-5 | 用户可运行 `zigma-flow validate <path>` 成功验证示例文件 | CLI 对合法文件返回 0，对非法文件返回非零并输出字段级错误 |

## 4. 工作流拆分

**单一工作流：WF-P2-VALIDATE**

P2.1–P2.5 五个任务高度耦合（schema → loader → resolver → CLI），且合并符合 Step 1 粒度约束（≤3 用户任务、≤15 规范强制条款、≤2 测试文件）。作为单一工作流推进。

### 4.1 WF-P2-VALIDATE 功能点

- **FP-WF-SCH**: Workflow schema 定义（Zod）
- **FP-WF-LOAD**: YAML 读取 + YAML 语法错误包装
- **FP-WF-NORM**: Workflow definition 正规化（默认值）
- **FP-WF-SEM**: 语义校验（job id 唯一、step id 唯一、expose 引用）
- **FP-SP-SCH**: Skill Pack schema 定义（Zod）
- **FP-SP-LOAD**: skill.yml YAML 读取 + schema 校验
- **FP-SP-PATH**: Pack 内路径约束（pack 外/绝对路径/.. 越界失败）
- **FP-LK-SCH**: skill-lock.json schema 定义
- **FP-LK-RES**: local:// 路径解析
- **FP-LK-ERR**: lockfile 错误（缺 lock、缺 skill、路径不存在）
- **FP-CLI-VAL**: `validate <path>` 命令分流（workflow vs skill.yml）
- **FP-CLI-ERR**: 字段级错误输出（path + message + suggestion）
- **FP-CLI-EXIT**: 退出码规范（0 = 合法，非零 = 校验失败）

### 4.2 规范强制条款（FR-002 + FR-003 + Architecture §6.2）

| # | 来源 | 条款 | 实现状态 |
|---|---|---|---|
| RC-01 | PRD FR-002 | 校验 name、version、on、skills、permissions、signals、jobs | 已纳入 FP-WF-SCH |
| RC-02 | PRD FR-002 | 校验 job id 唯一 | 已纳入 FP-WF-SEM |
| RC-03 | PRD FR-002 | 校验 step id 在同一 job 内唯一 | 已纳入 FP-WF-SEM |
| RC-04 | PRD FR-002 | 校验 step type 属于六类 | 已纳入 FP-WF-SCH |
| RC-05 | PRD FR-002 | 校验 Agent Step expose 只能引用顶层 skills | 已纳入 FP-WF-SEM |
| RC-06 | PRD FR-002 | 校验 Router Step 控制流只使用 MVP 允许动作 | 已纳入 FP-WF-SCH |
| RC-07 | PRD FR-002 | 校验 needs/optional_needs 引用存在 job | **延迟 P3.1** (TD-P2-001) |
| RC-08 | PRD FR-002 | 校验 DAG 不存在循环依赖 | **延迟 P3.1** (TD-P2-001) |
| RC-09 | PRD FR-003 | 校验 kind: skill-pack | 已纳入 FP-SP-SCH |
| RC-10 | PRD FR-003 | 校验 exports 完整集合 | 已纳入 FP-SP-SCH |
| RC-11 | PRD FR-003 | 校验所有 path 位于 Skill Pack 目录内 | 已纳入 FP-SP-PATH |
| RC-12 | Architecture §6.2 | lockfile 记录 resolved path、version、content hash | 已纳入 FP-LK-SCH |
| RC-13 | Architecture §9.1 | Schema validator 必须给出字段级错误 | 已纳入 FP-CLI-ERR |

**技术债登记：**

- **TD-P2-001**: `needs`/`optional_needs` job 引用存在性校验 + DAG 循环检测延迟到 P3.1。
  - 引用规范：PRD FR-002 RC-07/RC-08、Architecture §6.2 WorkflowDefinition invariants。
  - 推迟原因：P3.1 专门负责 DAG 解析，P2 workflow loader 预留字段但不执行图校验。
  - 清偿期限：P3.1 完成时必须关闭。
  - 影响：`validate` 命令对 needs 引用错误或循环 DAG 不报错，直到 P3.1 完成。

## 5. 质量要求

- `typecheck`（`tsc --noEmit`）无报错
- `lint`（`tsc --noEmit`）无报错
- `test`（`vitest run`）全部通过
- 合法 fixture 经 validate 命令返回 0
- 非法 fixture 经 validate 命令返回非零 + 字段级错误输出

## 6. 预研任务

无。库选型（yaml + zod）已在 Readiness Review 中决定，无需额外预研。

## 7. 当前状态

工作流 `WF-P2-VALIDATE`：`planned`

下一动作：创建 feature 分支 + worktree，派发 Step 1 subagent（opus）。
