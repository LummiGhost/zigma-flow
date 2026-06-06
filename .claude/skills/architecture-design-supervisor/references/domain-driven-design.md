# Subskill: Domain-Driven Design

Use DDD when business semantics, workflow rules, and model boundaries are the main complexity.

## Review Steps

1. Identify business capabilities and user-visible workflows.
2. Build or verify the ubiquitous language: names used by users, domain experts, docs, APIs, and code should converge.
3. Split bounded contexts where terms, lifecycle, data ownership, or rules diverge.
4. Define aggregates around transactional consistency boundaries, not UI screens or database joins.
5. Use value objects for concepts with equality by value and local invariants.
6. Keep domain events as business facts, not technical notifications.
7. Verify repositories expose aggregate persistence, not arbitrary query utilities.

## Design Outputs

- Bounded context map and upstream/downstream relationships.
- Aggregate list with invariants, commands, events, and consistency boundary.
- Context integration patterns: conformist, anti-corruption layer, shared kernel, open host service, published language.
- Glossary of high-risk terms.

## Common Findings

- One table/object represents several different business concepts.
- Status fields encode multiple independent lifecycles.
- Application services contain rules that belong in aggregates or domain services.
- Domain events describe implementation actions instead of business facts.
- Cross-context reads become hidden writes or consistency assumptions.

## Acceptance Checks

- A core workflow can be explained using domain names without mentioning framework classes.
- Invariants are enforced in one authoritative place.
- Tests prove meaningful domain success paths and invalid transitions.
- Context boundaries match ownership and change cadence.
