# P4 — Artifact 与 Event Log 基础 Development Plan

Date: 2026-06-08
Phase: P4
Status: Frozen
Branch: feature/p4-event-artifact

## Objective

- **Business objective:** Let outputs, logs, diff, reports and state changes be traceable — each event and artifact can be found, replayed and linked to its producer.
- **Technical objective:** Implement `src/events/` with full discriminated-union event schema and append-only writer; implement `src/artifact/` with metadata schema, path allocator, safety checks, writer and index; upgrade `src/run/` state consistency tests.

## Scope

- In scope:
  - `src/events/eventTypes.ts` — discriminated-union event types covering all 17 event types in `mvp-contracts.md §2.4`
  - `src/events/appendEvent.ts` — `EventWriter` interface + `JsonlEventWriter` implementation (moved from `src/run/index.ts`)
  - `src/events/index.ts` — re-exports public API
  - `src/artifact/artifactMetadata.ts` — `ArtifactMetadata` schema + Zod validator
  - `src/artifact/artifactPaths.ts` — path allocator + safety guard
  - `src/artifact/writeArtifact.ts` — write content + return metadata
  - `src/artifact/index.ts` — re-exports public API
  - `src/run/index.ts` — update to import `EventWriter`/`WorkflowEvent` from `events/` instead of defining them internally; keep `StateStore`, `StateError` tests
  - `tests/events/` — event schema round-trip tests
  - `tests/run/state.test.ts` — corrupted state + last_event_id mismatch tests
  - `tests/artifact/` — artifact metadata, path safety, write, index tests
  - GitHub Project items P4.1, P4.2, P4.3 → status = Done

- Out of scope:
  - Anything in MVP out-of-scope list (Docker, MCP, PR automation, remote registry, full event sourcing rebuild)
  - P5 Context Builder and Prompt generation
  - Script Step, Check Step execution

## Milestones

| Milestone | Description | Exit criteria |
| --- | --- | --- |
| M-P4-1 | Event module complete | `src/events/` has all 17 event types, writer, id helper; event round-trip tests pass |
| M-P4-2 | State consistency tests | Corrupted-state and last_event_id-mismatch fixtures → test failures correctly detected |
| M-P4-3 | Artifact module complete | `src/artifact/` has metadata, path allocator, safety guard, writer, index; path-safety tests pass |
| M-P4-GATE | All gates green | typecheck 0 errors, lint clean, all tests pass |

## Technical Approach

### Architecture and module changes

**`src/events/`** (new module, populated from empty stub):
- `eventTypes.ts` — `ZigmaFlowEventType` string union; `ZigmaFlowEvent` discriminated union with typed payloads per `mvp-contracts.md §2.4`; `EventId` string brand; `nextEventId(counter)` helper
- `appendEvent.ts` — `EventWriter` interface, `JsonlEventWriter` class (moved from `src/run/index.ts`); exports `readLastEventId`
- `index.ts` — re-exports above

**`src/artifact/`** (new module, populated from empty stub):
- `artifactMetadata.ts` — `ArtifactProducer`, `ArtifactMetadata` types; Zod schema; `artifactId(runId, job, attempt, step, filename)` generator
- `artifactPaths.ts` — `artifactStepDir(runDir, job, attempt, step)`: string; `assertPathSafe(runDir, relPath)`: void — rejects absolute paths, `..` traversal, empty
- `writeArtifact.ts` — `writeArtifact(opts): Promise<ArtifactMetadata>` — creates directory, writes content, returns metadata
- `artifactIndex.ts` — `appendArtifactIndex(runDir, metadata): Promise<void>` — appends to `artifacts.jsonl`
- `index.ts` — re-exports above

**`src/run/index.ts`** (refactor):
- Remove `WorkflowEvent`, `EventWriter`, `JsonlEventWriter` definitions (move to `events/`)
- Import from `events/index.ts` instead
- Keep `Clock`, `IdGenerator`, `StateStore`, `RunState`, `JobState`, `LocalStateStore`, `LocalRunIdGenerator`, `JsonlEventWriter` (re-export from events)
- Keep `createRunDirectory`, `writeRunYaml`, `snapshotSkillLock`

**`src/engine/index.ts`** (update imports):
- Import `EventWriter`, `JsonlEventWriter`, `WorkflowEvent` from `events/` instead of `run/`

### Data/API changes

- `WorkflowEvent` changes from `{ id, type: string, run_id, timestamp, payload }` to discriminated union with typed payloads
- `EventWriter` and `JsonlEventWriter` move to `events/` module (backward-compatible re-export from `run/`)

### Testing strategy

- `tests/events/eventTypes.test.ts` — round-trip all 17 event types; type narrowing tests
- `tests/run/state.test.ts` — corrupted JSON, last_event_id mismatch, valid round-trip
- `tests/artifact/artifactPaths.test.ts` — safe paths pass, absolute / `..` / empty paths rejected
- `tests/artifact/writeArtifact.test.ts` — file written, metadata correct, artifacts.jsonl appended

### Release / migration notes

- All changes are backward-compatible at runtime; `run/index.ts` re-exports moved types
- `engine/index.ts` import paths updated; no external API change

## Workflow Breakdown

| Workflow | Goal | Dependencies | Acceptance criteria | Research needed |
| --- | --- | --- | --- | --- |
| WF-P4-EVENT | Event schema + writer module | P3 (run/index.ts baseline) | 17 event types defined; round-trip tests pass; JsonlEventWriter appends only | None |
| WF-P4-STATE | State snapshot consistency tests | WF-P4-EVENT (last_event_id contract) | Corrupted state rejected; last_event_id mismatch rejected; atomic write verified | None |
| WF-P4-ARTIFACT | Artifact metadata + path + writer + index | WF-P4-EVENT (ArtifactMetadata uses Clock) | Path safety tests pass; write+index round-trip; `..` traversal rejected | None |

## Risks And Mitigations

| Risk | Probability | Impact | Mitigation | Owner |
| --- | --- | --- | --- | --- |
| Refactoring `run/index.ts` breaks existing P3 tests | Medium | High | Keep re-exports; run full test suite after refactor | impl agent |
| Event discriminated union makes engine imports incompatible | Low | Medium | Use backward-compatible payload shape; update engine imports | impl agent |
| Artifact path safety platform differences (Windows vs POSIX) | Medium | Medium | Use `node:path.resolve` and `node:path.relative` for normalization; test both styles | impl agent |

## Quality Bar

- Required automated tests: event round-trip × 17, state corruption × 2, artifact path safety × 5+, artifact write/index × 3+
- Required manual checks: none (pure infrastructure)
- Performance / reliability constraints: atomic state write (tmp+rename), append-only events.jsonl
- Documentation updates: none required for P4

## Open Decisions

No open decisions — all contracts frozen in `mvp-contracts.md`.

## Freeze Record

- Plan status: **Frozen**
- Frozen at: 2026-06-08
- Final decisions: Move `EventWriter`/`JsonlEventWriter`/`WorkflowEvent` from `run/` to `events/`; keep re-exports in `run/` for backward compat; implement full `src/artifact/` module from scratch
- Residual risks: None blocking
