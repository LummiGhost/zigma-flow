# Subskill: Event-Driven Architecture, CQRS, and Event Sourcing

Use this when workflows cross boundaries asynchronously, read and write needs diverge, or the business requires historical reconstruction.

## Event-Driven Architecture

Use for temporal decoupling, integration across bounded contexts, high fan-out notifications, and resilience to downstream downtime.

Design:

- Define event as a past-tense business fact.
- Include event id, producer, occurred time, schema version, aggregate/reference id, and idempotency key.
- Decide delivery semantics, retry, dead-letter handling, ordering needs, and replay policy.
- Keep consumers idempotent.
- Version event schemas with compatibility rules.

Avoid when direct request/response semantics, strong immediate consistency, or simple local transactions are required.

## CQRS

Use when command processing and query serving have different models, permissions, performance needs, or storage shapes.

Review:

- Commands express intent and enforce invariants.
- Query models are disposable projections.
- Projection lag is explicit in UX/API behavior.
- Tests cover projection rebuild and stale-read expectations.

## Event Sourcing

Use only when event history is the source of truth: audit, replay, temporal state, regulatory traceability, or collaborative state reconstruction.

Require:

- Stable event modeling discipline.
- Snapshot strategy where replay cost matters.
- Upcasters or migration strategy for old events.
- Strong operational tooling for inspection and repair.
- Clear separation between domain events and integration events.

## Common Risks

- Events named after CRUD operations instead of business facts.
- Consumers depend on undocumented ordering.
- "Eventually consistent" used as an excuse for unspecified behavior.
- CQRS introduced for basic CRUD.
- Event sourcing added without replay, migration, or debugging tools.
