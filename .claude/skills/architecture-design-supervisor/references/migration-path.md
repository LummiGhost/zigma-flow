# Migration Path Design

Use this for architecture optimization, modernization, service extraction, data model redesign, or framework/runtime replacement.

## Migration Principles

- Preserve product behavior while changing structure.
- Keep each stage independently shippable or explicitly label it as preparatory.
- Use compatibility layers, feature flags, adapters, and strangler patterns to reduce cutover risk.
- Define rollback before implementation begins.
- Make migration progress visible through tests, runtime markers, metrics, or docs tied to source changes.

## Plan Template

```text
Current state:
Target state:
Non-goals:
Constraints:

Stage 0 - discovery and guardrails:
Stage 1 - boundary preparation:
Stage 2 - parallel implementation:
Stage 3 - migration and cutover:
Stage 4 - cleanup:

Compatibility strategy:
Data migration strategy:
Rollback strategy:
Validation gates:
Ownership:
Open decisions:
```

## Required Gates

- Architecture boundary tests or dependency checks where practical.
- Golden-path runtime validation.
- Contract tests for external or cross-module boundaries.
- Data migration dry run or reversible migration proof when data changes.
- Observability for the migrated path before cutover.
- Documentation/ADR updates when decisions change.

## Migration Smells

- "Refactor everything first" with no user-visible or runtime evidence.
- New architecture and old architecture both accept writes without reconciliation.
- No plan for schema/event/API compatibility.
- Tests only prove old behavior fails or mocks are called.
- Cleanup stage is undefined, leaving permanent dual paths.
