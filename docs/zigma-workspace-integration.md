# zigma-workspace 集成方案

状态：Proposed  
适用阶段：zigma-flow 下一阶段 workspace isolation  
外部依赖：`@zigma-ai/zigma-workspace`

## 1. 背景与目标

zigma-flow 当前支持通过 job `workspace.directory` 为 script、check 和 router step 指定已有工作目录，但不拥有该目录的创建、合并和回收生命周期；Agent step 也尚未统一使用该目录。

本方案引入由 zigma-flow Engine 编排、zigma-workspace 提供资源操作的两级隔离模型：

1. Run 启动时创建 Run workspace，作为本次工作流的集成基线。
2. Writable Job 的每个 attempt 从 Run workspace 当前 HEAD 创建独立 Job workspace。
3. Job 成功后先提交变更，再串行合并到 Run workspace。
4. Run 全部验证通过后，按显式 publish 策略交付 Run branch。
5. workspace 按结果和 retention 策略回收或保留。

目标是实现可并行、可审计、可恢复的工作区隔离，同时保持以下既有架构约束：

- Engine 是 workflow、run、job 和 step 状态转换的唯一写者。
- zigma-workspace 只拥有 Git/worktree、锁、快照、集成和资源清理。
- Agent、script、check 和 router executor 只消费 Engine 已解析的 execution context，不能自行创建或回收 workspace。
- Skill Pack 不拥有 workspace 或 workflow 状态。

## 2. 非目标

首个版本不实现：

- Docker workspace 或远程 workspace。
- 跨机器调度和共享文件系统。
- 自动解决 Git 合并冲突。
- Job 直接合并或推送到 `main`。
- step 级 workspace 生命周期。
- event sourcing 或把 zigma-workspace registry 作为 zigma-flow 的状态存储。

## 3. 两级 workspace 模型

```text
source repository / target ref
              │
              ▼
Run workspace: flow/<run-id>
      │                 │
      ▼                 ▼
Job workspace A     Job workspace B
flow/<run>/a/a1     flow/<run>/b/a1
      │                 │
      └──── serialized integration ────► Run workspace
                                             │
                                             ▼
                                   publish branch or target ref
```

| Scope | 生命周期 | 语义 |
|---|---|---|
| `external` | 外部管理 | 兼容现有 `workspace.directory`，zigma-flow 不创建、不合并、不回收 |
| `run` | 一次 Run | 本次工作流的集成 workspace，承载最终验证和交付分支 |
| `job` | 一次 Job attempt | writable Job 的隔离执行目录，成功后提交并合并到 Run workspace |

并行 Job 可以并行创建和修改各自的 workspace，但进入 Run workspace 的 integration 操作必须按 Run 串行执行。

## 4. Workflow schema

保留现有字符串形式和 `directory` 对象形式。新生命周期字段使用对象形式声明：

```yaml
name: code-change

workspace:
  provider: zigma-workspace
  repository: .
  base: main
  publish:
    strategy: branch       # none | branch | merge | fast-forward
    target: main
    conflict: block        # block | fail
  retention:
    success: cleanup
    failure: retain
    blocked: retain

jobs:
  implement:
    workspace:
      scope: job
      mode: writable
      merge:
        strategy: commit   # none | commit
        target: run
        conflict: block
    steps:
      - id: edit
        type: agent
        with:
          task: "${{ inputs.task }}"

  test:
    needs: [implement]
    workspace:
      scope: run
      mode: read-only
    steps:
      - id: unit
        type: script
        run: pnpm test
```

### 4.1 默认值与兼容性

- `workspace: <path>` 和 `workspace.directory` 等价于 `provider: external`、`scope: external`。
- 顶层 `workspace` 定义 Run workspace；Job 定义覆盖 `scope`、`mode`、`merge` 和 `retention`。
- 有 managed Run workspace 时，writable Job 默认 `scope: job`；read-only Job 默认 `scope: run`。
- 首版 `publish.strategy` 默认 `branch`，不得默认更新 `main`。
- `read-only` 仍由 zigma-flow Workspace Guard 检测修改。zigma-workspace 的 Git `core.readOnly` 标记不是安全边界。

## 5. Engine 边界

zigma-flow 在 `src/workspace` 定义端口，由 composition root 注入外部适配器：

```ts
interface WorkspaceProvider {
  prepareRun(input: PrepareRunWorkspaceInput): Promise<RunWorkspaceHandle>;
  prepareJob(input: PrepareJobWorkspaceInput): Promise<JobWorkspaceHandle>;
  snapshot(handle: WorkspaceHandle): Promise<WorkspaceEvidence>;
  integrateJob(input: IntegrateJobInput): Promise<IntegrationResult>;
  publishRun(input: PublishRunInput): Promise<PublishResult>;
  cleanup(handle: WorkspaceHandle): Promise<CleanupResult>;
  inspect(handle: WorkspaceHandle): Promise<WorkspaceStatus>;
}
```

建议模块：

```text
src/workspace/provider.ts
src/workspace/externalProvider.ts
src/workspace/zigmaWorkspaceProvider.ts
src/engine/workspaceLifecycle.ts
src/engine/workspaceReconcile.ts
```

依赖方向为：

```text
Engine -> WorkspaceProvider port <- zigma-workspace adapter
```

优先使用 zigma-workspace 的 TypeScript 公共 API。CLI 只用于人工诊断，避免 shell JSON 解析、额外 helper process 和取消/reaping 风险。

## 6. 生命周期

### 6.1 Run 初始化

1. Engine 解析 repository、base ref 和 base commit。
2. 使用 `operation_id=run:<runId>:create` 创建 `flow/<runId>` Run workspace。
3. 将 workspace 绑定到 `flowRunId`。
4. 把 workspace ID、绝对路径、base commit、branch 和 lifecycle 写入 Run state。
5. 发出 `run_workspace_created` 后才允许调度 Job。

Run workspace 创建失败时，Run 失败且不得启动 Job。

### 6.2 Job attempt 初始化

1. Engine 短暂获取 Run integration lock，读取 Run workspace 当前 HEAD，记为 `job_base_commit`，然后释放锁。
2. 从该精确 commit 创建分支 `flow/<runId>/<jobId>/a<attempt>`。
3. 使用 `operation_id=run:<runId>:job:<jobId>:attempt:<n>:create` 保证重试幂等。
4. Engine 记录 workspace handle，发出 `job_workspace_created`。
5. 同一个绝对 `cwd` 必须传给 Agent、script、check 和 router executor。

Job retry 创建新的 attempt workspace，默认从 Run workspace 最新 HEAD 开始，不复用失败 workspace。

### 6.3 Job 成功与集成

Job 的最后一个 step 成功后，Engine 依次执行：

1. Workspace Guard、protected path 和 forbidden path 检查。
2. 收集包含 tracked、untracked、rename、delete 和 binary change 的 evidence。
3. 创建 snapshot 和 diff artifact。
4. `git add --all` 并创建 Job commit；无变更时记录 no-op evidence。
5. 获取 Run integration 排他锁。
6. 使用 expected Run HEAD 执行三方 merge，并记录 Job commit 和 resulting Run commit。
7. 可选执行 post-merge 快速检查。
8. 发出 `job_workspace_merged` 并释放锁。
9. Engine 此后才写 `job_completed`。
10. 根据 retention 策略清理或保留 Job workspace。

不得通过复制文件或只应用现有 patch 完成集成；Git commit 是完整变更和合并边界，patch 只是审计 artifact。

### 6.4 冲突

合并冲突时：

- 中止 merge，使 Run workspace 回到 integration 前 HEAD。
- 保留 Job workspace、Job commit 和 snapshot。
- Job 进入 `blocked`，reason 为 `workspace_merge_conflict`。
- 发出 `job_workspace_merge_blocked`，记录冲突文件、Job commit、Run HEAD 和 operation ID。
- 允许后续 `retry-merge` 或 `discard`；首版不自动 rebase 或自动解决冲突。

### 6.5 失败、取消和重试

- Job 执行失败：不合并，创建 best-effort snapshot，默认保留 workspace。
- Run 取消：先传播取消、等待并 reap 子进程，再处理 snapshot 和 cleanup。
- fail-fast：同批 Job 完成取消收敛后分别进入保留或清理策略。
- attempt 1 失败、attempt 2 成功时，只允许 attempt 2 的 commit 进入 Run workspace。

### 6.6 Run publish

所有 Job 集成完成后，最终 validation 必须在 Run workspace 上运行。通过后按显式策略交付：

| 策略 | 行为 |
|---|---|
| `none` | 不更新 ref，保留 evidence |
| `branch` | 保留或推送 `flow/<runId>` 分支 |
| `merge` | 将 Run branch 合并到显式 target |
| `fast-forward` | 仅当 target 未前进时更新 target |

只有 publish 成功后才能发出 `run_workspace_published`。首版推荐只实现 `none` 和 `branch`；`merge` 与 `fast-forward` 在 zigma-workspace 严格 publish 契约稳定后开启。

## 7. 状态与事件

zigma-flow workflow state 和 zigma-workspace resource state 分别持有，不互相替代。

Run state 中保存可恢复 handle：

```json
{
  "workspace": {
    "provider": "zigma-workspace",
    "id": "ws_run_xxx",
    "path": "D:\\...\\ws_run_xxx",
    "base_commit": "abc123",
    "branch": "flow/run-123",
    "lifecycle": "ready"
  },
  "jobs": {
    "implement": {
      "attempt": 1,
      "workspace": {
        "id": "ws_job_xxx",
        "scope": "job",
        "base_commit": "abc123",
        "head_commit": "def456",
        "integration_commit": null,
        "lifecycle": "executing"
      }
    }
  }
}
```

建议 lifecycle：

```text
unassigned -> provisioning -> ready -> executing -> snapshotting
           -> integrating -> integrated -> cleaning -> cleaned
```

异常状态包括 `provision_failed`、`execution_failed`、`integration_blocked`、`cleanup_failed` 和 `retained`。

新增 Engine 事件：

- `run_workspace_provisioning`
- `run_workspace_created`
- `job_workspace_provisioning`
- `job_workspace_created`
- `job_workspace_snapshot_created`
- `job_workspace_integration_started`
- `job_workspace_merged`
- `job_workspace_merge_blocked`
- `workspace_cleanup_started`
- `workspace_cleaned`
- `workspace_cleanup_failed`
- `run_workspace_publish_started`
- `run_workspace_published`

事件至少携带 `run_id`、可选 `job_id`、`attempt`、`workspace_id`、`operation_id`、`base_commit` 和 `head_commit`。

## 8. 并发与一致性

- workspace 创建和 Job 执行可以并行。
- 每个 Run 只有一把 integration 排他锁。
- 等待 integration lock 的 Job 显示为 `integrating`，不能继续显示为 step execution。
- Job 基于旧 Run HEAD 但无冲突时允许三方 merge。
- 冲突时 block，不能在不重新验证的情况下自动 rebase。
- 最终 validation 必须观察所有已集成 Job 的 resulting Run HEAD。

## 9. 崩溃恢复

`resume` 必须先执行 reconcile，而不是直接重复创建或合并：

1. 从 Run state 读取 workspace ID、operation ID 和 expected HEAD。
2. 查询 zigma-workspace registry、manifest、目录、Git HEAD 和锁。
3. 按实际资源状态收敛：

| 记录状态 | 实际状态 | 恢复动作 |
|---|---|---|
| `provisioning` | workspace 已存在 | 采用现有 handle，补齐 Engine 状态和事件 |
| `provisioning` | 资源不存在 | 使用相同 operation ID 重试 create |
| `integrating` | resulting commit 已存在 | 确认为成功，不重复 merge |
| `integrating` | merge 未发生 | 使用 expected HEAD 幂等重试 |
| `cleaning` | 目录已不存在 | 收敛为 cleaned |
| `cleaned` | 目录仍存在 | 标记 cleanup_failed 并重试清理 |

完成判定必须使用 `operation_id + expected_head + resulting_commit`，不能只依赖最后一条事件。

## 10. zigma-workspace 前置能力

zigma-flow 开始 managed workspace 集成前，zigma-workspace 需要提供：

1. 严格的 `commitWorkspace`、`integrateWorkspace`、`publishWorkspace` 和 `abortIntegration` API。
2. 写操作支持 `operationId`、`expectedState` 和 `expectedHead`。
3. 完整处理 tracked、untracked、rename、delete 和 binary changes。
4. Git 查询失败不得伪装成空 diff 或无变更。
5. cleanup 只有在目录和 worktree registration 确认回收后才能进入 cleaned；失败必须保持可重试状态。
6. create/integrate/cleanup operation journal 和 `reconcileWorkspace`。
7. owner 校验、lease、heartbeat、过期接管和原子获取的 integration lock。
8. 所有返回结果提供可审计的 base、head、resulting commit、changed files 和 artifact digest。
9. Windows 长路径、中文路径、文件占用、进程终止和重复恢复测试。

对应 GitHub Issue：[`LummiGhost/zigma-workspace#22`](https://github.com/LummiGhost/zigma-workspace/issues/22)。

## 11. 分阶段实施

### Stage 0：冻结契约

- 确认本方案和 schema 命名。
- 决定首版 publish 仅支持 `none/branch`。
- 冻结错误码、事件和 evidence 字段。

### Stage 1：补齐 zigma-workspace

- 实现第 10 节的严格集成、清理、锁和 reconcile 契约。
- 通过 zigma-workspace 自身 contract、real Git 和 Windows 测试。

回滚：zigma-flow 尚未调用新接口。

### Stage 2：Run workspace

- 引入 `WorkspaceProvider` 和 external provider。
- 实现 Run create、bind、resume reconcile 和 retention。
- 将 Agent、script、check、router 统一到 execution context cwd。

回滚：使用 `provider: external` 保持现有目录语义。

### Stage 3：Job workspace 与 integration

- attempt 级 workspace。
- commit、串行 merge、冲突 block。
- failure/cancel evidence 和 retention。

回滚：关闭 Job isolation，只保留 Run workspace。

### Stage 4：publish 和 GC

- 开启 `branch` publish。
- 在契约稳定后增加 `merge/fast-forward`。
- 增加 doctor、reconcile 和 orphan GC。

## 12. 验收标准

- 单 writable Job 能创建、执行、提交、合并和清理。
- 两个并行 Job 修改不同文件时均能合并。
- 两个并行 Job 修改同一行时，后合并者进入 blocked，Run workspace 无残留冲突状态。
- Job 失败不合并，并保留可核验 snapshot。
- attempt 1 失败、attempt 2 成功时只合并 attempt 2。
- create、commit、integration、publish 和 cleanup 在进程崩溃后均可 resume。
- 相同 operation ID 的重试不产生重复 workspace、commit 或 merge。
- untracked、rename、delete 和 binary changes 不丢失。
- Agent、script、check 和 router 使用同一个 resolved workspace cwd。
- 取消时子进程先终止并被 reap，workspace 才进入 cleanup。
- cleanup 删除失败准确表现为 cleanup_failed。
- 最终 validation 在所有 Job 合并后的 Run workspace 上执行。
- Windows 长路径、中文路径和文件占用场景有自动化证据。

## 13. 架构决策摘要

- 采用 Run workspace + Job attempt workspace 两级模型，拒绝并行 Job 直接写用户工作区。
- 采用 Git commit 作为集成边界，拒绝文件复制和不完整 patch 作为合并协议。
- 并行执行、串行 integration，冲突进入 blocked 而不是自动修复。
- zigma-flow Engine 拥有业务状态，zigma-workspace 拥有资源操作，两者通过端口和版本化契约集成。
- 首版 publish 默认 `branch`，不隐式更新 `main`。
