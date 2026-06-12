---
workflow: WF-P11-SKILL-PACK
title: Skill Pack Content + Code-change Workflow Refinement — Cases and Failing Tests
phase: P11
status: red (Step 1)
date: 2026-06-12
authority: docs/prd.md §9, §10, §11, §12, §20, docs/phases/p11-skill-pack-refinement/02-development-plan.md
spec-source:
  - docs/phases/p11-skill-pack-refinement/02-development-plan.md §1, §3 (AD-P11-S-001..005), §4 WF-P11-SKILL-PACK, §6
  - src/init/templates.ts (P10 baseline — Step 2 will refine content)
  - src/init/index.ts (P10 baseline — Step 2 will add common-failure-patterns.md to file list)
  - tests/init/init.test.ts (P10 baseline — Step 2 will update TC-WORKFLOW-10 assertion via T-P11-9)
---

# WF-P11-SKILL-PACK — Cases and Failing Tests

## 0. Purpose

P10 shipped the structural shell of the code-change workflow and Skill Pack
(10-job DAG, valid `skill.yml`, six prompt files, two knowledge files, schema
checks). The shell is structurally valid but the content quality is still
boilerplate:

- `coding-guidelines.md` is generic and does not call out "small-step" /
  incremental editing or the prohibition on touching `.zigma-flow/state.json` /
  `.zigma-flow/config.json` / `runs/`.
- `implement.md` lacks an explicit forbidden-actions section.
- `review.md` does not define the `approved` / `rejected` /
  `needs_architecture_design` output vocabulary.
- `summarize.md` outputs `summary` + `files_changed` but not the
  `final_summary` / `remaining_risks` fields used by the dogfood report
  acceptance loop.
- `skill.yml` declares `functions: []` — no `implement-by-plan` /
  `review-change` entries.
- `collect-diff.ts` is a placeholder with the real git logic commented out.
- The `implement` job is a single agent step; per AD-P11-S-002 it needs three
  steps (agent edit + script collect-diff + check check-diff).
- A new `knowledge/common-failure-patterns.md` file is missing from the
  template inventory entirely.

WF-P11-SKILL-PACK turns the templates into something that survives a real
dogfood pass without further hand-editing. The change is intentionally bounded
to `src/init/templates.ts` and `src/init/index.ts` (AD-P11-S-001).

## 1. Workflow Goal

After Step 2 ships, `zigma-flow init` must produce:

1. A new `knowledge/common-failure-patterns.md` file written by `runInit()` —
   discoverable to the agent via the Skill Pack knowledge index.
2. A `coding-guidelines.md` whose body explicitly names "small step" /
   "incremental" change patterns and explicitly forbids modifying state /
   runtime files under `.zigma-flow/`.
3. An `implement.md` prompt containing a forbidden-action section (must-not /
   forbidden / do-not-modify phrasing) so the agent knows what is out of scope.
4. A `review.md` prompt whose output spec names the `approved`, `rejected`,
   and `needs_architecture_design` verdict vocabulary, aligned with the
   workflow's signals.
5. A `summarize.md` prompt whose output spec requires `final_summary` and
   `remaining_risks` fields.
6. A `skill.yml` whose `functions:` array is non-empty and contains at least
   an `implement-by-plan` entry (the `review-change` entry is also expected
   per AD-P11-S-003).
7. An `implement` job in `code-change.yml` whose `steps:` array contains ≥ 3
   entries (agent edit, script collect-diff, check check-diff).
8. A `collect-diff.ts` that contains a real `git diff` invocation in active
   code (not only in a commented example).
9. The legacy TC-WORKFLOW-10 functions assertion (`functions ?? []).toEqual([])`)
   replaced with a new assertion (`functions.length >= 2`) that matches the
   new schema.

## 2. Function Points

| ID                   | Functional Point                                                                                                          | Spec Source        | Impacted File                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------- |
| FP-P11-CFP-FILE      | `runInit()` writes `skills/code-change/knowledge/common-failure-patterns.md`                                              | AD-P11-S-001       | `src/init/templates.ts`, `src/init/index.ts`               |
| FP-P11-GUIDELINES    | `coding-guidelines.md` mentions small-step/incremental change AND prohibits modifying state/runtime files                 | §1 acceptance      | `src/init/templates.ts`                                    |
| FP-P11-IMPLEMENT-FA  | `implement.md` includes a forbidden-action section (must-not / forbidden / do-not-modify phrasing)                        | §1 acceptance      | `src/init/templates.ts`                                    |
| FP-P11-REVIEW-OUT    | `review.md` output spec names `approved`, `rejected`, and `needs_architecture_design`                                     | §1 acceptance      | `src/init/templates.ts`                                    |
| FP-P11-SUMMARIZE-OUT | `summarize.md` output spec names `final_summary` AND `remaining_risks`                                                    | §1 acceptance      | `src/init/templates.ts`                                    |
| FP-P11-FUNCTIONS     | `skill.yml` `functions:` is non-empty and contains an entry with `id: implement-by-plan`                                  | AD-P11-S-003       | `src/init/templates.ts`                                    |
| FP-P11-IMPLEMENT-3   | `implement` job declares ≥ 3 steps in order (agent edit, script collect-diff, check)                                      | AD-P11-S-002       | `src/init/templates.ts`                                    |
| FP-P11-DIFF-REAL     | `collect-diff.ts` contains an active `git diff` invocation (not commented-out example)                                    | AD-P11-S-004       | `src/init/templates.ts`                                    |
| FP-P11-TC10-UPDATE   | TC-WORKFLOW-10's `functions === []` assertion is superseded by a `length >= 2` assertion in the new describe block        | §6, §8 risk row    | `tests/init/init.test.ts`                                  |

## 3. Use Cases

| Case ID   | Description                                                                                          | Test ID   |
| --------- | ---------------------------------------------------------------------------------------------------- | --------- |
| UC-P11-1  | A fresh `zigma-flow init` lays down `common-failure-patterns.md` next to existing knowledge files    | T-P11-1   |
| UC-P11-2  | An agent reading `coding-guidelines.md` finds explicit small-step + state-file guidance              | T-P11-2   |
| UC-P11-3  | An implement-step agent reading `implement.md` sees a forbidden-actions section                      | T-P11-3   |
| UC-P11-4  | A review-step agent reading `review.md` learns the `approved`/`rejected`/`needs_architecture_design` verdict vocabulary | T-P11-4 |
| UC-P11-5  | A summarize-step agent reading `summarize.md` writes a report with `final_summary` + `remaining_risks` | T-P11-5 |
| UC-P11-6  | `loadSkillPack()` returns a definition whose `functions` array contains `implement-by-plan`          | T-P11-6   |
| UC-P11-7  | The Engine running the `implement` job advances through three steps (agent → script → check)         | T-P11-7   |
| UC-P11-8  | The `collect-diff` script template can be executed directly to capture a real git diff               | T-P11-8   |
| UC-P11-9  | The P10 TC-WORKFLOW-10 `functions === []` assumption is replaced with the P11 contract               | T-P11-9   |

## 4. Test Plan

All tests live in `tests/init/init.test.ts` inside a new describe block:
`describe("P11 Skill Pack refinement (WF-P11-SKILL-PACK)", () => { ... })`.

Each test follows the existing pattern:

- `beforeEach`: `mkdtemp` a tempDir under `tmpdir()`.
- `afterEach`: `rm` it recursively.
- Trigger: `await safeRunInit(tempDir)`.
- Assert against files under `join(tempDir, ".zigma-flow", ...)`.

The tests are RED until Step 2 implements the template changes.

### T-P11-1 — `common-failure-patterns.md` is written by `runInit()`

- **Setup**: empty temp directory.
- **Trigger**: `await safeRunInit(tempDir)`.
- **Assert**:
  - `await pathExists(join(dotZigma, "skills", "code-change", "knowledge", "common-failure-patterns.md"))` is `true`.
  - The file body is non-empty (`text.trim().length > 0`).
- **Red reason**: `commonFailurePatternsMd()` does not exist in
  `src/init/templates.ts`, and `runInit()` does not include the file in its
  `fileEntries` list.

Covers FP-P11-CFP-FILE.

### T-P11-2 — `coding-guidelines.md` mentions small-step and state-file restrictions

- **Setup**: empty temp directory.
- **Trigger**: `await safeRunInit(tempDir)`.
- **Assert**:
  - Read `coding-guidelines.md`.
  - Body matches `/small.step|incremental/i` (case-insensitive).
  - Body matches `/state|runtime|\.zigma-flow/i` together with a
    prohibition cue (`/must not|do not modify|forbidden|never modify/i`).
- **Red reason**: current `codingGuidelinesMd()` is generic style guidance
  only; it never mentions small-step changes or `.zigma-flow` state files.

Covers FP-P11-GUIDELINES.

### T-P11-3 — `implement.md` contains forbidden-action guidance

- **Setup**: empty temp directory.
- **Trigger**: `await safeRunInit(tempDir)`.
- **Assert**:
  - Read `implement.md`.
  - Lowercased body matches at least one of:
    `must not`, `do not modify`, `forbidden`, `禁止`.
- **Red reason**: current `implementMd()` lists positive instructions only;
  no forbidden-action section exists.

Covers FP-P11-IMPLEMENT-FA.

### T-P11-4 — `review.md` specifies approved/rejected/needs_architecture_design output

- **Setup**: empty temp directory.
- **Trigger**: `await safeRunInit(tempDir)`.
- **Assert**:
  - Read `review.md`.
  - Body contains the substring `approved`.
  - Body contains the substring `rejected`.
  - Body contains the substring `needs_architecture_design`.
- **Red reason**: current `reviewMd()` mentions signals but does not
  enumerate the three verdict tokens together as the canonical output
  vocabulary.

Covers FP-P11-REVIEW-OUT.

### T-P11-5 — `summarize.md` requires final_summary and remaining_risks outputs

- **Setup**: empty temp directory.
- **Trigger**: `await safeRunInit(tempDir)`.
- **Assert**:
  - Read `summarize.md`.
  - Body contains the substring `final_summary`.
  - Body contains the substring `remaining_risks`.
- **Red reason**: current `summarizeMd()` outputs `summary` and
  `files_changed`; neither `final_summary` nor `remaining_risks` is present.

Covers FP-P11-SUMMARIZE-OUT.

### T-P11-6 — `skill.yml` functions section is non-empty with implement-by-plan entry

- **Setup**: empty temp directory.
- **Trigger**: `await safeRunInit(tempDir)`; then
  `await loadSkillPack(join(dotZigma, "skills", "code-change"))`.
- **Assert**:
  - `def.functions` is a non-empty array.
  - At least one entry has `id === "implement-by-plan"`.
- **Red reason**: current `skillYml()` declares `functions: []`.

Covers FP-P11-FUNCTIONS.

### T-P11-7 — `implement` job has ≥ 3 steps

- **Setup**: empty temp directory.
- **Trigger**: `await safeRunInit(tempDir)`; load
  `workflows/code-change.yml` via `loadWorkflow(yamlText)`.
- **Assert**:
  - `wf.jobs["implement"].steps.length >= 3`.
  - `wf.jobs["implement"].steps[0].type === "agent"` (preserves
    TC-WORKFLOW-4's expectation that the first step is an agent step).
- **Red reason**: current `codeChangeWorkflowYml()` declares a single agent
  step for `implement`.

Covers FP-P11-IMPLEMENT-3.

### T-P11-8 — `collect-diff.ts` contains real git diff logic

- **Setup**: empty temp directory.
- **Trigger**: `await safeRunInit(tempDir)`.
- **Assert**:
  - Read `skills/code-change/scripts/collect-diff.ts`.
  - Strip out single-line comments (any line whose first non-whitespace
    chars are `//`) and block-comment bodies before searching, OR assert
    that the file contains an active (non-commented) `git diff` string.
  - Concretely: take the file text, split on lines, keep lines that do
    NOT start with `//` (after trim), join, then assert that the
    remaining text matches `/git diff/`.
- **Red reason**: current `collectDiffTs()` template only contains the
  string `git diff` inside a `// import { execSync } ...` example block —
  there is no active executable git invocation.

Covers FP-P11-DIFF-REAL.

### T-P11-9 — `skill.yml` functions length ≥ 2 (TC-WORKFLOW-10 successor)

- **Setup**: empty temp directory.
- **Trigger**: `await safeRunInit(tempDir)`; then
  `await loadSkillPack(join(dotZigma, "skills", "code-change"))`.
- **Assert**:
  - `(def.functions ?? []).length >= 2` (covers `implement-by-plan` and
    `review-change` per AD-P11-S-003).
- **Red reason**: the legacy TC-WORKFLOW-10 inside the
  `code-change template (WF-P10-WORKFLOW)` describe block still asserts
  `(def.functions ?? []).toEqual([])`. Step 2 will update that assertion
  in place; this T-P11-9 case provides the forward contract under the new
  describe block so that the P11 acceptance set is self-contained.

Covers FP-P11-TC10-UPDATE.

## 5. Implementation Boundary (Step 2)

- **Files Step 2 may modify**:
  - `src/init/templates.ts` — refine `codingGuidelinesMd`, `implementMd`,
    `reviewMd`, `summarizeMd`, `skillYml`, `collectDiffTs`,
    `codeChangeWorkflowYml`; add `commonFailurePatternsMd`.
  - `src/init/index.ts` — import `commonFailurePatternsMd` and add an
    entry to `fileEntries` writing it to
    `.zigma-flow/skills/code-change/knowledge/common-failure-patterns.md`.
  - `tests/init/init.test.ts` — update TC-WORKFLOW-10's assertion
    `expect(def.functions ?? []).toEqual([])` to a forward-compatible form
    such as `expect((def.functions ?? []).length).toBeGreaterThanOrEqual(2)`.
- **Files Step 2 must NOT modify**: `src/workflow/index.ts`,
  `src/skill-pack/index.ts`, `src/engine/**`, any other runtime code.
- **Backward compatibility**:
  - TC-WORKFLOW-1..9 must continue to pass — the file inventory and DAG
    contract from P10 are preserved.
  - TC-WORKFLOW-4's "first step of agent jobs is `type: agent`" assertion
    must keep holding for the multi-step `implement` job (the first step is
    still the agent step).
  - All P1 `T-INIT-1..12` tests must continue to pass.

## 6. Acceptance Checklist

- T-P11-1..9 turn green after Step 2.
- TC-WORKFLOW-10's `functions === []` assertion is rewritten in place by
  Step 2 and turns green.
- Pre-existing T-INIT-1..12 and TC-WORKFLOW-1..9 stay green.
- `pnpm typecheck && pnpm lint && pnpm test` passes (367 baseline + the new
  P11 cases).
- No Engine, Workflow, Skill Pack loader, or CLI runtime code is modified —
  changes are isolated to `src/init/**` and `tests/init/init.test.ts`.
