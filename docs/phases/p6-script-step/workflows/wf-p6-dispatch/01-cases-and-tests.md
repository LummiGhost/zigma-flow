# WF-P6-DISPATCH — Cases and Tests

- Workflow: WF-P6-DISPATCH
- Phase: P6 Script Step
- Step: 1 (Cases and Tests)
- Date: 2026-06-08
- Author: subagent (workflow Step 1)

## Slice Boundary

- Slice name: **P6-DISPATCH**
- Bounded contexts:
  - **CLI Layer / Command handler** (architecture.md §12.3). Owns
    `stepAction` and the `zigma-flow step [--job <job-id>]` wiring.
  - **Engine command surface** (architecture.md §7.1, §7.2). Owns the
    `executeCurrentStep(opts)` entry-point signature — the implementation
    of that entry-point is delivered by WF-P6-SCRIPT.
- Bounded context interactions:
  - **Consumes** `src/run/index.js` (`readActiveRun`, `LocalStateStore`,
    `JsonlEventWriter`, `Clock`).
  - **Consumes** `src/workflow/index.js` (`loadWorkflowFile`, the
    `StepDefinition.type` discriminator).
  - **Produces** the `executeCurrentStep` symbol on
    `src/engine/index.js`. WF-P6-DISPATCH ships a signature stub; the
    full implementation is wired by WF-P6-SCRIPT. The stub MUST accept a
    `runner?: ProcessRunner` so this workflow can pass a no-op
    `FakeRunner` from tests without depending on `execa`.
  - **MUST NOT** write to `state.json` directly. Every state transition
    triggered by `step` MUST go through `executeCurrentStep`
    (architecture §5.2 / §7.1, ADR-003).
  - **MUST NOT** read or instantiate `ExecaProcessRunner`. Process
    spawning is owned by WF-P6-RUNNER; this workflow only forwards the
    optional `runner` injection point.
  - **MUST NOT** write artifacts, append `script_completed` /
    `step_completed` / `step_failed` events, or compute
    `ScriptResult`. Those concerns live in WF-P6-SCRIPT.

## Workflow Goal

Wire the `zigma-flow step --job <job-id>` CLI surface through to the
Engine's `executeCurrentStep(runId, jobId)` command, so a user can stand
on a freshly created run (WF-P3-RUN) and trigger inline script-step
execution without bypassing the Engine. WF-P6-DISPATCH owns the
CLI↔Engine boundary only — it validates the active-run pointer, the
target job state, the step kind, and delegates to `executeCurrentStep`,
which is the single state-transition path for step execution.

Deliverables:

1. `stepAction({ job?, zigmaflowDir, clock, runner? })` in
   `src/commands/step.ts` implementing the architecture.md §12.3
   command-handler pipeline up to the Engine call.
2. `executeCurrentStep(opts)` exported from `src/engine/index.js` with
   the signature documented in the frozen plan (D5). WF-P6-DISPATCH only
   ships the symbol and signature; WF-P6-SCRIPT supplies the body.
3. `step` subcommand registration in `src/cli.ts` with
   `commander.exitOverride()` and the existing `ZigmaFlowError` → exit
   code mapping.
4. `export { stepAction }` added to `src/commands/index.ts`.

## "用户可完成" Milestones

- **M1**: 用户可完成 `zigma-flow step --job <job>` 后，CLI 校验
  `active_run`、目标 `job` 存在且处于 `ready`/`running`、当前 step 为
  `script`，并将控制权交给 `executeCurrentStep`，由 Engine 推进 job
  从 `ready` → `running`（实际事件 / artifact / 状态转移在
  WF-P6-SCRIPT 完成；本 slice 只负责 dispatch 成功后 Engine 收到调用且
  job 状态不再是 `ready`）。
- **M2**: 用户可完成 `zigma-flow step`（无 `--job`，仅一个 `ready`
  script job 时）并获得与 M1 相同的结果。
- **M3**: 用户可完成 `zigma-flow step --job <non-script-step-job>` 后
  得到带 exit code 3 的明确错误，CLI 不调用 `executeCurrentStep`，
  `state.json` 字节不变。

## Spec Compliance Matrix

下表覆盖 architecture.md §7.1、§7.2、§12.3 及 mvp-contracts.md §7 中与
WF-P6-DISPATCH 相关的 MUST/SHALL/强制性条款。

| Clause ID  | Clause Source             | Clause Text                                                                                                                          | Status                                                                          |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| RC-D1      | architecture §7.1         | Engine 对外暴露 `executeCurrentStep(runId, jobId)` 命令式入口。CLI 命令只调用这些入口，不直接改 run state.                              | 已纳入本工作流 — FP-DISPATCH-ENGINE-CALL, FP-DISPATCH-NO-DIRECT-STATE           |
| RC-D2      | architecture §7.1         | CLI 命令只调用 Engine 入口；step CLI handler MUST 通过 `executeCurrentStep` 进行 step 推进，禁止旁路。                                  | 已纳入本工作流 — FP-DISPATCH-ENGINE-CALL                                        |
| RC-D3      | architecture §7.2         | Job status 非法转换必须返回明确错误，并且不得写入 snapshot。`step` 命令命中非 `ready`/`running` 的 job 时 MUST 拒绝并保持 snapshot 不变. | 已纳入本工作流 — FP-DISPATCH-JOB-STATUS                                         |
| RC-D4      | architecture §7.2         | Job status 合法转换为 `ready -> running -> completed | failed`。`step` 命令负责发起 `ready -> running` 的入口；实际写入由 Engine 完成。   | 已纳入本工作流（dispatch 部分） — FP-DISPATCH-ENGINE-CALL                       |
| RC-D5      | architecture §12.3        | `Command Handler -> load active run` — handler MUST 解析 `.zigma-flow/config.json` 的 `active_run`，缺失时报错。                       | 已纳入本工作流 — FP-DISPATCH-ACTIVE-RUN                                         |
| RC-D6      | architecture §12.3        | `Command Handler -> inspect current step type` — handler MUST 在派发前判定当前 step 的 type；P6 仅 `script` 在范围内。                  | 已纳入本工作流 — FP-DISPATCH-STEP-KIND                                          |
| RC-D7      | architecture §12.3        | `script: ProcessRunner executes command` — script step 的执行入口是 Engine `executeCurrentStep`，进而调用 ProcessRunner。              | 已纳入本工作流（dispatch 路径） — FP-DISPATCH-ENGINE-CALL                       |
| RC-D8      | architecture §12.3        | `Engine applies transition` / `append events and write state snapshot` — handler 自身 MUST NOT 写 state.json / events.jsonl。         | 已纳入本工作流 — FP-DISPATCH-NO-DIRECT-STATE                                    |
| RC-D9      | mvp-contracts §7          | `UserInputError` 触发于 CLI 参数缺失、job id 不存在、ready jobs 多于一个但未指定。Exit code 2。                                         | 已纳入本工作流 — FP-DISPATCH-ERRORS (unknown-job / no-ready / multi-ready)      |
| RC-D10     | mvp-contracts §7          | `ConfigError` 触发于 active run 缺失、config 损坏。Exit code 4。                                                                       | 已纳入本工作流 — FP-DISPATCH-ERRORS (missing active_run)                        |
| RC-D11     | mvp-contracts §7          | `WorkflowError` 触发于 workflow 定义内部不一致或引用缺失。Exit code 3。本工作流用于 step kind 不是 `script` 的场景。                    | 已纳入本工作流 — FP-DISPATCH-ERRORS (non-script step)                           |
| RC-D12     | mvp-contracts §7          | `StateError` 触发于 state 损坏、非法转换、event/state 不一致。Exit code 1。本工作流用于 state.json 缺失或 job 状态非 ready/running。   | 已纳入本工作流 — FP-DISPATCH-ERRORS (missing state.json / illegal job status)   |
| RC-D13     | mvp-contracts §7          | 错误对象至少包含 `kind`、`message`、`details`、`suggestion`、`exitCode`；测试断言 SHOULD 使用 `kind`，避免只匹配文案。                  | 已纳入本工作流 — 所有错误断言通过 `kind` + `exitCode` 配对。                    |
| TD-P6-001  | architecture §7.1, §12.3  | `executeCurrentStep` MUST 在 MVP 处理 script/check/router/human/workflow 五种 step type。本 phase 只实现 `script`，其余抛 WorkflowError. | 技术债 — TD-P6-001（在 P7/P8 落地）                                              |
| TD-P6-004  | architecture §7.2         | 多 step job 在 step 完成后 MUST 推进 `current_step` 指针到下一个 step。本 slice 不要求 dispatch 处理多 step，单 step job 是验证范围。   | 技术债 — TD-P6-004（在 P8 落地）                                                |

Spec clause budget within plan envelope (13 in-scope clauses + 2 explicit
technical-debt registrations). All MUST clauses sourced from
architecture §7.1 / §7.2 / §12.3 and mvp-contracts §7 are accounted for.

## Functional Points

| FP id                          | Area                              | Source                                | Summary                                                                                                                                |
| ------------------------------ | --------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| FP-DISPATCH-ACTIVE-RUN         | Active-run resolution             | architecture §12.3, mvp-contracts §7  | `stepAction` reads `active_run` via `readActiveRun`; missing pointer → `ConfigError`.                                                  |
| FP-DISPATCH-STATE-LOAD         | State snapshot load               | architecture §12.3                    | `stepAction` reads `state.json` via `LocalStateStore`; missing snapshot → `StateError`.                                                |
| FP-DISPATCH-WORKFLOW-LOAD      | Workflow YAML load                | architecture §12.3                    | `stepAction` reads `run.yml` and loads the workflow via `loadWorkflowFile` to obtain the step list of the chosen job.                  |
| FP-DISPATCH-JOB-SELECT         | Job selection                     | architecture §12.3                    | `--job` selects an explicit job; absence triggers the same single-ready-job rule used by `promptAction` (UC-SELECT-2 / SELECT-3 / SELECT-4). |
| FP-DISPATCH-JOB-STATUS         | Job status guard                  | architecture §7.2                     | The chosen job MUST be `ready` or `running`. Any other status (waiting, inactive, done, failed) → `StateError`.                        |
| FP-DISPATCH-STEP-KIND          | Step kind guard                   | architecture §12.3, frozen plan §3    | Current step MUST be `type === "script"`. Any other type (in P6) → `WorkflowError` (TD-P6-001).                                        |
| FP-DISPATCH-ENGINE-CALL        | Engine entry-point invocation     | architecture §7.1, ADR-003            | `stepAction` calls `executeCurrentStep({ runDir, zigmaflowDir, runId, jobId, clock, runner })` and awaits the result.                  |
| FP-DISPATCH-NO-DIRECT-STATE    | No bypass of Engine               | architecture §5.2, §7.1, §7.2         | `stepAction` does NOT write `state.json` or append to `events.jsonl`; all state mutations are performed inside `executeCurrentStep`.   |
| FP-DISPATCH-CLI                | CLI subcommand wiring             | architecture §12.3, PRD §17           | `zigma-flow step [--job <job-id>]` registered in `src/cli.ts` with `commander.exitOverride()`; reuses existing `ZigmaFlowError` mapper. |
| FP-DISPATCH-ERRORS             | Error → exit code mapping         | mvp-contracts §7                      | Each documented failure raises a `ZigmaFlowError` subclass with the kind / exit-code pair listed in RC-D9..D12.                        |

## Use Cases

| UC id              | Actor | Trigger                                                                        | Pre-conditions                                                                                       | Steps (happy path / failure)                                                                                                 | Post-conditions / observable result                                                                                 |
| ------------------ | ----- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| UC-DISPATCH-1      | CLI   | `zigma-flow step --job <job>` against a freshly created run with a script job  | `createRun` has been called; `state.jobs[job].status === "ready"`; current step is `type: "script"`  | Resolve active_run → load state → load workflow → pick step → call `executeCurrentStep(...)` with an injectable `runner`.    | `executeCurrentStep` is invoked exactly once with the resolved `runId`/`jobId`; promise resolves without throw.     |
| UC-DISPATCH-2      | CLI   | `zigma-flow step` (no `--job`)                                                  | exactly one ready job, with a script step                                                            | Auto-detect the single ready job; same dispatch as UC-DISPATCH-1.                                                            | Same as UC-DISPATCH-1.                                                                                              |
| UC-DISPATCH-3      | CLI   | `zigma-flow step` (no `--job`)                                                  | two or more jobs are `ready`                                                                         | Auto-detect fails.                                                                                                           | Throws `UserInputError` (exit 2); `executeCurrentStep` is NOT called.                                               |
| UC-DISPATCH-4      | CLI   | `zigma-flow step` (no `--job`)                                                  | zero ready jobs                                                                                      | Auto-detect fails.                                                                                                           | Throws `UserInputError` (exit 2); `executeCurrentStep` is NOT called.                                               |
| UC-DISPATCH-5      | CLI   | `zigma-flow step --job nope`                                                    | `nope` is not declared in the workflow / state                                                       | Job lookup fails.                                                                                                            | Throws `UserInputError` (exit 2).                                                                                   |
| UC-DISPATCH-6      | CLI   | `zigma-flow step --job <job>` where job.status === "waiting"/"inactive"/"done"  | job exists but is not `ready` / `running`                                                            | Job status guard fails.                                                                                                      | Throws `StateError` (exit 1); `executeCurrentStep` is NOT called; `state.json` byte-identical to pre-call.          |
| UC-DISPATCH-7      | CLI   | `zigma-flow step --job <job>` where current step is `agent`                     | job is `ready`; current step is `type: "agent"`                                                      | Step kind guard fails.                                                                                                       | Throws `WorkflowError` (exit 3); `executeCurrentStep` is NOT called.                                                |
| UC-DISPATCH-8      | CLI   | `zigma-flow step --job <job>` where current step is `check`/`router`/`workflow`/`human` | job is `ready`; current step is non-script, non-agent                                              | Step kind guard fails (TD-P6-001 placeholder).                                                                               | Throws `WorkflowError` (exit 3); `executeCurrentStep` is NOT called.                                                |
| UC-DISPATCH-9      | CLI   | `zigma-flow step` against a project with no `active_run` in `config.json`       | config exists with `active_run: null`                                                                | Active-run resolution fails.                                                                                                 | Throws `ConfigError` (exit 4); no I/O against the runs directory.                                                   |
| UC-DISPATCH-10     | CLI   | `zigma-flow step` where state.json is missing in the active runDir              | `active_run` points to a dir lacking `state.json`                                                    | State load fails.                                                                                                            | Throws `StateError` (exit 1).                                                                                       |
| UC-DISPATCH-11     | CLI   | `zigma-flow step --job <job>` success path                                      | UC-DISPATCH-1 setup                                                                                  | `stepAction` does not touch `state.json` or `events.jsonl` itself; both files have byte-identical content to pre-call.       | Pre-call bytes of `state.json` and `events.jsonl` equal post-call bytes (the only mutator is `executeCurrentStep`). |
| UC-DISPATCH-12     | CLI   | `executeCurrentStep` rejects with `ScriptError` (simulated via injected runner) | UC-DISPATCH-1 setup with a runner that throws                                                        | `stepAction` propagates the error verbatim.                                                                                  | The thrown error is the exact instance from the runner / engine; `stepAction` does not wrap or swallow it.          |

## Test Plan

| Test id       | Test name                                                                                                            | UCs covered                       | FPs covered                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| T-DISPATCH-1  | `stepAction dispatches a script step on a freshly created run and transitions the job out of "ready"`                | UC-DISPATCH-1                     | FP-DISPATCH-ACTIVE-RUN, FP-DISPATCH-STATE-LOAD, FP-DISPATCH-JOB-SELECT, FP-DISPATCH-STEP-KIND, FP-DISPATCH-ENGINE-CALL |
| T-DISPATCH-2  | `stepAction throws ConfigError (exit 4) when active_run is null`                                                      | UC-DISPATCH-9                     | FP-DISPATCH-ACTIVE-RUN, FP-DISPATCH-ERRORS                                 |
| T-DISPATCH-3  | `stepAction throws WorkflowError (exit 3) when current step is not a script step`                                     | UC-DISPATCH-7, UC-DISPATCH-8      | FP-DISPATCH-STEP-KIND, FP-DISPATCH-ERRORS                                  |
| T-DISPATCH-4  | `stepAction throws UserInputError (exit 2) when --job names an unknown job`                                           | UC-DISPATCH-5                     | FP-DISPATCH-JOB-SELECT, FP-DISPATCH-ERRORS                                 |
| T-DISPATCH-5  | `stepAction throws UserInputError (exit 2) when --job is omitted and zero jobs are ready`                             | UC-DISPATCH-4                     | FP-DISPATCH-JOB-SELECT, FP-DISPATCH-ERRORS                                 |

## Test Design Summary

- **Test framework**: `vitest` (`describe`, `it`, `expect`,
  `beforeEach`, `afterEach`). Mirrors the structure of
  `tests/commands/prompt.test.ts`.
- **Imports under test**:
  - `stepAction` from `../../src/commands/step.js` (does not exist yet —
    tests intentionally fail at import time in the red phase).
  - `createRun` from `../../src/engine/index.js` for sandbox setup.
  - `Clock` type, `LocalStateStore`, `JsonlEventWriter` from
    `../../src/run/index.js` (read-only — used to capture pre-call state
    bytes).
  - `ConfigError`, `UserInputError`, `WorkflowError`, `StateError` from
    `../../src/utils/index.js`.
- **Filesystem**: real temp directories under `os.tmpdir()` with
  `node:crypto.randomUUID()` suffixes; no fs mocking. Each test creates
  its own `<sandbox>/.zigma-flow/` skeleton (`config.json`,
  `skill-lock.json`, `runs/`).
- **Clock**: `FakeClock { now(): "2026-06-08T00:00:00.000Z" }` defined
  inline (mirrors the prompt test pattern).
- **ProcessRunner injection**: tests pass a `FakeRunner` that is a no-op
  stub (`run()` returns a benign `ScriptRunResult`-shaped object).
  Because `stepAction`'s only contract for the runner is "forward to
  `executeCurrentStep`", the fake exists primarily so that tests
  compile and so that, when `executeCurrentStep` becomes real
  (WF-P6-SCRIPT), the happy-path test does not require `execa`.
- **Engine stub interop**: the red phase only requires that
  `executeCurrentStep` resolves without throwing when handed a script
  step; the test therefore asserts that the dispatch path runs to
  completion (no thrown error) and that the chosen job transitions out
  of `ready` (the actual `running`/`done` choice is enforced by the
  WF-P6-SCRIPT implementation). If WF-P6-SCRIPT ships before the
  dispatch tests are green, the same assertions still hold; the
  test is intentionally tolerant of WF-P6-SCRIPT's specific state
  outcome.
- **Pre/post bytes**: T-DISPATCH-3 reads `state.json` bytes before and
  after the call and asserts byte equality on failure paths (ensures
  the handler did not write state directly).

## Red-Phase Expectations

- `src/commands/step.ts` and the corresponding `stepAction` export do
  not yet exist. Tests fail at module resolution.
- `executeCurrentStep` is not yet exported from `src/engine/index.js`;
  the test for happy-path either fails on the import-time check (via
  the `stepAction` module's transitive import) or on the assertion that
  the job state transitions out of `ready`.
- Once WF-P6-DISPATCH Step 2 ships `stepAction` and the
  `executeCurrentStep` signature stub, tests T-DISPATCH-2 through
  T-DISPATCH-5 turn green. T-DISPATCH-1 fully turns green only after
  WF-P6-SCRIPT lands the `executeCurrentStep` implementation.

## Step 2 Handoff Notes

1. `src/commands/step.ts` MUST export `stepAction` with the signature
   below. Use conditional spreads for optional fields because
   `exactOptionalPropertyTypes` is enabled:

   ```ts
   export interface StepActionOpts {
     zigmaflowDir: string;
     job?: string;
     clock: Clock;
     runner?: ProcessRunner;
   }
   export function stepAction(opts: StepActionOpts): Promise<void>;
   ```

2. The pipeline MUST mirror `promptAction` for the validation steps
   (read active_run → read state → load workflow → select job → guard
   job status → guard step kind) but MUST NOT write to state. It then
   calls `executeCurrentStep({ runDir, zigmaflowDir, runId, jobId,
   clock, ...(runner === undefined ? {} : { runner }) })`.
3. `src/engine/index.ts` MUST export `executeCurrentStep` even if the
   body is a temporary stub. The Step 2 stub MAY simply throw
   `WorkflowError("executeCurrentStep is not yet implemented")` —
   T-DISPATCH-1 then verifies the call was attempted (and is expected
   to flip to a real success assertion once WF-P6-SCRIPT lands).
   Alternatively, the Step 2 stub MAY perform the minimal `ready ->
   running` transition to keep T-DISPATCH-1 green during the
   interleave with WF-P6-SCRIPT.
4. `src/cli.ts` MUST register the subcommand with
   `program.command("step").option("--job <job>", ...)
     .exitOverride().action(async (opts) => stepAction({ job:
     opts.job, zigmaflowDir: process.cwd(), clock: new SystemClock() }))`.
5. The CLI MUST reuse the existing `ZigmaFlowError → process.exitCode`
   mapping; no new exit-code mapping is required.
6. `src/commands/index.ts` MUST add `export { stepAction } from
   "./step.js";`.

## Test Gaps

- **Multi-step job step pointer**: tests assume a single-step job per
  TD-P6-004; once `current_step` advancement lands in P8 the dispatch
  guard MUST inspect `state.jobs[jobId].current_step`.
- **Concurrent `step` invocations**: not exercised — single-process
  MVP.
- **`StateError` from corrupt state.json**: covered by P4 tests; not
  re-litigated here.
- **`runner` adapter behaviour**: owned by WF-P6-RUNNER tests; this
  workflow only verifies that `stepAction` forwards an injected
  runner.
