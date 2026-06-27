# WF-P13-VARIABLES Step 1: Use Cases and Tests

## Overview

This document enumerates all use cases, provides a specification compliance matrix against AD-P13-010 and AD-P13-011, and maps each test requirement to its corresponding test file and test case ID.

**Scope**: Workflow-level variables and context blocks with a permission model controlled via `allowed_writers` and step `permissions` sub-fields, independent of file editing permissions.

**Implementation PRs**: AD-P13-010 (Variables), AD-P13-011 (Context Blocks)

## Use Cases

### UC-VAR-001: Declare Workflow Variables
A workflow author defines top-level `variables` with type, optional initial value, optional enum constraints, and an `allowed_writers` list of step references (`<job>.<step>` or `<job>.*`). These variables live in `RunState.variables` and are initialized from `initial` values when the run is created.

### UC-VAR-002: Declare Context Blocks
A workflow author defines top-level `context_blocks` with optional `initial_artifact` and an `allowed_writers` list. These blocks live in `RunState.context_blocks` and store versioned artifact references.

### UC-VAR-003: Agent Reads Variables via Prompt
During `buildContext`, variables that the current step is permitted to read (via `permissions.variables.read`) are injected into the prompt context as a `## Variables` section. Variables not in the read list are excluded.

### UC-VAR-004: Agent Reads Context Blocks via Prompt
During `buildContext`, context blocks that the current step is permitted to read (via `permissions.context_blocks.read`) are injected into the prompt context as a `## Context Blocks` section. If the step also has write permission, a writable annotation is included.

### UC-VAR-005: Agent Sets a Variable
An agent submits `context_patches` in its report with `kind: "variable_set"`. The engine validates the step is in the variable's `allowed_writers`, validates the value against the variable's type and (if present) enum, then writes to `state.variables` and emits a `variable_set` event.

### UC-VAR-006: Agent Deletes a Variable
An agent submits `context_patches` with `kind: "variable_delete"`. The engine validates the step is in the variable's `allowed_writers`, removes the key from `state.variables`, and emits a `variable_deleted` event.

### UC-VAR-007: Agent Sets a Context Block
An agent submits `context_patches` with `kind: "context_block_set"`. The engine validates the step is in the context block's `allowed_writers`, writes a new versioned artifact to `context-blocks/<block-id>/v<N>.md`, updates `state.context_blocks` with incremented version number, and emits a `context_block_updated` event.

### UC-VAR-008: Agent Appends to a Context Block
An agent submits `context_patches` with `kind: "context_block_append"`. Same as set, but the new content is appended to the previous version's content before writing.

### UC-VAR-009: Agent Deletes a Context Block
An agent submits `context_patches` with `kind: "context_block_delete"`. The engine validates the step is in the block's `allowed_writers`, removes the block from `state.context_blocks`, and emits a `context_block_deleted` event.

### UC-VAR-010: Batch Atomicity
Multiple patches in one `context_patches` array are applied as a batch. If any single patch fails validation (permission denied, wrong type, invalid enum value, reserved field touch), the entire batch is rolled back -- no state, event, or artifact mutations persist.

### UC-VAR-011: Wildcard Writer Permission
The `allowed_writers` field supports `<job>.*` as a wildcard meaning any step in job `<job>`. This is validated at workflow load time and enforced at patch application time.

### UC-VAR-012: Permission Model Enforcement
Step `permissions` sub-fields control access:
- `permissions.variables: { read: [...], write: [...] }` -- fine-grained variable access
- `permissions.context_edit: "none" | "read" | "write"` -- coarse-grained context block access
- `permissions.context_blocks: { read: [...], write: [...] }` -- fine-grained context block access

`context_edit: "none"` means all `context_patches` from that step are rejected regardless of individual `allowed_writers`.

### UC-VAR-013: Pipeline Order (AD-P13-013)
`applyContextPatch` is called after outputs are written but before status/signal handling in `acceptAgentReport`. If patches fail, step transitions to `step_failed` and status/signals are not processed.

### UC-VAR-014: Non-Context-Patch Steps
Steps that do not submit `context_patches` (null/undefined/empty array) pass through the patch stage with no effect (no-op).

### UC-VAR-015: Variable Type Enforcement
Variables have a `type` field that constrains what values can be set. Supported types: `string`, `number`, `boolean`, `array`. Setting a value of the wrong type causes a `ValidationError`.

### UC-VAR-016: Variable Enum Enforcement
Variables with an `enum` field constrain values to the listed options. Setting a value not in the enum causes a `ValidationError`.

### UC-VAR-017: Reserved Field Protection
Patches that attempt to modify reserved state fields (e.g., `state.jobs`, `state.run_id`, `state.last_event_id`) are rejected with `ValidationError`.

### UC-VAR-018: Expression Resolution -- Variables
The expression resolver (`${{ variables.<name> }}`) resolves to the current value of the named variable. Unknown variables are left as literal text (no crash).

### UC-VAR-019: Expression Resolution -- Step Outputs (TD-P9-001/002)
The expression resolver supports `${{ jobs.<id>.outputs.<key> }}` and `${{ steps.<id>.outputs.<key> }}` for referencing upstream job/step outputs. Missing references are left as literal text.

### UC-VAR-020: Expression Boolean Operators
The expression resolver supports boolean/equality operators (`==`, `!=`, `&&`, `||`, `!`) for use in step `if:` condition evaluation. A separate `evaluateCondition` function returns a boolean.

### UC-VAR-021: Context Block Artifact Versioning
Context block artifacts are versioned: `v1`, `v2`, ... in the path `context-blocks/<block-id>/v<N>.md`. Old versions are never overwritten; each new write creates a new version.

## Specification Compliance Matrix

### AD-P13-010: Workflow Variables

| Requirement | Description | Test IDs | Status |
|---|---|---|---|
| AD-P13-010-REQ-01 | Top-level `variables` schema with type, initial, enum, allowed_writers | FR-VAR-SCHEMA-001 through FR-VAR-SCHEMA-010 | Step 1 (tests written) |
| AD-P13-010-REQ-02 | Step `permissions.variables` sub-field | FR-PERM-SCHEMA-001, FR-PERM-SCHEMA-005 | Step 1 (tests written) |
| AD-P13-010-REQ-03 | `allowed_writers` references real steps (`<job>.<step>` or `<job>.*`) | FR-VAR-SCHEMA-006, FR-VAR-SCHEMA-007 | Step 1 (tests written) |
| AD-P13-010-REQ-04 | Run state initialization from `variables.*.initial` | FR-PATCH-001 (indirect, via state initialization) | Step 1 (pipeline test) |
| AD-P13-010-REQ-05 | `variable_set` engine operation with permission check | FR-PATCH-001, FR-PATCH-002 | Step 1 (tests written) |
| AD-P13-010-REQ-06 | `variable_delete` engine operation | FR-PATCH-003 | Step 1 (tests written) |
| AD-P13-010-REQ-07 | Type enforcement on variable_set | FR-PATCH-011 | Step 1 (tests written) |
| AD-P13-010-REQ-08 | Enum enforcement on variable_set | FR-PATCH-012 | Step 1 (tests written) |
| AD-P13-010-REQ-09 | Batch atomicity (rollback on any failure) | FR-PATCH-008 | Step 1 (tests written) |
| AD-P13-010-REQ-10 | Reserved field protection | FR-PATCH-009 | Step 1 (tests written) |
| AD-P13-010-REQ-11 | Wildcard `<job>.*` writer permission | FR-PATCH-010 | Step 1 (tests written) |
| AD-P13-010-REQ-12 | Variables injected into prompt context | FR-CTX-INJECT-001 through FR-CTX-INJECT-003 | Step 1 (tests written) |
| AD-P13-010-REQ-13 | `${{ variables.<name> }}` expression resolution | FR-EXPR-VAR-001 through FR-EXPR-VAR-003 | Step 1 (tests written) |
| AD-P13-010-REQ-14 | `variable_set` event emission | FR-PATCH-001 | Step 1 (tests written) |
| AD-P13-010-REQ-15 | `variable_deleted` event emission | FR-PATCH-003 | Step 1 (tests written) |
| AD-P13-010-REQ-16 | Pipeline integration in acceptAgentReport | FR-PIPELINE-001 through FR-PIPELINE-006 | Step 1 (tests written) |

### AD-P13-011: Context Blocks

| Requirement | Description | Test IDs | Status |
|---|---|---|---|
| AD-P13-011-REQ-01 | Top-level `context_blocks` schema with initial_artifact, allowed_writers | FR-VAR-SCHEMA-002, FR-VAR-SCHEMA-008 | Step 1 (tests written) |
| AD-P13-011-REQ-02 | Step `permissions.context_blocks` sub-field | FR-PERM-SCHEMA-003 | Step 1 (tests written) |
| AD-P13-011-REQ-03 | Step `permissions.context_edit` sub-field | FR-PERM-SCHEMA-002, FR-PERM-SCHEMA-004 | Step 1 (tests written) |
| AD-P13-011-REQ-04 | Run state initialization from `context_blocks.*.initial_artifact` | (via createRun extension, tested in pipeline tests) | Step 2 |
| AD-P13-011-REQ-05 | `context_block_set` engine operation | FR-PATCH-004 | Step 1 (tests written) |
| AD-P13-011-REQ-06 | `context_block_set` version increment | FR-PATCH-005 | Step 1 (tests written) |
| AD-P13-011-REQ-07 | `context_block_append` engine operation | FR-PATCH-006 | Step 1 (tests written) |
| AD-P13-011-REQ-08 | `context_block_delete` engine operation | FR-PATCH-007 | Step 1 (tests written) |
| AD-P13-011-REQ-09 | `context_edit: "none"` blocks all patches | FR-PATCH-013 | Step 1 (tests written) |
| AD-P13-011-REQ-10 | Context blocks injected into prompt context | FR-CTX-INJECT-004, FR-CTX-INJECT-005 | Step 1 (tests written) |
| AD-P13-011-REQ-11 | `context_block_updated` event emission | FR-PATCH-004 | Step 1 (tests written) |
| AD-P13-011-REQ-12 | `context_block_deleted` event emission | FR-PATCH-007 | Step 1 (tests written) |
| AD-P13-011-REQ-13 | Context block artifact versioning (v1, v2, ...) | FR-ART-CB-001, FR-ART-CB-002 | Step 1 (tests written) |
| AD-P13-011-REQ-14 | Context block artifact metadata | FR-ART-CB-003, FR-ART-CB-004 | Step 1 (tests written) |
| AD-P13-011-REQ-15 | Batch atomicity for context block patches | FR-PATCH-008 | Step 1 (tests written) |

### TD-P9-001 and TD-P9-002 (Expression Step/Job Output Resolution)

| Tech Debt ID | Description | Test IDs | Status |
|---|---|---|---|
| TD-P9-001 | `${{ jobs.<id>.outputs.<key> }}` resolution | FR-EXPR-STEPS-001, FR-EXPR-STEPS-002, FR-EXPR-STEPS-004 | Step 1 (tests written) |
| TD-P9-002 | `${{ steps.<id>.outputs.<key> }}` resolution | FR-EXPR-STEPS-003, FR-EXPR-STEPS-005 | Step 1 (tests written) |

### Boolean Operators

| Requirement | Description | Test IDs | Status |
|---|---|---|---|
| BOOL-OP-001 | `==` equality operator | FR-EXPR-VAR-004 | Step 1 (tests written) |
| BOOL-OP-002 | `!=` inequality operator | FR-EXPR-VAR-005 | Step 1 (tests written) |
| BOOL-OP-003 | `&&` logical AND | FR-EXPR-VAR-006 | Step 1 (tests written) |
| BOOL-OP-004 | `\|\|` logical OR | FR-EXPR-VAR-007 | Step 1 (tests written) |
| BOOL-OP-005 | `!` logical NOT | FR-EXPR-VAR-008 | Step 1 (tests written) |
| BOOL-OP-006 | Complex expressions | FR-EXPR-VAR-009 | Step 1 (tests written) |
| BOOL-OP-007 | Non-boolean condition guard | FR-EXPR-VAR-010 | Step 1 (tests written) |

## Test Coverage Mapping

| Test File | Test IDs | Count |
|---|---|---|
| `tests/workflow/variables-schema.test.ts` | FR-VAR-SCHEMA-001 through FR-VAR-SCHEMA-010 | 10 |
| `tests/workflow/permissions-schema.test.ts` | FR-PERM-SCHEMA-001 through FR-PERM-SCHEMA-006 | 6 |
| `tests/engine/applyContextPatch.test.ts` | FR-PATCH-001 through FR-PATCH-014 | 14 |
| `tests/engine/accept-pipeline.test.ts` | FR-PIPELINE-001 through FR-PIPELINE-006 | 6 |
| `tests/expression/variables.test.ts` | FR-EXPR-VAR-001 through FR-EXPR-VAR-010 | 10 |
| `tests/expression/steps-outputs.test.ts` | FR-EXPR-STEPS-001 through FR-EXPR-STEPS-005 | 5 |
| `tests/context/variables-injection.test.ts` | FR-CTX-INJECT-001 through FR-CTX-INJECT-005 | 5 |
| `tests/artifact/context-blocks.test.ts` | FR-ART-CB-001 through FR-ART-CB-004 | 4 |
| **Total** | | **60** |

## Notes

### TD-P9-001 and TD-P9-002 清偿

These two tech debt items require extending the expression resolver to support `${{ jobs.<id>.outputs.<key> }}` and `${{ steps.<id>.outputs.<key> }}` patterns. The `ExpressionContext` interface must be extended with `jobs` and `steps` fields containing upstream output data. Tests are written in `tests/expression/steps-outputs.test.ts` and will be implemented in Step 2.

### Pipeline Integration (AD-P13-013)

The pipeline order specified in AD-P13-013 is:
1. Read report.json
2. Validate report shape
3. Normalize outputs
4. **applyContextPatch** (NEW -- this workflow)
5. applyStatusReturn (from WF-P13-RETURNS)
6. Signal handling
7. advanceJob

This order ensures that context patches are applied before routing decisions, so status handlers and signal dispatchers see the latest variable/block state.

### Event Type Additions

Four new event types must be added to `ZigmaFlowEventType`:
- `variable_set`
- `variable_deleted`
- `context_block_updated`
- `context_block_deleted`

These extend the 27-type catalog (26 original + `step_returned` from P13a) to 31 types. The `EVENT_TYPES` runtime tuple must be extended correspondingly.

### Red Phase Status

All 60 tests in this Step 1 are intentionally RED (fail) because the production modules do not yet exist. Step 2 will implement the modules (`src/workflow/index.ts` schema extensions, `src/engine/applyContextPatch.ts`, `src/artifact/` context block writer, `src/context/index.ts` injection, `src/expression/index.ts` extensions, `src/events/eventTypes.ts` extensions) and the tests will flip to GREEN.
