# Changelog

All notable changes to Zigma Flow are documented in this file.

## Classification Tags

Change entries are classified with the following tags to help readers quickly identify the nature of each change:

- `[runtime]` -- Engine, scheduler, state machine, job execution, agent lifecycle
- `[DSL]` -- Workflow schema, expression language, variables, context blocks
- `[CLI]` -- Command-line interface, flags, subcommands, output formatting
- `[docs]` -- Documentation, README, tutorials, comments
- `[tests]` -- Test additions, test fixes, test infrastructure
- `[breaking]` -- Breaking changes to public APIs, schema, or behavior (additive; appears alongside another tag)

## Version Policy

Zigma Flow follows semantic versioning for its release tags. Compatibility guarantees, stability levels (stable, experimental, reserved), and the breaking change process are documented in `docs/compatibility.md`.

---

## [v0.7.1] — Patch (2026-07-17)

### Engine Fixes

- [runtime] Fix engine deadlock when jobs with `failure_policy: continue` exhaust retries: downstream dependents are now correctly unblocked. `computeReadyJobs` treats failed+continue deps as satisfied, and readiness is propagated immediately after the failure is recorded (#253).
- [runtime] Fix post-loop deadlock resolution to skip failed upstream deps with `failure_policy: continue` instead of erroneously marking dependents as blocked (#253).
- [DSL] Replace deprecated `on_failure` syntax with `failure_policy` in issue-fix workflow templates (#252).

---

## [v0.7.0] — Execution Model (2026-07-16)

### Execution Attempt Model (#234, #247)

- [runtime] Introduce `Attempt` as a first-class immutable execution record with per-job monotonic numbering and hybrid state shape (summary fields in state, step detail in events).
- [runtime] Add `FailureKind` taxonomy: 7 well-known values (`timeout`, `infrastructure_error`, `invalid_output`, `agent_error`, `cancelled`, `permission_denied`, `config_error`) + extension slot. `TRANSIENT_FAILURE_KINDS` constant for default retry policy.
- [runtime] Add `RetryPolicy` with `when` whitelist conditions, `max_attempts`, and `on_exceeded`. Default retries on transient failures only (safe by default).
- [runtime] Add `deriveJobConclusion` pure function mapping attempt history to job conclusion.
- [runtime] Add `attempt_started`, `attempt_completed`, `attempt_failed` event types. Extend `job_failed`, `job_blocked`, `job_retrying` payloads with `failure_kind`.
- [runtime] Engine integration: `createRun` emits `attempt_started` per ready job; `appendJobCompleted` seals attempt as success; `retryJob` and routing paths create new Attempt records on retry.
- [runtime] Old `retry_job` router action internally translated to Attempt model (backward compatible).

### Job Group Iteration Model (#233, #248)

- [DSL] Add `group` field on `JobDefinition` and `job_groups` top-level section with `RepeatConfig` (`max_iterations`, `until` condition).
- [DSL] Group-level DAG: `job_groups.<id>.needs` for inter-group dependencies, with cycle detection.
- [runtime] Add `JobGroupState` and `IterationState` to `RunState`. Sequential iteration execution (N completes before N+1 starts).
- [runtime] Add `iteration.previous.jobs.<id>.outputs.<key>` expression for feedback-driven rework across iterations.
- [runtime] Add 7 new event types: `iteration_started`, `iteration_completed`, `iteration_condition_met`, `iteration_max_reached`, `group_completed`, `group_blocked`, `group_failed`.
- [runtime] Backward compat: runtime implicit group creation for `goto_step`/`goto_job` on ungrouped jobs. `max_visits` maps to `max_iterations`. `goto_with` maps to `iteration.previous`.
- [DSL] Validation: conflict detection (explicit `group` + `goto_step`/`goto_job`/`max_visits`), group reference checks, group DAG cycle detection.

### Expression Extensions & Outcome/Conclusion Model (#235, #249, #250)

- [DSL] Add `invocation` expression namespace (`trigger`, `backend`) and `attempt` namespace (`number`, `trigger`, `previous_outcome`).
- [DSL] Extend `jobs` and `steps` expression context with `.status` and `.attempt` fields.
- [DSL] Add status functions: `success()`, `failure()`, `always()`, `cancelled()` — pre-resolution strategy (no grammar change), condition-only scope, context-dependent semantics.
- [DSL] Add centralized `buildExpressionContext()` helper to prevent context construction drift across 7 call sites.
- [runtime] Add `AttemptOutcome`, `JobConclusion` (with `success_with_warnings`), and `IterationConclusion` enums.
- [runtime] Add pure mapping functions: `computeJobConclusion`, `computeIterationConclusion`, `computeRunConclusion`.
- [runtime] Add `failure_policy` field: `fail` (default), `continue`, `block` — job-level with step-level override. Hierarchical cascade: job → iteration → run.
- [runtime] Backward compat: old `on_failure` string values normalized to `failure_policy`.
- [runtime] Add Concurrency Group model: `concurrency` field on `JobDefinition` with static `group` key + `policy` (allow/queue/cancel_previous/reject).
- [runtime] Concurrency group integration: `queue` filter in scheduler (pure function), `cancel_previous`/`reject` in pre-scheduler mutation step.

### Event Catalog

- Event types expanded from 45 to 55+: 3 attempt lifecycle + 7 iteration/group + updated payloads.

### Internal Translation (v0.6 deprecation → v0.7 model)

| Deprecated | Replaced By |
|---|---|
| `goto_step`, `goto_job` | Implicit Job Group Iteration |
| `retry_job`, `retry_with` | Attempt model with `RetryPolicy.when` |
| `max_visits` | `max_iterations` on implicit group |
| `on_failure` (object form) | `failure_policy` |

### Documentation

- [docs] Phase documentation: `docs/phases/v0.7-execution-model/` — frozen development plan, 5 research reports (R1–R5), 3 workflow case documents.

### Test Coverage

- ~1670 tests across 105+ test files. New pure-function modules (`attemptModel`, `jobGroupModel`, `outcomeModel`) are independently testable.
- 3 tracked technical debt items: TD-7.1-MIG (pre-v0.7 run migration), TD-7.1-STATUS (state transition diagram update), TD-7.2-001 (attempt counter reset per iteration).

---

## [v0.6.3] — Scheduler Dispatch Fix (2026-07-14)

### Runtime

- [runtime] Fix engine exiting immediately after `job_ready` without dispatching any jobs. The scheduler no longer silently skips ready jobs whose definitions are missing from `workflow.jobs` (e.g., v0.5-style jobs where Zod strips unknown fields). The run loop now detects missed ready jobs and dispatches them with a warning instead of always breaking on empty batches. Unexpected rejections from `executeJobOnce` are now logged instead of being silently swallowed (#225, #226).

---

## [v0.6.2] — Run Directory Expression (2026-07-14)

### DSL

- [DSL] Add `${{ run.dir }}` expression resolving to the absolute path of the current run directory, usable in `workspace.directory` and step-level `cwd` fields (#221, #224).

---

## [v0.6.1] — Prompt Debugging Flags (2026-07-14)

### CLI

- [CLI] Add `--pause-before <job.step>` flag to `invoke`: pauses execution before the specified agent step, saves the prompt, and sets the run to `blocked` (#222, #223).
- [CLI] Add `--stop-after <job.step>` flag to `invoke`: stops execution after the specified step completes (#223).
- [CLI] Add `--save-all-prompts` flag to `invoke`: saves every agent prompt to the run artifact directory without pausing execution (#223).

### Runtime

- [runtime] Add `execution_paused` and `execution_stopped` event types to the event log for debugging checkpoints (#223).

---

## [v0.6.0] — CLI Convergence & Deprecation Sweep (2026-07-14)

### CLI

- [CLI] [breaking] Converge workflow lifecycle into `invoke <workflow>` (create + execute) and `inspect [run-id]` (all inspection views). Old `run`, `run-all`, `prompt`, `step`, `next`, `check` commands deprecated (#204).
- [CLI] Add `resume [run-id] --job <id> --input key=value` command: replaces `approve`/`reject` for human step interaction with structured key-value input (#210).
- [CLI] Remove `active_run` from `.zigma-flow/config.json`; all run-targeting now uses explicit `--run <id>` or `--latest` (#205).

### DSL

- [DSL] [breaking] Deprecate mutable shared context (`variables`, `context_blocks`, `context_patches`); prefer job outputs and `${{ jobs.<id>.outputs.<key> }}` (#206).
- [DSL] [breaking] Deprecate overlapping control flow mechanisms; converge to DAG `needs:` + `returns`/`on_return` (#209).
- [DSL] [breaking] Deprecate unimplemented fields, simplify permissions and workspace schema (#212).
- [DSL] Simplify skill discovery; deprecate `skill-lock.json` and `config_version` field (#207).
- [DSL] Make `step.on` optional; promote `inputs` to top-level workflow field (#211).

### Runtime

- [runtime] Unify deprecation warning utility for CLI and workflow-level deprecations.

---

## [v0.5.0] — Host Integration (2026-07-14)

### Runtime

- [runtime] Add Host API TypeScript interfaces (`HostContext`, `HostPermissions`, `HostEvent`) for embedding zigma-flow in host applications (#201).
- [runtime] Add caller context and permission snapshot attached to each run, enabling host-level access control (#202).
- [runtime] Add human gate remote channel and evidence export: human steps can receive structured input from external systems and export evidence artifacts (#203).

---

## [v0.4.6] — Workspace & Built-in Workflows (2026-07-13)

### Runtime

- [runtime] Add built-in GitHub and git worktree workflow definitions for fetch issue, publish PR, comment, close-and-merge, and worktree lifecycle operations (#176, #180).
- [runtime] Add job-level workspace directory resolution with expression support for script, check, and router steps (#181).
- [runtime] Add traverse/fan-out workflow execution support with audit events and schema coverage (#182).

### CLI

- [CLI] Add `--cwd` support with validation and command wiring for running workflows from an explicit working directory (#177, #183).

### Tests

- [tests] Add regression coverage for built-in workflows, workspace resolution, traverse schema, traverse execution, and CLI `--cwd` handling (#180, #181, #182, #183).

---

## [v0.4.5] — On-Output Routing & Report Hardening (2026-07-12)

### Runtime

- [runtime] Add `on_output` routing: validate agent output values and conditionally activate downstream jobs based on output content (#172, #173).
- [runtime] Validate required artifacts and typed outputs in the agent report acceptance path (#170).
- [runtime] Add non-interactive environment setup and dependency install step for script gates (#171).

---

## [v0.4.3] — Template Expressions & CLI Flags (2026-07-10)

### Runtime

- [runtime] Resolve `${{ }}` template expressions in script step `run:` and `cwd:` fields (#164).
- [runtime] Resolve template expressions in check step `with:` fields (#169).
- [runtime] Report all validation errors in `report.json` at once instead of stopping on the first (#168).

### CLI

- [CLI] Add `--run <run_id>` flag to `next`, `step`, `prompt`, `abort`, `retry` commands for explicit run targeting (#166).
- [CLI] Add `--input key=value` flag to `run` and `run-all` commands for named workflow inputs (#167).

---

## [v0.4.2] — Windows CLI Fix (2026-07-09)

### CLI

- [CLI] Fix silent exit on Windows/pnpm: resolve junction paths via `realpathSync` before comparing entry point URLs in ESM entry guard (#159).

### Build

- [CLI] Inject package version at build time via esbuild `define` instead of hardcoding `0.1.0` (#159).

## [v0.4.1] — Package Rename & CD (2026-07-09)

### Project

- [breaking] Package renamed from `@zigma/zigma-flow` to `@zigma-ai/zigma-flow` (#158).
- [CLI] Add npm Trusted Publisher OIDC auto-publish to CD workflow (release.yml).

## [v0.4.0] — Productization (2026-07-09)

### CLI

- [CLI] `zigma-flow init` detects project package manager (pnpm/npm/yarn/bun) and available scripts, generating tailored workflow YAML with correct commands (#97, #158).
- [CLI] `zigma-flow init` produces agent steps instead of failing script steps when no typecheck/lint/test scripts are found (#158).
- [CLI] `zigma-flow init` adds a build job to the workflow DAG when the project has a build script (#158).
- [CLI] New `zigma-flow doctor` command for environment and configuration diagnostics: Node.js version, config.json, skill-lock.json, workflow YAML, and skill pack validation (#97, #158).

### Error Handling

- [CLI] [breaking] Stabilize exit code taxonomy: 13 unique codes (2-30 range) replacing the collapsed 1/3 scheme. See `docs/error-codes.md` (#158).
- [CLI] Structured error output via `formatError()` with kind, exit code, and optional context fields (Run, Job, Step, Artifact, Suggestion) (#158).

### Documentation

- [docs] `examples/basic-code-change/` — 19-file runnable TypeScript project demonstrating zigma-flow workflow structure (#158).
- [docs] Rewritten README Quick Start with 7 copy-pasteable steps for new users (#158).
- [docs] `docs/error-codes.md` — stable error code reference (#158).
- [docs] `docs/release-checklist.md` — 7-step release process (#158).

### Project

- [breaking] Package renamed to `@zigma/zigma-flow`; license set to Apache 2.0; removed `private: true` (#158).
- [docs] CHANGELOG catch-up: v0.2.2 through v0.3.6 entries added with classification tags (#158).

## [v0.3.6] — Script On-Failure Goto (2026-07-08)

### Engine

- [runtime] Support `goto_step` in `on_failure` handler for script steps, enabling failure recovery flows within the same job.
- [runtime] Finalize source job after delegation in `on_failure` handler to prevent orphaned job state (#156, #157).

## [v0.3.5] — Upstream Failure Propagation & Force Retry (2026-07-08)

*Includes changes originally intended for v0.3.4 (git tag not created; commits folded into this release).*

### Engine

- [runtime] [breaking] Block downstream waiting jobs when upstream dependency fails, preventing cascading hangs across the DAG (#150, #151).
- [runtime] Add `--force` flag to retry command for blocked jobs, allowing manual unblock of stuck workflows (#154).
- [tests] Stabilize T-CANCEL-2 test -- extend accepted terminal statuses to cover completion edge cases (#150).

### Tests

- [tests] Commit golden prompt snapshots to main branch for deterministic prompt diffing.
- [tests] Add `.gitattributes` to enforce LF line endings for vitest snapshot files on Windows.
- [tests] Restore prompt golden snapshots after inadvertent deletion.

## [v0.3.4] — Tag Not Created (2026-07-08)

**Note:** The v0.3.4 git tag was not created. All changes intended for this version are documented under v0.3.5 above.

- [runtime] Upstream failure propagation, cancel test stabilization, and `--force` retry flag (see v0.3.5 for details).

## [v0.3.3] — Engine Step Lifecycle Fix (2026-07-07)

### Engine

- [runtime] Advance agent step unconditionally after report is accepted, fixing a state machine progression bug where the step would not advance on certain report paths (#147, #148).

## [v0.3.2] — CLI & Backend Registration Fixes (2026-07-07)

### CLI

- [CLI] Resolve workflow short name in `run-all` command, fixing workflow selection by alias (#141, #143).
- [CLI] Surface skill resolution errors and add `skill add` command for managing skill packs (#142, #145).

### Runtime

- [runtime] Register custom agent backends loaded from configuration, enabling third-party backend plugins (#139, #140).
- [runtime] Add environment variable interpolation in agent backend command configuration (#139, #140).

## [v0.3.1] — Gitignore Fix (2026-07-06)

### Runtime

- [runtime] Add `.turbo/` to `.gitignore` to prevent submodule conflicts in monorepo setups (#137).

## [v0.3.0] — DSL Specification & Dogfood Workflows (2026-07-06)

### DSL

- [DSL] Publish `docs/workflow-language.md` -- formal language specification with field-level stability annotations.
- [DSL] Add stability annotations to the Zod workflow schema; audit stable-field coverage across all definitions (#113).
- [DSL] Document `context_patches` specification and add reserved-field contract tests preventing state machine field tampering (#115).
- [DSL] Add forbidden-expression validator with comprehensive error-path tests (#119).
- [DSL] Add `bugfix.yml` workflow -- 8-stage bug fix pipeline with review gates and validation steps (#125).
- [DSL] Add `release-candidate.yml` workflow for controlled RC promotion (#127, #130).
- [DSL] Add `docs-change.yml` workflow for documentation-only change requests (#128, #132).
- [DSL] Add `design-review.yml` workflow for design proposal review cycles (#129, #133).

### Docs

- [docs] Add `docs/compatibility.md` and `docs/migration.md` documenting version policy, stability levels, and upgrade paths (#120).
- [docs] Add experimental field breaking-change risk notices across the language specification (#123).
- [docs] Standardize dogfood report format with runbooks and report templates (#134).

## [v0.2.2] — Runtime Reliability & Prompt Hardening (2026-07-03)

### Runtime

- [runtime] Verify-run command for run state validation, inconsistency detection, and diagnostics reporting.
- [runtime] Human gate contract: formalize gate step lifecycle, approval flow, and timeout handling.
- [runtime] Consolidate flaky test fixes across the engine test suite for improved CI stability.
- [runtime] Prompt engineering hardening (Issues #100-#108): standardized agent prompts, structured output contracts, and improved token efficiency.

### Docs

- [docs] Add user documentation covering runtime reliability features: verify-run, diagnostics, human gate.

## [v0.2.1] — CI Release Workflow (2026-06-29)

### CI

- [tests] Add GitHub release workflow for automated npm publishing on tag push.
- [tests] Enable npm publishing configuration in package metadata.

---

## [v0.2.0] — P14 Concurrent Read-Only Job Execution (2026-06-28)

### Scheduler

- **`selectExecutable` pure function** (`src/engine/scheduler.ts`): scheduler accepts `RunState`, `WorkflowDefinition`, and `SchedulerConfig`; returns an `ExecutableBatch` with `jobs` array and `rationale` string. No IO, no async.
- **Scheduling rules**: read-only jobs run concurrently up to `parallelism`; writable jobs are strictly serialized (at most 1 per batch). A writable lock blocks further writable jobs until the running writable completes.
- **Workspace mode derivation**: `workspace.mode: "read-only"` is the sole indicator for concurrency eligibility; all other values (including `undefined` and `"writable"`) are treated as writable and serialized.

### AsyncQueue — Per-runDir Write Serialization

- **`AsyncQueue`** (`src/run/asyncQueue.ts`): FIFO serial execution queue. `run<T>(fn: () => Promise<T>): Promise<T>` — functions execute one at a time; errors propagate but do not prevent subsequent tasks.
- **`LocalStateStore.writeSnapshot`** now wraps writes through a per-runDir AsyncQueue, eliminating concurrent-write race conditions.
- **`JsonlEventWriter.appendEvent`** now wraps appends through a per-runDir AsyncQueue, ensuring events are appended in call order with no line interleaving.

### Concurrent Batch Loop

- **`runAll` main loop refactored** (`src/engine/runAll.ts`): from sequential (one job per iteration) to scheduler-driven concurrent batch execution using `Promise.allSettled`.
- **`--parallelism N` CLI flag** (default 4): maximum concurrent jobs in a batch.
- **`--fail-fast` CLI flag** (default false): when enabled, a single job failure aborts all peer jobs in the same batch.
- **`batch_id` on events**: each scheduling batch generates a UUID; all events emitted during the batch carry `batch_id` in their payload for grouping.
- **`updateState` atomic read-modify-write**: `StateStore` now exposes `updateState(runDir, fn)` which performs atomic read-modify-write within the AsyncQueue.
- **`parallelism` agent config**: `AgentConfig.parallelism` can be set in `.zigma-flow/config.json` under `agent.parallelism`. A `getParallelism()` helper resolves the effective value.

### Documentation

- `docs/architecture.md` §7.4: Concurrency Model — scheduler pure function, AsyncQueue serialization, batch loop, fail-fast, event ordering.
- `README.md`: "并发执行" section with `--parallelism`, `--fail-fast` usage, and batch loop description.
- `CHANGELOG.md`: this section.

### Test Coverage

- 8 new test files for scheduler, AsyncQueue, concurrent state store, concurrent event writer, and concurrent runAll.
- Total test suite: ~740+ tests across 69+ test files.
- Pre-existing 714 tests: zero regressions.

## [v0.2.0] — P13a Agent Adapter Hardening (2026-06-28)

### Engine — runAll Loop

- **Extracted `runAll` engine entry** (`src/engine/runAll.ts`): the main execution loop is now a standalone function callable without CLI dependencies. `commands/run-all.ts` is a thin CLI shell (~100 lines).
- **Event ID sequencing** (`src/events/sequence.ts`): `nextSequentialEventId(runDir)` reads `events.jsonl` to determine the next sequential event ID, replacing scattered manual `parseInt(lastId.replace(...))` calls in the engine.

### Agent Lifecycle Events

- **5 new event types** in `src/events/eventTypes.ts`: `agent_invoked`, `agent_completed`, `agent_timed_out`, `agent_failed`, `agent_cancelled`.
- Every agent backend invocation is bracketed by an `agent_invoked` → terminal event pair, making backend behavior independently auditable from `events.jsonl`.

### Backend Artifacts

- **Stdout/stderr written to files**: `ClaudeCodeBackend.execute` writes `agent.stdout.log`, `agent.stderr.log`, and `agent.invocation.json` to the step artifact directory. Error messages no longer embed truncated stdout/stderr strings.
- **Artifact registration**: `runAll` registers these files as artifacts (`kind=agent_stdout`, `agent_stderr`, `agent_invocation`) in `artifacts.jsonl`.

### Retry on Failure

- **`recordAgentFailure`** (`src/engine/recordAgentFailure.ts`): agent failures now follow the job's `retry` configuration (attempt+1) instead of directly failing the run.
- **ConfigError/PermissionError bypass**: backend-not-found, not-logged-in, and similar configuration errors skip retry and fail the run immediately with exit code 4.

### Resume and Cancel

- **`--resume <run-id>`**: resumes an interrupted run from its last state. Mutually exclusive with `--task`.
- **AbortSignal propagation**: `runAll` accepts an `AbortSignal`; the CLI wires SIGINT to abort. On cancel, the Engine writes `agent_cancelled` + `run_cancelled` events and sets `state.status=cancelled`.

### Backend Configuration

- **Config module** (`src/agent/config.ts`): `loadAgentConfig`, `resolveBackendForStep`, `createBackend` extracted from the CLI for reuse.
- **Error classification**: `ClaudeCodeBackend` classifies command-not-found, not-logged-in, and rate-limited errors for appropriate retry/skip decisions.

### Documentation

- `docs/architecture.md` §11.1: Agent Backend Lifecycle section.
- `README.md`: `run-all --resume` usage and `.zigma-flow/config.json` agent backend example.
- `CHANGELOG.md`: this file.

### Test Coverage

- 77 new test cases across 7 new test files.
- Total test suite: 556 tests, 46 test files, zero regressions.

## [v0.2.0] — P13b Agent-Driven Flow Control (2026-06-28)

### Step Structured Return Status (AD-P13-009)

- **`applyStatusReturn`** (`src/engine/applyStatusReturn.ts`): new Engine entry that translates Agent `report.status` into `on_return` routing actions.
- **Workflow schema**: `step.returns` (status values + required flag) and `step.on_return` (status → action mappings).
- **Event**: `step_returned` (payload: `job_id`, `step_id`, `status`, `mapped_action`).
- **Pipeline**: status is processed after context_patches but before signals (AD-P13-013); status-triggered actions take priority over signals.

### Workflow Variables & Context Blocks (AD-P13-010, AD-P13-011)

- **Variables namespace** (`workflow.variables`): type-declared variables with `initial` values and `allowed_writers`. Agent can modify via `context_patches`. Stored in `state.json` `variables` segment.
- **Context blocks namespace** (`workflow.context_blocks`): versioned document artifacts (`context-blocks/<id>/v<N>.md`) that agents can write through patches. Old versions preserved.
- **`applyContextPatch`** (`src/engine/applyContextPatch.ts`): batch-atomic engine entry. Pre-validates all patches before writing; any failure rolls back the entire batch.
- **Permission model**: step permissions expand with `variables.read/write`, `context_edit` (none|read|write), `context_blocks.read/write` — independent of file `edits` permission.
- **Reserved field protection**: patch operations rejected if they touch state machine fields.
- **Events**: `variable_set`, `variable_deleted`, `context_block_updated`, `context_block_deleted`.
- **Context Builder**: variables and context blocks injected into Agent prompt, filtered by step read permissions.

### Expression Resolver Expansion

- **`${{ variables.<name> }}`**: resolve workflow variable values.
- **`${{ steps.<id>.outputs.<key> }}`**: resolve step outputs within the same job (清偿 TD-P9-002).
- **`${{ jobs.<id>.outputs.<key> }}`**: resolve cross-job outputs (清偿 TD-P9-001).
- **`evaluateCondition(expr, ctx)`**: boolean expression evaluator supporting `==`, `!=`, `&&`, `||`, `!`, parentheses. No `eval()`.

### Conditions, Goto, and Bounded Loops (AD-P13-012)

- **Step `if:`**: condition evaluated before step start; false → step skipped with `step_skipped` event.
- **Router `goto_step`**: same-job step redirection with `step_revisited` event; cross-job rejected at load time.
- **`max_visits`**: per-step visit limit (default 3). Exceeded → step + job blocked with `step_visit_exceeded` event.
- **Visit counting**: `JobState.step_visits`; skipped steps don't increment; retryJob resets.
- **Events**: `step_skipped`, `step_revisited`, `step_visit_exceeded`.

### Test Coverage

- 159 new test cases across 17 new test files.
- Total test suite: 714 tests, 61 test files.
- Pre-existing 556 tests: zero regressions.
