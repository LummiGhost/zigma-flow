# v0.7 Execution Model — Development Plan

Date: 2026-07-16
Status: Frozen
Inputs: Issue #233, #234, #235; `docs/prd.md`; `docs/architecture.md`; Research reports R1–R5

## Objective

- **Business objective:** Replace the deprecated v0.6 dynamic control-flow features (`goto_step`, `goto_job`, `retry_job`, `max_visits`, `signals`) with a forward-only, immutable-record execution model based on Attempt, Job Group Iteration, and declarative execution strategies. Prepare for v1.0 removal of deprecated features.
- **Technical objective:** Introduce three new domain concepts — Execution Attempt, Job Group Iteration, and Condition Context / Execution Strategy — that together replace all deprecated dynamic control flow with static-DAG-compatible alternatives. Engine state only advances forward; retry and rework always produce new execution records.

## Scope

### In scope

| Feature | Source | Priority |
|---------|--------|----------|
| Execution Attempt data model | #234 | P0 |
| Attempt-based retry (retry policy with `when` conditions) | #234 | P0 |
| Attempt outcome vs Job conclusion distinction | #234 | P0 |
| Job Group data model with Iterations | #233 | P0 |
| `repeat` block (max_iterations + until condition) | #233 | P0 |
| `iteration.previous` data flow for feedback-driven rework | #233 | P0 |
| Condition Context namespaces (`inputs`, `invocation`, `run`, `jobs`, `steps`, `attempt`, `host`) | #235 | P1 |
| Status functions (`success()`, `failure()`, `always()`, `cancelled()`) | #235 | P1 |
| Concurrency Group model (`group`, `policy`: allow/queue/cancel_previous/reject) | #235 | P1 |
| Failure Policy at job level (`fail`/`continue`/`block`) | #235 | P1 |
| Result model: `outcome` vs `conclusion` distinction | #235 | P1 |
| Backward compatibility: translate deprecated features internally | #233 | P0 |
| Updated event catalog (new + removed event types) | #233, #234 | P0 |
| Updated CLI inspect to show Attempt/Iteration history | #234 | P1 |
| Updated Workflow Language Specification | #233, #235 | P1 |

### Out of scope

- Matrix strategy (explicitly rejected per #235)
- v1.0 removal of deprecated fields (v0.7 keeps compatibility)
- `while`/`for` DSL keywords
- Runtime YAML patch
- New CLI top-level commands beyond inspect enhancements
- Web UI
- Remote Skill Registry

## Milestones

| Milestone | Description | Exit criteria |
|-----------|-------------|---------------|
| M1: Pre-research complete | All 5 research topics resolved, plan frozen | Research reports accepted; plan updated with final decisions |
| M2: Attempt model landed | #234 data model, retry policy, engine integration | typecheck + lint + test:ci pass; old retry_job internally uses Attempt |
| M3: Job Group Iteration landed | #233 data model, repeat block, iteration data flow | typecheck + lint + test:ci pass; old goto_step/goto_job internally use Iteration |
| M4: Execution strategies landed | #235 condition context, concurrency group, failure policy, result model | typecheck + lint + test:ci pass |
| M5: Phase acceptance | Total验收通过 | All gates green; backward compat verified; dogfood workflow runs |

## Technical Approach

### Architecture changes

The v0.7 execution model touches these modules:

- **`src/run/`** — New `Attempt`, `Iteration`, `JobGroup` types in state model; updated `RunState`, `JobState`
- **`src/engine/`** — New entry points for iteration loop, attempt creation; updated `runAll` loop, `recordAgentFailure`, `advanceJob`; concurrency group enforcement in scheduler
- **`src/events/eventTypes.ts`** — New event types; remove deprecated event types (or mark for v1.0 removal)
- **`src/workflow/`** — New `repeat`, `concurrency`, `failure_policy` schema fields; updated validation
- **`src/expression/`** — New context namespaces, status functions
- **`src/commands/invoke.ts`** — Updated inspect output for attempt/iteration history
- **`src/commands/inspect.ts`** — New inspection views for attempt and iteration data

### Data model direction (to be finalized in research)

```
Run
  JobGroup (new)
    Iteration 1 (new)
      Job A
        Attempt 1 (new — replaces implicit attempt counter)
          Step 1
          Step 2
        Attempt 2
          Step 1
          Step 2
      Job B
        Attempt 1
    Iteration 2
      Job A → reads iteration.previous.jobs.A.outputs
      Job B
```

Key design constraints:
- Completed executions stay terminal — never mutate status backward
- Retry and Iteration always produce new records
- Engine state only advances forward
- Workflow DAG remains static
- Agent returns domain results (failure_kind), not engine actions (retry_job)

### Compatibility strategy

v0.7: New model as recommended path. Old deprecated fields (`goto_step`, `goto_job`, `retry_job`, `max_visits`, `signals`) continue to work but are internally translated to the new Attempt/Iteration model. Deprecation warnings persist.

v1.0: Remove deprecated fields from schema, router actions, and engine.

## Workflow Breakdown

| Workflow | Goal | Dependencies | Acceptance criteria | Research needed |
|----------|------|-------------|---------------------|-----------------|
| WF-7.1: Execution Attempt | Introduce Attempt as first-class immutable execution record; unified retry policy | None (foundational) | Attempt data model in state; retry creates new Attempt without mutating old; failure_kind classification; CLI inspect shows attempt history; old retry_job internally translated | Attempt model detail design (R1) |
| WF-7.2: Job Group Iteration | Introduce Job Group with Iterations; replace goto_step/goto_job/max_visits | WF-7.1 (Attempt model) | Job Group + Iteration in state; repeat block schema; iteration.previous data flow; old goto_* internally translated | Job Group DAG semantics (R2); Failure policy cascade (R4) |
| WF-7.3: Condition Context & Execution Strategy | Add condition context namespaces, status functions, concurrency groups, failure policies, outcome/conclusion model | WF-7.1, WF-7.2 | Context namespaces in expressions; status functions evaluable; concurrency group enforcement; failure_policy at job level; outcome vs conclusion in state | Concurrency group integration (R3); Expression extensions (R5) |

## Risks And Mitigations

| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Attempt model breaks existing retry behavior | Medium | High | Comprehensive backward compat tests; internal translation layer for old retry_job | WF-7.1 |
| Job Group DAG semantics conflict with existing needs DAG | Medium | High | Resolve in R2 research before implementation; consider group-level needs only | WF-7.2 |
| Concurrency group + existing scheduler deadlock | Low | Medium | Resolve in R3 research; pure-function scheduler testability helps | WF-7.3 |
| Expression language creep (status functions become eval) | Medium | Medium | Strict grammar definition in R5; whitelist-only implementation | WF-7.3 |
| Dogfood workflow breakage | Medium | Medium | Run code-change workflow after each WF lands; backward compat ensures old workflows still work | All |
| State file size growth (immutable records) | Low | Low | Attempt/iteration data is incremental; old attempts already preserved; monitor run directory size | WF-7.1 |

## Quality Bar

- **Required automated tests:** Unit tests for Attempt state machine, Iteration state machine, retry policy evaluation, failure policy cascade, concurrency group enforcement, expression extensions; integration tests for backward compat translation of goto_step/goto_job/retry_job; snapshot tests for updated state.json schema
- **Required manual checks:** Dogfood run of code-change workflow with new model; inspect CLI output review
- **Performance / reliability constraints:** No regression in runAll loop iteration count; deadlock detection still works with iteration model
- **Documentation updates:** Workflow Language Specification updated with new fields; CHANGELOG entry

## Freeze Record

- **Plan status:** Frozen
- **Frozen at:** 2026-07-16
- **Pre-research completed:** R1 (Attempt Model), R2 (Job Group DAG), R3 (Concurrency Group), R4 (Failure Policy Cascade), R5 (Expression Extensions)

### Final Decisions

| Decision | R# | Choice | Rationale |
|----------|-----|--------|-----------|
| Attempt identity and numbering | R1 | Per-job monotonic (1,2,3 within each job) | Already established across codebase; artifact paths and event envelopes already scoped this way |
| Attempt state shape | R1 | Hybrid (key summary fields in Attempt; step detail stays in events) | Fast CLI inspection + compact state.json + no event duplication |
| `failure_kind` taxonomy | R1 | Closed string union: `timeout`, `infrastructure_error`, `invalid_output`, `agent_error`, `cancelled`, `permission_denied`, `config_error` + `(string & {})` extension slot | Type safety for known kinds; extension slot for forward compatibility. Maps to existing `errorType` in `recordAgentFailure.ts`. R1 authoritative over R4. |
| Retry policy `when` conditions | R1 | Whitelist array: `when: ["timeout", "infrastructure_error"]`. Default: transient failures only. | Safe by default; new failure kinds excluded until explicitly added |
| Job conclusion computation | R1/R4 | Last attempt outcome + `failure_policy`. `success_with_warnings` added per R4 for `failure_policy: continue`. | Retry-on-failure means last attempt IS the conclusion; `success_with_warnings` from R4 needed for "continue despite failure" |
| Artifact path | R1 | No change: `jobs/<jobId>/attempts/<n>/steps/<stepId>/` | Already correct; zero migration cost |
| Job Group structure | R2 | `group:` field on Job + `job_groups:` top-level section | Consistent with existing `traverse:` pattern; backward-compatible; flat job map preserved |
| Group-level DAG | R2 | Groups have `needs: [other_group]`, translated to first-iteration job readiness | Clean DAG semantics; inter-group dependencies expressed naturally |
| Iteration execution model | R2 | Sequential only (iteration N completes fully before N+1 starts) | Simplest; intra-iteration parallelism handled by existing scheduler |
| Iteration data access | R2 | Job-level outputs only: `${{ iteration.previous.jobs.<id>.outputs.<key> }}` | Consistent with existing `jobs.<id>.outputs` pattern; expression depth limit relaxed from 3 to 4 for this path |
| `until` evaluation timing | R2 | Post-iteration (after all jobs in iteration reach terminal status) | Natural iteration boundary; all outputs available |
| goto_step/goto_job backward compat | R2 | Runtime adaptation: engine creates implicit groups when goto triggered on ungrouped jobs | No static analysis fragility; existing workflows continue to work |
| Concurrency group scope | R3 | Per-run, static string keys. Expression-based keys deferred. | MVP scope; expression-based keys can be layered on later |
| Concurrency/parallelism integration | R3 | Separate constraint layer: parallelism cap first, then concurrency group filter | Orthogonal concerns; scheduler pure-function contract preserved |
| Policy enforcement point | R3 | `queue`/`allow` in scheduler (pure); `cancel_previous`/`reject` in pre-scheduler mutation step | Mutation policies require state changes; pure filter stays in scheduler |
| `cancel_previous` semantics | R3 | Cancel only currently-running jobs in same group; completed jobs untouched | Aligned with forward-only state principle |
| Failure policy scope | R4 | Job-level default, step-level override | Mirrors existing `on_failure` pattern; backward-compatible |
| Policy cascade | R4 | Hierarchical: job → iteration → group (each level can contain or escalate) | Models real escalation chains; default all `fail` = current behavior |
| `continue` policy semantics | R4 | Skip failed job (mark `failed`), continue iteration. DAG dependents correctly blocked. | Preserves auditability; does not fake success |
| Outcome vs Conclusion | R4 | Separate enums: `AttemptOutcome` (technical) vs `JobConclusion` (business). Pure mapping function. | Type-safe; independently testable; clear separation of engine domain and workflow author domain |
| Conclusion computation rule | R4 | Fixed rule: any success → `Success`; all failed → evaluate `failure_policy` | Matches current behavior; no configuration needed |
| Iteration conclusion criticality | R4 | Derived from `failure_policy`: `fail` → critical; `continue` → non-critical | No separate `critical` field needed |
| Expression namespaces | R5 | Phase: `attempt` + `invocation` in v0.7; `host` deferred to v1.0 | Security concern: `host` exposes OS/environment info |
| `invocation` namespace | R5 | `trigger` (`"manual" | "scheduled" | "resume"`) + `backend` (string) | Minimal, useful, safe |
| `attempt` namespace | R5 | `number`, `trigger` (`"initial" | "retry"`), `previous_outcome?` (optional) | Sufficient for retry policy `when:` conditions |
| Status function implementation | R5 | Pre-resolution: scan for 4 hardcoded function names, replace with boolean literals before tokenization | Zero grammar change; cannot enable arbitrary function calls |
| Status function scope | R5 | Condition-only (valid in `if:` and `when:`, not in general `${{ }}` interpolation) | Clear semantics; no ambiguity |
| Status function semantics | R5 | Context-dependent: `success()` in step `if:` checks prior steps; in retry `when:` checks previous attempt | Matches GitHub Actions convention; intuitive |
| Centralized expression context builder | R5 | New `buildExpressionContext()` helper in `src/context/index.ts` | Prevents drift across 7 call sites that currently build context inline |

### Cross-Research Reconciliations

| Topic | R1 position | R4 position | Resolved |
|-------|-------------|-------------|----------|
| `failure_kind` taxonomy | 7 well-known values + extension slot | 8-value enum | Use R1's taxonomy (maps to existing `errorType`). R4's additional `validation` and `unknown` values folded into `invalid_output` and extension slot respectively. |
| `AttemptOutcome` | `Attempt.status`: `"success" \| "failure" \| "cancelled"` | `AttemptOutcome`: `"success" \| "failure" \| "timeout" \| "cancelled"` | Use R1's model where timeout is a `failure_kind` within a `failure` status, not a separate outcome. Simpler. |
| `JobConclusion` | `"success" \| "failure" \| "blocked" \| "cancelled"` | Adds `"success_with_warnings"` | Adopt R4's `success_with_warnings` — needed for `failure_policy: continue`. Final set: `"success" \| "success_with_warnings" \| "failure" \| "blocked" \| "cancelled"`. |

### Residual Risks

1. **Expression depth limit**: `iteration.previous.jobs.<id>.outputs.<key>` requires 5-part path (depth 4). Current limit is depth 3. Must be relaxed for `iteration.previous` prefix specifically.
2. **State file size growth**: Immutable attempt + iteration records add ~200-500 bytes per attempt. Acceptable for MVP; monitor in CI.
3. **Implicit group naming collision**: `__implicit__` prefix prevents user-defined group name collisions, but lint rule should be added.
4. **`recordAgentFailure` premature run.status overwrite**: Known bug (line 277) fixed by v0.7 model (only sets job-level state; run conclusion computed separately).
