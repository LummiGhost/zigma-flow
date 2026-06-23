---
phase: p12-integration-quality
workflow: wf-p12-inline-prompt
title: Agent Step Inline Prompt Template — Development Plan
status: frozen
date: 2026-06-23
authority: GitHub Issue #83, docs/mvp-contracts.md §5, docs/architecture.md §5
project-items: P12.9.1, P12.9.2, P12.9.3, P12.9.4, P12.9.5
---

# P12.9 Agent Step Inline Prompt Template — Development Plan

## 1. Objective

- **Business objective**: Allow workflow authors to write step-specific prompt templates directly in workflow YAML, without requiring an external Skill Pack prompt file.
- **Technical objective**: Extend the Context Builder to detect inline prompt templates, bypass Skill Pack lookup for inline content, render them through the expression resolver, and emit the resolved content into the prompt packet and current-step.md.

## 2. Scope

- **In scope**:
  - Agent Step `prompt:` field accepts multiline template strings (YAML `|` block scalar).
  - Inline templates support `${{ inputs.* }}`, `${{ run.id }}`, `${{ run.workflow }}` expression substitution via existing `resolveExpression()`.
  - Inline content is detected when `step.prompt` is multiline or contains `${{ }}` tokens — bypasses Skill Pack prompt file lookup.
  - If `step.prompt` is inline AND matches a Skill Pack prompt ID: validation error (conflict detection).
  - Prompt packet / current-step.md includes the resolved step prompt body, not just a reference path.
  - Existing Skill Pack prompt references and external prompt files continue to work.

- **Out of scope**:
  - New expression patterns beyond existing `${{ inputs.* }}`, `${{ run.* }}`, `${{ retry.inputs.* }}`.
  - Exposing full workflow details in the prompt (MVP boundary: §5, prompt must not include full workflow).
  - Inline prompts for non-agent step types.

## 3. Technical Approach

### Design Decision: Inline Detection

**Chosen**: Heuristic detection from content.
- If `step.prompt` contains newlines → inline template.
- If `step.prompt` contains `${{ }}` pattern → inline template.
- Otherwise → treated as Skill Pack prompt reference ID (current behavior).

**Why**: Backward compatible; matches the YAML `|` block scalar convention in the issue's suggested example; no new schema fields needed.

### Conflict Detection Rule

When `step.prompt` is inline AND the agent step also has `expose.skills` that contain a prompt with an ID matching `step.prompt` (as a single-line reference): **validation error** at context build time. This prevents ambiguity.

### Module Changes

| Module | Change |
|--------|--------|
| `src/context/index.ts` | Add `isInlinePrompt()` helper; modify primary prompt resolution to render inline templates directly; add conflict detection |
| `src/prompt/templates/step-prompt.md` | Update template to clarify inline prompt source display |
| `src/prompt/index.ts` | No functional change needed — `buildWorkflowStepPrompt()` already renders `primaryPrompt.content` generically |
| `src/workflow/index.ts` | No schema change needed — `prompt: z.string().optional()` already accepts multiline strings |
| `tests/context/context.test.ts` | Add inline prompt test cases |
| `tests/prompt/prompt.test.ts` | Add inline prompt rendering snapshot tests |
| `.zigma-flow/workflows/code-change.yml` | Add an Agent Step with inline prompt as example |

### Testing Strategy

- **Unit tests**: `isInlinePrompt()`, inline prompt resolution in context builder, conflict detection errors.
- **Integration tests**: Context bundle includes rendered inline content; prompt packet includes step prompt body.
- **Golden snapshot tests**: Prompt output with inline prompt content is as expected.
- **Negative tests**: Conflict between inline prompt and Skill Pack prompt ID; invalid expression patterns.

## 4. Workflow Breakdown

Single workflow WF-P12-INLINE-PROMPT covering all 5 sub-tasks:

| Sub-task | Description | Delivered by |
|----------|-------------|--------------|
| P12.9.1 | Design contract (this document + issue body) | Already done |
| P12.9.2 | Update workflow schema/loader | Step 2 |
| P12.9.3 | Template rendering in Context/Prompt Builder | Step 2 |
| P12.9.4 | Expression and error path tests | Step 1 + Step 2 |
| P12.9.5 | Update built-in workflow and snapshots | Step 2 |

## 5. Quality Bar

- `pnpm typecheck && pnpm lint` pass.
- All existing tests (376+) continue to pass.
- New test cases cover: inline detection, rendering, conflict errors, expression substitution.
- Golden prompt snapshots updated.

## 6. Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Inline detection heuristic misfires (e.g., single-line reference with `${{ }}`) | Low | Med | The `${{ }}` heuristic is safe: any prompt reference ID containing `${{ }}` would be nonsensical as a Skill Pack prompt ID |
| Conflict detection causes false positives | Low | Low | Only triggers when inline AND Skill Pack prompt ID match simultaneously |

## 7. Freeze Record

- Plan status: Frozen
- Frozen at: 2026-06-23
- Final design decision: Heuristic inline detection (newlines or `${{ }}` patterns)
- Conflict rule: Inline + matching Skill Pack prompt ID → error
- Residual risks: None blocking
