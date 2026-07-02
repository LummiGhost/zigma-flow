# Prompt Engineering Hardening — Readiness Review

**Date:** 2026-07-02
**Author:** phase-development-supervisor

## Inputs

- Source documents:
  - `docs/prd.md` v0.3 (especially §FR-006 Context Builder & Agent Prompt, §14 Context Builder & Prompt Builder)
  - `docs/architecture.md` v0.1 (especially §5.2 module boundaries for `context` and `prompt`, §10 Quality Attributes)
  - `docs/mvp-contracts.md` v0.1 (especially §2.6 Agent Report Contract, §2.5 Artifact Contract)
- Related design materials:
  - GitHub Issues #100–#108 (all labeled [Prompt Engineering])
  - Each issue contains detailed specification, acceptance criteria, and non-goals
- Current code constraints:
  - `src/prompt/index.ts` (1361 lines) — mature PromptPacket builder, renderer, validator, artifact writer
  - `src/prompt/templates/*.md` — 8 template files for prompt sections
  - `src/workflow/index.ts` — workflow schema with full step definition support (permissions, returns, signals, variables, etc.)
  - `tests/prompt/prompt.test.ts` — comprehensive test suite with snapshot coverage
  - `tests/prompt/__snapshots__/prompt.test.ts.snap` — golden prompt snapshots

## Stage Goal

- **Goal:** Harden Agent prompt quality by adding structural sections (allowed actions matrix, instruction priority, stop conditions, context use policy, verification evidence, signal semantics, artifact reference schema), step-specific output contracts, and a prompt quality gate that fails fast on detectable issues.
- **Milestones:**
  1. Wave 1: Quality gate (#107) + Step-specific output schemas (#100)
  2. Wave 2: Allowed actions matrix (#101) + Instruction priority & stop conditions (#102) + Context use policy (#103) + Verification evidence table (#104)
  3. Wave 3: Signal semantics table (#105) + Fail-fast no primary prompt (#106) + Artifact reference schema (#108)
- **Acceptance criteria:**
  - All agent prompts render the new structural sections
  - Prompt quality gate catches unresolved templates, missing sections, future artifact leakage, and permission conflicts
  - Step-specific output schemas are validated per-step
  - All existing snapshot tests are updated to reflect new prompt structure
  - `pnpm typecheck && pnpm lint && pnpm test:ci` pass

## Boundary

- **In scope:**
  - `src/prompt/index.ts` — new packet fields, builder functions, renderer logic
  - `src/prompt/qualityGate.ts` — new file for #107 quality gate
  - `src/prompt/templates/*.md` — new template files for new sections
  - `src/workflow/index.ts` — schema extensions for `outputs_schema`, `allow_generic_prompt`, signal `description`/`when`/`engine_effect`
  - `tests/prompt/prompt.test.ts` — test coverage for all new sections
  - `tests/prompt/__snapshots__/prompt.test.ts.snap` — updated snapshots
- **Out of scope:**
  - Engine state transition changes
  - Runtime Agent backend changes (only prompt rendering and validation)
  - LLM-based prompt quality judgment
  - Complex RBAC/permission system changes
  - Docker, MCP, PR automation
- **External dependencies:** None — all changes are self-contained within the prompt and workflow modules

## Findings

| ID | Type | Description | Impact | Blocking |
| --- | --- | --- | --- | --- |
| F-01 | Architecture | output-contract-lines.md has unreferenced template placeholders `{{outputsSchemaSection}}`, `{{artifactPolicySection}}`, `{{signalPolicySection}}` — these are not in TEMPLATE_PLACEHOLDERS and will cause template validation errors if referenced | Medium | No — addressed in #100 implementation |
| F-02 | Dependency | #107 (quality gate) is foundational for Waves 2 and 3 — detecting missing sections and future artifacts depends on the quality gate infrastructure | High | No — wave ordering already accounts for this |
| F-03 | Dependency | #106 (fail-fast no primary prompt) partially overlaps with #107 quality gate — both detect no-primary-prompt condition | Medium | No — #107 adds detection in quality gate, #106 adds schema flag and behavior change |
| F-04 | Design Gap | #100 proposes `outputs_schema` in workflow YAML but current `StepDefinition` has `outputs` as `Record<string, unknown>` only. Need to decide schema syntax. | Medium | No — resolved in development plan |
| F-05 | Risk | Snapshot test updates require careful review — 3 golden snapshots exist (plan, implement, review) plus fallback and inline prompt snapshots | Low | No — addressed in acceptance criteria |
| F-06 | Design | #105 signal semantics table requires workflow signal declarations to support `description`, `when`, `required_evidence`, `engine_effect` fields, but current schema uses `.passthrough()` so unknown fields are already accepted | Low | No — schema already permissive |

## Decision

- **Ready for development: Yes**
- **Reason:** All 9 issues have clear specifications with non-overlapping scope. The codebase has mature prompt infrastructure that can absorb these additions. The issues are logically sequenced in 3 waves with minimal inter-wave coupling. No external dependencies or blocking design gaps exist. The current workflow schema already supports unknown properties via `.passthrough()`, making backward-compatible additions straightforward.

## Required Follow-up

- **Item:** Verify snapshot test updates match design intent after each wave
- **Owner suggestion:** phase-development-supervisor (acceptance review)
- **Exit condition:** All snapshots reviewed and intentional changes confirmed
