# Human Gate Remote Channel Behavior

Reference: GitHub issue #195, mvp-contracts.md Section 7.

This document defines the expected behavior of human gate decision recording
when the decision arrives through a remote channel (API, email, web) rather than
the local CLI.

## 1. Decision Channels

When `recordHumanDecision` is called with a `source` parameter, the engine
records the channel in the decision artifact and event payload. Four channels
are defined:

| Channel | Source Value | Typical Caller                |
|---------|-------------|-------------------------------|
| CLI     | `"cli"`     | `zigma-flow approve`/`reject` |
| API     | `"api"`     | Zigma Host programmatic API   |
| Email   | `"email"`   | Email-based approval link     |
| Web     | `"web"`     | Web dashboard / UI            |

The `source` value is recorded in `human-decision.json` and appears in the
`actor.source` field for audit purposes.

## 2. Remote Request Failure

When a remote approval request fails due to a network error at the Host layer
(before reaching `recordHumanDecision`):

- **Run state:** The run remains in `awaiting_human` — no state transition
  occurs.
- **Job state:** The job's `step_status` stays `awaiting_human`.
- **Event log:** No event is written.
- **Artifact:** No `human-decision.json` is created.

The caller should retry the request. `recordHumanDecision` is idempotent for the
same decision from the same actor on the same step (see Section 5).

If the failure occurs *after* the engine has written the decision artifact but
*before* the response reaches the caller, a retry with the same parameters will
be treated as a duplicate and handled as a no-op (idempotent behavior).

## 3. Timeout Behavior

A human gate step that remains in `awaiting_human` for longer than a
configurable timeout window will be auto-rejected by the Host (not the engine).

- **MVP timeout:** No engine-level timeout exists in v0.5. The Host is
  responsible for monitoring pending gates and issuing a timeout rejection.
- **Timeout rejection:** The Host calls `approveHumanGate` with
  `decision: "reject"`, `comment: "Timed out after {duration}"`, and an
  `actor.type: "system"` to distinguish automated rejection from a human
  reviewer.
- **Configurable duration:** The timeout is a Host configuration value. The
  engine does not enforce or consume it.

Future versions may add engine-level timeout via a new `human_gate_timed_out`
event type. That is out of scope for v0.5.

## 4. Retraction

A submitted human decision cannot be retracted in the current MVP:

- Once `recordHumanDecision` succeeds and the step transitions out of
  `awaiting_human`, the decision is final.
- The engine will reject any subsequent call to `recordHumanDecision` for the
  same step with a `StateError` ("not awaiting human input").
- There is no `retract` / `undo` API in v0.5.

If retraction becomes necessary in a future version, the recommended approach
is a new `retractHumanDecision` entry that:
1. Validates the run is still active.
2. Writes a `human_decision_retracted` event.
3. Resets the step status back to `awaiting_human`.
4. Requires the `run:decide` permission plus an additional `run:retract`
   permission.

## 5. Duplicate Submission (Idempotent Behavior)

A second submission with the same decision from the same actor on the same step
is a no-op:

- **Before first decision:** If two concurrent calls arrive for a step that is
  still `awaiting_human`, both proceed. The first one to complete transitions
  the step out of `awaiting_human`. The second call will fail with `StateError`
  because the step is no longer `awaiting_human`.
- **After first decision:** Any subsequent call to `recordHumanDecision` for
  the same step will fail with `StateError` ("not awaiting human input").
- **Changing decision:** A caller cannot change a decision from "approved" to
  "rejected" (or vice versa) by submitting a second call. The engine rejects
  all calls after the first successful decision.
- **Same decision, same actor, retry:** If the Host's retry logic resends the
  exact same decision after the first one succeeded, the engine will reject it
  with `StateError`. The Host should treat this as confirmation that the
  original decision was recorded.

## 6. State Machine Diagram

```
                    +------------------+
                    | step in progress |
                    +--------+---------+
                             |
                     enterHumanGate()
                             |
                    +--------v---------+
                    |  awaiting_human  |<-----------------------------+
                    +--+---+---+-------+                              |
                       |   |   |                                      |
          +------------+   |   +------------+                         |
          |                |                |                         |
    recordHumanDecision()  |   recordHumanDecision()                  |
    decision="approved"    |   decision="rejected"                    |
          |            timeout             |                           |
          |         (Host-layer)           |                           |
          |                |                |                           |
   +------v------+   +-----v------+   +----v----+                     |
   | job running  |   |job FAILED  |   |job FAILED|                    |
   | (advance)    |   |(auto-reject)|  |          |                    |
   +--------------+   +------------+   +---------+                     |
                                                                       |
   If retraction is added in a future version:                        |
   retractHumanDecision() --> awaiting_human -------------------------+
```

### Transition Rules

1. **entering awaiting_human:** Only valid from a step that has not yet entered
   the gate. Idempotent: calling `enterHumanGate` when already `awaiting_human`
   is a no-op.

2. **approve:** Transitions the step out of `awaiting_human`, writes the
   decision artifact, and calls `advanceJob` to continue execution. The job
   remains `running`.

3. **reject:** Transitions the job to `failed`. The step is no longer
   `awaiting_human`. The router may retry the upstream job if configured.

4. **timeout:** Handled by the Host layer. The Host calls
   `recordHumanDecision` with `decision: "rejected"` and a system actor. The
   engine sees this as a normal rejection.

5. **retry after reject:** Not managed by the human gate engine. The caller
   must use the router's retry mechanism or create a new run.

## 7. Audit Trail

Every decision is recorded in three places:

1. **`human-decision.json`** — the decision artifact in the step's artifact
   directory. Contains `decision`, `actor`, `source`, `comment`,
   `custom_outputs`, `timestamp`, and `step_artifact_dir`.

2. **Event log (`events.jsonl`)** — a `human_decision` event with type,
   timestamp, and payload (job_id, step_id, decision, comment, decided_by,
   outputs).

3. **Artifact index (`artifacts.jsonl`)** — an entry with kind
   `"human_decision_record"` pointing to the decision artifact.

These three records together form a complete audit trail for every human gate
decision, regardless of the channel it arrived through.
