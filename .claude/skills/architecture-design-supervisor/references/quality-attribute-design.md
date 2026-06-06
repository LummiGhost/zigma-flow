# Subskill: Quality-Attribute Design

Use this when performance, availability, security, scalability, modifiability, operability, or compliance drive the architecture.

## Scenario Template

Capture each quality attribute as:

```text
Source:
Stimulus:
Environment:
Artifact:
Response:
Response measure:
Priority:
Evidence:
```

Example:

```text
Stimulus: payment provider timeout
Environment: peak checkout traffic
Artifact: checkout command handler
Response: stop waiting after 2s, record pending payment, retry asynchronously, expose pending status
Response measure: p95 checkout response under 3s; no duplicate charge
```

## Tactics

- Performance: caching, batching, indexing, async processing, pagination, backpressure, hot-path profiling.
- Availability: timeout, retry with jitter, circuit breaker, bulkhead, failover, graceful degradation.
- Consistency: transaction boundary, outbox, saga, idempotency, compensation, optimistic locking.
- Security: least privilege, threat modeling, input validation, authz at boundary and domain action, audit logging, secret handling.
- Modifiability: bounded contexts, stable contracts, plugin points, dependency inversion, ADR discipline.
- Observability: structured logs, metrics, traces, correlation ids, business events, runbooks.

## Architecture Review Questions

- Which scenarios are most important and measured?
- Which component owns the response?
- What happens during partial failure?
- Is there a test, load run, chaos run, security review, or runtime evidence?
- Are tactics implemented in the right layer or scattered across callers?
