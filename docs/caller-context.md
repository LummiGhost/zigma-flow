# Caller Context & Permissions

Zigma Flow accepts a versioned `CallerContextV1` from Zigma Core through
`invoke --context-file`. Every accepted platform run carries a frozen copy of
that envelope, recording Core's actor, authority, task, Flow-run, project, and
permission-snapshot references. Interactive CLI runs may omit the file and do
not produce this snapshot.

## 1. Caller Context Schema

`CallerContextV1` is defined in `src/caller-context-contract.ts`; runtime
validation lives in `src/caller-context.ts`. This shared schema is the
published language between Core and Flow, rather than a Flow-specific rewrite
of Core identity fields.

| Field | Type | Description |
|---|---|---|
| `contractVersion` | literal `1` | Version discriminator; unknown or omitted versions fail closed. |
| `actor.type` | `"user" \| "agent" \| "system" \| "service"` | Core actor category. |
| `actor.id` | `string` | Unique actor identifier. |
| `capabilities` | non-empty `string[]` | Core-granted authority at dispatch. |
| `constraints` | object | Required repository/workflow/tool/branch arrays, plus optional expiry and duration. |
| `source.kind` / `source.metadata` | enum / object | Core task-origin record. |
| `taskId` / `flowRunId` / `projectId` | non-empty strings | Durable Core identities. |
| `permissionSnapshotId` / `integrityHash` | non-empty strings | Core's frozen authorization evidence. |

Optional correlation (`operationId`, `callbackCorrelationId`) and workspace
records are validated when provided. The prior unversioned
`user/project/source.system` context file is intentionally not accepted by
this protocol: it has no unambiguous Core semantics.

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

1. **Non-repudiation**: Every platform run carries an immutable Core actor, capability, constraint, and snapshot-evidence record. A reviewer can open `caller-context.json` and see the exact accepted v1 envelope.

2. **Permission time-bounding**: Because the snapshot is frozen at creation, a permission revocation after run start does not affect an in-flight run. Conversely, a permission grant after run start is not retroactively available. This prevents time-of-check-time-of-use (TOCTOU) issues.

3. **Cross-layer traceability**: Core logs can be correlated with Flow's `caller-context.json` through `taskId`, `flowRunId`, `projectId`, `permissionSnapshotId`, and `actor.id`. Discrepancies between these durable records indicate a bug or an attack.

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
