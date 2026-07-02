# Prompt Engineering Hardening — Development Plan

**Date:** 2026-07-02
**Author:** phase-development-supervisor
**Status:** Draft

## Objective

- **Business objective:** Improve Agent prompt quality and safety by adding structural hardening sections (allowed actions matrix, instruction priority, stop conditions, context use policy, verification evidence tables, signal semantics, artifact reference schemas) and a deterministic prompt quality gate. Reduce the risk of Agent misinterpreting permissions, skipping required outputs, or acting on future artifacts.
- **Technical objective:** Extend `src/prompt/index.ts` (packet builder, renderer, validator), add `src/prompt/qualityGate.ts` for automated prompt quality checks, extend `src/workflow/index.ts` for new step-level schema fields, and add/modify templates in `src/prompt/templates/`.

## Scope

- **In scope:**
  - Prompt quality gate (#107): detect unresolved templates, missing sections, future artifact leakage, permission conflicts
  - Step-specific output schemas (#100): per-step `outputs_schema`, `artifact_policy`, `signal_policy` in workflow schema and prompt rendering
  - Allowed actions matrix (#101): fixed per-step permission matrix in every agent prompt
  - Instruction priority & stop conditions (#102): priority hierarchy and explicit stop rules in every agent prompt
  - Context use policy (#103): classified context blocks (mandatory-included, mandatory-external, evidence, optional) with canonical paths
  - Verification evidence table (#104): structured evidence table for review/summarize steps from upstream artifacts
  - Signal semantics table (#105): structured signal descriptions with trigger conditions, evidence requirements, and engine effects
  - Fail-fast no primary prompt (#106): default to error when no primary prompt, opt-in via `allow_generic_prompt: true`
  - Artifact reference schema (#108): explicit artifact reference format in output contract (agent-created vs existing evidence)
- **Out of scope:**
  - Engine state transition changes
  - Runtime Agent backend changes
  - LLM-based prompt quality judgment
  - Complex RBAC system
  - Report validator runtime changes (only prompt-time validation)

## Milestones

| Milestone | Description | Exit criteria |
| --- | --- | --- |
| M1 — Wave 1 | Quality gate + Step-specific output schemas | `pnpm typecheck && pnpm lint && pnpm test:ci` pass; all existing snapshots updated; quality gate catches unresolved templates/missing sections; step-specific schemas render in output contract |
| M2 — Wave 2 | Structural sections (actions matrix, priority, stop, context policy, evidence table) | All gates pass; all 4 new sections render in appropriate prompts; context blocks classified by policy; evidence table populated from upstream artifacts |
| M3 — Wave 3 | Signal semantics, fail-fast, artifact schema | All gates pass; signal table renders with conditions/effects; no-primary-prompt fails by default; artifact schema renders in output contract |

## Technical Approach

- **Architecture and module changes:**
  - `src/prompt/qualityGate.ts` (new): `checkPromptQuality(packet, rendered)` → `PromptQualityResult { errors, warnings, diagnostics }`
  - `src/prompt/index.ts`: new fields on `PromptPacket`, `OutputContract`, and `ContextBlock`; new builder functions for each section; integrate quality gate into `buildPromptPacket` flow
  - `src/prompt/templates/`: new templates for actions-matrix, instruction-priority, stop-conditions, context-use-policy, verification-evidence, signal-semantics, artifact-schema
  - `src/workflow/index.ts`: add `outputs_schema`, `artifact_policy`, `signal_policy`, `allow_generic_prompt` to `StepBaseSchema` and `StepDefinition`
- **Data/API changes:**
  - `OutputContract` gains: `stepOutputSchema`, `artifactPolicy`, `signalPolicy`, `allowedActionsMatrix`, `evidenceTable`
  - `PromptPacket` gains: `instructions` block (priority + stop), `contextPolicy` metadata
  - `ContextBlock` gains: `contextClass` (mandatory-included / mandatory-external / evidence / optional), `canonicalPath`
- **Testing strategy:**
  - Unit tests for quality gate checks (each detection, both error and warning paths)
  - Unit tests for each new section rendering
  - Snapshot test updates for all 3 golden prompts + fallback prompt
  - Contract tests for workflow schema validation of new fields
- **Release or migration notes:**
  - Backward-compatible: existing prompts gain new sections but retain all previous content
  - Breaking: Agent steps without primary prompts now fail by default (#106); existing fallback-dependent steps must add `allow_generic_prompt: true`

## Workflow Breakdown

| Workflow | Goal | Dependencies | Acceptance criteria | Research needed |
| --- | --- | --- | --- | --- |
| wf-prompt-hardening-wave1 | Quality gate + Step-specific output schemas (#107, #100) | None (wave 1) | Quality gate catches 7 detection categories; step-specific schemas render in output contract; 2 new snapshot variants | None |
| wf-prompt-hardening-wave2 | Structural sections (#101, #102, #103, #104) | Wave 1 (uses quality gate infrastructure) | 4 new sections render in agent prompts; context blocks classified; evidence table populated | None |
| wf-prompt-hardening-wave3 | Signal semantics, fail-fast, artifact schema (#105, #106, #108) | Waves 1–2 | Signal table renders with conditions/effects; no-primary-prompt fails by default; artifact schema renders | None |

## Risks And Mitigations

| Risk | Probability | Impact | Mitigation | Owner |
| --- | --- | --- | --- | --- |
| Snapshot churn across 3 waves | High | Low | Each wave updates snapshots atomically; wave ordering minimizes re-render iteration | phase-supervisor |
| Quality gate false positives | Medium | Medium | Gate defaults to warning for subjective checks; only objective checks are errors; escape hatch via `allow_generic_prompt` | implementation subagent |
| Template proliferation | Low | Low | Limit to 1 new template per section; reuse existing rendering patterns | implementation subagent |
| Permission boundary confusion | Low | Medium | Allowed Actions Matrix derived from existing permissions model — no new rules, only rendering | implementation subagent |

## Quality Bar

- **Required automated tests:**
  - `pnpm typecheck` — zero errors
  - `pnpm lint` — zero errors
  - `pnpm test:ci` — all tests pass, including updated snapshots
- **Required manual checks:**
  - Review updated golden snapshots for intentionality
  - Verify quality gate error messages include job/step id and fix suggestion
- **Performance / reliability constraints:**
  - Quality gate must run in < 10ms for typical prompt size
  - No template loading changes that would slow prompt generation
- **Documentation updates:**
  - Phase docs: readiness review, development plan, acceptance reports

## Open Decisions

| Decision | Options | Research task | Due trigger |
| --- | --- | --- | --- | --- |
| Quality gate severity levels | error/warning only vs error/warning/info | None — use 2-level model from #107 spec | Already decided in issue spec |
| Step-specific output schema syntax | YAML-inline JSON schema vs key-value shorthand | None — use key-value shorthand from #100 example | Already decided in issue spec |
| Context block classification | infer from existing fields vs require explicit declaration | None — infer from readPolicy and content inclusion | Already decided in issue spec |

## Freeze Record

- **Plan status:** Frozen
- **Frozen at:** 2026-07-02
- **Final decisions:**
  - 3-wave structure with one workflow per wave (not per-issue)
  - Wave 1 establishes quality gate infrastructure that Waves 2–3 build upon
  - All prompt section additions use existing template rendering pattern (`renderTemplate`)
  - Workflow schema extensions use `.passthrough()` compatibility with existing workflow YAML
- **Residual risks:**
  - Snapshot review requires human judgment for prompt quality; quality gate provides automated guard but cannot assess subjective readability
  - Context block classification is inference-based (not explicit declaration) — future work may add explicit policy fields to Skill Pack knowledge declarations
