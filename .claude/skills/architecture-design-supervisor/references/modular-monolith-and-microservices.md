# Subskill: Modular Monolith and Microservices

Use this when deciding module boundaries, preventing a monolith from decaying, or planning service extraction.

## Default Bias

Prefer a modular monolith until there is evidence that independent deployment, team autonomy, scale isolation, fault isolation, or regulatory/data isolation requires services.

## Modular Monolith Rules

- Modules own their domain model and persistence schema or table subset.
- Cross-module access goes through explicit APIs, events, or application services.
- No imports from another module's internal package.
- Shared code must be small, stable, and truly generic; avoid "common" becoming a dumping ground.
- Module tests should prove boundary contracts.

## Microservice Readiness

Require evidence for:

- Clear bounded context and data ownership.
- Independent deployment need.
- Operational maturity: observability, CI/CD, rollback, versioned APIs, incident response.
- Consistency strategy across services.
- Team ownership that maps to service boundaries.

## Service Extraction Path

1. Enforce module boundary inside the monolith.
2. Introduce contracts and anti-corruption layers.
3. Move reads or async side effects first when lower risk.
4. Split data ownership deliberately.
5. Run shadow traffic or dual-read checks where possible.
6. Cut over behind feature flags or routing controls.

## Anti-Patterns

- Service per table.
- Service split before domain terms stabilize.
- Shared database with direct writes from multiple services.
- Synchronous call chains that reproduce monolith coupling with worse reliability.
- Shared library containing business logic that changes with multiple services.
