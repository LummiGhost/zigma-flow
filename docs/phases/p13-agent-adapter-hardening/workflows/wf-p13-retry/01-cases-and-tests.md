---
workflow: WF-P13-RETRY
title: Agent Failure Retry — Use Cases and Test Plan
status: proposed
date: 2026-06-27
target: AD-P13-004
references:
  - docs/phases/p13-agent-adapter-hardening/02-development-plan.md §5 WF-P13-RETRY
  - docs/mvp-contracts.md §2.3, §2.4
  - docs/prd.md §FR-012
---

# WF-P13-RETRY — Use Cases and Test Plan

## 1. Summary

`recordAgentFailure` is a new Engine entry point called by `runAll` when a
backend agent step fails. It replaces the current behavior of directly setting
`run.failed`. Instead it:

1. Writes a `step_failed` event.
2. Reads `JobDefinition.retry` config from the workflow YAML.
3. If `attempt < max_attempts`: calls `retryJob` (attempt+1, new attempt dir,
   status back to `ready`).
4. If `attempt >= max_attempts`: applies `on_exceeded.status` (default
   `blocked`).
5. **ConfigError / PermissionError** (backend not found, claude not logged
   in) bypass retry entirely -- directly set `run.failed` with exit code 4.

This workflow covers the test design (Step 1). Implementation is Step 2.

## 2. Use Case Enumeration

| ID | Title | Trigger | Expected Outcome |
|---|---|---|---|
| UC-RETRY-001 | Retry succeeds on 2nd attempt | Backend fails attempt=1, retry allows attempt=2, backend succeeds | Job completes with attempt=2, `job_retrying` event, `step_failed` on attempt 1, `agent_completed` on attempt 2 |
| UC-RETRY-002 | Retry exhausts attempts with default on_exceeded | Backend fails every attempt, max_attempts=2, no on_exceeded declared | Job status → `blocked`, `job_blocked` event, run stays active (not `failed`) |
| UC-RETRY-003 | Retry exhausts attempts with on_exceeded.status=failed | Backend fails every attempt, max_attempts=2, `on_exceeded.status: failed` | Job status → `failed`, `job_failed` event |
| UC-RETRY-004 | ConfigError bypasses retry (backend not found) | Backend resolver throws ConfigError | Run status → `failed`, no retry, no `job_retrying`, exit code 4 semantics |
| UC-RETRY-005 | PermissionError bypasses retry (not logged in) | Backend resolver or execute throws PermissionError | Run status → `failed`, no retry, exit code 4 semantics |
| UC-RETRY-006 | Retry respects max_attempts from job definition | Workflow declares `retry.max_attempts: 3`, backend fails twice then succeeds | Attempts cap at 3, job completes on attempt 3 |
| UC-RETRY-007 | step_failed event carries correct attempt and reason | Any backend failure | `step_failed` event has `payload.attempt` matching current attempt, `payload.reason` contains error |
| UC-RETRY-008 | Timeout failure triggers retry | Backend returns timeout error | Same retry path as normal failure (timeout IS retryable) |

## 3. Functional Point Coverage Matrix

| FP ID | Description | UC Coverage | Test Case ID |
|---|---|---|---|
| FP-RETRY-STEP-FAILED | Write `step_failed` event on backend error | UC-RETRY-001, UC-RETRY-007 | T-RETRYF-1 |
| FP-RETRY-ATTEMPT-CHECK | Compare current attempt to `retry.max_attempts` | UC-RETRY-001, UC-RETRY-002, UC-RETRY-003 | T-RETRYF-1, T-RETRYF-2, T-RETRYF-3 |
| FP-RETRY-JOB-RETRYING | Call `retryJob` when attempt < max_attempts | UC-RETRY-001 | T-RETRYF-1 |
| FP-RETRY-ON-EXCEEDED | Apply `on_exceeded.status` when attempts exhausted | UC-RETRY-002, UC-RETRY-003 | T-RETRYF-2, T-RETRYF-3 |
| FP-RETRY-DEFAULT-ON-EXCEEDED | Default `on_exceeded.status` is `blocked` when not declared | UC-RETRY-002 | T-RETRYF-2 |
| FP-RETRY-CONFIG-ERROR | ConfigError/PermissionError skip retry and set `run.failed` | UC-RETRY-004, UC-RETRY-005 | T-RETRYF-4, T-RETRYF-5 |
| FP-RETRY-TIMEOUT-RETRY | Timeout failures are retryable (not skipped) | UC-RETRY-008 | T-RETRYF-6 |
| FP-RETRY-ATTEMPT-DIR | Each retry creates a new attempt directory | UC-RETRY-001 | T-RETRYF-1 |
| FP-RETRY-PRESERVE | recordAgentFailure does NOT modify runState.status to failed unless ConfigError | UC-RETRY-001, UC-RETRY-002 | T-RETRYF-1, T-RETRYF-2 |

## 4. Spec Compliance Matrix

| ADR / Contract | Requirement | Evidence |
|---|---|---|
| AD-P13-004 §1 | Writes `step_failed` event | T-RETRYF-1 asserts `step_failed` in event log |
| AD-P13-004 §2 | Reads `JobDefinition.retry`, compares attempt vs max_attempts | T-RETRYF-1 asserts retry when attempt < max; T-RETRYF-2 asserts no retry when exceeded |
| AD-P13-004 §3 | Calls `retryJob` with attempt+1, new attempt dir, status→ready | T-RETRYF-1 asserts `job_retrying` event and job.status=ready |
| AD-P13-004 §4 | Applies `on_exceeded.status` (default `blocked`) | T-RETRYF-2 asserts blocked; T-RETRYF-3 asserts failed |
| AD-P13-004 §5 | ConfigError/PermissionError → direct run.failed, no retry | T-RETRYF-4, T-RETRYF-5 assert run.failed without job_retrying |
| mvp-contracts §2.3 | Engine owns state transitions | recordAgentFailure is Engine entry point, not CLI |
| mvp-contracts §2.4 | Events are auditable | All paths produce event chain (step_failed → job_retrying or job_blocked/failed) |

## 5. Test Plan

### Test File: `tests/engine/recordAgentFailure.test.ts`

| Test Case ID | Description | Method |
|---|---|---|
| T-RETRYF-1 | Retry succeeds on 2nd attempt | Mock backend fails on attempt=1, succeeds on attempt=2; call runAll with retry-enabled workflow; assert job.completed, attempts=2, `job_retrying` event present |
| T-RETRYF-2 | Max_attempts exceeded with default on_exceeded (blocked) | Workflow with `max_attempts: 1`; backend always fails; assert job.blocked, `job_blocked` event, run not failed |
| T-RETRYF-3 | Max_attempts exceeded with `on_exceeded.status: failed` | Workflow with `max_attempts: 2`, `on_exceeded.status: failed`; backend always fails; assert job.failed, `job_failed` event |
| T-RETRYF-4 | ConfigError bypasses retry | Backend resolver throws ConfigError("backend not found"); assert run.failed, no `job_retrying` event, only 1 attempt |
| T-RETRYF-5 | PermissionError bypasses retry | Backend resolver or execute throws PermissionError("not logged in"); assert run.failed, no retry |
| T-RETRYF-6 | Timeout failure is retryable | Backend times out on attempt=1, succeeds on attempt=2; assert `agent_timed_out` + `step_failed` on attempt 1, `job_retrying`, `agent_completed` on attempt 2 |
| T-RETRYF-7 | step_failed event payload carries correct reason | Assert `step_failed.payload.reason` matches backend error and `payload.attempt` matches current attempt |

### Test Strategy

- **Red-phase lazy import**: `recordAgentFailure` module does not exist yet. Use the lazy import pattern from `tests/engine/runAll.test.ts` with the specifier `../../src/engine/recordAgentFailure.js`.
- **End-to-end via runAll**: Since `recordAgentFailure` is called from within `runAll`, the primary test path exercises it through `runAll` with a configurable FakeBackend.
- **FakeBackend**: Extend the FakeBackend pattern from `tests/engine/runAll.test.ts` to support per-attempt behavior (fail on attempt N, succeed after).

### Fixtures Needed

- `RETRY_ENABLED_YAML` — single agent job with `retry: { max_attempts: 2 }`
- `RETRY_EXCEEDED_FAILED_YAML` — `retry: { max_attempts: 1, on_exceeded: { status: failed } }`
- `RETRY_EXCEEDED_DEFAULT_YAML` — `retry: { max_attempts: 1 }` (no on_exceeded)
