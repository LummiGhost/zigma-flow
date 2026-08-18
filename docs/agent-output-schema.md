# Agent output schema

For every Agent step, the Engine compiles the workflow step's `outputs` and
`outputs_schema` declarations into a closed JSON Schema for the canonical Agent
report envelope. Declared output keys are required; `type`, `values`/`enum`, and
`description` are preserved. A declared `returns.status` becomes an
`outputs.status` string enum — the canonical location the prompt contract
(Issue #256) directs agents to write — and a required `returns.status` makes
`outputs.status` required.

The legacy top-level `status` remains an optional property (mvp-contracts
§2.6), but its compatibility scope is narrower than "any shape passes":

- **With a required `returns.status`**, built-in backends reject a report
  that carries only the legacy top-level `status`: `outputs.status` is
  required, so the canonical location is the only one accepted at the native
  schema boundary.
- **With an optional `returns.status`**, a top-level-only report still passes
  native schema enforcement, as does an `outputs.status`-only report.
- **Boundaries without native schema enforcement** (the manual
  `acceptAgentReport`/`next` path, and custom backends that never see the
  compiled schema) accept a legacy top-level-only report even when
  `returns.status` is required — the Engine's final-line checks are the only
  enforcement there. The compiled schema never claims otherwise.
- In both cases the legacy top-level `status` itself is held to the exact
  constraint the compiled schema declares — `{ type: "string", enum:
  returns.status.values }` — on every accept path: a non-string value
  (number/null/object) is rejected without String coercion, and a string
  outside `returns.status.values` is rejected. The Engine never coerces a
  raw value into a routable status.

Because both locations are accepted, the compiler adds a Draft 2020-12
equality guard: when a report carries **both** a top-level `status` and an
`outputs.status`, the two values must be strictly equal. JSON Schema has no
general cross-field equality operator, so the compiler approximates it with
one `if`/`then` guard per declared status value (each guard fires only when
both locations are present and pins `outputs.status` to the top-level value).
The Engine's final-line validator enforces the same rule with strict equality
on every accept path — it is the authoritative final defense, since manual and
custom-runtime boundaries bypass native schema enforcement entirely.

When the same output name is declared in both `outputs` and `outputs_schema`,
the two declarations are merged per key: `outputs_schema` overlays its
`type`/`values` fields while `outputs` metadata (such as `description`) is
retained — `outputs_schema` never discards the `outputs` declaration wholesale.
The prompt-side schema and the Engine's final-line validator both derive from
this same merged declaration, so they cannot drift. The union of `outputs` and
`outputs_schema` keys is the complete output contract: every key in the union
is required, and no other key is allowed (`additionalProperties: false`). The
one additional key is the implicit `status` inside `outputs` when the step
declares `returns.status` (see "Final-line enforcement" below).

When a step declares **both** an explicit `outputs`/`outputs_schema` `status`
and a `returns.status`, a single shared merge rule folds the returns routing
domain into the explicit declaration — the compiler never silently overwrites
one with the other:

- **Compatible** declarations merge: the explicit (stricter) `values` win when
  they are a subset of `returns.status.values`, `type` stays `"string"`, and
  explicit metadata such as `description` is preserved. Both the compiled
  schema and the Engine's final-line validator enforce this exact merged
  declaration, so the native boundary and the runtime cannot drift.
- **Conflicting** declarations fail closed at compile time with
  `ValidationError` (see "Compile-time validation"): a declared `type` other
  than `"string"`, or a declared `values`/`enum` entry outside
  `returns.status.values` (unrouteable by `applyStatusReturn`).
- **Required** semantics never conflict: an explicitly declared `status` key
  is required like every declared output key — stricter than, and therefore
  compatible with, an optional `returns.status`. A required `returns.status`
  additionally requires `outputs.status` in the compiled schema.

The `artifacts` envelope field compiles as an array of **string refs**
(relative step-artifact paths or `artifact://` refs). This is the same shape
the Engine's `required_artifacts` check and the canonical prompt contract
consume; the Engine matches refs as path segments (`summary.md` matches
`docs/summary.md` but not `not-summary.md`). A non-string item in the
`artifacts` array is rejected on every accept path — the Engine enforces
`artifacts.items: { type: "string" }` exactly like the compiled schema,
instead of silently filtering the item out of the `required_artifacts` match.

The schema is written to `agent-output-schema.json` in the step attempt
directory and its SHA-256 hash is recorded in `agent.invocation.json`.

- Codex CLI receives the file through `--output-schema` and writes its final
  structured response through `--output-last-message`.
- Claude Code receives the same schema through `--json-schema`, with
  `--output-format json`; the backend extracts the structured `result` and
  writes the canonical `report.json`.

## Compile-time validation

Unsupported declarations are rejected at compile time with `ValidationError`
before the backend is invoked — the step fails as a configuration error:

- A non-object declaration (`title: "a string"`) is invalid; the YAML empty
  shorthand (`title:`) and `{}` are unconstrained declarations.
- `type` must be one of the Engine-runtime vocabulary:
  `string | number | boolean | object | array | null`. Other JSON Schema types
  (e.g. `integer`) cannot be enforced by the final-line runtime checks and are
  rejected.
- `values`/`enum` must be arrays of allowed values.
- `outputs_schema` property declarations are validated by the zod layer at
  workflow load: `description` must be a string and `enum` an array of
  strings (like `values`). A non-string `description`, or an `enum` containing
  non-string entries, is **explicitly rejected** at load time — never silently
  dropped.
- An explicit `status` declaration combined with `returns.status` must be
  compatible with the routing domain, otherwise the step fails closed before
  the backend is invoked:
  - a declared `type` other than `"string"` is rejected (status values are
    strings);
  - a declared `values`/`enum` entry outside `returns.status.values` is
    rejected (the value is unrouteable, so the native schema must not
    advertise it).

## Backend capability contract

`AgentBackend.supportsOutputSchema` is a required capability flag:

- Backends that declare `true` receive the compiled schema via
  `AgentExecuteOptions.outputSchema` and enforce it at their model/CLI
  boundary.
- The Engine fails the step **closed** before execution when a resolved
  backend does not declare `supportsOutputSchema: true` — there is no
  prompt-only fallback.
- Only the built-in backends (`claude-code`, `codex-cli`) are created for
  unregistered backend names. An unknown configured backend is a
  `ConfigError`; it is never assumed to be Claude-compatible and must be
  registered explicitly via `agentFactory.register(name, BackendClass)`
  with its own `supportsOutputSchema` declaration.

## Final-line enforcement

The Engine validates `report.json` before changing workflow state on every
accept path (the autonomous `runAll` loop and the manual accept/`next` path).
Both paths enforce the same checks in the same order, but a violation is
reported differently:

- **Manual accept (`acceptAgentReport` / `next`)**: the violation throws
  `ValidationError` and nothing is written — the job stays `running` on the
  same step, the rejected outputs are never persisted, no
  `agent_report_accepted` event is emitted, and no `on_output`/signal routing
  is dispatched.
- **Autonomous `runAll`**: the violation routes through `recordAgentFailure`
  with `errorType: "execution"` — the step fails and the job transitions to
  failed/blocked (or retries per job policy). The rejected outputs are never
  persisted and the report cannot trigger routing either.

The checks, in order:

1. `artifacts` items must all be strings (the shared report-shape gate) —
   the compiled schema declares `artifacts.items: { type: "string" }`, and
   any non-string item (object/number/null) is rejected before the
   step-contract checks run.
2. `required_artifacts` — each declared path must be present as a string ref.
3. Declared output keys must all be present — the union of `outputs` and
   `outputs_schema` keys is required, so an `outputs_schema`-only key is
   required at accept time.
4. Closed outputs object (`additionalProperties: false`) — any reported key
   outside the merged declaration is rejected before it can be persisted or
   influence routing. The one implicit key is `status` when the step declares
   `returns.status`: the prompt contract (Issue #256) directs agents to write
   `outputs.status`, so it is accepted and used for status-return dispatch.
   The compiled schema declares the same key — `outputs.properties.status`
   with the merged status enum (`returns.status.values`, or the explicit
   subset when `outputs`/`outputs_schema` declared a compatible one),
   required exactly when the key is explicitly declared or
   `returns.status.required` — so built-in backends enforce the same
   location the prompt demands. A legacy top-level `status` (mvp-contracts
   §2.6) is still accepted by the runtime (preferred, in fact, when present)
   and remains an optional property in the compiled schema; only the
   prompt-canonical `outputs.status` is enforced as required.
5. Dual-source status conflict (fail-closed) — when the step declares
   `returns.status` and the report carries **both** a top-level `status` and
   an `outputs.status`, the two values must be strictly equal. Otherwise the
   report is rejected before any state change: routing would follow the
   top-level value while the nested value is the one persisted. This mirrors
   the compiled schema's equality guard and is authoritative on every accept
   path (the native boundary is bypassed by manual accept and custom
   backends).
6. Legacy top-level status — when the step declares `returns.status`, a
   top-level `status` is held to the exact constraint the compiled schema
   declares for that location: a strict `string` within
   `returns.status.values`, with no String coercion. A number/null/object
   top-level value is rejected before any state change instead of being
   coerced into a string that happens to match a routing value.
7. Array-typed outputs (merged type `array`) reported as strings are
   normalized: JSON parse first, then newline-split fallback.
8. `type` checks run against the merged declaration after normalization —
   `outputs`-only type declarations are enforced exactly like
   `outputs_schema` ones. When `returns.status` is declared, the merged
   `status` declaration's `type: "string"` is enforced on `outputs.status`
   too — the same constraint the compiled schema applies without String
   coercion.
9. `values`/`enum` checks for `outputs` and `outputs_schema` use strict
   equality (JSON Schema semantics, no String coercion — `1` does not match
   `"1"`). An empty enum (`values: []`) matches nothing and therefore rejects
   every reported value. When `returns.status` is declared, `outputs.status`
   is held to the same merged enum the compiled schema declares — the
   explicit subset when one was declared.

Native CLI schema enforcement is an additional boundary and does not transfer
state transition ownership to an Agent backend.

## Cross-attempt determinism signal

The Engine never snapshots the workflow file — state stores only step/job ids
and the workflow is loaded fresh on every resume/retry. A user editing the
workflow's `outputs`/`outputs_schema` declarations between attempts therefore
silently changes the schema the next attempt executes under. To keep that
drift explicit in the audit trail, the Engine compares the newly compiled
schema hash against the prior attempt's recorded evidence and signals a
difference — **warn-only** (strategy D1 = A): the signal is emitted and
execution continues under the current contract, because the drift affects only
the consistency of historical audit evidence, never run state.

Checkpoint and evidence:

- The check runs in `executeAgentStep` after `compileAgentOutputSchema`
  succeeds and before `agent_invoked` is emitted (before `backend.execute`).
- Evidence is the `output_schema_sha256` field of `agent.invocation.json`
  under `jobs/<jobId>/attempts/1..N/steps/<stepId>/`. The scan covers the
  **current attempt directory too**, and runs before execution — resume and
  reset-run reuse the attempt number, so the backend would otherwise overwrite
  the only evidence.
- Backtracking runs from attempt N down to 1 and uses the **most recent
  hash-bearing** invocation: a hash-less invocation (the claude-code
  catch-path shape) does not shadow older evidence.

Degradation: if no prior invocation exists, or none carries
`output_schema_sha256`, there is no evidence to compare and the check is
skipped silently.

The hash reflects the **compiled** schema's content, whose shape depends on the
engine version that compiled it. After an engine upgrade, the same workflow may
compile to a different hash — the cross-attempt signal then truthfully records
that the audit evidence is inconsistent; it does not necessarily mean the
workflow file was edited between attempts.

Signal (all three channels):

- New event `schema_drift_detected` (mvp-contracts §2.4) with payload
  `job_id`/`step_id`/`attempt`/`prior_hash`/`new_hash`, written to the shared
  `events.jsonl` sequence before `agent_invoked`.
- A system log line via `RunLogWriter.writeSystem`.
- A `console.warn` for CLI users.

The signal never alters execution: the compiled schema, backend invocation,
and final-line validation all proceed unchanged.
