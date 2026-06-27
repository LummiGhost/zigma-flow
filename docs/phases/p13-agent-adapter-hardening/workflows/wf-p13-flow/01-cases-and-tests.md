# WF-P13-FLOW — Conditions, Goto, and Bounded Loops (Step 1 — Cases and Tests)

Phase: P13b  
Workflow ID: WF-P13-FLOW  
ADR: AD-P13-012  
Date: 2026-06-28  

## 1. Overview

WF-P13-FLOW implements three interrelated flow-control mechanisms for the Zigma Flow workflow engine:

1. **Step `if:` condition** — Conditional step execution with boolean expression evaluation.
2. **Router `goto_step`** — Intra-job step redirection from a router's case mapping.
3. **Step `max_visits`** — Bounded-loop guard that limits how many times a step can be entered.

These mechanisms are designed to be composed: a planner step can set variables, a router can `goto_step` back to an earlier step to form a loop, and `max_visits` guarantees the loop terminates.

## 2. Use Cases

### UC-FLOW-001 — Conditional Step Execution (step `if:`)

**Actor:** Engine (advanceJob)  
**Precondition:** A step has `if: "<expr>"` declared in its workflow definition.  
**Trigger:** advanceJob is about to start the step.

**Main Flow:**
1. Engine resolves `${{ }}` tokens in the `if` expression string.
2. Engine evaluates the resolved expression as a boolean condition.
3. If true — step proceeds as normal.
4. If false — step status set to `skipped`, `step_skipped` event emitted (payload includes the condition string), advanceJob continues to the next step.
5. If expression parse fails — ValidationError raised, step_failed.

**Postcondition:** Step either ran, was skipped, or the job failed.

### UC-FLOW-002 — Router Intra-Job Redirection (goto_step)

**Actor:** Router step (via applyRoutingAction)  
**Precondition:** A router step declares a case mapping to `{ goto_step: "<target-step-id>" }`.  
**Trigger:** Router evaluates its switch expression and matches a case.

**Main Flow:**
1. Router produces routing action `{ goto_step: "<target>" }`.
2. applyRoutingAction validates target step exists in the same job.
3. `step_revisited` event emitted (payload: target_step, visit_count).
4. Target step's visit count incremented in `state.jobs[jobId].step_visits`.
5. `current_step` set to target step.
6. On the next iteration, advanceJob starts at the target step.

**Alternate Flows:**
- Target doesn't exist in same job → WorkflowError at validation time.
- Target across jobs → WorkflowError (use `goto_job` for cross-job).

### UC-FLOW-003 — Visit Counting and Max Visits Guard

**Actor:** Engine (advanceJob)  
**Precondition:** A step declares `max_visits: N` (default 3).  
**Trigger:** The step is about to be entered (either via normal advance or goto_step).

**Main Flow:**
1. Engine increments `step_visits[stepId]`.
2. If visit count < max_visits → step runs normally.
3. If visit count >= max_visits → step blocked, `step_visit_exceeded` event emitted, job blocked.
4. On `retryJob`, `step_visits` is reset to empty (new attempt starts fresh).

**Edge Cases:**
- `max_visits: 0` or negative → ValidationError at workflow load time.
- Skipped steps (via `if: false`) do NOT increment visit count.
- Step without `max_visits` declaration → defaults to 3.

### UC-FLOW-004 — Plan-Loop Pattern (E2E Composition)

**Actor:** End-to-end workflow  
**Precondition:** A job has steps: plan → implement → route, with router goto_step back to plan.  
**Trigger:** Full workflow run.

**Main Flow:**
1. Plan step writes a status variable (e.g., `plan_status = "incomplete"`).
2. Router evaluates switch, matches `incomplete` → `goto_step: plan`.
3. Engine redirects to plan step, incrementing visit count.
4. Loop continues until plan sets `plan_status = "ready"` OR `max_visits` is exceeded.
5. On `max_visits` exceeded → step blocked, job blocked, full audit trail.

## 3. Spec Compliance Matrix

| Ref | Requirement (AD-P13-012) | FR Test ID | Test File | Status |
|-----|--------------------------|------------|-----------|--------|
| R1 | Step with `if:` passes schema validation | FR-FLOW-SCHEMA-001 | flow-schema.test.ts | RED |
| R1 | Step with `max_visits` passes validation | FR-FLOW-SCHEMA-002 | flow-schema.test.ts | RED |
| R2 | Router `goto_step` with valid target | FR-FLOW-SCHEMA-003 | flow-schema.test.ts | RED |
| R2 | `goto_step` target not in same job | FR-FLOW-SCHEMA-004 | flow-schema.test.ts | RED |
| R2 | `goto_step` target non-existent | FR-FLOW-SCHEMA-005 | flow-schema.test.ts | RED |
| R2 | `goto_step` with `goto_with` payload | FR-FLOW-SCHEMA-006 | flow-schema.test.ts | RED |
| R3 | `max_visits: 0` → validation error | FR-FLOW-SCHEMA-007 | flow-schema.test.ts | RED |
| R4 | Backward compat (no if/max_visits) | FR-FLOW-SCHEMA-008 | flow-schema.test.ts | RED |
| R3 | `max_visits` not a number → error | FR-FLOW-SCHEMA-009 | flow-schema.test.ts | RED |
| R1 | `if` expression empty → error | FR-FLOW-SCHEMA-010 | flow-schema.test.ts | RED |
| R5 | goto_step to valid target → step pending | FR-GOTO-001 | goto-step.test.ts | RED |
| R5 | Visit count increment on goto_step | FR-GOTO-002 | goto-step.test.ts | RED |
| R5 | step_revisited event payload | FR-GOTO-003 | goto-step.test.ts | RED |
| R5 | goto_step to non-existent target → error | FR-GOTO-004 | goto-step.test.ts | RED |
| R5 | goto_step across jobs → error | FR-GOTO-005 | goto-step.test.ts | RED |
| R5 | goto_step with goto_with → retry_inputs | FR-GOTO-006 | goto-step.test.ts | RED |
| R5 | goto_step preserves attempt number | FR-GOTO-007 | goto-step.test.ts | RED |
| R6 | if: true → step runs normally | FR-IF-001 | step-if.test.ts | RED |
| R6 | if: false → step skipped, event emitted | FR-IF-002 | step-if.test.ts | RED |
| R6 | step_skipped event contains condition | FR-IF-003 | step-if.test.ts | RED |
| R6 | Skipped step → advance to next | FR-IF-004 | step-if.test.ts | RED |
| R6 | if with template expression resolved | FR-IF-005 | step-if.test.ts | RED |
| R6 | if parse error → ValidationError | FR-IF-006 | step-if.test.ts | RED |
| R6 | No if → backward compat | FR-IF-007 | step-if.test.ts | RED |
| R7 | Step entered once → count 1 | FR-MAXV-001 | max-visits.test.ts | RED |
| R7 | max_visits=3, allowed on 3rd, blocked on 4th | FR-MAXV-002 | max-visits.test.ts | RED |
| R7 | Default max_visits=3 | FR-MAXV-003 | max-visits.test.ts | RED |
| R7 | step_visit_exceeded event emitted | FR-MAXV-004 | max-visits.test.ts | RED |
| R7 | Job blocked after exceed | FR-MAXV-005 | max-visits.test.ts | RED |
| R7 | retryJob resets step_visits | FR-MAXV-006 | max-visits.test.ts | RED |
| R7 | Skipped steps don't increment visits | FR-MAXV-007 | max-visits.test.ts | RED |
| R8 | E2E plan-loop with goto_step | FR-E2E-001 | agent-flow-control-e2e.test.ts | RED |
| R8 | Complete auditable event chain | FR-E2E-002 | agent-flow-control-e2e.test.ts | RED |
| R8 | Variables + if: composition | FR-E2E-003 | agent-flow-control-e2e.test.ts | RED |

## 4. Test Coverage Mapping

### Schema Tests (10 tests)

Tests exercise `loadWorkflow` with YAML fixtures. Zod schema extensions (`if`, `max_visits`, `goto_step` in RouterAction) are not yet present in `src/workflow/index.ts`, so these tests verify that the schema additions are correctly wired when Step 2 implements them.

| FR-ID | Description | Expected Behavior (Step 1) |
|-------|-------------|---------------------------|
| FR-FLOW-SCHEMA-001 | step with `if: "${{ variables.x == 'ready' }}"` | Passes (unknown key stripped by passthrough; Step 2 must assert field survives) |
| FR-FLOW-SCHEMA-002 | step with `max_visits: 5` | Passes |
| FR-FLOW-SCHEMA-003 | router with `goto_step: gather-context` | Passes (target exists in same job) |
| FR-FLOW-SCHEMA-004 | goto_step target not in same job | ValidationError |
| FR-FLOW-SCHEMA-005 | goto_step target non-existent | ValidationError |
| FR-FLOW-SCHEMA-006 | goto_step with goto_with payload | Passes |
| FR-FLOW-SCHEMA-007 | max_visits: 0 | ValidationError |
| FR-FLOW-SCHEMA-008 | step without if or max_visits | Passes (backward compat) |
| FR-FLOW-SCHEMA-009 | max_visits not a number | ValidationError |
| FR-FLOW-SCHEMA-010 | if is empty string | ValidationError |

### Engine Tests (21 tests)

Engine tests bootstrap a real run via `createRun`, manipulate job state, then call the function under test. Tests that exercise modules not yet existing use lazy import wrappers (following the `applyStatusReturn.test.ts` pattern).

#### goto-step tests (7)

| FR-ID | Description | Lazy Import? |
|-------|-------------|-------------|
| FR-GOTO-001 | goto_step to valid target → target pending, current_step updated | Yes (applyRoutingAction) |
| FR-GOTO-002 | Visit count incremented on each goto_step | Yes |
| FR-GOTO-003 | step_revisited event has correct payload | Yes |
| FR-GOTO-004 | goto_step non-existent target → WorkflowError | Yes |
| FR-GOTO-005 | goto_step across jobs → WorkflowError | Yes |
| FR-GOTO-006 | goto_step with goto_with → retry_inputs on target | Yes |
| FR-GOTO-007 | goto_step preserves source job attempt number | Yes |

#### step-if tests (7)

| FR-ID | Description | Lazy Import? |
|-------|-------------|-------------|
| FR-IF-001 | if: true → step runs normally | Yes (advanceJob) |
| FR-IF-002 | if: false → step skipped, step_skipped event | Yes |
| FR-IF-003 | step_skipped event contains condition string | Yes |
| FR-IF-004 | Skipped step → advanceJob moves to next step | Yes |
| FR-IF-005 | if with template expression resolved | Yes |
| FR-IF-006 | if parse error → ValidationError → step_failed | Yes |
| FR-IF-007 | No if → runs normally (backward compat) | Yes |

#### max-visits tests (7)

| FR-ID | Description | Lazy Import? |
|-------|-------------|-------------|
| FR-MAXV-001 | Step entered once → visit count = 1 | Yes (advanceJob) |
| FR-MAXV-002 | max_visits=3, allowed on 3rd, blocked on 4th | Yes |
| FR-MAXV-003 | Default max_visits=3 when not declared | Yes |
| FR-MAXV-004 | step_visit_exceeded event emitted | Yes |
| FR-MAXV-005 | Job blocked after max_visits exceeded | Yes |
| FR-MAXV-006 | retryJob resets step_visits | No (retryJob exists) |
| FR-MAXV-007 | Skipped steps don't increment visit count | Yes (advanceJob) |

### E2E Tests (3 tests)

| FR-ID | Description |
|-------|-------------|
| FR-E2E-001 | Workflow with plan → goto_step → plan loop runs until max_visits exceeded |
| FR-E2E-002 | Event chain is complete and auditable |
| FR-E2E-003 | Planner writes variables → implement uses if: to check |

## 5. Key Design Decisions

1. **Step-level cycles allowed**: DAG validation does NOT enforce acyclicity at step level. Step-level cycles (via goto_step) are explicitly permitted and guarded by `max_visits`.

2. **Default max_visits = 3**: From AD-P13-012: "max_visits 默认 3". This ensures bounded loops by default.

3. **Visit count reset on retryJob**: Per AD-P13-012: "visit 计数随 retryJob（attempt+1）重置为 0". A new attempt means a fresh start.

4. **Skipped steps don't count**: Only actual step entry (via advance or goto_step) increments visit count. Skips via `if: false` do not.

5. **goto_step is same-job only**: Cross-job redirection uses the existing `goto_job` action. `goto_step` targets must exist in the same job's steps array.

## 6. Red-Phase Strategy

In Step 1, all tests are written as RED (failing) tests:

- **Schema tests**: Currently, `loadWorkflow` uses `.passthrough()` on step objects, so unknown fields (`if`, `max_visits`) are silently stripped. Tests that assert success for valid `if`/`max_visits` will pass (fields ignored rather than validated), which means they will GO GREEN in Step 1. Negative tests (invalid `max_visits`, missing target, etc.) will fail because the semantic validation does not yet exist — these remain RED.

- **Engine tests**: Lazy import wrappers catch module-not-found errors and throw descriptive errors. All lazy-import tests remain RED until Step 2 ships the modules.

- **retryJob test** (FR-MAXV-006): `retryJob` already exists. The test verifies it resets `step_visits`, which will be RED until Step 2 adds the reset logic.

- **E2E tests**: All remain RED — they depend on the full goto_step + if + max_visits pipeline.

## 7. Files to Create

| File | Purpose | Test Count |
|------|---------|-----------|
| `tests/workflow/flow-schema.test.ts` | Schema validation for if, max_visits, goto_step | 10 |
| `tests/engine/goto-step.test.ts` | goto_step routing action | 7 |
| `tests/engine/step-if.test.ts` | Step if: condition evaluation | 7 |
| `tests/engine/max-visits.test.ts` | Visit counting and max_visits guard | 7 |
| `tests/dogfood/agent-flow-control-e2e.test.ts` | End-to-end plan-loop pattern | 3 |
| **Total** | | **34** |
