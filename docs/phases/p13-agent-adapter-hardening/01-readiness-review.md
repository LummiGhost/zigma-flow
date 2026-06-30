---
phase: p13b
title: P13b Readiness Review — Agent-Driven Flow Control
date: 2026-06-28
status: ready
authority: docs/phases/p13-agent-adapter-hardening/02-development-plan.md
---

# P13b Readiness Review — Agent-Driven Flow Control

## 1. Assessment Summary

**Conclusion: P13b is ready to proceed.** All P13a prerequisites are satisfied
(merged via PR #90), the development plan is complete, and no pre-development
research is needed. All 3 workflows have explicit ADRs (AD-P13-009 through
AD-P13-013) with defined boundaries, acceptance criteria, and test plans.

## 2. Prerequisites Verified

| Prerequisite | Status | Evidence |
|---|---|---|
| P13a merged on main | Pass | Commit `dae5810` on `main` — engine extraction, lifecycle events, retry, resume/cancel, backend config |
| Development plan written | Pass | `02-development-plan.md` §1–§13 with 7 ADRs for P13b scope |
| PRD updated for v0.2 | Pass | `docs/prd.md` v0.3 with v0.2 revisions (§FR-016/FR-017/FR-018) |
| Contracts updated for v0.2 | Pass | `docs/mvp-contracts.md` v0.1 with v0.2 revisions (§2.1/§2.3/§2.4/§2.6) |
| Architecture updated for v0.2 | Pass | `docs/architecture.md` v0.1 with v0.2 revisions (§5.2/§6.2/§7.1/§7.2) |
| No open design gaps | Pass | All 3 workflows have explicit ADRs, boundaries, acceptance criteria |
| Workflow dependency order clear | Pass | RETURNS → VARIABLES → FLOW (plan §6) |

## 3. Codebase Ready State

| Module | Integration Point | Ready? |
|---|---|---|
| `src/engine/accept.ts` | Pipeline expansion (AD-P13-013): insert applyContextPatch + applyStatusReturn | Yes — outputs → signals → advance flow is clean |
| `src/engine/routing.ts` | `goto_step` branch | Yes — action discriminator pattern extensible |
| `src/engine/index.ts` | `advanceJob` has step pointer + `appendJobCompleted` | Yes — insertion point for `if` evaluation clear |
| `src/workflow/index.ts` | Schema extension (returns, on_return, if, max_visits, variables, context_blocks) | Yes — Zod-based, additive fields |
| `src/run/index.ts` | `RunState` / `JobState` type expansion | Yes — additive fields |
| `src/expression/index.ts` | New namespace resolution + operators | Yes — regex-based, additive |
| `src/context/index.ts` | Variables/context_blocks injection | Yes — `buildContext` has permission merging pattern |
| `src/events/eventTypes.ts` | New event types | Yes — discriminated union, additive |
| `src/artifact/index.ts` | `context_block` artifact kind | Yes — kind is string, additive |

## 4. Workflow Scope Confirmation

### WF-P13-RETURNS (AD-P13-009) — Step Structured Return Status

- 3 new files: `applyStatusReturn.ts`, 2 test files
- 3 modified files: `schema.ts`, `accept.ts`, `eventTypes.ts`
- Adds: `step.returns`, `step.on_return`, `step_returned` event

### WF-P13-VARIABLES (AD-P13-010, AD-P13-011) — Variables & Context Blocks

- 4 new files: `applyContextPatch.ts`, 3 test files
- 8 modified files: `schema.ts`, `run/index.ts`, `accept.ts`, `artifact/index.ts`, `context/index.ts`, `expression/index.ts`, `eventTypes.ts`, permissions test
- Adds: variables/context_blocks namespaces, patch operations, permission model, expression expansion

### WF-P13-FLOW (AD-P13-012) — Conditions, Goto, Bounded Loops

- 3 new files: 3 test files
- 5 modified files: `schema.ts`, `validateDag.ts`, `routing.ts`, `advanceJob` (in index.ts), `eventTypes.ts`
- Adds: `step.if`, `step.max_visits`, `goto_step`, 3 new event types

## 5. Out-of-Scope Confirmed

Per plan §3.2: concurrency, human gate, multi-backend, Docker, event sourcing replay,
arbitrary scripts, `while`/`for` DSL, runtime YAML patch, cross-job goto_step,
deep schema validation — all excluded.

## 6. Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| accept.ts pipeline breaks existing signal path | Medium | 556 tests must stay green; incremental validation per WF |
| Expression parser breaks existing `${{ inputs.* }}` | Medium | Existing expression tests as regression suite |
| Schema changes break existing workflow fixtures | Low | All new fields optional; existing tests cover backward compat |
| Step 3 review finds P0 issues | Medium | 3 rework cycles per WF before human escalation |

## 7. Decision

**P13b is approved to proceed.** Plan is frozen. Implementation follows strict
order: RETURNS → VARIABLES → FLOW, with Step 1 (cases+tests) → Step 2
(implementation) → Step 3 (acceptance) for each workflow.
