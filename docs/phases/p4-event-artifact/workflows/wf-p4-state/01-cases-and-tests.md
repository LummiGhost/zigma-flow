# WF-P4-STATE — Cases and Tests

- Workflow: WF-P4-STATE
- Phase: P4 Event Log & Artifact Foundation
- Step: 1 (Cases and Tests)
- Date: 2026-06-08
- Author: subagent (workflow lead)

## Slice Boundary

- Slice name: **WF-P4-STATE**
- Bounded context: **Run State & Persistence** — owned by the Engine, accessed
  via the `StateStore` port. Includes the `RunState` schema (mvp-contracts
  §2.3), the `LocalStateStore` adapter (`readSnapshot`, `writeSnapshot`,
  `validateLastEventId`), and the event-log/snapshot consistency contract from
  architecture.md §7.3.
- User tasks covered: **none — this is a pure infrastructure / safety slice.**
  The user-visible value is indirect: when state or events become corrupt the
  CLI must stop advancing the run instead of producing a silently wrong run.
  No new CLI subcommand is added by this slice.
- Planned test files (1 / max 2):
  - `tests/run/state.test.ts` — unit tests for corrupted state, event/state
    mismatch detection, valid round-trip, atomic write tmp-cleanup, and
    boundary checks for the contract that only the Engine (via `StateStore`)
    may produce `state.json`.

The existing `tests/run/infrastructure.test.ts` already covers the happy-path
write/read round-trip and `validateLastEventId` happy / mismatch cases against
a snapshot-supplied id. This slice extends coverage to the failure modes that
mvp-contracts §2.3 and architecture §7.3 require but P3 left out — corrupted
JSON, event-log tail divergence from snapshot, post-rename tmp cleanup, and
the "only Engine writes state" boundary. To keep tests in one focused file we
do not add a second new file.

## Workflow Goal

Make `state.json` durability and event/state consistency enforceable rather
than aspirational. Concretely:

1. **Corrupted snapshot detection.** If `state.json` exists but is not valid
   JSON or does not conform to the `RunState` shape, `readSnapshot` must
   surface a `StateError` (kind `"StateError"`) — not return a half-parsed
   object and not be swallowed as `null`. CLI callers must treat this as a
   stop signal.
2. **Event-log tail consistency.** `validateLastEventId` must compare the
   snapshot's `last_event_id` to the **actual tail of `events.jsonl`** (read
   from disk), not merely to a caller-supplied id. The P3 implementation only
   checks the caller-supplied id; this slice upgrades the contract so that
   startup divergence (architecture §7.3) is detectable.
3. **Atomic write tmp cleanup.** `writeSnapshot` writes a `state.json.tmp-*`
   file then atomically renames it. After a successful write no `*.tmp-*`
   file may remain in the run directory.
4. **Only-Engine-writes-state boundary.** The CLI and non-Engine layers must
   not write `state.json` directly. We exercise the boundary in a test by
   simulating a foreign writer producing invalid content and showing that
   `readSnapshot` then refuses to advance the run.
5. **Schema completeness.** `RunState` must carry the `status` field required
   by mvp-contracts §2.3. The P3 type omits it. Step 2 must add it; this
   step's tests already exercise it.

## Module Layout

Modules touched in Step 2 (Step 1 only writes tests that import these
symbols):

- `src/run/index.ts`
  - **Updated:** `RunState` adds `status: "running" | "blocked" | "failed" | "completed" | "cancelled"` per mvp-contracts §2.3.
  - **Updated:** `LocalStateStore.readSnapshot` throws `StateError` on
    non-ENOENT failure (corrupt JSON, schema mismatch).
  - **Updated:** `LocalStateStore.validateLastEventId(runDir)` (signature
    change — no caller-supplied id) reads the **event-log tail** via the
    `EventWriter` port and compares it to `state.last_event_id`. Throws
    `StateError` on mismatch.
  - **Updated:** `LocalStateStore.writeSnapshot` ensures the tmp file is
    removed even on a successful rename (rename consumes the tmp; the test
    also asserts no stray tmp survives a successful write).
- `src/utils/errors.ts`
  - **Updated:** export concrete `StateError` class with `exitCode: 1`
    (mvp-contracts §7). The `ZigmaFlowErrorKind` union already includes
    `"StateError"`; only the runtime class is missing.
- `src/utils/index.ts`
  - **Updated:** re-export `StateError`.

The test file uses
`import ... from "../../src/run/index.js"` and
`import { StateError } from "../../src/utils/index.js"`.

## Spec Compliance Matrix (mvp-contracts §2.3)

Every MUST / SHALL clause in mvp-contracts §2.3 (Run State Contract). Status
column is the state assuming Step 2 of this workflow lands as planned.

| #      | Clause (origin)                                                                                       | Status after WF-P4-STATE | Use cases / tests             |
| ------ | ----------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------- |
| SC-S01 | `run_id` field required on RunState                                                                   | Already covered (P3)     | UC-STATE-RT-1 / T-STATE-RT-1  |
| SC-S02 | `workflow` field required on RunState                                                                 | Already covered (P3)     | UC-STATE-RT-1 / T-STATE-RT-1  |
| SC-S03 | `status` field required on RunState                                                                   | **NEW — added by Step 2** — type updated; test asserts the field round-trips | UC-STATE-RT-1 / T-STATE-RT-1  |
| SC-S04 | `last_event_id` field required on RunState                                                            | Already covered (P3)     | UC-STATE-RT-1, UC-STATE-EVT-* |
| SC-S05 | `signals` field — MVP allows empty default; not blocking for this slice                               | Out of scope this slice — tracked as gap below | (none)                        |
| SC-S06 | `jobs` field required on RunState                                                                     | Already covered (P3)     | UC-STATE-RT-1                 |
| SC-S07 | job fields: `status`, `activation`, `attempt`, `needs`, `current_step`, `outputs`                     | Partially covered: `status`/`activation`/`attempt` exist; `needs`/`current_step`/`outputs` extension is gap below | UC-STATE-RT-1                 |
| SC-S08 | optional job fields `activated`, `activation_reason`                                                   | Out of scope this slice — gap below | (none)                        |
| SC-S09 | retry job fields `retry_reason`, `retry_inputs`                                                       | Out of scope this slice — gap below | (none)                        |
| SC-S10 | MUST: `state.json` is written only by Engine via `StateStore`                                         | Enforced by design — exercised | UC-STATE-BOUND-1 / T-STATE-BOUND-1 |
| SC-S11 | MUST: write order is "append event THEN atomic replace state snapshot"                                 | Already exercised in P3 (T-ENG-5/6 in `engine-create-run.test.ts`); this slice adds the post-write tmp-cleanup assertion | UC-STATE-ATOMIC-1 / T-STATE-ATOMIC-1 |
| SC-S12 | MUST: `state.last_event_id` equals event log tail id                                                  | **NEW — `validateLastEventId` now reads the real event-log tail** | UC-STATE-EVT-1, UC-STATE-EVT-2 / T-STATE-EVT-1, T-STATE-EVT-2 |
| SC-S13 | MUST: corrupted state OR event/state divergence → CLI MUST NOT continue advancing the run             | **NEW — `readSnapshot` throws `StateError`; `validateLastEventId` throws `StateError` on divergence** | UC-STATE-CORRUPT-1, UC-STATE-EVT-2 / T-STATE-CORRUPT-1, T-STATE-EVT-2 |

13 clauses enumerated. SC-S05 / SC-S07 (partial) / SC-S08 / SC-S09 are
deliberately deferred — see **Test Gaps** below; they belong to later P4 / P5
slices where the engine actually produces those fields. This slice only adds
what the **state-consistency** contract demands, not the full §2.3 schema.

## Functional Points

| FP id              | Area                                | Source                       | Summary                                                                              |
| ------------------ | ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| FP-STATE-CORRUPT   | `LocalStateStore.readSnapshot`      | mvp-contracts §2.3 SC-S13    | Corrupted JSON / schema-broken `state.json` → `StateError`                            |
| FP-STATE-EVT-CONS  | `LocalStateStore.validateLastEventId` | mvp-contracts §2.3 SC-S12 / architecture §7.3 | Compare snapshot `last_event_id` to **actual event log tail**; mismatch → `StateError` |
| FP-STATE-RT        | `LocalStateStore.readSnapshot` / `writeSnapshot` round-trip | mvp-contracts §2.3 SC-S01..S07 | Valid state round-trip; new `status` field survives serialization                     |
| FP-STATE-ATOMIC    | `LocalStateStore.writeSnapshot`     | mvp-contracts §2.3 SC-S11 / architecture §7.3 | tmp-file + rename leaves no `state.json.tmp-*` survivor after a successful write       |
| FP-STATE-BOUNDARY  | Only-Engine-writes-state            | mvp-contracts §2.3 SC-S10    | A foreign writer producing arbitrary `state.json` content is detected by `readSnapshot` as invalid; advancing is refused |

## Use Cases

| UC id              | Actor   | Trigger                                                                                       | Pre-conditions                                                                  | Steps                                                                                                                       | Post-conditions / observable result                                                                                              |
| ------------------ | ------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| UC-STATE-CORRUPT-1 | Engine  | Engine reads `state.json` whose body is `not-json{`                                           | `state.json` exists; bytes are not valid JSON                                   | Call `readSnapshot(runDir)`.                                                                                                | Throws `StateError` (kind `"StateError"`). Run advancement aborts.                                                              |
| UC-STATE-CORRUPT-2 | Engine  | Engine reads `state.json` whose JSON is valid but shape is wrong (missing `run_id`, `jobs`)   | `state.json` parses to an object that is not a `RunState`                       | Call `readSnapshot(runDir)`.                                                                                                | Throws `StateError`. Run advancement aborts.                                                                                    |
| UC-STATE-EVT-1     | Engine  | Engine validates consistency after a normal write (snapshot.last_event_id = events.jsonl tail) | `events.jsonl` tail is `evt-002`; snapshot `last_event_id` is `evt-002`         | Call `validateLastEventId(runDir)`.                                                                                          | Resolves without error.                                                                                                          |
| UC-STATE-EVT-2     | Engine  | Engine validates consistency when snapshot points to a stale event id                          | `events.jsonl` tail is `evt-003`; snapshot `last_event_id` is `evt-002`         | Call `validateLastEventId(runDir)`.                                                                                          | Throws `StateError` referencing both ids in `details`. CLI MUST NOT advance the run (architecture §7.3, mvp-contracts §2.3 SC-S13). |
| UC-STATE-EVT-3     | Engine  | Engine validates consistency when events.jsonl is missing entirely                             | `state.json` exists; `events.jsonl` does not exist                              | Call `validateLastEventId(runDir)`.                                                                                          | Throws `StateError` — divergence (snapshot claims an id, log has none).                                                          |
| UC-STATE-RT-1      | Engine  | Engine writes a `RunState` then reads it back                                                   | none                                                                            | Write a fully populated `RunState` including the new `status` field; re-read.                                              | Deep-equals the written object; `status` survives the round-trip.                                                                |
| UC-STATE-ATOMIC-1  | Engine  | Engine writes a snapshot via `writeSnapshot`                                                    | run directory exists                                                            | After `writeSnapshot` resolves, list directory entries.                                                                     | `state.json` exists; no `state.json.tmp-*` survives.                                                                              |
| UC-STATE-ATOMIC-2  | Engine  | Engine writes a snapshot twice in quick succession                                              | run directory exists                                                            | Call `writeSnapshot` twice with different contents.                                                                          | Final `state.json` matches the second payload; no `state.json.tmp-*` survives.                                                  |
| UC-STATE-BOUND-1   | Intruder | Non-Engine code overwrites `state.json` with arbitrary bytes outside the `StateStore`         | `state.json` exists from a real write; intruder writes garbage directly via fs   | Engine then calls `readSnapshot(runDir)`.                                                                                    | Throws `StateError` — corruption is detected, advancement refused. (Boundary is enforced via *detection*, not OS permissions; MVP scope per mvp-contracts §7.) |

## Test Mapping

| Test id              | File                       | `describe` → `it`                                                                                              | UCs covered                | FPs covered          | RCs (SC) touched          |
| -------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------- | ------------------------- |
| T-STATE-CORRUPT-1    | `tests/run/state.test.ts`  | `LocalStateStore.readSnapshot` → `throws StateError when state.json contains invalid JSON`                     | UC-STATE-CORRUPT-1         | FP-STATE-CORRUPT     | SC-S13                    |
| T-STATE-CORRUPT-2    | `tests/run/state.test.ts`  | `LocalStateStore.readSnapshot` → `throws StateError when state.json JSON is missing required fields`           | UC-STATE-CORRUPT-2         | FP-STATE-CORRUPT     | SC-S13                    |
| T-STATE-EVT-1        | `tests/run/state.test.ts`  | `LocalStateStore.validateLastEventId` → `resolves when snapshot last_event_id matches events.jsonl tail`       | UC-STATE-EVT-1             | FP-STATE-EVT-CONS    | SC-S12                    |
| T-STATE-EVT-2        | `tests/run/state.test.ts`  | `LocalStateStore.validateLastEventId` → `throws StateError when snapshot last_event_id lags behind log tail`   | UC-STATE-EVT-2             | FP-STATE-EVT-CONS    | SC-S12, SC-S13            |
| T-STATE-EVT-3        | `tests/run/state.test.ts`  | `LocalStateStore.validateLastEventId` → `throws StateError when events.jsonl is missing but snapshot has an id` | UC-STATE-EVT-3             | FP-STATE-EVT-CONS    | SC-S12, SC-S13            |
| T-STATE-RT-1         | `tests/run/state.test.ts`  | `LocalStateStore round-trip` → `writeSnapshot then readSnapshot preserves all RunState fields including status` | UC-STATE-RT-1              | FP-STATE-RT          | SC-S01..S04, SC-S06, SC-S07 |
| T-STATE-ATOMIC-1     | `tests/run/state.test.ts`  | `LocalStateStore.writeSnapshot` → `cleans up tmp file after successful rename`                                 | UC-STATE-ATOMIC-1          | FP-STATE-ATOMIC      | SC-S11                    |
| T-STATE-ATOMIC-2     | `tests/run/state.test.ts`  | `LocalStateStore.writeSnapshot` → `leaves no stray tmp file after two successive writes`                       | UC-STATE-ATOMIC-2          | FP-STATE-ATOMIC      | SC-S11                    |
| T-STATE-BOUND-1      | `tests/run/state.test.ts`  | `state.json ownership boundary` → `readSnapshot rejects state.json produced by a non-StateStore writer`        | UC-STATE-BOUND-1           | FP-STATE-BOUNDARY    | SC-S10, SC-S13            |

9 tests in a single file, within the 2-file budget.

## Test Design Summary

- **Framework:** vitest (`describe` / `it` / `expect`).
- **Filesystem strategy:** each `describe` (or `beforeEach`) creates a unique
  `os.tmpdir()` subdirectory and removes it in `afterEach`. No `fs` mocking.
- **Event log fixtures:** tests that need an events.jsonl tail write JSON
  lines directly via `node:fs/promises.writeFile` / `appendFile` so the test
  does not depend on `JsonlEventWriter`'s internals — the test asserts the
  contract, not the writer.
- **Corrupted-state fixtures:** tests use `writeFile(statePath, "not-json{")`
  and `writeFile(statePath, JSON.stringify({}))` to produce the two corruption
  modes.
- **Boundary fixture for UC-STATE-BOUND-1:** the test first runs a legitimate
  `writeSnapshot`, then bypasses the store with a direct `writeFile` of
  garbage, then asserts `readSnapshot` throws. This mirrors the threat model
  in mvp-contracts §2.3 SC-S10 (a foreign writer); MVP does not enforce OS-level
  write protection, so the detection is the boundary.
- **Atomic-write tmp cleanup:** `T-STATE-ATOMIC-1` lists `runDir` entries
  after `writeSnapshot` resolves and asserts no entry matches
  `/^state\.json\.tmp-/`.
- **Error assertions:** `instanceof StateError` plus `.kind === "StateError"`.
  No string matching on `.message`.
- **`exactOptionalPropertyTypes`:** the test fixtures use the new
  `RunState.status` field unconditionally. Tests do not assign `undefined`
  to optional fields.
- **Red phase expected:** as of Step 1, the following must change in Step 2
  to make the tests pass:
  1. `StateError` class exported from `src/utils/errors.ts` and re-exported
     from `src/utils/index.ts`.
  2. `RunState.status` added to the type (mvp-contracts §2.3 SC-S03).
  3. `LocalStateStore.readSnapshot` throws `StateError` on JSON-parse or
     schema-shape failure (currently returns the result of `JSON.parse` as
     `RunState` without any shape check and re-wraps other I/O failures as
     `FilesystemError`).
  4. `LocalStateStore.validateLastEventId(runDir)` — signature drops the
     `expectedEventId` argument and instead reads the **events.jsonl tail**;
     throws `StateError` on mismatch (currently takes `expectedEventId`,
     reads the snapshot, throws `WorkflowError`).
  5. `LocalStateStore.writeSnapshot` continues to use tmp + rename; tests
     additionally assert no `*.tmp-*` survives. (The current implementation
     already passes by virtue of rename consuming the tmp; the test guards
     against regressions and against a future fallback that copies instead
     of renames.)

## Test Gaps

- **SC-S05 `signals` field:** Not introduced in this slice — the engine has
  no signal producer yet (P5 work). When `signals` is added, a follow-up
  test extends `T-STATE-RT-1`.
- **SC-S07 partial — `needs`, `current_step`, `outputs`:** The P3 `JobState`
  shape lacks these. Engine code does not produce them yet, so adding the
  fields without producers risks dead schema. Deferred to the P4/P5 slice
  that introduces step execution. The slice boundary is recorded so a later
  agent can extend `T-STATE-RT-1` with the missing job fields.
- **SC-S08 / SC-S09 — optional-activation and retry job fields:** Deferred
  to the slice that introduces optional activation outcomes and retry
  scheduling. Currently these are workflow definitions, not runtime
  outcomes.
- **Concurrent writers:** Two processes simultaneously writing `state.json`
  is out of MVP scope (TD-P3-003).
- **OS-enforced write protection of `state.json`:** Out of MVP scope per
  mvp-contracts §7; detection on read is the agreed boundary.
- **Atomicity under crash mid-rename:** Real crash-injection requires
  faulting `node:fs/promises.rename`. Out of MVP scope; tmp-cleanup test
  guards the post-condition only.
