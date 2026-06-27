---
workflow: WF-P13-ENGINE-RUNALL
phase: p13
step: 1 (Cases and Tests)
date: 2026-06-27
status: draft
authority:
  - docs/phases/p13-agent-adapter-hardening/02-development-plan.md §5 (WF-P13-ENGINE-RUNALL)
  - AD-P13-001 (run-all main loop extraction)
  - AD-P13-007 (event ID sequence port)
---

# WF-P13-ENGINE-RUNALL — Step 1: Cases and Tests

## 1. Overview

This document enumerates every functional point and use case for the two
architectural decisions delivered by WF-P13-ENGINE-RUNALL:

- **AD-P13-001**: Extract the main execution loop from `src/commands/run-all.ts`
  into `src/engine/runAll.ts` so the engine is the sole state-writer and the
  CLI becomes a thin shell.
- **AD-P13-007**: Create `src/events/sequence.ts` with a reusable
  `nextSequentialEventId` function, replacing all scattered
  `parseInt(lastId.replace("evt-",""), 10)` calls.

This is a **design/test-authoring task** (TDD red phase). No source code is
implemented in this step. The test files will fail to compile until Step 2
ships `src/engine/runAll.ts` and `src/events/sequence.ts`.

## 2. Use Case Enumeration

### 2.1 runAll Engine Function (AD-P13-001)

#### UC-RUNALL-001: runAll can be called directly in tests without CLI

**Source:** FP-RUNALL-ENGINE (plan §5 Acceptance)

`runAll()` accepts a typed options object and returns a structured summary.
It does not depend on `process.cwd()`, `console.log`, or CLI argument parsing.
Tests inject fakes for `clock`, `stateStore`, `eventWriter`, and
`backendResolver`.

**Preconditions:**
- A valid `RunAllOpts` object with `task`, `workflowPath`, `runsDir`,
  `zigmaflowDir`, `skillLockPath`, `backendResolver`, and `clock`.

**Expected result:**
- `runAll()` returns `Promise<RunAllSummary>` with `runId`, `status`, `jobs`,
  and `iterations`.
- All state transitions are written through `stateStore.writeSnapshot`.
- All events are written through `eventWriter.appendEvent`.
- No `console.log` calls originate from within `runAll`; log output is
  emitted through the `onEvent` hook.

---

#### UC-RUNALL-002: Happy path — agent step to script step to router step completes

**Source:** FP-RUNALL-HAPPY (plan §5 Acceptance)

A workflow with one agent job that has three sequential steps (agent, script,
router) should complete successfully through the runAll loop.

**Preconditions:**
- Workflow YAML with one job containing steps: agent, script, router.
- Fake backend that returns `{ success: true }` and writes a valid report.
- Fake script runner that exits with code 0.
- Router step with `cases: { success: continue }`.

**Expected result:**
- `runAll()` returns `RunAllSummary` with `status: "completed"`.
- `jobs[0].status` is `"completed"`.
- Events include: `run_created`, `job_ready`, `prompt_generated`,
  `agent_report_accepted`, `script_completed`, `router_decided`,
  `job_completed`, `run_completed`.

---

#### UC-RUNALL-003: runAll with runId (resume) calls runAll without createRun

**Source:** FP-RUNALL-IDEMPOTENT (design: runId mutex with task)

When `opts.runId` is provided (instead of `opts.task`), `runAll` skips
`createRun` and starts the main loop against the existing run directory.

**Preconditions:**
- A run directory already exists in `runsDir/<runId>` with valid `state.json`,
  `events.jsonl`, `run.yml`.
- `opts.runId` is set (and `opts.task` is omitted or undefined).

**Expected result:**
- No new `run_created` event is emitted.
- The main loop reads the existing state and resumes iteration.
- If all jobs are already in a terminal state, returns immediately.

---

#### UC-RUNALL-004: Empty workflow — no ready jobs terminates cleanly

**Source:** FP-RUNALL-EMPTY (plan §5 Acceptance)

A workflow where all jobs have `activation` set (and are therefore `inactive`)
should terminate without error.

**Preconditions:**
- Workflow YAML with one job that has `activation: manual`.
- `createRun` creates the job as `inactive`.

**Expected result:**
- `runAll()` returns `RunAllSummary` with `status` undefined (no terminal
  status written).
- `iterations` is 0 (or minimal — entered loop, found no ready jobs,
  exited).
- No jobs are executed.

---

#### UC-RUNALL-005: MAX_ITERATIONS guard prevents infinite loops

**Source:** FP-RUNALL-MAX-ITER (plan §5 Acceptance)

The main loop has a configurable `maxIterations` (default 100). If the loop
exceeds this limit, it terminates and returns the summary reflecting the
current state.

**Preconditions:**
- Workflow YAML with a ready job that always stays `ready` (fake backend
  does not advance it).
- `opts.maxIterations` set to 3.

**Expected result:**
- `runAll()` returns `RunAllSummary` with `status: undefined` (not a
  terminal state, but loop exhausted).
- `iterations` equals `maxIterations`.
- An `onEvent` call reports the iteration-exceeded condition.

---

#### UC-RUNALL-006: runAll returns structured RunAllSummary

**Source:** FP-RUNALL-SUMMARY (plan §5 Acceptance)

The returned summary contains:
- `runId` — the run identifier.
- `status` — terminal status if reached, or undefined.
- `jobs` — array of `{ id, status, attempts }` for each job.
- `iterations` — number of loop iterations executed.

**Preconditions:**
- Any call to `runAll()` that completes without throwing.

**Expected result:**
- Return value is `RunAllSummary` with all fields present and correctly typed.
- `jobs` array length matches the number of jobs in the workflow.
- Each `jobs` entry has `id`, `status`, and `attempts` (number).

---

#### UC-RUNALL-007: runAll accepts injectable fakes

**Source:** FP-RUNALL-INJECT (plan §5 Acceptance)

The `RunAllOpts` interface accepts:
- `clock: Clock` — injectable for deterministic test timestamps.
- `stateStore` — for state read/write (defaults to `LocalStateStore`).
- `eventWriter` — for event append (defaults to `JsonlEventWriter`).
- `backendResolver: (stepBackendName?) => AgentBackend` — function to
  get a backend instance.
- `signal?: AbortSignal` — for cancellation.
- `maxIterations?: number` — overrides the 100-iteration default.
- `onEvent?: (e: ZigmaFlowEvent) => void` — log hook.

**Preconditions:**
- Test provides a `FakeClock` implementing `Clock`.
- Test provides a `backendResolver` that returns a test `AgentBackend`.

**Expected result:**
- Timestamps in events use the fake clock's `now()` value.
- Backend calls go through the provided resolver.

---

#### UC-RUNALL-008: runAll with AbortSignal cancels gracefully

**Source:** FP-RUNALL-CANCEL (design: signal propagation)

When `opts.signal` is aborted during backend execution, the loop stops and
returns a summary reflecting the cancelled state.

**Preconditions:**
- Workflow with a ready agent job.
- Fake backend that can be aborted mid-execution.
- `AbortController` provided as `opts.signal`.

**Expected result:**
- `runAll()` returns without throwing.
- Summary has `status: "cancelled"` or loop exits.
- No partial state corruption.

---

#### UC-RUNALL-009: runAll invokes correct backend per step

**Source:** FP-RUNALL-BACKEND (design: backendResolver)

When the workflow has a step with `step.backend` or `step.agent.backend`,
the resolver is called with that name. When no step-level backend is
specified, the resolver is called with `undefined` (default backend).

**Preconditions:**
- `backendResolver` is a mock function.
- Workflow step has `step.agent.backend: "custom"`.

**Expected result:**
- `backendResolver` is called with `"custom"`.
- The returned backend's `execute` method is called.

---

#### UC-RUNALL-010: non-agent steps are delegated to executeCurrentStep

**Source:** FP-RUNALL-DELEGATE (design: script/check/router path)

`runAll` delegates script, check, and router steps to `executeCurrentStep`
from `src/engine/index.ts`, preserving existing behavior for those step types.

**Preconditions:**
- Workflow with a ready job that has a script step.

**Expected result:**
- `executeCurrentStep` is called with the correct run/job/step parameters.
- The script step completes and emits `script_completed`.

---

### 2.2 Event ID Sequence Port (AD-P13-007)

#### UC-SEQ-001: nextSequentialEventId reads events.jsonl and returns next ID

**Source:** FP-SEQ-ID (plan §5, AD-P13-007)

`nextSequentialEventId(runDir)` reads `events.jsonl`, finds the last
event's id, parses the numeric part, increments, and formats.

**Preconditions:**
- `events.jsonl` exists with events ending at `evt-005`.

**Expected result:**
- Returns `"evt-006"`.

---

#### UC-SEQ-002: nextSequentialEventId returns "evt-001" when empty

**Source:** FP-SEQ-ID-FRESH (plan §5, AD-P13-007)

When `events.jsonl` does not exist or is empty, the function returns `"evt-001"`.

**Preconditions:**
- The run directory exists but `events.jsonl` is absent or has no lines.

**Expected result:**
- Returns `"evt-001"`.

---

#### UC-SEQ-003: nextSequentialEventId with eventWriter writes then reads

**Source:** FP-SEQ-ID-ROUNDTRIP (plan §5 Acceptance)

After appending an event via `EventWriter.appendEvent`, calling
`nextSequentialEventId` returns the next sequential ID.

**Preconditions:**
- A run directory with empty `events.jsonl`.
- An `EventWriter` (e.g., `JsonlEventWriter`).

**Expected result:**
- First call returns `"evt-001"`.
- After appending an event with that ID, second call returns `"evt-002"`.

---

#### UC-SEQ-004: All scattered parseInt(...replace(...)) calls are removed

**Source:** FP-SEQ-ID-DEDUP (plan §5, AD-P13-007)

Every direct `parseInt(id.replace("evt-", ""), 10)` call in the codebase is
replaced with a call to `nextSequentialEventId`. Affected files:
- `src/commands/run-all.ts` (lines 285-289)
- `src/engine/index.ts` (`appendJobCompleted`, line 419)
- Any other locations that parse event IDs manually.

**Preconditions:**
- Step 2 refactors all call sites.

**Expected result:**
- Grep for `replace("evt-"` in `src/` yields zero results.
- All event ID sequencing goes through `nextSequentialEventId`.

---

#### UC-SEQ-005: nextSequentialEventId handles malformed last event gracefully

**Source:** FP-SEQ-ID-ERROR (defensive design)

If the last line of `events.jsonl` is not valid JSON or lacks an `id` field,
the function throws a descriptive error.

**Preconditions:**
- `events.jsonl` last line is `{ not valid json }`.

**Expected result:**
- Throws `FilesystemError` or `ValidationError` with a message indicating
  the events log is corrupt.

---

### 2.3 Functional Point Coverage Matrix

| FP ID | Description | Use Cases |
|-------|-------------|-----------|
| FP-RUNALL-ENGINE | `runAll()` callable without CLI | UC-RUNALL-001, UC-RUNALL-007 |
| FP-RUNALL-HAPPY | agent -> script -> router flow | UC-RUNALL-002 |
| FP-RUNALL-EMPTY | no ready jobs terminates | UC-RUNALL-004 |
| FP-RUNALL-MAX-ITER | MAX_ITERATIONS guard | UC-RUNALL-005 |
| FP-RUNALL-SUMMARY | returns RunAllSummary | UC-RUNALL-006 |
| FP-RUNALL-INJECT | injectable clock, stateStore, eventWriter | UC-RUNALL-007 |
| FP-RUNALL-CANCEL | AbortSignal support | UC-RUNALL-008 |
| FP-RUNALL-BACKEND | backend resolver per step | UC-RUNALL-009 |
| FP-RUNALL-DELEGATE | dispatch to executeCurrentStep | UC-RUNALL-010 |
| FP-SEQ-ID | reads events.jsonl, returns next | UC-SEQ-001 |
| FP-SEQ-ID-FRESH | empty file -> "evt-001" | UC-SEQ-002 |
| FP-SEQ-ID-ROUNDTRIP | write then read | UC-SEQ-003 |
| FP-SEQ-ID-DEDUP | scattered parseInt removed | UC-SEQ-004 |
| FP-SEQ-ID-ERROR | malformed event handling | UC-SEQ-005 |

## 3. Test Plan

### 3.1 `tests/engine/runAll.test.ts`

**Red-phase note:** `src/engine/runAll.ts` does not exist. The test imports
from `../../src/engine/runAll.js` and uses a lazy-import wrapper (modeled
after `tests/engine/accept.test.ts`) so the file compiles in Step 1 and fails
at runtime with a clear diagnostic until Step 2 ships the module.

**Test cases:**

| Test ID | Use Case | Brief |
|---------|----------|-------|
| T-RUNALL-1 | UC-RUNALL-001, UC-RUNALL-002 | Happy path: single agent job (no-signal report) completes via fake backend |
| T-RUNALL-2 | UC-RUNALL-004 | Empty job list: workflow with `activation`-only jobs terminates cleanly |
| T-RUNALL-3 | UC-RUNALL-005 | MAX_ITERATIONS: loop exits after `maxIterations` reach limit |
| T-RUNALL-4 | UC-RUNALL-007 | Injectable clock: timestamps use `FakeClock.now()` |
| T-RUNALL-5 | UC-RUNALL-006 | Summary shape: returned value has correct `RunAllSummary` fields |
| T-RUNALL-6 | UC-RUNALL-003 | Resume via runId: loop reads existing state, does not createRun |
| T-RUNALL-7 | UC-RUNALL-009 | Backend resolver: mock resolver receives step backend name |
| T-RUNALL-8 | UC-RUNALL-010 | Script step delegation: script job completes via executeCurrentStep |

**Mocks and fakes:**
- `FakeClock` implements `Clock` with fixed ISO timestamp.
- `FakeBackend` implements `AgentBackend`, writes a valid report and returns
  `{ success: true }`.
- `FakeBackendFactory` returns `FakeBackend` for `backendResolver`.
- Temp directories under `os.tmpdir()` with `randomUUID()` suffixes,
  cleaned up in `afterEach`.

### 3.2 `tests/events/sequence.test.ts`

**Red-phase note:** `src/events/sequence.ts` does not exist. The test imports
from `../../src/events/sequence.js` and uses a lazy-import wrapper so the file
compiles in Step 1 and fails at runtime with a clear diagnostic until Step 2
ships the module.

**Test cases:**

| Test ID | Use Case | Brief |
|---------|----------|-------|
| T-SEQ-1 | UC-SEQ-002 | Empty events.jsonl (missing file) returns "evt-001" |
| T-SEQ-2 | UC-SEQ-001 | events.jsonl ending at evt-005 returns "evt-006" |
| T-SEQ-3 | UC-SEQ-003 | Roundtrip: write event, then nextSequentialEventId returns correct next |
| T-SEQ-4 | UC-SEQ-005 | Malformed last line throws descriptive error |
| T-SEQ-5 | UC-SEQ-001 | events.jsonl with only whitespace lines returns "evt-001" |
| T-SEQ-6 | UC-SEQ-001 | events.jsonl ending at evt-999 returns "evt-1000" (width expansion) |
| T-SEQ-7 | UC-SEQ-001 | Accepts optional eventWriter parameter for reading |

**Mocks and fakes:**
- Real `JsonlEventWriter` for writing events.
- Temp directories under `os.tmpdir()` with `randomUUID()` suffixes,
  cleaned up in `afterEach`.

## 4. Spec Compliance Matrix

| Clause | Source | Status | Evidence |
|--------|--------|--------|----------|
| AD-P13-001: runAll main loop in engine | Plan §3.1-A | In scope for WF | UC-RUNALL-001 through UC-RUNALL-010; tests T-RUNALL-1 through T-RUNALL-8 |
| AD-P13-007: nextSequentialEventId utility | Plan §3.1-A | In scope for WF | UC-SEQ-001 through UC-SEQ-005; tests T-SEQ-1 through T-SEQ-7 |
| Delete scattered parseInt(...replace(...)) | Plan §3.1-A | In scope for WF | UC-SEQ-DEDUP (UC-SEQ-004); verified via grep in Step 2 |
| runAll accepts AbortSignal | Plan §3.1-A (AD-P13-006) | In scope for WF | UC-RUNALL-008 |
| runAll accepts onEvent hook | Plan §3.1-A (AD-P13-001) | In scope for WF | UC-RUNALL-001 (onEvent does not participate in state) |

## 5. Design Decisions

### 5.1 runAll signature

```typescript
export interface RunAllOpts {
  /** Mutually exclusive with runId. Triggers createRun. */
  task?: string;
  /** Mutually exclusive with task. Resumes an existing run. */
  runId?: string;
  /** Absolute path to the workflow YAML file. */
  workflowPath: string;
  /** Path to .zigma-flow/runs directory. */
  runsDir: string;
  /** Project root (.zigma-flow directory location). */
  zigmaflowDir: string;
  /** Path to skill-lock.json. */
  skillLockPath: string;
  /**
   * Resolves an AgentBackend given an optional step-level backend name.
   * Called with undefined to use the default backend.
   */
  backendResolver: (stepBackendName?: string) => AgentBackend;
  /** Injectable clock for tests (defaults to SystemClock). */
  clock?: Clock;
  /** Injectable state store (defaults to LocalStateStore). */
  stateStore?: StateStore;
  /** Injectable event writer (defaults to JsonlEventWriter). */
  eventWriter?: EventWriter;
  /** AbortSignal for cancellation (SIGINT, etc.). */
  signal?: AbortSignal;
  /** Safety limit on loop iterations (default 100). */
  maxIterations?: number;
  /** Logger hook — receives each event, does not participate in state. */
  onEvent?: (e: ZigmaFlowEvent) => void;
}

export interface RunAllSummary {
  runId: string;
  status?: RunState["status"];
  jobs: Array<{ id: string; status: string; attempts: number }>;
  iterations: number;
}
```

### 5.2 nextSequentialEventId signature

```typescript
/**
 * Reads events.jsonl from the run directory, finds the last event's ID,
 * parses the numeric part, increments, and formats as "evt-NNN".
 *
 * @param runDir  Absolute path to the run directory.
 * @param eventWriter  Optional EventWriter for reading the last event ID.
 *   Defaults to `new JsonlEventWriter()` when omitted.
 * @returns The next sequential event ID (e.g., "evt-006").
 * @throws FilesystemError if events.jsonl is unparseable.
 */
export async function nextSequentialEventId(
  runDir: string,
  eventWriter?: EventWriter,
): Promise<string>;
```

### 5.3 Mutex constraint: task vs runId

`task` and `runId` are mutually exclusive. Providing both, or neither, is a
validation error. The validation happens inside `runAll`, not in the CLI layer,
so the constraint is enforced for all callers (tests, future programmatic
consumers).

## 6. Red-Phase Expectations

All test files in this step:

- **Compile** successfully (TypeScript type-checks).
- **Fail at runtime** with a clear diagnostic message indicating the
  implementation module does not yet exist (e.g., "runAll is not yet
  implemented — src/engine/runAll.ts does not exist").
- Use the lazy-import pattern from `tests/engine/accept.test.ts` to avoid
  static import errors while preserving type safety of the function signature.

Step 2 (Implementation) will create `src/engine/runAll.ts` and
`src/events/sequence.ts`, at which point the tests will flip from red to green.

## 7. References

- [P13 Development Plan](../../02-development-plan.md) §5 (WF-P13-ENGINE-RUNALL)
- [AD-P13-001](../../02-development-plan.md#ad-p13-001--run-all-main-loop)
- [AD-P13-007](../../02-development-plan.md#ad-p13-007--event-id-sequence-port)
- [mvp-contracts.md](../../../mvp-contracts.md) §2.3, §2.4
- [architecture.md](../../../architecture.md) §7.1
- [prd.md](../../../prd.md) §24
