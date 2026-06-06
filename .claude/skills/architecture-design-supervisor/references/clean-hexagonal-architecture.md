# Subskill: Clean and Hexagonal Architecture

Use this when the central concern is dependency direction, framework isolation, testability, or replacement of infrastructure.

## Boundary Rules

- Domain/application core must not depend on UI, HTTP framework, ORM, database client, message broker SDK, or third-party API SDK.
- Ports should be defined near the use case that needs them.
- Adapters translate between external protocols and internal models.
- Configuration, logging, persistence, and transport concerns enter through composition roots or adapters.

## Design Steps

1. Identify core use cases and domain concepts.
2. Define inbound ports for commands/queries or application services.
3. Define outbound ports for persistence, external systems, clocks, id generation, messaging, and file systems.
4. Implement adapters at the edge.
5. Keep mapping explicit between transport DTOs, persistence records, and domain/application models.
6. Validate with tests that core use cases run without real infrastructure.

## Review Findings

- Domain model imports ORM annotations, HTTP request classes, framework decorators, or SDK clients.
- Application service constructs concrete database clients or external API clients.
- Adapter DTOs leak into domain logic.
- Tests require a full application boot for basic business behavior.
- Infrastructure exceptions cross into domain semantics without translation.

## Practical Compromises

- Small CRUD systems may keep a thinner service layer if business logic is minimal.
- Framework annotations can be acceptable in boundary modules when the core remains independent.
- Do not introduce ports for every trivial helper; introduce them for volatile or external dependencies.
