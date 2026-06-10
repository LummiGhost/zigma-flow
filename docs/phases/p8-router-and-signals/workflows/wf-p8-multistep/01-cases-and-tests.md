---
date: 2026-06-10
authority: docs/architecture.md §7.1, §7.2, docs/mvp-contracts.md §2.3
---

# WF-P8-MULTISTEP — Cases and Tests

- Workflow: WF-P8-MULTISTEP
- Phase: P8 Router and Signals
- Step: 1 (Cases and Tests)
- Date: 2026-06-10
- Author: subagent (workflow Step 1)

## Slice Boundary

- Slice name: **P8-MULTISTEP**
- Bounded contexts:
  - **Engine command body** (architecture.md §7.1) — owns the new
    `advanceJob(runId, jobId)` entry point and the post-step hook in
    `executeCurrentStep` that calls it.
  - **Job-level step pointer** (mvp-contracts.md §2.3, run state
    contract) — owns mutation of `state.jobs[<jobId>].current_step`,
    the optional `string` field already declared on `JobState` by P3
    (`src/run/index.ts`).
  - **Job status terminal transitions** (architecture.md §7.2) — the
    `running → completed` transition when the final step finishes
    flows through `advanceJob`'s "no more steps" branch.
- Bounded context interactions:
  - **Consumes** `LocalStateStore` from `src/run/index.js` for
    `readSnapshot` / `writeSnapshot`.
  - **Consumes** `loadWorkflowFile` from `src/workflow/index.js` to
    resolve `JobDefinition.steps` for the running job. Reuses the
    `run.yml` → `workflow.path` lookup already present in
    `executeCurrentStep`.
  - **Consumes** `JsonlEventWriter` from `src/run/index.js` and the
    sequencer in `src/events/index.js` only for the `job_completed`
    event emitted when the pointer runs off the end. No new event
    types are introduced — `job_retrying`, `job_activated`,
    `job_skipped`, `signal_received` belong to WF-P8-SIGNALS.
  - **Produces** the `advanceJob(runId, jobId)` Engine entry described
    in architecture §7.1. This is the third Engine entry to ship in
    MVP (after `createRun` and `executeCurrentStep`).
  - **MUST NOT** decide whether a job should `fail`, `block`, `retry`,
    `activate` a peer job, or `goto` a peer job — those are routing
    actions and belong to WF-P8-SIGNALS. `advanceJob` is purely
    mechanical: "find the next undone step in this job's `steps[]`,
    update the pointer, return whether more remain".
  - **MUST NOT** be called by the CLI. `executeCurrentStep` is the
    only legitimate caller. CLI commands (`step`, `next`) reach
    `advanceJob` only through `executeCurrentStep`.
  - **MUST NOT** emit `step_started`, `step_completed`, `step_failed`,
    `script_completed`, `check_completed`, or `router_decided`. Those
    are owned by the individual step executors (P6 script, P7 check,
    WF-P8-ROUTER router). `advanceJob` runs *after* the executor has
    completed and persisted its terminal step event.
  - **MUST NOT** mutate `state.last_event_id` independently. When
    `advanceJob` writes a new state snapshot (because the pointer
    moved or `job_completed` was appended), the snapshot's
    `last_event_id` MUST equal the tail of `events.jsonl` after any
    `job_completed` append.
  - **MUST NOT** alter the existing single-step job behaviour proven
    by P6 (T-SCRIPT-1) and P7 (T-CHECK-1). The pre-existing
    `job_completed` emission path for "current step is the only / last
    step" must continue to fire exactly once with the same payload
    shape.

## Workflow Goal

Deliver mechanical step-pointer advancement so that a user who runs
`zigma-flow step --job <job>` on a job declaring multiple steps sees
each step execute in turn: after step N completes, `current_step`
moves to step N+1; after the final step completes, the job
transitions to `completed` and emits a single `job_completed` event.
The next invocation of `zigma-flow step --job <job>` reads the
updated `current_step` and dispatches to the executor for that step
type. All state mutation continues to flow through the Engine, and
the routing decision logic (`on_pass`, `on_fail`, retry, activate,
goto) is explicitly out of scope for this workflow — `advanceJob`
treats every successfully-completed step the same way: advance the
pointer, return whether more remain.

Deliverables:

1. `advanceJob(runId, jobId)` in `src/engine/index.ts` — pure
   mechanical pointer advancement that:
   - Reads the run state snapshot via `LocalStateStore`.
   - Locates the named job in `JobDefinition.steps` (loaded from the
     workflow file resolved through `run.yml`).
   - Finds the next undone step relative to the current `current_step`
     (or, if `current_step` is unset, picks the first step).
   - If a next step exists: writes a snapshot with the new
     `current_step` value and returns `true`.
   - If no next step exists: clears `current_step`, appends a single
     `job_completed` event, sets `state.jobs[jobId].status =
     "completed"`, writes a snapshot whose `last_event_id` matches
     the appended event, and returns `false`.
2. Post-step hook in `executeCurrentStep` (or in the script / check
   executors, depending on where step-completion is finalised in
   the Step 2 implementation choice). The hook calls `advanceJob`
   exactly once per successful step completion. The Step 2 author
   chooses whether the call sits in `executeCurrentStep` or inside
   each executor — both shapes satisfy the contract as long as
   `advanceJob` runs after the terminal `step_completed` event for
   the just-finished step and before control returns to the CLI.
3. `tests/engine/multistep.test.ts` — red-phase tests for
   `advanceJob` covering single-step, two-step, three-step, failure
   gating, retry reset, and edge cases. **This workflow Step 1 ships
   only the cases-and-tests document and the failing test file; the
   `advanceJob` source ships in Step 2.**

## "用户可完成" Milestones

- **M1 — 多步 job 顺序执行**: 用户可在一个声明 `steps: [s1, s2, s3]`
  的 job 上反复执行 `zigma-flow step --job <job>`，看到：
  - 第一次调用：执行 s1，`current_step` 从 `undefined`/`"s1"`
    推进到 `"s2"`；`events.jsonl` 末尾不是 `job_completed`。
  - 第二次调用：执行 s2，`current_step` 推进到 `"s3"`。
  - 第三次调用：执行 s3，`current_step` 字段从 `state.json` 中清除，
    `events.jsonl` 末尾追加恰好一个 `job_completed`，
    `state.jobs[jobId].status === "completed"`。
  - `state.last_event_id` 始终等于 `events.jsonl` 尾部 event id。
  - 每次调用之间没有竞态：每一次 `step` 命令读到的 `current_step`
    都是上一次 `advanceJob` 写入的值。

- **M2 — 单步 job 兼容**: 用户对一个只声明 `steps: [only-step]` 的
  job 执行一次 `zigma-flow step --job <job>` 时，行为与 P6 / P7
  完全一致：`step_completed` → `job_completed` 紧邻追加，
  `current_step` 不出现在终态 `state.json` 中。`advanceJob` 在该
  路径中也被调用一次，但其 "no next step" 分支与 P6 / P7 已有的
  `job_completed` 追加路径**等价且不重复**（详见 Architecture
  Decision 5）。

## Spec Compliance Matrix

下表覆盖 mvp-contracts.md §2.3、architecture.md §7.1 / §7.2 中与
WF-P8-MULTISTEP 相关的 MUST / SHALL / 强制性条款。每条条款一行，
直接列出对应的功能点 (FP) 和测试 (T)。

| Clause ID | Clause Source | Clause Text | Status |
| --- | --- | --- | --- |
| RC-M01 | mvp-contracts §2.3 | Run state MUST 包含 `jobs.<jobId>.current_step` 字段以追踪当前执行的 step. | 已纳入本工作流 — FP-MULTISTEP-POINTER-INIT / FP-MULTISTEP-POINTER-WRITE；T-MULTISTEP-1, T-MULTISTEP-2, T-MULTISTEP-3 |
| RC-M02 | mvp-contracts §2.3 | `state.json` 只能由 Engine 通过 State Store 写入. | 已纳入本工作流 — FP-MULTISTEP-STATE-WRITE；T-MULTISTEP-2 (advanceJob 是唯一推进 `current_step` 的 Engine 入口；测试断言 `state.json` 是 LocalStateStore.writeSnapshot 写入) |
| RC-M03 | mvp-contracts §2.3 | 写入顺序为 append event 后原子替换 state snapshot. | 已纳入本工作流 — FP-MULTISTEP-FINAL-SEQUENCE；T-MULTISTEP-3 (job_completed 先 append，再写 snapshot；`last_event_id` 匹配 tail) |
| RC-M04 | mvp-contracts §2.3 | `state.last_event_id` 必须与 event log 尾部一致. | 已纳入本工作流 — FP-MULTISTEP-FINAL-SEQUENCE；T-MULTISTEP-3 |
| RC-M05 | mvp-contracts §2.3 | state 损坏或 event/state 不一致时，CLI 不得继续推进 run. | 已纳入本工作流 — FP-MULTISTEP-STATE-MISSING；T-MULTISTEP-8 (advanceJob 在 readSnapshot 返回 null 时抛 StateError，不写 snapshot、不追加 event) |
| RC-M06 | architecture §7.1 | Engine 对外暴露 `advanceJob(runId, jobId)` 命令入口；CLI 命令只调用这些入口. | 已纳入本工作流 — FP-MULTISTEP-ENGINE-ENTRY；T-MULTISTEP-1 (advanceJob 是从 `src/engine/index.ts` 导出的命名 export) |
| RC-M07 | architecture §7.2 | Job status 合法转换包含 `running → completed`. | 已纳入本工作流 — FP-MULTISTEP-JOB-COMPLETED；T-MULTISTEP-3 |
| RC-M08 | architecture §7.2 | 非法转换必须返回明确错误，并且不得写入 snapshot. | 已纳入本工作流 — FP-MULTISTEP-INVALID-JOB / FP-MULTISTEP-UNKNOWN-POINTER / FP-MULTISTEP-FAILED-GATE；T-MULTISTEP-5, T-MULTISTEP-6, T-MULTISTEP-7 |
| RC-M09 | architecture §7.2 | Step status `pending → running → completed` 是 step 自身的转换；step 完成后由 Engine 推进 job. | 已纳入本工作流 — FP-MULTISTEP-POINTER-WRITE；T-MULTISTEP-2 (advanceJob 在 step 已是 completed 状态后被调用，自身不修改 step 状态) |
| TD-P8-005 | architecture §7.2 | `completed → retrying → ready` 转换上 `current_step` 必须重置到第一个 step. WF-P8-MULTISTEP 提供 `advanceJob` 的 "reset pointer when state.jobs[jobId].current_step is undefined" 行为；retry 触发逻辑本身由 WF-P8-SIGNALS 拥有. | 部分纳入本工作流 — FP-MULTISTEP-POINTER-INIT (advanceJob 在 `current_step === undefined` 时回到 `steps[0]`)；T-MULTISTEP-9 验证；retry 事件触发的完整生命周期是 TD-P8-SIGNALS. |

Spec clause budget within plan envelope: 9 in-scope clauses + 1
technical-debt registration. Total 10 clauses — within the planned
≤15 envelope. All MUST clauses sourced from mvp-contracts §2.3 and
architecture §7.1 / §7.2 that govern step-pointer mechanics are
accounted for. Routing / signal MUST clauses (`on_fail`, `on_pass`,
retry trigger, activate, goto) are intentionally excluded — they
belong to WF-P8-SIGNALS.

## Functional Points

| FP id | Area | Source | Summary |
| --- | --- | --- | --- |
| FP-MULTISTEP-ENGINE-ENTRY | Engine entry | arch §7.1 | `advanceJob(runId, jobId)` is a named export of `src/engine/index.ts` with signature `(opts: { runDir: string; runId: string; jobId: string; clock: Clock }) => Promise<boolean>`. Returns `true` if `current_step` was advanced to a next step, `false` if no more steps remain (job marked `completed`). |
| FP-MULTISTEP-POINTER-INIT | Pointer initialisation | mvp §2.3 | When `state.jobs[jobId].current_step` is `undefined`, `advanceJob` treats the *first* element of `JobDefinition.steps` as the "previously executed" reference point and advances to `steps[1]` if it exists, or completes the job if `steps.length === 1`. This codifies the contract that the executor pipeline calls `advanceJob` *after* a step finishes, so an unset pointer means "the implicit first step just finished". |
| FP-MULTISTEP-POINTER-WRITE | Pointer write (non-terminal) | mvp §2.3 | If a next step exists, `advanceJob` writes a snapshot with `state.jobs[jobId].current_step = <next step id>`, leaves `state.jobs[jobId].status` unchanged, and returns `true`. No new events are appended. |
| FP-MULTISTEP-JOB-COMPLETED | Job completion (terminal) | arch §7.2, mvp §2.3 | If no next step exists, `advanceJob` appends a `job_completed` event with payload `{ job_id }`, sets `state.jobs[jobId].status = "completed"`, removes `state.jobs[jobId].current_step` from the snapshot (omitted, not set to `null`), and returns `false`. |
| FP-MULTISTEP-FINAL-SEQUENCE | Event-then-snapshot ordering | arch §7.3, mvp §2.3 | The `job_completed` event is appended BEFORE the terminal snapshot is written. The snapshot's `last_event_id` equals the tail of `events.jsonl` after the append. |
| FP-MULTISTEP-STATE-WRITE | Single writer | mvp §2.3 | `advanceJob` writes `state.json` via `LocalStateStore.writeSnapshot` (atomic tmp-and-rename). No direct `fs.writeFile` of `state.json`. |
| FP-MULTISTEP-FAILED-GATE | Failed step gate | arch §7.2 | If the job's current status is `"failed"` or `"blocked"` when `advanceJob` is called, the function does NOT advance the pointer and does NOT append `job_completed`. It returns `false` and leaves both `state.json` and `events.jsonl` byte-identical to the pre-call snapshot. (Routing actions that drive a `running → failed` transition belong to WF-P8-SIGNALS; this clause is the inert-gate behaviour that prevents accidental advancement.) |
| FP-MULTISTEP-INVALID-JOB | Unknown job id | arch §7.2 | If `state.jobs[jobId]` is `undefined`, `advanceJob` throws `StateError` BEFORE writing any state or appending any event. |
| FP-MULTISTEP-UNKNOWN-POINTER | Pointer points at non-existent step | arch §7.2 | If `current_step` is set to a value that does not appear in `JobDefinition.steps`, `advanceJob` throws `StateError`. (Cannot recover; the caller must retry the job to reset the pointer.) |
| FP-MULTISTEP-STATE-MISSING | Missing state file | mvp §2.3 | If `LocalStateStore.readSnapshot` returns `null`, `advanceJob` throws `StateError`. No event appended, no snapshot written. |
| FP-MULTISTEP-EMPTY-STEPS | Empty steps array | arch §7.2 | If `JobDefinition.steps` is empty, `advanceJob` immediately appends `job_completed`, sets `status = "completed"`, and returns `false`. (Workflow validator should reject empty-steps jobs upstream; this clause is the defensive runtime behaviour.) |
| FP-MULTISTEP-IDEMPOTENT-TERMINAL | Idempotent on terminal job | arch §7.2 | If `state.jobs[jobId].status === "completed"` when `advanceJob` is called, the function returns `false` immediately without appending events or writing snapshots. (Belt-and-braces guard against double-call by the executor pipeline.) |

## Use Case Enumeration

| UC id | Actor | Trigger | Pre-conditions | Steps | Post-conditions / observable result |
| --- | --- | --- | --- | --- | --- |
| UC-MULTISTEP-1 | Engine | `advanceJob` called on a `running` job with `steps: [only]`; `current_step === undefined`. | Run dir exists with valid state and events; job has exactly one step. | `advanceJob` detects "no next step", appends `job_completed`, marks job `completed`, returns `false`. | events.jsonl tail is `job_completed`; `state.jobs[jobId].status === "completed"`; `state.jobs[jobId].current_step` is absent; `last_event_id` matches tail. |
| UC-MULTISTEP-2 | Engine | `advanceJob` called after step `s1` completed on a job with `steps: [s1, s2]`; `current_step` may be `undefined` (no executor wrote it) or `"s1"` (executor recorded it). | Run dir exists; events.jsonl tail is `step_completed` for `s1`. | `advanceJob` finds `s2` as the next step, writes snapshot with `current_step = "s2"`, returns `true`. | No new events appended; `state.jobs[jobId].current_step === "s2"`; `state.jobs[jobId].status` unchanged (`"running"` or `"ready"` depending on executor convention); `last_event_id` unchanged from pre-call. |
| UC-MULTISTEP-3 | Engine | Three sequential `advanceJob` calls on a job with `steps: [s1, s2, s3]`. | Run dir exists; user simulates calling `executeCurrentStep` three times, each followed by `advanceJob`. | Call 1 (after s1): pointer → `"s2"`, returns `true`. Call 2 (after s2): pointer → `"s3"`, returns `true`. Call 3 (after s3): appends `job_completed`, clears pointer, status → `"completed"`, returns `false`. | events.jsonl tail is `job_completed`; pointer absent in final snapshot; `last_event_id` matches tail. |
| UC-MULTISTEP-4 | Engine | `advanceJob` called when the just-completed step was NOT the last. | Job has `steps: [s1, s2, s3]`; `current_step === "s1"`. | `advanceJob` returns `true`. | Return value is `true`; caller (Engine pipeline) knows to NOT emit `job_completed`. |
| UC-MULTISTEP-5 | Engine | `advanceJob` called when the just-completed step WAS the last. | Job has `steps: [s1]`; `current_step === undefined`. | `advanceJob` appends `job_completed`, sets status, returns `false`. | Return value is `false`; caller knows the job is done. |
| UC-MULTISTEP-6 | Engine (failed-step gate) | `advanceJob` called on a job whose status is `"failed"`. | Some prior step emitted `step_failed`; executor transitioned `state.jobs[jobId].status` to `"failed"` before calling `advanceJob` (defensive double-call by the pipeline). | `advanceJob` returns `false` without touching state or events. | events.jsonl byte-length unchanged; state.json byte-content unchanged; no `job_completed` is appended. |
| UC-MULTISTEP-7 | Engine (retry reset baseline) | `advanceJob` called on a job whose `state.jobs[jobId].current_step` is `undefined` AND status is `"running"`. (Simulates the post-retry state where the retry handler — WF-P8-SIGNALS — has cleared the pointer to restart from `steps[0]`.) | Job has `steps: [s1, s2]`; pointer reset. | `advanceJob` interprets `undefined` as "the implicit first step just finished" and advances to `s2`, returns `true`. NOTE: this is the only invariant WF-P8-MULTISTEP owns for the retry path. The retry trigger and the `current_step = undefined` reset are owned by WF-P8-SIGNALS. | `state.jobs[jobId].current_step === "s2"`. |
| UC-MULTISTEP-8 | Engine (negative) | `advanceJob` called when `state.json` is missing or malformed. | `LocalStateStore.readSnapshot` returns `null`. | `advanceJob` throws `StateError`. | events.jsonl unchanged; state.json unchanged; error has `kind === "StateError"`. |
| UC-MULTISTEP-9 | Engine (negative) | `advanceJob` called when the named job does not exist in `state.jobs`. | `state.jobs[jobId]` is `undefined`. | `advanceJob` throws `StateError`. | events.jsonl unchanged; state.json unchanged. |
| UC-MULTISTEP-10 | Engine (negative) | `advanceJob` called when `current_step` is set to a step id that is not in `JobDefinition.steps`. | Job has `steps: [s1, s2]`; `current_step === "ghost"`. | `advanceJob` throws `StateError` (pointer cannot be located). | events.jsonl unchanged; state.json unchanged; error has `kind === "StateError"`. |
| UC-MULTISTEP-11 | Engine (defensive) | `advanceJob` called on a job whose `steps` array is empty. | Workflow validator failed to reject (or the workflow was authored before validation existed). | `advanceJob` appends `job_completed`, marks job `completed`, returns `false`. | events.jsonl tail is `job_completed`; status is `"completed"`. |

(11 use cases — within the 5–7 "core" envelope when filtered to the
five anchor cases UC-MULTISTEP-1..3, UC-MULTISTEP-5, UC-MULTISTEP-6,
plus the 6 supporting / negative cases that gate the FP / RC matrix.)

## Test Plan

All tests live in **`tests/engine/multistep.test.ts`** under
`describe("advanceJob", ...)`. Vitest. Real temp dirs under
`os.tmpdir()`. No filesystem mocking. The test file boots a real
run via `createRun` from `src/engine/index.ts`, writes a synthetic
intermediate snapshot when needed (to simulate a step having just
completed), then invokes `advanceJob` and asserts on the resulting
`state.json` / `events.jsonl`.

| Test id | `it` description | What it verifies | UCs covered | FPs covered | RCs touched |
| --- | --- | --- | --- | --- | --- |
| T-MULTISTEP-1 | `single-step job — advanceJob appends job_completed, clears pointer, returns false` | Boot a run with `steps: [only]`. Call `advanceJob`. Assert: (a) return value is `false`; (b) events.jsonl tail is `job_completed` with payload `{ job_id: <jobId> }`; (c) `state.jobs[jobId].status === "completed"`; (d) `state.jobs[jobId].current_step` is absent; (e) `state.last_event_id` matches events.jsonl tail. | UC-MULTISTEP-1, UC-MULTISTEP-5 | FP-MULTISTEP-ENGINE-ENTRY, FP-MULTISTEP-POINTER-INIT, FP-MULTISTEP-JOB-COMPLETED, FP-MULTISTEP-FINAL-SEQUENCE, FP-MULTISTEP-STATE-WRITE | RC-M01, RC-M02, RC-M03, RC-M04, RC-M06, RC-M07 |
| T-MULTISTEP-2 | `two-step job — advanceJob advances pointer from s1 to s2 and returns true` | Boot a run with `steps: [s1, s2]`. Manually set `state.jobs[jobId].current_step = "s1"` and status to `"running"`. Call `advanceJob`. Assert: (a) return value is `true`; (b) `state.jobs[jobId].current_step === "s2"`; (c) `state.jobs[jobId].status` is unchanged (`"running"`); (d) events.jsonl tail is UNCHANGED from pre-call (no events appended). | UC-MULTISTEP-2, UC-MULTISTEP-4 | FP-MULTISTEP-POINTER-WRITE, FP-MULTISTEP-STATE-WRITE | RC-M01, RC-M02, RC-M06, RC-M09 |
| T-MULTISTEP-3 | `three-step job — sequential advanceJob calls advance through every step and terminate with job_completed` | Boot a run with `steps: [s1, s2, s3]`. Set `current_step = "s1"`. Call advanceJob → expect `current_step === "s2"`, true. Set `current_step = "s2"`. Call advanceJob → expect `current_step === "s3"`, true. Set `current_step = "s3"`. Call advanceJob → expect `current_step` absent, status `"completed"`, false. Assert events.jsonl has exactly ONE `job_completed` event at the tail and `last_event_id` matches. | UC-MULTISTEP-3 | FP-MULTISTEP-POINTER-WRITE, FP-MULTISTEP-JOB-COMPLETED, FP-MULTISTEP-FINAL-SEQUENCE | RC-M01, RC-M03, RC-M04, RC-M07 |
| T-MULTISTEP-4 | `advanceJob returns true only when more steps remain; returns false when the pointer is on the last step` | Boot a run with `steps: [s1, s2]`. Set `current_step = "s1"`. Call advanceJob → expect `true`. Set `current_step = "s2"`. Call advanceJob → expect `false`. | UC-MULTISTEP-4, UC-MULTISTEP-5 | FP-MULTISTEP-POINTER-WRITE, FP-MULTISTEP-JOB-COMPLETED | RC-M01, RC-M07 |
| T-MULTISTEP-5 | `missing state.json — advanceJob throws StateError without touching disk` | Boot a run, then delete `state.json`. Capture events.jsonl size. Call advanceJob. Assert: (a) error thrown with `kind === "StateError"`; (b) events.jsonl size unchanged. | UC-MULTISTEP-8 | FP-MULTISTEP-STATE-MISSING | RC-M05, RC-M08 |
| T-MULTISTEP-6 | `unknown job id — advanceJob throws StateError without touching disk` | Boot a run. Call advanceJob with a job id not in `state.jobs`. Assert: (a) error thrown with `kind === "StateError"`; (b) events.jsonl unchanged; (c) state.json byte-content unchanged. | UC-MULTISTEP-9 | FP-MULTISTEP-INVALID-JOB | RC-M05, RC-M08 |
| T-MULTISTEP-7 | `current_step points at non-existent step id — advanceJob throws StateError without touching disk` | Boot a run with `steps: [s1, s2]`. Set `current_step = "ghost"`. Call advanceJob. Assert: (a) error thrown with `kind === "StateError"`; (b) events.jsonl unchanged; (c) state.json byte-content unchanged. | UC-MULTISTEP-10 | FP-MULTISTEP-UNKNOWN-POINTER | RC-M05, RC-M08 |
| T-MULTISTEP-8 | `failed job — advanceJob is a no-op (does not advance, does not complete)` | Boot a run with `steps: [s1, s2]`. Set `state.jobs[jobId].status = "failed"` and `current_step = "s1"`. Capture events.jsonl byte-content and state.json byte-content. Call advanceJob. Assert: (a) return value is `false`; (b) events.jsonl byte-content unchanged; (c) state.json byte-content unchanged. | UC-MULTISTEP-6 | FP-MULTISTEP-FAILED-GATE | RC-M08 |
| T-MULTISTEP-9 | `current_step undefined on a multi-step job — advanceJob treats it as "first step just finished" and advances to steps[1]` | Boot a run with `steps: [s1, s2]`. Leave `current_step` undefined; set status to `"running"`. Call advanceJob. Assert: `current_step === "s2"`, return `true`. (This is the post-retry-reset baseline; TD-P8-005.) | UC-MULTISTEP-7 | FP-MULTISTEP-POINTER-INIT | RC-M01, TD-P8-005 |
| T-MULTISTEP-10 | `empty steps[] — advanceJob defensively completes the job` | Manually craft a state snapshot for a job whose workflow declares `steps: []`. (The fixture bypasses the workflow validator to construct this state.) Call advanceJob. Assert: `job_completed` appended, status `"completed"`, return `false`. | UC-MULTISTEP-11 | FP-MULTISTEP-EMPTY-STEPS | RC-M07 |
| T-MULTISTEP-11 | `already-completed job — advanceJob is idempotent (returns false, no writes)` | Boot a run; manually set `state.jobs[jobId].status = "completed"`. Capture events.jsonl byte-content and state.json byte-content. Call advanceJob. Assert: (a) return value is `false`; (b) events.jsonl unchanged; (c) state.json unchanged. | (defensive — no UC; covers FP-MULTISTEP-IDEMPOTENT-TERMINAL) | FP-MULTISTEP-IDEMPOTENT-TERMINAL | RC-M08 |

## Test Design Summary

- **Test framework**: vitest (`describe` / `it` / `expect` /
  `beforeEach` / `afterEach`). Mirrors the structure of
  `tests/script/executor.test.ts` (P6) and
  `tests/check/executor.test.ts` (P7).
- **Imports under test**:
  - `advanceJob` from `../../src/engine/index.js` (does not exist
    yet — red phase; module exists but the named export is missing).
  - `createRun` from `../../src/engine/index.js` for sandbox setup.
  - `LocalStateStore`, `Clock` from `../../src/run/index.js` for
    snapshot mutation helpers.
- **Filesystem**: real temp directories under `os.tmpdir()` with
  `node:crypto.randomUUID()` suffixes; no fs mocking. Each test
  creates its own `<sandbox>/.zigma-flow/` skeleton (`config.json`,
  `skill-lock.json`, `runs/`).
- **Clock**: inline `FakeClock { now(): "2026-06-10T00:00:00.000Z" }`.
- **Workflow YAML fixtures**: three minimal fixtures —
  `SINGLE_STEP_YAML` (one script step), `TWO_STEP_YAML` (two script
  steps), `THREE_STEP_YAML` (three script steps). All use
  `type: script` with inline `run: "echo ok"` so that
  `JobDefinition.steps` populates with at least one entry. The
  fixtures are NOT actually executed (no `executeScriptStep` /
  `executeCheckStep` call) — the tests directly mutate `state.json`
  via `LocalStateStore.writeSnapshot` to simulate the
  post-executor state and then invoke `advanceJob` in isolation.
- **State mutation helper**: a local `setJobState(runDir, jobId,
  patch)` reads `state.json`, deep-merges the patch into
  `state.jobs[jobId]`, and writes back via `LocalStateStore`. Used
  to set `current_step`, `status`, and simulate post-step
  intermediate state.
- **Empty-steps fixture (T-MULTISTEP-10)**: the workflow validator
  may reject `steps: []` upstream. The test mocks the workflow
  loader (or writes a YAML whose loader output is post-processed)
  to construct the empty-steps case for `advanceJob`'s defensive
  branch. Step 2 chooses the exact mechanism (e.g., a thin
  `withFakeWorkflow` helper that monkey-patches the loaded
  `WorkflowDefinition`).
- **Pre/post evidence**: T-MULTISTEP-5..8 / T-MULTISTEP-11 capture
  `await fs.stat(events.jsonl).size` AND
  `await fs.readFile(state.json, "utf-8")` before invoking
  `advanceJob` and re-read them after to confirm zero mutation.
  Negative tests do NOT use object-shape comparisons because
  property ordering in `JSON.stringify` is implementation-defined;
  raw byte comparison is the strictest no-write evidence available.

## Architecture Decisions

1. **`advanceJob` is mechanical only.** It contains no routing
   decision (`continue` / `fail` / `block` / `retry_job` /
   `activate_job` / `goto_job`). It contains no `on_pass` / `on_fail`
   lookup. Those live in WF-P8-SIGNALS. The contract is: "given a job
   in the middle of execution, move the pointer; if no next step,
   complete the job; otherwise leave the snapshot consistent for the
   next `executeCurrentStep` invocation". This keeps `advanceJob`
   testable in isolation and prevents WF-P8-SIGNALS from accidentally
   re-implementing the pointer arithmetic.

2. **`current_step` is the *just-finished* step's id, not the
   *next* step's id, after the executor writes it.** This is the
   convention `advanceJob` consumes: the executor records what just
   completed, and `advanceJob` finds the next undone step *after*
   that index in `JobDefinition.steps`. There is one nuance:
   `current_step === undefined` is treated as "the implicit first
   step just finished" so that the unset state from `createRun`
   (P3 produces no `current_step` field) AND the post-retry-reset
   state both flow through the same code path. This is documented
   in FP-MULTISTEP-POINTER-INIT and exercised by T-MULTISTEP-9.

   NOTE: this convention differs from "current_step is the
   currently-executing step" which the P3 doc comment implies
   (`src/run/index.ts:56` — "id of the step currently being
   executed; absent before first step"). Step 2 may either (a)
   amend the doc comment to "id of the step that has just
   completed within the current attempt; absent before any step
   has run" or (b) introduce a sibling field. The Step 1 design
   choice (a) is preferred because it minimises state schema churn
   and the field semantics under (a) are observationally
   equivalent for all P3 / P6 / P7 single-step jobs.

3. **No new event types.** WF-P8-MULTISTEP reuses the existing
   `job_completed` event (mvp-contracts §2.4) for the
   "pointer-ran-off-the-end" terminal. No `step_advanced` event is
   introduced — the pointer advancement is observable through the
   `state.json` snapshot alone, and `events.jsonl` already records
   the `step_completed` of the just-finished step plus the
   `step_started` of the next step (when the next
   `executeCurrentStep` call runs). Adding a `step_advanced` event
   would double-count without adding audit value.

4. **`advanceJob` writes the snapshot once per call.** The
   non-terminal path writes one snapshot (pointer update). The
   terminal path writes one snapshot (status + pointer-removal +
   `last_event_id` update). The failed-gate, idempotent-terminal,
   and all negative paths write zero snapshots. This matches the
   P6 / P7 single-write convention.

5. **Single-step jobs remain end-to-end compatible.** P6's
   `executeScriptStep` and P7's `executeCheckStep` already emit
   `job_completed` for single-step jobs as part of their terminal
   transition. Step 2 of WF-P8-MULTISTEP has two implementation
   choices:
   - **Choice A**: `executeScriptStep` / `executeCheckStep` keep
     emitting `job_completed` directly for single-step jobs;
     `executeCurrentStep` calls `advanceJob` only when
     `JobDefinition.steps.length > 1`. `advanceJob`'s
     "no next step" branch is then unreachable in production but
     remains tested.
   - **Choice B**: `executeScriptStep` / `executeCheckStep` stop
     emitting `job_completed` and only emit `step_completed`;
     `executeCurrentStep` always calls `advanceJob`, which is the
     sole `job_completed` emitter. This requires updating P6 / P7
     tests that assert on `job_completed` adjacency.
   The cases-and-tests doc does not mandate the choice; Step 2
   authors evaluate the test-churn cost and pick. Either choice
   satisfies T-MULTISTEP-1 because `advanceJob` is called and its
   "no-next-step" branch produces the same observable
   `job_completed` event.

6. **`StateError` is the only error class introduced.** All
   negative paths (missing state, unknown job, unknown pointer)
   reuse the existing `StateError` from `src/utils/errors.ts`. No
   new error class is needed; `advanceJob` does not introduce a
   `MultistepError`.

7. **Idempotent terminal.** `advanceJob` on a job that is already
   `"completed"` is a no-op. This belt-and-braces guard exists
   because the executor pipeline shape under Choice A (above) may
   double-call `advanceJob` during the transition window between
   single-step and multi-step semantics. The cost of the guard is
   one extra `===` check; the benefit is removing an entire class
   of double-emit bugs.

## Red-Phase Expectations

- `src/engine/index.ts` does not yet export `advanceJob`; tests
  fail at module-resolution / named-import resolution. After Step 2
  ships the export, all T-MULTISTEP-N tests should turn green.
- `executeCurrentStep` does not yet call `advanceJob`; the
  integration of the call-site is a Step 2 concern. The Step 1
  test file therefore drives `advanceJob` directly without going
  through `executeCurrentStep`. This isolation is intentional:
  Step 1 fixes the contract for `advanceJob`; Step 2 wires it.
- The P3 doc comment on `current_step` (`src/run/index.ts:56`)
  may need an update per Architecture Decision 2. Step 2 owns
  that edit.
- T-MULTISTEP-10's empty-steps fixture may require a workflow
  loader bypass — Step 2 picks the mechanism. The test is allowed
  to skip in red phase if the bypass is non-trivial; it should
  not block Step 2 progress.

## Step 2 Handoff Notes

1. `src/engine/index.ts` MUST export `advanceJob` with a signature
   structurally compatible with:

   ```ts
   export interface AdvanceJobOpts {
     runDir: string;
     runId: string;
     jobId: string;
     clock: Clock;
   }

   export function advanceJob(opts: AdvanceJobOpts): Promise<boolean>;
   ```

2. The execution order MUST be:
   - `readSnapshot` → if `null`, throw `StateError`.
   - Locate `state.jobs[jobId]` → if absent, throw `StateError`.
   - If `status === "completed"` → return `false` (idempotent
     terminal, FP-MULTISTEP-IDEMPOTENT-TERMINAL).
   - If `status === "failed" | "blocked"` → return `false` (failed
     gate, FP-MULTISTEP-FAILED-GATE).
   - Load `WorkflowDefinition` via `loadWorkflowFile` resolved
     through `run.yml`.
   - Locate `JobDefinition.steps` → if `[]`, append `job_completed`,
     mark `completed`, write snapshot, return `false`
     (FP-MULTISTEP-EMPTY-STEPS).
   - If `current_step === undefined` → treat index = 0 as
     "just-finished" baseline; pick `steps[1]` as next (if exists)
     or terminate (if `steps.length === 1`).
   - Else find `current_step` in `steps[]` → if not found, throw
     `StateError` (FP-MULTISTEP-UNKNOWN-POINTER).
   - If found at index `i` and `steps[i+1]` exists → write
     snapshot with `current_step = steps[i+1].id`, return `true`.
   - If found at index `i` and `i+1 >= steps.length` → append
     `job_completed`, clear `current_step`, set `status =
     "completed"`, write snapshot with updated `last_event_id`,
     return `false`.

3. `executeCurrentStep` integration: choose Choice A or Choice B
   per Architecture Decision 5. Document the chosen path in the
   Step 2 development plan section "D-MULTISTEP-X". Update P6 /
   P7 executor tests if Choice B is selected.

4. The `state.jobs[jobId].current_step` doc comment in
   `src/run/index.ts` should be updated to reflect the
   "just-finished step" semantics (Architecture Decision 2).

5. No new event types in `src/events/index.ts`. The
   `job_completed` event payload remains `{ job_id }`.

6. No new error classes in `src/utils/errors.ts`. All negative
   paths reuse `StateError`.

7. After Step 2 lands, the `tests/engine/multistep.test.ts`
   file MUST achieve 11/11 green (or document any explicit
   `.skip` with a TD reference and a reason in the development
   plan).

## Test Gaps

- **Routing actions on advancement**: `on_pass`, `on_fail`,
  `retry_job`, `activate_job`, `goto_job` interactions with
  `advanceJob` are explicitly out of scope. They are owned by
  WF-P8-SIGNALS and tested in `tests/engine/signals.test.ts` (or
  equivalent).
- **End-to-end multi-step execution through CLI**: the executor
  pipeline (`zigma-flow step --job <job>` → executeScriptStep
  → advanceJob → next call → executeScriptStep on step 2 → ...)
  is integration-level evidence that belongs in
  `tests/commands/step.test.ts` (or a new `tests/engine/pipeline.test.ts`).
  WF-P8-MULTISTEP Step 1 does not own that end-to-end test; the
  unit test on `advanceJob` is the contract surface.
- **Retry trigger and reset**: the full lifecycle of retry
  (`completed → retrying → ready` with `current_step` reset) is
  owned by WF-P8-SIGNALS. T-MULTISTEP-9 covers only the baseline
  "advanceJob behaves correctly when `current_step` is undefined"
  invariant that the retry handler depends on.
- **Empty-steps fixture mechanism**: T-MULTISTEP-10 may require
  workflow-loader bypass scaffolding. If Step 2 cannot land that
  scaffolding without scope creep, T-MULTISTEP-10 may be deferred
  to a TD entry and marked `.skip` with reason.
- **Concurrent calls to advanceJob on the same job**: not in
  scope (MVP same-time single writable job constraint). Not
  tested.
