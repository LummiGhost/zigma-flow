---
phase: p8-router-and-signals
status: planned
date: 2026-06-10
authority: docs/prd.md §20 (FR-008), docs/architecture.md §6–§7, §9.4, §12.3, §16, docs/mvp-contracts.md §2.1, §2.8, §6, §7
---

# P8 Development Plan — Router Step, Multi-step Advancement, Signal Handling, and Workspace Guard

## 1. Phase Goal

Enable multi-step job execution, router step logic, on_fail/on_pass signal processing,
and workspace guard validation:

1. **Router Step Execution:** Execute `type: "router"` steps that read routing conditions and emit `router_decided` events without calling Agent or running scripts.
2. **Multi-step Job Advancement:** When a step completes, automatically advance `current_step` pointer to the next step in job definition.
3. **Signal Handling:** Engine processes `on_fail` and `on_pass` routing actions (`retry_job`, `activate_job`, `goto_job`) to trigger corresponding state transitions.
4. **Workspace Guard:** Detect if read-only jobs have modified the working directory and fail with `PermissionError`.

Pays off tech debt: TD-P6-004 (multi-step advancement), TD-P7-001 (on_fail/on_pass routing), TD-P7-003 (workspace guard).

Architecture §13 phase 8 verification target:
> multi-step job 支持；router step 分流；on_failure/on_pass 处理流程重试、激活和跳转；read-only job 修改工作区失败。

## 2. Milestones

| ID | Milestone | Acceptance condition |
|---|---|---|
| MS-P8-1 | User can execute router steps via `zigma-flow step --job` | Integration test: `step` on a router-type step → routing decision applied (job fails, retries, or continues) |
| MS-P8-2 | Multi-step jobs advance through steps automatically | Integration test: job with 3 steps → each step completes → current_step pointer increments → next step becomes ready |
| MS-P8-3 | on_fail/on_pass routing actions processed by Engine | Integration test: step with `on_fail: retry_job` → job enters retry flow with attempt counter incremented |
| MS-P8-4 | Workspace Guard detects read-only job modifications | Integration test: read-only job modifies a file → check fails with PermissionError |

## 3. Scope

**In scope:**
- `executeCurrentStep` extended to handle `router` step type (`src/engine/index.ts`)
- `RouterDecision` type and router step schema enhancements (`src/router/index.ts`)
- Router step executor pipeline: condition evaluation → routing decision → event emission (`src/router/executor.ts`)
- `advanceJob(runId, jobId)` function to move `current_step` pointer to next step (`src/engine/index.ts`)
- Job state advancement: after a step completes, check for next step in job definition
- Signal processing in Engine:
  - `on_fail: "fail"` → job enters `failed` status
  - `on_fail: "block"` → job enters `blocked` status
  - `on_fail: "continue"` → advance to next step (if exists)
  - `on_fail: { action: "retry_job", ... }` → job enters `retrying` status, attempt counter incremented
  - `on_fail: { action: "activate_job", job: "X", ... }` → optional job "X" transitions to `ready`
  - `on_fail: { action: "goto_job", job: "X", ... }` → jump execution to job "X"
- `on_pass` logic mirrors `on_fail` for successful steps
- `WorkspaceGuard` port interface + local implementation (`src/workspace/index.ts`)
- Workspace Guard integration: read-only jobs checked before/after execution; PermissionError on modification
- `router_decided` event payload; `signal_received` event (deferred to P9 if Agent signals not MVP scope)
- Tests: `tests/router/executor.test.ts`, `tests/engine/multistep.test.ts`, `tests/workspace/guard.test.ts`

**Out of scope (P8):**
- Agent Signal submission (only workflow-defined routing is MVP) → deferred to P9
- Skill Pack `uses` referencing router logic (P9)
- Complex expression evaluation in router conditions (only literal field/value checks in MVP) → P9
- Concurrent job execution (remain single writable job constraint)
- Workflow template invocation via Workflow Step (P10)
- Human Gate Step (P11)
- TD-P5-003 (report schema rendering in prompt) — deferred to P9
- Complete event sourcing reconstruction (out of MVP scope)

## 4. Workflow Breakdown

Four workflows. Dependency graph:
- WF-P8-ROUTER and WF-P8-MULTISTEP are prerequisites for WF-P8-SIGNALS
- WF-P8-WSGUARD is independent; can proceed in parallel

### WF-P8-ROUTER — Router Step Execution and Routing Dispatch

**Goal:** Executor infrastructure for router steps: router decision logic, event emission, no Agent/script execution.

**Boundary:** Does NOT implement conditional expression evaluation (deferred to P9).
MVP router only supports literal field comparisons (e.g., `outputs.status == "approved"` as explicit step definition fields).
This workflow owns executor scaffolding and step type dispatch only.

**Functional points:**
- `router_decided` event payload in `src/events/index.ts`
- `RouteAction` type: union of `{ action: "continue" }`, `{ action: "fail" }`, `{ action: "block" }`, `{ action: "retry_job", ... }`, `{ action: "activate_job", job: string }`, `{ action: "goto_job", job: string }`
- Router step definition: has `routes` field (array of conditions with corresponding actions)
- MVP condition model: simple field comparisons from previous step outputs or signals
- `executeRouterStep(opts)` orchestration function in `src/router/executor.ts`:
  - Reads router step definition with routes
  - Evaluates conditions (MVP: literal comparisons only)
  - Selects matching route and corresponding action
  - Emits `router_decided` event
  - Returns routing decision for Engine to apply
- `executeCurrentStep` in `src/engine/index.ts` dispatches to `executeRouterStep` for `type: "router"`
- `RouterError` class in `src/utils/errors.ts` (exit code 1, for invalid route definitions or no matching routes)

**Deliverables:**
- `src/router/executor.ts` — `executeRouterStep(opts)` + route evaluation
- `src/router/index.ts` — `RouteAction` type, `RouterDecision` type
- `src/engine/index.ts` — dispatch to `executeRouterStep` for router steps
- `src/events/index.ts` — `router_decided` event payload
- `src/utils/errors.ts` — `RouterError` class
- `tests/router/executor.test.ts` — router logic tests

**Test IDs:** T-ROUTER-1 (route selected), T-ROUTER-2 (continue action), T-ROUTER-3 (fail action), T-ROUTER-4 (block action), T-ROUTER-5 (no matching route)

### WF-P8-MULTISTEP — Multi-step Job Advancement

**Goal:** Automatically advance `current_step` pointer when a step completes; enable users to execute multi-step jobs sequentially.

**Boundary:** This workflow owns the `advanceJob()` function and integration with Engine step execution loop.
NOT responsible for signal/routing logic (that's WF-P8-SIGNALS); just mechanical step advancement.

**Functional points:**
- Job definition contains `steps: [ { id, type, ... }, { id, type, ... }, ... ]`
- After a step completes (successfully or with failure caught by on_failure handler), Engine calls `advanceJob(runId, jobId)`
- `advanceJob()` finds the next uncompleted step in the job's step list
- Updates `current_step` pointer in state.json to the next step id
- Returns boolean: true if more steps remain, false if job is exhausted
- If no more steps: job transitions to `completed` (or stays `failed` if prior step failed without recovery)
- Next `zigma-flow step --job <job>` invocation reads updated `current_step` and executes the next step

**Deliverables:**
- `src/engine/index.ts` — `advanceJob(runId, jobId)` function
- Updated `executeCurrentStep` to call `advanceJob()` after step completion
- Integration test: multi-step job with 2–3 steps, each completes, advancing through steps

**Test IDs:** T-MULTISTEP-1 (step 1 → step 2), T-MULTISTEP-2 (step 2 → step 3), T-MULTISTEP-3 (final step → job completed), T-MULTISTEP-4 (failed step blocks advancement)

### WF-P8-SIGNALS — on_fail/on_pass Signal Processing and State Transitions

**Goal:** Engine processes `on_fail` and `on_pass` routing outcomes to trigger state transitions (retry, activate, goto).

**Boundary:** This workflow integrates router decisions with Engine's state machine.
Given a routing action from router step or step failure handler, convert to Engine commands.
NOT responsible for Agent signal submission (Agent signals deferred to P9).

**Functional points:**
- When a step execution completes (script, check, or router), Engine checks `on_pass` (success) or `on_fail` (failure) field
- Routing action types supported:
  - `{ action: "continue" }` or string `"continue"` → advance to next step
  - `{ action: "fail" }` or string `"fail"` → job enters `failed` status
  - `{ action: "block" }` or string `"block"` → job enters `blocked` status
  - `{ action: "retry_job" }` → job enters `retrying` status; attempt counter incremented; current_step reset to first step of job
  - `{ action: "activate_job", job: "<job-id>" }` → optional job transitions from `inactive` to `ready` (or `waiting` if dependencies not met)
  - `{ action: "goto_job", job: "<job-id>" }` → skip remaining steps in current job; prepare job X for execution (requires manual `step` command to start it)
- Events: `signal_received` (for routing decision); `job_retrying`, `job_activated`, `job_skipped` (state transitions)
- Retry semantics: attempt counter increments; step artifacts/results preserved in separate attempt directories

**Deliverables:**
- `src/engine/index.ts` — signal handler logic to process routing actions
- Updated step execution pipeline to apply routing actions
- `src/events/index.ts` — `job_retrying`, `job_activated`, `job_skipped`, `signal_received` event payloads
- Integration tests: on_fail retry, activate optional job, goto_job transitions

**Test IDs:** T-SIGNALS-1 (on_fail: fail), T-SIGNALS-2 (on_fail: retry_job), T-SIGNALS-3 (on_fail: activate_job), T-SIGNALS-4 (on_fail: goto_job), T-SIGNALS-5 (on_pass routing)

### WF-P8-WSGUARD — Workspace Guard and Read-only Job Protection

**Goal:** Detect if read-only jobs (jobs with `workspace: read-only` or equivalent) have modified the working directory.

**Boundary:** Port-adapter pattern: `WorkspaceGuard` interface with `detectModifications(cwd, readOnlyPatterns)` method.
Adapter wraps git/filesystem inspection.
Integration point: after step execution in read-only job, run guard check before marking step as completed.

**Functional points:**
- Job definition can declare `workspace: read-only` (MVP only supports this binary mode; no fine-grained path rules)
- Read-only job constraint: no changes to working directory allowed
- Before marking read-only step as completed: call `WorkspaceGuard.detectModifications(cwd)`
- If modifications detected: emit `step_failed` event with reason `"workspace_guard_detected_modifications"`; job status → `failed`; optional: PermissionError
- Modifications include: new files, deleted files, modified files, renamed files (anything in git status)
- Protected patterns (from P7 protected-runtime-files check) implicitly forbidden
- Integration: can be a built-in check kind (similar to protected-runtime-files from P7) or a guard called post-step

**Deliverables:**
- `src/workspace/index.ts` — `WorkspaceGuard` port interface, `SimpleWorkspaceGuard` adapter
- Integration with Engine: post-step check for read-only jobs
- Tests: `tests/workspace/guard.test.ts` with fake file system or temp repo

**Test IDs:** T-WSGUARD-1 (read-only job with no modifications → pass), T-WSGUARD-2 (read-only job with file creation → fail), T-WSGUARD-3 (read-only job with file deletion → fail)

## 5. Technical Decisions

### D1 — Router condition evaluation
MVP router only supports literal field comparisons embedded in step definition.
No expression language or complex condition evaluation.
Routes are defined as: `routes: [ { when: { field: value }, then: action }, ... ]`
This avoids scope creep into expression parsing; complex routing deferred to P9.

### D2 — Retry semantics
`retry_job` increments the `attempt` counter; previous attempt artifacts are preserved in separate directories.
`current_step` resets to the first step of the job (full re-execution from start, not continuation).
max_attempts enforced per workflow definition; exceeding max → job blocked or failed.

### D3 — activate_job behavior
`activate_job` transitions an optional job from `inactive` to `ready` (or `waiting` if dependencies not met).
Multiple activate signals for the same job are idempotent (job remains `ready`).
Job must have `activation: optional` in workflow definition; attempting to activate a required job → WorkflowError.

### D4 — goto_job semantics
`goto_job` skips remaining steps in the current job; prepares the target job for execution.
Does NOT automatically execute the target job — user must manually run `zigma-flow step --job <target>`.
Target job must exist in workflow; referencing non-existent job → WorkflowError.
If target job has unmet dependencies: transitions to `waiting` (waits for needs to complete).

### D5 — Workspace Guard implementation
Reuses `GitInspector` from P7 to detect changed files.
Additionally checks filesystem directly for untracked files (git-ignored files may still be forbidden in read-only jobs).
Integration point: post-step validation in Engine or as an implicit check before marking step completed.

### D6 — current_step storage and advancement
`current_step` is stored as string (step id) in `JobState`.
After step execution, `advanceJob()` finds the next step in the job's `steps[]` array and updates current_step.
If no more steps: current_step field is cleared (omitted from state.json) and job marked `completed`.

### D7 — Event sequence for routing
Router decided event emitted BEFORE state transition.
Signal received event (if applicable) emitted BEFORE routing action applied.
State transition events (job_retrying, job_activated) emitted AFTER routing action is processed.
Single atomic write of state.json after all events.

### D8 — read-only job definition
MVP defines read-only as a job-level property: `workspace: read-only` (future: path-level granularity in P9+).
Check is enforced post-step via `WorkspaceGuard`, not during step execution (e.g., not a pre-flight permission check).

## 6. Module Boundaries

```
src/commands/step.ts      ← existing CLI handler; calls executeCurrentStep (extended in P8)
src/engine/index.ts       ← executeCurrentStep; adds dispatch for "router" step type; adds advanceJob() and signal processing
src/router/executor.ts    ← executeRouterStep orchestration (condition eval → route selection → event emission)
src/router/index.ts       ← RouteAction type, RouterDecision type, route registry
src/workspace/index.ts    ← WorkspaceGuard port interface, SimpleWorkspaceGuard adapter
src/workflow/index.ts     ← router step schema extensions, workspace: read-only field
src/events/index.ts       ← router_decided, job_retrying, job_activated, job_skipped, signal_received event payloads
src/utils/errors.ts       ← RouterError class
```

`src/router/executor.ts` may import from `../router/index.js`, `../run/index.js`, `../events/index.js`.

`src/engine/index.ts` imports `executeRouterStep` from `../router/executor.js` and `WorkspaceGuard` interface from `../workspace/index.js`.

`src/engine/index.ts` does NOT directly import concrete implementations (adapters).

## 7. Tech Debt Registrations

| ID | Spec reference | Description | Deferred to |
|---|---|---|---|
| TD-P8-001 | mvp-contracts §2.1, prd §20 | Router expression language and complex condition evaluation | P9 |
| TD-P8-002 | prd FR-008, mvp-contracts §2.1 | Agent Signal submission and processing (signal_received emitted but Agent signals not accepted) | P9 |
| TD-P8-003 | arch §11, mvp-contracts §2.8 | Skill Pack `uses: "<skill-alias>.routers.<id>"` resolution | P9 |
| TD-P8-004 | arch §16, mvp-contracts §2.1 | Path-level workspace granularity (per-step read-only paths; not just job-level) | P10 |
| TD-P5-003 | prd FR-006 | Report schema rendering in prompt Output section | P9 |

## 8. Quality Gate

```
pnpm typecheck && pnpm lint && pnpm test
```

Baseline: 258/258 tests pass (P7 gate). Gate target: all existing + new P8 tests pass.
0 typecheck errors, 0 lint warnings.

New tests expected: ~50–70 net new test cases across router executor, multistep advancement, signal processing, and workspace guard.

## 9. Workflow Status

| Workflow | Status | Dependencies |
|---|---|---|
| WF-P8-ROUTER | planned | None (can start immediately) |
| WF-P8-MULTISTEP | planned | None (can start immediately) |
| WF-P8-SIGNALS | planned | Depends on WF-P8-ROUTER, WF-P8-MULTISTEP (integration point) |
| WF-P8-WSGUARD | planned | None (independent; can proceed in parallel) |

## 10. Risks and Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Router condition model underspecified for MVP | Step 1 may uncover missing schema or semantics | Front-load Step 1 with comprehensive use case matrix |
| Signal processing creates complex state machine | Harder to test and reason about | Decompose into minimal state transition rules; each rule has dedicated test |
| Workspace Guard false positives (untracked files) | Read-only jobs fail unexpectedly | Clearly document what "modification" means; provide exemption list or dry-run mode in P9 |
| Multi-step advancement edge cases | Retry/failed steps may not advance correctly | Thorough state machine tests covering retry → advance scenarios |

## 11. Acceptance Criteria

- [x] P8 development plan frozen and reviewed
- [ ] All 4 workflows Step 1 (cases + tests) completed
- [ ] All 4 workflows Step 2 (implementation) completed and gate passing
- [ ] All 4 workflows Step 3 (acceptance) completed; tech review and compliance review passing
- [ ] Total test count ≥ 308 (258 + 50 net new)
- [ ] Integration tests demonstrating multi-step job execution with routing and retry
- [ ] Zero breaking changes to existing CLI or state model
