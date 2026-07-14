# Zigma Flow Host Integration Guide

Version: v0.1 (v0.5 Group 4, 2026-07-14)

This document is the single entry point for integrating Zigma Flow into a larger
system. It covers the Host API contract, caller context bridge, human gate
remote channel, evidence export, component boundary, and CLI adapter mapping.

## 1. Overview

### 1.1 What Is the Host API

The Host API is a TypeScript type-level contract that defines how an upper
platform (Zigma Host) invokes the Zigma Flow workflow engine. It exposes six
methods for run lifecycle management, human gate resolution, and audit evidence
collection.

The API is defined as pure TypeScript interfaces in `src/host-api.ts`. It
contains zero runtime logic and zero imports from modules with side effects. Any
consumer (Host, CLI, tests, adapters) can import these types without triggering
engine or filesystem initialization.

### 1.2 Relationship: Zigma Host and Zigma Flow

```
Zigma Host (upper platform)
  - Identity & authentication
  - Organization & project management
  - Multi-tenant permissions
  - User-facing UI / API gateway
        |
        | Host API (TypeScript interfaces)
        |
Zigma Flow (workflow engine)
  - Workflow execution & state management
  - DAG resolution & step dispatch
  - Deterministic script/check/router steps
  - Agent prompt generation & report ingestion
  - Audit event log & artifact management
```

Zigma Host is the platform layer. Zigma Flow is the embedded workflow runtime.
The Host API is the narrow, typed contract between them.

### 1.3 Design Philosophy

**Host manages identity and organization. Flow manages workflow execution.**

- The Host authenticates users, enforces organization-level permissions, and
  decides whether a user may interact with a project. Flow never
  re-authenticates -- it trusts the Host's assertion and snapshots it.
- Flow owns all workflow state transitions, step execution, DAG computation,
  and audit trail generation. The Host never inspects workflow YAML or skill
  pack manifests to make step-level decisions.
- The boundary is enforced at the type level: every mutating Host API method
  requires a `CallerContext` that captures who is calling, under what authority,
  and for which project. Flow snapshots this context and never alters it.

## 2. Host API Reference

All six methods are defined as input/result interface pairs in `src/host-api.ts`.
Each method has documented preconditions, return values, and error codes.

### 2.1 createRun

**Purpose:** Start a new workflow run.

**Parameters** (`HostApiCreateRunInput`):

| Field | Type | Description |
| --- | --- | --- |
| `workflow` | `string` | Workflow name (matches `name` field in workflow YAML) |
| `inputs` | `Record<string, string>` | Named input values keyed by the workflow's declared input names |
| `callerContext` | `CallerContext` | Caller identity, origin, and authority |

**Returns** (`HostApiCreateRunResult`):

| Field | Type | Description |
| --- | --- | --- |
| `runId` | `string` | Opaque run identifier (e.g. `"20260714-0001"`) |
| `initialStatus` | `RunStatus` | Always `"running"` |

**Preconditions:**
- The referenced workflow must exist and be valid.
- The caller must hold `workflow:execute` permission.

**Error codes:**

| Code | Condition |
| --- | --- |
| `WORKFLOW_NOT_FOUND` | Workflow name does not match any known workflow |
| `VALIDATION_FAILED` | Inputs do not match the workflow's declared input schema |
| `PERMISSION_DENIED` | Caller lacks required permissions |

### 2.2 resumeRun

**Purpose:** Resume a suspended or blocked run.

**Parameters** (`HostApiResumeRunInput`):

| Field | Type | Description |
| --- | --- | --- |
| `runId` | `string` | Run identifier to resume |
| `callerContext` | `CallerContext` | Caller identity, origin, and authority |

**Returns** (`HostApiResumeRunResult`):

| Field | Type | Description |
| --- | --- | --- |
| `runId` | `string` | The resumed run identifier |
| `status` | `RunStatus` | Run status after resumption |
| `resumedJobIds` | `string[]` | Job IDs that transitioned from blocked/suspended back to ready/running |

**Preconditions:**
- The run must exist and be in a non-terminal state (`"blocked"` or implicitly running).
- Resuming a terminal run (`"completed"`, `"cancelled"`, `"failed"`) is an error.
- The caller must hold `run:resume` permission.

**Error codes:**

| Code | Condition |
| --- | --- |
| `RUN_NOT_FOUND` | Run ID is unknown |
| `INVALID_STATE` | Run is in a terminal state |
| `PERMISSION_DENIED` | Caller lacks required permissions |

### 2.3 getRunStatus

**Purpose:** Read the full status of a run. This is the primary read path -- it
returns everything the Host needs to render a run detail view in a single call.

**Parameters:** Run identifier.

**Returns** (`HostApiGetRunStatusResult`):

| Field | Type | Description |
| --- | --- | --- |
| `runId` | `string` | Run identifier |
| `status` | `RunStatus` | Current run status |
| `workflow` | `string` | Workflow name |
| `task` | `string` | Task description from run creation |
| `createdAt` | `string` | ISO 8601 creation timestamp |
| `updatedAt` | `string?` | ISO 8601 timestamp of most recent state mutation |
| `jobs` | `HostApiJobSummary[]` | All jobs with current summaries |
| `pendingHumanGates` | `PendingHumanGate[]` | Human gates currently awaiting a decision |
| `latestEventSummary` | `HostApiEventSummary` | Tail-of-log event summary |
| `artifactIndex` | `HostApiArtifactIndexSummary` | Artifact index summary |

**Job summary fields** (`HostApiJobSummary`): `jobId`, `status`, `currentStep`,
`attempt`, `stepStatus`, `outputs`.

**Pending human gate fields** (`PendingHumanGate`): `jobId`, `stepId`, `prompt`,
`approvers`, `instructions`, `enteredAt`.

### 2.4 approveHumanGate

**Purpose:** Resolve a human gate step with a decision.

**Parameters** (`HostApiApproveHumanGateInput`):

| Field | Type | Description |
| --- | --- | --- |
| `runId` | `string` | Run identifier |
| `jobId` | `string` | Job containing the human gate step |
| `stepId` | `string` | Step awaiting a human decision |
| `decision` | `Decision` | `"approve"`, `"reject"`, or `"request_changes"` |
| `comment` | `string?` | Optional explanation of the decision |
| `actor` | `Actor` | The actor issuing the decision (recorded in audit trail) |

**Returns** (`HostApiApproveHumanGateResult`):

| Field | Type | Description |
| --- | --- | --- |
| `runId` | `string` | Run identifier |
| `jobId` | `string` | Job identifier |
| `stepId` | `string` | Step identifier |
| `decision` | `Decision` | The decision that was recorded |
| `recordedAt` | `string` | ISO 8601 timestamp when the decision was recorded |
| `nextAction` | `"continue" \| "blocked" \| "completed"` | What happens next |

**Preconditions:**
- The referenced run, job, and step must exist.
- The step must be in `step_status: "awaiting_human"`.
- The caller must hold `run:decide` permission.

**Error codes:**

| Code | Condition |
| --- | --- |
| `RUN_NOT_FOUND` | Run ID is unknown |
| `JOB_NOT_FOUND` | Job ID is unknown |
| `STEP_NOT_FOUND` | Step ID is unknown |
| `NOT_AWAITING_HUMAN` | Step is not in the awaiting_human state |
| `PERMISSION_DENIED` | Caller lacks required permissions |

### 2.5 cancelRun

**Purpose:** Cancel an active run.

**Parameters** (`HostApiCancelRunInput`):

| Field | Type | Description |
| --- | --- | --- |
| `runId` | `string` | Run identifier to cancel |
| `reason` | `string` | Human-readable reason for cancellation |
| `actor` | `Actor` | The actor requesting cancellation (recorded in audit trail) |

**Returns** (`HostApiCancelRunResult`):

| Field | Type | Description |
| --- | --- | --- |
| `runId` | `string` | The cancelled run identifier |
| `previousStatus` | `"running" \| "blocked"` | Status before cancellation |
| `newStatus` | `"cancelled"` | Always `"cancelled"` |
| `cancelledAt` | `string` | ISO 8601 timestamp |
| `reason` | `string` | Reason supplied with the request |
| `cancelledBy` | `Actor` | Actor who requested cancellation |

**Preconditions:**
- The run must exist and be in `"running"` or `"blocked"` status.
- Cancelling a terminal run is an error.
- The caller must hold `run:cancel` permission.

**Error codes:**

| Code | Condition |
| --- | --- |
| `RUN_NOT_FOUND` | Run ID is unknown |
| `ALREADY_TERMINAL` | Run is already completed, cancelled, or failed |
| `PERMISSION_DENIED` | Caller lacks required permissions |

### 2.6 collectRunEvidence

**Purpose:** Produce a complete evidence bundle for audit, compliance review, or
downstream analysis. Aggregates data from run state, event log, artifact index,
validation records, and human decision records.

**Parameters:** Run identifier.

**Returns** (`HostApiCollectEvidenceResult`):

| Field | Type | Description |
| --- | --- | --- |
| `summary` | `RunEvidenceSummary` | Top-level run summary |
| `events` | `EventEvidenceEntry[]` | Filtered event log entries |
| `artifacts` | `ArtifactIndexEntry[]` | All artifact index entries |
| `validation` | `ValidationEvidence[]` | Check-type step validation results |
| `humanDecisions` | `HumanDecisionEvidence[]` | Recorded human gate decisions |
| `knownRisks` | `KnownRisk[]` | Risks surfaced by the engine |

**Summary fields** (`RunEvidenceSummary`): `runId`, `workflow`, `task`, `status`,
`createdAt`, `completedAt`, `totalJobs`, `completedJobs`, `failedJobs`, `totalEvents`.

### 2.7 Error Shape

All methods return errors as a flat, serializable `HostApiError`:

```typescript
interface HostApiError {
  code: string;      // machine-readable, stable across versions
  message: string;   // human-readable
  details?: Record<string, unknown>;  // best-effort diagnostic data
  suggestion?: string;  // optional resolution hint
}
```

### 2.8 TypeScript Types

All types are imported from `src/host-api.ts`. The file exports:

```
CallerContext
Actor
Decision
RunStatus
HostApiCreateRunInput / HostApiCreateRunResult
HostApiResumeRunInput / HostApiResumeRunResult
HostApiJobSummary
PendingHumanGate
HostApiEventSummary
HostApiArtifactIndexSummary / HostApiArtifactIndexEntry
HostApiGetRunStatusResult
HostApiApproveHumanGateInput / HostApiApproveHumanGateResult
HostApiCancelRunInput / HostApiCancelRunResult
RunEvidenceSummary
EventEvidenceEntry
ArtifactIndexEntry
ValidationEvidence
HumanDecisionEvidence
KnownRisk
HostApiCollectEvidenceResult
HostApiError
CancellableRunStatus
```

## 3. Caller Context

### 3.1 Bridging Host and Flow

Every Host API method that mutates state requires a `CallerContext`. This object
carries identity, origin, and authority from the Host to Flow, and is snapshotted
at run creation time to provide an immutable audit record.

### 3.2 Schema

```typescript
interface CallerContext {
  user: {
    id: string;
    name: string;
    email: string;
  };
  actor: Actor;            // may differ from user for service accounts
  source: {
    system: string;         // e.g. "zigma-host", "zigma-cli"
    version: string;
  };
  permissions: string[];    // Host-level grants
  project: {
    id: string;
    scope: string;
  };
}

interface Actor {
  type: "user" | "system" | "service";
  id: string;
  name?: string;
}
```

### 3.3 Permission Division

| Concern | Owner | Enforcement Point |
| --- | --- | --- |
| Identity authentication | **Host** | Before any Flow call |
| Organization membership | **Host** | Before project access |
| Project access | **Host** | Before run creation |
| Feature flags / roles | **Host** | Before run creation |
| Script execution | **Flow** | Step execution |
| Artifact writing | **Flow** | Artifact manager |
| Filesystem access | **Flow** | Workspace guard |
| Workflow variable write | **Flow** | applyContextPatch |
| Context block write | **Flow** | applyContextPatch |

### 3.4 Snapshot Behavior

When `createRun` receives a `CallerContext`:
- A `caller-context.json` file is written to the run directory.
- The snapshot is immutable -- no engine operation ever reads or modifies it after creation.
- If no `callerContext` is provided (e.g. direct CLI usage), no snapshot is written and the run proceeds normally. This supports backward compatibility.

For the complete specification, see `docs/caller-context.md`.

## 4. Human Gate Remote Channel

### 4.1 How Human Gates Work Remotely

Human gate steps pause workflow execution and wait for a human decision. While
the CLI provides local `zigma-flow approve` and `zigma-flow reject` commands, a
Host integration enables remote decision channels.

When a human gate step is entered, the engine:
1. Records a `human_gate_waiting` event with the gate prompt, approvers, and instructions.
2. The step enters `step_status: "awaiting_human"`.
3. The job (and potentially the run) is marked as `blocked` until a decision arrives.

The Host monitors `pendingHumanGates` via `getRunStatus` and presents the
decision prompt to the appropriate reviewer through any available channel.

### 4.2 Decision Channels

| Channel | Description | Latency |
| --- | --- | --- |
| CLI | `zigma-flow approve --job <id>` or `zigma-flow reject --job <id>` | Immediate |
| API | Host API `approveHumanGate` method | Near-real-time |
| Email | Host sends gate prompt via email; reviewer replies with decision | Minutes to hours |
| Web | Host renders a web UI for the reviewer to inspect artifacts and decide | Immediate to minutes |

The Flow engine is channel-agnostic: it only cares that a decision arrives via
`approveHumanGate` with the correct `runId`, `jobId`, and `stepId`.

### 4.3 Remote Failure, Timeout, and Idempotency

- **Timeout:** Human gates have no built-in timeout in v0.5. The Host is
  responsible for implementing escalation policies (e.g. remind after 24h,
  escalate after 72h).
- **Duplicate decisions:** Submitting the same decision for the same step
  multiple times is idempotent. The engine records the first decision and
  returns the same result for subsequent calls.
- **Decision after state change:** If the run has moved past the gate (e.g.
  cancelled), the engine returns `INVALID_STATE`.
- **Network failure:** The Host should retry `approveHumanGate` with exponential
  backoff. The idempotency guarantee means a retry is safe.

For the complete specification, see `docs/human-gate-remote.md`.

## 5. Evidence Export

### 5.1 Evidence Bundle Format

`collectRunEvidence` produces a `HostApiCollectEvidenceResult` containing six
data categories:

```
HostApiCollectEvidenceResult
├── summary: RunEvidenceSummary        (top-level run overview)
├── events: EventEvidenceEntry[]       (filtered event log)
├── artifacts: ArtifactIndexEntry[]    (all artifact metadata)
├── validation: ValidationEvidence[]   (check step results)
├── humanDecisions: HumanDecisionEvidence[]  (gate decisions)
└── knownRisks: KnownRisk[]            (engine-surfaced risks)
```

Each category is self-contained and serializable. The bundle is designed to be
passed directly to rendering adapters without further transformation.

### 5.2 Using collectEvidence

```typescript
// Conceptual usage (actual implementation in src/evidence/)
const bundle = await collectRunEvidence({ runId: "20260714-0001" });

// bundle.summary.totalJobs        → 9
// bundle.summary.completedJobs    → 7
// bundle.summary.failedJobs       → 1
// bundle.summary.totalEvents      → 142
// bundle.events.length            → 142
// bundle.artifacts.length         → 35
// bundle.validation.length        → 3
// bundle.humanDecisions.length    → 2
// bundle.knownRisks.length        → 1
```

### 5.3 Rendering Adapters

The evidence bundle can be rendered into different output formats through
adapters (defined in `src/evidence/`):

| Adapter | Output | Use Case |
| --- | --- | --- |
| Email summary | Plain text with summary stats and risk highlights | Notify stakeholders when a run completes |
| PR description | Markdown with job summaries and decision log | Auto-populate PR body after code-change workflow |
| Issue comment | Markdown with validation failures and risks | Post review findings to an issue tracker |
| Audit report | Structured Markdown with full event log and artifact index | Compliance review, incident post-mortem |

Each adapter consumes the same `HostApiCollectEvidenceResult` type and produces
a different output format. The evidence bundle itself is format-agnostic.

## 6. Zigma Component Boundary

### 6.1 What Zigma Flow DOES

| Responsibility | Description |
| --- | --- |
| Workflow execution | Load workflow YAML, resolve DAG, advance steps and jobs |
| State management | Own `state.json`, enforce state transitions, persist snapshots |
| Deterministic steps | Execute script steps (commands), check steps (validation), router steps (control flow) |
| Agent prompt generation | Build context, render Markdown prompt for agent steps |
| Agent report ingestion | Parse report.json, extract outputs/signals/status/patches |
| Human gate lifecycle | Enter gate, record decision, advance or block accordingly |
| Audit trail | Append events.jsonl, maintain artifact index, snapshot caller context |
| Skill pack resolution | Load and validate skill manifests, resolve lockfiles |
| Workspace safety | Enforce read-only/writable modes, detect forbidden paths |

### 6.2 What Zigma Flow Does NOT Do

| Non-Responsibility | Where It Lives |
| --- | --- |
| User authentication (login, tokens, SSO) | Zigma Host |
| Organization and project management | Zigma Host |
| Multi-tenant permission enforcement | Zigma Host |
| Email sending | Zigma Host or external service |
| PR / Issue creation on GitHub or GitLab | Zigma Host or external service |
| Remote sandbox scheduling (Docker, VMs) | Zigma Host or external scheduler |
| Workflow YAML authoring UI | External editor or future web UI |
| Agent LLM execution (Claude Code, Codex) | External agent backend |
| Remote Skill Registry hosting | Future Zigma service |

### 6.3 Boundary Table

| Action | Who Owns It | Who Calls It |
| --- | --- | --- |
| User clicks "Run Workflow" | Host | Host calls `createRun` |
| Workflow reaches a human gate | Flow | Host reads `getRunStatus` |
| Reviewer approves via web UI | Host | Host calls `approveHumanGate` |
| Reviewer approves via CLI | Flow (local) | User runs `zigma-flow approve` |
| Run completes | Flow | Host polls `getRunStatus` or receives webhook |
| Stakeholder wants audit report | Host | Host calls `collectRunEvidence` |
| Agent step needs prompt | Flow | Host reads prompt artifact or CLI generates it |
| Script step runs lint | Flow | Engine executes; Host is not involved |

## 7. CLI as Local Adapter

### 7.1 Relationship to Host API

The Zigma Flow CLI (`zigma-flow`) is a **local implementation** of the Host API
contract. Each CLI command maps to one or more Host API concepts, but the CLI
adds local conveniences: filesystem access, terminal formatting, and direct user
interaction.

The CLI is **not** a replacement for the Host API. It is a local adapter that
implements the same engine entry points that a Host would call remotely. When a
Host integration exists, the Host calls the Typed API directly; the CLI remains
available for local development and debugging.

### 7.2 Command-to-API Mapping

| CLI Command | Host API Equivalent | Notes |
| --- | --- | --- |
| `zigma-flow run <wf> --task <task>` | `createRun` | CLI also handles directory creation, lock snapshots |
| `zigma-flow run-all <wf> --task <task>` | `createRun` + loop | CLI runs the full automated loop start-to-finish |
| `zigma-flow run-all <wf> --resume <id>` | `resumeRun` | Resumes from blocked/suspended state |
| `zigma-flow status` | `getRunStatus` | CLI renders to terminal; API returns structured data |
| `zigma-flow status --verbose` | `getRunStatus` (with job details) | CLI expands step-level details |
| `zigma-flow show <run-id>` | `getRunStatus` + events | CLI combines status + recent events + artifacts |
| `zigma-flow prompt --job <job>` | (Host reads prompt artifact) | CLI generates and writes prompt Markdown |
| `zigma-flow step --job <job>` | (Engine executeCurrentStep) | CLI dispatches script/check/router step |
| `zigma-flow next --job <job>` | (Engine acceptAgentReport) | CLI ingests report and advances |
| `zigma-flow approve --job <id>` | `approveHumanGate` (decision: "approve") | CLI resolves human gate locally |
| `zigma-flow reject --job <id>` | `approveHumanGate` (decision: "reject") | CLI resolves human gate locally |
| `zigma-flow abort [--reason]` | `cancelRun` | CLI cancels run without deleting artifacts |
| `zigma-flow retry --job <id>` | (Engine retryJob) | CLI triggers job retry with optional inputs |
| `zigma-flow list-runs` | (Host queries run directory) | CLI lists all runs in `.zigma-flow/runs/` |
| `zigma-flow events <run-id>` | (Host reads events.jsonl) | CLI shows recent events from the event log |
| `zigma-flow artifacts <run-id>` | (Host reads artifacts index) | CLI lists artifact metadata |
| `zigma-flow verify-run <run-id>` | (Host runs integrity check) | CLI validates state/event/artifact consistency |
| `zigma-flow validate <path>` | (Host validates workflow before createRun) | CLI validates workflow YAML or skill manifest |
| `zigma-flow init` | (Host initializes project) | CLI creates `.zigma-flow/` directory structure |
| `zigma-flow doctor` | (Host diagnostics) | CLI diagnoses environment and configuration |
| `zigma-flow skill add <path>` | (Host manages skill registry) | CLI registers a local skill pack |

### 7.3 Caller Context in CLI Mode

When used directly via CLI (without a Host), no `CallerContext` is provided.
This means:
- No `caller-context.json` is written to the run directory.
- The `caller_context_snapshot` field in `run.yml` is absent.
- The run proceeds normally with no caller context recorded.

When the Host calls Flow via the API, a full `CallerContext` is provided and
snapshotted. This is the recommended path for production deployments where audit
trails are required.

### 7.4 Adding a New Host API Method

When adding a new Host API method, follow this pattern:

1. Define the input and result interfaces in `src/host-api.ts`.
2. Implement the engine entry point in `src/engine/`.
3. Expose a CLI command in `src/cli.ts` and `src/commands/`.
4. Update the mapping table in this document (Section 7.2).
5. If the method mutates state, require `CallerContext` in the API signature.
6. Document preconditions, return values, and error codes in the JSDoc and in this document (Section 2).

## 8. Related Documents

| Document | Content |
| --- | --- |
| `src/host-api.ts` | All Host API TypeScript interfaces and types |
| `docs/caller-context.md` | Full caller context specification and permission boundary |
| `docs/human-gate-remote.md` | Human gate remote channel specification |
| `docs/architecture.md` | System architecture, module boundaries, state machine |
| `docs/prd.md` | Product requirements and design rationale |
| `docs/mvp-contracts.md` | MVP execution contracts and DoD |
| `src/evidence/` | Evidence bundle assembly and rendering adapters |
