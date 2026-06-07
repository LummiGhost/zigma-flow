# P2 Readiness Review

日期：2026-06-07
审阅人：Phase Development Supervisor
阶段：P2 — Workflow / Skill Pack Loader 与校验

## 1. 阶段目标

读取并校验 workflow YAML、Skill Pack manifest 和 lockfile，形成可测试的 published language。交付 `zigma-flow validate <path>` 命令。

## 2. 设计材料收集

| 材料 | 路径 | 状态 |
|---|---|---|
| PRD FR-002 Workflow 定义加载 | `docs/prd.md §FR-002` | 完整 |
| PRD FR-003 Skill Pack manifest 加载 | `docs/prd.md §FR-003` | 完整 |
| PRD §11 Skill Pack Manifest 规范 | `docs/prd.md §11` | 完整 |
| PRD §12 Workflow YAML 规范 | `docs/prd.md §12` | 完整 |
| PRD §17 CLI 命令面 | `docs/prd.md §17` | 完整 |
| Architecture §5.2 模块边界 | `docs/architecture.md §5.2` | 完整 |
| Architecture §6.1 领域模型 | `docs/architecture.md §6.1` | 完整 |
| Architecture §9.1 Workflow YAML 契约 | `docs/architecture.md §9.1` | 完整 |
| Architecture §9.2 Skill Pack 契约 | `docs/architecture.md §9.2` | 完整 |
| MVP Contracts §2.1 §2.2 | `docs/mvp-contracts.md §2.1-2.2` | 完整 |

## 3. 阶段范围澄清

**范围内：**
- P2.1 Workflow schema（Zod schema 定义）
- P2.2 Workflow loader（YAML 读取 + schema 校验 + 语义校验）
- P2.3 Skill Pack schema 和 loader（schema + YAML 读取 + pack 内路径校验）
- P2.4 Skill lock resolver（skill-lock.json 解析 + local:// 路径解析）
- P2.5 Validate 命令（`zigma-flow validate <path>` 分流 + 字段级错误输出）

**范围外（推迟到 P3）：**
- DAG 循环依赖检测（P3.1 DAG 解析）
- `needs`/`optional_needs` 跨 job 引用校验（P3.1）
- Run 创建（P3 系列）

**边界说明：** P2.2 的 Workflow loader 执行字段级 schema 校验和 job/step id 唯一性检查；DAG 拓扑校验（循环检测、needs 引用存在性）属于 P3.1 范围，P2 不实现，但 schema 设计需为 P3 预留字段。

## 4. 技术决策

### 4.1 YAML 解析库

**决定：** 使用 `yaml`（npm package）。

**理由：**
- 原生 ESM 支持，无 CJS 兼容问题。
- 错误包含行/列号，便于字段级错误映射。
- API 稳定，维护活跃。
- 替代方案 `js-yaml` v4 也支持 ESM，但 `yaml` 错误信息更结构化。

### 4.2 Schema 校验库

**决定：** 使用 `zod`。

**理由：**
- 提供路径级错误（`ZodError.issues[]` 含 `path` 数组），满足 FR-002/FR-003 字段级错误要求。
- TypeScript 类型推导原生支持，不需要手写类型。
- 与 ESM 完全兼容。
- 替代方案（手写 JSON Schema + ajv）调试体验差，错误路径不稳定。

### 4.3 模块边界

依据 `docs/architecture.md §5.2`：
- `src/workflow/` — workflow YAML 加载和校验
- `src/skill-pack/` — skill.yml 加载、lock resolver
- `src/commands/validate.ts` — CLI 命令处理器（调用 use case，不直接执行 loader 逻辑）

## 5. 缺口与风险

| 缺口/风险 | 影响 | 应对 |
|---|---|---|
| `yaml` 和 `zod` 尚未加入依赖 | Step 2 前必须添加 | 开发计划中明确 Step 2 首先安装依赖 |
| skill.yml 路径校验需访问文件系统 | 测试需要临时目录 | 使用 mkdtemp，参考 P1 测试模式 |
| P2.2 includes 部分 FR-002 功能（DAG 校验）超出 P2 scope | 测试设计必须明确哪些校验属于 P2 | 在 Step 1 用例文档中显式标注 P3 延迟项 |

## 6. 结论

**可以启动开发。** 设计文档完整，无需预研。依赖库选择确定（`yaml` + `zod`）。P3 边界已划清。

进入下一步：编写阶段开发计划。
