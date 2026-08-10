# Zigma 统一项目目录设计

状态：Proposed

适用范围：Zigma 组件在项目仓库内使用的配置、人工维护资源和运行时状态

目标版本：下一阶段目录规范迁移

## 1. 背景

Zigma 各组件目前分别在项目根目录创建自己的工作目录。例如，zigma-flow 使用
`.zigma-flow/`，其他组件采用类似的独立目录。随着组件增加，这种结构会产生以下问题：

- 项目根目录出现多个 Zigma 专用目录，缺少统一入口。
- 配置、人工维护资源和运行时状态混在组件目录中，文件所有权不清晰。
- 多个组件可能重复定义相同配置或各自维护项目发现逻辑。
- 项目根 `.gitignore` 需要持续追加各组件的运行时路径。
- 跨组件共享 workflow、skill、policy 或 template 时缺少稳定位置。

本设计将所有项目级 Zigma 内容收敛到唯一的 `.zigma/` 目录，并明确区分：

1. 人工维护且需要版本控制的项目源文件。
2. 组件私有、可再生成且不应纳入版本控制的运行时状态。

本文中的“Zigma 项目目录”与 Agent 实际执行代码修改的 Run/Job workspace 是两个不同概念。
Run/Job workspace 的创建、隔离、合并和回收仍遵循
[`zigma-workspace-integration.md`](zigma-workspace-integration.md)。

## 2. 设计目标

- 一个项目最多只有一个 `.zigma/` 项目目录。
- 所有组件共享同一个人工配置入口 `.zigma/config.yml`。
- Workflow、Skill、Policy 和 Template 等人工维护资源位于 `.zigma/` 公共区域。
- 每个组件拥有独立的私有状态目录 `.zigma/.<component>/`。
- 组件私有状态目录只保存生成文件、缓存、锁、临时文件和运行记录。
- `.zigma/` 使用自己的 `.gitignore`，不要求修改项目根 `.gitignore`。
- 迁移期间避免新旧目录双写，并提供可回滚的显式迁移路径。
- 目录调整不得改变 Engine 作为 workflow state 唯一写者的架构边界。

## 3. 非目标

本设计不负责：

- 定义 Run/Job Git workspace 的完整生命周期。
- 将实际 Git worktree 强制放入项目内的 `.zigma/`。
- 引入远程配置中心或远程状态存储。
- 设计跨项目的用户级全局配置目录。
- 允许组件直接读取或修改其他组件的私有状态。
- 在本次迁移中重新设计 Workflow、Skill Pack 或 Engine 状态机语义。

## 4. 术语

| 术语 | 定义 |
| --- | --- |
| Zigma 项目目录 | 项目根目录下唯一的 `.zigma/` |
| 公共区域 | `.zigma/` 内由人工维护、可供多个组件消费并应被 Git 跟踪的内容 |
| 组件私有目录 | `.zigma/.<component>/`，只保存组件生成的非跟踪状态 |
| 项目源文件 | 配置、workflow、skill、policy、template 等人工维护文件 |
| 运行时状态 | run state、event、artifact、cache、lock、journal 和临时文件 |
| Execution workspace | Agent、script 或 check 实际执行的 Run/Job 工作区，不等同于 `.zigma/` |

## 5. 目标目录结构

```text
<project-root>/
└─ .zigma/
   ├─ .gitignore
   ├─ config.yml
   │
   ├─ workflows/
   │  ├─ code-change.yml
   │  └─ release.yml
   │
   ├─ skills/
   │  └─ code-change/
   │     ├─ skill.yml
   │     ├─ prompts/
   │     ├─ knowledge/
   │     ├─ scripts/
   │     └─ checks/
   │
   ├─ policies/
   ├─ templates/
   │
   ├─ .flow/
   │  ├─ runs/
   │  ├─ active-run.json
   │  ├─ cache/
   │  ├─ locks/
   │  └─ tmp/
   │
   ├─ .workspace/
   │  ├─ registry/
   │  ├─ operations/
   │  ├─ locks/
   │  └─ cache/
   │
   └─ .skill/
      ├─ registry/
      ├─ cache/
      └─ tmp/
```

首版组件私有目录名称固定为：

| 组件 | 私有目录 |
| --- | --- |
| zigma-flow | `.zigma/.flow/` |
| zigma-workspace | `.zigma/.workspace/` |
| zigma-skill | `.zigma/.skill/` |

新增组件不得自行选择可能冲突的简称。组件私有目录名称应纳入公共目录规范登记。

## 6. 文件分类与所有权

文件位置由“是否人工维护、是否需要版本控制”决定，而不是仅由“哪个组件使用”决定。

### 6.1 公共人工维护区

以下内容直接位于 `.zigma/`，即使当前主要由单一组件消费：

- `.zigma/config.yml`：统一项目配置。
- `.zigma/workflows/`：workflow 定义。
- `.zigma/skills/`：skill 定义、prompt、knowledge、script 和 check 资源。
- `.zigma/policies/`：跨组件或项目级策略。
- `.zigma/templates/`：需要审阅和复用的模板。
- 未来经架构决策批准的其他人工维护目录。

这些文件属于项目源文件，正常参与 Git diff、review 和版本追踪。

### 6.2 组件私有状态区

`.zigma/.<component>/` 只能保存：

- Run、Job 或 operation 状态。
- Event log 和 artifact。
- Cache 和可重建索引。
- Lock、lease 和 heartbeat。
- Operation journal。
- 临时文件和中间结果。
- 当前运行指针等机器状态。

私有目录中的内容不得成为 workflow、skill 或项目配置的唯一事实来源。删除整个私有目录后，
组件可以丢失历史运行记录，但不能丢失项目声明和人工决策。

### 6.3 文件所有权表

| 路径 | 写入者 | 人工编辑 | Git 跟踪 |
| --- | --- | --- | --- |
| `.zigma/config.yml` | 显式 config/init 命令或用户 | 是 | 是 |
| `.zigma/workflows/` | 用户或显式 workflow 管理命令 | 是 | 是 |
| `.zigma/skills/` | 用户或显式 skill 管理命令 | 是 | 是 |
| `.zigma/policies/` | 用户 | 是 | 是 |
| `.zigma/templates/` | 用户 | 是 | 是 |
| `.zigma/.flow/` | zigma-flow runtime | 否 | 否 |
| `.zigma/.workspace/` | zigma-workspace runtime | 否 | 否 |
| `.zigma/.skill/` | zigma-skill runtime | 否 | 否 |

普通的 `run`、`resume`、`next`、`retry` 或后台执行不得修改公共人工维护区。

## 7. 统一配置

### 7.1 文件和命名空间

统一配置文件为：

```text
.zigma/config.yml
```

配置采用顶层组件命名空间：

```yaml
version: 1

flow:
  agent:
    backend: codex
    parallelism: 4
  defaults:
    workflow: code-change

workspace:
  provider: git-worktree
  publish:
    strategy: branch
  retention:
    success: cleanup
    failure: retain

skill:
  discovery:
    paths:
      - ./skills
```

规则如下：

1. `version` 表示整个 Zigma 项目配置格式版本。
2. 每个组件只能解释和修改自己的顶层命名空间。
3. 未安装组件的命名空间必须原样保留。
4. 跨组件配置必须提升为公共字段并经过版本化设计，不能重复定义。
5. 组件不能通过重写完整 YAML 的方式删除未知字段或注释。
6. 配置写入必须是显式用户操作，并采用临时文件加原子替换。

### 7.2 配置优先级

所有组件统一采用：

```text
CLI 参数 > 环境变量 > .zigma/config.yml > 组件默认值
```

Workflow 文件中的运行声明仍按其 schema 生效，不作为项目级组件配置的替代品。

### 7.3 状态与密钥不得写入配置

当前 `active_run` 一类运行指针不属于人工配置，目标位置为：

```text
.zigma/.flow/active-run.json
```

API key、token 等密钥不得直接存入可跟踪的 `config.yml`。配置只记录环境变量名称或外部
credential provider：

```yaml
flow:
  agent:
    backends:
      custom:
        api_key_env: CUSTOM_API_KEY
```

## 8. `.zigma/.gitignore`

`.zigma/.gitignore` 由 Zigma 初始化，建议纳入版本控制。项目根 `.gitignore` 不再增加
Zigma 运行时路径。

初始内容：

```gitignore
# Zigma component-private generated state
/.flow/
/.workspace/
/.skill/

# Shared temporary files, if introduced
/tmp/
```

约束：

- 必须显式列出组件私有目录，禁止使用 `.*` 等宽泛规则。
- 不得忽略整个 `.zigma/`，否则公共人工文件无法正常跟踪。
- 组件初始化以幂等方式确保自己的条目存在。
- 普通运行命令发现条目缺失时只报警，不擅自修改人工文件。
- 组件卸载默认不删除 ignore 条目，避免遗留状态突然出现在 Git 中。
- `doctor` 应检测私有目录文件是否已经被 Git 跟踪。

如果旧项目根 `.gitignore` 已包含 `.zigma-flow` 条目，迁移工具默认只提示，不自动修改，
因为该文件可能包含用户定制规则。

## 9. 公共路径解析契约

各组件不得在业务逻辑中重复硬编码目录。应通过公共路径解析契约获得路径：

```ts
interface ZigmaProjectLayout {
  projectRoot: string;
  zigmaRoot: string;
  configFile: string;
  workflowsDir: string;
  skillsDir: string;
  policiesDir: string;
  templatesDir: string;
  componentState(component: string): string;
}
```

逻辑依赖方向为：

```text
CLI / Engine / Component
          │
          ▼
Zigma Project Layout
          │
          ├─ public authored paths
          └─ private component-state paths
```

该契约可以由小型共享包实现，也可以先形成版本化规范并在各组件内实现兼容解析器。无论采用
哪种方式，路径常量、项目根发现顺序和错误语义必须保持一致。

组件边界：

- 组件可以创建和写入自己的私有目录。
- 组件不得直接写入其他组件的私有目录。
- 跨组件状态访问必须通过公开 API 或版本化契约。
- 组件只有在显式 init/add/config 命令中才能修改公共人工区。
- zigma-flow runtime state 仍只能通过 Engine 所有的状态入口写入。

## 10. 与 Execution Workspace 的关系

`.zigma/` 是项目控制目录；Run/Job workspace 是 Agent、script 和 check 实际执行代码修改的
目录。两者不能混用。

推荐布局：

```text
.zigma/.workspace/       registry、lock、journal 和 cache
外部 managed directory  实际 Run/Job Git worktree
```

不强制把实际 Git worktree 放在 `.zigma/.workspace/` 下，原因包括：

- 避免在源仓库内形成嵌套 Git worktree。
- 避免项目扫描器、watcher、lint 和搜索工具误扫工作副本。
- 降低 Windows 长路径风险。
- 资源清理失败时不污染源项目目录。

zigma-flow Engine 继续拥有 workflow、run、job 和 step 状态；zigma-workspace 只拥有 Git/worktree、
锁、快照、集成与清理等资源操作。

## 11. 项目发现规则

新布局启用后的发现顺序：

```text
存在 .zigma/       -> 使用新布局
仅存在 .zigma-flow/ -> 使用旧布局兼容适配器并显示迁移提示
两者同时存在        -> 报歧义错误，要求显式选择或迁移
两者均不存在        -> 提示执行 init
```

不得通过文件修改时间、目录内容数量或组件版本静默选择其中一个目录。

如果命令允许显式项目根参数，该参数只决定从哪个项目根查找 `.zigma/`，不能绕过双目录冲突检查。

## 12. 迁移设计

迁移采用“旧路径只读兼容、新路径唯一写入”，禁止长期双写。

### Stage 0：冻结规范

- 冻结组件私有目录简称。
- 冻结 `config.yml` 顶层命名空间和 schema version。
- 定义路径冲突、配置冲突和迁移错误码。
- 为现有 `.zigma-flow` 内容建立分类清单。

回滚：尚未改变运行时行为。

### Stage 1：引入路径解析层

- 所有命令通过统一 resolver 访问项目目录。
- 保持 `.zigma-flow` 现有行为。
- 增加新旧布局发现和冲突测试。

回滚：切回 legacy resolver。

### Stage 2：新项目采用 `.zigma`

`init` 只创建：

```text
.zigma/.gitignore
.zigma/config.yml
.zigma/workflows/
.zigma/skills/
.zigma/.flow/
```

`init` 不修改项目根 `.gitignore`。

回滚：旧版本工具不能直接运行新项目，但项目源文件仍保持可读，无状态数据迁移风险。

### Stage 3：显式迁移命令

建议提供：

```text
zigma migrate layout --dry-run
zigma migrate layout
```

若统一 `zigma` CLI 尚未提供，可临时由组件暴露 `zigma-flow migrate-layout`，但迁移契约必须属于
Zigma 项目目录规范。

路径映射：

| 旧路径 | 新路径 |
| --- | --- |
| `.zigma-flow/config.json` 的人工配置 | `.zigma/config.yml` 的 `flow:` |
| `.zigma-flow/workflows/` | `.zigma/workflows/` |
| `.zigma-flow/skills/` | `.zigma/skills/` |
| `.zigma-flow/runs/` | `.zigma/.flow/runs/` |
| 运行指针和锁 | `.zigma/.flow/` 对应状态文件 |
| 组件缓存和临时文件 | `.zigma/.flow/cache/` 或 `.zigma/.flow/tmp/` |

迁移流程：

1. 扫描新旧目录、Git 跟踪状态和目标冲突。
2. 生成 dry-run 报告，不修改任何文件。
3. 在 `.zigma-migration-tmp/` 或系统临时目录构建完整目标结构。
4. 转换 JSON 配置为 YAML，并通过新 schema 校验。
5. 校验 workflow、skill 和可迁移 run 状态。
6. 原子地将准备好的目录切换为 `.zigma/`。
7. 保留旧目录，直到用户确认或显式执行 cleanup。
8. 写入迁移结果和仍需人工处理的根 `.gitignore` 提示。

迁移不得覆盖目标中已有的不同内容。发现 `.zigma/` 和 `.zigma-flow/` 均有人工文件时必须停止，
输出逐文件冲突清单。

### Stage 4：兼容期

- 新 run 只写 `.zigma/.flow/`。
- 旧布局仅允许兼容读取，不再接收新状态。
- 旧 run 可只读查看，或通过显式迁移命令复制并验证。
- 所有旧布局命令输出弃用提示和迁移命令。

回滚：恢复旧版本时仍可使用保留的 `.zigma-flow/`，但新布局产生的 run 不自动反向迁移。

### Stage 5：移除旧布局

- 经过明确的弃用周期后删除 `.zigma-flow` 自动发现。
- 独立保留 migration 工具至少一个发布周期。
- 清理源代码、测试、示例和当前文档中的旧路径。
- 历史 phase 文档保留原始路径时应标注其历史语境，不进行无差别改写。

## 13. 一致性、失败与恢复

### 13.1 禁止双写

同一命令不得同时更新 `.zigma-flow` 和 `.zigma`。双写会造成 active run、event 和配置的
先后顺序无法可靠恢复。

### 13.2 配置写入失败

- 新配置必须先写临时文件并完成解析和 schema 校验。
- 原子替换成功前保留原配置。
- 未知组件命名空间和字段必须保留。
- 任一组件配置错误时，不得自动删除或重写该命名空间。

### 13.3 迁移中断

- 准备阶段只写临时目录，不改变旧布局。
- 切换阶段记录 migration journal。
- 恢复时根据 journal 和目标目录 hash 判断采用目标或回退旧目录。
- 不能仅以目录存在作为迁移成功依据。

### 13.4 Git 跟踪异常

如果私有状态已经被 Git 跟踪，`.gitignore` 不会自动停止跟踪。迁移或 `doctor` 应给出明确的
`git rm --cached` 建议，但不得在普通运行期间自动修改 Git index。

## 14. 安全与隐私

- 迁移工具扫描旧配置时应检测疑似明文 token 或 API key，并在报告中脱敏。
- 明文密钥不得复制到 `.zigma/config.yml`；应转换为环境变量引用或要求人工处理。
- 错误信息不得打印配置中的 secret 值。
- `.zigma/.gitignore` 是防误提交措施，不是安全边界；运行时仍需避免在不必要位置持久化密钥。
- Artifact、event 和日志继续遵循各组件的数据最小化与脱敏规则。

## 15. 验收标准

### 15.1 目录与 Git

- 新项目只创建 `.zigma/`，不创建 `.zigma-flow/`。
- `init` 不修改项目根 `.gitignore`。
- `.zigma/.gitignore` 自身可被跟踪。
- `.zigma/config.yml`、workflows、skills、policies 和 templates 可正常跟踪。
- `.zigma/.flow/`、`.workspace/` 和 `.skill/` 中的内容默认被忽略。
- 私有目录被意外跟踪时 `doctor` 能准确报告。

### 15.2 配置

- 所有组件从同一个 `config.yml` 读取各自命名空间。
- CLI、环境变量、配置文件和默认值的优先级一致。
- 未安装组件和未知字段在配置更新后保持不变。
- `active_run` 等运行状态不写入 `config.yml`。
- 明文密钥迁移不会进入可跟踪配置。

### 15.3 组件边界

- zigma-flow 普通运行只写 `.zigma/.flow/`。
- 组件不能通过公共 resolver 获得其他组件私有目录的写权限。
- Engine 仍是 Flow 状态转换的唯一写者。
- 删除一个组件的私有目录不会删除公共 workflow、skill 或配置。

### 15.4 迁移

- Dry-run 不修改文件、Git index 或配置。
- 新旧目录同时存在时不会静默选择。
- 配置转换失败时旧项目保持可用。
- 迁移中断可根据 journal 恢复或回滚。
- 迁移不会覆盖已存在且内容不同的人工文件。
- 兼容期内只有 `.zigma` 接收新写入。

### 15.5 平台

- Windows 中文路径、空格路径和长路径通过自动化测试。
- 文件占用导致切换或清理失败时，错误可恢复且不会破坏旧布局。
- Linux 和 macOS 上 `.gitignore` 与路径发现行为一致。

## 16. 需要同步修改的代码和文档

实施时至少涉及：

- CLI 项目发现、`init`、`run`、`validate` 和管理命令。
- Config loader 及 schema。
- Run、artifact、event、active-run 和 lock 路径。
- Skill discovery 路径。
- Protected runtime file checks。
- 测试 sandbox 和 fixture。
- README、PRD、architecture、MVP contracts 中的当前路径说明。
- 示例项目和初始化模板。

历史 phase 设计文档不应机械替换；只修订仍被视为当前契约的文档，并通过迁移文档解释旧路径。

## 17. 架构决策建议

建议后续确认并记录以下 ADR：

1. 每个项目只有一个 `.zigma` 项目目录。
2. 人工维护内容位于公共区域，组件私有目录只保存非跟踪状态。
3. 统一配置使用 `.zigma/config.yml` 和组件顶层命名空间。
4. Zigma ignore 规则由 `.zigma/.gitignore` 自包含。
5. 旧布局采用单写迁移，禁止新旧目录长期双写。
6. `.zigma/` 不等同于 execution workspace，实际 Git worktree 可位于项目外部。

## 18. 决策摘要

- 采用 `.zigma/` 作为唯一项目级入口。
- 采用“公共人工区 + 隐藏组件私有状态区”的两层模型。
- Workflow 和 Skill 是项目源文件，不归入 `.flow` 或 `.skill` 私有状态目录。
- 采用单一 YAML 配置，并以组件命名空间隔离所有权。
- 将 active run 等易变状态从人工配置中移出。
- 使用 `.zigma/.gitignore` 管理运行时忽略规则，不污染项目根 `.gitignore`。
- 迁移过程只允许新路径写入，不采用双写同步。
- 继续保持 Engine、Skill Pack 和 workspace provider 的既有职责边界。
