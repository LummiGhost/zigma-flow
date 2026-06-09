# WF-P6-SCRIPT — Cases and Tests

- Workflow: WF-P6-SCRIPT
- Phase: P6 Script Step
- Step: 1 (Cases and Tests)
- Date: 2026-06-08
- Author: subagent (workflow Step 1)

## Slice Boundary

- Slice name: **P6-SCRIPT**
- Bounded contexts:
  - **Script Executor / Engine command body** (architecture.md §7.1, §12.3,
    §13 phase 6). Owns the body of `executeCurrentStep` for `type: script`
    and the new `executeScriptStep(opts)` orchestrator in
    `src/script/executor.ts`.
  - **Event Sequencer** for script-step events (architecture.md §7.3,
    mvp-contracts.md §2.4) — sequences `step_started` →
    `script_completed` → `step_completed | step_failed` → `job_completed`.
  - **Step Schema extension** in `src/workflow/index.ts` —
    `StepBaseSchema` gains explicit `run`, `shell`, `timeout`, `cwd`,
    `env`, `on_failure`.
- Bounded context interactions:
  - **Consumes** `ProcessRunner` from WF-P6-RUNNER. P6-SCRIPT depends on
    the port interface, not on the `execa` adapter. The runner is
    injected via `opts.runner` (D5 in the development plan).
  - **Consumes** `writeArtifact`, `artifactId` from
    `src/artifact/index.js` to persist stdout / stderr / result.json.
  - **Consumes** `JsonlEventWriter`, `LocalStateStore`, `nextEventId`
    from `src/run/index.js` and `src/events/index.js` for events and
    state snapshot.
  - **Produces** the only legal `ready → running →
    completed | failed` transition for a script step. Architecture §5.2
    and ADR-003: Engine is the sole state mutator.
  - **MUST NOT** be called directly by the CLI — `stepAction` from
    WF-P6-DISPATCH is the only caller in P6. The Engine wrapper
    `executeCurrentStep` is the public surface; `executeScriptStep` is
    the script-specific worker invoked by it.
  - **MUST NOT** include router / check / human / workflow step handling
    in P6 — those are TD-P6-001, deferred.
  - **MUST NOT** advance `current_step` to a sibling step within the same
    job — TD-P6-004 defers multi-step job progression to P8. P6 only
    validates single-step jobs end-to-end; for jobs with multiple
    sibling steps the post-step `job_completed` assertion is gated on
    "no remaining steps after the current one".

## Workflow Goal

Deliver the complete inline-script execution pipeline so that a user who has
already created a run (WF-P3-RUN) and ran `zigma-flow step --job <job>`
(WF-P6-DISPATCH) sees their workflow's script step execute: the step
command is resolved (inline `run` or Skill Pack `uses`), the subprocess is
executed through the injected `ProcessRunner`, stdout / stderr are persisted
as artifacts, a `ScriptResult` is written to disk, the corresponding
`step_started` / `script_completed` / `step_completed | step_failed`
events are appended in order, a `job_completed` event is emitted when no
further steps remain, and the job state advances exactly once from
`ready → running → completed | failed`. All state mutations occur inside
the Engine — no CLI, no Skill Pack, no Runner writes `state.json` or
`events.jsonl` directly. The slice satisfies architecture §13 phase 6
verification: *"timeout、cwd、env、stdout/stderr 和 exit_code 都写入
artifact."*

Deliverables:

1. `executeScriptStep(opts)` in `src/script/executor.ts` — orchestration
   function that maps the camelCase `ProcessRunner.run()` result to the
   snake_case `ScriptResult` artifact, writes events, and applies the
   on_failure / success transition.
2. `executeCurrentStep(opts)` body in `src/engine/index.ts` — for
   `type: script` calls `executeScriptStep`; for other types throws
   `WorkflowError` (TD-P6-001).
3. `StepBaseSchema` extension in `src/workflow/index.ts` adding
   `run`, `shell`, `timeout`, `cwd`, `env`, `on_failure`.
4. `tests/script/executor.test.ts` — integration tests against real temp
   directories, with an injected `FakeRunner` (no `execa` dependency).

## "用户可完成" Milestones

- **M1 — 成功的 script step**: 用户可完成 `zigma-flow step --job <job>`
  后，对一个 `type: script` 且 `run: "..."` 的 step，得到：
  - `events.jsonl` 末尾包含按顺序排列的 `step_started` →
    `script_completed` → `step_completed` → `job_completed`；
  - `state.json` 中该 job 的 `status` 从 `ready` 变为 `completed`；
  - `<runDir>/jobs/<jobId>/<attempt>/steps/<stepId>/stdout.txt` 和
    `stderr.txt` 真实存在并记录子进程输出；
  - `<runDir>/jobs/<jobId>/<attempt>/steps/<stepId>/result.json` 内
    `ScriptResult` 的 `stdout` / `stderr` 字段是 `artifact://...` URI；
  - `state.json.last_event_id` 等于 events.jsonl 尾部 event id；
  - `state.json` 仅被写入一次（在事件序列结束后）。

- **M2 — 失败的 script step (非零 exit)**: 用户可完成
  `zigma-flow step --job <job>` 后，对一个非零 exit 的 script step，得到：
  - `events.jsonl` 末尾包含 `step_started` → `script_completed`
    (`exit_code` 非零) → `step_failed`；
  - `state.json` 中该 job 的 `status` 从 `ready` 变为 `failed`；
  - stdout / stderr / result.json 仍被持久化为 artifact；
  - 没有 `step_completed` 事件，没有 `job_completed` 事件；
  - `state.json.last_event_id` 等于 events.jsonl 尾部 event id。

- **M3 — Timeout**: 用户可完成 `zigma-flow step --job <job>` 后，对一个超时
  的 script step，得到：
  - runner 返回 `timedOut: true, exitCode: 124`；
  - `step_failed` 事件的 `reason` 字段包含 `"timeout"`；
  - job `status` 变为 `failed`；
  - stdout / stderr artifact 仍被写入（即便为空字符串）。

## Spec Compliance Matrix

下表覆盖 prd.md FR-007、architecture.md §7.1 / §7.2 / §9.4 / §12.3 /
§13 phase 6、mvp-contracts.md §2.7 / §6 / §7 中与 WF-P6-SCRIPT 相关的
MUST / SHALL / 强制性条款。

| Clause ID | Clause Source | Clause Text | Status |
| --- | --- | --- | --- |
| RC-S1 | prd §FR-007 | Script Step 必须支持 inline command (`run`). | 已纳入本工作流 — FP-SCRIPT-RESOLVE, T-SCRIPT-1 |
| RC-S2 | prd §FR-007 | Script Step 必须支持调用 Skill Pack scripts (`uses`). | 已纳入本工作流 — FP-SCRIPT-RESOLVE-USES (实现路径由 dev plan D7 定义)；T-SCRIPT-1 / T-SCRIPT-4 用 inline 验证总线；Skill Pack 解析的端到端测试由 dev plan §4 T-SCRIPT-5 在 implementation phase 补 (此处占位) |
| RC-S3 | prd §FR-007 | Script Step 必须支持 timeout、cwd、env、capture stdout/stderr 和 exit_code. | 已纳入本工作流 — FP-SCRIPT-RUNNER-CALL, FP-SCRIPT-ARTIFACT-STDOUT, FP-SCRIPT-ARTIFACT-STDERR；T-SCRIPT-1 (capture), T-SCRIPT-3 (timeout)，cwd/env 透传由 WF-P6-RUNNER T-RUNNER-4/5 覆盖 |
| RC-S4 | prd §FR-007 | stdout/stderr 必须保存为 artifact. | 已纳入本工作流 — FP-SCRIPT-ARTIFACT-STDOUT, FP-SCRIPT-ARTIFACT-STDERR；T-SCRIPT-1, T-SCRIPT-4 |
| RC-S5 | prd §FR-007 | exit_code 必须记录到 report 或 result. | 已纳入本工作流 — FP-SCRIPT-RESULT-JSON；T-SCRIPT-2, T-SCRIPT-4 |
| RC-S6 | prd §FR-007 | 命令超时必须终止并记录失败. | 已纳入本工作流 — FP-SCRIPT-TIMEOUT；T-SCRIPT-3 (runner 返回 `timedOut: true`，执行器据此发出 `step_failed`) |
| RC-S7 | prd §FR-007 | 根据 `allow_failure` 或 `on_failure` 决定状态. | 部分纳入本工作流（MVP 只支持 `on_failure: { status: "failed" }` 字面量 / 缺省）；其余对象形式 (`retry_job`/`activate_job`/`goto_job`) 为技术债 TD-P6-002 — T-SCRIPT-7 验证默认行为 |
| RC-S8 | architecture §7.1 | Engine 对外暴露 `executeCurrentStep(runId, jobId)` 命令式入口；CLI 命令只调用这些入口，不直接改 run state. | 已纳入本工作流 — FP-SCRIPT-ENGINE-ENTRY (脚本 step 的实现填充 executeCurrentStep 主体) |
| RC-S9 | architecture §7.2 | Job status 合法转换 `ready → running → completed`；`ready → running → failed`. | 已纳入本工作流 — FP-SCRIPT-TRANSITION-SUCCESS / FAILURE；T-SCRIPT-1 (completed), T-SCRIPT-2 (failed) |
| RC-S10 | architecture §7.2 | 非法转换必须返回明确错误，并且不得写入 snapshot. | 已纳入本工作流（继承自 WF-P6-DISPATCH 的状态守卫）；本 slice 不重测 dispatch 守卫；执行器内部如果发现 job 状态非 `ready`/`running` 直接抛 StateError — 由 dispatch 层覆盖 |
| RC-S11 | architecture §7.3 | 写入流程为：计算 transition，追加 event，写 `state.json.tmp`，原子替换 `state.json`. | 已纳入本工作流 — FP-SCRIPT-STATE-WRITE；T-SCRIPT-6 (snapshot 仅写一次且 last_event_id 与 events.jsonl 尾部一致) |
| RC-S12 | architecture §7.3 | `state.last_event_id` 必须与 event log 尾部一致；state 损坏或不一致时 CLI 不得继续推进. | 已纳入本工作流 — FP-SCRIPT-STATE-WRITE；T-SCRIPT-6 |
| RC-S13 | architecture §9.4 | ScriptResult 必须包含 `exit_code`、`timed_out`、`stdout`、`stderr`、`started_at`、`ended_at`，且 stdout / stderr 为 artifact ref. | 已纳入本工作流 — FP-SCRIPT-RESULT-JSON；T-SCRIPT-4 |
| RC-S14 | architecture §12.3 | `Command Handler -> script: ProcessRunner executes command -> write artifacts -> Engine applies transition -> append events and write state snapshot`. | 已纳入本工作流 — FP-SCRIPT-ORCHESTRATION；T-SCRIPT-1, T-SCRIPT-5 (顺序约束) |
| RC-S15 | architecture §13 phase 6 | 验证：timeout、cwd、env、stdout/stderr 和 exit_code 都写入 artifact. | 已纳入本工作流 — FP-SCRIPT-ARTIFACT-STDOUT / STDERR / RESULT-JSON；T-SCRIPT-1, T-SCRIPT-3, T-SCRIPT-4 |
| RC-S16 | mvp-contracts §2.7 | ScriptResult JSON schema `{ exit_code, timed_out, stdout, stderr, started_at, ended_at }` 必须存在；Script Step 必须支持 timeout、cwd、env、stdout/stderr capture 和 exit_code. | 已纳入本工作流 — FP-SCRIPT-RESULT-JSON；T-SCRIPT-4 |
| RC-S17 | mvp-contracts §2.7 | timeout 必须终止进程并记录失败结果. | 已纳入本工作流 — FP-SCRIPT-TIMEOUT；T-SCRIPT-3 |
| RC-S18 | mvp-contracts §2.7 | 是否 continue、failed、retry 或 blocked 由 Engine 和 Gate 决定（Script 不直接推进 job status）. | 已纳入本工作流 — FP-SCRIPT-RUNNER-CALL（runner 只返回数据）+ FP-SCRIPT-TRANSITION-*（执行器才发起 transition）；T-SCRIPT-2 (失败 → failed by Engine) |
| RC-S19 | mvp-contracts §6 | ProcessRunner 端口的最小能力：执行命令、timeout、cwd、env、capture stdout/stderr；典型适配器：execa. | 已纳入本工作流（通过依赖端口而非 execa）— FP-SCRIPT-RUNNER-CALL；全部 T-SCRIPT 测试通过注入 FakeRunner 验证端口契约 |
| RC-S20 | mvp-contracts §7 (ScriptError) | ScriptError 触发于 exit_code 非零、timeout、进程启动失败；写入 ScriptResult，由 Engine/Gate 决定状态. | 已纳入本工作流 — FP-SCRIPT-TRANSITION-FAILURE；T-SCRIPT-2 (exit≠0), T-SCRIPT-3 (timeout)。`ScriptError` 类本身由 WF-P6-RUNNER 添加到 `src/utils/errors.ts` |
| RC-S21 | mvp-contracts §2.4 | event 必须至少包含 `id` / `run_id` / `type` / `timestamp` / `producer` / `job` / `step` / `attempt` / `payload`. | 已纳入本工作流 — FP-SCRIPT-EVENT-SEQUENCE；T-SCRIPT-1, T-SCRIPT-5 |
| RC-S22 | mvp-contracts §2.4 | 关键事件类型集合必须包含 `step_started` / `step_completed` / `step_failed` / `script_completed` / `job_completed`. | 已纳入本工作流 — FP-SCRIPT-EVENT-SEQUENCE；T-SCRIPT-1, T-SCRIPT-2, T-SCRIPT-5 |
| RC-S23 | mvp-contracts §2.3 | `state.json` 只能由 Engine 通过 State Store 写入；写入顺序为 append event 后原子替换 state snapshot. | 已纳入本工作流 — FP-SCRIPT-STATE-WRITE；T-SCRIPT-6 |
| RC-S24 | mvp-contracts §2.5 | artifact path 必须是相对 run directory 的安全路径；retry 不得覆盖历史 attempt artifact. | 已纳入本工作流（通过复用 `writeArtifact` / `artifactStepDir`）— FP-SCRIPT-ARTIFACT-STDOUT/STDERR；T-SCRIPT-4 |
| TD-P6-001 | architecture §7.1, §12.3 | `executeCurrentStep` MUST 在 MVP 处理 script / check / router / human / workflow 五种 step type. 本 phase 只实现 `script`，其余抛 `WorkflowError`. | 技术债 — TD-P6-001（P7 / P8 落地） |
| TD-P6-002 | prd §FR-007, mvp-contracts §2.7 | `on_failure` 对象形式 `retry_job` / `activate_job` / `goto_job` MUST 由 Engine 实现. 本 slice 只支持字面量 `failed` / 缺省 `{ status: "failed" }`. | 技术债 — TD-P6-002（P8 落地） |
| TD-P6-003 | architecture §9.4 | stdout / stderr artifact 应当有大小上限，避免大输出耗尽磁盘. | 技术债 — TD-P6-003（P9 落地） |
| TD-P6-004 | architecture §7.2 | 多 step job 在 step 完成后 MUST 推进 `current_step` 指针到下一个 step. 本 slice 只验证单 step job 的 `job_completed` 触发条件. | 技术债 — TD-P6-004（P8 落地） |
| TD-P5-003 | prd §FR-006 | Agent prompt 中的 report schema 渲染. 与本 slice 无直接依赖，但 P6 测试不允许暗中依赖 prompt 输出. | 不适用（与脚本执行无交互） |

Spec clause budget within plan envelope: 24 in-scope clauses + 4
technical-debt registrations + 1 explicit "不适用" entry. All MUST clauses
sourced from prd FR-007, architecture §7.1 / §7.2 / §9.4 / §12.3 / §13
phase 6, and mvp-contracts §2.7 / §6 / §7 are accounted for.

## Functional Points

| FP id | Area | Source | Summary |
| --- | --- | --- | --- |
| FP-SCRIPT-RESOLVE | Inline command resolution | prd FR-007, plan §4 | Resolve step command from the workflow `StepDefinition.run` field. |
| FP-SCRIPT-RESOLVE-USES | Skill Pack `uses` resolution | prd FR-007, plan §D7 | Resolve `uses: "<skill>/<script>"` against `skill-lock.json` to a local file path. Implementation lives in `executeScriptStep`; tests in this slice focus on inline (T-SCRIPT-1..7); a Skill-Pack-specific test is registered for the implementation phase per dev plan T-SCRIPT-5. |
| FP-SCRIPT-EVENT-STARTED | `step_started` emission | arch §12.3, mvp §2.4 | `executeScriptStep` appends a `step_started` event with `{ job_id, step_id, attempt }` payload BEFORE invoking the runner. |
| FP-SCRIPT-RUNNER-CALL | ProcessRunner invocation | arch §12.3, mvp §6 | `executeScriptStep` calls `runner.run({ command, shell?, cwd?, env?, timeoutMs? })` exactly once per step. Runner is injected (defaults to `ExecaProcessRunner`). |
| FP-SCRIPT-ARTIFACT-STDOUT | stdout artifact persistence | arch §9.4, mvp §2.5 / §2.7 | stdout string from runner is written to `<runDir>/jobs/<jobId>/attempts/<attempt>/steps/<stepId>/stdout.txt` via `writeArtifact`; metadata's `artifact://` URI is recorded into `ScriptResult.stdout`. |
| FP-SCRIPT-ARTIFACT-STDERR | stderr artifact persistence | arch §9.4, mvp §2.5 / §2.7 | Same path as stdout but `stderr.txt`. The URI is recorded into `ScriptResult.stderr`. |
| FP-SCRIPT-RESULT-JSON | `ScriptResult` persistence | arch §9.4, mvp §2.7 | `executeScriptStep` writes `{ exit_code, timed_out, stdout, stderr, started_at, ended_at }` JSON to `<runDir>/jobs/<jobId>/attempts/<attempt>/steps/<stepId>/result.json`. camelCase → snake_case mapping happens here. |
| FP-SCRIPT-EVENT-SCRIPT-COMPLETED | `script_completed` emission | mvp §2.4 | After artifacts and result.json, append `script_completed` with `{ job_id, step_id, exit_code, timed_out }`. |
| FP-SCRIPT-TIMEOUT | Timeout detection → failure | arch §10, mvp §2.7 | When runner returns `timedOut === true`, treat as failure; `step_failed.payload.reason` MUST contain the substring `"timeout"`. |
| FP-SCRIPT-TRANSITION-SUCCESS | Success transition | arch §7.2 | If `exit_code === 0 && !timed_out`: append `step_completed`, then (if no remaining steps) append `job_completed`; set `state.jobs[jobId].status = "completed"`. |
| FP-SCRIPT-TRANSITION-FAILURE | Failure transition | arch §7.2, prd FR-007 | Otherwise: append `step_failed` (reason includes `"timeout"` or `"exit code N"`); set `state.jobs[jobId].status = "failed"`. |
| FP-SCRIPT-STATE-WRITE | Atomic state snapshot | arch §7.3, mvp §2.3 | `state.json` is written exactly once after the final event of the sequence; `state.last_event_id` equals the tail event id of `events.jsonl`. |
| FP-SCRIPT-EVENT-SEQUENCE | Event ordering | arch §12.3, mvp §2.4 | The append order is `step_started` → `script_completed` → (`step_completed` + `job_completed` | `step_failed`). |
| FP-SCRIPT-ENGINE-ENTRY | Engine integration | arch §7.1 | `executeCurrentStep(opts)` dispatches `type: "script"` to `executeScriptStep(opts)`. Other types throw `WorkflowError` (TD-P6-001). |
| FP-SCRIPT-ORCHESTRATION | End-to-end pipeline | arch §12.3 | The full pipeline (resolve → started → runner → artifacts → result → script_completed → completed/failed → job_completed → snapshot) executes in this order on every invocation. |

## Use Case Enumeration

| UC id | Actor | Trigger | Pre-conditions | Steps (happy path / failure) | Post-conditions / observable result |
| --- | --- | --- | --- | --- | --- |
| UC-SCRIPT-1 | Engine | `executeScriptStep` called on a `ready` single-step `script` job; runner returns `exitCode: 0`. | Run dir exists with valid state.json + events.jsonl; FakeRunner returns zero exit, stdout `"ok\n"`, stderr `""`. | Append `step_started`; call runner; write `stdout.txt` + `stderr.txt` artifacts; write `result.json`; append `script_completed`; append `step_completed`; append `job_completed`; write state snapshot with `jobs[jobId].status === "completed"`. | events.jsonl tail = `job_completed`; state.last_event_id matches tail; stdout artifact file exists; result.json contains valid ScriptResult. |
| UC-SCRIPT-2 | Engine | Same as UC-SCRIPT-1 but runner returns `exitCode: 2`, `timedOut: false`. | Same. | Append `step_started`; call runner; write stdout/stderr artifacts; write result.json with `exit_code: 2`; append `script_completed` with `exit_code: 2`; append `step_failed` with `reason` containing `"exit code 2"`; write state snapshot with `jobs[jobId].status === "failed"`. NO `step_completed`, NO `job_completed`. | events.jsonl tail = `step_failed`; state.last_event_id matches tail; state.jobs[jobId].status === "failed". |
| UC-SCRIPT-3 | Engine | Same as UC-SCRIPT-1 but runner returns `timedOut: true, exitCode: 124`. | Same. | Append `step_started`; call runner (which returns timeout); write stdout/stderr artifacts; write result.json with `timed_out: true`; append `script_completed` with `timed_out: true, exit_code: 124`; append `step_failed` with `reason` containing `"timeout"`; write state snapshot with `jobs[jobId].status === "failed"`. | events.jsonl tail = `step_failed`; reason includes `"timeout"`; state.jobs[jobId].status === "failed". |
| UC-SCRIPT-4 | Engine | Same as UC-SCRIPT-1 — verify ScriptResult contents | runner stdout = `"hello\n"`, stderr = `"warning\n"`. | Standard happy-path pipeline. | result.json `stdout` field is exactly the `artifact://` URI returned by `writeArtifact` for stdout.txt; similarly `stderr` field; `exit_code === 0`, `timed_out === false`, `started_at` / `ended_at` are valid ISO 8601 strings. |
| UC-SCRIPT-5 | Engine | Same as UC-SCRIPT-1 — verify event ordering | Same. | Standard happy-path pipeline. | In events.jsonl the index of `step_started` is strictly less than the index of `script_completed`, which is strictly less than the index of `step_completed`, which is strictly less than the index of `job_completed`. |
| UC-SCRIPT-6 | Engine | Same as UC-SCRIPT-1 — verify snapshot consistency | Same. | Standard happy-path pipeline. | `state.json.last_event_id` equals the id of the tail line of events.jsonl. State snapshot is written exactly once after the final event of the sequence (verified indirectly: last_event_id == tail). |
| UC-SCRIPT-7 | Engine | UC-SCRIPT-2 with explicit `on_failure: { status: "failed" }` declared on the step. | Same as UC-SCRIPT-2 but workflow YAML declares `on_failure: { status: "failed" }`. | Same as UC-SCRIPT-2 — confirms the explicit declaration is equivalent to the default (TD-P6-002: other on_failure object forms deferred). | Same as UC-SCRIPT-2. |
| UC-SCRIPT-8 | Engine (negative — TD-P6-001) | `executeCurrentStep` called on a non-script step. | Workflow current step is `agent` / `check` / `router` / `human` / `workflow`. | Engine wrapper throws `WorkflowError` BEFORE invoking `executeScriptStep`. | No events appended; no state change. (Covered indirectly by WF-P6-DISPATCH T-DISPATCH-3; not duplicated here.) |

## Test Plan

All tests live in **`tests/script/executor.test.ts`** under
`describe("executeScriptStep", ...)`. Vitest. Real temp dirs under
`os.tmpdir()`. No filesystem mocking. A local `FakeRunner` class implements
the `ProcessRunner` shape and is injected via `opts.runner`.

| Test id | `it` description | What it verifies | UCs covered | FPs covered | RCs touched |
| --- | --- | --- | --- | --- | --- |
| T-SCRIPT-1 | `happy path — zero exit emits step_started → script_completed → step_completed → job_completed and writes stdout artifact` | Run end-to-end on a single-step script job. Assert: (a) events.jsonl contains `step_started`, `script_completed`, `step_completed`, `job_completed` in that order; (b) `state.json.jobs[jobId].status === "completed"`; (c) `stdout.txt` file exists on disk under the canonical artifact path. | UC-SCRIPT-1, UC-SCRIPT-5 | FP-SCRIPT-RESOLVE, FP-SCRIPT-EVENT-STARTED, FP-SCRIPT-RUNNER-CALL, FP-SCRIPT-ARTIFACT-STDOUT, FP-SCRIPT-EVENT-SCRIPT-COMPLETED, FP-SCRIPT-TRANSITION-SUCCESS, FP-SCRIPT-EVENT-SEQUENCE, FP-SCRIPT-ORCHESTRATION | RC-S1, RC-S3, RC-S4, RC-S8, RC-S9, RC-S14, RC-S22 |
| T-SCRIPT-2 | `non-zero exit emits step_failed and transitions job to failed` | runner returns `exitCode: 2`. Assert: events.jsonl tail is `step_failed`; NO `step_completed` / `job_completed` exist in the tail; `state.json.jobs[jobId].status === "failed"`. | UC-SCRIPT-2 | FP-SCRIPT-RUNNER-CALL, FP-SCRIPT-TRANSITION-FAILURE, FP-SCRIPT-EVENT-SEQUENCE | RC-S5, RC-S7, RC-S9, RC-S18, RC-S20, RC-S22 |
| T-SCRIPT-3 | `timeout maps to step_failed with reason containing "timeout"` | runner returns `timedOut: true, exitCode: 124`. Assert: events.jsonl contains `step_failed` with `payload.reason` substring `"timeout"`; `state.json.jobs[jobId].status === "failed"`. | UC-SCRIPT-3 | FP-SCRIPT-TIMEOUT, FP-SCRIPT-TRANSITION-FAILURE | RC-S6, RC-S17, RC-S20 |
| T-SCRIPT-4 | `result.json contains a ScriptResult with artifact:// URIs for stdout / stderr` | runner returns non-empty stdout / stderr. Assert: result.json parses, contains snake_case `{ exit_code, timed_out, stdout, stderr, started_at, ended_at }`; `stdout` and `stderr` strings start with `"artifact://"`; both refer to files that exist on disk under the run dir. | UC-SCRIPT-4 | FP-SCRIPT-ARTIFACT-STDOUT, FP-SCRIPT-ARTIFACT-STDERR, FP-SCRIPT-RESULT-JSON | RC-S4, RC-S5, RC-S13, RC-S15, RC-S16, RC-S24 |
| T-SCRIPT-5 | `step_started is appended strictly before script_completed in events.jsonl` | Standard happy-path; explicitly assert the index of `step_started` < index of `script_completed`. | UC-SCRIPT-5 | FP-SCRIPT-EVENT-STARTED, FP-SCRIPT-EVENT-SCRIPT-COMPLETED, FP-SCRIPT-EVENT-SEQUENCE | RC-S14, RC-S21, RC-S22 |
| T-SCRIPT-6 | `state.json.last_event_id matches the tail of events.jsonl after execution` | Standard happy-path; assert `state.json.last_event_id === <id of last line of events.jsonl>`. Also assert state.json was written (mtime > pre-execution baseline). | UC-SCRIPT-6 | FP-SCRIPT-STATE-WRITE | RC-S11, RC-S12, RC-S23 |
| T-SCRIPT-7 | `on_failure: { status: "failed" } is equivalent to the default failure transition` | Same as T-SCRIPT-2 but the workflow YAML explicitly declares `on_failure: { status: "failed" }` on the step. Assert the same observable outcome. Confirms the baseline before TD-P6-002 retrofits the other on_failure forms in P8. | UC-SCRIPT-7 | FP-SCRIPT-TRANSITION-FAILURE | RC-S7 |

## Test Design Summary

- **Test framework**: vitest (`describe` / `it` / `expect` / `beforeEach`
  / `afterEach`). Mirrors the structure of
  `tests/commands/prompt.test.ts` and `tests/commands/step.test.ts`.
- **Imports under test**:
  - `executeScriptStep` from `../../src/script/executor.js` (does not
    exist yet — red phase).
  - `createRun` from `../../src/engine/index.js` for sandbox setup.
  - `Clock`, `LocalStateStore` from `../../src/run/index.js`.
- **Filesystem**: real temp directories under `os.tmpdir()` with
  `node:crypto.randomUUID()` suffixes; no fs mocking. Each test creates
  its own `<sandbox>/.zigma-flow/` skeleton (`config.json`,
  `skill-lock.json`, `runs/`).
- **Clock**: inline `FakeClock { now(): "2026-06-08T00:00:00.000Z" }`.
- **ProcessRunner injection**: tests pass a local `FakeRunner` class.
  The fake implements `run(opts): Promise<...>` returning fully camelCase
  fields `{ exitCode, timedOut, stdout, stderr, startedAt, endedAt }`.
  This camelCase convention is **the authoritative interface convention
  for the `ProcessRunner` port going forward**. The existing
  `tests/script/runner.test.ts` (WF-P6-RUNNER red phase) uses the
  earlier snake_case `started_at` / `ended_at` shape; that test will be
  reconciled to camelCase as part of WF-P6-RUNNER Step 2 when the actual
  port is implemented. WF-P6-SCRIPT depends on the port name only via
  `opts.runner`, so no source-of-truth drift is introduced by this
  document.
- **Pre/post evidence**: T-SCRIPT-1 / T-SCRIPT-2 / T-SCRIPT-3 read
  events.jsonl line-by-line and parse each line as JSON; T-SCRIPT-4
  reads `result.json` and verifies the keys and prefixes; T-SCRIPT-6
  cross-checks tail event id against state.last_event_id.

## Red-Phase Expectations

- `src/script/executor.ts` does not exist; tests fail at module
  resolution. After WF-P6-SCRIPT Step 2 ships the file, all T-SCRIPT-N
  tests should turn green.
- `StepBaseSchema` does not yet declare `run`; the workflow used by
  T-SCRIPT-1..7 sets the step to `type: script` with a `run` field. The
  workflow loader currently passes the `run` field through under the
  `[key: string]: unknown` index signature, so `createRun` succeeds even
  before Step 2 extends the schema. Step 2 must extend the schema to
  make `run` first-class (D2 in the development plan), but the test does
  not depend on the schema extension to compile.
- `executeCurrentStep` is not exported from `src/engine/index.ts` in the
  red phase, but `executor.test.ts` imports `executeScriptStep`
  directly, so dispatch-layer red-phase status is independent.

## Step 2 Handoff Notes

1. `src/script/executor.ts` MUST export `executeScriptStep` with a
   signature structurally compatible with:

   ```ts
   export interface ExecuteScriptStepOpts {
     runDir: string;
     zigmaflowDir: string;
     runId: string;
     jobId: string;
     clock: Clock;
     runner: ProcessRunner;
   }
   export function executeScriptStep(opts: ExecuteScriptStepOpts): Promise<void>;
   ```

   When called from `executeCurrentStep`, the wrapper supplies
   `runner ?? new ExecaProcessRunner()`.
2. The orchestration order MUST be: append `step_started` → call
   `runner.run(...)` → write `stdout.txt` artifact → write `stderr.txt`
   artifact → write `result.json` → append `script_completed` →
   (success branch) append `step_completed` → (if no remaining steps in
   the job) append `job_completed` / (failure branch) append
   `step_failed` → atomic snapshot write.
3. `ScriptResult` written to `result.json` MUST use snake_case fields
   `{ exit_code, timed_out, stdout, stderr, started_at, ended_at }`.
   `stdout` and `stderr` fields MUST be the `artifact://` URIs returned
   by `writeArtifact` (NOT the raw captured strings).
4. `step_failed.payload.reason` MUST contain the substring `"timeout"`
   when `runner` reports `timedOut === true`; otherwise it MUST contain
   the substring `"exit code N"` where N is the non-zero exit code.
5. `executeCurrentStep` in `src/engine/index.ts` MUST throw
   `WorkflowError` with the substring `"not yet implemented"` (or
   equivalent) for non-`script` step types — registers TD-P6-001.
6. Schema extension in `src/workflow/index.ts` MUST add the explicit
   `run`, `shell`, `timeout`, `cwd`, `env`, `on_failure` fields to
   `StepBaseSchema` and to the `StepDefinition` interface.

## Test Gaps

- **Skill Pack `uses` resolution**: T-SCRIPT-1..7 use inline `run`. A
  Skill-Pack-specific test is registered for the implementation phase
  per dev plan §4 (T-SCRIPT-5 in the dev plan, distinct from
  T-SCRIPT-5 in this workflow's test plan) and is not exercised here to
  keep the red phase focused. Step 2 MUST add the Skill Pack scenario;
  it should reuse the FakeRunner pattern.
- **`cwd` / `env` injection**: the runner-layer behaviour is covered by
  WF-P6-RUNNER T-RUNNER-4 / T-RUNNER-5; this slice does not duplicate.
- **Concurrent `executeScriptStep` calls**: not exercised — single
  process MVP.
- **Multi-step job step pointer advancement**: TD-P6-004; T-SCRIPT-1's
  `job_completed` assertion is valid only for single-step jobs. The
  multi-step variant lands in P8.
- **Atomicity under crash**: not asserted (out of scope for MVP unit
  tests; relies on `LocalStateStore.writeSnapshot` tmp+rename behaviour
  covered by P4 tests).
