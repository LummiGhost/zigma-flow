# Research Report: Expression Language Extensions

Date: 2026-07-16
Status: Complete
Topic: R5 -- Context Namespaces and Status Functions (Issue #235)

## Question

How should the existing expression resolver (`src/expression/index.ts`) be extended to support:
1. Seven read-only context namespaces (`inputs`, `invocation`, `run`, `jobs`, `steps`, `attempt`, `host`)
2. Four status functions (`success()`, `failure()`, `always()`, `cancelled()`)

While maintaining the hard constraint: no function calls, no arithmetic, no string concatenation, no JS eval, no mutation.

## Current State

### Existing ExpressionContext

```typescript
export interface ExpressionContext {
  inputs: Record<string, string>;
  run: { id: string; workflow: string; dir?: string };
  retry?: { inputs: Record<string, string> };
  variables?: Record<string, unknown>;
  jobs?: Record<string, { outputs?: Record<string, unknown> }>;
  steps?: Record<string, { outputs?: Record<string, unknown> }>;
}
```

### Namespace coverage vs Issue #235 proposal

| Namespace   | Status | Current access pattern | What is exposed |
|-------------|--------|----------------------|-----------------|
| `inputs`    | EXISTS | `${{ inputs.<key> }}` | CLI positional task string |
| `invocation`| NEW    | --                   | --              |
| `run`       | EXISTS | `${{ run.id }}`, `${{ run.workflow }}`, `${{ run.dir }}` | id, workflow name, run directory |
| `jobs`      | PARTIAL | `${{ jobs.<id>.outputs.<key> }}` | Only outputs; no status/attempt |
| `steps`     | PARTIAL | `${{ steps.<id>.outputs.<key> }}` | Only outputs of previous steps in same job; no status |
| `attempt`   | NEW    | --                   | --              |
| `host`      | NEW    | --                   | --              |

### Existing parser grammar (recursive descent)

```
expression    -> or-expression
or-expression  -> and-expression ("||" and-expression)*
and-expression -> not-expression ("&&" not-expression)*
not-expression -> "!" not-expression | comparison
comparison     -> primary ("==" primary | "!=" primary)?
primary        -> "(" expression ")" | string | number | boolean | ident
```

Tokens: `paren`, `op`, `ident`, `string`, `number`, `boolean`.

No function-call construct exists. The `primary` rule recognizes identifiers, string/number/boolean literals, and parenthesized sub-expressions. Identifiers are resolved against `ctx.variables` by `resolveValue()`.

### Call sites summary

| Module | Function | Context fields used |
|--------|----------|-------------------|
| `src/engine/index.ts` (advanceJob) | `evaluateCondition` | `inputs`, `run`, `variables`, `jobs` |
| `src/script/executor.ts` | `resolveExpression` | `inputs`, `run`, `jobs`, `steps`, `variables` |
| `src/router/executor.ts` | `resolveExpression` | `inputs`, `run`, `jobs`, `steps` |
| `src/check/executor.ts` | `resolveExpression` | `inputs`, `run`, `jobs`, `steps`, `variables` |
| `src/context/index.ts` (buildContext) | `resolveExpression` | `inputs`, `run` |
| `src/engine/workspace.ts` | `resolveExpression` | `inputs`, `run`, `jobs`, `variables` |
| `src/engine/traverse.ts` | `resolveExpression` | `inputs`, `run`, `variables`, `jobs` |

Pattern: Every call site constructs its own `ExpressionContext` inline from `RunState`. There is no centralized context builder for expressions (unlike `buildContext` for agent prompts).

## Options Evaluated

### A. New context namespaces: phasing strategy

**Option A1: Add all 7 atomically**

Introduce `invocation`, `attempt`, and `host` plus extend `jobs`/`steps`/`run`/`inputs` all in one change.

- Pro: One migration, one type change.
- Con: `host` has unresolved security questions; large change surface; harder to review.
- Verdict: Reject. Too much scope for a single expression change.

**Option A2: Add only v0.7-necessary namespaces (attempt + invocation)**

Add `attempt` and `invocation`; extend `jobs` and `steps` with status access; defer `host`.

- Pro: Aligned with v0.7 scope; focused change; `host` security concerns don't block.
- Con: Future `host` addition is a second migration.
- Verdict: Adopt. This matches the MVP scope.

**Option A3: Phase core in v0.7, host deferred to v1.0**

Same as A2 but explicitly documents the `host` deferral plan.

- Pro: Clear roadmap; no scope creep.
- Con: None.
- Verdict: **RECOMMENDED.** Phase core namespaces now; `host` separately.

**Decision:** Phase namespaces. v0.7 ships `attempt` and `invocation`; extends `jobs` and `steps` beyond outputs-only. `host` is explicitly deferred to v1.0 with a note in the type definition.

### B. `invocation` namespace design

**Option B1: Full CLI invocation parameters**

`invocation.command`, `invocation.backend`, `invocation.parallelism`, `invocation.trigger`, `invocation.user`.

- Pro: Rich metadata for conditional logic.
- Con: `invocation.user` requires authentication context not universally available; `invocation.parallelism` is internal scheduling detail.
- Verdict: Reject for v0.7. Overly broad.

**Option B2: Trigger-focused**

`invocation.trigger` only: `"manual" | "scheduled" | "resume"` plus `invocation.backend` for the agent backend name.

- Pro: Immediately useful for `if:` conditions like `invocation.trigger == 'scheduled'`; aligns with `invoke --trigger` and `resume` flows.
- Con: Limited enrichment.
- Verdict: **RECOMMENDED.** Small, useful, safe.

**Option B3: Empty placeholder (defer entirely)**

Add `invocation?: Record<string, never>` as a placeholder, populate later.

- Pro: Zero implementation risk.
- Con: Delivers no value; contradicts Issue #235 scope.
- Verdict: Reject. The namespace exists but is useless.

**Decision:** Minimal `invocation` with `trigger` and `backend` fields. Accessible as `${{ invocation.trigger }}` and `${{ invocation.backend }}`.

### C. `attempt` namespace design

**Option C1: Current attempt number only**

`attempt.number` -- resolves to the 1-based attempt counter.

- Pro: Simplest possible; sufficient for most conditional logic (`attempt.number > 1`).
- Con: No contextual metadata (why did retry happen?).
- Verdict: Reject. Too narrow; doesn't support `when` conditions on retry policy.

**Option C2: Full attempt context**

`attempt.number`, `attempt.started_at`, `attempt.trigger` (`"initial" | "retry"`), `attempt.previous_outcome?: string`.

- Pro: Supports retry policy conditions: `attempt.previous_outcome == 'timeout'` for deciding `when:` on next retry.
- Con: `attempt.previous_outcome` requires the retry policy evaluation to have access to the previous attempt's conclusion, which may not be available at all expression sites.
- Verdict: **RECOMMENDED with caveat.** Full context when available; `previous_outcome` is optional.

**Option C3: Attempt + previous (deep history)**

`attempt.previous.outcome`, `attempt.previous.error`, etc.

- Pro: Rich history access.
- Con: Nested object traversal in a flat expression language; violates KISS.
- Verdict: Reject. Unnecessary complexity.

**Decision:** `attempt.number` (required, always present), `attempt.trigger` (`"initial" | "retry"`), `attempt.previous_outcome?` (optional, only present during retry). Previous outputs are accessed through the existing `jobs`/`steps` paths; no separate `attempt.previous.*` tree.

### D. `host` namespace design

**Option D1: Full OS/arch/environment**

`host.os`, `host.arch`, `host.hostname`, `host.cwd`, `host.env`.

- Pro: Maximum flexibility.
- Con: Severe security concern -- exposing host environment information to workflow expressions leaks infrastructure details; `host.env` is a hard no.
- Verdict: Reject.

**Option D2: Defer entirely to v1.0**

No `host` namespace in v0.7. Document the intent.

- Pro: Zero security risk; keeps v0.7 focused.
- Con: Delays feature.
- Verdict: **RECOMMENDED.**

**Option D3: Limited platform only**

`host.platform` only (`"win32" | "linux" | "darwin"`).

- Pro: Useful for cross-platform workflow conditions (e.g., skip Windows-specific steps on Linux).
- Con: Even `host.platform` leaks OS fingerprint to workflow authors; questionable value proposition.
- Verdict: Reject for now; reevaluate in v1.0 with concrete use cases.

**Decision:** Defer `host` entirely. The security concern outweighs the value for MVP. Add a `// reserved for v1.0` comment in the `ExpressionContext` type to signal intent.

### E. Status function implementation strategy

**Option E1: Pure functions in expression evaluator**

Modify the recursive-descent parser to recognize function-call tokens (`ident "(" ")"`) and evaluate only the 4 whitelisted functions.

- Pro: Natural syntax; reuses existing parser architecture.
- Con: Requires grammar extension (new token types, new production rule); opens the door to future function-argument creep; parser complexity increases.
- Verdict: Reject. Grammar creep is the primary risk identified in the phase plan.

**Option E2: Template function syntax**

Allow `${{ success() }}` in template interpolation, resolving to `"true"` or `"false"` strings.

- Pro: Uses existing `${{ }}` mechanism.
- Con: Ambiguous semantics -- is `${{ success() }}` a string `"true"` or boolean `true`? Would require special `if:` handling anyway; pollutes the interpolation namespace.
- Verdict: Reject. Confusing dual semantics.

**Option E3: Condition-only (restrict to `if:` and `when:` contexts)**

Status functions are NOT valid in general `${{ }}` interpolation. They are recognized only within `evaluateCondition` (used by `if:` on steps and `when:` on retry policy). This is enforced by the evaluation pipeline, not by the grammar.

- Pro: Clear separation of concerns; no grammar change; no ambiguity; `success()` naturally produces a boolean.
- Con: `${{ success() }}` in a template string is an error (or passthrough), which might surprise users.
- Verdict: **RECOMMENDED.**

**Option E4: Pre-resolution (string replacement before parser)**

Before the expression enters `evaluateCondition`, scan the resolved string for `success()`, `failure()`, `always()`, `cancelled()` and replace each with `true` or `false` based on the expression context. Then parse as normal.

- Pro: Zero grammar change; trivial to implement; no risk of enabling arbitrary functions; easy to audit (only 4 hardcoded patterns).
- Con: Cannot support arguments or nested calls; replacement is order-sensitive if a function name appears inside a string literal (unlikely but theoretically possible).
- Verdict: **RECOMMENDED (combined with E3).**

**Decision:** Combine E3 (condition-only scope) with E4 (pre-resolution). The pipeline is:
1. `resolveExpression` is unchanged -- status functions are NOT recognized in template interpolation.
2. In `evaluateCondition`, after `resolveExpression` resolves `${{ }}` tokens but before tokenization, scan for the 4 function names followed by `()` and replace with boolean literals.
3. The boolean literals then flow through the normal parser.

This approach makes exactly one surgical change to `evaluateCondition` and zero changes to the grammar.

### F. Status function semantics

**Option F1: Job-scoped**

`success()` within a step's `if:` condition means "all previous steps in the current job's current attempt have succeeded." `failure()` means "any previous step in the current job's current attempt has failed." `cancelled()` means "the current job/run has been cancelled."

- Pro: Matches how step `if:` conditions are typically used (guard based on previous step outputs).
- Con: Does not address cross-job status queries (retry policy `when:` on job B checking if job A succeeded).
- Verdict: Good for step `if:`; insufficient alone.

**Option F2: Run-scoped**

`success()` means "all jobs in the current run have succeeded so far." Too broad for step-level conditions.

- Pro: Useful for run-level gates.
- Con: Overly broad for step `if:`; a single failed job in an unrelated branch would make `success()` false for all subsequent steps.
- Verdict: Reject as sole semantics.

**Option F3: Context-dependent scope**

The scope of `success()` depends on where it is evaluated:
- In step `if:`: checks all previous steps in the current job's current attempt.
- In retry policy `when:`: checks the outcome of the job's previous attempt.
- In job-level `failure_policy`: checks the outcome of the current job.
- In run-level contexts: checks all jobs so far.

This is conceptually how GitHub Actions `success()` works.

- Pro: Matches user expectations; natural semantics.
- Con: Requires the evaluator to know its evaluation context; more complex implementation.
- Verdict: **RECOMMENDED.** The context-dependent behavior is the most intuitive and aligns with existing workflow engine conventions.

**Decision:** Context-dependent scope for all status functions:
- `success()` -- true when the current scope (step's job, job, or run) has no failures.
- `failure()` -- true when the current scope has at least one failure.
- `cancelled()` -- true when the current run's status is `cancelled`.
- `always()` -- always true (useful for cleanup steps: `if: always()`).

To implement, `evaluateCondition` receives a new `scope` parameter (see proposed interface below) that informs the pre-resolution of status functions.

### G. Grammar extension approach: detailed analysis

Given the decision to use pre-resolution (E4), the grammar does NOT change. Here is the detailed pipeline:

**Current pipeline:**
```
expression string -> resolveExpression -> resolved string -> tokenize -> parse -> boolean
```

**Proposed pipeline:**
```
expression string -> resolveExpression -> resolved string
    -> resolveStatusFunctions(resolved, context, scope) -> pre-resolved string
    -> tokenize -> parse -> boolean
```

The new `resolveStatusFunctions` step is a pure function:

```typescript
function resolveStatusFunctions(
  expr: string,
  ctx: ExpressionContext,
  scope: StatusScope
): string {
  // Replace each known function call with its boolean literal
  const replacements: [RegExp, boolean][] = [
    [/success\(\)/g,  computeSuccess(ctx, scope)],
    [/failure\(\)/g,  computeFailure(ctx, scope)],
    [/cancelled\(\)/g, computeCancelled(ctx, scope)],
    [/always\(\)/g,   true],
  ];

  let result = expr;
  for (const [pattern, value] of replacements) {
    result = result.replace(pattern, String(value));
  }
  return result;
}
```

This approach:
- Does not modify the tokenizer.
- Does not modify the recursive-descent parser.
- Does not introduce a `CALL` token type.
- Cannot be extended to support arbitrary function arguments without a deliberate code change.
- Is trivially auditable: only 4 regex patterns, all hardcoded.

## Recommendation

### Phasing

| Component | v0.7 | Deferred |
|-----------|------|----------|
| `inputs` namespace | Already exists | -- |
| `invocation` namespace | `trigger`, `backend` | `user`, `parallelism` |
| `run` namespace | Already exists | -- |
| `jobs` namespace | Add `jobs.<id>.status`, `jobs.<id>.attempt` | `jobs.<id>.conclusion` |
| `steps` namespace | Add `steps.<id>.status` | `steps.<id>.conclusion` |
| `attempt` namespace | `number`, `trigger`, `previous_outcome?` | `started_at` |
| `host` namespace | DEFERRED | v1.0: `platform` only |
| `success()`, `failure()` | Condition-only, context-dependent scope | -- |
| `always()`, `cancelled()` | Condition-only, context-dependent scope | -- |

### Implementation strategy

1. **Pre-resolution for status functions**: No grammar change. Scan and replace before tokenization.
2. **Condition-only scope**: Status functions only valid in `evaluateCondition`; not in general `${{ }}` interpolation.
3. **No new grammar production rules**: The parser grammar remains unchanged.
4. **Context-dependent semantics**: Step `if:` scope differs from retry `when:` scope; passed as a parameter.

## Proposed Data Model

### Updated ExpressionContext

```typescript
export interface ExpressionContext {
  // Existing (unchanged)
  inputs: Record<string, string>;
  run: { id: string; workflow: string; dir?: string };
  retry?: { inputs: Record<string, string> };

  // Existing (unchanged, but deprecated)
  variables?: Record<string, unknown>;

  // Existing (extended -- now include status, not just outputs)
  jobs?: Record<string, {
    outputs?: Record<string, unknown>;
    status?: JobStatus;          // NEW: "running" | "completed" | "failed" | "cancelled"
    attempt?: number;            // NEW: current attempt number
  }>;
  steps?: Record<string, {
    outputs?: Record<string, unknown>;
    status?: StepStatus;         // NEW: "completed" | "failed" | "skipped"
  }>;

  // New namespaces (v0.7)
  invocation?: {
    trigger: "manual" | "scheduled" | "resume";
    backend?: string;            // e.g. "claude-code", "openai", "default"
  };
  attempt?: {
    number: number;              // 1-based attempt counter
    trigger: "initial" | "retry";
    previous_outcome?: string;   // only present during retry; e.g. "timeout", "failure"
  };

  // host is reserved for v1.0 -- not present in v0.7
}
```

### StatusScope (new type for evaluateCondition)

```typescript
/**
 * Informs the context-dependent semantics of status functions.
 *
 * - "step-if": evaluating a step's `if:` condition.
 *   success() checks all prior steps in the current job attempt.
 * - "retry-when": evaluating a retry policy's `when:` condition.
 *   success() checks the previous attempt's outcome.
 * - "failure-policy": evaluating a job's `failure_policy` condition.
 *   success() checks the current job's outcome.
 */
export type StatusScope = "step-if" | "retry-when" | "failure-policy";
```

### Updated evaluateCondition signature

```typescript
export function evaluateCondition(
  expr: string,
  ctx: ExpressionContext,
  scope: StatusScope = "step-if"
): boolean;
```

### Context construction implications

Every call site that currently builds an `ExpressionContext` inline must be updated to include the new fields:

- `invocation` is set once at run creation time from CLI flags or resume metadata.
- `attempt` is set per-job from `jobState.attempt` and retry trigger metadata.
- `jobs` extended with `status` and `attempt` pulled directly from `state.jobs`.
- `steps` extended with `status` pulled from job history (the previous steps in the current attempt).

This requires a non-trivial update to 7 call sites. A centralized `buildExpressionContext(state, opts)` helper is warranted to avoid drift. This helper lives alongside `buildContext` in `src/context/index.ts`.

### Context construction helper (new)

```typescript
// src/context/index.ts

export interface BuildExpressionContextOpts {
  state: RunState;
  runId: string;
  jobId?: string;
  stepIdx?: number;       // index of current step in job definition (for steps context)
  invocation?: ExpressionContext["invocation"];
  attempt?: ExpressionContext["attempt"];
}

export function buildExpressionContext(opts: BuildExpressionContextOpts): ExpressionContext {
  // ... constructs the full ExpressionContext from RunState
}
```

## Proposed Grammar Changes

**None.** The grammar is unchanged. The pre-resolution strategy keeps the recursive-descent parser exactly as-is.

The only code change in `src/expression/index.ts` is:

1. Add `resolveStatusFunctions()` helper (private, pure function).
2. Insert one line in `evaluateCondition()` after `resolveExpression()`:
   ```typescript
   const preResolved = resolveStatusFunctions(resolved, ctx, scope);
   ```
3. Use `preResolved` instead of `resolved` for tokenization.
4. Update `resolveValue()` to handle `jobs.<id>.status` and `steps.<id>.status` lookups (simple string access, same pattern as existing `outputs` lookup).

## Proposed Expression Context (complete shape)

```typescript
// At time of step `if:` evaluation for job "build", step 2 ("test"):
ctx = {
  inputs: { task: "fix the bug" },
  run: { id: "20260716-0001", workflow: "code-change", dir: "/runs/20260716-0001" },
  invocation: { trigger: "manual", backend: "claude-code" },
  attempt: { number: 1, trigger: "initial" },
  variables: {},
  jobs: {
    "build":  { outputs: { status: "ok" }, status: "running",  attempt: 1 },
    "review": { outputs: {},           status: "pending",       attempt: 1 },
  },
  steps: {
    "checkout": { outputs: { sha: "abc123" }, status: "completed" },
    "lint":     { outputs: { warnings: 0 },  status: "completed" },
  },
}
```

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Grammar complexity creep (status functions become eval) | Medium | Pre-resolution with hardcoded regex; no parser change; no `CALL` token; only 4 whitelisted names. Any future function would require a deliberate code edit -- impossible to add accidentally. |
| Context construction drift across 7 call sites | High | Introduce centralized `buildExpressionContext()` helper in `src/context/index.ts`; call sites use it instead of inline construction. |
| `attempt.previous_outcome` not available at all expression sites | Medium | Make it optional; retry policy `when:` specifically passes previous outcome data; step `if:` does not (scope doesn't need it). |
| `invocation.trigger` values change during resume | Low | Set once at run creation; resume is a distinct value (`"resume"`) so it does not change mid-run. |
| Status function semantics confusion (what scope is `success()`?) | Medium | Document per-scope behavior explicitly; `always()` is self-documenting; error on `cancelled()` outside of retry/cleanup contexts (or return false). |
| Deprecation of `variables.*` expressions | Low | Existing deprecation warning already in place; v0.7 does not remove it; no new deprecation surface. |

## Next Action

1. **Freeze this recommendation** by updating `02-development-plan.md` with the decisions recorded here.
2. **Write the TDD test cases** for new namespaces and status functions (before implementation, per project convention: `tests/expression/v0.7-extensions.test.ts`).
3. **Implement the centralized context builder** (`src/context/index.ts` -- `buildExpressionContext`) to prevent context construction drift.
4. **Implement the pre-resolution** in `evaluateCondition` for status functions.
5. **Extend resolveExpression** for new namespace patterns: `invocation.*`, `attempt.*`, `jobs.<id>.status`, `steps.<id>.status`.
6. **Update all 7 call sites** to use the centralized builder and pass invocation/attempt data.
