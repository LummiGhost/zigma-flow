---
phase: p6-script-step
status: frozen
date: 2026-06-08
authority: docs/prd.md §20 (FR-007), docs/architecture.md §6–§7, §9.4, §12.3, docs/mvp-contracts.md §2.7, §6, §7
---

# P6 Development Plan — Script Step

## 1. Phase Goal

Enable `zigma-flow step --job <job-id>` to execute a `script` step inline or via Skill Pack,
capture stdout/stderr as artifacts, persist `ScriptResult`, emit the
`step_started` / `script_completed` / `step_completed` (or `step_failed`) event sequence,
and advance job state `ready → running → completed | failed`.

Architecture §13 phase 6 verification target:
> timeout、cwd、env、stdout/stderr 和 exit_code 都写入 artifact。

## 2. Milestones

| ID | Milestone | Acceptance condition |
|---|---|---|
| MS-P6-1 | User can run `zigma-flow step --job <job>` and execute a script step | Integration test: `step` on a valid script step workflow → job status `completed` |
| MS-P6-2 | ProcessRunner executes commands with timeout / cwd / env / capture | Unit tests: timeout kills process; stdout/stderr captured; exit_code returned |
| MS-P6-3 | ScriptResult persisted as artifact; events appended to events.jsonl | Integration test: events.jsonl contains `step_started` + `script_completed` + `step_completed`; stdout/stderr artifact files exist |

## 3. Scope

**In scope:**
- `zigma-flow step --job <job-id>` CLI command (`src/commands/step.ts`)
- `executeCurrentStep(runId, jobId)` Engine entry point — script steps only (`src/engine/index.ts`)
- `ProcessRunner` port interface + `ExecaProcessRunner` adapter (`src/script/index.ts`)
- Script step execution: inline `run` field and Skill Pack `uses` reference
- `timeout`, `cwd`, `env` options and `capture.stdout / capture.stderr`
- stdout / stderr written as artifacts (text/plain)
- `ScriptResult` JSON type (`{ exit_code, timed_out, stdout, stderr, started_at, ended_at }`)
- Events: `step_started`, `script_completed`, `step_completed` (success) / `step_failed` (failure)
- Job `job_completed` event for single-step completed job
- State transitions: job `ready → running → completed` or `ready → running → failed`
- `on_failure` — MVP supports only `status: failed` (literal or `{ status: "failed" }`)
- `ScriptError` class added to `src/utils/errors.ts` (exit code 1)
- `StepBaseSchema` extended with explicit `run`, `shell`, `timeout`, `cwd`, `env`, `on_failure` fields
- `execa@9` dependency installation

**Out of scope (P6):**
- Check step execution (P7)
- Router step execution (P8)
- `on_failure` object forms `retry_job`, `activate_job`, `goto_job` (P8) → TD-P6-002
- Multi-step job: advancing `current_step` pointer to next step after completion (P8) → TD-P6-004
- `executeCurrentStep` for check / router / human / workflow step types (P7/P8) → TD-P6-001
- TD-P5-003: report schema rendering in prompt Output section — deferred to P7

## 4. Workflow Breakdown

Three workflows. WF-P6-DISPATCH and WF-P6-RUNNER can proceed in parallel.
WF-P6-SCRIPT depends on both.

### WF-P6-DISPATCH — Step Command Dispatch

**Goal:** Wire `zigma-flow step --job` CLI through to `executeCurrentStep` Engine entry point.

**Boundary:** This workflow owns the CLI ↔ Engine boundary only. It does not own
ProcessRunner or artifact writing — those are WF-P6-RUNNER / WF-P6-SCRIPT concerns.

**Functional points:**
- Read active_run from config.json → ConfigError if absent
- Read state.json; validate job exists and is `ready` or `running` → StateError otherwise
- Load workflow YAML; select job by `--job`; auto-detect if single `ready` job
- Assert current step is a `script` step → WorkflowError if not (in P6 scope)
- Call `executeCurrentStep(runId, jobId)` and print result path

**Deliverables:**
- `src/commands/step.ts` — `stepAction(opts: StepActionOpts)`
- `src/engine/index.ts` — exports `executeCurrentStep(runId, jobId)` (signature; implementation wired in WF-P6-SCRIPT)
- `src/cli.ts` — `step` subcommand registration
- `src/commands/index.ts` — `export { stepAction }`
- `tests/commands/step.test.ts` — integration tests

**Test IDs:** T-DISPATCH-1 (happy path), T-DISPATCH-2 (no active run), T-DISPATCH-3 (non-script step), T-DISPATCH-4 (unknown job)

### WF-P6-RUNNER — Process Runner

**Goal:** Implement `ProcessRunner` port and `ExecaProcessRunner` adapter.

**Boundary:** Pure subprocess execution; no artifact writing, no event emission, no state mutation.

**Functional points:**
- `ProcessRunner` port interface defined in `src/script/index.ts`
- `ExecaProcessRunner` implements `ProcessRunner` using `execa`
- Supports `command`, `shell`, `cwd`, `env`, `timeoutMs`
- On timeout: sets `timedOut: true`, `exitCode: 124`, captures partial stdout/stderr
- On non-zero exit: sets `exitCode`, `timedOut: false`
- On process spawn error: throws `ScriptError`
- Returns raw stdout/stderr strings (not artifact refs — artifact writing is WF-P6-SCRIPT)

**Deliverables:**
- `src/script/index.ts` — `ProcessRunner` interface, `ExecaProcessRunner`, `ScriptRunResult` raw type
- `src/utils/errors.ts` — `ScriptError` class (exit code 1)
- `package.json` — `execa@9` in dependencies
- `tests/script/runner.test.ts` — unit + integration tests

**Test IDs:** T-RUNNER-1 (zero exit), T-RUNNER-2 (non-zero exit), T-RUNNER-3 (timeout), T-RUNNER-4 (custom cwd), T-RUNNER-5 (env injection), T-RUNNER-6 (spawn failure)

### WF-P6-SCRIPT — Script Step Behavior

**Goal:** Full script step execution pipeline: inline/Skill Pack → ProcessRunner → artifacts → events → Engine state transition → on_failure.

**Boundary:** This workflow owns the complete `executeCurrentStep` implementation for script steps
and the `step_started` / `script_completed` / `step_completed|failed` event sequence.

**Functional points:**
- `executeCurrentStep` resolves step definition (inline `run` or Skill Pack `uses`)
- Emits `step_started` event; transitions job `ready → running`
- Instantiates `ExecaProcessRunner`; calls `runner.run(opts)`
- Writes stdout and stderr as artifacts (text/plain, producer: "script-executor")
- Builds `ScriptResult`; writes to `<runDir>/jobs/<jobId>/steps/<stepId>/result.json`
- Emits `script_completed` event
- Applies `on_failure` logic:
  - exit_code=0 && !timed_out: `step_completed` event → job `running → completed` → `job_completed` event
  - otherwise: `step_failed` event → job `running → failed` (unless `on_failure` overrides)
- Writes state snapshot (atomic; uses `stateStore.writeSnapshot`)
- `StepBaseSchema` extended with explicit `run`, `shell`, `timeout`, `cwd`, `env`, `on_failure`

**Deliverables:**
- `src/script/executor.ts` — `executeScriptStep(opts)` orchestration function
- `src/engine/index.ts` — complete `executeCurrentStep` implementation calling `executeScriptStep`
- `src/workflow/index.ts` — `StepBaseSchema` + `StepDefinition` extended
- `tests/script/executor.test.ts` — integration tests

**Test IDs:** T-SCRIPT-1 (happy path: zero exit, artifacts), T-SCRIPT-2 (non-zero exit, on_failure: failed), T-SCRIPT-3 (timeout → step_failed), T-SCRIPT-4 (stdout/stderr artifact URIs), T-SCRIPT-5 (Skill Pack uses reference), T-SCRIPT-6 (state transition sequence), T-SCRIPT-7 (events.jsonl sequence)

## 5. Technical Decisions

### D1 — execa version
Use `execa@9`. ESM-native; API stable. `timeout` option in ms; on timeout `error.timedOut === true`.
`ExecaProcessRunner` maps timeout case to `exitCode: 124` (POSIX convention).

### D2 — StepBaseSchema extension strategy
Add explicit optional fields to `StepBaseSchema` in `src/workflow/index.ts`.
`StepDefinition` already has `[key: string]: unknown` — add typed named fields alongside.
New fields: `run?: string`, `shell?: string`, `timeout?: string`, `cwd?: string`,
`env?: Record<string, string>`, `on_failure?: RouterAction`.

### D3 — Timeout string parsing
Parse `"300s"` / `"5m"` / `"1h"` → ms in `executeScriptStep`. Format: `(\d+)(s|m|h)`. Default: no timeout (undefined). Invalid format → `WorkflowError` before execution.

### D4 — Artifact path for stdout/stderr
```
<runDir>/jobs/<jobId>/<attempt>/steps/<stepId>/stdout.txt
<runDir>/jobs/<jobId>/<attempt>/steps/<stepId>/stderr.txt
```
Artifact ref format: `artifact://runs/<runId>/jobs/<jobId>/<attempt>/steps/<stepId>/stdout.txt`

### D5 — executeCurrentStep signature
```typescript
export async function executeCurrentStep(opts: {
  runDir: string;
  zigmaflowDir: string;
  runId: string;
  jobId: string;
  runner?: ProcessRunner;  // injectable for tests
  clock: Clock;
}): Promise<void>
```
`runner` defaults to `new ExecaProcessRunner()`. CLI passes no `runner` (uses default).

### D6 — Architecture §5.2 compliance
`executeCurrentStep` is the only path that writes state transitions during step execution.
`stepAction` calls `executeCurrentStep` — it does not write state directly.
This satisfies architecture §5.2 (Engine owns state transitions) and resolves ADR-003 for the step command path.

### D7 — Skill Pack script resolution
P6 supports `uses: "<skill-alias>/<script-name>"` resolution from `skill-lock.json`.
The script entry point must be a local file path resolved relative to the project root.
If skill-lock.json does not contain the referenced script: `SkillPackError`.

## 6. Event Sequence (Step Execution)

```
1. step_started        { job_id, step_id, attempt }
2. <ProcessRunner executes>
3. script_completed    { job_id, step_id, exit_code, timed_out }
4a. step_completed     { job_id, step_id, attempt }  ← on success
4b. step_failed        { job_id, step_id, attempt, reason }  ← on failure
5. job_completed       { job_id, attempt }  ← P6: emitted when job has no remaining steps
```

State snapshot is written once after the final event in the sequence.

## 7. Module Boundaries

```
src/commands/step.ts      ← CLI handler; calls executeCurrentStep via Engine
src/engine/index.ts       ← executeCurrentStep; owns state transitions
src/script/index.ts       ← ProcessRunner port + ExecaProcessRunner adapter
src/script/executor.ts    ← executeScriptStep orchestration (Runner → artifacts → events)
src/workflow/index.ts     ← StepBaseSchema extension
src/utils/errors.ts       ← ScriptError addition
```

`src/script/executor.ts` imports `ProcessRunner` from `../script/index.js` and
`ArtifactStore`-family functions from `../artifacts/index.js` and
`JsonlEventWriter` / `LocalStateStore` from `../run/index.js`.

`src/script/index.ts` does NOT import `execa` at the port level —
`ExecaProcessRunner` (the adapter class in the same file) imports it.

## 8. Tech Debt Registrations

| ID | Spec reference | Description | Deferred to |
|---|---|---|---|
| TD-P6-001 | arch §7.1, §12.3 | `executeCurrentStep` handles only `script`; check/router/human/workflow step types not implemented | P7/P8 |
| TD-P6-002 | prd FR-007, mvp-contracts §2.7 | `on_failure` object forms `retry_job`, `activate_job`, `goto_job` not implemented | P8 |
| TD-P6-003 | arch §9.4 | stdout/stderr artifacts have no size limit; large output may exhaust disk | P9 |
| TD-P6-004 | arch §7.2 | Multi-step job: `current_step` pointer not advanced after step completion; WF-P6-SCRIPT only handles single-step jobs correctly | P8 |
| TD-P5-003 | prd FR-006 | Report schema rendering in prompt Output section | P7 |

## 9. Quality Gate

```
pnpm typecheck && pnpm lint && pnpm test
```

Baseline: 217/217 tests pass. Gate target: all existing tests + new P6 tests pass.
0 typecheck errors, 0 lint warnings.

## 10. Workflow Status

| Workflow | Status |
|---|---|
| WF-P6-DISPATCH | planned |
| WF-P6-RUNNER | planned |
| WF-P6-SCRIPT | planned |
