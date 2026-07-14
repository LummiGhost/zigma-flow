# Caller Context & Permissions

Zigma Flow v0.5 introduces caller context wiring into the run creation flow so every run carries a frozen permission snapshot that records who initiated the action, under what authority, and within which project scope. This document defines the schema, the Host-vs-Flow permission boundary, the creation-time snapshot mechanism, and the audit trail guarantees.

## 1. Caller Context Schema

The `CallerContext` interface captures the full identity and origin of the caller invoking a Host API method. It is defined in `src/host-api.ts` as the pure-type contract between Zigma Host (the upper platform) and Zigma Flow (the workflow engine). An implementation-compatible copy lives in `src/caller-context.ts` for engine-internal use.

| Field | Type | Description |
|---|---|---|
| `user.id` | `string` | Unique user identifier (provider-agnostic). |
| `user.name` | `string` | Display name. |
| `user.email` | `string` | Contact email. |
| `actor.type` | `"user" \| "system" \| "service"` | Actor category. |
| `actor.id` | `string` | Unique actor identifier. |
| `actor.name` | `string?` | Human-readable name (optional for system actors). |
| `source.system` | `string` | Originating system name (e.g. `"zigma-host"`, `"zigma-cli"`). |
| `source.version` | `string` | System version string. |
| `permissions` | `string[]` | Permission grants held by the caller (e.g. `["workflow:execute"]`). |
| `project.id` | `string` | Project identifier. |
| `project.scope` | `string` | Project scope / tenant. |

The `actor` may differ from `user` when a service account or system process executes on behalf of an end-user. Both identities are recorded for full auditability.

## 2. Host vs Flow Permission Boundary

Permissions in Zigma Flow are split across two distinct layers. This boundary ensures each layer enforces what it owns without leaking authority or creating circular dependencies.

### Host Responsibilities (Identity, Org, Project)

The Host (upper platform) owns:

- **Authentication**: Verifying the caller's identity (who they are).
- **Organization permissions**: Whether the caller belongs to the target organization and holds a valid role.
- **Project access**: Whether the caller can read or mutate the target project.
- **API-level authorization**: Whether the caller holds coarse-grained permissions like `workflow:execute`, `run:resume`, `run:cancel`, or `run:decide`.

These checks happen **before** the Host API method reaches the Flow engine. If any check fails, the Host returns a `HostApiError` with code `PERMISSION_DENIED` and the engine is never invoked.

### Flow Responsibilities (Step Execution, Artifacts, Filesystem)

The Flow engine (this repository) owns:

- **Step-level execution permissions**: Whether a script step is allowed to execute, based on the workflow definition's step permissions and the frozen caller context.
- **Artifact writing**: Whether an artifact kind is allowed for the current step and job.
- **Filesystem access**: Whether a step may read or write specific paths, enforced through workspace guards and the step definition.
- **Human gate decisions**: Whether a human actor recorded in the caller context matches an expected approver (informational in MVP; full enforcement deferred).

These checks happen **inside** the engine at step dispatch time. The engine reads the frozen permission snapshot from the run directory and evaluates step-level rules against it.

### Why the Boundary Matters

```
Host:
  - Authenticates the user
  - Checks org membership
  - Checks project access
  - Checks "workflow:execute" permission
  - Passes CallerContext to Flow

Flow:
  - Freezes CallerContext into a permission snapshot at run creation
  - Uses frozen snapshot at step dispatch time
  - Enforces step-level permissions (script, artifact, filesystem)
  - Records all permission evaluations in the audit trail
```

The Host never evaluates step-level rules, and Flow never authenticates users. This clean separation makes the engine reusable across different Host implementations (CLI, web dashboard, CI/CD plugin) without coupling to any particular identity provider.

## 3. Permission Snapshot

### Creation Time

The permission snapshot is created exactly once, at run creation time, inside `engine.createRun()`:

1. The Host calls `createRun` with a `callerContext` parameter.
2. If `callerContext` is provided, the engine calls `createPermissionSnapshot(callerContext, runId, clock.now())`.
3. The snapshot is deep-copied via `structuredClone` so the original object cannot be mutated after creation.
4. The snapshot is written to `caller-context.json` in the run root directory.
5. The path `"caller-context.json"` is recorded in `run.yml` under the key `caller_context_snapshot`.

If `callerContext` is **not provided** (e.g., CLI-created runs before v0.5), no snapshot is written and the `caller_context_snapshot` key is absent from `run.yml`. This maintains full backward compatibility.

### Snapshot Schema

```typescript
interface PermissionSnapshot {
  /** ISO 8601 timestamp when the snapshot was frozen. */
  frozenAt: string;
  /** Run identifier this snapshot belongs to. */
  runId: string;
  /** Deep-copied caller context at creation time. */
  callerContext: CallerContext;
}
```

### Immutability

Once written, the snapshot file is never modified by the engine. Any step that needs the caller context reads `caller-context.json` from disk and receives the same frozen record. This immutability is enforced by:

- **Deep copy at creation**: `structuredClone` severs all references to the original object.
- **Write-once semantics**: The engine never updates or overwrites `caller-context.json` after initial creation.
- **Run immutability**: Run directories are append-only for artifacts and events; state mutations go through `state.json`, never through the snapshot.

## 4. Audit Trail Guarantees

The caller context and permission snapshot provide the following audit guarantees:

1. **Non-repudiation**: Every run carries an immutable record of who initiated it and under what permissions. A reviewer can open `caller-context.json` and see the exact identity, actor, and permission set at creation time.

2. **Permission time-bounding**: Because the snapshot is frozen at creation, a permission revocation after run start does not affect an in-flight run. Conversely, a permission grant after run start is not retroactively available. This prevents time-of-check-time-of-use (TOCTOU) issues.

3. **Cross-layer traceability**: The Host's identity provider logs can be correlated with the Flow run's `caller-context.json` via `user.id` and `actor.id`. Discrepancies between the two layers indicate a bug or an attack.

4. **Evidence bundle inclusion**: When `collectRunEvidence` is called, the caller context snapshot is included in the evidence bundle, providing a complete chain from identity through execution to output.

5. **Event log correlation**: All events emitted by the engine carry timestamps that can be compared against the `frozenAt` field to verify that no state mutation preceded the snapshot.

## 5. Backward Compatibility

- **CLI callers**: The `zigma-flow run` command does not pass `callerContext`. The engine treats this as a valid case and writes no snapshot. Existing runs, tests, and workflows are unaffected.
- **Host API callers**: The `HostApiCreateRunInput` type in `src/host-api.ts` requires `callerContext` (it is non-optional in the Host API contract). The Host is responsible for constructing the caller context before invoking the engine. The engine itself accepts it as optional to support direct CLI usage.
- **Future consumers**: Any adapter that wraps the engine (e.g., a future REST API, a gRPC server) can pass `callerContext` without modifying engine internals.

## References

- `src/host-api.ts` — Pure-type Host API contract (CallerContext, Actor, HostApiError).
- `src/caller-context.ts` — Engine-internal implementation (PermissionSnapshot, createPermissionSnapshot).
- `src/engine/index.ts` — `createRun` function that wires caller context into run creation.
- `src/run/index.ts` — `RunYamlMeta` with `caller_context_snapshot` field.
