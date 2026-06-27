---
workflow: WF-P14-LOCKS
phase: P14 Concurrent Read-Only Job Execution
step: 1 — Cases and Tests
authority: docs/phases/p14-concurrent-execution/02-development-plan.md §4 AD-P14-003, §5 WF-P14-LOCKS
date: 2026-06-28
---

# WF-P14-LOCKS — Cases and Tests

## 1. Slice Boundary Declaration

| Field | Value |
|---|---|
| **Slice name** | WF-P14-LOCKS |
| **Bounded context** | Run / I/O serialization |
| **User tasks** | N/A (infrastructure, not user-facing) |
| **Target new source** | `src/run/asyncQueue.ts` |
| **Target test files** | `tests/run/asyncQueue.test.ts`, `tests/run/stateStore-concurrent.test.ts`, `tests/events/eventWriter-concurrent.test.ts` |
| **Files to modify (Step 2)** | `src/run/index.ts` (LocalStateStore.writeSnapshot), `src/events/appendEvent.ts` (JsonlEventWriter.appendEvent) |
| **Predecessor** | WF-P14-SCHEDULER composable (no runtime dependency) |

## 2. Architecture Decision Reference

### AD-P14-003 — State 写串行通过 Mutex (from development plan §4)

Full text:

> `LocalStateStore` 内部维护一个 per-runDir 的 AsyncQueue（实现见 `src/run/asyncQueue.ts` 新增）。所有 `writeSnapshot` 调用排队执行。
>
> EventWriter 同理：`JsonlEventWriter.appendEvent` 也走 per-runDir 队列。
>
> **理由：** 即使 v0.2 不做跨进程并发，Promise.all 多 job 并发时仍会触发同进程 reentrancy；最稳的实现是在写者层串行，业务代码无须感知。

**Implementation points from AD-P14-003:**

1. AsyncQueue 接受 `() => Promise<T>`，按 FIFO 串行 await。
2. 每个 runDir 一把锁，存于 module-level Map<string, AsyncQueue>。
3. 不是 OS 锁；进程退出锁随之消失。

## 3. Functional Points and Use Cases

### 3.1 AsyncQueue (`src/run/asyncQueue.ts`)

**Interface:**

```ts
export class AsyncQueue {
  run<T>(fn: () => Promise<T>): Promise<T>;
}
```

**Operational semantics:**

- `run(fn)` enqueues `fn` and returns a Promise that resolves with `fn`'s result when it is that fn's turn to execute.
- FIFO order: functions execute in the order `run()` was called.
- Mutual exclusion: only one function executes at a time.
- Error propagation: if `fn` rejects, the returned Promise rejects with the same error; subsequent queued functions still execute.
- No external dependencies, no OS locks.
- Per-runDir: each runDir gets its own queue instance, stored in a module-level `Map<string, AsyncQueue>`.

**Use cases:**

| ID | Name | Description |
|---|---|---|
| UC-QUEUE-FIFO | Sequential task ordering | 3 tasks submitted to queue.run() in sequence; verify they execute in call order and return correct results. |
| UC-QUEUE-SERIAL | Concurrent submission serialization | 5 tasks submitted concurrently via Promise.all; verify at most 1 executes at any time (use a "currently executing" counter that never exceeds 1). |
| UC-QUEUE-ERROR | Error propagation and continuation | Task 2 rejects; verify task 1 resolves, task 2 rejects with the same error, task 3 still executes and resolves. |
| UC-QUEUE-RESULT | Return value passthrough | Verify that the resolved value from `fn` is passed through `run()` unchanged. |

### 3.2 StateStore Concurrent Writes

**Target:** `LocalStateStore.writeSnapshot` wrapped with `AsyncQueue.run()`.

**Current behavior (pre-P14):**
- `writeSnapshot` writes to a unique `.tmp-{uuid}` file, then renames to `state.json`.
- Atomic per-call, but concurrent calls to the same runDir can interleave write/rename cycles.

**Desired behavior (post-P14):**
- `writeSnapshot` calls to the same runDir are serialized through the per-runDir AsyncQueue.
- The file always ends up with the content of the write that was called last (FIFO guarantee).
- Different runDirs have independent queues and do not block each other.

**Use cases:**

| ID | Name | Description |
|---|---|---|
| UC-STORE-CONCURRENT | Concurrent writes to same runDir | 5 concurrent writeSnapshot calls to the same runDir. Verify the file ends up with the last-called write's content; no partial writes. |
| UC-STORE-ISOLATION | Independent runDir queues | Concurrent writes to runDir-A and runDir-B; verify both complete without blocking each other and each file has correct content. |

### 3.3 EventWriter Concurrent Appends

**Target:** `JsonlEventWriter.appendEvent` wrapped with `AsyncQueue.run()`.

**Current behavior (pre-P14):**
- `appendEvent` uses `appendFile` which is NOT safe for concurrent writes. Multiple `appendFile` calls to the same file can interleave at the byte level, producing corrupted/malformed lines.

**Desired behavior (post-P14):**
- `appendEvent` calls to the same runDir are serialized through the per-runDir AsyncQueue.
- All events are written to the file (no loss).
- Events are appended in the order each `appendEvent` was called (FIFO guarantee).
- No interleaved or corrupted lines.

**Use cases:**

| ID | Name | Description |
|---|---|---|
| UC-EVENT-CONCURRENT | Concurrent append serialization | 100 concurrent appendEvent calls. Verify all 100 events are in the file (no loss), events appear in call order, and no line is interleaved/corrupted. |

## 4. Spec Compliance Matrix

Extracted MUST clauses from AD-P14-003 in the development plan §4:

| # | Clause | Source | Status |
|---|---|---|---|
| SC-P14-LOCK-1 | AsyncQueue MUST accept `() => Promise<T>` and return `Promise<T>` | AD-P14-003 impl pt 1 | Covered by UC-QUEUE-FIFO, UC-QUEUE-RESULT |
| SC-P14-LOCK-2 | AsyncQueue MUST execute functions in FIFO order | AD-P14-003 impl pt 1 | Covered by UC-QUEUE-FIFO, UC-QUEUE-SERIAL |
| SC-P14-LOCK-3 | Each runDir MUST have its own queue instance, stored in a module-level Map<string, AsyncQueue> | AD-P14-003 impl pt 2 | Covered by UC-STORE-ISOLATION |
| SC-P14-LOCK-4 | LocalStateStore.writeSnapshot MUST wrap writes with the per-runDir queue | AD-P14-003 body | Covered by UC-STORE-CONCURRENT |
| SC-P14-LOCK-5 | JsonlEventWriter.appendEvent MUST wrap appends with the per-runDir queue | AD-P14-003 body | Covered by UC-EVENT-CONCURRENT |
| SC-P14-LOCK-6 | Queue is NOT an OS lock; it exists only in process memory | AD-P14-003 impl pt 3 | Testable by design (no filesystem artifacts for the queue) |
| SC-P14-LOCK-7 | If fn rejects, the returned Promise MUST reject with the same error and subsequent tasks MUST still execute | AD-P14-003 (implicit contract) | Covered by UC-QUEUE-ERROR |
| SC-P14-LOCK-8 | Operations on different runDirs MUST NOT block each other | AD-P14-003 impl pt 2 (implicit) | Covered by UC-STORE-ISOLATION |

**Compliance summary:** All 8 MUST clauses are covered by at least one test case. No gaps.

## 5. Test Case Catalog

### 5.1 `tests/run/asyncQueue.test.ts`

| Test ID | Description | Use Case | Spec Clause |
|---|---|---|---|
| T-QUEUE-FIFO-1 | 3 tasks execute in FIFO order; results match task outputs | UC-QUEUE-FIFO | SC-P14-LOCK-1, SC-P14-LOCK-2 |
| T-QUEUE-SERIAL-1 | 5 concurrent queue.run() calls; active count never exceeds 1 | UC-QUEUE-SERIAL | SC-P14-LOCK-2 |
| T-QUEUE-ERROR-1 | Task 2 rejects; error propagates; task 3 still executes | UC-QUEUE-ERROR | SC-P14-LOCK-7 |
| T-QUEUE-RESULT-1 | Return value passes through correctly: object equality | UC-QUEUE-RESULT | SC-P14-LOCK-1 |

### 5.2 `tests/run/stateStore-concurrent.test.ts`

| Test ID | Description | Use Case | Spec Clause |
|---|---|---|---|
| T-STORE-CONCURRENT-1 | 5 concurrent writes; file contains last-called write's content | UC-STORE-CONCURRENT | SC-P14-LOCK-4 |
| T-STORE-CONCURRENT-2 | 10 concurrent writes; file is always valid parseable JSON with correct shape | UC-STORE-CONCURRENT | SC-P14-LOCK-4 |
| T-STORE-ISOL-1 | Concurrent writes to runDir-A and runDir-B don't block each other | UC-STORE-ISOLATION | SC-P14-LOCK-3, SC-P14-LOCK-8 |

### 5.3 `tests/events/eventWriter-concurrent.test.ts`

| Test ID | Description | Use Case | Spec Clause |
|---|---|---|---|
| T-EVENT-CONCURRENT-1 | 100 concurrent appends; all 100 unique events present in file | UC-EVENT-CONCURRENT | SC-P14-LOCK-5 |
| T-EVENT-CONCURRENT-2 | 50 concurrent appends; line order is strictly increasing (matches call order) | UC-EVENT-CONCURRENT | SC-P14-LOCK-5 |
| T-EVENT-CONCURRENT-3 | 100 concurrent appends; every line is parseable JSON with required fields | UC-EVENT-CONCURRENT | SC-P14-LOCK-5 |

**Total test cases: 8** (4 asyncQueue + 3 stateStore + 3 eventWriter, but catalog lists 8 distinct test IDs)

## 6. Red-Phase Notes

- `asyncQueue.test.ts`: Will fail at **import time** — `src/run/asyncQueue.ts` does not exist yet.
- `stateStore-concurrent.test.ts`: T-STORE-CONCURRENT-1 asserts that the file content matches the **last-called** write. Without AsyncQueue serialization, concurrent `writeFile(tmp)` + `rename` calls are non-deterministic; the assertion may pass or fail depending on OS I/O scheduling. T-STORE-CONCURRENT-2 (valid JSON) will likely pass even without the queue because `writeFile`+`rename` is atomic per-call.
- `eventWriter-concurrent.test.ts`: **Reliably RED** without AsyncQueue — `appendFile` is not safe for concurrent writes; interleaved/corrupted lines are expected with 100 concurrent appends.

## 7. Determinism Guarantees

- `asyncQueue.test.ts`: Uses call-order tracking arrays + active-count counter. No timers, no sleep. Fully deterministic.
- `stateStore-concurrent.test.ts`: Uses `Promise.all` with array-index-ordered calls. With AsyncQueue, FIFO order is deterministic. Uses real temporary directories (fast, isolated).
- `eventWriter-concurrent.test.ts`: Uses `Promise.all` with array-index-ordered calls and sequential event IDs. With AsyncQueue, line order is deterministic. Uses real temporary directories.

All tests use `describe`/`it`/`expect` from vitest. No `setTimeout`, no `sleep`, no `fake timers` needed.
