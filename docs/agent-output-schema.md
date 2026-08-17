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

The `artifacts` envelope field compiles as an array of **string refs**
(relative step-artifact paths or `artifact://` refs). This is the same shape
the Engine's `required_artifacts` check and the canonical prompt contract
consume; the Engine matches refs as path segments (`summary.md` matches
`docs/summary.md` but not `not-summary.md`).

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

1. `required_artifacts` — each declared path must be present as a string ref.
2. Declared output keys must all be present — the union of `outputs` and
   `outputs_schema` keys is required, so an `outputs_schema`-only key is
   required at accept time.
3. Closed outputs object (`additionalProperties: false`) — any reported key
   outside the merged declaration is rejected before it can be persisted or
   influence routing. The one implicit key is `status` when the step declares
   `returns.status`: the prompt contract (Issue #256) directs agents to write
   `outputs.status`, so it is accepted and used for status-return dispatch.
   The compiled schema declares the same key — `outputs.properties.status`
   with the `returns.status.values` enum, required exactly when
   `returns.status.required` — so built-in backends enforce the same
   location the prompt demands. A legacy top-level `status` (mvp-contracts
   §2.6) is still accepted by the runtime (preferred, in fact, when present)
   and remains an optional property in the compiled schema; only the
   prompt-canonical `outputs.status` is enforced as required.
4. Dual-source status conflict (fail-closed) — when the step declares
   `returns.status` and the report carries **both** a top-level `status` and
   an `outputs.status`, the two values must be strictly equal. Otherwise the
   report is rejected before any state change: routing would follow the
   top-level value while the nested value is the one persisted. This mirrors
   the compiled schema's equality guard and is authoritative on every accept
   path (the native boundary is bypassed by manual accept and custom
   backends).
5. Array-typed outputs (merged type `array`) reported as strings are
   normalized: JSON parse first, then newline-split fallback.
6. `type` checks run against the merged declaration after normalization —
   `outputs`-only type declarations are enforced exactly like
   `outputs_schema` ones.
7. `values`/`enum` checks for `outputs` and `outputs_schema` use strict
   equality (JSON Schema semantics, no String coercion — `1` does not match
   `"1"`). An empty enum (`values: []`) matches nothing and therefore rejects
   every reported value.

Native CLI schema enforcement is an additional boundary and does not transfer
state transition ownership to an Agent backend.
