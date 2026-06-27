---
workflow: WF-P13-RESUME-CANCEL
title: Resume and Cancel — Use Cases and Test Plan
status: proposed
date: 2026-06-27
target: AD-P13-005, AD-P13-006
references:
  - docs/phases/p13-agent-adapter-hardening/02-development-plan.md §5 WF-P13-RESUME-CANCEL
  - docs/mvp-contracts.md §2.3, §2.4
  - docs/prd.md §24
---

# WF-P13-RESUME-CANCEL — Use Cases and Test Plan

## 1. Summary

This workflow covers two related Engine capabilities:

**Resume (AD-P13-005):** `runAll` gains a `--resume <run-id>` mode (mutually
exclusive with `--task`) that skips `createRun` and enters the main loop from
the existing run state. This allows recovering from interrupted runs without
duplicate events or double initialization.

**Cancel (AD-P13-006):** `runAll` receives an `AbortSignal`. When the signal
aborts during backend execution: the backend child process is killed, an
`agent_cancelled` event is emitted, a `run_cancelled` event is emitted, the
state transitions to `status=cancelled`, and the process exits with code 130.

## 2. Use Case Enumeration

### Resume Use Cases

| ID | Title | Trigger | Expected Outcome |
|---|---|---|---|
| UC-RESUME-001 | Resume from run with ready jobs | `runAll({ runId })` on a run that was created but not yet completed | Continues from existing state, no duplicate `run_created`, runs remaining jobs, run completes |
| UC-RESUME-002 | Resume from completed run rejected | `runAll({ runId })` on a run with `status=completed` | ValidationError or immediate return without further processing |
| UC-RESUME-003 | Resume from failed run rejected | `runAll({ runId })` on a run with `status=failed` | ValidationError or immediate return without further processing |
| UC-RESUME-004 | Resume from cancelled run rejected | `runAll({ runId })` on a run with `status=cancelled` | ValidationError or immediate return |
| UC-RESUME-005 | Resume preserves no duplicate events | `runAll({ runId })` on a partially-executed run | `run_created` count is 1, existing events are not re-written |
| UC-RESUME-006 | Resume continues from correct attempt | Run had 1 failed attempt, workflow has `max_attempts: 2` | Job continues at attempt 2, does not re-execute attempt 1 |

### Cancel Use Cases

| ID | Title | Trigger | Expected Outcome |
|---|---|---|---|
| UC-CANCEL-001 | Abort during backend execution | `AbortController.abort()` while backend is executing | `agent_cancelled` event emitted, `run_cancelled` event emitted, `state.status=cancelled` |
| UC-CANCEL-002 | Abort between iterations | `AbortController.abort()` while loop is between jobs | Loop exits cleanly, run status may be `running` or `cancelled` (no in-flight agent) |
| UC-CANCEL-003 | Cancel event payload correctness | Abort during execution | `agent_cancelled.payload.reason` is present, `agent_cancelled.payload.duration_ms` is a number |
| UC-CANCEL-004 | Run state reflects cancellation | Abort during execution | `state.status` = `cancelled`, running job status = `failed` or `cancelled` |
| UC-CANCEL-005 | Event chain: invoked + cancelled | Abort during agent execution | Event sequence: ... → `agent_invoked` → `agent_cancelled` → `run_cancelled` |

## 3. Functional Point Coverage Matrix

| FP ID | Description | UC Coverage | Test Case ID |
|---|---|---|---|
| FP-RESUME-CREATE-SKIP | `runId` mode skips `createRun` | UC-RESUME-001 | T-RESUME-1 |
| FP-RESUME-NO-DUP-EVENTS | No duplicate `run_created` on resume | UC-RESUME-005 | T-RESUME-2 |
| FP-RESUME-EXISTING-STATE | Reads existing state.json before entering loop | UC-RESUME-001 | T-RESUME-1 |
| FP-RESUME-REJECT-TERMINAL | Rejects resume from terminal state | UC-RESUME-002, UC-RESUME-003, UC-RESUME-004 | T-RESUME-3 |
| FP-RESUME-ATTEMPT-CONTINUITY | Continues from correct attempt after failure | UC-RESUME-006 | T-RESUME-4 |
| FP-RESUME-RUNID-REQUIRED | `runId` must point to existing run directory | UC-RESUME-001 | T-RESUME-1 |
| FP-CANCEL-AGENT-EVENT | `agent_cancelled` event on abort | UC-CANCEL-001 | T-CANCEL-1 |
| FP-CANCEL-RUN-EVENT | `run_cancelled` event on abort | UC-CANCEL-001 | T-CANCEL-1 |
| FP-CANCEL-STATE | state.status = cancelled | UC-CANCEL-001, UC-CANCEL-004 | T-CANCEL-2 |
| FP-CANCEL-SIGNAL | AbortSignal passed to backend.execute | UC-CANCEL-001 | T-CANCEL-1 |
| FP-CANCEL-EVENT-CHAIN | Invoked → cancelled chain | UC-CANCEL-005 | T-CANCEL-3 |

## 4. Spec Compliance Matrix

| ADR / Contract | Requirement | Evidence |
|---|---|---|
| AD-P13-005 §1 | `--resume <run-id>` is mutually exclusive with `--task` | T-RESUME-1 uses `runId` without `task`; error case tests both-set |
| AD-P13-005 §2 | Resumes from existing state without createRun | T-RESUME-1 asserts run_created count unchanged |
| AD-P13-005 §3 | Terminal state runs rejected | T-RESUME-3 asserts error on completed/failed/cancelled resume |
| AD-P13-006 §1 | runAll receives AbortSignal | T-CANCEL-1 passes AbortController.signal to runAll |
| AD-P13-006 §2 | Backend child process killed on abort | T-CANCEL-1 uses long-delay FakeBackend, aborts mid-execution |
| AD-P13-006 §3 | agent_cancelled event + run_cancelled event | T-CANCEL-1 asserts both events in log |
| AD-P13-006 §4 | state.status = cancelled | T-CANCEL-2 asserts state.status === "cancelled" |
| mvp-contracts §2.3 | Engine owns state transitions | cancelRun is Engine entry point; runAll handles AbortSignal internally |
| mvp-contracts §2.4 | Cancelled events are auditable | agent_cancelled and run_cancelled payloads follow event contract |

## 5. Test Plan

### Test File: `tests/engine/runAll-resume.test.ts`

| Test Case ID | Description | Method |
|---|---|---|
| T-RESUME-1 | Resume from an existing run | `createRun` then `runAll({ runId })`; assert run completes, no duplicate run_created |
| T-RESUME-2 | No duplicate events on resume | Read events.jsonl before and after resume; assert run_created appears exactly once |
| T-RESUME-3 | Resume from terminal state rejected | Set state.status=completed via LocalStateStore; call runAll({ runId }); assert error or immediate return |
| T-RESUME-4 | Resume continues at correct attempt | Create run with 1 failed attempt via retryJob exhausted; resume with remaining attempts (max_attempts > 1) |
| T-RESUME-5 | Summary preserves existing job statuses on resume | After resume, RunAllSummary.status reflects the final terminal status |

### Test File: `tests/engine/runAll-cancel.test.ts`

| Test Case ID | Description | Method |
|---|---|---|
| T-CANCEL-1 | Abort during backend execution | FakeBackend with 200ms delay; abort after 50ms; assert agent_cancelled + run_cancelled events |
| T-CANCEL-2 | State.status becomes cancelled | After abort, read state.json; assert status is "cancelled" |
| T-CANCEL-3 | Event chain order correct | Capture events via onEvent; assert agent_invoked before agent_cancelled before run_cancelled |
| T-CANCEL-4 | Cancel when no job is running | Abort before any job starts; assert loop exits, summary reflects no completion |
| T-CANCEL-5 | RunAllSummary reflects cancelled state | After abort, summary.status should be "cancelled" |

### Test Strategy

- **Resume tests**: Use `callRunAll` with the `runId` parameter (not `task`). The lazy import pattern already exists in `runAll.test.ts` -- we mirror it.
- **Cancel tests**: Use the existing `FakeBackend` extended with configurable delay. Create an `AbortController`, pass its `signal` to `callRunAll`, and `abort()` after a short timeout.
- **FakeBackend with delay**: The events test already has a delay-capable FakeBackend. We use the same pattern.
- **Red-phase**: The resume and cancel logic in `runAll.ts` does not yet exist for these specific cases beyond what WF-P13-ENGINE-RUNALL shipped (which already supports `runId` parameter and `signal` parameter). The tests extend existing behavior.

### Fixtures Needed

- Default `SINGLE_AGENT_YAML` (reuse from runAll.test.ts)
- `RETRY_ENABLED_YAML` for resume-after-failure tests
