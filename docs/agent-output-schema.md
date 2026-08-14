# Agent output schema

For every Agent step, the Engine compiles the workflow step's `outputs` and
`outputs_schema` declarations into a closed JSON Schema for the canonical Agent
report envelope. Declared output keys are required; `type`, `values`/`enum`, and
`description` are preserved. A required `returns.status` becomes a required
top-level `status` enum.

The schema is written to `agent-output-schema.json` in the step attempt
directory and its SHA-256 hash is recorded in `agent.invocation.json`.

- Codex CLI receives the file through `--output-schema` and writes its final
  structured response through `--output-last-message`.
- Claude Code receives the same schema through `--json-schema`, with
  `--output-format json`; the backend extracts the structured `result` and
  writes the canonical `report.json`.

The Engine still validates `report.json` before changing workflow state. Native
CLI schema enforcement is an additional boundary and does not transfer state
transition ownership to an Agent backend.

Custom backends receive the compiled schema as `AgentExecuteOptions.outputSchema`.
They must enforce it at their model/CLI boundary and return a canonical report;
prompt-only schema enforcement is not a supported implementation strategy.
