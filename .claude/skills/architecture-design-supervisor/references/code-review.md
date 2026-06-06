# Architecture-Focused Code Review

Use this when reviewing implementation branches, PRs, generated code, or phase deliverables against architecture intent.

## Review Order

1. **Architecture boundary**
   - Check imports, package/module dependencies, service calls, shared libraries, and database access.
   - Identify violations before style comments.

2. **Domain semantics**
   - Verify business concepts are not conflated.
   - Check lifecycle/state transitions and invariants.
   - Confirm names match the project's domain language.

3. **Runtime path**
   - Trace at least one real success path from entrypoint through core logic to persistence/integration.
   - Confirm production wiring reaches the intended adapters/drivers, not placeholders.

4. **Quality attributes**
   - Review transaction boundaries, idempotency, retries, timeouts, authorization, input validation, observability, and failure behavior.

5. **Tests and evidence**
   - Require tests that prove meaningful success behavior.
   - Treat failure-only tests, snapshot-only tests, and mock-call-only tests as insufficient for architecture acceptance.

6. **Migration safety**
   - Check compatibility, rollback, data migration, feature flags, and cleanup plan.

## Finding Format

Use this format:

```text
[Severity] Finding title
Evidence: file/line or design artifact
Architecture rule: violated rule or decision
Impact: practical consequence
Required change: concrete fix or acceptable alternative
Evidence required: test/runtime/doc proof needed
```

## Severity Guide

- P0: data loss, security break, production outage path, irreversible migration risk.
- P1: architecture boundary break that undermines the design, invalid domain model, fake acceptance evidence.
- P2: localized design debt likely to slow near-term work.
- P3: style or maintainability issue without immediate architecture risk.

## Acceptance Bar

Do not pass architecture implementation unless:

- The main success path is real and validated.
- Core boundaries match the selected architecture.
- Tests prove non-trivial behavior.
- Migration risks have gates and rollback.
- Any deferred architectural debt is explicitly recorded with owner and trigger.
