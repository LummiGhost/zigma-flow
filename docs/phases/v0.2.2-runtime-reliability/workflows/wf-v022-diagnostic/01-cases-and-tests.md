---
workflow: wf-v022-diagnostic
title: WF-V022-DIAGNOSTIC — Cases and Tests (Step 1)
phase: v0.2.2-runtime-reliability
date: 2026-07-01
status: red-phase (tests authored, implementation pending)
authority: docs/phases/v0.2.2-runtime-reliability/02-development-plan.md §WF-V022-DIAGNOSTIC
issue: https://github.com/zigma-tools/zigma-flow/issues/94
---

# WF-V022-DIAGNOSTIC Cases And Tests

## Slice Boundary

- Slice name: Diagnostic CLI Experience
- Bounded context this slice belongs to: CLI diagnostics
- User tasks covered (max 3):
  1. User can run `zigma-flow status --verbose` and see per-step detail
     (current step, step status, attempt) for each job.
  2. User can run `zigma-flow events [run-id]` and inspect the recent
     events of a run, with `--limit N` slicing the tail.
  3. User can run `zigma-flow artifacts [run-id]` and list the artifact
     index of a run, with `--job <id>` filtering to a single job.
- Planned test files (max 2):
  - `tests/commands/events.test.ts`
  - `tests/commands/artifacts.test.ts`

  (The `status --verbose` cases extend the pre-existing
  `tests/commands/status.test.ts`; that file is a modification, not a new
  planned test file, so it does not count against the two-file cap.)
- UX expectations source: GitHub Issue #94 P1 items;
  `docs/phases/v0.2.2-runtime-reliability/02-development-plan.md` §WF-V022-DIAGNOSTIC.

## Workflow Goal

- Goal: Improve the diagnostic experience of the Zigma Flow CLI so an
  operator can inspect a run's health, recent activity, and artifact
  inventory without touching raw JSONL files. Deliverables:
  1. `status --verbose` — additive flag on the existing `status` command
     that surfaces per-step detail (current step, step status, attempt)
     while keeping the default output unchanged.
  2. `zigma-flow events [run-id]` — new top-level command that tails
     `events.jsonl` (default 20 events, `--limit N` flag).
  3. `zigma-flow artifacts [run-id]` — new top-level command that lists
     `artifacts.jsonl` in tabular form (`--job <id>` filter flag).
  4. Runtime error suggestions — every `ZigmaFlowError` thrown in
     `approve.ts`, `reject.ts`, `abort.ts`, `run-all.ts` carries a
     non-null `.suggestion` field pointing the operator at the next
     useful command.
- Acceptance criteria:
  - `zigma-flow status` output (no flag) is byte-identical to the
     current behavior; existing 5 `renderRunStatus` tests continue to
     pass.
  - `zigma-flow status --verbose` prints per-step detail (current step,
     step status, attempt) for each job that carries those fields.
  - `zigma-flow events [run-id]` prints one line per event in
     `events.jsonl`; defaults to last 20; `--limit N` slices to the tail
     N events; missing `events.jsonl` in an existing run dir is treated
     as an empty log (exit 0); missing run dir is signaled.
  - `zigma-flow artifacts [run-id]` prints one row per artifact in
     `artifacts.jsonl` with `id`, `kind`, `path`, `size` columns;
     `--job <id>` filters to artifacts whose `producer.job` equals the
     supplied id; missing/empty index handled gracefully.
  - `.suggestion` field is present on ≥90% of `ZigmaFlowError` throw
     sites in the four audited command files.

## Spec Compliance Matrix

The v0.2.2 phase development plan and GitHub Issue #94 are the two
sources of MUST-style clauses for this workflow. Every clause listed
below is in scope for Step 2.

| Clause ID | Source | Clause summary | Implementation status | Notes |
| --- | --- | --- | --- | --- |
| SPEC-V022-DG-01 | Plan §WF-V022-DIAGNOSTIC.1; Issue #94 | `status --verbose` flag added to existing `status` command | Planned for Step 2 | UC-VERB-1..4; tests in `tests/commands/status.test.ts`. |
| SPEC-V022-DG-02 | Plan §WF-V022-DIAGNOSTIC.1 | Default `status` output (no flag) is unchanged | Planned for Step 2 | UC-VERB-1 asserts byte-identical baseline. |
| SPEC-V022-DG-03 | Plan §WF-V022-DIAGNOSTIC.1 | Verbose mode surfaces current step, step status, and attempt per job | Planned for Step 2 | UC-VERB-2, UC-VERB-3. |
| SPEC-V022-DG-04 | Plan §WF-V022-DIAGNOSTIC.2; Issue #94 | New top-level command `zigma-flow events [run-id]` | Planned for Step 2 | UC-EV-1..4. |
| SPEC-V022-DG-05 | Plan §WF-V022-DIAGNOSTIC.2 | Default limit is 20 events; `--limit N` slices the tail | Planned for Step 2 | UC-EV-1, UC-EV-2. |
| SPEC-V022-DG-06 | Plan §WF-V022-DIAGNOSTIC.2 | Each event line contains `<id>  <timestamp>  <type>  <job>/<step>` | Planned for Step 2 | T-EV-002. |
| SPEC-V022-DG-07 | Plan §WF-V022-DIAGNOSTIC.2 | Missing `events.jsonl` inside an existing run dir is not an error | Planned for Step 2 | T-EV-020, T-EV-021. |
| SPEC-V022-DG-08 | Plan §WF-V022-DIAGNOSTIC.3; Issue #94 | New top-level command `zigma-flow artifacts [run-id]` | Planned for Step 2 | UC-AR-1..4. |
| SPEC-V022-DG-09 | Plan §WF-V022-DIAGNOSTIC.3 | Each row contains `<id>  <kind>  <path>  <size>` columns | Planned for Step 2 | T-AR-001, T-AR-002. |
| SPEC-V022-DG-10 | Plan §WF-V022-DIAGNOSTIC.3 | `--job <id>` filter honors `producer.job` on each metadata entry | Planned for Step 2 | UC-AR-2, T-AR-010..012. |
| SPEC-V022-DG-11 | Plan §WF-V022-DIAGNOSTIC.4 | Every `ZigmaFlowError` throw in the four command files has a `.suggestion` field | Delivered in Step 1 (annotation-only) | See §Suggestion Audit. |
| SPEC-V022-DG-12 | Plan freeze record | `verify-run`, `events`, `artifacts` are top-level commands, not sub-commands of `show` | Planned for Step 2 | Wire into `src/cli.ts`. |
| SPEC-V022-DG-13 | Plan §WF-V022-DIAGNOSTIC.2, .3 | Missing run directory itself surfaces a clear diagnostic | Planned for Step 2 | T-EV-022, T-AR-022. |

Nothing in this matrix is `N/A`.

## Functional Points

- FP-VERB-DEFAULT — `renderRunStatus(state, jobs)` (2 args) and
  `renderRunStatus(state, jobs, {})` and
  `renderRunStatus(state, jobs, { verbose: false })` all return the
  same string.
- FP-VERB-CURRENT-STEP — verbose mode prints `current_step` for jobs
  that carry it.
- FP-VERB-STEP-STATUS — verbose mode prints `step_status` for jobs
  that carry it (e.g. `awaiting_human`).
- FP-VERB-ATTEMPT — verbose mode prints `attempt` for jobs that carry
  a non-default attempt.
- FP-VERB-NO-STEP-INFO — verbose mode on a job with no step info
  produces no `undefined` leakage and does not throw.
- FP-EV-LINE-FORMAT — each event line contains `<event id>`,
  `<timestamp>`, `<event type>`, and `<job>/<step>`.
- FP-EV-DEFAULT-ORDER — output is in append order (oldest → newest).
- FP-EV-LIMIT — `--limit N` keeps only the last N events; the trailing
  events (newest) are kept, older events are dropped.
- FP-EV-LIMIT-ZERO — `--limit 0` prints no data rows.
- FP-EV-LIMIT-OVERFLOW — `--limit N` with `N > count` prints every event.
- FP-EV-MISSING-LOG — missing `events.jsonl` inside an existing run dir
  is treated as an empty log (0 rows, exit 0).
- FP-EV-EMPTY-LOG — an empty `events.jsonl` file is treated identically.
- FP-EV-MISSING-RUN — a missing run directory itself surfaces via a
  thrown error or a stderr message.
- FP-EV-LATEST — when neither `runId` nor `runDir` is passed, the
  command resolves to the lexicographically largest run under `runsDir`.
- FP-AR-COLUMNS — each row surfaces `id`, `kind`, `path`, and `size`.
- FP-AR-DEFAULT — no filter prints every artifact.
- FP-AR-JOB-FILTER — `--job <id>` keeps only artifacts whose
  `producer.job === id`.
- FP-AR-FILTER-MISS — a `--job <id>` that matches nothing prints no
  data rows.
- FP-AR-MISSING-INDEX — missing `artifacts.jsonl` in an existing run
  dir is treated as an empty index (0 rows, exit 0).
- FP-AR-EMPTY-INDEX — an empty `artifacts.jsonl` file is treated
  identically.
- FP-AR-MISSING-RUN — a missing run directory itself surfaces via a
  thrown error or a stderr message.
- FP-AR-LATEST — when neither `runId` nor `runDir` is passed, the
  command resolves to the lexicographically largest run under `runsDir`.
- FP-SUG-COVERAGE — ≥90% of `ZigmaFlowError` throws in the four
  audited command files carry a non-null `.suggestion`.

## Use Cases

| ID | Scenario | Preconditions | Expected result | Priority |
| --- | --- | --- | --- | --- |
| UC-VERB-1 | Default `status` output regression guard | RunState with jobs, workflowJobs empty | `renderRunStatus(state, jobs)` and `renderRunStatus(state, jobs, { verbose: false })` return byte-identical strings | P0 |
| UC-VERB-2 | Verbose mode surfaces per-step detail | Jobs with `current_step` and `step_status` populated | Output contains each job's current step id and step_status value | P0 |
| UC-VERB-3 | Verbose mode surfaces attempt number | Jobs with `attempt` populated | Output contains each job's attempt number | P0 |
| UC-VERB-4 | Verbose mode is safe when step info is absent | Jobs with no `current_step` / `step_status` | Output is a non-empty string; no literal `undefined` appears; no throw | P1 |
| UC-EV-1 | Default events output | `events.jsonl` present with N ≤ 20 events | One line per event; each line contains id, timestamp, type, job/step | P0 |
| UC-EV-2 | `--limit N` slicing | `events.jsonl` present with 8 events | With `--limit 5`, prints newest 5; with `--limit 100`, prints all 8; with `--limit 0`, prints none | P0 |
| UC-EV-3 | Graceful missing/empty inputs | Missing `events.jsonl` OR empty file OR missing run dir | Missing/empty → exit 0, 0 rows; missing run dir → throw or stderr | P0 |
| UC-EV-4 | Run id resolution | Caller provides `runsDir` + `runId`, or only `runsDir` | Reads the requested run's events; with only `runsDir`, picks the newest run lexicographically | P1 |
| UC-AR-1 | Default artifacts output | `artifacts.jsonl` present with 3 entries | Each artifact's id/kind/path/size appears in output | P0 |
| UC-AR-2 | `--job <id>` filter | `--job intake` (2 matches) or `--job implement` (1 match) or `--job no-such-job` (0 matches) | Only artifacts from the requested job appear; zero-match case prints no data rows | P0 |
| UC-AR-3 | Graceful missing/empty inputs | Missing `artifacts.jsonl` OR empty file OR missing run dir | Missing/empty → exit 0, 0 rows; missing run dir → throw or stderr | P0 |
| UC-AR-4 | Run id resolution | Caller provides `runsDir` + `runId`, or only `runsDir` | Reads the requested run's artifacts; with only `runsDir`, picks the newest run lexicographically | P1 |
| UC-SUG-1 | Suggestion audit annotation | Every `ZigmaFlowError` throw in `approve.ts`, `reject.ts`, `abort.ts` has a `.suggestion` field | Delivered directly in Step 1 (see §Suggestion Audit); coverage ≥ 90% | P0 |

## Test Mapping

| Test ID | Name | Covers use case(s) | Covers FP(s) | Notes |
| --- | --- | --- | --- | --- |
| T-VERB-1 | default output is unchanged when `{ verbose: false }` | UC-VERB-1 | FP-VERB-DEFAULT | `tests/commands/status.test.ts`; regression guard |
| T-VERB-2 | verbose mode surfaces `current_step` and `step_status` | UC-VERB-2 | FP-VERB-CURRENT-STEP, FP-VERB-STEP-STATUS | `tests/commands/status.test.ts` |
| T-VERB-3 | verbose mode surfaces `attempt` | UC-VERB-3 | FP-VERB-ATTEMPT | `tests/commands/status.test.ts` |
| T-VERB-4 | verbose mode with no step info stays clean | UC-VERB-4 | FP-VERB-NO-STEP-INFO | `tests/commands/status.test.ts` |
| T-EV-001 | default prints all events when N ≤ default limit | UC-EV-1 | FP-EV-DEFAULT-ORDER | `tests/commands/events.test.ts` |
| T-EV-002 | each line includes id, timestamp, type, `<job>/<step>` | UC-EV-1 | FP-EV-LINE-FORMAT | |
| T-EV-010 | `--limit 5` keeps newest 5 | UC-EV-2 | FP-EV-LIMIT | |
| T-EV-011 | `--limit 100` prints all 8 | UC-EV-2 | FP-EV-LIMIT-OVERFLOW | |
| T-EV-012 | `--limit 0` prints none | UC-EV-2 | FP-EV-LIMIT-ZERO | |
| T-EV-020 | missing `events.jsonl` → 0 rows, exit 0 | UC-EV-3 | FP-EV-MISSING-LOG | |
| T-EV-021 | empty `events.jsonl` → 0 rows, exit 0 | UC-EV-3 | FP-EV-EMPTY-LOG | |
| T-EV-022 | missing run dir → throw or stderr signal | UC-EV-3 | FP-EV-MISSING-RUN | |
| T-EV-030 | resolves `runsDir` + `runId` | UC-EV-4 | FP-EV-LATEST | |
| T-EV-031 | resolves latest run when only `runsDir` supplied | UC-EV-4 | FP-EV-LATEST | |
| T-AR-001 | default prints one row per artifact | UC-AR-1 | FP-AR-DEFAULT | `tests/commands/artifacts.test.ts` |
| T-AR-002 | each row surfaces id/kind/path/size | UC-AR-1 | FP-AR-COLUMNS | |
| T-AR-010 | `--job intake` keeps 2 artifacts | UC-AR-2 | FP-AR-JOB-FILTER | |
| T-AR-011 | `--job no-such-job` prints no rows | UC-AR-2 | FP-AR-FILTER-MISS | |
| T-AR-012 | `--job implement` keeps 1 artifact | UC-AR-2 | FP-AR-JOB-FILTER | |
| T-AR-020 | missing `artifacts.jsonl` → 0 rows, exit 0 | UC-AR-3 | FP-AR-MISSING-INDEX | |
| T-AR-021 | empty `artifacts.jsonl` → 0 rows, exit 0 | UC-AR-3 | FP-AR-EMPTY-INDEX | |
| T-AR-022 | missing run dir → throw or stderr signal | UC-AR-3 | FP-AR-MISSING-RUN | |
| T-AR-030 | resolves `runsDir` + `runId` | UC-AR-4 | FP-AR-LATEST | |
| T-AR-031 | resolves latest run when only `runsDir` supplied | UC-AR-4 | FP-AR-LATEST | |

Total test cases authored in this workflow:

- `tests/commands/status.test.ts` — 4 new tests appended (T-VERB-1..4).
- `tests/commands/events.test.ts` — 10 tests (T-EV-001..002, 010..012,
  020..022, 030..031).
- `tests/commands/artifacts.test.ts` — 10 tests (T-AR-001..002,
  010..012, 020..022, 030..031).

Grand total: **24** new test cases across three files.

## Fixtures

Static fixtures live under `tests/fixtures/`:

| Fixture directory | Purpose |
| --- | --- |
| `tests/fixtures/corrupt-runs/valid-run/` (existing) | Minimal known-good run authored by WF-V022-VERIFYRUN. Not used directly by the diagnostic tests because it only carries 3 events and 1 artifact — too small to exercise `--limit 5` and `--job` filter across multiple jobs. |
| `tests/fixtures/diagnostic-run/` (new) | Run directory with **8 events** across two jobs (`intake` done, `implement` running attempt 2) and **3 artifacts** across the same two jobs. Sized so `--limit 5` and `--job <id>` filter tests can distinguish real behavior from no-op behavior. |

The `diagnostic-run` fixture contains only `state.json`, `events.jsonl`,
and `artifacts.jsonl` — the referenced artifact files are NOT included
because the diagnostic commands do not stat artifact paths (only
`verify-run` does that).

## Suggestion Audit

The runtime-error suggestion audit for `approve.ts`, `reject.ts`,
`abort.ts`, `run-all.ts` was executed as part of Step 1. Findings and
changes are listed here.

### Files audited

| File | ZigmaFlowError throw sites | Had `.suggestion` before | Have `.suggestion` after |
| --- | --- | --- | --- |
| `src/commands/approve.ts` | 7 | 0 | 7 |
| `src/commands/reject.ts` | 7 | 0 | 7 |
| `src/commands/abort.ts` | 1 | 0 | 1 |
| `src/commands/run-all.ts` | 0 (delegates to engine) | N/A | N/A |

Total: **15 of 15** (100%) `ZigmaFlowError` throws in the audited files
now carry a non-null `.suggestion`. Coverage exceeds the ≥90% acceptance
threshold defined in the phase development plan.

### Changes applied

The audit-fix diff is annotation-only (no behavioral change). Each
throw's `options` object gained a `suggestion` string pointing to the
next useful command:

- **`approve.ts`**
  - `ConfigError("No active run found. …")` → suggestion:
    "Run 'zigma-flow list-runs' to see available runs, or 'zigma-flow
    run <workflow> --task <task>' to create a new one."
  - `StateError("state.json not found …")` → suggestion:
    "Run 'zigma-flow verify-run' to check whether the run directory is
    intact, or 'zigma-flow list-runs' to pick a different run."
  - `UserInputError("Job \"…\" not found …")` → suggestion:
    "Run 'zigma-flow status' to see the current jobs in this run."
  - `UserInputError("No step is currently awaiting …")` → suggestion:
    "Run 'zigma-flow status --verbose' to see per-step status for each
    job."
  - `UserInputError("Multiple steps are awaiting …")` → suggestion:
    "Re-run with '--job <job> --step <step>' naming one of the awaiting
    entries above."
  - `UserInputError("Could not determine which step to approve. …")` →
    suggestion: "Run 'zigma-flow status --verbose' to list the steps of
    this job and pick the awaiting one."
  - `StateError("Step \"…\" is not awaiting human input.")` →
    suggestion: "Run 'zigma-flow status --verbose' to see which step is
    currently awaiting a decision."

- **`reject.ts`** — same seven throws as `approve.ts` (mirror
  implementation) received the same suggestions with wording adapted
  to "reject" where needed.

- **`abort.ts`**
  - `ConfigError("No active run found. …")` → suggestion:
    "Run 'zigma-flow list-runs' to see available runs, or 'zigma-flow
    run <workflow> --task <task>' to create a new one."

- **`run-all.ts`** — no direct `ZigmaFlowError` throws. All error
  surfaces come from the engine (`runAll`) which owns its own
  suggestions. No annotation needed.

### Verification

The diff is a pure annotation change (adds `suggestion:` keys to
existing `options` objects). Existing tests for `approve`, `reject`,
and `abort` should continue to pass because:

- The thrown error class and message strings are unchanged.
- The `details` field is unchanged.
- The `.suggestion` field is a new read-only property; no existing test
  asserts its absence.

## Test Gaps

- Gap: No test asserts the exact `.suggestion` string on any throw. The
  audit is purely additive; enforcing the wording would be brittle and
  is out of scope. If Step 2 (or a future workflow) wants a suggestion
  regression test, the recommended shape is
  `expect(err.suggestion).toMatch(/list-runs|status|verify-run/)` — a
  vocabulary check, not a wording check.
  - Action: Log as a v0.2.3 follow-up if operators report low-quality
    suggestion text.
- Gap: No test exercises very large event logs (thousands of entries).
  Performance targets for `events` are not in scope for v0.2.2
  (`verify-run` has a stated 1000-event / <2s target; `events` inherits
  no such constraint yet).
  - Action: Recorded as out-of-scope; revisit if `events` is used on
    hot paths.
- Gap: No test exercises very large artifact indexes (hundreds of
  entries). Same reasoning as above.
  - Action: Recorded as out-of-scope.
- Gap: The `--limit N` semantics for `events` fix "N" to a numeric CLI
  argument. Tests only cover 0, 5, and 100. Negative N is not
  specified. Step 2 should choose a policy (reject vs. clamp to 0) and
  add a corresponding test.
  - Action: Step 2 planning item; do not implement without a decision.
- Gap: `status --verbose` last-event-timestamp and artifact-count
  fields are called out in the workflow scope but not covered by
  T-VERB-2/3 because they require reading `events.jsonl` and
  `artifacts.jsonl` from disk — a departure from the current pure
  `renderRunStatus` signature. Step 2 must decide whether to derive
  these inside `statusAction` (fetching event tail and artifact count)
  and pass them into the render, or to expand the options bag to
  carry `lastEventAt` / `artifactCount` per job. Tests for those
  fields will be added once Step 2 lands the signature decision.
  - Action: Step 2 architecture-review item; add follow-up tests as
    part of Step 2 delivery, not deferred.
