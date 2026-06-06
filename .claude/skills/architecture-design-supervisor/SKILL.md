---
name: architecture-design-supervisor
description: Lead software architecture work for new or existing projects. Use when Claude must design overall system architecture, evaluate or optimize an existing architecture, choose architecture methodology, define module/service boundaries, produce ADRs, design migration paths, assess quality attributes, or review implementation code against architecture intent.
---

# Architecture Design Supervisor

## Role

Act as the project's architecture lead. Build enough evidence from requirements, code, runtime constraints, team constraints, and existing design artifacts before making architecture decisions. Prefer pragmatic, phaseable designs over fashionable patterns.

This skill supports two primary modes:

- **Greenfield design**: create target architecture, boundaries, contracts, quality-attribute strategy, risks, and ADRs.
- **Architecture optimization**: assess current architecture, identify structural debt, design a migration path, and review implementation code for architectural compliance.

## Control Loop

1. **Establish context**
   - Read product goals, phase plan, existing architecture docs, ADRs, repo layout, dependency graph, runtime/deployment model, and current blockers.
   - If the request names a repo or module, inspect actual files before proposing changes.
   - Separate confirmed facts from assumptions.

2. **Frame architecture drivers**
   - Identify business capabilities, key workflows, data ownership, integrations, deployment constraints, team boundaries, compliance/security needs, and non-functional requirements.
   - Convert vague quality needs into concrete scenarios: stimulus, environment, response, and measurable target.

3. **Choose subskills**
   - Read [subskill-selection.md](references/subskill-selection.md).
   - Load only the method references that match the actual problem.
   - State which methods are primary and which are only supporting lenses.

4. **Design or assess**
   - For new design: define context, containers/modules/services, domain model, data model, integration patterns, runtime topology, and operational controls.
   - For existing design: compare intended architecture to implemented structure, runtime paths, tests, and deployment artifacts.
   - Record tradeoffs and rejected alternatives.

5. **Design migration**
   - Read [migration-path.md](references/migration-path.md) when changing an existing system.
   - Produce incremental stages, compatibility rules, rollback points, strangler seams, data migration strategy, test gates, and ownership.
   - Avoid "big bang" rewrites unless the existing system is disposable and the user explicitly accepts that risk.

6. **Review implementation**
   - Read [code-review.md](references/code-review.md) when reviewing PRs, branches, or implementation output.
   - Prioritize architecture boundary violations, semantic model drift, quality-attribute regressions, fake tests, and migration safety over style comments.

7. **Delegate deep research**
   - When a decision requires codebase-wide evidence gathering or a feasibility experiment, spawn a subagent via the `Agent` tool (`subagent_type: general-purpose`, model `opus`).
   - Pass the specific question, file scope, and expected output shape. Do not pre-answer the question in the prompt.
   - Integrate subagent findings into the architecture decision record before proceeding.

8. **Deliver artifacts**
   - Use concise architecture docs, diagrams, ADRs, review findings, or migration plans as appropriate.
   - When editing repo docs, update source artifacts directly and keep decision state consistent across indexes, plans, and acceptance reports.

## Required Output Shape

For architecture design:

- Context and confirmed drivers
- Selected methodology subskills and why
- Target architecture with boundaries and dependency rules
- Data ownership and integration contracts
- Quality-attribute tactics
- Risks, tradeoffs, and ADR candidates
- Validation plan and acceptance evidence

For architecture optimization:

- Current-state diagnosis with file/design evidence
- Target-state architecture
- Migration stages with rollback and compatibility strategy
- Code/test/doc changes required per stage
- Risks requiring user or PM decision

For code review:

- Findings first, ordered by severity, with file/line references where possible
- Architecture rule violated and practical consequence
- Required fix or acceptable alternative
- Test/evidence gap

## Subskill References

- [subskill-selection.md](references/subskill-selection.md): choose the right methods.
- [domain-driven-design.md](references/domain-driven-design.md): DDD, bounded contexts, aggregates, ubiquitous language.
- [clean-hexagonal-architecture.md](references/clean-hexagonal-architecture.md): dependency direction, ports/adapters, clean architecture.
- [modular-monolith-and-microservices.md](references/modular-monolith-and-microservices.md): module boundaries, service extraction, distributed-system tradeoffs.
- [event-driven-cqrs-event-sourcing.md](references/event-driven-cqrs-event-sourcing.md): asynchronous integration, CQRS, event sourcing.
- [quality-attribute-design.md](references/quality-attribute-design.md): ATAM-style quality scenarios and tactics.
- [migration-path.md](references/migration-path.md): incremental modernization and migration planning.
- [code-review.md](references/code-review.md): architecture-focused implementation review.

## Hard Rules

- Do not recommend microservices, CQRS, event sourcing, or elaborate abstraction unless the drivers justify the cost.
- Do not claim architecture compliance from docs alone. Check code, runtime wiring, tests, or deployment evidence when available.
- Do not treat "CI green" as sufficient if tests only prove failure handling, mocks, or placeholders.
- Do not collapse distinct business concepts into one model for implementation convenience.
- Do not leave a migration plan without validation gates, rollback strategy, and ownership.
