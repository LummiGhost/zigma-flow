# WF-P3-DAG — Cases and Tests

- Workflow: WF-P3-DAG
- Phase: P3 Run Creation & DAG Validation
- Step: 1 (Cases and Tests)
- Date: 2026-06-07
- Author: subagent (workflow lead)

## Slice Boundary

- Slice name: WF-P3-DAG
- Bounded context: Workflow Definition (owned by workflow loader and DAG validator).
  The `dag/` module is a pure-function library inside this context. It MUST NOT
  access the file system, MUST NOT import from `commander`, `execa`, `simple-git`,
  or any infrastructure adapter. It only consumes the `JobDefinition`-shaped data
  produced by `src/workflow/index.ts`.
- User tasks covered (3 / max 3):
  1. 用户可完成运行 `zigma-flow validate <workflow.yml>` 看到 `needs` 或
     `optional_needs` 引用不存在 job 时的字段级错误（RC-07，关闭 TD-P2-001 的一半）。
  2. 用户可完成运行 `zigma-flow validate <workflow.yml>` 看到 workflow 出现
     循环依赖时的循环路径错误（RC-08，关闭 TD-P2-001 的另一半）。
  3. 用户可完成（间接地，通过 P3-RUN 步骤的依赖）调用 `computeReadyJobs` 得到
     当前可执行 job 列表，为 WF-P3-RUN 的 `engine.createRun` 提供输入。
- Planned test files (1 / max 2):
  - `tests/dag/dag.test.ts` — DAG 模块三函数（`validateNeedsReferences`、
    `detectCycles`、`computeReadyJobs`）的纯函数单元测试。

Slice within 3-user-task and 2-test-file budget. Integration into `loadWorkflow`
and the `validate` CLI command is reserved for Step 2 (WF-P3-DAG implementation),
not enumerated here.

## Workflow Goal

Deliver the `dag/` pure-function module as the single source of truth for DAG
topology checks and ready-job computation:

- `validateNeedsReferences(jobs)` — verify all `needs`/`optional_needs` ids exist
  in the `jobs` map; return `{ valid, errors }` rather than throwing.
- `detectCycles(jobs)` — DFS with white/grey/black color marking; return `null`
  when the graph is acyclic, or an array of cycle paths (each path is an ordered
  list of job ids forming the cycle).
- `computeReadyJobs(jobs, completedJobIds, activeJobIds)` — return the ids of
  jobs that are not yet completed, not currently active, and whose `needs` are
  fully satisfied by `completedJobIds`. `optional_needs` are NOT required to be
  satisfied (optional dependencies do not block readiness).

The module exports these as pure functions with no observable side effects, no
filesystem access, no logger calls, and no dependencies outside `src/workflow`
types and Node built-ins. Step 2 wires `validateNeedsReferences` and
`detectCycles` into `loadWorkflow` to close FR-002 (RC-07, RC-08) and discharge
TD-P2-001.

## Acceptance Criteria

1. **M1 Needs Reference Validation (FP-DAG-NR)**
   - Empty jobs map returns `{ valid: true, errors: [] }`.
   - A single job with no `needs` returns `{ valid: true, errors: [] }`.
   - Legal linear chain (`A -> B -> C` via `needs`) returns valid.
   - A job whose `needs` lists `ghost` (no such job) returns
     `{ valid: false, errors: [...] }`; the error string identifies the
     referencing job and the missing target.
   - A job whose `optional_needs` references a non-existent job returns
     `valid: false` with an error identifying the optional reference.
   - Mixed case (`needs: [valid]`, `optional_needs: [missing]`) returns
     `valid: false` and the error pertains to the optional reference; the valid
     hard need is not reported.
   - Multiple invalid references across multiple jobs surface multiple errors;
     none are silently dropped.

2. **M2 Cycle Detection (FP-DAG-CYCLE)**
   - Empty jobs map returns `null`.
   - Single job with no `needs` returns `null`.
   - Linear chain (A -> B -> C) returns `null`.
   - Fork (A -> B, A -> C) returns `null`.
   - Join (B -> D, C -> D) returns `null`.
   - Diamond (A -> B -> D, A -> C -> D) returns `null`.
   - Self-loop (A needs A) returns a non-empty array containing the path `[A, A]`
     (or `[A]` repeated to indicate self-reference — see test for exact shape).
   - Simple two-node cycle (A -> B -> A) returns a non-empty array containing
     a cycle path that includes both `A` and `B`.
   - Multi-node cycle (A -> B -> C -> A) returns a non-empty array containing
     a path covering `A`, `B`, `C`.
   - Cycle detection considers only `needs` (hard dependencies), NOT
     `optional_needs`, because optional dependencies do not constrain run order
     and therefore cannot create a cycle that blocks the workflow.

3. **M3 Ready Job Computation (FP-DAG-READY)**
   - Empty jobs map returns `[]`.
   - With no jobs completed and no jobs active, every job with no `needs`
     appears in the ready set; jobs with unsatisfied `needs` do not.
   - When all of a job's `needs` are in `completedJobIds`, the job becomes
     ready, provided it is not in `completedJobIds` itself and not in
     `activeJobIds`.
   - A job already in `completedJobIds` is never returned as ready.
   - A job already in `activeJobIds` is never returned as ready.
   - `optional_needs` do NOT block readiness: a job with only
     `optional_needs` (and no `needs`) is ready immediately.
   - When all jobs are completed, the ready set is `[]`.

## Spec Compliance Matrix

The two enforcement clauses come from PRD FR-002 (DAG portion) and Architecture
§6.2 (WorkflowDefinition invariants). RC numbers continue the sequence opened by
WF-P2-VALIDATE (where RC-07 and RC-08 were carved out as TD-P2-001).

| #     | Clause (origin)                                                                       | Status                |
| ----- | ------------------------------------------------------------------------------------- | --------------------- |
| RC-07 | `needs`/`optional_needs` must refer to existing jobs (PRD FR-002, Arch §6.2)          | Covered by FP-DAG-NR  |
| RC-08 | DAG must not contain cycles (PRD FR-002, Arch §6.2)                                   | Covered by FP-DAG-CYCLE |
| RC-D1 | `dag/` module must not access file system or import infrastructure adapters (Arch §5.2, Contracts §5) | 通过 Step 2 实现自检 + tech-review |
| RC-D2 | `computeReadyJobs` is the single source of truth for "ready" semantics consumed by `engine.createRun` (Plan §4 WF-P3-RUN) | Covered by FP-DAG-READY |

Out-of-scope or deferred clauses recorded in **Test Gaps** below.

## Functional Points

| FP id         | Area                          | Source                | Summary                                                                      |
| ------------- | ----------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| FP-DAG-NR     | Needs reference check         | PRD FR-002 (RC-07)    | Return `{ valid, errors }` indicating which jobs reference missing ids       |
| FP-DAG-CYCLE  | Cycle detection (DFS, colors) | PRD FR-002 (RC-08)    | Return `null` or array of cycle paths using DFS white/grey/black marking     |
| FP-DAG-READY  | Ready job computation         | Plan §4 WF-P3-RUN     | Return ids of jobs whose `needs` are satisfied and that are not active/done  |
| FP-DAG-INT    | Integration into loadWorkflow | PRD FR-002 (RC-07/08) | Step 2: call `validateNeedsReferences` and `detectCycles` from loadWorkflow  |

FP-DAG-INT is the Step 2 deliverable; this Step-1 doc only enumerates the three
pure functions. FP-DAG-INT is mentioned here so the spec matrix and Step 2 plan
remain aligned.

## Use Cases

| UC id      | Actor | Trigger                                                       | Pre-conditions                                            | Steps (happy path)                                                          | Post-conditions / observable result                                          |
| ---------- | ----- | ------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| UC-NR-1    | Lib   | `validateNeedsReferences({})`                                 | Empty jobs map                                            | Iterate (no jobs).                                                            | Returns `{ valid: true, errors: [] }`.                                       |
| UC-NR-2    | Lib   | `validateNeedsReferences({ a: { steps: [] } })`               | Single job, no `needs`                                    | Iterate, find no references.                                                  | Returns `{ valid: true, errors: [] }`.                                       |
| UC-NR-3    | Lib   | Legal chain A -> B -> C                                       | Three jobs, each `needs` references existing job          | Iterate; every reference resolves.                                            | Returns `{ valid: true, errors: [] }`.                                       |
| UC-NR-4    | Lib   | Job `b.needs = ['ghost']`                                     | `ghost` does not exist in jobs map                        | Iterate; `b.needs[0]` misses.                                                 | Returns `valid: false`; errors list mentions `b` and `ghost`.                |
| UC-NR-5    | Lib   | Job `b.optional_needs = ['ghost']`                            | `ghost` does not exist in jobs map                        | Iterate; optional reference misses.                                           | Returns `valid: false`; errors list mentions `b` and `ghost`.                |
| UC-NR-6    | Lib   | `b.needs = ['a']`, `b.optional_needs = ['ghost']`             | `a` exists, `ghost` does not                              | Iterate; only optional reference misses.                                      | Returns `valid: false`; errors only mention the optional `ghost` reference.  |
| UC-NR-7    | Lib   | Multiple jobs each have a missing reference                   | `b.needs=['x']`, `c.needs=['y']`, neither `x` nor `y` exist | Iterate; both references miss.                                                | Returns `valid: false`; errors include entries for both `b` and `c`.         |
| UC-CYC-1   | Lib   | `detectCycles({})`                                            | Empty jobs map                                            | DFS visits nothing.                                                           | Returns `null`.                                                              |
| UC-CYC-2   | Lib   | `detectCycles` on single job no needs                         | Single job                                                | DFS visits one node white -> black.                                           | Returns `null`.                                                              |
| UC-CYC-3   | Lib   | Linear chain A -> B -> C                                      | Chain via `needs`                                         | DFS, no grey re-encounter.                                                    | Returns `null`.                                                              |
| UC-CYC-4   | Lib   | Fork A -> B, A -> C                                           | A is needed by B and C                                    | DFS, no grey re-encounter.                                                    | Returns `null`.                                                              |
| UC-CYC-5   | Lib   | Join B -> D, C -> D                                           | D needs both B and C                                      | DFS, no grey re-encounter.                                                    | Returns `null`.                                                              |
| UC-CYC-6   | Lib   | Diamond A -> B -> D, A -> C -> D                              | D needs B and C; both need A                              | DFS, no grey re-encounter.                                                    | Returns `null`.                                                              |
| UC-CYC-7   | Lib   | Self-loop: A `needs` A                                        | One job referencing itself                                | DFS sees A as grey when traversing A's own need.                              | Returns array containing a cycle path that includes `A`.                     |
| UC-CYC-8   | Lib   | Simple cycle A -> B -> A                                      | Two jobs with mutual `needs`                              | DFS visits A grey, B grey, B's need points back to grey A.                    | Returns array containing a cycle path that includes both `A` and `B`.        |
| UC-CYC-9   | Lib   | Multi-node cycle A -> B -> C -> A                             | Three-node ring                                           | DFS detects grey A when traversing C's need.                                  | Returns array containing a cycle path covering `A`, `B`, and `C`.            |
| UC-CYC-10  | Lib   | Cycle that only exists via `optional_needs` (A -> B -> A via optional) | Optional dependencies form a ring                  | DFS ignores optional edges entirely.                                          | Returns `null` (optional dependencies cannot form a blocking cycle).         |
| UC-RDY-1   | Lib   | `computeReadyJobs({}, new Set(), new Set())`                  | Empty jobs map                                            | Iterate nothing.                                                              | Returns `[]`.                                                                |
| UC-RDY-2   | Lib   | Three jobs with no completed, no active, B needs A, C no needs | Initial state                                            | A and C have no unmet `needs`; B's `needs=[A]` not satisfied.                 | Returns `['a', 'c']` (set semantics; ordering not asserted).                 |
| UC-RDY-3   | Lib   | Same as UC-RDY-2 but A is in `completedJobIds`                | A done                                                    | B's `needs` now satisfied.                                                    | Returns `['b', 'c']`.                                                        |
| UC-RDY-4   | Lib   | A, B, C all in `completedJobIds`                              | All done                                                  | Every job is completed.                                                       | Returns `[]`.                                                                |
| UC-RDY-5   | Lib   | A completed, B is in `activeJobIds`                           | B already running, C ready                                | B is skipped because active; C has no `needs`.                                | Returns `['c']` (excludes B).                                                |
| UC-RDY-6   | Lib   | Job has only `optional_needs`, none completed                 | `b.optional_needs=['a']`, `a` not done                    | Optional deps don't block readiness.                                          | Returns `['a', 'b']` (B is ready immediately).                               |
| UC-RDY-7   | Lib   | Job's `needs` partially satisfied                             | `c.needs=['a','b']`, only `a` completed                   | C is not ready.                                                               | Returns `[]` for C; A/B depending on their own state.                        |

## Test Mapping

| Test id    | File                  | Test name                                                                                            | UCs covered          | FPs covered     |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------- | -------------------- | --------------- |
| T-NR-1     | `tests/dag/dag.test.ts` | `validateNeedsReferences returns valid for empty jobs map`                                          | UC-NR-1              | FP-DAG-NR       |
| T-NR-2     | `tests/dag/dag.test.ts` | `validateNeedsReferences returns valid for single job with no needs`                                | UC-NR-2              | FP-DAG-NR       |
| T-NR-3     | `tests/dag/dag.test.ts` | `validateNeedsReferences returns valid for legal linear chain`                                      | UC-NR-3              | FP-DAG-NR       |
| T-NR-4     | `tests/dag/dag.test.ts` | `validateNeedsReferences flags needs referencing non-existent job`                                  | UC-NR-4              | FP-DAG-NR       |
| T-NR-5     | `tests/dag/dag.test.ts` | `validateNeedsReferences flags optional_needs referencing non-existent job`                         | UC-NR-5              | FP-DAG-NR       |
| T-NR-6     | `tests/dag/dag.test.ts` | `validateNeedsReferences reports only the invalid reference when needs valid and optional invalid`  | UC-NR-6              | FP-DAG-NR       |
| T-NR-7     | `tests/dag/dag.test.ts` | `validateNeedsReferences surfaces multiple missing references across jobs`                          | UC-NR-7              | FP-DAG-NR       |
| T-CYC-1    | `tests/dag/dag.test.ts` | `detectCycles returns null for empty jobs map`                                                      | UC-CYC-1             | FP-DAG-CYCLE    |
| T-CYC-2    | `tests/dag/dag.test.ts` | `detectCycles returns null for single job with no needs`                                            | UC-CYC-2             | FP-DAG-CYCLE    |
| T-CYC-3    | `tests/dag/dag.test.ts` | `detectCycles returns null for linear chain A -> B -> C`                                            | UC-CYC-3             | FP-DAG-CYCLE    |
| T-CYC-4    | `tests/dag/dag.test.ts` | `detectCycles returns null for fork A -> B, A -> C`                                                 | UC-CYC-4             | FP-DAG-CYCLE    |
| T-CYC-5    | `tests/dag/dag.test.ts` | `detectCycles returns null for join B -> D, C -> D`                                                 | UC-CYC-5             | FP-DAG-CYCLE    |
| T-CYC-6    | `tests/dag/dag.test.ts` | `detectCycles returns null for diamond A -> B -> D, A -> C -> D`                                    | UC-CYC-6             | FP-DAG-CYCLE    |
| T-CYC-7    | `tests/dag/dag.test.ts` | `detectCycles returns a cycle path for self-loop (A needs A)`                                       | UC-CYC-7             | FP-DAG-CYCLE    |
| T-CYC-8    | `tests/dag/dag.test.ts` | `detectCycles returns a cycle path for simple two-node cycle A -> B -> A`                           | UC-CYC-8             | FP-DAG-CYCLE    |
| T-CYC-9    | `tests/dag/dag.test.ts` | `detectCycles returns a cycle path for multi-node cycle A -> B -> C -> A`                           | UC-CYC-9             | FP-DAG-CYCLE    |
| T-CYC-10   | `tests/dag/dag.test.ts` | `detectCycles ignores optional_needs when looking for cycles`                                       | UC-CYC-10            | FP-DAG-CYCLE    |
| T-RDY-1    | `tests/dag/dag.test.ts` | `computeReadyJobs returns empty for empty jobs map`                                                 | UC-RDY-1             | FP-DAG-READY    |
| T-RDY-2    | `tests/dag/dag.test.ts` | `computeReadyJobs returns jobs with no needs when nothing completed`                                | UC-RDY-2             | FP-DAG-READY    |
| T-RDY-3    | `tests/dag/dag.test.ts` | `computeReadyJobs unlocks downstream job once its needs are satisfied`                              | UC-RDY-3             | FP-DAG-READY    |
| T-RDY-4    | `tests/dag/dag.test.ts` | `computeReadyJobs returns empty when all jobs are completed`                                        | UC-RDY-4             | FP-DAG-READY    |
| T-RDY-5    | `tests/dag/dag.test.ts` | `computeReadyJobs excludes jobs that are currently active`                                          | UC-RDY-5             | FP-DAG-READY    |
| T-RDY-6    | `tests/dag/dag.test.ts` | `computeReadyJobs treats optional_needs as non-blocking`                                            | UC-RDY-6             | FP-DAG-READY    |
| T-RDY-7    | `tests/dag/dag.test.ts` | `computeReadyJobs keeps a job waiting when only some of its needs are satisfied`                    | UC-RDY-7             | FP-DAG-READY    |

## Test Design Summary

- **Test framework**: vitest (`describe`, `it`, `expect`).
- **Imports**: only from `../../src/dag/index.js`; no import from `src/workflow`
  (to avoid coupling the test to non-DAG schema concerns). Job fixtures are
  inline plain objects shaped as
  `{ needs?: string[]; optional_needs?: string[]; steps: unknown[] }`.
- **No I/O**: tests do not touch the filesystem; nothing temporary is written.
- **Assertions**: cycle path assertions use set-membership over the cycle path
  array rather than exact ordering, because DFS starting node is
  implementation-detail-sensitive. Tests assert "at least one cycle reported"
  and "the cycle covers all expected ids".
- **Red phase**: tests will not compile until Step 2 supplies
  `src/dag/index.ts` and its three exported functions. That is expected and
  matches the test-driven workflow.

## Test Gaps

- **Integration into `loadWorkflow`**: wiring `validateNeedsReferences` and
  `detectCycles` into `loadWorkflow` and the `validate` CLI command is Step 2's
  deliverable, not Step 1's. End-to-end coverage (workflow YAML with cycle ->
  CLI exit 3 + field-level message) belongs to Step 2 acceptance tests, not
  this Step-1 unit-test file.
- **Performance / large DAGs**: MVP DAGs are small; we do not assert
  algorithmic bounds. If P4+ exposes larger DAGs, add complexity tests then.
- **Cross-pack `uses` references**: out of scope; tracked separately (see P2
  test gaps).
- **`activation: optional` semantics in `computeReadyJobs`**: this Step 1
  defines `activeJobIds` as the "considered for running" set, matching the
  engine model where an optional job is only added to `activeJobIds` after
  signal/router activation. The DAG module itself does not interpret
  `activation`; that is engine policy.
- **Cycle paths involving optional edges that would form a cycle when activated**:
  out of scope for MVP. Optional activation cycles, if they arise, will be
  detected at activation time by engine policy in a later phase.
