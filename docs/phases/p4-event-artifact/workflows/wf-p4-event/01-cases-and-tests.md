# WF-P4-EVENT — Cases and Tests

- Workflow: WF-P4-EVENT
- Phase: P4 Event Log & Artifact Foundation
- Step: 1 (Cases and Tests)
- Date: 2026-06-08
- Author: subagent (workflow lead)

## Slice Boundary

- Slice name: **WF-P4-EVENT**
- Bounded context: **Audit and Event Log** — `src/events/` module.
  This slice owns the structured event type catalog (`ZigmaFlowEvent`
  discriminated union covering all 17 MVP event types), the sequential event
  id helper (`nextEventId`), the `EventWriter` port, and the
  `JsonlEventWriter` adapter that appends one JSON line per event to
  `events.jsonl`.
- User tasks covered: **none.** This is a technical workflow whose
  deliverables are consumed by Engine, Run, Artifact, Script, Check and
  Router slices. User-visible behavior is exercised indirectly: a successful
  P3 `zigma-flow run` still produces a valid `events.jsonl` and
  `state.last_event_id`, but now over a typed event schema with discriminated
  payloads. No new CLI surface is added by this workflow.
- Planned test files (1 / max 2):
  - `tests/events/eventTypes.test.ts` — discriminated-union round-trip,
    JSON serialization stability per type, type-narrowing exhaustiveness,
    and `nextEventId` counter behavior.

The `JsonlEventWriter` append-only contract and `readLastEventId` tail
behavior are already covered by `tests/run/infrastructure.test.ts`
(T-EVENT-1..3) under WF-P3-RUN. After WF-P4-EVENT moves the writer into
`src/events/`, those tests continue to assert the same contract via the
re-export shim in `src/run/index.ts`. We deliberately do NOT add a second
test file here to keep the slice within budget; the writer move is a
mechanical refactor whose risk is covered by the existing P3 tests plus the
typecheck gate.

## Workflow Goal

Replace the loose `{ id, type: string, run_id, timestamp, payload: Record<string, unknown> }`
event shape currently defined in `src/run/index.ts` with a typed discriminated
union covering every event type listed in `mvp-contracts.md §2.4`. The new
module must:

1. Define `ZigmaFlowEventType` as a string union of the 17 MVP event types.
2. Define `ZigmaFlowEvent` as a discriminated union where the `type` field
   narrows `payload` to a per-type interface (architecture §18 fitness
   function: "`events` must not only save human-readable text — must save
   structured fields").
3. Expose the common event envelope fields (`id`, `run_id`, `timestamp`,
   `producer`, `job`, `step`, `attempt`) so any event can be audited and
   correlated back to the producing job / step / attempt.
4. Provide a deterministic `nextEventId(counter)` helper that yields
   `evt-001`, `evt-002`, … so engine and tests do not duplicate the
   `String(n).padStart(3, "0")` logic.
5. Move `EventWriter` + `JsonlEventWriter` from `src/run/index.ts` into
   `src/events/appendEvent.ts` and re-export them through `src/run/index.ts`
   so existing P3 callers (Engine, P3 tests) continue to compile.

P4 scope ends at the event type catalog and writer relocation. The state
consistency tests live in **WF-P4-STATE**; the artifact metadata, path
allocator and writer live in **WF-P4-ARTIFACT**.

## Module Layout

Implementation modules (created in Step 2; Step 1 only writes the tests
that import these symbols):

- `src/events/eventTypes.ts` — exports:
  - `ZigmaFlowEventType` — string union of the 17 event types.
  - One typed payload interface per event type
    (`RunCreatedPayload`, `JobReadyPayload`, `StepStartedPayload`, …).
  - `ZigmaFlowEvent` — discriminated union mapping each
    `ZigmaFlowEventType` to its envelope + typed payload.
  - `EventEnvelope` — the common fields shared by every event (`id`,
    `run_id`, `timestamp`, `producer`, `job`, `step`, `attempt`).
  - `nextEventId(counter: number): string` — `evt-NNN` formatter.
- `src/events/appendEvent.ts` — exports `EventWriter` interface and
  `JsonlEventWriter` class (moved from `src/run/index.ts`). The writer
  signature uses the new `ZigmaFlowEvent` discriminated union.
- `src/events/index.ts` — re-exports the public API of the two files above.
- `src/run/index.ts` — re-exports `EventWriter`, `JsonlEventWriter`, and
  `WorkflowEvent` (aliased to `ZigmaFlowEvent`) for backward compatibility
  with WF-P3 callers.

The tests use `import ... from "../../src/events/index.js"`.

## Event Catalog and Producers

The 17 event types and their producers (per `mvp-contracts.md §2.4` and
architecture §17 happy-path narrative):

| Event type              | Producer  | Typed payload fields (minimum)                                       |
| ----------------------- | --------- | -------------------------------------------------------------------- |
| `run_created`           | engine    | `workflow: string`, `task: string`                                   |
| `job_ready`             | engine    | `job_id: string`                                                     |
| `step_started`          | engine    | `job_id: string`, `step_id: string`, `attempt: number`               |
| `step_completed`        | engine    | `job_id: string`, `step_id: string`, `attempt: number`, `outputs: Record<string, unknown>` |
| `step_failed`           | engine    | `job_id: string`, `step_id: string`, `attempt: number`, `reason: string` |
| `prompt_generated`      | prompt    | `job_id: string`, `step_id: string`, `prompt_artifact: string`       |
| `agent_report_accepted` | engine    | `job_id: string`, `step_id: string`, `report_artifact: string`       |
| `script_completed`      | script    | `job_id: string`, `step_id: string`, `exit_code: number`, `timed_out: boolean` |
| `check_completed`       | check     | `job_id: string`, `step_id: string`, `check_id: string`, `passed: boolean` |
| `signal_received`       | engine    | `signal: string`, `from_job: string`, `from_step: string`            |
| `router_decided`        | router    | `job_id: string`, `step_id: string`, `action: string`, `target?: string` |
| `job_retrying`          | engine    | `job_id: string`, `attempt: number`, `reason: string`                |
| `job_completed`         | engine    | `job_id: string`, `attempt: number`                                  |
| `run_blocked`           | engine    | `job_id: string`, `step_id: string`, `reason: string`                |
| `run_failed`            | engine    | `reason: string`                                                     |
| `run_completed`         | engine    | (empty object)                                                       |
| `run_cancelled`         | engine    | `reason: string`                                                     |

The envelope `producer` field carries the same value at runtime and is
declared in `EventEnvelope` so the consumer never needs to look up a side
table. The `job`, `step`, and `attempt` envelope fields MAY be `null` for
run-scoped events (`run_created`, `run_completed`, `run_failed`,
`run_cancelled`, `signal_received`) — they remain part of the envelope so
schema consumers can rely on a single shape.

## Spec Compliance Matrix

The clauses below come from `mvp-contracts.md §2.4` (Event Contract). All
MUST/SHALL clauses in that section map into WF-P4-EVENT.

| #       | Clause (origin)                                                                  | Status                  | Use cases                              |
| ------- | -------------------------------------------------------------------------------- | ----------------------- | -------------------------------------- |
| RC-E01  | §2.4 — event MUST include `id` field                                             | 已纳入本工作流          | UC-EVT-ENVELOPE, UC-EVT-ROUND-TRIP-*   |
| RC-E02  | §2.4 — event MUST include `run_id` field                                         | 已纳入本工作流          | UC-EVT-ENVELOPE, UC-EVT-ROUND-TRIP-*   |
| RC-E03  | §2.4 — event MUST include `type` field (discriminator)                           | 已纳入本工作流          | UC-EVT-NARROW, UC-EVT-EXHAUSTIVE       |
| RC-E04  | §2.4 — event MUST include `timestamp` field (ISO 8601)                           | 已纳入本工作流          | UC-EVT-ENVELOPE                        |
| RC-E05  | §2.4 — event MUST include `producer` field                                       | 已纳入本工作流          | UC-EVT-ENVELOPE                        |
| RC-E06  | §2.4 — event MUST include `job` field (nullable for run-scoped events)           | 已纳入本工作流          | UC-EVT-ENVELOPE, UC-EVT-RUN-SCOPED     |
| RC-E07  | §2.4 — event MUST include `step` field (nullable for run-scoped events)          | 已纳入本工作流          | UC-EVT-ENVELOPE, UC-EVT-RUN-SCOPED     |
| RC-E08  | §2.4 — event MUST include `attempt` field (nullable for run-scoped events)       | 已纳入本工作流          | UC-EVT-ENVELOPE, UC-EVT-RUN-SCOPED     |
| RC-E09  | §2.4 — event MUST include `payload` field (typed per discriminator)              | 已纳入本工作流          | UC-EVT-NARROW, UC-EVT-ROUND-TRIP-*     |
| RC-E10  | §2.4 — catalog covers all 17 MVP event types                                     | 已纳入本工作流          | UC-EVT-CATALOG, UC-EVT-ROUND-TRIP-*    |
| RC-E11  | §2.4 验收证据 — event schema (typed) round-trips via JSON                        | 已纳入本工作流          | UC-EVT-ROUND-TRIP-*                    |
| RC-E12  | §2.4 验收证据 — append-only writer behavior                                      | 计划外（由 WF-P3-RUN T-EVENT-1..3 已覆盖；refactor 复用） | — |
| RC-E13  | §2.4 验收证据 — state-change-to-event correspondence                             | 计划外（由 WF-P3-RUN T-ENG-5/T-ENG-6 已覆盖；WF-P4-STATE 进一步深化） | — |
| RC-E14  | §2.4 验收证据 — event field snapshot or contract test                            | 已纳入本工作流          | UC-EVT-ROUND-TRIP-*, UC-EVT-ENVELOPE   |
| RC-E15  | Architecture §18 fitness function — `events` must save structured fields, not only human-readable text | 已纳入本工作流 | UC-EVT-NARROW, UC-EVT-CATALOG |

14 spec constraints referenced — within the ≤ 15 budget. Of these, 12 are
**已纳入本工作流**, 2 are **计划外（由其他工作流覆盖）** with explicit
cross-references. No clauses are marked **规范不适用**.

## Functional Points

| FP id              | Area                                  | Source                                  | Summary                                                                              |
| ------------------ | ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| FP-EVT-CATALOG     | `ZigmaFlowEventType` string union     | `mvp-contracts.md §2.4`                 | Enumerates all 17 MVP event types as a closed union (discriminator alphabet).        |
| FP-EVT-ENVELOPE    | `EventEnvelope` common fields         | `mvp-contracts.md §2.4`                 | Carries `id`, `run_id`, `timestamp`, `producer`, `job`, `step`, `attempt` for every event. |
| FP-EVT-PAYLOAD     | Typed payload interfaces (× 17)       | `mvp-contracts.md §2.4` + architecture §17 | One `XxxPayload` interface per event type; ensures structured fields.              |
| FP-EVT-UNION       | `ZigmaFlowEvent` discriminated union  | architecture §18 fitness function       | `type` narrows `payload` at the type level; ill-typed combinations fail to compile.  |
| FP-EVT-NEXT-ID     | `nextEventId(counter)` helper         | WF-P3 engine code reuse                  | Returns `evt-NNN`; centralizes the formatting so engine and tests stay consistent.   |
| FP-EVT-WRITER-MOVE | `EventWriter` / `JsonlEventWriter`    | Plan §Architecture and module changes   | Moves the existing writer from `src/run/index.ts` to `src/events/appendEvent.ts`; behavior unchanged. |

## Use Cases

| UC id                      | Actor        | Trigger                                                                                | Pre-conditions | Steps (happy path)                                                                                                              | Post-conditions / observable result                                                                                                            |
| -------------------------- | ------------ | -------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| UC-EVT-CATALOG             | Lib          | Inspect `ZigmaFlowEventType` constants / type list                                     | none           | Compile-time and run-time enumeration of all 17 type strings.                                                                   | Set equality check passes: every type in `mvp-contracts.md §2.4` is present exactly once.                                                      |
| UC-EVT-ENVELOPE            | Lib          | Construct any `ZigmaFlowEvent` literal                                                 | none           | Provide `id`, `run_id`, `type`, `timestamp`, `producer`, `job`, `step`, `attempt`, `payload`.                                   | The type checks; missing any envelope field fails to compile.                                                                                  |
| UC-EVT-RUN-SCOPED          | Lib          | Construct a `run_created` event without a job/step/attempt                             | none           | Set `job = null`, `step = null`, `attempt = null`; populate payload `{ workflow, task }`.                                       | The value is assignable to `ZigmaFlowEvent`; serializes and round-trips.                                                                       |
| UC-EVT-NARROW              | Lib          | `switch (event.type) { case "run_created": event.payload.workflow … }`                 | none           | TypeScript narrows `event.payload` to `RunCreatedPayload`; access typed fields without casts.                                   | Switch covers all 17 cases; `default: const _: never = event;` compiles (exhaustiveness).                                                      |
| UC-EVT-EXHAUSTIVE          | Lib          | Add a hypothetical 18th type string without updating the union                         | none           | TypeScript reports an error at the producing call site.                                                                         | Asserted by a compile-time check inside the test (`// @ts-expect-error`).                                                                      |
| UC-EVT-ROUND-TRIP-RUN-CREATED        | Lib | `JSON.stringify(ev)` then `JSON.parse(...)` for each of the 17 event types          | none           | Parse the JSON; assert the parsed object structurally equals the original and that `type` still narrows `payload`.              | Bytes are stable; structural equality holds; the parsed `event.type` discriminates correctly.                                                  |
| UC-EVT-ROUND-TRIP-* (16 more) | Lib       | Same as above for the remaining 16 event types                                         | none           | Same.                                                                                                                            | Same.                                                                                                                                            |
| UC-EVT-NEXT-ID-FIRST       | Lib          | `nextEventId(1)`                                                                       | none           | Format `1` → `"evt-001"`.                                                                                                       | Returns `"evt-001"`.                                                                                                                            |
| UC-EVT-NEXT-ID-SEQUENCE    | Lib          | Call `nextEventId` for counters 1, 2, 3 in order                                       | none           | Format each counter independently.                                                                                              | Returns `["evt-001", "evt-002", "evt-003"]` in order.                                                                                          |
| UC-EVT-NEXT-ID-WIDTH       | Lib          | `nextEventId(1000)` (4 digits)                                                         | none           | Format `1000` → `"evt-1000"` (no truncation; width grows past 3).                                                               | Returns `"evt-1000"`. Documents that the helper pads to 3 but does not cap.                                                                    |

## Test Mapping

| Test id               | File                                | `describe` → `it`                                                                                  | UCs covered                       | FPs covered                       | RCs touched                         |
| --------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------- | ----------------------------------- |
| T-EVT-CATALOG-1       | `tests/events/eventTypes.test.ts`   | `ZigmaFlowEventType` → `enumerates all 17 MVP event types from mvp-contracts.md §2.4`             | UC-EVT-CATALOG                    | FP-EVT-CATALOG                    | RC-E03, RC-E10                       |
| T-EVT-ENVELOPE-1      | `tests/events/eventTypes.test.ts`   | `EventEnvelope` → `requires id, run_id, type, timestamp, producer, job, step, attempt fields`     | UC-EVT-ENVELOPE                   | FP-EVT-ENVELOPE                   | RC-E01..E08                          |
| T-EVT-RUN-SCOPED-1    | `tests/events/eventTypes.test.ts`   | `EventEnvelope` → `accepts null job/step/attempt for run-scoped events`                            | UC-EVT-RUN-SCOPED                 | FP-EVT-ENVELOPE                   | RC-E06, RC-E07, RC-E08               |
| T-EVT-NARROW-1        | `tests/events/eventTypes.test.ts`   | `ZigmaFlowEvent` → `narrows payload via switch on type (discriminated union)`                      | UC-EVT-NARROW                     | FP-EVT-UNION                      | RC-E03, RC-E09, RC-E15               |
| T-EVT-NARROW-2        | `tests/events/eventTypes.test.ts`   | `ZigmaFlowEvent` → `exhaustiveness check assigns event to never in default branch`                 | UC-EVT-EXHAUSTIVE                 | FP-EVT-UNION                      | RC-E15                               |
| T-EVT-RT-1..17        | `tests/events/eventTypes.test.ts`   | `ZigmaFlowEvent JSON round-trip` → one `it` per event type (× 17)                                  | UC-EVT-ROUND-TRIP-*               | FP-EVT-PAYLOAD, FP-EVT-UNION      | RC-E09, RC-E10, RC-E11, RC-E14       |
| T-EVT-NEXT-ID-1       | `tests/events/eventTypes.test.ts`   | `nextEventId` → `formats 1 as "evt-001"`                                                           | UC-EVT-NEXT-ID-FIRST              | FP-EVT-NEXT-ID                    | —                                    |
| T-EVT-NEXT-ID-2       | `tests/events/eventTypes.test.ts`   | `nextEventId` → `is sequential when called with 1, 2, 3`                                           | UC-EVT-NEXT-ID-SEQUENCE           | FP-EVT-NEXT-ID                    | —                                    |
| T-EVT-NEXT-ID-3       | `tests/events/eventTypes.test.ts`   | `nextEventId` → `pads to at least 3 digits but does not cap at 999`                                | UC-EVT-NEXT-ID-WIDTH              | FP-EVT-NEXT-ID                    | —                                    |

## Test Design Summary

- **Framework**: vitest (`describe` / `it` / `expect`).
- **No filesystem**: the entire test file runs in-process with literal
  values; no `tmpdir` / `mkdir` / `rm`. The append-only writer behavior is
  already covered by `tests/run/infrastructure.test.ts` T-EVENT-1..3 under
  WF-P3-RUN. After WF-P4-EVENT moves the writer to `src/events/`, those
  tests continue to assert it via the re-export in `src/run/index.ts`.
- **Catalog assertion**: T-EVT-CATALOG-1 imports a runtime `EVENT_TYPES`
  tuple (frozen `readonly` array exported by `src/events/eventTypes.ts`)
  and asserts set equality against an inline literal list of the 17 type
  strings, so a future drift between the union and the runtime catalog
  breaks the test immediately.
- **Type-level assertions**: narrowing and exhaustiveness checks live
  inside the test file as helper functions consumed by `it` bodies. They
  rely on `tsc --noEmit` (run via `tsc -p tsconfig.json`) and `vitest typecheck`
  as the actual verification surface; the runtime `expect` calls double as a
  smoke test that the helper functions return.
- **`exactOptionalPropertyTypes`**: `attempt` on `EventEnvelope` and the
  optional `target` on `RouterDecidedPayload` are written via conditional
  assignment in fixtures — we never assign `undefined`. Nullable
  envelope fields (`job`, `step`, `attempt` for run-scoped events) are
  expressed as explicit `null`, not `undefined`.
- **Round-trip strategy**: each round-trip test constructs an inline
  `ZigmaFlowEvent` literal, calls `JSON.stringify` followed by
  `JSON.parse`, then asserts deep structural equality (`toEqual`) against
  the original. This proves the schema is serialization-safe and that the
  discriminator survives JSON encoding intact.
- **Red phase**: tests will not compile until Step 2 implements
  `src/events/eventTypes.ts` (`ZigmaFlowEventType`, `EventEnvelope`,
  per-type payload interfaces, `ZigmaFlowEvent` discriminated union,
  `EVENT_TYPES`, `nextEventId`). `src/events/index.ts` currently only
  re-exports `{}`, so all named imports fail to resolve. That is the
  intended Red signal.

## Test Gaps

- **JsonlEventWriter append behavior**: deferred — covered by WF-P3-RUN
  T-EVENT-1..3 against the moved module via the `src/run/index.ts`
  re-export. RC-E12 cross-reference.
- **Engine emits one event per state transition**: deferred to
  WF-P4-STATE. The matching event-vs-state-tail assertions live there
  (T-STATE-* in `tests/run/state.test.ts`). RC-E13 cross-reference.
- **End-to-end engine emit of all 17 event types**: out of scope for P4.
  The engine currently emits only `run_created` and `job_ready`; the
  remaining 15 types are emitted by future phases (P5 step execution, P6
  router/check, P7 retries/cancellation). Their producer signatures are
  fixed by the discriminated union introduced here so that those phases
  cannot drift.
- **YAML serialization**: events are JSONL only by contract; YAML
  round-trip is out of scope.
- **Producer string enum**: the `producer` field uses a string today
  (`"engine" | "script" | "check" | "router" | "prompt"`). Tightening to
  a literal union is deferred to a future phase to avoid coupling WF-P4
  to the producer taxonomy of P5/P6 step kinds. Documented here so the
  follow-up is visible.
