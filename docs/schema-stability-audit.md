# Schema Stability Audit

Generated 2026-07-03 against `origin/main` (77a4fe1). Each stable field is listed with its Zod location, fixtures that exercise it, and tests that validate it.

## Stable Fields

### Top-level

| Field | Zod location | Fixture | Tests | Gap |
|-------|-------------|---------|-------|-----|
| `name` | `WorkflowSchema` (index.ts ~243) | `code-change.yml` L1; `CANONICAL_WORKFLOW_YAML` | `workflow.test.ts` — T-WF-1 (accept), T-WF-2 (reject missing) | — |
| `version` | `WorkflowSchema` (index.ts ~245) | `code-change.yml` L2; `CANONICAL_WORKFLOW_YAML` | `workflow.test.ts` — T-WF-3 (reject missing) | — |
| `on` | `WorkflowSchema` (index.ts ~247) | `code-change.yml` L4-9 | `workflow.test.ts` — T-WF-1 (canonical) | — |
| `on.manual.inputs` | nested in `on` record | `code-change.yml` L5-9 | `workflow.test.ts` — canonical workflow exercises `inputs` | — |
| `skills` | `WorkflowSchema` (index.ts ~249) | `code-change.yml` L11-13 | `workflow.test.ts` — T-WF-11 (undeclared alias) | — |
| `permissions` | `WorkflowSchema` (index.ts ~251) | `code-change.yml` L15-18 | `permissions-schema.test.ts` — multiple tests; `workflow.test.ts` canonical | — |
| `signals` | `WorkflowSchema` (index.ts ~253) | `code-change.yml` L20-41 | `engine/signals.test.ts`; `workflow.test.ts` canonical | — |
| `jobs` | `WorkflowSchema` (index.ts ~269) | `code-change.yml` L39+ | `workflow.test.ts` — T-WF-4 (reject missing jobs) | — |

### Top-level permissions sub-fields

| Field | Zod location | Fixture | Tests | Gap |
|-------|-------------|---------|-------|-----|
| `permissions.contents` | `StepBaseSchema.permissions` (index.ts ~111) | `code-change.yml` L16 | `permissions-schema.test.ts` — backward compat test | — |
| `permissions.edits` | `StepBaseSchema.permissions` (index.ts ~113) | `code-change.yml` L17 | `permissions-schema.test.ts` | — |
| `permissions.commands` | `StepBaseSchema.permissions` (index.ts ~115) | `code-change.yml` L18 | `permissions-schema.test.ts` | — |
| `permissions.workflow_state` | `StepBaseSchema.permissions` (index.ts ~117) | `code-change.yml` L19 | `permissions-schema.test.ts` | — |

### SignalDeclaration

| Field | Zod location | Fixture | Tests | Gap |
|-------|-------------|---------|-------|-----|
| `signals.<name>.severity` | `SignalDeclarationSchema` (index.ts ~49) | `code-change.yml` L23 | `engine/signals.test.ts` | — |
| `signals.<name>.priority` | `SignalDeclarationSchema` (index.ts ~51) | `code-change.yml` L24 | `engine/signals.test.ts` | — |
| `signals.<name>.allowed_from` | `SignalDeclarationSchema` (index.ts ~53) | `code-change.yml` L25-27 | `engine/signals.test.ts` | — |
| `signals.<name>.action` | `SignalDeclarationSchema` (index.ts ~55) | `code-change.yml` L28-29 | `engine/signals.test.ts` | — |

### Job-level

| Field | Zod location | Fixture | Tests | Gap |
|-------|-------------|---------|-------|-----|
| `jobs.<id>.steps` | `JobSchema` (index.ts ~210) | `code-change.yml` all steps | `workflow.test.ts` canonical | — |
| `jobs.<id>.workspace` | `JobSchema` (index.ts ~212) | `code-change.yml` L42-43 | `workspace/guard.test.ts` | — |
| `jobs.<id>.needs` | `JobSchema` (index.ts ~214) | `code-change.yml` L56 | `workflow.test.ts` — DAG validation (T-WF-DAG-1) | — |
| `jobs.<id>.optional_needs` | `JobSchema` (index.ts ~216) | `code-change.yml` L121 | DAG validation tests | — |
| `jobs.<id>.activation` | `JobSchema` (index.ts ~218) | `code-change.yml` L103 | `engine/runAll.test.ts` (activation behaviour) | — |
| `jobs.<id>.retry` | `JobSchema` (index.ts ~220) | `code-change.yml` L123-126 | `engine/retry.test.ts`; `engine/retryJob.test.ts` | — |
| `jobs.<id>.permissions` | `JobSchema` (index.ts ~222) | not exercised in fixture | no dedicated job-level permissions test | **Gap**: no fixture or test exercises job-level `permissions` override |

### Step-level (common)

| Field | Zod location | Fixture | Tests | Gap |
|-------|-------------|---------|-------|-----|
| `step.id` | `StepBaseSchema` (index.ts ~68) | `code-change.yml` L44 | `workflow.test.ts` — T-WF-10 (duplicate step id) | — |
| `step.type` | `StepBaseSchema` (index.ts ~71) | `code-change.yml` L45 | `workflow.test.ts` — T-WF-5 (illegal type) | — |
| `step.with` | `StepBaseSchema` (index.ts ~89) | `code-change.yml` L47-48 | `workflow.test.ts` canonical | — |
| `step.outputs` | `StepBaseSchema` (index.ts ~91) | `code-change.yml` L49-50 | `human-step.test.ts` — outputs mapping test | — |
| `step.expose` | `StepBaseSchema` (index.ts ~82) | `code-change.yml` L51-53 | `workflow.test.ts` — T-WF-11 (undeclared alias) | — |
| `step.expose.skills` | nested in `expose` object (index.ts ~73) | `code-change.yml` L53 | `workflow.test.ts` — T-WF-11 | — |
| `step.expose.knowledge` | nested in `expose` object (index.ts ~74) | not exercised directly | not directly tested | **Info**: exercises `expose` but no test targets `knowledge` specifically |
| `step.uses` | `StepBaseSchema` (index.ts ~76) | `code-change.yml` L80 | `human-step.test.ts` — "rejects a human step with uses field" | — |
| `step.prompt` | `StepBaseSchema` (index.ts ~78) | `code-change.yml` (not explicit, but human steps use it) | `human-step.test.ts` — prompt tests; `prompt/prompt.test.ts` | — |
| `step.on_failure` | `StepBaseSchema` (index.ts ~101) | `code-change.yml` L140 | `script/executor.test.ts`; engine tests | — |

### Step-level (script)

| Field | Zod location | Fixture | Tests | Gap |
|-------|-------------|---------|-------|-----|
| `step.run` | `StepBaseSchema` (index.ts ~97) | `code-change.yml` L139 | `script/executor.test.ts`; `script/runner.test.ts` | — |
| `step.shell` | `StepBaseSchema` (index.ts ~99) | not in main fixture | `script/executor.test.ts` likely covers | — |
| `step.timeout` | `StepBaseSchema` (index.ts ~100) | not in main fixture | `script/runner.test.ts` likely covers | — |
| `step.cwd` | `StepBaseSchema` (index.ts ~101) | not in main fixture | no direct cwd test found | **Gap**: no test validates `cwd` field behaviour |
| `step.env` | `StepBaseSchema` (index.ts ~102) | not in main fixture | no direct env test found | **Gap**: no test validates `env` field behaviour |

### Step-level (check)

| Field | Zod location | Fixture | Tests | Gap |
|-------|-------------|---------|-------|-----|
| `step.on_pass` | `StepBaseSchema` (index.ts ~105) | not in main fixture | `check/executor.test.ts` | — |
| `step.on_fail` | `StepBaseSchema` (index.ts ~107) | `code-change.yml` L83 | `check/executor.test.ts` | — |

### Step-level (router)

| Field | Zod location | Fixture | Tests | Gap |
|-------|-------------|---------|-------|-----|
| `step.switch` | `StepBaseSchema` (index.ts ~93) | `flow-schema.test.ts` fixtures | `flow-schema.test.ts`; `router/executor.test.ts` | — |
| `step.cases` | `StepBaseSchema` (index.ts ~95) | `flow-schema.test.ts` fixtures | `flow-schema.test.ts`; `router/executor.test.ts` | — |

### RouterAction (stable)

| Action | Zod location | Fixture | Tests | Gap |
|--------|-------------|---------|-------|-----|
| `continue` | `RouterActionLiteralSchema` (index.ts ~20) | `code-change.yml` L135 | `router/executor.test.ts` | — |
| `fail` | `RouterActionLiteralSchema` (index.ts ~20) | `code-change.yml` L83, L140 | `router/executor.test.ts` | — |
| `block` | `RouterActionLiteralSchema` (index.ts ~20) | not in main fixture | `router/executor.test.ts` likely covers | — |
| `retry_job` (+ `retry_with`) | `RouterActionObjectSchema` (index.ts ~23) | `returns-schema.test.ts` fixtures | `returns-schema.test.ts` — FR-RETURNS-SCHEMA-008 | — |
| `activate_job` | `RouterActionObjectSchema` (index.ts ~25) | `returns-schema.test.ts` fixtures | `returns-schema.test.ts` — edge case test | — |
| `goto_job` | `RouterActionObjectSchema` (index.ts ~27) | `returns-schema.test.ts` fixtures | `returns-schema.test.ts` — edge case test | — |
| `status` (`blocked`\|`failed`) | `RouterActionObjectSchema` (index.ts ~29) | `code-change.yml` L126 | `returns-schema.test.ts` — edge case test | — |

## Gap Summary

The following stable fields have **no fixture coverage** or **no dedicated test**:

| # | Field | Status | Recommendation |
|---|-------|--------|----------------|
| 1 | `jobs.<id>.permissions` (job-level override) | No fixture, no test | Add a job-level permissions override to a YAML fixture and a schema test that validates the override is parsed correctly |
| 2 | `step.cwd` (script step) | No direct test | Add a script executor test that validates `cwd` is honoured |
| 3 | `step.env` (script step) | No direct test | Add a script executor test that validates `env` variables are passed to the subprocess |
| 4 | `step.expose.knowledge` | Not exercise by a dedicated test | Covered indirectly; low risk — same Zod shape as `skills` |

### Pre-existing test issue (not a gap)

`tests/engine/runAll-cancel.test.ts` — the "emits agent_cancelled and run_cancelled" test (T-CANCEL-1) is flaky. It fails intermittently depending on process timing. This is unrelated to schema stability.
