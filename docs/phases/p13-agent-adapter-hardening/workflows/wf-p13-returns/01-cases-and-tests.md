---
workflow: WF-P13-RETURNS
title: Step Structured Return Status — Use Cases and Test Plan
status: proposed
date: 2026-06-28
target: AD-P13-009
references:
  - docs/phases/p13-agent-adapter-hardening/02-development-plan.md §5 WF-P13-RETURNS
  - docs/mvp-contracts.md §2.1, §2.3, §2.4, §2.6
  - docs/prd.md §FR-010
---

# WF-P13-RETURNS — Use Cases and Test Plan

## 1. Summary

This workflow implements AD-P13-009 (Structured Return Status): Agent reports
can include an optional `status` field (e.g., `"approved"`, `"rejected"`), and
workflow steps can declare `returns.status.values` (the allowed set of status
strings) plus `on_return` mappings that translate each declared status into a
routing action (`continue`, `fail`, `block`, `retry_job`, `activate_job`,
`goto_job`).

Key behaviors:

1. **Schema validation** at `loadWorkflow` time: `returns.status.values` must
   be a non-empty array; `on_return` keys must be a subset of `returns.status.values`;
   `on_return` values must be valid `RouterAction` objects/literals.
2. **Runtime application**: Engine entry point `applyStatusReturn` validates
   the report `status` against the step's declared `returns`, looks up the
   corresponding `on_return` action, delegates to `applyRoutingAction`, and
   emits a `step_returned` event.
3. **Pipeline integration**: `acceptAgentReport` calls `applyStatusReturn`
   after persisting outputs but before signal handling (AD-P13-013). Status
   action takes priority over signals.
4. **Backward compatibility**: Steps without `returns` work exactly as before;
   a `status` field in such reports is treated as data, recorded in outputs,
   and does not trigger routing.

This workflow covers Step 1 (test design and use case enumeration).
Implementation is Step 2.

## 2. Use Case Enumeration

| ID | Title | Trigger | Expected Outcome |
|---|---|---|---|
| UC-RETURNS-001 | Step declares returns with on_return; report status matches | Agent report includes `status: "approved"`; step declares `returns.status.values: [approved, rejected]` and `on_return: { approved: continue }` | `step_returned` event emitted with status="approved" mapped_action="continue"; continue action applied; job advances |
| UC-RETURNS-002 | Status required but missing from report | `returns.status.required: true` but report omits `status` field | ValidationError raised; step_failed event emitted |
| UC-RETURNS-003 | Status value not in declared values | Report `status: "bogus"` but step declares `values: [approved, rejected]` | ValidationError raised; step_failed event emitted |
| UC-RETURNS-004 | No returns declared; status in report treated as data | Report includes `status: "anything"` but step has no `returns` field | Status recorded in outputs alongside other output fields; no routing action triggered; normal signal/advance pipeline continues |
| UC-RETURNS-005 | Status triggers retry_job action | Report `status: "rejected"` maps to `on_return: { rejected: { retry_job: implement } }` | `step_returned` emitted; `applyRoutingAction` called with `retry_job` action; target job retried |
| UC-RETURNS-006 | Status triggers goto_job action | Report `status: "escalate"` maps to `on_return: { escalate: { goto_job: review } }` | `step_returned` emitted; source job completed; target job transitions to ready/waiting |
| UC-RETURNS-007 | Status triggers continue action | Report `status: "pass"` maps to `on_return: { pass: continue }` | `step_returned` emitted; `advanceJob` called; step pointer advances |
| UC-RETURNS-008 | on_return does not declare mapping for specific status | Step declares `values: [approved, rejected]` and `on_return: { approved: continue }` but report has `status: "rejected"` | ValidationError because `rejected` is in values but has no on_return mapping |
| UC-RETURNS-009 | Multiple status values declared; status matches a later value | Step declares `values: [approved, rejected, needs_clarification]`; report `status: "needs_clarification"` maps to `goto_step: gather-context` | Correct action (`goto_step`) dispatched for the matched status |
| UC-RETURNS-010 | step_returned event payload carries correct fields | Any successful status return | Event payload contains `job_id`, `step_id`, `status` (the report value), `mapped_action` (the action discriminator string) |
| UC-RETURNS-011 | returns.status.required defaults to false | Step declares `returns.status.values` without explicit `required` field | Missing status in report does NOT cause ValidationError; normal pipeline proceeds |
| UC-RETURNS-012 | returns declared without on_return; status present | Step declares `values: [approved, rejected]` but no `on_return` at all | Report status in values is accepted; no action triggered (no mapping available); validation passes |

## 3. Functional Point Coverage Matrix

| FP ID | Description | UC Coverage | Test Case ID |
|---|---|---|---|
| FP-RETURNS-SCHEMA-001 | Valid returns schema accepted | UC-RETURNS-001, UC-RETURNS-011 | FR-RETURNS-SCHEMA-001, FR-RETURNS-SCHEMA-006, FR-RETURNS-SCHEMA-007, FR-RETURNS-SCHEMA-008 |
| FP-RETURNS-SCHEMA-002 | Empty status.values array rejected | — | FR-RETURNS-SCHEMA-002 |
| FP-RETURNS-SCHEMA-003 | on_return key not in values rejected | — | FR-RETURNS-SCHEMA-003 |
| FP-RETURNS-SCHEMA-004 | Non-boolean required field rejected | — | FR-RETURNS-SCHEMA-004 |
| FP-RETURNS-SCHEMA-005 | Invalid on_return action rejected | — | FR-RETURNS-SCHEMA-005 |
| FP-RETURNS-SCHEMA-006 | Returns without on_return accepted | UC-RETURNS-012 | FR-RETURNS-SCHEMA-006 |
| FP-RETURNS-SCHEMA-009 | Step without returns (backward compat) | UC-RETURNS-004 | FR-RETURNS-SCHEMA-009 |
| FP-RETURNS-SCHEMA-010 | Returns on non-agent step allowed | — | FR-RETURNS-SCHEMA-010 |
| FP-STATUS-RETURN-001 | Status match triggers on_return action + event | UC-RETURNS-001 | FR-STATUS-RETURN-001 |
| FP-STATUS-RETURN-002 | Required status missing causes error | UC-RETURNS-002 | FR-STATUS-RETURN-002 |
| FP-STATUS-RETURN-003 | Status not in values causes error | UC-RETURNS-003 | FR-STATUS-RETURN-003 |
| FP-STATUS-RETURN-004 | No returns declared, status → outputs | UC-RETURNS-004 | FR-STATUS-RETURN-004 |
| FP-STATUS-RETURN-005 | retry_job action dispatched | UC-RETURNS-005 | FR-STATUS-RETURN-005 |
| FP-STATUS-RETURN-006 | goto_step action dispatched | UC-RETURNS-006, UC-RETURNS-009 | FR-STATUS-RETURN-006 |
| FP-STATUS-RETURN-007 | continue action dispatched | UC-RETURNS-007 | FR-STATUS-RETURN-007 |
| FP-STATUS-RETURN-008 | on_return missing mapping for status | UC-RETURNS-008 | FR-STATUS-RETURN-008 |
| FP-STATUS-RETURN-009 | Multiple status values; second match | UC-RETURNS-009 | FR-STATUS-RETURN-009 |
| FP-STATUS-RETURN-010 | step_returned event payload correctness | UC-RETURNS-010 | FR-STATUS-RETURN-010 |

## 4. Spec Compliance Matrix (AD-P13-009)

| ADR / Contract Clause | Requirement | Evidence |
|---|---|---|
| AD-P13-009 §1 — Step `returns` schema | Step definition gets optional `returns: { status: { values: string[], required?: boolean } }` | FR-RETURNS-SCHEMA-001 validates full schema; FR-RETURNS-SCHEMA-002 rejects empty values; FR-RETURNS-SCHEMA-004 rejects non-boolean required |
| AD-P13-009 §1 — Step `on_return` mapping | Step definition gets optional `on_return: Record<string, RouterAction>` | FR-RETURNS-SCHEMA-007 validates continue literal; FR-RETURNS-SCHEMA-008 validates retry_job object action |
| AD-P13-009 §1 — Schema cross-field validation | `on_return` keys must be subset of `returns.status.values` | FR-RETURNS-SCHEMA-003 rejects key not in values |
| AD-P13-009 §1 — Valid RouterAction values | `on_return` values must be valid router actions | FR-RETURNS-SCHEMA-005 rejects invalid action literal |
| AD-P13-009 §2 — Report schema extension | `report.json` schema gets optional `status: string` | FR-STATUS-RETURN-001 submits report with status field |
| AD-P13-009 §2 — required semantics | If `required: true`, status must be present and in values | FR-STATUS-RETURN-002 (missing → error); FR-STATUS-RETURN-003 (bad value → error) |
| AD-P13-009 §3 — applyStatusReturn Engine entry | New entry point validates status, looks up action, delegates to applyRoutingAction, emits step_returned | FR-STATUS-RETURN-001 through FR-STATUS-RETURN-010 |
| AD-P13-009 §3 — step_returned event | New event type with payload: job_id, step_id, status, mapped_action | FR-STATUS-RETURN-010 asserts payload field values |
| AD-P13-009 §4 — Default behavior (no returns) | Status without returns declaration → outputs, no action | FR-STATUS-RETURN-004 confirms status goes to outputs without routing |
| AD-P13-009 §5 — Status priority over signals | Status action takes priority; if status triggers action, skip signal dispatching | (Integration coverage in WF-P13-FLOW / accept-pipeline.test.ts) |
| AD-P13-013 §4 — Pipeline order | applyStatusReturn runs after outputs persist, before signal handling | (Integration coverage in accept-pipeline.test.ts) |
| AD-P13-013 §4 — Required status validation | `required: true` + missing status → ValidationError → step_failed | FR-STATUS-RETURN-002 |
| AD-P13-013 §4 — Status value validation | Status not in declared values → ValidationError → step_failed | FR-STATUS-RETURN-003 |

## 5. Test Plan

### 5.1 Schema Tests: `tests/workflow/returns-schema.test.ts`

Tests the Zod schema additions on `StepDefinition` via `loadWorkflow`. Uses
inline YAML fixtures to exercise valid and invalid combinations of `returns`
and `on_return`.

| Test Case ID | Description | Method |
|---|---|---|
| FR-RETURNS-SCHEMA-001 | valid returns with status.values and on_return passes schema | YAML with full returns + on_return; `loadWorkflow` succeeds |
| FR-RETURNS-SCHEMA-002 | returns.status.values is empty array → validation error | YAML with `values: []`; `loadWorkflow` throws ValidationError |
| FR-RETURNS-SCHEMA-003 | on_return key not in returns.status.values → validation error | YAML with `values: [approved]` but `on_return: { rejected: continue }`; throws ValidationError |
| FR-RETURNS-SCHEMA-004 | returns.status.required is not boolean → validation error | YAML with `required: "yes"` (string); throws ValidationError |
| FR-RETURNS-SCHEMA-005 | on_return value is invalid RouterAction → validation error | YAML with `on_return: { approved: delete_job }` (not in enum); throws ValidationError |
| FR-RETURNS-SCHEMA-006 | returns without on_return → valid | YAML with `returns.status.values: [a, b]` but no `on_return`; `loadWorkflow` succeeds |
| FR-RETURNS-SCHEMA-007 | on_return with continue literal action → valid | YAML with `on_return: { x: continue }`; `loadWorkflow` succeeds |
| FR-RETURNS-SCHEMA-008 | on_return with retry_job object action → valid | YAML with `on_return: { x: { retry_job: foo } }`; `loadWorkflow` succeeds |
| FR-RETURNS-SCHEMA-009 | step without returns field → valid (backward compat) | Canonical workflow YAML (no returns field); `loadWorkflow` succeeds |
| FR-RETURNS-SCHEMA-010 | returns declared on non-agent step → valid | YAML with `type: script` step that has `returns`; schema allows any step type to declare returns (semantic guard is runtime) |

### 5.2 Engine Tests: `tests/engine/applyStatusReturn.test.ts`

Tests the `applyStatusReturn` Engine entry point. Uses real temp directories
with `createRun` bootstrapping, state manipulation via `LocalStateStore`, and
event log verification.

**Red-phase setup:**
- `applyStatusReturn` module does not exist yet. Use the lazy import pattern
  from `tests/engine/accept.test.ts` with dynamic import specifier
  `../../src/engine/applyStatusReturn.js`.
- All tests will fail with a descriptive error until Step 2 ships the module.

| Test Case ID | Description | Method |
|---|---|---|
| FR-STATUS-RETURN-001 | Status matches on_return key → action executed, step_returned event emitted | Bootstrap run with returns+on_return workflow; call applyStatusReturn with matching status; assert step_returned event and action effect |
| FR-STATUS-RETURN-002 | Status missing but required=true → ValidationError, step_failed event | Step declares `required: true`; call applyStatusReturn with status=undefined; assert ValidationError and step_failed event |
| FR-STATUS-RETURN-003 | Status not in values → ValidationError, step_failed event | Values=[approved, rejected]; submit status="bogus"; assert ValidationError and step_failed event |
| FR-STATUS-RETURN-004 | No returns declared, status in report → recorded in outputs, no action triggered | Workflow step without returns; call acceptAgentReport with report containing `status`; assert status appears in job outputs; no step_returned event |
| FR-STATUS-RETURN-005 | Status triggers retry_job action | on_return maps status to `retry_job` object; verify target job retried, step_returned event with correct mapped_action |
| FR-STATUS-RETURN-006 | Status triggers goto_job action | on_return maps status to `goto_job`; verify source job completed, target activated, step_returned event |
| FR-STATUS-RETURN-007 | Status triggers continue action → advanceJob called | on_return maps status to `continue`; verify step_returned event and job advancement |
| FR-STATUS-RETURN-008 | Status present but step declares returns without on_return for that specific status → ValidationError | Values=[approved, rejected]; on_return={approved: continue}; submit status="rejected"; assert ValidationError |
| FR-STATUS-RETURN-009 | Multiple status values declared, status matches second one → correct action | Values=[a, b, c]; on_return={b: fail}; submit status="b"; assert fail action triggered |
| FR-STATUS-RETURN-010 | step_returned event has correct payload fields | Any successful return; assert payload contains job_id, step_id, status, mapped_action with correct values |

### 5.3 Test Strategy

- **Schema tests**: Pure synchronous `loadWorkflow` calls with inline YAML
  strings. No filesystem needed. Tests validate Zod error messages and paths.
- **Engine tests**: Use real temp directories (under `os.tmpdir()`), `createRun`
  for bootstrapping, `FakeClock` for deterministic timestamps, and event log
  parsing to verify event types and payloads.
- **For FR-STATUS-RETURN-004**: This tests the acceptAgentReport pipeline
  integration (not applyStatusReturn directly), since it covers the case where
  no `returns` is declared. Use the same lazy import pattern targeting
  `acceptAgentReport`.
- **For goto_step action**: Full goto_step behavior is in WF-P13-FLOW scope.
  This test only verifies that `applyRoutingAction` is called with the correct
  mapped action and `step_returned` is emitted.

### 5.4 Fixtures Needed

**For schema tests:**
- `CANONICAL_WORKFLOW_YAML` — reused from `tests/workflow/workflow.test.ts`
- Various inline YAML snippets for each boundary case

**For engine tests:**
- `RETURNS_ENABLED_YAML` — single agent step with `returns.status.values`
  and `on_return` mapping
- `RETURNS_REQUIRED_YAML` — step with `returns.status.required: true`
- `RETURNS_NO_ON_RETURN_YAML` — step with `returns.status.values` but
  no `on_return`
- `RETURNS_RETRY_YAML` — step with `on_return` containing `retry_job`
  action targeting another job
- `RETURNS_GOTO_JOB_YAML` — step with `on_return` containing `goto_job`
  action
- `NO_RETURNS_YAML` — standard workflow without any `returns` declarations
