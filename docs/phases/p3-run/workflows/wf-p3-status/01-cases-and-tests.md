# WF-P3-STATUS — Cases and Tests

- Workflow: WF-P3-STATUS
- Phase: P3 Run Creation & DAG Validation
- Step: 1 (Cases and Tests)
- Date: 2026-06-07
- Author: subagent (workflow lead)

## Slice Boundary

- Slice name: WF-P3-STATUS
- Bounded context: CLI / Application layer. Read-only command that consumes the
  Run Runtime artifacts produced by WF-P3-RUN. The slice does not own state and
  does not advance run state (RC-S06).
- User tasks covered (≤ 3 user-visible tasks):
  1. **用户可完成** 运行 `zigma-flow status` 在 P3 已创建至少一个 run 的项目里，
     默认看到最近一次 run 的整体状态：`run_id`、`workflow`、`task`、`created_at`、
     所有 jobs 的 `status` 与（若声明）`activation` / `attempt`、ready jobs 列表、
     waiting jobs 的阻塞依赖、inactive jobs 列表，以及下一步操作建议
     （`zigma-flow prompt --job <id>` / `zigma-flow step --job <id>` 等）。
  2. **用户可完成** 通过 `zigma-flow status --run <run_id>` 查看历史 run，
     而不是默认的最近一次。
  3. **用户可完成** 在 state.json 丢失或损坏的项目里运行 `zigma-flow status`，
     拿到一个明确的、可操作的错误提示（FilesystemError），命令以非零退出，
     **不** 写入或修改任何 state、events 或 run 目录（RC-S06）。
- Planned test files (1 / max 1):
  - `tests/commands/status.test.ts` — vitest suite covering `findRun`,
    `renderRunStatus`, and `statusAction` end-to-end against real
    `os.tmpdir()` directories.

The CLI binding (`src/cli.ts` integration) is out of scope for this slice —
Step 2 will export `statusAction` and the implementer will wire commander in
the same step. The exported `statusAction(options, runsDir?)` accepts an
injected `runsDir` argument so the unit tests can exercise the full action
without spawning a real CLI process.

## Workflow Goal

Deliver the `status` command read path on top of the WF-P3-RUN runtime:

- A pure `findRun(runsDir, runId?)` helper that picks the requested run dir
  (or the most recent one) and throws `FilesystemError` on miss.
- A pure `renderRunStatus(state, workflowJobs)` function that formats a
  `RunState` plus minimal workflow job metadata (`needs`) into a human-readable
  string. It is pure (returns a string; does not touch stdout) so it can be
  snapshot-tested without spies.
- A `statusAction(options, runsDir?)` CLI handler that resolves the runs
  directory, calls `findRun` + `LocalStateStore.readSnapshot` + `renderRunStatus`,
  and writes the rendered string to stdout via a single `console.log`.

P3 scope ends at "display state". No step execution, no state mutation, no
event append. Those belong to P4+.

## Module Layout (for Step 2 to implement)

Step 2 will create `src/commands/status.ts` exporting:

```ts
export interface StatusOptions {
  run?: string; // specific run_id, or undefined for latest
}

// Find the latest run dir or a specified one;
// throws FilesystemError if not found.
export async function findRun(runsDir: string, runId?: string): Promise<string>;

// Render RunState to a human-readable string.
// Pure: no stdout, no fs, no state mutation.
export function renderRunStatus(
  state: RunState,
  workflowJobs: Record<string, { needs?: string[] }>,
): string;

// CLI action handler — computes runsDir from process.cwd() when not injected,
// calls findRun + LocalStateStore.readSnapshot + renderRunStatus + console.log.
export async function statusAction(
  options: StatusOptions,
  runsDir?: string,
): Promise<void>;
```

Tests import from `"../../src/commands/status.js"` and reuse `RunState`,
`JobState` from `"../../src/run/index.js"`.

The `workflowJobs` argument carries only the `needs` map. For Step 1 tests,
`statusAction` is required to operate without loading the workflow YAML
(see UC-RENDER-3 for how unfulfilled-needs are derived purely from
`RunState.jobs[*].status === "waiting"` plus the `needs` map). Step 2 may
either pass an empty `{}` when the workflow file is unavailable or load
needs from `run.yml` — both choices satisfy RC-S04 because waiting jobs are
already visible in `RunState`; the `needs` data only enriches the rendering.

## Spec Compliance Matrix

The six RC clauses below come from PRD FR-005 and MVP Contracts §2.3.
They match the development plan exactly.

| #      | Clause (origin)                                                              | Use cases covering it             |
| ------ | ---------------------------------------------------------------------------- | --------------------------------- |
| RC-S01 | PRD FR-005 — display run status (`run_id`, `workflow`, `task`, `created_at`) | UC-RENDER-1, UC-ACTION-1          |
| RC-S02 | PRD FR-005 — display all job statuses, incl. `activation` and `attempt`      | UC-RENDER-2, UC-ACTION-1          |
| RC-S03 | PRD FR-005 — list ready jobs                                                 | UC-RENDER-2, UC-ACTION-1          |
| RC-S04 | PRD FR-005 — list waiting jobs with unfulfilled `needs`                      | UC-RENDER-3                       |
| RC-S05 | PRD FR-005 — display next-step suggestion                                    | UC-RENDER-4, UC-ACTION-1          |
| RC-S06 | Contracts §2.3 — when `state.json` is missing/malformed, CLI does not advance run | UC-FIND-3, UC-ACTION-3, UC-ACTION-4 |

6 spec constraints referenced — within the ≤ 15 budget and exactly the count
mandated by Step 1.

## Functional Points

| FP id           | Area                                | Source              | Summary                                                              |
| --------------- | ----------------------------------- | ------------------- | -------------------------------------------------------------------- |
| FP-STATUS-FIND  | findRun                             | Plan §4 WF-P3-STATUS | Pick latest run dir (lexicographic descending) or named one          |
| FP-STATUS-READ  | LocalStateStore.readSnapshot reuse  | Plan §4 WF-P3-STATUS | Read state.json via the existing port; null/throw on missing/bad     |
| FP-STATUS-RENDER| renderRunStatus                     | Plan §4 WF-P3-STATUS | Format header, job table, ready/waiting/inactive summary, next step  |
| FP-STATUS-ERR   | error paths                         | Plan §4 WF-P3-STATUS | FilesystemError surfaces and propagates without mutating runtime    |

## Use Cases

| UC id        | Actor   | Trigger                                                              | Pre-conditions                                                                         | Steps (happy / error path)                                                                                              | Post-conditions / observable result                                                                                                                |
| ------------ | ------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| UC-FIND-1    | Lib     | `findRun(runsDir)` with one run dir present                          | `runsDir/20260607-0001/` exists                                                        | Read dir entries, sort descending, take first.                                                                          | Returns absolute path `<runsDir>/20260607-0001`.                                                                                                   |
| UC-FIND-2    | Lib     | `findRun(runsDir)` with multiple run dirs                            | `runsDir/{20260606-0001, 20260607-0001, 20260607-0002}/` exist                         | Sort descending; pick first.                                                                                            | Returns `<runsDir>/20260607-0002`.                                                                                                                 |
| UC-FIND-3    | Lib     | `findRun(runsDir)` with no run dirs                                  | `runsDir` exists but empty (or missing)                                                | No candidates.                                                                                                          | Throws `FilesystemError` (RC-S06).                                                                                                                 |
| UC-FIND-4    | Lib     | `findRun(runsDir, "20260607-0001")` with that run dir present        | `runsDir/20260607-0001/` exists                                                        | Stat the explicit dir.                                                                                                  | Returns its absolute path.                                                                                                                         |
| UC-FIND-5    | Lib     | `findRun(runsDir, "does-not-exist")`                                 | `runsDir` exists; the requested id does not                                            | Stat the explicit dir, miss.                                                                                            | Throws `FilesystemError` (RC-S06).                                                                                                                 |
| UC-RENDER-1  | Lib     | `renderRunStatus(state, {})` with header fields                      | `state.run_id`, `state.workflow`, `state.task`, `state.created_at` are populated       | Format header block.                                                                                                    | Returned string contains the run_id, workflow name, task, and created_at substrings (RC-S01).                                                       |
| UC-RENDER-2  | Lib     | `renderRunStatus(state, {})` with mixed job statuses                 | `state.jobs` contains a `ready`, a `waiting`, an `inactive`, and a `running` job, one of which has `activation` and one has `attempt` | Format job table and per-bucket summary.                                                                                | Output contains each job id, the literal status keywords (`ready`, `waiting`, `inactive`), the `activation` value, and the `attempt` value (RC-S02, RC-S03). |
| UC-RENDER-3  | Lib     | `renderRunStatus(state, workflowJobs)` for a waiting job             | `state.jobs.plan.status === "waiting"`; `workflowJobs.plan.needs === ["intake","code-map"]` | Cross-reference waiting jobs with workflow `needs`.                                                                     | Output mentions `plan` along with its unfulfilled dependencies `intake` and `code-map` (RC-S04).                                                    |
| UC-RENDER-4  | Lib     | `renderRunStatus(state, {})` with at least one ready job             | `state.jobs.intake.status === "ready"`                                                 | Append next-step suggestion section.                                                                                    | Output contains a `next` / `next step` hint and a `zigma-flow` command referencing a ready job id (RC-S05).                                       |
| UC-RENDER-5  | Lib     | `renderRunStatus(state, {})` with no ready jobs                      | All jobs `inactive` or `waiting` or terminal                                           | Append next-step suggestion section.                                                                                    | Output contains a next-step hint that does not crash (string is returned, mentions "no ready" or equivalent) (RC-S05).                            |
| UC-ACTION-1  | CLI     | `statusAction({}, runsDir)` against a real run                       | `runsDir/<id>/state.json` exists and is valid                                          | findRun → readSnapshot → renderRunStatus → `console.log`.                                                              | `console.log` is invoked exactly once with a string containing the run header, all job statuses, and a next-step hint (RC-S01..S03, S05).         |
| UC-ACTION-2  | CLI     | `statusAction({ run: "20260607-0001" }, runsDir)` with that id existing | `runsDir/20260607-0001/state.json` valid                                              | Use explicit run id; happy path.                                                                                        | Logged string contains `20260607-0001` (RC-S01).                                                                                                   |
| UC-ACTION-3  | CLI     | `statusAction({}, runsDir)` when no runs exist                       | `runsDir` empty                                                                        | findRun throws.                                                                                                         | `statusAction` rejects with `FilesystemError` (RC-S06).                                                                                            |
| UC-ACTION-4  | CLI     | `statusAction({}, runsDir)` when state.json is missing               | run dir exists but `state.json` does not                                               | readSnapshot returns `null` → action throws `FilesystemError`.                                                          | `statusAction` rejects with `FilesystemError` (RC-S06).                                                                                            |
| UC-ACTION-5  | CLI     | `statusAction({}, runsDir)` when state.json is malformed JSON        | `state.json` contains invalid JSON                                                     | `LocalStateStore.readSnapshot` throws `FilesystemError` (the existing adapter wraps fs/parse errors).                    | `statusAction` rejects with `FilesystemError` (RC-S06).                                                                                            |

## Test Mapping

| Test id    | File                            | `describe` → `it`                                                                                                | UCs covered                       | FPs covered      | RCs touched         |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------- | ------------------- |
| T-FIND-1   | `tests/commands/status.test.ts` | `findRun` → `returns the only run dir when one exists`                                                           | UC-FIND-1                         | FP-STATUS-FIND   | RC-S01              |
| T-FIND-2   | `tests/commands/status.test.ts` | `findRun` → `returns the lexicographically largest run dir when multiple exist`                                  | UC-FIND-2                         | FP-STATUS-FIND   | RC-S01              |
| T-FIND-3   | `tests/commands/status.test.ts` | `findRun` → `throws FilesystemError when no runs exist`                                                          | UC-FIND-3                         | FP-STATUS-FIND   | RC-S06              |
| T-FIND-4   | `tests/commands/status.test.ts` | `findRun` → `returns the requested run dir when given an explicit run id`                                        | UC-FIND-4                         | FP-STATUS-FIND   | RC-S01              |
| T-FIND-5   | `tests/commands/status.test.ts` | `findRun` → `throws FilesystemError when the explicit run id does not exist`                                     | UC-FIND-5                         | FP-STATUS-FIND   | RC-S06              |
| T-REND-1   | `tests/commands/status.test.ts` | `renderRunStatus` → `includes run_id, workflow, task, and created_at in the header`                              | UC-RENDER-1                       | FP-STATUS-RENDER | RC-S01              |
| T-REND-2   | `tests/commands/status.test.ts` | `renderRunStatus` → `lists each job with its status, activation, and attempt`                                    | UC-RENDER-2                       | FP-STATUS-RENDER | RC-S02, RC-S03      |
| T-REND-3   | `tests/commands/status.test.ts` | `renderRunStatus` → `lists waiting jobs with their unfulfilled needs from workflowJobs`                          | UC-RENDER-3                       | FP-STATUS-RENDER | RC-S04              |
| T-REND-4   | `tests/commands/status.test.ts` | `renderRunStatus` → `emits a next-step suggestion that references a ready job id`                                | UC-RENDER-4                       | FP-STATUS-RENDER | RC-S05              |
| T-REND-5   | `tests/commands/status.test.ts` | `renderRunStatus` → `still emits a next-step section when there are no ready jobs`                               | UC-RENDER-5                       | FP-STATUS-RENDER | RC-S05              |
| T-ACT-1    | `tests/commands/status.test.ts` | `statusAction` → `prints run header, job table, and next-step hint for the latest run`                            | UC-ACTION-1                       | FP-STATUS-READ, FP-STATUS-RENDER | RC-S01..S03, S05 |
| T-ACT-2    | `tests/commands/status.test.ts` | `statusAction` → `accepts --run <run_id> and prints that specific run`                                            | UC-ACTION-2                       | FP-STATUS-FIND, FP-STATUS-READ   | RC-S01           |
| T-ACT-3    | `tests/commands/status.test.ts` | `statusAction` → `throws FilesystemError when no runs exist`                                                      | UC-ACTION-3                       | FP-STATUS-ERR    | RC-S06              |
| T-ACT-4    | `tests/commands/status.test.ts` | `statusAction` → `throws FilesystemError when state.json is missing in the run dir`                               | UC-ACTION-4                       | FP-STATUS-ERR    | RC-S06              |
| T-ACT-5    | `tests/commands/status.test.ts` | `statusAction` → `throws FilesystemError when state.json contains malformed JSON`                                 | UC-ACTION-5                       | FP-STATUS-ERR    | RC-S06              |

## Acceptance Criterion (用户可完成)

**用户可完成** 在 P3 已经创建过 run 的项目里运行 `zigma-flow status`（或
`zigma-flow status --run <run_id>`）并立即得到：

1. 当前 run 的 `run_id` / `workflow` / `task` / `created_at` 头信息（RC-S01）；
2. 每个 job 的 status、activation 与 attempt（RC-S02）；
3. ready 列表（RC-S03）；
4. waiting 列表及其阻塞依赖（RC-S04）；
5. 下一步推荐命令（RC-S05）。

且当 `state.json` 缺失、损坏或所选 run 不存在时，命令以 `FilesystemError`
非零退出而不修改运行状态（RC-S06）。

## Test Design Summary

- **Framework**: vitest (`describe` / `it` / `expect`).
- **Filesystem strategy**: each describe block creates a unique
  `os.tmpdir()` sub-directory in `beforeEach` and removes it in `afterEach`.
  Real reads/writes — no `fs` mocks (matches WF-P3-RUN's approach).
- **State fixtures**: tests write `state.json` fixtures with `writeFile +
  JSON.stringify`. They do NOT use `LocalStateStore.writeSnapshot` so the
  fixture format is independent of the production write path (UC-ACTION-5
  needs the freedom to write invalid JSON anyway).
- **Pure renderer**: `renderRunStatus` is asserted via substring presence
  (`expect(out).toContain(...)`). No golden-file snapshot — the rendering
  details are not contractual at this slice; only the listed substrings are.
- **Console spying**: `statusAction` tests spy on `console.log` with
  `vi.spyOn(console, "log").mockImplementation(() => {})`, then assert the
  call arguments. The spy is restored in `afterEach`.
- **Error assertions**: failure tests use `rejects.toBeInstanceOf(FilesystemError)`,
  matching the `kind` discriminator via `instanceof` (the same pattern used in
  `tests/run/infrastructure.test.ts`).
- **`exactOptionalPropertyTypes`**: optional fields (`activation`, `attempt`,
  `needs`) are assigned conditionally; we never set them to `undefined`.
- **Red phase**: tests will not compile until Step 2 creates
  `src/commands/status.ts` exporting `findRun`, `renderRunStatus`,
  `statusAction`, and `StatusOptions`. That is the intended Red signal.

## Test Gaps

- **CLI snapshot for `commands/status.ts` via commander**: the test budget is
  exactly 1 file; commander wiring is verified indirectly through
  `statusAction` invocation. Step 2 may add a smoke test under
  `tests/smoke/` only if it does not duplicate the assertions here.
- **Concurrent status reads vs in-flight createRun**: not covered; the slice
  is read-only and MVP is single-process (TD-P3-003).
- **Workflow loading inside `status`**: Step 2 may pass an empty `needs` map
  if it chooses not to load the workflow YAML. The waiting-jobs RC-S04 case
  is still satisfied because the rendering function is called with the
  `needs` map directly in tests.
