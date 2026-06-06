# Subskill Selection

Use this file to choose architecture method references. Select the smallest set that explains the problem and constrains the decision.

## Selection Matrix

| Situation | Primary subskill | Supporting subskills |
| --- | --- | --- |
| Complex business rules, unclear concepts, model drift | `domain-driven-design.md` | `code-review.md`, `quality-attribute-design.md` |
| Framework/database leakage into business logic | `clean-hexagonal-architecture.md` | `code-review.md` |
| Single repo becoming tangled but deployment is still simple | `modular-monolith-and-microservices.md` | `domain-driven-design.md` |
| Team wants microservices or service split | `modular-monolith-and-microservices.md` | `quality-attribute-design.md`, `migration-path.md` |
| Cross-system async workflows, integration events, eventual consistency | `event-driven-cqrs-event-sourcing.md` | `quality-attribute-design.md` |
| Read/write models diverge substantially | `event-driven-cqrs-event-sourcing.md` | `domain-driven-design.md` |
| Existing architecture needs modernization | `migration-path.md` | choose domain/runtime methods as needed |
| PR or implementation review | `code-review.md` | method tied to the violated rule |
| Non-functional requirements dominate | `quality-attribute-design.md` | selected structural method |

## Method Selection Rules

- Start with **quality drivers** and **domain boundaries**, then choose technical patterns.
- Prefer **modular monolith** before microservices unless independent deployment, team ownership, scale isolation, or reliability isolation is a real driver.
- Prefer **clean/hexagonal boundaries** when core logic needs testability and infrastructure independence.
- Prefer **DDD** when business semantics are the main source of complexity.
- Prefer **event-driven architecture** when temporal decoupling and cross-boundary integration matter; do not use it merely to avoid direct calls.
- Prefer **CQRS** only when command and query models have materially different needs.
- Prefer **event sourcing** only when auditability, replay, temporal reconstruction, or append-only business facts are core requirements.

## Output Discipline

When reporting method choice, use:

```text
Primary subskills:
- <method>: <driver>

Supporting subskills:
- <method>: <specific question it answers>

Rejected methods:
- <method>: <why not now>
```
