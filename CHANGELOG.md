# Changelog

All notable changes to Zigma Flow are documented in this file.

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
