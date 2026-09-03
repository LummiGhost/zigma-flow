# Zigma Flow Platform Integration Contract

- Contract version: `1`
- Provider: `@zigma-ai/zigma-flow`
- Baseline implementation: `0.8.12`
- Status: Published
- Architecture authority: `LummiGhost/zigma-core#12` / ADR-0001
- Tracking issue: `LummiGhost/zigma-flow#298`

## 1. Purpose and ownership

This contract is the published language between Zigma Flow and Zigma Core or a
future Execution Host. It covers invocation, machine results, platform events,
resume, cancellation, timeout, artifacts, and provider errors.

Flow exclusively owns workflow, runtime-run, job, step, attempt, iteration,
gate, artifact, and internal event state. A caller may project Flow state but
must not edit Flow's `state.json` or infer internal transitions from process
exit alone.

Contract version and package version are independent:

- `contractVersion: 1` identifies the JSON shape and semantics in this file.
- `0.8.12` is the first release baseline documented by this contract.
- Additive optional fields may be introduced without incrementing the contract
  version. Removing, renaming, changing requiredness, or changing semantics
  requires a new contract version.
- A caller must reject an unsupported version before using a result or event to
  advance platform state.

## 2. Invocation contract

### 2.1 CLI operation

```text
zigma-flow --cwd <workspace-path> invoke <workflow> \
  (--task <description> | --resume <runtime-run-id>) \
  [--backend <name>] [--parallelism <n>] [--fail-fast] \
  [--input <key=value> ...] [--context-file <absolute-path>] \
  [--event-file <absolute-path>] --json
```

`--task` creates a new Flow runtime run. `--resume` continues an existing
runtime run through the engine loop. The separate `resume` command submits
structured input to a paused human step; callers must not confuse these two
operations.

The invocation working directory is the assigned Workspace root. Flow may
write its run state under `<workspace>/.zigma-flow/runs/` and may invoke steps
only with the resolved execution context. Flow does not create or allocate the
platform Workspace.

### 2.2 Request fields

| Field / flag | Required | Semantics |
| --- | --- | --- |
| `workflow` | yes | Path or resolvable workflow reference. |
| `--task` / `--resume` | one | New user intent or existing Flow runtime-run ID. |
| `--backend` | no | Default backend override; step-level routing may override it. |
| `--parallelism` | no | In-run ready-job cap; default is 4. It is not Core task capacity. |
| `--fail-fast` | no | Abort remaining jobs in the current batch after the first failure. |
| `--input` | no | Repeated non-secret string inputs. |
| `--context-file` | platform calls | Validated caller identity, permission snapshot references, platform IDs, constraints, and callback configuration. |
| `--event-file` | no | Best-effort NDJSON projection sink in v1; see section 4. |
| `--json` | platform calls | Emits one machine result document to stdout. |

### 2.3 Caller Context v1

`--context-file` is the canonical Core-to-Flow `CallerContextV1` envelope.
It is parsed and validated before Flow creates a run, invokes a backend, or
touches a managed workspace. It is not Flow's legacy Host API identity shape.

```json
{
  "contractVersion": 1,
  "actor": { "type": "service", "id": "zigma-core" },
  "capabilities": ["task:start", "workflow:invoke"],
  "constraints": {
    "repositoryIds": ["repo_..."],
    "workflowRefs": ["code-change"],
    "toolNames": ["git", "npm"],
    "branchPatterns": ["zigma/*"],
    "maxRunDurationMs": 3600000
  },
  "source": { "kind": "api", "metadata": {} },
  "taskId": "task_...",
  "flowRunId": "flowrun_...",
  "projectId": "project_...",
  "permissionSnapshotId": "permission_...",
  "integrityHash": "sha256:...",
  "operationId": "flow:start:...",
  "callbackCorrelationId": "command_..."
}
```

Required fields are `contractVersion` (exactly `1`), `actor`, a non-empty
`capabilities` array, all four `constraints` arrays, `source.kind`,
`source.metadata`, `taskId`, `flowRunId`, `projectId`,
`permissionSnapshotId`, and `integrityHash`. `permissionSnapshotId` and
`integrityHash` are required non-empty strings: a platform invocation without
frozen Core permission evidence is rejected rather than silently downgraded.

`actor.type` is one of `user`, `agent`, `service`, or `system`. `source.kind`
is one of `api`, `web`, `mail`, `code-platform`, `schedule`, `cli`, or
`system`. Optional `operationId` and `callbackCorrelationId` preserve the
caller's durable correlation IDs. Optional `repository`, `baseRef`,
`workspacePolicy`, and `coreCallbackUrl` carry the corresponding Core records;
when present their nested fields are validated. Unknown contract versions,
unversioned legacy files, null evidence fields, and malformed required values
fail closed.

Interactive `zigma-flow invoke` without `--context-file` remains supported and
does not create a caller-context snapshot. A caller that supplies a context
file is opting into this v1 contract and must not use the prior
`user/project/source.system` shape. Once accepted, Flow freezes a deep copy in
the run directory; later caller permission changes do not mutate an active
run.

### 2.4 Idempotency

Contract v1 has no start `operationId`. Repeating `invoke --task` can create a
second runtime run and is therefore not an idempotent retry. Until a later
contract adds an operation key or status-by-operation query, an Execution Host
must persist the returned runtime run ID and must reconcile an ambiguous start
instead of blindly invoking again.

`invoke --resume <run-id>` targets an existing runtime run, but the caller must
still reject impossible or terminal transitions. Human input submission is
idempotent only for an identical decision on the same waiting step; a different
decision after resolution fails.

## 3. Machine result contract

`invoke --json` emits this version-1 shape:

```ts
interface InvokeJsonOutputV1 {
  contractVersion: 1;
  runId: string;
  status: "running" | "awaiting_human" | "completed" | "failed" | "cancelled";
  exitCode: number;
  pausedGate: {
    jobId: string;
    stepId: string;
    prompt: string;
    externalGateId?: string;
    inputSchema?: Record<string, unknown>;
    deadline?: string;
  } | null;
  artifacts: Array<{ id: string; kind: string; path: string; size: number }>;
  eventLogUri: string;
}
```

| Status | Meaning | `exitCode` field |
| --- | --- | --- |
| `running` | No terminal result was reached, including a bounded loop ending. Caller must inspect/reconcile. | `0` |
| `awaiting_human` | Run is paused at the returned gate and can accept structured input. | `0` |
| `completed` | All required jobs reached successful conclusions. | `0` |
| `failed` | Engine run failed or blocked under the current mapping. | `1` |
| `cancelled` | Engine recorded run cancellation. | `1` |

The JSON `exitCode` field is authoritative in contract v1. The process exit code
is not yet guaranteed to mirror a terminal failed/cancelled result, so a
platform caller must parse `status` and `exitCode` rather than using process
exit alone. Validation/command-line errors may exit before an invoke result is
created.

`eventLogUri` references Flow's authoritative internal event log. `artifacts`
contains indexes, not artifact bytes. Paths are provider paths; remote callers
must not assume local accessibility.

On some v1 invocation errors, Flow emits a generic failed result with
`runId: "(error)"` and no structured error detail. Stable invoke error envelopes
are an M1 contract gap; callers must retain stderr as diagnostic evidence
without mixing it into stdout JSON parsing.

## 4. Platform event contract

Every projected event has this additive version-1 envelope:

```ts
interface FlowPlatformEventV1 {
  contractVersion: 1;
  producer: "zigma-flow";
  eventId: string;
  runId: string;
  type:
    | "run.started"
    | "run.progress"
    | "run.awaiting-human"
    | "run.completed"
    | "run.failed"
    | "run.cancelled";
  occurredAt: string;
  status?: string;
  summary?: string;
  payload: Record<string, unknown>;
}
```

`eventId` is `<runId>::<internalEventId>` and is stable for a persisted internal
event. Consumers deduplicate globally by `eventId`. Events for one run preserve
the internal sequential order; events from different runs may interleave.

### 4.1 Delivery semantics

Flow's internal `events.jsonl` is the authoritative append-only log. The v1
`--event-file` path is a best-effort projection: appends are fire-and-forget and
write failures are currently dropped. It must not be described as at-least-once
delivery or used as the sole terminal acknowledgement.

An at-least-once delivery adapter must:

1. read authoritative persisted events;
2. retain the delivery cursor durably;
3. retry with the same `eventId`;
4. accept duplicate acknowledgements;
5. expose lag and terminal-delivery failure;
6. flush outstanding delivery before reporting a quiescent terminal result.

Reliable event-file flushing and/or a delivery adapter is owned by M1/M2. Core
must keep callback handling idempotent and must reject invalid state
transitions even when an event ID is new.

## 5. Resume and human input

```text
zigma-flow --cwd <workspace> resume <run-id> \
  --job <job-id> [--step <step-id>] \
  --input <key=value> ... --json
```

The `resume --json` command uses the shared command envelope:

```ts
interface CommandJsonResultV1 {
  contractVersion: 1;
  command: "resume" | "abort" | string;
  status: "success" | "error";
  runId: string;
  data: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}
```

A successful response means Flow durably accepted and applied the input. It
does not mean the resumed workflow has reached a terminal result; a caller may
then continue with `invoke --resume` or the chosen host execution loop.

## 6. Cancellation and timeout

### 6.1 In-process invocation cancellation

During `invoke`, SIGINT or an injected AbortSignal stops new scheduling,
propagates abort to active jobs, waits for the current batch through
`Promise.allSettled`, writes cancellation events/state, and returns a cancelled
summary. The terminal contract additionally requires all Flow-owned child
processes and asynchronous writers to be quiescent before cancellation is
acknowledged.

M1 must prove that requirement across timeout, fail-fast, SIGINT, concurrent
jobs, and Windows process-tree termination. A recorded `run_cancelled` event by
itself is not sufficient evidence that OS children have been reaped.

### 6.2 External abort command

```text
zigma-flow --cwd <workspace> abort --run <run-id> --reason <text> --json
```

In v1, `abort` records cancellation in the run state but does not provide an
out-of-process control channel to prove that a separately running `invoke`
process has stopped. Therefore:

- Core records cancellation as requested before invoking `abort`.
- An `abort` success is not a child-process termination acknowledgement.
- The Execution Host must signal and await the actual invoke process it owns.
- Core releases capacity and Workspace cleanup only after host/provider
  termination acknowledgement or explicit reconciliation.

### 6.3 Timeout ownership

Step timeouts are interpreted by their step executors. The overall invocation
deadline is owned by the Execution Host/Core profile. A host timeout must
trigger cancellation, bounded forced termination if graceful cancellation
fails, process wait/reaping, and reconciliation. Timeout alone must not be
projected as a Flow terminal state.

On Windows, the host and backend adapters must deliberately own stdin, stdout,
stderr, cancellation, process-tree termination, waiting, and reaping. Helper
process output must never enter stdout JSON or NDJSON protocol streams.

## 7. Error taxonomy

Shared command envelopes currently expose:

- `RUN_NOT_FOUND`
- `RUN_ALREADY_TERMINAL`
- `JOB_NOT_FOUND`
- `STEP_NOT_AWAITING`
- `ALREADY_DECIDED`
- `INVALID_INPUT`
- `STATE_CORRUPT`
- `CONFIG_ERROR`
- `INTERNAL_ERROR`

Unknown codes are permitted only as additive provider-specific failures and
must be preserved by callers. A caller classifies retryability from the
operation and documented code, not from localized stderr text.

## 8. Compatibility and negotiation

The minimum v1 feature set is:

- `invoke --json`, `--context-file`, and `--event-file`;
- invoke result `contractVersion: 1`;
- command result `contractVersion: 1` for `resume` and `abort`;
- platform event `contractVersion: 1` and `producer: "zigma-flow"`;
- stable runtime run ID and internal event log URI.

Core must bind a Flow contract version in its compatibility matrix. A package
version newer than `0.8.12` is not automatically compatible; the required
contract version and capability set must both match.

## 9. Contract evidence and gaps

| Contract area | Current executable evidence | Gap assigned forward |
| --- | --- | --- |
| Invoke result shape/status mapping | `tests/commands/invoke-json.test.ts` | Structured invoke error envelope and process-exit alignment: M1 |
| Context validation/freeze | `tests/commands/context-file.test.ts` | Cross-repository Core adapter fixture: M0.5/M2 |
| Event ID/type/envelope | `tests/events/platformEvent.test.ts` | Durable projection flush and at-least-once delivery: M1/M2 |
| Resume command envelope | `tests/commands/resume-json.test.ts` | Host retry/duplicate integration: M2 |
| Abort command envelope | `tests/commands/abort-json.test.ts` | Out-of-process termination acknowledgement: M1/M2 |
| In-process cancellation | `tests/engine/runAll-cancel.test.ts`, `tests/engine/runAll-events.test.ts`, `tests/process/lifecycle.test.ts` | Deterministic cancellation and process-tree reaping are gated by Windows CI; see `docs/windows-lifecycle-soak.md` |
| Parallel scheduling | `tests/engine/runAll-concurrent.test.ts`, `tests/dogfood/run-all-parallel.test.ts` | Repeated mixed-load coverage is gated by Windows CI; see `docs/windows-lifecycle-soak.md` |

This contract is accepted for M0 because current limitations are explicit and
assigned. It does not claim M1 reliability before the missing evidence is
green under the full suite and Windows soak workload.
