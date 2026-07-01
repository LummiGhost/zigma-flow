---
workflow: wf-v022-verifyrun
title: WF-V022-VERIFYRUN — Cases and Tests (Step 1)
phase: v0.2.2-runtime-reliability
date: 2026-07-01
status: red-phase (tests authored, implementation pending)
authority: docs/phases/v0.2.2-runtime-reliability/02-development-plan.md §WF-V022-VERIFYRUN
issue: https://github.com/zigma-tools/zigma-flow/issues/94
---

# WF-V022-VERIFYRUN Cases And Tests

## Slice Boundary

- Slice name: Run Consistency Checker
- Bounded context this slice belongs to: CLI diagnostics
- User tasks covered (max 3):
  1. User can run `zigma-flow verify-run` on a run directory and get a
     readable diagnosis telling them whether the run data (state.json,
     events.jsonl, artifacts.jsonl, and on-disk artifact/context files) is
     internally consistent.
- Planned test files (max 2):
  - `tests/commands/verify-run.test.ts`
- UX expectations source: GitHub Issue #94; WF-V022-VERIFYRUN section of
  `docs/phases/v0.2.2-runtime-reliability/02-development-plan.md`.

## Workflow Goal

- Goal: Ship `zigma-flow verify-run [run-id]` as a technical diagnostic CLI
  command. It reads the run's state.json, events.jsonl, and artifacts.jsonl,
  cross-checks them against the on-disk layout, and prints a per-check
  PASS / FAIL / WARN report followed by a summary. Exit code is `0` when
  every check passes and `1` when at least one check fails.
- Acceptance criteria:
  - User can run `zigma-flow verify-run` on a run directory and receive a
    human-readable diagnosis that identifies:
    - whether state.json parses and has the required fields;
    - whether events.jsonl has duplicate event ids;
    - whether state.last_event_id matches the tail of events.jsonl (or both
      are empty/absent);
    - whether every artifacts.jsonl entry has a `path` field and whether the
      referenced file exists on disk relative to the run directory;
    - whether every job's `job.attempt` (defaulting to 1 when absent) equals
      the count of directories under `jobs/<jobId>/attempts/`;
    - whether every `context_block_updated` event points to a
      `payload.artifact_ref` that exists on disk.
  - Exit code is `0` iff every check passes; `1` iff at least one check
    fails.
  - Failing lines include enough detail (path, id, job id) for a user to
    locate the offending record without further tooling.

## Spec Compliance Matrix

Zigma Flow v0.2.2 does not carry an upper design spec beyond the phase
development plan and the tracking issue for this workflow. Rather than
leave the matrix empty, we enumerate every MUST-style expectation drawn
from those two sources so Step 2 has a single compliance list to satisfy.

| Clause ID | Source | Clause summary | Implementation status | Notes |
| --- | --- | --- | --- | --- |
| SPEC-V022-VR-01 | Issue #94; plan WF-V022-VERIFYRUN | Command name is `zigma-flow verify-run [run-id]` | Planned for Step 2 | Wired via `src/commands/index.ts`; positional `run-id` optional. |
| SPEC-V022-VR-02 | Issue #94; plan WF-V022-VERIFYRUN | Command reads state.json, events.jsonl, artifacts.jsonl of a single run | Planned for Step 2 | Enforced by UC-VERIFY-1..8. |
| SPEC-V022-VR-03 | Issue #94 (state check) | state.json must exist, parse as JSON, and pass the shape check (matches `RunState`) | Planned for Step 2 | UC-VERIFY-2, T-VR-010..012. |
| SPEC-V022-VR-04 | Issue #94 (event sequence) | events.jsonl must not contain duplicate event ids | Planned for Step 2 | UC-VERIFY-3, T-VR-020. |
| SPEC-V022-VR-05 | Issue #94 (event sequence) | state.last_event_id must equal the tail id of events.jsonl (or both absent/empty) | Planned for Step 2 | UC-VERIFY-3, T-VR-021, T-VR-022. |
| SPEC-V022-VR-06 | Issue #94 (artifact file existence) | every artifacts.jsonl entry must have a `path` field | Planned for Step 2 | UC-VERIFY-4, T-VR-031. |
| SPEC-V022-VR-07 | Issue #94 (artifact file existence) | the file at each artifact `path` must exist relative to the run directory | Planned for Step 2 | UC-VERIFY-4, T-VR-030. |
| SPEC-V022-VR-08 | Issue #94 (job attempt integrity) | for each job in state.jobs, `job.attempt` (default 1) must equal the count of dirs under `jobs/<jobId>/attempts/` | Planned for Step 2 | UC-VERIFY-5, T-VR-040, T-VR-041. |
| SPEC-V022-VR-09 | Issue #94 (context block versions) | for each `context_block_updated` event, the `payload.artifact_ref` must exist on disk | Planned for Step 2 | UC-VERIFY-6, T-VR-050. |
| SPEC-V022-VR-10 | Issue #94 (output format) | output includes a `Run: <run-id>` header, one `[PASS|FAIL|WARN]` line per check, and a `Summary:` line with counts | Planned for Step 2 | UC-VERIFY-7, T-VR-060..062. |
| SPEC-V022-VR-11 | Issue #94 (exit codes) | exit code 0 = all checks passed; exit code 1 = at least one FAIL | Planned for Step 2 | UC-VERIFY-8, T-VR-070, T-VR-071. |
| SPEC-V022-VR-12 | Issue #94 (actionable output) | FAIL lines must include the path, id, or job id needed to locate the issue | Planned for Step 2 | UC-VERIFY-7, T-VR-062. |
| SPEC-V022-VR-13 | Issue #94 (CLI wiring) | when `run-id` is omitted the command resolves the run against the standard runs dir; when supplied it is honored | Planned for Step 2 | UC-VERIFY-9, T-VR-080, T-VR-081. |

Nothing in this matrix is `N/A` — every clause is in scope for the workflow.

## Functional Points

- FP-VR-STATE-VALID — state.json exists, parses as JSON, and has the
  minimum required RunState fields (`run_id`, `workflow`, `task`,
  `created_at`, `last_event_id`, `jobs`).
- FP-VR-EVENT-DUP — event ids in events.jsonl are unique.
- FP-VR-EVENT-TAIL — state.last_event_id matches events.jsonl tail id (or
  both are absent/empty).
- FP-VR-ARTIFACT-PATH — every artifacts.jsonl entry has a non-empty `path`
  field.
- FP-VR-ARTIFACT-EXISTS — the file at each artifact `path` exists relative
  to the run directory.
- FP-VR-ATTEMPT-COUNT — for each job, `attempt` value matches the count of
  attempt dirs.
- FP-VR-CTX-ARTIFACT — every `context_block_updated` event's
  `payload.artifact_ref` file exists on disk.
- FP-VR-OUTPUT-HEADER — output includes a `Run: <run-id>` header line.
- FP-VR-OUTPUT-CHECKLINE — output prints one `[PASS|FAIL|WARN]` line per
  check.
- FP-VR-OUTPUT-SUMMARY — output ends with a `Summary:` line containing
  numeric counts.
- FP-VR-OUTPUT-ACTIONABLE — every `[FAIL]` line contains the path or id
  needed to locate the offending record.
- FP-VR-EXIT-PASS — exit code is `0` when no FAIL is emitted.
- FP-VR-EXIT-FAIL — exit code is `1` when at least one FAIL is emitted.
- FP-VR-RUNID-RESOLUTION — the command resolves an explicit run id against
  the standard runs dir when the caller does not pass an absolute `runDir`.

## Use Cases

| ID | Scenario | Preconditions | Expected result | Priority |
| --- | --- | --- | --- | --- |
| UC-VERIFY-1 | Verify a fully consistent run | Fixture `valid-run/` — state.json, events.jsonl, artifacts.jsonl, plus one artifact file — is present | Exit code 0; at least one `[PASS]` line; no `[FAIL]` lines; `Summary:` includes `0 failed` | P0 |
| UC-VERIFY-2 | Detect state.json corruption | state.json is missing, malformed JSON, or missing required fields | Exit code 1; `[FAIL]` line naming `state.json` | P0 |
| UC-VERIFY-3 | Detect event log integrity issues | events.jsonl has a duplicate event id OR state.last_event_id does not match events.jsonl tail | Exit code 1; `[FAIL]` line mentions the duplicated id or the mismatched ids; empty-log/empty-last-event case passes | P0 |
| UC-VERIFY-4 | Detect missing artifact files or missing `path` fields | artifacts.jsonl references a non-existent file OR contains an entry with no `path` field | Exit code 1; `[FAIL]` line names the offending path (or file name) | P0 |
| UC-VERIFY-5 | Detect job attempt / directory mismatch | `state.jobs.<id>.attempt` differs from the number of dirs under `jobs/<id>/attempts/` | Exit code 1; `[FAIL]` line names the job id | P0 |
| UC-VERIFY-6 | Detect stale context block artifact refs | `context_block_updated` event points to an artifact path that does not exist on disk | Exit code 1; `[FAIL]` line names the artifact path | P0 |
| UC-VERIFY-7 | Output format (header + check lines + summary) | Any run being verified | Output includes `Run: <run-id>` header, `[PASS|FAIL|WARN]` prefixed check lines, and a `Summary:` line with counts | P0 |
| UC-VERIFY-8 | Exit code contract | Any verification result | Exit code 0 iff no FAIL; exit code 1 iff at least one FAIL | P0 |
| UC-VERIFY-9 | Run id resolution against runsDir | Caller supplies `runsDir` + `runId` instead of an absolute `runDir` | Command resolves `<runsDir>/<runId>/` and verifies it, or reports a clear "not found" error when it does not exist | P1 |

## Test Mapping

| Test ID | Name | Covers use case(s) | Covers FP(s) | Notes |
| --- | --- | --- | --- | --- |
| T-VR-001 | valid run returns exit code 0 | UC-VERIFY-1 | FP-VR-EXIT-PASS | Uses `valid-run` fixture |
| T-VR-002 | valid run emits `[PASS]` for state.json | UC-VERIFY-1 | FP-VR-STATE-VALID, FP-VR-OUTPUT-CHECKLINE | |
| T-VR-003 | valid run emits no `[FAIL]` and `0 failed` summary | UC-VERIFY-1 | FP-VR-OUTPUT-SUMMARY, FP-VR-EXIT-PASS | |
| T-VR-010 | state.json missing → exit 1 + `[FAIL]` | UC-VERIFY-2 | FP-VR-STATE-VALID, FP-VR-EXIT-FAIL | |
| T-VR-011 | state.json malformed JSON → exit 1 + `[FAIL]` | UC-VERIFY-2 | FP-VR-STATE-VALID, FP-VR-EXIT-FAIL | |
| T-VR-012 | state.json missing required fields → exit 1 | UC-VERIFY-2 | FP-VR-STATE-VALID | |
| T-VR-020 | duplicate event id → exit 1 + FAIL naming id | UC-VERIFY-3 | FP-VR-EVENT-DUP, FP-VR-OUTPUT-ACTIONABLE | Uses `duplicate-event-id` fixture |
| T-VR-021 | stale `last_event_id` → exit 1 + FAIL naming both ids | UC-VERIFY-3 | FP-VR-EVENT-TAIL, FP-VR-OUTPUT-ACTIONABLE | Uses `stale-last-event-id` fixture |
| T-VR-022 | empty log + empty `last_event_id` passes | UC-VERIFY-3 | FP-VR-EVENT-TAIL | Boundary case |
| T-VR-030 | missing artifact file → exit 1 + FAIL naming path | UC-VERIFY-4 | FP-VR-ARTIFACT-EXISTS, FP-VR-OUTPUT-ACTIONABLE | Uses `missing-artifact` fixture |
| T-VR-031 | artifact entry with no `path` field → exit 1 + FAIL | UC-VERIFY-4 | FP-VR-ARTIFACT-PATH | |
| T-VR-040 | job attempt > attempt-dir count → exit 1 + FAIL naming job | UC-VERIFY-5 | FP-VR-ATTEMPT-COUNT, FP-VR-OUTPUT-ACTIONABLE | Uses `attempt-count-mismatch` fixture |
| T-VR-041 | attempt=1 with one dir → PASS (no FAIL mentioning attempt) | UC-VERIFY-5 | FP-VR-ATTEMPT-COUNT | Uses `valid-run` fixture |
| T-VR-050 | `context_block_updated` → missing artifact file → exit 1 + FAIL naming path | UC-VERIFY-6 | FP-VR-CTX-ARTIFACT, FP-VR-OUTPUT-ACTIONABLE | |
| T-VR-060 | output header contains `Run: <run-id>` | UC-VERIFY-7 | FP-VR-OUTPUT-HEADER | |
| T-VR-061 | output has `Summary:` line with passed/failed counts | UC-VERIFY-7 | FP-VR-OUTPUT-SUMMARY | |
| T-VR-062 | FAIL line for missing artifact contains the full path | UC-VERIFY-7 | FP-VR-OUTPUT-ACTIONABLE | |
| T-VR-070 | exit code 0 when no FAIL | UC-VERIFY-8 | FP-VR-EXIT-PASS | |
| T-VR-071 | exit code 1 when at least one FAIL | UC-VERIFY-8 | FP-VR-EXIT-FAIL | |
| T-VR-080 | resolves `runsDir` + `runId` when `runDir` is not passed | UC-VERIFY-9 | FP-VR-RUNID-RESOLUTION | |
| T-VR-081 | reports a clear "not found" error when run id is unknown | UC-VERIFY-9 | FP-VR-RUNID-RESOLUTION | Accepts either a thrown error or an exit=1 + stderr message |

Total test cases: 22.

## Fixtures

Static fixtures live at
`tests/fixtures/corrupt-runs/`. Each subdirectory is a minimal, self-
contained run directory:

| Fixture directory | Purpose |
| --- | --- |
| `valid-run/` | Fully consistent run: state.json, events.jsonl (3 events), artifacts.jsonl (1 entry), and the referenced `jobs/implement/attempts/1/steps/implement/stdout.txt` file. Reference input for happy-path tests and for the tests that mutate a copy to inject specific corruption. |
| `missing-artifact/` | Same shape as `valid-run/` but the artifact file referenced from artifacts.jsonl is not present. |
| `duplicate-event-id/` | events.jsonl contains two events with `id: "evt-002"`. |
| `stale-last-event-id/` | state.json `last_event_id` is `evt-099` while events.jsonl tail is `evt-003`. |
| `attempt-count-mismatch/` | state.json has `jobs.implement.attempt = 3` but only `jobs/implement/attempts/1/` and `jobs/implement/attempts/2/` exist on disk. |

Tests copy the fixture to a temp directory before running (see
`copyFixture` helper in the test file) so the on-disk fixture remains
read-only source of truth.

## Test Gaps

- Gap: WARN-severity checks are not yet fixtured. The plan mentions
  `[WARN]` as a valid line prefix but Step 1 focuses on PASS/FAIL to keep
  the contract small. If Step 2 implements WARN cases (e.g. orphaned
  artifact files on disk that are not indexed), tests should be added to
  the same file.
  - Action: Log as a Step 2 planning note. If WARN is deferred, record it
    as a v0.2.3 follow-up.
- Gap: No test verifies behavior when events.jsonl is missing entirely
  (as opposed to empty). Current fixtures do not exercise that path.
  - Action: If Step 2 treats a missing events.jsonl differently from an
    empty file, add a dedicated test using a fixture-copy variant.
- Gap: No test exercises very large runs (thousands of events, many
  artifacts). Performance targets are not in scope for v0.2.2.
  - Action: Recorded as an out-of-scope note; revisit if verify-run is
    added to a CI hot path.
