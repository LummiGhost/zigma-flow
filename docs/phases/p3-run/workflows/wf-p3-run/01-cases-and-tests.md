# WF-P3-RUN — Cases and Tests

- Workflow: WF-P3-RUN
- Phase: P3 Run Creation & DAG Validation
- Step: 1 (Cases and Tests)
- Date: 2026-06-07
- Author: subagent (workflow lead)

## Slice Boundary

- Slice name: WF-P3-RUN
- Bounded context: Run Runtime (owned by workflow engine), plus the infrastructure
  ports it requires (`Clock`, `IdGenerator`, `StateStore`, `EventWriter`) and run
  filesystem helpers (`createRunDirectory`, `writeRunYaml`, `snapshotSkillLock`).
- User tasks covered (≤ 3 user-visible tasks; the rest are infrastructure prep):
  1. **用户可完成** 运行
     `zigma-flow run .zigma-flow/workflows/code-change.yml --task "<desc>"`
     成功创建一个 run 实例（生成 run_id、run 目录、`run.yml`、`state.json`、
     `events.jsonl`、`skill-lock.snapshot.json`），并在 stdout 看到 run_id 与
     next-step 提示。
  2. **用户可完成** 在创建 run 后查看 `state.json`，看到所有 jobs 的初始状态
     符合 PRD FR-004：无依赖的必需 job 为 `ready`，有未满足 `needs` 的为
     `waiting`，声明 `activation: optional` 的为 `inactive`。
  3. **用户可完成** 在创建 run 后查看 `events.jsonl`，看到 `run_created` 事件
     以及每个初始 ready job 对应的 `job_ready` 事件，且 `state.last_event_id`
     与 `events.jsonl` 尾部 event id 完全一致。
- Planned test files (2 / max 2):
  - `tests/run/infrastructure.test.ts` — unit tests for the ports/adapters and
    pure filesystem helpers (`Clock`, `IdGenerator`, `StateStore`, `EventWriter`,
    `createRunDirectory`, `writeRunYaml`, `snapshotSkillLock`).
  - `tests/run/engine-create-run.test.ts` — integration tests for
    `engine.createRun(inputs)` end-to-end against real `os.tmpdir()` run
    directories.

The CLI handler (`commands/run.ts`) is enumerated as FP-CLI-RUN below; its
interactive behavior (exit code, stdout text) is covered indirectly by
`engine.createRun` assertions. Adding a dedicated CLI test file would exceed
the 2-file budget; that coverage is reserved for Step 2 if the implementer
deems it necessary, but must not add a third test file.

## Workflow Goal

Deliver the infrastructure for `zigma-flow run <workflow> --task <desc>`:

- A small set of ports (`Clock`, `IdGenerator`, `StateStore`, `EventWriter`) with
  local filesystem adapters.
- Run directory creation, `run.yml` writer, and skill-lock snapshot.
- `engine.createRun(inputs)` as the single Engine entry-point for run creation,
  responsible for: generating `run_id`, creating the run directory, loading the
  workflow, computing initial job states, writing the initial events, then
  atomically writing `state.json`.
- A thin `commands/run.ts` CLI handler that parses the `--task` flag, resolves
  paths, and calls `engine.createRun`.

P3 scope ends at run creation. No step execution, no Agent prompt, no script
run. Those belong to P4+.

## Module Layout

Implementation modules (created in Step 2; Step 1 only writes the tests that
import these symbols):

- `src/run/index.ts` exports the infrastructure pieces:
  - Ports: `Clock`, `IdGenerator`, `StateStore`, `EventWriter`
  - Adapters: `SystemClock`, `LocalRunIdGenerator`, `LocalStateStore`,
    `JsonlEventWriter`
  - Helpers: `createRunDirectory`, `writeRunYaml`, `snapshotSkillLock`
  - Types: `RunState`, `JobState`, `WorkflowEvent`, `RunYamlMeta`
- `src/engine/index.ts` exports `createRun(inputs: CreateRunInputs)` and
  `CreateRunInputs` / `CreateRunResult` types.
- `src/commands/run.ts` exports `runAction(workflowPath, options)`. Tests in
  Step 1 do not import this — coverage is via `engine.createRun`.

The tests use `import ... from "../../src/run/index.js"` and
`import ... from "../../src/engine/index.js"`.

## Run State / Event Schemas

```ts
interface JobState {
  status: "ready" | "waiting" | "inactive" | "running" | "done" | "failed";
  activation?: string; // present iff the workflow declares activation on the job
  attempt?: number;    // present iff retry-eligible; 0 or absent for initial state
}
interface RunState {
  run_id: string;
  workflow: string;       // workflow name (NOT path)
  task: string;
  created_at: string;     // ISO 8601, from Clock
  last_event_id: string;  // tail of events.jsonl
  jobs: Record<string, JobState>;
}
interface WorkflowEvent {
  id: string;              // "evt-001", "evt-002", ...
  type: string;            // "run_created" | "job_ready"
  run_id: string;
  timestamp: string;       // ISO 8601, from Clock
  payload: Record<string, unknown>;
}
```

Initial job state rules (deterministic from workflow definition):

- A job with `activation: optional` → `inactive` regardless of `needs`.
- A non-optional job with no `needs` (and no unmet hard deps) → `ready` (via
  `computeReadyJobs`).
- A non-optional job whose `needs` are not yet satisfied → `waiting`.

Write pipeline (engine.createRun must honour this order — RC-R11):

1. Create the run directory (`<runsDir>/<runId>/`).
2. Snapshot skill-lock into the run directory.
3. Write `run.yml`.
4. Append `run_created` event to `events.jsonl`.
5. For each initial `ready` job, append a `job_ready` event.
6. Read the tail event id from `events.jsonl`.
7. Atomically write `state.json` (tmp → rename), including `last_event_id`
   matching the tail event id.

## Acceptance Criteria

1. **M1 Clock port + SystemClock adapter (FP-INFRA-CLOCK)**
   - `Clock` is an interface with `now(): string`.
   - `SystemClock` returns a valid ISO 8601 timestamp (parsable via
     `Date.parse`, non-NaN).

2. **M2 IdGenerator port + LocalRunIdGenerator adapter (FP-INFRA-IDGEN)**
   - `LocalRunIdGenerator.nextRunId(runsDir)` returns a `YYYYMMDD-NNNN` string.
   - When `runsDir` does not exist or is empty, the counter starts at `0001`.
   - When `runsDir` contains one existing dir for today's date, the next id is
     incremented by 1 (`0002`).
   - The date portion is derived from a `Clock` (so the test can inject a
     deterministic fake clock).
   - Directories whose names do not match today's date prefix are ignored.

3. **M3 StateStore port + LocalStateStore adapter (FP-STORE-STATE)**
   - `readSnapshot(runDir)` returns `null` if `state.json` does not exist.
   - `readSnapshot(runDir)` parses and returns the existing snapshot when present.
   - `writeSnapshot(runDir, state)` writes atomically: writes to a temp file in
     the same directory, then renames over the target.
   - After a successful `writeSnapshot`, `readSnapshot` returns the value
     just written.
   - `validateLastEventId(runDir, expected)` resolves silently when
     `state.json.last_event_id === expected`, and throws `WorkflowError`
     otherwise.

4. **M4 EventWriter port + JsonlEventWriter adapter (FP-STORE-EVENT)**
   - `appendEvent(runDir, event)` appends one JSON line (with trailing `\n`)
     to `events.jsonl`.
   - After two appends, `readLastEventId(runDir)` returns the id of the
     second event.
   - `readLastEventId(runDir)` returns `null` when `events.jsonl` does not
     exist or is empty.

5. **M5 createRunDirectory (FP-RUN-DIR)**
   - `createRunDirectory(runId, runsDir)` creates `<runsDir>/<runId>/` (with
     parents if needed) and returns the absolute path.
   - The returned path exists and is a directory.

6. **M6 writeRunYaml (FP-RUN-YAML)**
   - `writeRunYaml(runDir, meta)` writes `run.yml` containing `task`, `workflow`
     (name + path), `created_at`, and `skill_lock_snapshot`.
   - YAML keys are recognizable via substring assertions (no full parse needed
     in tests).

7. **M7 snapshotSkillLock (FP-RUN-LOCK / RC-R12)**
   - Given a real `skill-lock.json`, copies it to
     `<runDir>/skill-lock.snapshot.json` and preserves contents.
   - When `skillLockPath` does not exist, throws `FilesystemError`.

8. **M8 engine.createRun (FP-ENGINE-CREATE / RC-R01..R11)**
   - Creates the full run directory layout (run.yml, state.json,
     events.jsonl, skill-lock.snapshot.json).
   - Returns `{ runId }` where `runId` matches `^\d{8}-\d{4}$`.
   - `state.json.run_id` equals the returned `runId`.
   - `state.json.workflow` equals the workflow name from the loaded definition.
   - `state.json.task` equals the input task.
   - `state.json.created_at` is ISO 8601.
   - `state.json.jobs` contains an entry per workflow job, with status
     `ready` / `waiting` / `inactive` matching FR-004 rules.
   - `state.json.last_event_id` matches the last line of `events.jsonl`.
   - `events.jsonl` begins with a `run_created` event followed by one
     `job_ready` event per initial ready job.
   - Event ids are sequential `evt-001`, `evt-002`, ….

9. **M9 commands/run.ts hint (FP-CLI-RUN)**
   - Module exports `runAction(workflowPath, options): Promise<void>` and
     reads `--task` from `options`. Behavior covered indirectly via Step 2's
     integration test that observes the produced run on disk. Direct CLI I/O
     assertions are deferred to Step 3 if the implementer decides one is
     warranted; they MUST NOT add a third test file.

## Spec Compliance Matrix

The twelve RC clauses below come from PRD FR-004, MVP Contracts §2.3 (Run
State), §2.4 (Event), and Architecture §7.3 (write pipeline) / §8.1 (run
directory ownership). They match the development plan exactly.

| #     | Clause (origin)                                                                                  | Use cases covering it          |
| ----- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| RC-R01 | PRD FR-004 — unique `run_id` in `YYYYMMDD-NNNN` format                                          | UC-IDGEN-1..3, UC-ENG-1        |
| RC-R02 | PRD FR-004 — run directory created                                                              | UC-DIR-1, UC-ENG-1             |
| RC-R03 | PRD FR-004 — `run.yml` records task, workflow, created_at, skill_lock_snapshot                  | UC-YAML-1, UC-ENG-1            |
| RC-R04 | PRD FR-004 — all required job states initialized                                                | UC-ENG-2, UC-ENG-3             |
| RC-R05 | PRD FR-004 — no-dep required jobs marked `ready`                                                | UC-ENG-2                       |
| RC-R06 | PRD FR-004 — `activation`-gated jobs marked `inactive`                                          | UC-ENG-3                       |
| RC-R07 | MVP Contracts §2.3 — `state.json` written only by Engine through StateStore                     | UC-STATE-3, UC-ENG-1 (boundary) |
| RC-R08 | MVP Contracts §2.3 — `state.last_event_id` matches event log tail                               | UC-ENG-4, UC-STATE-4           |
| RC-R09 | MVP Contracts §2.4 — `run_created` event appended to events.jsonl                               | UC-EVENT-1, UC-ENG-5           |
| RC-R10 | MVP Contracts §2.4 — `job_ready` event appended per initial ready job                           | UC-EVENT-2, UC-ENG-5           |
| RC-R11 | Architecture §7.3 — write order: compute → append event → atomic state write                     | UC-ENG-4, UC-ENG-6             |
| RC-R12 | Architecture §8.1 — `skill-lock.snapshot.json` placed in run directory                          | UC-LOCK-1, UC-ENG-1            |

12 spec constraints referenced — within the ≤ 15 budget.

## Functional Points

| FP id              | Area                         | Source                | Summary                                                                   |
| ------------------ | ---------------------------- | --------------------- | ------------------------------------------------------------------------- |
| FP-INFRA-CLOCK     | Clock port + SystemClock     | Plan §4 WF-P3-RUN     | ISO 8601 `now()`; injectable fake for deterministic tests                 |
| FP-INFRA-IDGEN     | IdGenerator + LocalRunId     | Plan §4 WF-P3-RUN     | `YYYYMMDD-NNNN`, derived from clock + scan of `runs/`                     |
| FP-STORE-STATE     | StateStore + LocalStateStore | Plan §4 WF-P3-RUN     | Read/write `state.json` atomically, tail-event-id assertion               |
| FP-STORE-EVENT     | EventWriter + JsonlEventWriter | Plan §4 WF-P3-RUN   | Append JSON line per event; read last id                                  |
| FP-RUN-DIR         | createRunDirectory           | Plan §4 WF-P3-RUN     | mkdir `<runsDir>/<runId>/` and return path                                |
| FP-RUN-YAML        | writeRunYaml                 | Plan §4 WF-P3-RUN     | Write `run.yml` with task / workflow / created_at / skill_lock_snapshot   |
| FP-RUN-LOCK        | snapshotSkillLock            | Plan §4 WF-P3-RUN     | Copy `skill-lock.json` → `<runDir>/skill-lock.snapshot.json`              |
| FP-ENGINE-CREATE   | engine.createRun             | Plan §4 WF-P3-RUN     | Orchestrates the full create-run pipeline (RC-R01..R11)                   |
| FP-CLI-RUN         | commands/run.ts              | Plan §4 WF-P3-RUN     | CLI handler — parses `--task`, calls `engine.createRun`, prints run_id    |

## Use Cases

| UC id        | Actor   | Trigger                                                                       | Pre-conditions                                                  | Steps (happy path)                                                                                                | Post-conditions / observable result                                                                                                  |
| ------------ | ------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| UC-CLOCK-1   | Lib     | `new SystemClock().now()`                                                     | none                                                            | Read system time, return ISO 8601 string.                                                                          | Returned string parses via `Date.parse` (non-NaN).                                                                                   |
| UC-IDGEN-1   | Lib     | `LocalRunIdGenerator(clock).nextRunId(emptyRunsDir)`                          | `runsDir` does not exist OR is empty; clock returns `2026-06-07` | Compute date prefix `20260607`, scan dir (empty), use count 0.                                                     | Returns `"20260607-0001"`.                                                                                                            |
| UC-IDGEN-2   | Lib     | `nextRunId(runsDir)` after one prior `20260607-0001/` exists                  | `runsDir/20260607-0001/` already on disk                        | Scan dir, find 1 today-prefix entry.                                                                              | Returns `"20260607-0002"`.                                                                                                            |
| UC-IDGEN-3   | Lib     | `nextRunId(runsDir)` with mixed entries                                       | `runsDir` contains `20260606-0001/` and `20260607-0001/`        | Scan dir, count today-prefix entries only.                                                                        | Returns `"20260607-0002"` (yesterday's run ignored).                                                                                  |
| UC-STATE-1   | Lib     | `LocalStateStore().readSnapshot(emptyDir)`                                    | `runDir/state.json` does not exist                              | Stat file (not found).                                                                                            | Returns `null`.                                                                                                                       |
| UC-STATE-2   | Lib     | `writeSnapshot(runDir, state)` then `readSnapshot(runDir)`                    | none                                                            | Write atomically; re-read.                                                                                        | Returned object deep-equals the written `state`.                                                                                     |
| UC-STATE-3   | Lib     | `writeSnapshot` is atomic                                                     | none                                                            | Write tmp + rename; observer never sees partial JSON.                                                              | After write, `state.json` is valid JSON and matches input. (The atomicity is asserted indirectly by writing twice and re-reading.) |
| UC-STATE-4   | Lib     | `validateLastEventId(runDir, "evt-005")` against snapshot with `evt-005` tail | snapshot exists                                                 | Read snapshot, compare ids.                                                                                       | Resolves without error.                                                                                                              |
| UC-STATE-5   | Lib     | `validateLastEventId(runDir, "evt-999")` against snapshot with `evt-005` tail | snapshot exists                                                 | Read snapshot, compare ids, mismatch.                                                                              | Throws `WorkflowError` (the contract clause for state/event divergence).                                                              |
| UC-EVENT-1   | Lib     | `appendEvent(runDir, ev)` then `readLastEventId(runDir)`                      | none                                                            | Append a single JSON line to `events.jsonl`; read tail.                                                            | `readLastEventId` returns `ev.id`.                                                                                                   |
| UC-EVENT-2   | Lib     | Append two events                                                             | none                                                            | First event id `evt-001`; second `evt-002`.                                                                        | `readLastEventId` returns `"evt-002"`; the file contains two lines.                                                                  |
| UC-EVENT-3   | Lib     | `readLastEventId(runDir)` on empty/missing log                                | `events.jsonl` does not exist                                   | Stat / readFile → empty or missing.                                                                                | Returns `null`.                                                                                                                       |
| UC-DIR-1     | Lib     | `createRunDirectory("20260607-0001", runsDir)`                                | parent `runsDir` may or may not exist                           | mkdir with recursive.                                                                                              | `<runsDir>/20260607-0001/` exists and is a directory; the returned path equals that absolute path.                                  |
| UC-YAML-1    | Lib     | `writeRunYaml(runDir, meta)`                                                  | `runDir` exists                                                 | Render YAML with `task`, `workflow.name`, `workflow.path`, `created_at`, `skill_lock_snapshot`.                    | `run.yml` exists; contents contain `task:`, `workflow:`, `created_at:`, `skill_lock_snapshot:`.                                       |
| UC-LOCK-1    | Lib     | `snapshotSkillLock(runDir, validLockPath)`                                    | `skill-lock.json` exists                                        | Copy bytes to `<runDir>/skill-lock.snapshot.json`.                                                                  | Snapshot file exists and matches the source bytes.                                                                                   |
| UC-LOCK-2    | Lib     | `snapshotSkillLock(runDir, missingLockPath)`                                  | source path does not exist                                      | Read source → fails.                                                                                              | Throws `FilesystemError`.                                                                                                            |
| UC-ENG-1     | Engine  | `engine.createRun({ workflowPath, task, runsDir, skillLockPath })`            | valid workflow + skill-lock fixtures on disk                    | Generate runId, create dir, load workflow, write run.yml, snapshot lock, append events, write state.json.          | Returns `{ runId }`; all four files (`run.yml`, `state.json`, `events.jsonl`, `skill-lock.snapshot.json`) exist under run dir.       |
| UC-ENG-2     | Engine  | createRun on the bundled `code-change` style workflow                         | workflow has `intake` (no needs) and `code-map` (needs intake)  | Compute initial states.                                                                                            | `state.jobs.intake.status === "ready"`; `state.jobs["code-map"].status === "waiting"`.                                              |
| UC-ENG-3     | Engine  | createRun on a workflow with an `activation: optional` job                    | optional job has no `needs`                                     | Compute initial states.                                                                                            | `state.jobs[optionalJob].status === "inactive"` and `activation === "optional"`.                                                    |
| UC-ENG-4     | Engine  | createRun, then inspect `state.last_event_id` vs events.jsonl tail            | none                                                            | After create, read both.                                                                                          | The two ids are equal (RC-R08 / RC-R11).                                                                                            |
| UC-ENG-5     | Engine  | createRun, then inspect events                                                | workflow has exactly N initial ready jobs                       | Read events.jsonl line by line.                                                                                    | Line 1 has `type === "run_created"`; lines 2..N+1 have `type === "job_ready"` and reference each initial ready job exactly once.    |
| UC-ENG-6     | Engine  | createRun write order                                                         | none                                                            | createRun completes successfully.                                                                                  | `events.jsonl` has at least one line BEFORE `state.json` is finalized — asserted indirectly by verifying both files exist and `state.last_event_id` was read from the event log (RC-R11). |
| UC-ENG-7     | Engine  | createRun with `code-change` workflow exposes deterministic run id            | runsDir is empty, clock fixed to `2026-06-07T00:00:00Z`         | Generate id with fake clock + empty runsDir.                                                                       | Returned `runId === "20260607-0001"`.                                                                                                |

## Test Mapping

| Test id       | File                                  | `describe` → `it`                                                                                       | UCs covered                | FPs covered          | RCs touched         |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------- | ------------------- |
| T-CLOCK-1     | `tests/run/infrastructure.test.ts`    | `SystemClock` → `returns an ISO 8601 timestamp`                                                         | UC-CLOCK-1                 | FP-INFRA-CLOCK       | —                   |
| T-IDGEN-1     | `tests/run/infrastructure.test.ts`    | `LocalRunIdGenerator` → `starts the counter at 0001 for an empty runs dir`                              | UC-IDGEN-1                 | FP-INFRA-IDGEN       | RC-R01              |
| T-IDGEN-2     | `tests/run/infrastructure.test.ts`    | `LocalRunIdGenerator` → `increments the counter when a prior run exists for today`                      | UC-IDGEN-2                 | FP-INFRA-IDGEN       | RC-R01              |
| T-IDGEN-3     | `tests/run/infrastructure.test.ts`    | `LocalRunIdGenerator` → `ignores run directories from other dates`                                      | UC-IDGEN-3                 | FP-INFRA-IDGEN       | RC-R01              |
| T-STATE-1     | `tests/run/infrastructure.test.ts`    | `LocalStateStore` → `readSnapshot returns null when state.json is missing`                              | UC-STATE-1                 | FP-STORE-STATE       | —                   |
| T-STATE-2     | `tests/run/infrastructure.test.ts`    | `LocalStateStore` → `writeSnapshot then readSnapshot round-trips the state object`                      | UC-STATE-2, UC-STATE-3     | FP-STORE-STATE       | RC-R07              |
| T-STATE-3     | `tests/run/infrastructure.test.ts`    | `LocalStateStore` → `validateLastEventId resolves when the snapshot matches`                            | UC-STATE-4                 | FP-STORE-STATE       | RC-R08              |
| T-STATE-4     | `tests/run/infrastructure.test.ts`    | `LocalStateStore` → `validateLastEventId throws WorkflowError on mismatch`                              | UC-STATE-5                 | FP-STORE-STATE       | RC-R08              |
| T-EVENT-1     | `tests/run/infrastructure.test.ts`    | `JsonlEventWriter` → `appendEvent then readLastEventId returns the single appended id`                  | UC-EVENT-1                 | FP-STORE-EVENT       | RC-R09              |
| T-EVENT-2     | `tests/run/infrastructure.test.ts`    | `JsonlEventWriter` → `appendEvent twice and readLastEventId returns the second id`                      | UC-EVENT-2                 | FP-STORE-EVENT       | RC-R09, RC-R10      |
| T-EVENT-3     | `tests/run/infrastructure.test.ts`    | `JsonlEventWriter` → `readLastEventId returns null when events.jsonl is missing`                        | UC-EVENT-3                 | FP-STORE-EVENT       | —                   |
| T-DIR-1       | `tests/run/infrastructure.test.ts`    | `createRunDirectory` → `creates the run directory and returns its absolute path`                        | UC-DIR-1                   | FP-RUN-DIR           | RC-R02              |
| T-YAML-1      | `tests/run/infrastructure.test.ts`    | `writeRunYaml` → `writes run.yml with task, workflow name+path, created_at, skill_lock_snapshot`        | UC-YAML-1                  | FP-RUN-YAML          | RC-R03              |
| T-LOCK-1      | `tests/run/infrastructure.test.ts`    | `snapshotSkillLock` → `copies skill-lock.json to skill-lock.snapshot.json`                              | UC-LOCK-1                  | FP-RUN-LOCK          | RC-R12              |
| T-LOCK-2      | `tests/run/infrastructure.test.ts`    | `snapshotSkillLock` → `throws FilesystemError when skill-lock.json does not exist`                      | UC-LOCK-2                  | FP-RUN-LOCK          | RC-R12              |
| T-ENG-1       | `tests/run/engine-create-run.test.ts` | `engine.createRun` → `creates run directory with run.yml, state.json, events.jsonl, skill-lock snapshot` | UC-ENG-1                   | FP-ENGINE-CREATE     | RC-R02, RC-R03, RC-R12 |
| T-ENG-2       | `tests/run/engine-create-run.test.ts` | `engine.createRun` → `returns a YYYYMMDD-NNNN run id matching state.run_id`                             | UC-ENG-1, UC-ENG-7         | FP-ENGINE-CREATE     | RC-R01              |
| T-ENG-3       | `tests/run/engine-create-run.test.ts` | `engine.createRun` → `marks no-dependency required jobs as ready and dependent jobs as waiting`         | UC-ENG-2                   | FP-ENGINE-CREATE     | RC-R04, RC-R05      |
| T-ENG-4       | `tests/run/engine-create-run.test.ts` | `engine.createRun` → `marks activation: optional jobs as inactive`                                      | UC-ENG-3                   | FP-ENGINE-CREATE     | RC-R06              |
| T-ENG-5       | `tests/run/engine-create-run.test.ts` | `engine.createRun` → `state.last_event_id equals the last line of events.jsonl`                         | UC-ENG-4                   | FP-ENGINE-CREATE     | RC-R08, RC-R11      |
| T-ENG-6       | `tests/run/engine-create-run.test.ts` | `engine.createRun` → `writes run_created then one job_ready per initial ready job, sequential ids`      | UC-ENG-5                   | FP-ENGINE-CREATE     | RC-R09, RC-R10      |
| T-ENG-7       | `tests/run/engine-create-run.test.ts` | `engine.createRun` → `state.json is the run-state shape expected by the contract`                       | UC-ENG-1                   | FP-ENGINE-CREATE     | RC-R04, RC-R07      |

## Test Design Summary

- **Framework**: vitest (`describe` / `it` / `expect`).
- **Filesystem strategy**: each describe block creates a unique
  `os.tmpdir()` sub-directory in `beforeEach` and removes it in `afterEach`.
  No mocks of `fs` — real filesystem reads/writes only, to satisfy the
  "Do NOT mock the file system for integration tests" rule.
- **Clock injection**: `LocalRunIdGenerator` takes a `Clock` so tests can use a
  fixed-date fake (`FakeClock`) to make `run_id` deterministic. The fake is a
  trivial inline implementation of the `Clock` interface.
- **Workflow fixtures**: integration tests construct workflow YAML inline as
  strings written to disk, then point `engine.createRun` at the file path. They
  do not depend on `init` templates so a future change to those templates does
  not silently rebreak the engine tests.
- **`exactOptionalPropertyTypes`**: optional fields (`activation`, `attempt`) are
  set with conditional property assignment in test fixtures; we never assign
  `undefined`.
- **Error assertions**: failure tests assert on the `ZigmaFlowError` subclass
  via `instanceof` plus the `kind` discriminator (`"FilesystemError"`,
  `"WorkflowError"`), not on the error message string.
- **Red phase**: tests will not compile until Step 2 implements:
  - `src/run/index.ts` (Clock, IdGenerator, StateStore, EventWriter,
    createRunDirectory, writeRunYaml, snapshotSkillLock + their types)
  - `src/engine/index.ts` (createRun + CreateRunInputs)
  Both source files currently export `{}` and therefore the test imports will
  fail to resolve the named symbols. That is the intended Red signal.

## Test Gaps

- **CLI snapshot for `commands/run.ts`**: deferred to Step 2 / Step 3 if the
  implementer adds it; the 2-file budget prohibits a dedicated CLI test file
  here. Coverage of `--task` parsing is delegated to commander itself plus the
  engine-level integration tests.
- **Atomicity under crash**: true crash-during-rename testing requires
  `node:fs/promises` faulting; out of scope for MVP. The atomic guarantee is
  asserted only by `writeSnapshot` round-trip (UC-STATE-3).
- **Concurrent `createRun` calls**: TD-P3-003 records this as accepted MVP
  debt; not covered.
- **State recovery from `events.jsonl`**: TD-P3-002 — full event-sourcing
  rebuild is out of MVP scope.
- **Permissions / workspace guard**: P3 boundary excludes FR-014; not tested
  here.
- **Status command**: WF-P3-STATUS owns those use cases. This workflow only
  guarantees that `state.json` and `events.jsonl` are written in a form
  status can later consume.
