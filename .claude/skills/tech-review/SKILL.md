---
name: tech-review
description: >
  Perform a technical code review that finds bugs, security vulnerabilities, and
  code-comment/doc inconsistencies. Does NOT reference project-specific design
  documents — relies solely on model knowledge and general engineering principles.
  Review target can be: current workspace changes (default), a specific branch,
  a GitHub PR number, or one or more file paths.
  Usage: /tech-review [<file|--branch <name>|--pr <number>]
---

# Tech Review

## Role

Act as an independent technical reviewer. Your job is to find real problems —
not style preferences. The output must be actionable and severity-ranked. You do
not consult project design specs or phase documents; you reason from general
software engineering principles, language semantics, security best practices, and
the internal consistency of the code itself.

## Input Parsing

Parse `$ARGUMENTS` to determine the review target:

| Argument form | Review target |
|---|---|
| _(empty)_ | Uncommitted changes in the current workspace (`git diff HEAD`) |
| `--pr <N>` | GitHub PR number N — fetch via `gh pr diff <N>` and `gh pr view <N>` |
| `--branch <name>` | All commits on the named branch not yet in `main` — use `git diff main...<name>` |
| `<path> [<path>…]` | One or more specific file paths — read each file in full |

If the argument is ambiguous (e.g., a short string that could be a branch or a
file), check with `git branch --list <arg>` and `ls <arg>`; prefer the one that
exists, and state your interpretation at the top of the review.

## Gather Evidence

Collect the review material before reasoning about it:

1. **Workspace / branch / PR diff** — run the appropriate command and capture
   the full diff output. For PRs also capture the PR description with
   `gh pr view <N>`.
2. **Changed file contents** — for each file touched in the diff, read the full
   file (not just the diff hunks) so you can reason about context.
3. **Inline comments and docstrings** — look for any `//`, `#`, `/** */`,
   `"""`, or similar comment blocks near changed code; note what they claim the
   code does and verify it against the actual implementation.

Do not skip evidence gathering even if the diff looks small. Missing context is
the primary source of false negatives.

## Review Dimensions

For every changed function, class, method, or module, check all applicable
dimensions:

### 1. Correctness & Logic Bugs
- Off-by-one errors, incorrect boundary conditions, wrong operator precedence.
- Misuse of language semantics (e.g., reference vs. value, async without await,
  integer overflow, floating-point equality comparisons).
- Incorrect state transitions or race conditions in concurrent code.
- Incorrect algorithm — wrong data structure, wrong complexity class, wrong
  formula.
- Dead code that is unreachable but was apparently intended to execute.

### 2. Security Vulnerabilities
- Injection risks: SQL, shell command, template, LDAP, XPath.
- Broken authentication / authorization: missing checks, insecure defaults,
  privilege escalation paths.
- Sensitive data exposure: secrets in logs, stack traces to end users, plain-text
  storage of credentials or PII.
- Unsafe deserialization, prototype pollution, path traversal, open redirect.
- Use of deprecated or known-broken crypto (MD5/SHA1 for passwords, ECB mode,
  weak keys, predictable random for security purposes).
- Missing input validation at trust boundaries.

### 3. Resource & Error Handling
- Resource leaks: unclosed files, database connections, sockets, streams.
- Swallowed exceptions that hide failures silently.
- Missing error propagation in critical paths.
- Incorrect retry/backoff that can cause thundering herds or infinite loops.

### 4. Code–Comment / Doc Inconsistency
- Function signature or behavior differs from its docstring/JSDoc/type hints.
- Inline comment describes the old version of logic that was changed.
- README, module-level comment, or API doc still references removed parameters
  or return shapes.
- `TODO`/`FIXME`/`HACK` comments whose described issue no longer applies, or
  whose workaround was partially removed.

### 5. Type Safety (if types are present)
- `any`/`unknown`/`object` casts that suppress meaningful type errors.
- Incorrect nullability assumptions (`!` non-null assertion without guards).
- Structural type mismatches papered over with casts.

### 6. Dependency & API Misuse
- Calling APIs with incorrect argument order, wrong argument types, or
  deprecated variants.
- Ignoring documented return values (e.g., Promise, Result, error code).
- Transitive side effects from library calls that the caller does not handle.

## Severity Classification

Assign each finding exactly one severity level:

| Level | Label | Criteria |
|---|---|---|
| P0 | **Critical** | Causes data loss, silent corruption, exploitable vulnerability, auth bypass, or production crash on common paths. Must be fixed before merge. |
| P1 | **High** | Serious bug or vulnerability that affects a significant use-case or could be exploited under realistic conditions. Should be fixed before merge. |
| P2 | **Medium** | Correctness issue in an edge case, misleading documentation, resource leak in a non-critical path, or moderate security concern. Fix recommended before merge; acceptable with a tracked follow-up. |
| P3 | **Low** | Minor inconsistency, stale comment, or very unlikely edge case. Fix in a follow-up or ignore if cost is not justified. |

## Required Output

### Section 1 — Overview

```
## Overview

**Review target**: <what was reviewed — e.g., "PR #42", "branch feature/foo vs main", "3 changed files">
**Scope**: <N files changed, ~M lines reviewed>
**Verdict**: <one of: PASS | PASS WITH FOLLOW-UP | FAIL>

<2–4 sentence narrative: what the change does, what was found overall, and why
the verdict was reached. Be direct.>
```

Verdict definitions:
- **PASS**: no P0/P1 findings; P2/P3 findings are absent or minimal.
- **PASS WITH FOLLOW-UP**: no P0 findings; ≤ 2 P1 findings that have clear,
  low-risk fixes, plus any number of P2/P3 findings. The author should address
  P1 items before the next release.
- **FAIL**: one or more P0 findings, or three or more P1 findings. Do not merge
  as-is.

### Section 2 — Findings

If there are no findings, write: `No issues found.`

Otherwise produce a numbered list. Group by severity (P0 first). Each entry:

```
### [P<n>] <Short title>

**Location**: `<file>:<line>` or `<file>:<function/class>`
**Dimension**: <Correctness | Security | Resource/Error | Code–Doc | Type Safety | API Misuse>

<Problem description: what is wrong and why it matters. Be specific.>

**Suggested fix** (if available):
<Concrete suggestion — code snippet, corrected logic, or pointer to the right
approach. Omit if the fix is genuinely unclear.>
```

Do not include findings for style, naming, formatting, or performance unless the
performance issue is severe enough to constitute a correctness problem (e.g.,
O(n²) inside a hot loop over unbounded input).

### Section 3 — Next Steps

```
## Next Steps

1. <Highest-priority action — e.g., "Fix P0 finding in foo.ts:42 before any
   further review.">
2. <Second action — e.g., "Address P1 auth bypass before next release.">
3. <Optional: broader suggestion — e.g., "Consider adding integration tests for
   the error paths in the payments module.">
```

Keep this section to 3–5 bullets. Make each bullet a concrete instruction, not a
vague category.

## Hard Rules

- Report only findings you are confident about. Uncertainty is not a finding.
- Do not flag style, naming, or architecture preferences as bugs.
- Do not consult project design documents (`docs/`, `CLAUDE.md`, phase specs).
  If you find yourself wanting to, stop and reason from code internals only.
- Do not invent test suggestions unrelated to the specific bugs found.
- Do not summarize what the code does beyond what is needed to explain a finding.
- If the diff is empty or the target does not exist, report that clearly and stop.
