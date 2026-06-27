---
workflow: wf-p13-events-artifacts
title: WF-P13-EVENTS-ARTIFACTS — Cases and Tests (Step 1)
phase: p13
date: 2026-06-27
status: red-phase (tests authored, implementation pending)
authority: docs/phases/p13-agent-adapter-hardening/02-development-plan.md §5 WF-P13-EVENTS-ARTIFACTS
adrs:
  - AD-P13-002 (Agent invocation lifecycle events)
  - AD-P13-003 (Backend artifacts instead of embedded error strings)
---

# WF-P13-EVENTS-ARTIFACTS: Cases and Tests

## 1. Overview

This workflow adds proper agent lifecycle events and structured artifact output to the Engine's
agent execution path, building on the `runAll` skeleton extracted in WF-P13-ENGINE-RUNALL.

**Two sub-domains:**

| ID | Sub-domain | ADR | Summary |
|----|-----------|-----|---------|
| EVT | Agent invocation lifecycle events | AD-P13-002 | 5 new event types for before/after backend execution |
| ART | Backend artifacts | AD-P13-003 | stdout/stderr/invocation logged to files instead of embedded in error messages |

**Red-phase note:** The new event types, `AgentExecuteResult` fields, and artifact-writing
logic in `runAll` do not exist yet. These test files and this case document define the
contract. All tests are expected to fail until Step 2 implements the changes.

---

## 2. Use Case Enumeration

### 2.1 Agent Invocation Events (EVT)

#### UC-EVT-001 — agent_invoked event written before backend.execute

**Actor:** Engine (runAll main loop)
**Precondition:** A workflow run is in progress, an agent step is ready, context/prompt have
been built and the prompt artifact has been written.
**Trigger:** `runAll` is about to call `backend.execute()`.
**Flow:**

1. Engine computes `args_hash` from backend config (SHA-256 of `command + JSON.stringify(args)`, no token).
2. Engine writes `agent_invoked` event to `events.jsonl`.
3. Event payload includes: `backend_name`, `command`, `args_hash`, `timeout_ms`, `step_artifact_dir`.
4. Envelope fields `run_id`, `job`, `step`, `attempt`, `producer="engine"` are populated.
5. Engine proceeds to call `backend.execute()`.

**Postcondition:** `events.jsonl` contains exactly one `agent_invoked` event immediately
before the call to `backend.execute()`. No `agent_invoked` event exists before this point.

**Acceptance criteria:**
- Event type is `"agent_invoked"`.
- `payload.backend_name` matches the backend name (e.g. `"claude-code"`).
- `payload.command` matches the backend CLI command (e.g. `"claude"`).
- `payload.args_hash` is a hex string (SHA-256), does not contain any API token.
- `payload.timeout_ms` is a positive integer.
- `payload.step_artifact_dir` is an absolute path ending in a POSIX-style artifact path.

---

#### UC-EVT-002 — agent_completed event written after successful backend execution

**Actor:** Engine (runAll main loop)
**Precondition:** `agent_invoked` has been written. `backend.execute()` resolves successfully
with `{ success: true, reportPath }`.
**Trigger:** `backend.execute()` returns a successful result.
**Flow:**

1. Engine records `duration_ms` as `Date.now() - invokeStart`.
2. Engine reads artifact refs (stdout/stderr/invocation) from the backend result (see UC-ART-*).
3. Engine writes `agent_completed` event to `events.jsonl`.
4. Event payload includes: `duration_ms`, `stdout_artifact`, `stderr_artifact`,
   `invocation_artifact`.
5. Engine proceeds to read and accept the report (existing path).

**Postcondition:** The event chain is `agent_invoked` followed by `agent_completed`.
`duration_ms > 0`. Artifact refs point to valid artifact entries in `artifacts.jsonl`.

**Acceptance criteria:**
- Event type is `"agent_completed"`.
- `payload.duration_ms` is a positive number.
- `payload.stdout_artifact` is an artifact ref string (e.g. `artifact://.../agent.stdout`).
- `payload.stderr_artifact` is an artifact ref string.
- `payload.invocation_artifact` is an artifact ref string.

---

#### UC-EVT-003 — agent_timed_out event written after backend timeout

**Actor:** Engine (runAll main loop)
**Precondition:** `agent_invoked` has been written. `backend.execute()` rejects or resolves
with a timeout error.
**Trigger:** `backend.execute()` times out.
**Flow:**

1. Engine records `duration_ms` from `invokeStart` to timeout.
2. Engine captures any partial stdout/stderr that was written before timeout (artifact files
   exist even on timeout).
3. Engine writes `agent_timed_out` event to `events.jsonl`.
4. Event payload includes: `duration_ms`, `timeout_ms` (the configured timeout value),
   `stdout_artifact`, `stderr_artifact`.
5. Engine then follows the failure/retry path (WF-P13-RETRY, not in scope here).

**Postcondition:** The event chain is `agent_invoked` followed by `agent_timed_out`.
`duration_ms >= timeout_ms`.

**Acceptance criteria:**
- Event type is `"agent_timed_out"`.
- `payload.duration_ms` is a positive number, >= `payload.timeout_ms`.
- `payload.timeout_ms` matches the configured backend timeout.
- `payload.stdout_artifact` and `payload.stderr_artifact` point to artifact refs (may be
  empty/partial for timeout — the artifact files still exist).

---

#### UC-EVT-004 — agent_failed event written after backend failure (non-zero exit)

**Actor:** Engine (runAll main loop)
**Precondition:** `agent_invoked` has been written. `backend.execute()` resolves with
`{ success: false }` or throws a non-timeout, non-cancellation error.
**Trigger:** `backend.execute()` fails (non-zero exit code, or agent error).
**Flow:**

1. Engine records `duration_ms`.
2. Engine captures backend result fields: `exitCode`, `reason`, artifact paths.
3. Engine writes `agent_failed` event to `events.jsonl`.
4. Event payload includes: `duration_ms`, `exit_code`, `reason`, `stdout_artifact`,
   `stderr_artifact`.
5. Engine then follows the failure/retry path.

**Postcondition:** The event chain is `agent_invoked` followed by `agent_failed`.
`exit_code` is set (from backend result). `reason` contains a human-readable summary
(no embedded stdout/stderr blobs).

**Acceptance criteria:**
- Event type is `"agent_failed"`.
- `payload.duration_ms` is a positive number.
- `payload.exit_code` is the numeric exit code (e.g. `1`).
- `payload.reason` is a short summary string (e.g. `"Claude Code exited with code 1"`).
- `payload.reason` does NOT contain truncated stdout/stderr text (see UC-ART-005).
- `payload.stdout_artifact` and `payload.stderr_artifact` are artifact ref strings.

---

#### UC-EVT-005 — agent_cancelled event written after abort

**Actor:** Engine (runAll main loop)
**Precondition:** `agent_invoked` has been written. `backend.execute()` is in flight,
`AbortSignal` is fired (SIGINT or programmatic abort).
**Trigger:** Backend execution is cancelled via `AbortSignal`.
**Flow:**

1. Engine detects cancellation via `signal.aborted` or `backend.execute()` throws with
   `isCanceled`.
2. Engine records `duration_ms` from invocation to cancellation.
3. Engine writes `agent_cancelled` event to `events.jsonl`.
4. Event payload includes: `duration_ms`, `reason` (e.g. `"signal:SIGINT"` or `"abort"`).
5. Engine then follows the cancel path (AD-P13-006, writes `run_cancelled`).

**Postcondition:** The event chain is `agent_invoked` followed by `agent_cancelled`.
State transitions to `cancelled`.

**Acceptance criteria:**
- Event type is `"agent_cancelled"`.
- `payload.duration_ms` is a positive number.
- `payload.reason` is a string identifying the cancel source.

---

#### UC-EVT-006 — Event chain consistency

**Actor:** Engine (runAll main loop)
**Precondition:** An agent step is being processed.
**Trigger:** Any agent step execution completes (via any path).
**Flow:**

1. Every agent execution produces exactly one `agent_invoked` event (before).
2. Every agent execution produces exactly one terminal event: `agent_completed`,
   `agent_timed_out`, `agent_failed`, or `agent_cancelled` (after).
3. The terminal event's event ID is strictly greater than the `agent_invoked` event's ID.
4. The `agent_invoked` event appears before the terminal event in `events.jsonl` order.
5. No intermediate events between `agent_invoked` and the terminal event are missing or
   out of order.

**Acceptance criteria:**
- For any completed agent step execution, the `events.jsonl` contains a matching
  (`agent_invoked`, terminal) pair.
- Event IDs are monotonically increasing through the pair.
- The pair is contiguous in `events.jsonl` (no other events are interleaved between
  `agent_invoked` and the terminal event).
- Every `agent_invoked` has exactly one corresponding terminal event.

---

### 2.2 Backend Artifacts (ART)

#### UC-ART-001 — stdout written to agent.stdout.log file

**Actor:** Backend (ClaudeCodeBackend.execute)
**Precondition:** Backend spawns the agent CLI process.
**Trigger:** The agent process produces stdout.
**Flow:**

1. Backend captures stdout from the child process.
2. Backend writes all stdout to `${stepDir}/agent.stdout.log`.
3. Backend returns `stdoutPath` in the result pointing to this file.

**Postcondition:** `${stepDir}/agent.stdout.log` exists and contains the full stdout output.
The backend result includes `stdoutPath: string`.

**Acceptance criteria:**
- File exists at `${stepDir}/agent.stdout.log`.
- File content matches the process stdout.
- `result.stdoutPath` ends with `agent.stdout.log`.
- Backend does NOT embed stdout text in `result.error`.

---

#### UC-ART-002 — stderr written to agent.stderr.log file

**Actor:** Backend (ClaudeCodeBackend.execute)
**Precondition:** Backend spawns the agent CLI process.
**Trigger:** The agent process produces stderr.
**Flow:**

1. Backend captures stderr from the child process.
2. Backend writes all stderr to `${stepDir}/agent.stderr.log`.
3. Backend returns `stderrPath` in the result pointing to this file.

**Postcondition:** `${stepDir}/agent.stderr.log` exists and contains the full stderr output.
The backend result includes `stderrPath: string`.

**Acceptance criteria:**
- File exists at `${stepDir}/agent.stderr.log`.
- File content matches the process stderr.
- `result.stderrPath` ends with `agent.stderr.log`.
- Backend does NOT embed stderr text in `result.error`.

---

#### UC-ART-003 — invocation metadata written to agent.invocation.json

**Actor:** Backend (ClaudeCodeBackend.execute)
**Precondition:** Backend is about to invoke the agent CLI.
**Trigger:** Backend starts execution.
**Flow:**

1. Backend creates invocation metadata: `{ command, args, timeout_ms, start_time, end_time, exit_code, project_root }`.
2. Backend writes invocation metadata to `${stepDir}/agent.invocation.json`.
3. Backend returns `invocationPath` in the result.

**Postcondition:** `${stepDir}/agent.invocation.json` exists with valid JSON invocation
metadata. The backend result includes `invocationPath: string`.

**Acceptance criteria:**
- File exists at `${stepDir}/agent.invocation.json`.
- File is valid JSON.
- Contains fields: `command`, `args` (array), `timeout_ms`, `start_time`, `end_time`,
  `exit_code`, `project_root`.
- `result.invocationPath` ends with `agent.invocation.json`.

---

#### UC-ART-004 — Artifacts registered in artifacts.jsonl

**Actor:** Engine (runAll)
**Precondition:** Backend execution has completed (success, timeout, or failure), and
stdout/stderr/invocation files exist.
**Trigger:** Engine receives the backend result.
**Flow:**

1. Engine reads `result.stdoutPath`, `result.stderrPath`, `result.invocationPath`.
2. For each path, Engine calls `writeArtifact()` (or `appendArtifactIndex()`) to register
   an artifact entry in `artifacts.jsonl`.
3. Artifact kinds are: `agent_stdout`, `agent_stderr`, `agent_invocation`.
4. Each entry has correct `id`, `run_id`, `producer`, `kind`, `path`, `content_type`,
   `size`, `summary`, `created_at`.

**Postcondition:** `artifacts.jsonl` contains three new entries (one for each artifact kind).
Artifact refs used in events correctly resolve to these entries.

**Acceptance criteria:**
- `artifacts.jsonl` contains an entry with `kind: "agent_stdout"`.
- `artifacts.jsonl` contains an entry with `kind: "agent_stderr"`.
- `artifacts.jsonl` contains an entry with `kind: "agent_invocation"`.
- Each entry has `content_type` set appropriately (`text/plain` for stdout/stderr,
  `application/json` for invocation).
- `producer.job`, `producer.step`, `producer.attempt` match the current step.
- `size` is non-negative.
- `path` is a relative POSIX path from the run directory.

---

#### UC-ART-005 — Error messages no longer embed truncated stdout/stderr

**Actor:** Backend (ClaudeCodeBackend.execute)
**Precondition:** Backend execution fails (any failure mode: timeout, non-zero exit, error).
**Trigger:** Backend constructs the error result.
**Flow:**

1. Backend writes stdout/stderr to files (UC-ART-001, UC-ART-002).
2. Backend constructs `result.error` as a short summary string: agent name + exit code
   or timeout + artifact refs.
3. Backend does NOT include `result.stdout.slice(-1000)` or `result.stderr.slice(-1000)`
   in the error message.

**Postcondition:** `result.error` is a single-line or short multi-line string (under 500
characters) that references artifact paths instead of embedding content.

**Acceptance criteria:**
- `result.error` does NOT contain `"stdout (last 1000 chars)"` or `"stderr (last 1000 chars)"`.
- `result.error` does NOT contain the literal text of the agent's stdout or stderr.
- `result.error` is under 500 characters (configurable threshold, but short).
- `result.error` references `stdoutPath` or `stderrPath` by path.

---

## 3. Functional Point Coverage Matrix

| FP ID | Description | UC Coverage | Test Coverage |
|-------|------------|-------------|---------------|
| FP-EVT-INVOKE | agent_invoked event emission before backend.execute | UC-EVT-001 | `runAll-events.test.ts` |
| FP-EVT-COMPLETE | agent_completed event emission on success | UC-EVT-002 | `runAll-events.test.ts` |
| FP-EVT-TIMEOUT | agent_timed_out event emission on timeout | UC-EVT-003 | `runAll-events.test.ts` |
| FP-EVT-FAILED | agent_failed event emission on non-zero exit | UC-EVT-004 | `runAll-events.test.ts` |
| FP-EVT-CANCEL | agent_cancelled event emission on abort | UC-EVT-005 | `runAll-events.test.ts` |
| FP-EVT-CHAIN | Event chain consistency (invoked + terminal pair) | UC-EVT-006 | `runAll-events.test.ts` |
| FP-EVT-PAYLOAD-INVOKE | agent_invoked payload correctness | UC-EVT-001 | `runAll-events.test.ts` |
| FP-EVT-PAYLOAD-COMPLETE | agent_completed payload correctness | UC-EVT-002 | `runAll-events.test.ts` |
| FP-EVT-PAYLOAD-TIMEOUT | agent_timed_out payload correctness | UC-EVT-003 | `runAll-events.test.ts` |
| FP-EVT-PAYLOAD-FAILED | agent_failed payload correctness | UC-EVT-004 | `runAll-events.test.ts` |
| FP-EVT-PAYLOAD-CANCEL | agent_cancelled payload correctness | UC-EVT-005 | `runAll-events.test.ts` |
| FP-EVT-SEQ | Event IDs are sequential within the chain | UC-EVT-006 | `runAll-events.test.ts` |
| FP-ART-STDOUT-FILE | Backend writes stdout to agent.stdout.log | UC-ART-001 | `claude-code-backend.test.ts` |
| FP-ART-STDERR-FILE | Backend writes stderr to agent.stderr.log | UC-ART-002 | `claude-code-backend.test.ts` |
| FP-ART-INVOC-FILE | Backend writes invocation to agent.invocation.json | UC-ART-003 | `claude-code-backend.test.ts` |
| FP-ART-REGISTER | Artifacts registered in artifacts.jsonl | UC-ART-004 | `runAll-events.test.ts` |
| FP-ART-NO-EMBED | Error messages no longer embed stdout/stderr | UC-ART-005 | `claude-code-backend.test.ts` |
| FP-ART-DURATION | duration_ms tracked in backend result | UC-EVT-002,3,4,5 | `claude-code-backend.test.ts` |
| FP-ART-STRUCTURED-RESULT | Backend returns structured result with file paths | UC-ART-001,2,3 | `claude-code-backend.test.ts` |

---

## 4. Spec Compliance Matrix

| Clause | Source | Status | Evidence |
|--------|--------|--------|----------|
| AD-P13-002: 5 agent lifecycle events | Plan §3.1-A | In scope for WF | UC-EVT-001 through UC-EVT-006 |
| AD-P13-002: Event chain agent_invoked -> terminal | Plan §4 AD-P13-002 | In scope for WF | UC-EVT-006 (chain consistency) |
| AD-P13-002: agent_invoked payload (backend_name, command, args_hash, timeout_ms, step_artifact_dir) | Plan §4 AD-P13-002 | In scope for WF | UC-EVT-001 |
| AD-P13-002: agent_completed payload (duration_ms, stdout_artifact, stderr_artifact, invocation_artifact) | Plan §4 AD-P13-002 | In scope for WF | UC-EVT-002 |
| AD-P13-002: agent_timed_out payload (duration_ms, timeout_ms, stdout_artifact, stderr_artifact) | Plan §4 AD-P13-002 | In scope for WF | UC-EVT-003 |
| AD-P13-002: agent_failed payload (duration_ms, exit_code, reason, stdout_artifact, stderr_artifact) | Plan §4 AD-P13-002 | In scope for WF | UC-EVT-004 |
| AD-P13-002: agent_cancelled payload (duration_ms, reason) | Plan §4 AD-P13-002 | In scope for WF | UC-EVT-005 |
| AD-P13-003: Backend writes stdout to file, not embedded in error | Plan §4 AD-P13-003 | In scope for WF | UC-ART-001, UC-ART-005 |
| AD-P13-003: Backend writes stderr to file, not embedded in error | Plan §4 AD-P13-003 | In scope for WF | UC-ART-002, UC-ART-005 |
| AD-P13-003: Backend writes invocation metadata | Plan §4 AD-P13-003 | In scope for WF | UC-ART-003 |
| AD-P13-003: Backend returns structured result { success, exitCode, stdoutPath, stderrPath, invocationPath, durationMs } | Plan §4 AD-P13-003 | In scope for WF | UC-ART-001,2,3 |
| AD-P13-003: runAll registers artifacts in artifacts.jsonl | Plan §4 AD-P13-003 | In scope for WF | UC-ART-004 |
| AD-P13-003: Error messages carry summary + artifact refs only | Plan §4 AD-P13-003 | In scope for WF | UC-ART-005 |
| mvp-contracts.md §2.4: Event types additive only | Plan §10 | Compliance | New types are additive, no existing types removed |
| mvp-contracts.md §2.5: Artifact immutability | Plan §10 | Compliance | Artifact files are written once and appended to index |
| docs/prd.md §13: Large logs via artifact ref | Plan §4 AD-P13-003 | Compliance | stdout/stderr go to artifact, not in error/event payload |

---

## 5. Event Type Contract (AD-P13-002)

### 5.1 New Event Type Tags

Five new members of `ZigmaFlowEventType` (expanding from 21 to 26):

```typescript
type ZigmaFlowEventType = /* existing 21 types */ | "agent_invoked" | "agent_completed" | "agent_timed_out" | "agent_failed" | "agent_cancelled";
```

### 5.2 New Payload Interfaces

```typescript
export interface AgentInvokedPayload {
  backend_name: string;
  command: string;
  args_hash: string;          // SHA-256 hex, no token
  timeout_ms: number;
  step_artifact_dir: string;  // absolute path
}

export interface AgentCompletedPayload {
  duration_ms: number;
  stdout_artifact: string;    // artifact ref
  stderr_artifact: string;    // artifact ref
  invocation_artifact: string; // artifact ref
}

export interface AgentTimedOutPayload {
  duration_ms: number;
  timeout_ms: number;
  stdout_artifact: string;    // artifact ref (may be partial)
  stderr_artifact: string;    // artifact ref (may be partial)
}

export interface AgentFailedPayload {
  duration_ms: number;
  exit_code: number;
  reason: string;             // short summary, no embedded stdout/stderr
  stdout_artifact: string;    // artifact ref
  stderr_artifact: string;    // artifact ref
}

export interface AgentCancelledPayload {
  duration_ms: number;
  reason: string;             // "signal:SIGINT" | "abort"
}
```

### 5.3 New Discriminated Union Members

```typescript
export type ZigmaFlowEvent =
  /* existing 21 members */
  | (EventEnvelope & { type: "agent_invoked"; payload: AgentInvokedPayload })
  | (EventEnvelope & { type: "agent_completed"; payload: AgentCompletedPayload })
  | (EventEnvelope & { type: "agent_timed_out"; payload: AgentTimedOutPayload })
  | (EventEnvelope & { type: "agent_failed"; payload: AgentFailedPayload })
  | (EventEnvelope & { type: "agent_cancelled"; payload: AgentCancelledPayload });
```

### 5.4 EVENT_TYPES Array Extension

The `EVENT_TYPES` const array grows from 21 to 26 by appending the 5 new type strings.

---

## 6. AgentExecuteResult Contract (AD-P13-003)

### 6.1 Current Type (v0.1)

```typescript
export interface AgentExecuteResult {
  success: boolean;
  reportPath?: string;
  error?: string;
}
```

### 6.2 New Type (v0.2)

```typescript
export interface AgentExecuteResult {
  success: boolean;
  exitCode?: number;
  reportPath?: string;
  error?: string;           // Short summary, no embedded stdout/stderr
  stdoutPath?: string;      // Abs path to agent.stdout.log
  stderrPath?: string;      // Abs path to agent.stderr.log
  invocationPath?: string;  // Abs path to agent.invocation.json
  durationMs: number;       // Wall-clock duration of the execute() call
}
```

### 6.3 New Artifact Kinds

Three new `kind` values for `ArtifactMetadata`:

| Kind | Content Type | File | Description |
|------|-------------|------|-------------|
| `agent_stdout` | `text/plain` | `agent.stdout.log` | Full stdout from the agent process |
| `agent_stderr` | `text/plain` | `agent.stderr.log` | Full stderr from the agent process |
| `agent_invocation` | `application/json` | `agent.invocation.json` | Invocation metadata record |

---

## 7. Test Plan

### 7.1 `tests/engine/runAll-events.test.ts` (New File)

**Purpose:** Verify that `runAll` emits the correct agent lifecycle events via a FakeBackend
that can simulate success, timeout, and failure modes.

**Test Cases:**

| Test ID | Description | UC Coverage | FP Coverage |
|---------|------------|-------------|-------------|
| T-EVT-001 | agent_invoked emitted before backend.execute with correct payload | UC-EVT-001 | FP-EVT-INVOKE, FP-EVT-PAYLOAD-INVOKE |
| T-EVT-002 | agent_completed emitted after successful execution with correct payload | UC-EVT-002 | FP-EVT-COMPLETE, FP-EVT-PAYLOAD-COMPLETE |
| T-EVT-003 | agent_timed_out emitted after timeout with correct payload | UC-EVT-003 | FP-EVT-TIMEOUT, FP-EVT-PAYLOAD-TIMEOUT |
| T-EVT-004 | agent_failed emitted after non-zero exit with correct payload | UC-EVT-004 | FP-EVT-FAILED, FP-EVT-PAYLOAD-FAILED |
| T-EVT-005 | agent_cancelled emitted after abort with correct payload | UC-EVT-005 | FP-EVT-CANCEL, FP-EVT-PAYLOAD-CANCEL |
| T-EVT-006 | Event chain has agent_invoked before terminal event, IDs sequential | UC-EVT-006 | FP-EVT-CHAIN, FP-EVT-SEQ |
| T-EVT-007 | Event payload contains all required fields (no missing keys) | UC-EVT-001..005 | FP-EVT-PAYLOAD-* |
| T-EVT-008 | Artifact entries in artifacts.jsonl after successful execution | UC-ART-004 | FP-ART-REGISTER |
| T-EVT-009 | args_hash does not contain command-line tokens | UC-EVT-001 | FP-EVT-PAYLOAD-INVOKE |

**FakeBackend Requirements:**

- Must be injectable and configurable to return success, timeout, or failure results.
- Must write stdout/stderr to the stepDir for artifact tests.
- Must accept a result factory function for flexible behavior.

**Red-phase strategy:** Use lazy import of `runAll` from `../../src/engine/runAll.js`
(via the same pattern as `tests/engine/runAll.test.ts`). The import succeeds because
`runAll.ts` was created in WF-P13-ENGINE-RUNALL. The tests will fail on missing event
type fields and missing artifact registration until Step 2 implements the changes.

---

### 7.2 `tests/agent/claude-code-backend.test.ts` (New File)

**Purpose:** Verify that `ClaudeCodeBackend.execute` writes stdout/stderr/invocation to
files and returns a structured result without embedding stdout/stderr in error messages.

**Test Cases:**

| Test ID | Description | UC Coverage | FP Coverage |
|---------|------------|-------------|-------------|
| T-CCB-001 | Writes stdout to agent.stdout.log on success | UC-ART-001 | FP-ART-STDOUT-FILE |
| T-CCB-002 | Writes stderr to agent.stderr.log on success | UC-ART-002 | FP-ART-STDERR-FILE |
| T-CCB-003 | Writes invocation metadata to agent.invocation.json | UC-ART-003 | FP-ART-INVOC-FILE |
| T-CCB-004 | Returns structured result with file paths on success | UC-ART-001,2,3 | FP-ART-STRUCTURED-RESULT |
| T-CCB-005 | Error result no longer embeds truncated stdout text | UC-ART-005 | FP-ART-NO-EMBED |
| T-CCB-006 | Error result no longer embeds truncated stderr text | UC-ART-005 | FP-ART-NO-EMBED |
| T-CCB-007 | Tracks durationMs in result | UC-EVT-002 | FP-ART-DURATION |
| T-CCB-008 | Writes stdout/stderr files even on failure | UC-ART-001,2 | FP-ART-STDOUT-FILE, FP-ART-STDERR-FILE |
| T-CCB-009 | Writes stdout/stderr files even on timeout | UC-ART-001,2 | FP-ART-STDOUT-FILE, FP-ART-STDERR-FILE |
| T-CCB-010 | Returns exitCode in structured result on failure | UC-EVT-004 | FP-ART-STRUCTURED-RESULT |

**Test Strategy:**

- Where possible, use a real Claude Code backend against a simple echo command
  (e.g. `command: "node"`, `args: ["-e", "console.log('hello')"]`) for fast
  integration tests that verify file output.
- For timeout and failure tests, use a script command that sleeps or exits non-zero.
- For no-embed assertion, verify that `result.error` is a short string without
  "stdout (last 1000 chars)" or large content blobs.
- Mock or stub the backend for negative test cases where needed.
- Use temp directories via `os.tmpdir()` for file output, cleaned up in `afterEach`.

**Red-phase note:** These tests fail until Step 2 adds the file-writing logic and
updates the `AgentExecuteResult` type. The `ClaudeCodeBackend` class and its
`execute` method signature already exist, so the tests should compile against the
current types but fail on assertions about new fields (`stdoutPath`, etc.).

---

## 8. Non-Functional Notes

### 8.1 Error Message Size Limit

After the change, `result.error` must be a short summary. Suggested maximum: 500
characters. The engine will log the full stdout/stderr from the artifact files, not
from the event payload.

### 8.2 Artifact File Sizes

- `agent.stdout.log`: may be large (multiple MB for long agent runs). The artifact
  `summary` field should contain only the first and last 200 bytes plus total byte count.
- `agent.stderr.log`: typically small (under 100KB).
- `agent.invocation.json`: always small (under 1KB).

### 8.3 args_hash Computation

`args_hash` must be computed as SHA-256 of `command + JSON.stringify(args)` without
any API token, environment variables, or prompt content. This provides a fingerprint
of the backend configuration without leaking secrets.

### 8.4 Event Ordering within runAll

Between `agent_invoked` and the terminal agent event, no other events should be
interleaved. The backend execution is synchronous in the current runAll loop,
so this is naturally satisfied. If concurrency is added (P14), this invariant must
be preserved via queuing.

### 8.5 Backward Compatibility

- Existing event types (21) are unchanged.
- Existing `AgentExecuteResult` fields (`success`, `reportPath`, `error`) are retained.
- `error` field's content changes but its type (`string | undefined`) stays the same.
- Existing tests that assert on `result.error` content may need updating (embedded
  stdout/stderr strings will no longer appear).
