---
workflow: WF-CLI-COMMANDS
phase: p9p10-cli-admin-commands
step: 1 (Cases and Tests)
date: 2026-06-12
authority: docs/prd.md §17, §18; docs/architecture.md §7.1, §7.2; docs/mvp-contracts.md §2.3, §2.4
project-items: P9.3, P10.1, P10.2, P10.3
---

# WF-CLI-COMMANDS — Cases and Tests

## 0. Slice Boundary

- **Slice name:** **CLI-COMMANDS** — the four PRD §17 commands not yet
  implemented in the MVP CLI plus the `check` alias for `step`.
- **Commands delivered:**
  - `zigma-flow retry --job <id> [--reason <text>] [--with <json>]`
  - `zigma-flow abort`
  - `zigma-flow list-runs`
  - `zigma-flow show [<run-id>]`
  - `zigma-flow check --job <id>` — CLI alias for `step --job <id>`.
- **Bounded contexts:**
  - **Engine retry path** — new `retryJob(opts)` function in
    `src/engine/retryJob.ts`. Validates the job is in a retryable
    state, checks `max_attempts`, follows `on_exceeded.status` on
    exhaustion, increments `attempt`, transitions the job to `ready`,
    writes `job_retrying` events.
  - **Engine abort path** — new `abortRun(opts)` function in
    `src/engine/abort.ts`. Transitions run status from `running`/
    `blocked` to `cancelled`, writes `run_cancelled` event. Does NOT
    delete the run directory and does NOT modify individual job
    statuses (MVP simplification, PRD §18).
  - **CLI list path** — new `listRunsAction()` in
    `src/commands/list-runs.ts`. Scans `.zigma-flow/runs/*/`, reads
    `run.yml` and `state.json` for each run, sorts by `created_at`
    descending, prints one row per run, marks unreadable rows as
    `[unreadable]`.
  - **CLI show path** — new `showAction(opts)` in
    `src/commands/show.ts`. Resolves the run id (positional arg or
    active run), reads `run.yml`, `state.json`, last 5 events from
    `events.jsonl`, renders the result.
- **Bounded context interactions:**
  - **Consumes** `LocalStateStore`, `JsonlEventWriter`,
    `readActiveRun` from `src/run/index.ts`.
  - **Consumes** `loadWorkflowFile` from `src/workflow/index.ts` to
    resolve job `retry` config and validate `--job <id>` against the
    workflow definition.
  - **Produces** the engine entries `retryJob` and `abortRun`; the
    CLI actions `retryAction`, `abortAction`, `listRunsAction`,
    `showAction`; the `check` alias registration in `src/cli.ts`.
  - **MUST NOT** bypass the Engine — every state mutation goes through
    the Engine entries.
  - **MUST NOT** mutate or delete existing run directories on
    `abort`.

## 1. 功能点清单 (Function Points)

| 编号 | 功能点 | 影响文件 |
| ---- | ----- | -------- |
| FP-RETRY-CLI-1 | `retryAction` reads `active_run` and rejects with `ConfigError` when absent | `src/commands/retry.ts` |
| FP-RETRY-CLI-2 | `retryAction` validates `--job <id>` exists in the run state, throws `UserInputError` otherwise | `src/commands/retry.ts` |
| FP-RETRY-CLI-3 | `retryAction` parses `--with <json>` and forwards it as `retryInputs`; malformed JSON → `UserInputError` | `src/commands/retry.ts` |
| FP-RETRY-CLI-4 | `retryAction` forwards `--reason` (default: `"Manual retry from CLI"`) | `src/commands/retry.ts` |
| FP-RETRY-ENG-1 | `retryJob(opts)` accepts only `completed`/`failed`/`blocked` jobs; other states → `UserInputError` | `src/engine/retryJob.ts` |
| FP-RETRY-ENG-2 | `retryJob` transitions the job to `ready` (via implicit retrying), increments `attempt`, resets `current_step` | `src/engine/retryJob.ts` |
| FP-RETRY-ENG-3 | `retryJob` writes a single `job_retrying` event with reason, attempt count, retry inputs | `src/engine/retryJob.ts` |
| FP-RETRY-ENG-4 | `retryJob` honors `max_attempts`; when exceeded follows `on_exceeded.status` (default `blocked`) and writes `job_blocked`/`job_failed` instead of `job_retrying` | `src/engine/retryJob.ts` |
| FP-RETRY-ENG-5 | `retryJob` persists `retry_inputs` wholesale (no merge with prior payload) | `src/engine/retryJob.ts` |
| FP-RETRY-ENG-6 | `retryJob` writes `state.last_event_id` equal to the events.jsonl tail | `src/engine/retryJob.ts` |
| FP-ABORT-CLI-1 | `abortAction` reads `active_run` and rejects with `ConfigError` when absent | `src/commands/abort.ts` |
| FP-ABORT-ENG-1 | `abortRun(opts)` only succeeds when run status is `running` or `blocked` (or unset, defaulting to running); otherwise → `StateError` | `src/engine/abort.ts` |
| FP-ABORT-ENG-2 | `abortRun` sets `state.status = "cancelled"`, writes `run_cancelled`, leaves job statuses untouched | `src/engine/abort.ts` |
| FP-ABORT-ENG-3 | `abortRun` does NOT delete or move the run directory or any artifacts | `src/engine/abort.ts` |
| FP-ABORT-ENG-4 | `abortRun` writes `state.last_event_id` equal to the events.jsonl tail | `src/engine/abort.ts` |
| FP-LISTRUN-1 | `listRunsAction` outputs `"No runs found."` when `.zigma-flow/runs/` is missing or empty | `src/commands/list-runs.ts` |
| FP-LISTRUN-2 | `listRunsAction` prints one row per run with `run_id`, `workflow`, `status`, `created_at` | `src/commands/list-runs.ts` |
| FP-LISTRUN-3 | `listRunsAction` sorts rows by `created_at` descending | `src/commands/list-runs.ts` |
| FP-LISTRUN-4 | A run with missing/corrupted `state.json` or `run.yml` is rendered as `[unreadable]` without crashing the command | `src/commands/list-runs.ts` |
| FP-SHOW-1 | `showAction` resolves run id from positional arg; defaults to `active_run` when omitted | `src/commands/show.ts` |
| FP-SHOW-2 | `showAction` throws `ConfigError` when run directory does not exist | `src/commands/show.ts` |
| FP-SHOW-3 | `showAction` prints run info (id, workflow, task, created_at, status), one row per job (id, status, attempt), and the last 5 events | `src/commands/show.ts` |
| FP-CHECK-ALIAS-1 | `zigma-flow check --job <id>` is wired to the same `stepAction` as `step` | `src/cli.ts` |

## 2. 规范强制条款矩阵

| 条款 | 来源 | 状态 | 落点 |
| ---- | ---- | ---- | ---- |
| `state.json` 只能由 Engine 通过 State Store 写入 | mvp-contracts §2.3 约束 1 | 已纳入 | `retryJob`, `abortRun` 通过 `LocalStateStore` 写入 |
| 写入顺序：先 append event，再原子替换 snapshot | mvp-contracts §2.3 约束 2 | 已纳入 | `retryJob`, `abortRun` 实现保持顺序 |
| `state.last_event_id` 必须与 event log 尾部一致 | mvp-contracts §2.3 约束 3 | 已纳入 | T-RETRY-1/3, T-ABORT-1 末尾断言 |
| abort 不删除运行记录 | prd §18 | 已纳入 | T-ABORT-4 守护 |
| state 损坏或一致性失败时 CLI 不得继续推进 run | mvp-contracts §2.3 约束 4 | 已在 P4 实现 | 本工作流不变更 |
| Engine 是唯一状态写入者，CLI/Adapter 不得绕过 | architecture §3.1 | 已纳入 | CLI 行为只调用 Engine |

## 3. Use Cases

### UC-RETRY-1 — 合法 retry：failed job 从 attempt 1 → 2

- **设置：** workflow `implement` job `retry.max_attempts: 3`；state 中
  `implement.status = "failed"`，`attempt = 1`，`current_step = "code"`。
- **触发：** `retryJob({ runDir, runId, jobId: "implement", clock, reason: "manual" })`.
- **断言：** 写盘后 `state.jobs["implement"].status === "ready"`；
  `attempt === 2`；`current_step` 被清除；events.jsonl 末尾为
  `job_retrying`；`state.last_event_id` 指向该 tail。

覆盖：FP-RETRY-ENG-1/2/3/6 → T-RETRY-1。

### UC-RETRY-2 — 合法 retry：completed job 也可触发 retry

- **设置：** state 中 `implement.status = "completed"`，`attempt = 1`；
  `retry.max_attempts: 3`。
- **触发：** `retryJob({ runDir, runId, jobId: "implement", clock })`.
- **断言：** `implement.status === "ready"`，`attempt === 2`。

覆盖：FP-RETRY-ENG-1/2 → T-RETRY-2。

### UC-RETRY-3 — 非法状态：running job 不可 retry → `UserInputError`

- **设置：** state 中 `implement.status = "running"`。
- **触发：** `retryJob({ runDir, runId, jobId: "implement", clock })`.
- **断言：** 抛出 `UserInputError`；事件文件与 state.json 字节完全不变。

覆盖：FP-RETRY-ENG-1 → T-RETRY-3。

### UC-RETRY-4 — `max_attempts` 超出：`on_exceeded.status = "failed"`

- **设置：** workflow `retry.max_attempts: 2`，`on_exceeded.status: "failed"`；
  state 中 `implement.status = "failed"`，`attempt = 2`。
- **触发：** `retryJob({ runDir, runId, jobId: "implement", clock })`.
- **断言：** `implement.status === "failed"`；attempt 不变（保持 2）；
  events.jsonl 末尾为 `job_failed`（不是 `job_retrying`）；
  `state.last_event_id` 指向 tail。

覆盖：FP-RETRY-ENG-4 → T-RETRY-4。

### UC-RETRY-5 — `max_attempts` 超出：缺省 `on_exceeded` 默认 `blocked`

- **设置：** workflow `retry.max_attempts: 1`，无 `on_exceeded`；state
  中 `implement.status = "failed"`，`attempt = 1`。
- **触发：** `retryJob({ runDir, runId, jobId: "implement", clock })`.
- **断言：** `implement.status === "blocked"`；events.jsonl 末尾为
  `job_blocked`；无 `job_retrying`。

覆盖：FP-RETRY-ENG-4 → T-RETRY-5。

### UC-RETRY-6 — `retry_inputs` 写入

- **设置：** state 中 `implement.status = "failed"`，`attempt = 1`；
  `retry.max_attempts: 3`。
- **触发：** `retryJob({ runDir, runId, jobId: "implement", clock,
  retryInputs: { review_comments: "fix edge cases" } })`.
- **断言：** `state.jobs["implement"].retry_inputs` 严格等于
  `{ review_comments: "fix edge cases" }`；二次 retry 时整体替换（不与
  上轮合并），测试在同一用例中验证写入流程。

覆盖：FP-RETRY-ENG-2/5 → T-RETRY-6。

### UC-ABORT-1 — 正常 abort：active run 转为 cancelled

- **设置：** state 中 `status = "running"`（或缺省视同 running），有若
  干 jobs。
- **触发：** `abortRun({ runDir, runId, clock, reason: "user abort" })`.
- **断言：** `state.status === "cancelled"`；events.jsonl 末尾为
  `run_cancelled`，payload 含 `reason`；`state.last_event_id` 指向 tail。

覆盖：FP-ABORT-ENG-2/4 → T-ABORT-1。

### UC-ABORT-2 — 终态 run abort 失败：`StateError`

- **设置：** state 中 `status = "completed"`（亦覆盖 `cancelled` /
  `failed`）。
- **触发：** `abortRun({ runDir, runId, clock })`.
- **断言：** 抛出 `StateError`；事件文件与 state.json 字节完全不变。

覆盖：FP-ABORT-ENG-1 → T-ABORT-2。

### UC-ABORT-3 — `run_cancelled` 事件 payload 完整

- **设置：** 正常 active run。
- **触发：** `abortRun({ runDir, runId, clock, reason: "ctrl-c" })`.
- **断言：** 末尾 event `type === "run_cancelled"`，`run_id === runId`，
  `payload.reason === "ctrl-c"`。

覆盖：FP-ABORT-ENG-2 → T-ABORT-3。

### UC-ABORT-4 — abort 不删除运行记录

- **设置：** active run，已有若干 artifact 文件。
- **触发：** `abortRun(...)`.
- **断言：** run 目录、`state.json`、`events.jsonl`、artifact 文件均
  存在；job 状态字段未被改写为 `"cancelled"`（仅 run 级别 status 变更）。

覆盖：FP-ABORT-ENG-3 → T-ABORT-4。

### UC-LISTRUN-1 — 多 run 列表按 created_at 降序

- **设置：** `.zigma-flow/runs/` 下有 3 个 run，各 `run.yml` 中
  `created_at` 不同。
- **触发：** `listRunsAction({ zigmaflowDir })`.
- **断言：** stdout 含每个 run_id；行序按 created_at 降序；每行含
  run_id、workflow name、status、created_at。

覆盖：FP-LISTRUN-2/3 → T-LISTRUN-1。

### UC-LISTRUN-2 — 空目录 / 缺失目录

- **设置：** `.zigma-flow/runs/` 不存在或目录为空。
- **触发：** `listRunsAction({ zigmaflowDir })`.
- **断言：** stdout 为 `"No runs found."`，不抛错。

覆盖：FP-LISTRUN-1 → T-LISTRUN-2。

### UC-LISTRUN-3 — 损坏的 run 标记为 `[unreadable]`

- **设置：** `.zigma-flow/runs/` 下两个 run；第一个 `state.json` 损坏
  / 缺失，第二个完好。
- **触发：** `listRunsAction({ zigmaflowDir })`.
- **断言：** 不抛错；损坏的 run 行带 `[unreadable]` 标记（仍显示 run_id）；
  完好的 run 行正常显示。

覆盖：FP-LISTRUN-4 → T-LISTRUN-3。

### UC-LISTRUN-4 — 各 run 的状态显示与 run_id 顺序

- **设置：** 3 个 run，分别 `status: "running"`、`"completed"`、
  `"cancelled"`。
- **触发：** `listRunsAction({ zigmaflowDir })`.
- **断言：** 每行显示对应 status。

覆盖：FP-LISTRUN-2 → T-LISTRUN-4。

### UC-SHOW-1 — `show <run-id>` 显示指定 run

- **设置：** 给定 run 中 `state.status = "running"`，3 个 job，最近
  6 个 event。
- **触发：** `showAction({ zigmaflowDir, runId: "<id>" })`.
- **断言：** stdout 含 run_id、workflow、task、status、created_at；
  含每个 job 的 id 与 status；含最近 5 条 event 的 id（不含第 6 条）。

覆盖：FP-SHOW-1/3 → T-SHOW-1。

### UC-SHOW-2 — 省略 `<run-id>` 时使用 active run

- **设置：** `.zigma-flow/config.json` 中 `active_run = "<id>"`。
- **触发：** `showAction({ zigmaflowDir })`（不传 runId）。
- **断言：** 输出与 UC-SHOW-1 同一 run 的渲染结果。

覆盖：FP-SHOW-1 → T-SHOW-2。

### UC-SHOW-3 — run 不存在 → `ConfigError`

- **设置：** 未创建任何 run，或显式传入不存在的 run_id。
- **触发：** `showAction({ zigmaflowDir, runId: "does-not-exist" })`.
- **断言：** 抛出 `ConfigError`。

覆盖：FP-SHOW-2 → T-SHOW-3。

## 4. 失败测试清单 (red-phase)

Step 1 完成时所有测试必须因功能未实现（缺模块/缺字段）而失败，非语
法错误。Step 2 完成后全部通过。

### tests/engine/retryJob.test.ts

| 测试编号 | 覆盖用例 | 覆盖 FP | 失败原因 (red) |
| -------- | -------- | ------- | -------------- |
| T-RETRY-1 | UC-RETRY-1 | FP-RETRY-ENG-1/2/3/6 | `src/engine/retryJob.ts` 不存在 |
| T-RETRY-2 | UC-RETRY-2 | FP-RETRY-ENG-1/2 | 同上 |
| T-RETRY-3 | UC-RETRY-3 | FP-RETRY-ENG-1 | 同上 |
| T-RETRY-4 | UC-RETRY-4 | FP-RETRY-ENG-4 | 同上 |
| T-RETRY-5 | UC-RETRY-5 | FP-RETRY-ENG-4 | 同上 |
| T-RETRY-6 | UC-RETRY-6 | FP-RETRY-ENG-2/5 | 同上 |

### tests/engine/abort.test.ts

| 测试编号 | 覆盖用例 | 覆盖 FP | 失败原因 (red) |
| -------- | -------- | ------- | -------------- |
| T-ABORT-1 | UC-ABORT-1 | FP-ABORT-ENG-2/4 | `src/engine/abort.ts` 不存在 |
| T-ABORT-2 | UC-ABORT-2 | FP-ABORT-ENG-1 | 同上 |
| T-ABORT-3 | UC-ABORT-3 | FP-ABORT-ENG-2 | 同上 |
| T-ABORT-4 | UC-ABORT-4 | FP-ABORT-ENG-3 | 同上 |

### tests/commands/list-runs.test.ts

| 测试编号 | 覆盖用例 | 覆盖 FP | 失败原因 (red) |
| -------- | -------- | ------- | -------------- |
| T-LISTRUN-1 | UC-LISTRUN-1 | FP-LISTRUN-2/3 | `src/commands/list-runs.ts` 不存在 |
| T-LISTRUN-2 | UC-LISTRUN-2 | FP-LISTRUN-1 | 同上 |
| T-LISTRUN-3 | UC-LISTRUN-3 | FP-LISTRUN-4 | 同上 |
| T-LISTRUN-4 | UC-LISTRUN-4 | FP-LISTRUN-2 | 同上 |

### tests/commands/show.test.ts

| 测试编号 | 覆盖用例 | 覆盖 FP | 失败原因 (red) |
| -------- | -------- | ------- | -------------- |
| T-SHOW-1 | UC-SHOW-1 | FP-SHOW-1/3 | `src/commands/show.ts` 不存在 |
| T-SHOW-2 | UC-SHOW-2 | FP-SHOW-1 | 同上 |
| T-SHOW-3 | UC-SHOW-3 | FP-SHOW-2 | 同上 |

## 5. 不在范围内

- `zigma-flow retry` 命令的 commander 注册测试 — 由 `tests/cli/cli.test.ts`
  在后续 PR 修订中追加。
- `check --job` 别名的端到端验证 — 已经被 `tests/commands/step.test.ts`
  覆盖，本工作流只在 `src/cli.ts` 中追加 commander 注册。
- 多 run 并发 abort、跨进程文件锁 — 不在 MVP 范围内。
- `JobState.outputs` 显示 — `show` 命令仅显示 job id/status/attempt；
  outputs 的渲染留给后续 P11+ 工作流。

## 6. 验收标准

- T-RETRY-1..6、T-ABORT-1..4、T-LISTRUN-1..4、T-SHOW-1..3 全部通过。
- 既有 348 个测试继续通过（无回归）。
- `pnpm typecheck && pnpm lint && pnpm test` 全绿。
- CLI 实际能跑：`zigma-flow retry --job <id>` / `abort` / `list-runs` /
  `show [<run-id>]` / `check --job <id>` 在本机命令行上行为符合
  PRD §17。

## 7. 实现指南 (Step 2 提示)

新建文件：

- `src/engine/retryJob.ts` — 导出 `retryJob(opts)`. 形如 `advanceJob`，
  接受 `{ runDir, runId, jobId, clock, reason?, retryInputs? }`. 内部
  可调用 `applyRoutingAction` with `{ retry_job: jobId, retry_with: ... }`
  或直接复刻其 retry 逻辑（含 max_attempts/on_exceeded 处理）。注意：
  applyRoutingAction 会以 `signal_received` 事件标记此次 retry；
  retryJob 应避免该事件（CLI 不是 signal）。推荐：复刻 routing.ts L249
  开始的 retry_job 分支，但替换头部 `signal_received` 为直接
  `job_retrying`。
- `src/engine/abort.ts` — 导出 `abortRun({ runDir, runId, clock, reason? })`.
  类似 `accept.ts` 的结构：读取 snapshot，验证 status 非 terminal，
  append `run_cancelled` 事件，写回 snapshot with `status: "cancelled"`
  和新的 `last_event_id`. 不修改 jobs 字段。
- `src/commands/retry.ts` — CLI action：读取 active run → 调
  `retryJob` → 打印成功信息。
- `src/commands/abort.ts` — CLI action：读取 active run → 调
  `abortRun` → 打印 cancelled 消息。
- `src/commands/list-runs.ts` — `listRunsAction({ zigmaflowDir })`.
- `src/commands/show.ts` — `showAction({ zigmaflowDir, runId? })`.

修改：

- `src/cli.ts` — 注册四个新命令；新增 `check --job` 命令注册（直接复
  用 `stepAction`）。
- `src/commands/index.ts` — 导出新命令的 action 函数。
- `src/engine/index.ts` — re-export `retryJob`/`abortRun`.

## 8. 风险

| 风险 | 影响 | 应对 |
| ---- | ---- | ---- |
| `retryJob` 与 `applyRoutingAction.retry_job` 行为分叉 | 重复维护 max_attempts 逻辑 | Step 2 把 max_attempts 逻辑抽到共享 helper（可选）；最低限度跑 T-RETRY-4/5 守护行为一致 |
| abort 期间 jobs 字段不一致 | 后续 `status` 命令显示混乱 | 在 PR 描述中明示：MVP abort 仅改 run.status，jobs 字段保留以供回溯；如有用户反馈在 P11 改进 |
| Windows 上 run 目录排序 | 测试在 CI Linux 与本机不一致 | 测试用 `created_at` 字符串而非文件 mtime 排序 |
