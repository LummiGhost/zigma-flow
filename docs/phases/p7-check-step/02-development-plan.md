---
phase: p7-check-step
status: frozen
date: 2026-06-09
authority: docs/prd.md §20 (FR-008), docs/architecture.md §6–§7, §9.4, §12.3, §16, docs/mvp-contracts.md §2.8, §6, §7
---

# P7 Development Plan — Check Step

## 1. Phase Goal

Enable `zigma-flow step --job <job-id>` to execute a `check` step, run deterministic
gate logic (file-exists, JSON validity, JSON Schema, required fields, git diff, forbidden paths,
protected runtime files) without LLM Judge, persist a `CheckResult` artifact,
emit the `step_started` / `check_completed` / `step_completed` (or `step_failed`) event
sequence, and advance job state `ready → running → completed | failed`.

Partially pays off TD-P6-001 (check step type in `executeCurrentStep`).

Architecture §13 phase 7 verification target:
> 基础 gate 不依赖 LLM；禁止路径修改失败；只读 step 修改文件失败。

## 2. Milestones

| ID | Milestone | Acceptance condition |
|---|---|---|
| MS-P7-1 | User can execute check steps via `zigma-flow step --job` | Integration test: `step` on a check-type step → job status `completed` or `failed` with check-result artifact |
| MS-P7-2 | 7 built-in check kinds operational | Unit tests: file-exists, json-parse, json-schema, required-fields, git-diff-exists, forbidden-paths, protected-runtime-files each have pass/fail cases |
| MS-P7-3 | Git-based checks produce correct results | Integration test with temp git repo: diff-exists and forbidden-paths correctly detect file changes |

## 3. Scope

**In scope:**
- `executeCurrentStep` extended to handle `check` step type (`src/engine/index.ts`)
- `CheckResult` type: `{ passed, check_id, failures, artifacts }` (`src/check/index.ts`)
- Check step executor pipeline: kind dispatch → check function → CheckResult → artifact write → events → Engine state transition (`src/check/executor.ts`)
- `on_pass` and `on_fail` router action fields added to step schema (`src/workflow/index.ts`)
- Built-in check implementations (7 kinds):
  - `file-exists`: assert file path exists on disk
  - `json-parse`: assert file content is valid JSON
  - `json-schema`: validate JSON content against a JSON Schema (ajv)
  - `required-fields`: assert specified fields are present and non-empty in a JSON file
  - `git-diff-exists`: assert the working tree has uncommitted changes
  - `forbidden-paths`: assert changed files do not match a forbidden path policy
  - `protected-runtime-files`: assert `.zigma-flow/runs/*/state.json` and `events.jsonl` were not touched
- `GitInspector` port interface + `SimpleGitInspector` adapter (`src/git/index.ts`)
- `CheckError` class and `PermissionError` class in `src/utils/errors.ts` (both exit code 1)
- `check_completed` event payload bound (`src/events/index.ts`)
- `simple-git` and `ajv` added to dependencies
- Tests: `tests/check/executor.test.ts`, `tests/check/checks.test.ts`, `tests/git/inspector.test.ts`

**Out of scope (P7):**
- Router step execution (P8)
- `on_fail: retry_job / activate_job / goto_job` processing by Engine (P8) → TD-P7-001
- Multi-step job: `current_step` pointer advancement (P8) → TD-P6-004 carry
- `check` step `uses` referencing a Skill Pack check (Skill Pack integration for check steps) → TD-P7-002
- Read-only workspace modification detection via Workspace Guard (P8) → TD-P7-003
- TD-P5-003 (report schema rendering in prompt) — deferred to P8 unless explicitly requested

## 4. Workflow Breakdown

Three workflows; WF-P7-CHECK must complete before WF-P7-FILECHECK and WF-P7-GITCHECK.
WF-P7-FILECHECK and WF-P7-GITCHECK can proceed in parallel after WF-P7-CHECK.

### WF-P7-CHECK — Check Runner Foundation

**Goal:** Executor infrastructure for check steps: `CheckResult` schema, step dispatcher,
artifact write, Engine dispatch, `on_pass`/`on_fail` gate handling.

**Boundary:** Does NOT implement specific check kinds — those are WF-P7-FILECHECK and
WF-P7-GITCHECK concerns. This workflow owns the executor scaffolding and Engine wiring only.

**Functional points:**
- `CheckResult` type: `{ passed: boolean, check_id: string, failures: string[], artifacts: string[] }`
- `executeCheckStep(opts)` orchestration function in `src/check/executor.ts`:
  - Reads current state; emits `step_started`; transitions job `ready → running`
  - Dispatches to registered check kind by name (returns CheckResult)
  - Writes `check-result.json` artifact (producer: "check-executor")
  - Emits `check_completed` event
  - Applies `on_pass` / `on_fail` gate:
    - passed: `step_completed` → job `running → completed` → `job_completed`
    - failed: `step_failed` → job `running → failed` (respects `on_fail` override)
  - Writes state snapshot atomically after final event
- `executeCurrentStep` in `src/engine/index.ts` dispatches to `executeCheckStep` for `type: "check"`
- Step schema: `on_pass?: RouterAction`, `on_fail?: RouterAction` added to `StepBaseSchema`
- `CheckError` (exit code 1) and `PermissionError` (exit code 1) in `src/utils/errors.ts`

**Deliverables:**
- `src/check/executor.ts` — `executeCheckStep(opts)` + kind registry interface
- `src/check/index.ts` — `CheckResult` type, `CheckRunner` interface, `registerBuiltinChecks()` hook
- `src/engine/index.ts` — dispatch to `executeCheckStep` for check steps
- `src/workflow/index.ts` — `on_pass` and `on_fail` fields added to `StepBaseSchema`
- `src/utils/errors.ts` — `CheckError` and `PermissionError` classes
- `tests/check/executor.test.ts` — executor tests (pass/fail, artifact, events)

**Test IDs:** T-CHECK-1 (step_started + check_completed + step_completed sequence), T-CHECK-2 (check failed → step_failed → job failed), T-CHECK-3 (check-result.json artifact present), T-CHECK-4 (on_fail: status failed override), T-CHECK-5 (unknown check kind → CheckError)

### WF-P7-FILECHECK — Built-in File and JSON Checks

**Goal:** Implement the four file/JSON check kinds: file-exists, json-parse, json-schema, required-fields.

**Boundary:** Pure check logic; no state mutation, no event emission. Each check receives
structured `with` arguments and returns a `CheckResult`. Check runner (WF-P7-CHECK) handles events.

**Functional points:**
- `file-exists` kind: accepts `{ file: string }` or `{ files: string[] }`; fails with list of missing paths
- `json-parse` kind: accepts `{ file: string }`; fails with parse error location if not valid JSON
- `json-schema` kind: accepts `{ file: string, schema: string }` (schema is a path to a JSON Schema file); uses `ajv`; fails with field-level validation errors
- `required-fields` kind: accepts `{ file: string, fields: string[] }`; fails listing missing or empty fields
- All kinds: return `CheckResult` with `passed`, `check_id`, `failures` (human-readable strings), `artifacts` (empty for pure logic checks)
- `ajv` dependency added for json-schema kind

**Deliverables:**
- `src/check/checks/file-exists.ts`
- `src/check/checks/json-parse.ts`
- `src/check/checks/json-schema.ts`
- `src/check/checks/required-fields.ts`
- `src/check/index.ts` — updated to register and export all four kinds
- `package.json` — `ajv` dependency added
- `tests/check/checks.test.ts` — fixture-based tests for all four kinds

**Test IDs:** T-FC-1 (file-exists pass), T-FC-2 (file-exists fail — missing file), T-FC-3 (json-parse pass), T-FC-4 (json-parse fail — parse error), T-FC-5 (json-schema pass), T-FC-6 (json-schema fail — field error), T-FC-7 (required-fields pass), T-FC-8 (required-fields fail — missing field)

### WF-P7-GITCHECK — Git and Path Checks

**Goal:** Implement `GitInspector` port + `SimpleGitInspector` adapter; implement three
git/path check kinds: git-diff-exists, forbidden-paths, protected-runtime-files.

**Boundary:** `GitInspector` is a pure port; the adapter wraps `simple-git`.
Check kinds receive structured `with` arguments and return `CheckResult`.
No state mutation, no event emission.

**Functional points:**
- `GitInspector` port interface in `src/git/index.ts`: `changedFiles(cwd): Promise<string[]>`, `diffExists(cwd): Promise<boolean>`
- `SimpleGitInspector` adapter in `src/git/index.ts` wraps `simple-git`
- `git-diff-exists` kind: accepts `{ cwd?: string }`; fails if diff is empty, passes if changes exist
- `forbidden-paths` kind: accepts `{ cwd?: string, paths: string[] }` where `paths` is a list of glob patterns; fails listing the changed files that match any pattern
- `protected-runtime-files` kind: accepts `{ cwd?: string, run_dir?: string }`; fails if any changed file matches `.zigma-flow/runs/*/state.json` or `.zigma-flow/runs/*/events.jsonl`
- All kinds: accept optional `GitInspector` injection for testing; default to `SimpleGitInspector`
- `simple-git` dependency added

**Deliverables:**
- `src/git/index.ts` — `GitInspector` port interface, `SimpleGitInspector` adapter
- `src/check/checks/git-diff-exists.ts`
- `src/check/checks/forbidden-paths.ts`
- `src/check/checks/protected-runtime-files.ts`
- `src/check/index.ts` — updated to register all three git/path kinds
- `package.json` — `simple-git` dependency added
- `tests/git/inspector.test.ts` — simple-git adapter integration test (temp git repo)
- `tests/check/git-checks.test.ts` — unit tests with FakeGitInspector + integration tests

**Test IDs:** T-GC-1 (git-diff-exists: no diff → fail), T-GC-2 (git-diff-exists: diff present → pass), T-GC-3 (forbidden-paths: no match → pass), T-GC-4 (forbidden-paths: match → fail with matched files), T-GC-5 (protected-runtime: state.json not changed → pass), T-GC-6 (protected-runtime: state.json changed → fail), T-GC-7 (inspector: changedFiles returns staged + unstaged)

## 5. Technical Decisions

### D1 — check_completed event payload
```typescript
export interface CheckCompletedPayload {
  job_id: string;
  step_id: string;
  check_id: string;
  passed: boolean;
  attempt: number;
}
```
Mirrors `ScriptCompletedPayload` pattern from P6.

### D2 — Kind dispatch registry
Check kinds are registered at module load time in a `Map<string, CheckFn>`.
`executeCheckStep` looks up the kind from the resolved step definition; throws `CheckError` if not found.
This avoids conditional chains and makes adding new kinds trivial.

### D3 — CheckResult artifact path
```
<runDir>/jobs/<jobId>/<attempt>/steps/<stepId>/check-result.json
```
Artifact metadata: `kind: "check-result"`, `content_type: "application/json"`.

### D4 — on_pass / on_fail schema
`on_pass` and `on_fail` use the same `RouterActionSchema` already defined in `src/workflow/index.ts`.
For check steps, `on_pass` defaults to `{ action: "continue" }` and `on_fail` defaults to `{ status: "failed" }`.
MVP P7 only processes `{ status: "failed" }` and `{ continue: true }` forms in the Engine.
Retry/activate forms are registered as TD-P7-001.

### D5 — ajv version and JSON Schema draft
Use `ajv@8` (JSON Schema draft-07/2019-09). Single compiled validator instance per check invocation.
Schema file is read from disk; `ajv.compile(schema)` is called per check to avoid caching complexity in MVP.

### D6 — simple-git usage
`simple-git` v3.x. `GitInspector.changedFiles()` returns a flat list of all modified paths
(staged + unstaged + untracked). `GitInspector.diffExists()` returns true if `changedFiles()` is non-empty.
GitInspector is an injectable port so tests can use a `FakeGitInspector`.

### D7 — check step kind resolution
In P7, the step `uses` field is resolved to a kind string using a simplified scheme:
- `uses: "zigma/<kind>"` → built-in kind (e.g., `uses: "zigma/file-exists"`)
- `uses: "<skill-alias>.checks.<id>"` → Skill Pack check resolution (TD-P7-002; deferred)
For testing the 7 built-in kinds without Skill Pack resolution, the test fixtures use `uses: "zigma/<kind>"` directly.

### D8 — Architecture compliance
`src/check/executor.ts` imports `GitInspector` interface (port), NOT `SimpleGitInspector` (adapter).
`src/engine/index.ts` calls `executeCheckStep`; does NOT import `simple-git` or `ajv`.
Check kinds receive their arguments from the resolved step `with` fields.
Engine is sole writer of state transitions (same pattern as P6).

### D9 — CheckError and PermissionError exit codes
Both use exit code 1 per mvp-contracts §7.
`CheckError`: check execution failure or unknown kind.
`PermissionError`: protected file accessed or read-only workspace modified.

## 6. Event Sequence (Check Step Execution)

```
1. step_started        { job_id, step_id, attempt }
2. <check function runs>
3. check_completed     { job_id, step_id, check_id, passed, attempt }
4a. step_completed     { job_id, step_id, attempt }  ← on_pass resolves to continue
4b. step_failed        { job_id, step_id, attempt, reason }  ← on_fail resolves to failed
5. job_completed       { job_id, attempt }  ← when job has no remaining steps (P6 pattern)
```

State snapshot is written once after the final event.

## 7. Module Boundaries

```
src/commands/step.ts      ← existing CLI handler; calls executeCurrentStep (extended in P7)
src/engine/index.ts       ← executeCurrentStep; adds dispatch for "check" step type
src/check/executor.ts     ← executeCheckStep orchestration (CheckRunner → artifact → events)
src/check/index.ts        ← CheckResult type, CheckRunner interface, kind registry
src/check/checks/         ← individual check kind implementations (pure functions)
src/git/index.ts          ← GitInspector port + SimpleGitInspector adapter
src/workflow/index.ts     ← on_pass, on_fail added to StepBaseSchema
src/utils/errors.ts       ← CheckError, PermissionError additions
```

`src/check/executor.ts` may import from `../check/index.js`, `../run/index.js`, `../events/index.js`, `../artifact/index.js`.

`src/check/checks/*.ts` may import `GitInspector` interface from `../git/index.js` and `ajv` for json-schema.

`src/engine/index.ts` imports `executeCheckStep` from `../check/executor.js` (as it imports `executeScriptStep` from `../script/executor.js`).

`src/engine/index.ts` does NOT directly import `simple-git`, `ajv`, or concrete check implementations.

## 8. Tech Debt Registrations

| ID | Spec reference | Description | Deferred to |
|---|---|---|---|
| TD-P7-001 | prd FR-008, mvp-contracts §2.8 | `on_fail` forms `retry_job`, `activate_job`, `goto_job` not processed by Engine | P8 |
| TD-P7-002 | prd §11, mvp-contracts §2.2 | Skill Pack check resolution: `uses: "<skill-alias>.checks.<id>"` | P8 |
| TD-P7-003 | arch §11, mvp-contracts §2.8 | Read-only workspace modification detection via Workspace Guard (requires workspace.ts integration) | P8 |
| TD-P6-004 | arch §7.2 | Multi-step job `current_step` pointer not advanced (carry from P6) | P8 |
| TD-P5-003 | prd FR-006 | Report schema rendering in prompt Output section (carry from P5) | P8 |

## 9. Quality Gate

```
pnpm typecheck && pnpm lint && pnpm test
```

Baseline: 235/235 tests pass (P6 gate). Gate target: all existing + new P7 tests pass.
0 typecheck errors, 0 lint warnings.

New tests expected: ~30–40 net new test cases across executor, checks, and git inspector.

## 10. Workflow Status

| Workflow | Status |
|---|---|
| WF-P7-CHECK | planned |
| WF-P7-FILECHECK | planned |
| WF-P7-GITCHECK | planned |
