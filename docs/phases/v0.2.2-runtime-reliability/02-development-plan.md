---
phase: v0.2.2-runtime-reliability
title: Runtime Reliability Development Plan
status: frozen
date: 2026-07-01
authority: docs/prd.md §5 §13 §17 §22, docs/mvp-contracts.md §2.3 §2.4, docs/phases/p15-human-gate/02-development-plan.md
predecessor: v0.2.1 (CI green, 784 tests)
target-pr: feature/v0.2.2-runtime-reliability (single consolidated PR, or split by workflow if >2500 lines)
---

# v0.2.2 Runtime Reliability — Development Plan

## Objective

- **Business objective:** Make Zigma Flow trustworthy for regular dogfood use. Operators should be able to inspect run health, understand failures, and act on human gates without inspecting raw files.
- **Technical objective:** Add `verify-run` for run data integrity, improve CLI diagnostic output, lock down human gate semantics, and harden the test suite against flakiness.

## Scope

### In scope

1. **Test stability audit and fixes** — enumerate potential platform/flaky/timing issues in tests; fix or isolate any instability; document platform-specific vs all-platform test expectations.
2. **`zigma-flow verify-run [run-id]`** — new CLI command that reads state.json, events.jsonl, artifacts.jsonl and reports consistency errors with actionable output. Companion regression tests using corrupt-run fixtures.
3. **Human gate semantic tightening** — add `timeout_minutes` schema field (DSL reservation, no runtime enforcement in v0.2.2); clarify `approvers` semantics in code/docs; confirm and test downstream router behavior after approve/reject; add `human_decision_record` JSON schema validation.
4. **Diagnostic CLI experience** — `status --verbose` flag showing per-step detail; at least one event/artifact inspection capability (new subcommand or flag on existing commands); all runtime errors carry a suggested next-command.
5. **Dogfood runs** — two real dogfood runs on actual code changes; results documented in `verification-log.md`.

### Out of scope

- Docker sandbox, MCP runtime, remote approval channels (v0.3+).
- Timeout enforcement for human gates (DSL field only, no clock check in v0.2.2).
- Web UI / email / Slack approvals.
- Multi-approver voting / quorum.
- Full event sourcing replay.
- Automated PR creation or multi-agent orchestration.

## Milestones

| ID | Milestone | Exit criteria |
|---|---|---|
| M1 | Test stability audit complete | Flaky/platform tests documented; any identified issues fixed or isolation strategy committed. `pnpm test:ci` stable. |
| M2 | `verify-run` command shipped | Command detects state/event/artifact/job/step/context-block inconsistencies; corrupt-run fixture regression tests pass. |
| M3 | Human gate contract locked | `timeout_minutes` field in schema; approvers semantics documented; downstream router tests pass; human_decision_record validated. |
| M4 | Diagnostic CLI usable | `status --verbose` shows per-step detail; event/artifact inspection available; runtime errors suggest next action. |
| M5 | Dogfood runs documented | Two real dogfood run records in `verification-log.md`. |

## Technical Approach

### Architecture and module changes

- **New file:** `src/commands/verify-run.ts` — run consistency checker.
- **New file:** `src/commands/events.ts` — event tail / inspection command.
- **New file:** `src/commands/artifacts.ts` — artifact list command.
- **Modified:** `src/commands/status.ts` — add `--verbose` flag with per-step detail.
- **Modified:** `src/workflow/schema.ts` — add `timeout_minutes` to human step sub-schema.
- **Modified:** `src/cli.ts` — register new commands.
- **No engine changes.** All new work is in the CLI layer reading existing data.

### Invariant from architecture.md

Engine is the sole state writer. The new `verify-run` command is read-only: it reads state.json, events.jsonl, artifacts.jsonl and reports inconsistencies but does NOT repair them.

### Data/API changes

- Human step schema gains optional `timeout_minutes: number` field (≥1, integer). Validation error if non-integer or <1. No runtime enforcement in v0.2.2.
- `human_decision_record` artifact gains zod/ajv shape validation on read in `verify-run`.

### Testing strategy

- All new commands: unit tests for logic, integration tests for CLI invocation.
- Corrupt-run fixtures under `tests/fixtures/corrupt-runs/` — static JSONL/JSON files with specific corruption patterns.
- No new dogfood/process-spawning tests (the existing dogfood suite is the environment for M5).
- Existing 784 tests must not regress.

### Release / migration notes

- `verify-run` is a new command — additive, no breaking change.
- `timeout_minutes` schema field is optional — existing workflow YAML files continue to validate.
- `status --verbose` flag is new — default behavior of `status` is unchanged.
- Human decision artifact schema validation is read-side only — no re-writing of existing records.

## Workflow Breakdown

| Workflow | Goal | Dependencies | Acceptance criteria | Research needed |
|---|---|---|---|---|
| WF-V022-STABILITY | Test stability audit and fixes | None | All tests pass; platform-conditional tests documented; no silent skip | No |
| WF-V022-VERIFYRUN | `verify-run` command | None | Command detects 5+ corruption classes; corrupt-run fixture tests pass | No |
| WF-V022-HUMANGATE | Human gate semantic tightening | None | timeout_minutes in schema; approvers docs; router behavior tested; decision artifact validated | No |
| WF-V022-DIAGNOSTIC | Diagnostic CLI experience | WF-V022-VERIFYRUN (for command naming precedent) | status --verbose; events/artifacts inspection; runtime errors suggest next command | No |
| WF-V022-DOGFOOD | Dogfood run documentation | All above WFs complete | verification-log.md with 2 run records | No |

**Parallel execution:** WF-V022-STABILITY, WF-V022-VERIFYRUN, and WF-V022-HUMANGATE can run in parallel. WF-V022-DIAGNOSTIC should start after WF-V022-VERIFYRUN Step 1 to align on command naming conventions. WF-V022-DOGFOOD is last.

## Workflow Details

### WF-V022-STABILITY

**Scope:**
- Read all 69 test files; identify any test.skip, platform conditionals, hardcoded timeouts, or race-prone patterns.
- Fix any identified issues (e.g., missing temp-dir cleanup, path separator assumptions).
- Add a comment/doc block in vitest config or README explaining which tests are platform-specific and why.

**Key files to audit:**
- `tests/dogfood/code-change.test.ts`, `tests/dogfood/run-all-parallel.test.ts`
- `tests/engine/runAll-concurrent.test.ts`, `tests/engine/runAll-cancel.test.ts`
- `tests/init/init.test.ts` (has `process.platform === "win32"` branch)
- Any tests using `execa` directly or real git operations

**Acceptance:**
- `pnpm test:ci` passes 100% on main platform.
- All platform-conditional branches are documented with a comment explaining the platform difference.
- No test uses `setTimeout`/`sleep` without justification.

### WF-V022-VERIFYRUN

**Scope:** New `zigma-flow verify-run [run-id]` command.

**Consistency checks to implement:**
1. **State exists:** `state.json` is valid JSON and passes schema check.
2. **Event sequence:** `events.jsonl` has no gaps or duplicate IDs; `last_event_id` in state matches last event in log.
3. **Artifact index:** Every entry in `artifacts.jsonl` points to a file that exists on disk.
4. **Job attempt integrity:** Each job's `attempt` counter matches the number of attempt directories present.
5. **Step visit integrity:** Each step's visit count in state matches the number of `step_revisited` events for that step.
6. **Context block versions:** Each `context_block_updated` event has a corresponding file in the artifact store.

**Output format:**
```
Run: 20260701-0001
  [PASS] state.json valid
  [FAIL] artifacts.jsonl: artifact agent_stdout for step 'code-map' not found at jobs/code-map/attempts/1/steps/code-map/stdout.txt
  [PASS] event sequence consistent
  [WARN] job 'implement' attempt counter = 2 but only 1 attempt directory found
...
```
Exit code: 0 = all pass; 1 = one or more FAIL; warnings don't affect exit code.

**Corrupt-run fixtures (at `tests/fixtures/corrupt-runs/`):**
- `missing-artifact/` — artifacts.jsonl references a file that doesn't exist
- `duplicate-event-id/` — events.jsonl with two events sharing the same ID
- `stale-last-event-id/` — state.json last_event_id doesn't match last event
- `attempt-count-mismatch/` — state attempt = 3, only 2 directories present
- `valid-run/` — a known-good reference fixture

### WF-V022-HUMANGATE

**Scope:**

1. **`timeout_minutes` schema field** — add to human step zod sub-schema as optional `z.number().int().min(1)`. Add tests: valid value passes, float fails, <1 fails, omitted passes.
2. **`approvers` semantics** — add a JSDoc/inline comment in `humanGate.ts` and `approve.ts` explicitly stating: "MVP: approvers field is informational only; no identity check is performed. See TD-P15-001."
3. **Downstream router tests** — add/verify integration tests confirming `steps.<human-step-id>.outputs.decision` and `.comment` are readable by a downstream router `switch` expression after approve and after reject (when reject is followed by a router with `retry_job`). These tests should use the real engine and a workflow fixture, not stubs.
4. **`human_decision_record` schema validation** — add a zod schema for the JSON structure of `human-decision.json` artifact; add a test asserting that `recordHumanDecision` produces a conformant record; add a corrupt-decision fixture for `verify-run` to detect.

**Acceptance:**
- Schema: `timeout_minutes` validates correctly in 4 test cases.
- Semantics: comment exists in both source files.
- Router: 2 integration tests pass (approve→router reads decision; reject→router retries with comment).
- Artifact schema: zod schema exists, conformance test passes, verify-run detects malformed record.

### WF-V022-DIAGNOSTIC

**Scope:**

1. **`status --verbose`** — add `--verbose` flag to `statusAction`. When set, each job block includes: current step, step status, last event time, artifact count, attempt number. Keeps backward compatibility (default: existing output unchanged).
2. **`zigma-flow events [run-id]`** — new command. Reads `events.jsonl` for the specified (or latest) run; prints last N events (default 20, `--limit N` flag). Format: `<event_id>  <timestamp>  <type>  <job>/<step>`.
3. **`zigma-flow artifacts [run-id]`** — new command. Reads `artifacts.jsonl`; prints all artifacts in tabular form: `<id>  <kind>  <path>  <size>`. `--job <id>` filter flag.
4. **Runtime error suggestions** — audit all `ZigmaFlowError` thrown in `approve.ts`, `reject.ts`, `abort.ts`, `run-all.ts`; ensure each has a non-null `.suggestion` field pointing the user to the next useful command. Where suggestion is missing, add it.

**Acceptance:**
- `status --verbose` shows step/artifact/event detail without breaking existing status tests.
- `events` command: outputs last N events; handles missing run gracefully.
- `artifacts` command: lists artifacts; `--job` filter works.
- Error suggestion audit: ≥90% of ZigmaFlowError throw sites in the 4 files have `.suggestion`.

### WF-V022-DOGFOOD (Operational)

This workflow is operational, not a development workflow. It cannot be automated via subagent because it requires real Claude Code invocation against a real code task.

**Process:**
1. After all code workflows are done and the PR is merged, the user runs `zigma-flow run-all` on a real task.
2. Record the prompt packet, agent responses, run events, and any anomalies.
3. Second run with a different task; note whether verify-run, status --verbose, or events commands helped diagnose anything.
4. Write results to `docs/phases/v0.2.2-runtime-reliability/verification-log.md`.

**Acceptance:** File exists with two run records, date, task description, run-id, commands used, anomalies found, and conclusion.

**Note:** This workflow is a human-gated milestone. The supervisor will not dispatch a subagent for it. It is listed here to establish M5 as a phase exit requirement.

## Risks And Mitigations

| Risk | Probability | Impact | Mitigation | Owner |
|---|---|---|---|---|
| `verify-run` check for step visits is complex because visit count isn't stored in state.json | Medium | Medium | Derive step visit count from `step_revisited` events in events.jsonl; document the derivation logic in Step 1 | WF-V022-VERIFYRUN |
| `status --verbose` changes break existing status tests | Low | Medium | Make `--verbose` strictly additive; existing tests pass `{}` options which default to non-verbose | WF-V022-DIAGNOSTIC |
| Dogfood runs expose runtime bugs not caught by unit tests | Medium | Medium | This is the point — bugs found during dogfood are out-of-band fixes or v0.2.3 | WF-V022-DOGFOOD |
| Human gate router integration tests require complex fixture setup | Low | Low | Reuse existing engine test infrastructure (runAll + FakeBackend); human gate tests in P15 already demonstrate the pattern | WF-V022-HUMANGATE |
| Test stability audit finds real flaky tests that need significant refactoring | Low | High | If a test requires major rework, create a tracking issue and isolate with `test.skip` + comment pending fix | WF-V022-STABILITY |

## Quality Bar

- **Required automated tests:** All new commands have unit + integration tests. Corrupt-run fixtures have regression tests. Human gate router tests are integration-level (real engine, real fixture).
- **Required manual checks:** `pnpm typecheck`, `pnpm lint`, `pnpm test:ci` must pass before PR creation.
- **Performance/reliability:** `verify-run` on a run with 1000 events must complete in <2s (sequential file reads are fine).
- **Documentation updates:** README or user docs should mention `verify-run`, `events`, `artifacts` commands. Human gate docs should mention `timeout_minutes`.

## Technical Debt

| ID | Description | Deferred from | Plan to clear |
|---|---|---|---|
| TD-P15-001 | `approvers` field not validated against caller identity | P15 plan §11 | v0.3 git config / env-var identity |
| TD-P15-002 | No timeout enforcement for human gates | P15 plan §11 | v0.3 timeout policy — v0.2.2 adds DSL field only |
| TD-P15-003 | Decision channels only CLI; no email/remote | P15 plan §11 | v0.3+ PR integration or email |

## Open Decisions

None — all design decisions are fully specified. No pre-research phase needed.

## Freeze Record

- **Plan status:** Frozen
- **Frozen at:** 2026-07-01
- **Final decisions:**
  - `verify-run` is a new top-level command (not a flag on `show`) for discoverability.
  - `events` and `artifacts` are new top-level commands.
  - `timeout_minutes` is a DSL reservation only; no runtime check in v0.2.2.
  - WF-V022-STABILITY, WF-V022-VERIFYRUN, WF-V022-HUMANGATE run in parallel (Step 1 dispatched together).
  - WF-V022-DIAGNOSTIC Step 1 dispatched after WF-V022-VERIFYRUN Step 1 completes.
  - WF-V022-DOGFOOD is human-gated; no subagent dispatch.
- **Residual risks:** Dogfood runs may surface bugs requiring out-of-band fixes. Verify-run step-visit derivation may be incomplete if events.jsonl is truncated.
