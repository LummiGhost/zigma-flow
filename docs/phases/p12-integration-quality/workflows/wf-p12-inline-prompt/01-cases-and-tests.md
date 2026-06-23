# WF-P12-INLINE-PROMPT — Cases and Tests

- Workflow: WF-P12-INLINE-PROMPT
- Phase: P12 Integration Quality
- Step: 1 (Cases and Tests)
- Date: 2026-06-23
- Author: subagent (workflow Step 1)
- Authority: GitHub Issue #83, docs/mvp-contracts.md §5, docs/architecture.md §5
- Project items: P12.9.1, P12.9.2, P12.9.3, P12.9.4, P12.9.5

## Slice Boundary

- Slice name: P12-INLINE-PROMPT
- Bounded context: **Agent Context** (architecture.md §6.1) — owned by the
  `context/` module together with `prompt/`. This slice extends the existing
  `buildContext()` primary prompt resolution path and the `step-prompt.md`
  template rendering path. No new module is introduced.
- Bounded context interactions: this slice **consumes** the same upstream
  modules as WF-P5-CONTEXT (Workflow Definition, Skill Pack, Run Runtime,
  Artifact) read-only. It **adds** a new detection heuristic
  (`isInlinePrompt()`) and a new conflict check at context build time.
  It does **not** import `commander`, `execa`, `simple-git`, or any
  CLI/runner adapter, and it **must not** mutate run state or write events.
- User tasks covered: **none — pure library workflow.** No CLI surface, no
  user-visible commands. Tests cover library contracts only. The user-facing
  impact is that workflow YAML authors can write inline prompt templates
  using YAML `|` block scalars instead of requiring external Skill Pack
  prompt files.
- Planned test files (2 / max 2):
  - `tests/context/context.test.ts` — unit tests for `isInlinePrompt()`
    helper, inline prompt detection in buildContext, conflict detection
    errors.
  - `tests/prompt/prompt.test.ts` — golden snapshot test for inline prompt
    rendering in the Workflow Step Prompt layer.

Slice within 0-user-task and 2-test-file budget. No CLI surface is delivered
in WF-P12-INLINE-PROMPT; CLI wiring already exists from WF-P5-PROMPT.

## Workflow Goal

Allow Agent Steps in workflow YAML to declare inline prompt template strings
(using YAML `|` block scalars) instead of only referencing external Skill
Pack prompt files. The Context Builder detects inline content heuristically,
bypasses Skill Pack lookup for it, renders it through the expression
resolver, and emits the resolved content into the prompt packet and
current-step.md.

### 1. `isInlinePrompt()` detection helper

```ts
export function isInlinePrompt(prompt: string | undefined): boolean;
```

Contract:

- If `prompt` is `undefined`, returns `false`.
- If `prompt` is a zero-length or whitespace-only string, returns `false`.
- If `prompt` contains one or more newline characters (`\n`, `\r\n`),
  returns `true` — inline template.
- If `prompt` is a single line but contains at least one `${{ ... }}`
  pattern, returns `true` — inline template.
- Otherwise, returns `false` — treated as a Skill Pack prompt reference ID
  (existing behaviour preserved).

Design rationale (from frozen development plan): backward compatible;
matches the YAML `|` block scalar convention in the issue's suggested
example; no new schema fields needed.

### 2. Inline prompt resolution in `buildContext()`

When `step.type === "agent"` and `step.prompt` is detected as inline
(via `isInlinePrompt`):

1. **Skip Skill Pack file lookup.** Do not attempt to match
   `step.prompt` against any `pack.prompts[]` entry. Do not read a
   prompt file from disk.

2. **Resolve expressions.** Pass the raw inline template text through
   `resolveExpression()` using the same expression context as
   `step.with` resolution:

   ```ts
   const exprCtx = {
     inputs: { task: state.task },
     run: { id: state.run_id, workflow: state.workflow },
   };
   ```

3. **Populate `PrimaryPrompt`:**

   ```ts
   primaryPrompt = {
     skill: <first exposed skill alias or "">,
     id: "(inline)",
     path: "(inline template)",
     content: resolveExpression(rawTemplate, exprCtx),
     source: "step.prompt",
   };
   ```

   - `skill` is the alias of the first Skill Pack exposed by the step, or
     `""` if the agent step has no `expose.skills`. This preserves
     backward compatibility with the `ExposedCapabilities.prompts[]`
     skill-tagging convention.
   - `id` is `"(inline)"` to distinguish from Skill Pack prompt IDs in
     template output.
   - `path` is `"(inline template)"` — no file on disk.
   - `content` is the expression-resolved template body.
   - `source` is `"step.prompt"` — the prompt originates from the step's
     `prompt:` YAML field.

4. **No Skill Pack lookup for inline prompts.** The primary prompt
   resolution loop skips prompt file matching when the candidate is
   inline. The inline prompt takes priority over `job.id` and `step.id`
   candidates just as an explicit Skill Pack `prompt:` reference would.

5. **Agent step without `expose.skills`:** An inline prompt must still
   resolve and produce `primaryPrompt` even when the step has no
   `expose.skills` field. The `skill` field on `PrimaryPrompt` will
   be `""` in this case. The fallback warning ("No primary prompt
   resolved …") must NOT be emitted when inline prompt content is
   present.

### 3. Conflict detection

When `step.prompt` is detected as inline AND the agent step also has
`expose.skills`:

- After loading all Skill Packs, check whether any loaded pack's
  `prompts[]` contains a prompt whose `id` matches the raw
  `step.prompt` value (interpreted as a single-line reference ID).
- **Match rule:** the raw `step.prompt` (with leading/trailing whitespace
  trimmed) is compared against each `pack.prompts[].id` using the
  existing `promptIdMatches()` logic (exact, `alias.id`, or
  `alias/id` patterns).
- If a match is found, throw `WorkflowError` with a message indicating
  that the inline prompt conflicts with a Skill Pack prompt of the
  same ID.

Rationale: prevents ambiguity. Without this rule a workflow author
might mistakenly think their inline prompt is overriding a Skill Pack
prompt, or that a Skill Pack prompt is loaded from the inline text.

### 4. Backward compatibility

- **Skill Pack prompt references unchanged.** When `step.prompt` is a
  single-line string without `${{ }}` tokens, it is treated exactly as
  before — matched against `pack.prompts[]`, file read from disk, etc.
- **No prompt fallback unchanged.** When `step.prompt` is undefined or
  empty, the existing `job.id` / `step.id` fallback resolution is
  unchanged.
- **Non-agent steps unchanged.** Steps of type `script`, `check`,
  `router`, `workflow`, `human` are unaffected. The `prompt:` field on
  non-agent steps is ignored (current behaviour).

### 5. Template rendering

The existing `step-prompt.md` template renders inline prompt content
through the same `{{promptContent}}` placeholder used for Skill Pack
prompts. The `{{promptId}}` and `{{promptPath}}` placeholders render
`"(inline)"` and `"(inline template)"` respectively, making the
inline origin visible in the rendered prompt.

No new template file is needed. The existing `step-prompt-fallback.md`
template is not affected — it is used only when `primaryPrompt` is
absent, which cannot happen for inline prompts since the inline
content itself becomes the `PrimaryPrompt`.

## Acceptance Criteria

1. **M1 Inline Detection (FP-INLINE-DETECT)**
   - Multiline `step.prompt` (contains `\n`) → detected as inline.
   - Single-line `step.prompt` with `${{ }}` → detected as inline.
   - Single-line `step.prompt` without `${{ }}` → NOT inline (reference ID).
   - `undefined` or empty/whitespace-only → NOT inline.
   - Mixed `\r\n` line endings → detected as inline.

2. **M2 Inline Prompt Resolution (FP-INLINE-RESOLVE)**
   - Agent step with inline multiline prompt (`expose.skills` present) →
     `primaryPrompt` populated with resolved content, source `"step.prompt"`,
     id `"(inline)"`, path `"(inline template)"`.
   - Agent step with inline prompt but no `expose.skills` →
     `primaryPrompt` still populated (no Skill Pack needed for inline).
   - `${{ inputs.task }}`, `${{ run.id }}`, `${{ run.workflow }}`
     expressions resolved in the inline template body.
   - Unknown expression patterns (`${{ jobs.x.outputs.y }}`) pass through
     unchanged in the inline template body.
   - No file read from disk for inline prompt content.
   - No warning emitted when inline prompt resolves successfully.

3. **M3 Conflict Detection (FP-INLINE-CONFLICT)**
   - Inline prompt whose raw trimmed text matches a loaded Skill Pack
     prompt `id` → throws `WorkflowError`.
   - Inline prompt that does NOT match any Skill Pack prompt `id` → OK.
   - Single-line reference (not inline) matching a Skill Pack prompt
     `id` → OK (normal resolution, no conflict).

4. **M4 Backward Compatibility (FP-INLINE-COMPAT)**
   - Existing Skill Pack prompt reference flow (single-line `step.prompt`
     without `${{ }}`) works identically to before.
   - No prompt → `job.id` / `step.id` fallback → fallback step prompt.
   - Non-agent step with `prompt:` field → ignored.
   - Existing golden snapshots for Skill Pack prompts are unchanged.

5. **M5 Template Rendering (FP-INLINE-RENDER)**
   - Inline prompt content is rendered in the Workflow Step Prompt layer
     of the prompt packet.
   - The inline origin is visible via `"(inline)"` id and
     `"(inline template)"` path markers.
   - The rendered output satisfies the existing prompt handoff quality
     gate (all required sections present, correct heading hierarchy,
     report path present).

## Spec Compliance Matrix

Relevant MUST / SHALL clauses from `docs/mvp-contracts.md §5` (module
dependency), `docs/architecture.md §5` (module boundaries), and
`docs/architecture.md §12.2` (prompt flow). RC numbers continue from
WF-P12-QUALITY; this workflow begins at `RC-I1`.

| #      | Clause (origin)                                                                           | Status                                    |
| ------ | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| RC-I1  | `prompt` 不得包含完整 workflow 全量细节 (mvp-contracts §5)                                  | Design constraint — inline prompt is step-scoped content, not full workflow. Verified by architecture review; no test covers this directly. |
| RC-I2  | `context` 不得绕过 `expose` 读取 Skill Pack 资源 (mvp-contracts §5)                        | 已纳入本工作流 — inline prompt resolution skips Skill Pack lookup entirely; if expose is absent, no packs are loaded. FP-INLINE-RESOLVE covers the no-expose path. |
| RC-I3  | Context Builder 决定当前 step 可见上下文 (arch §5.2)                                      | 已纳入本工作流 — `isInlinePrompt()` decides whether prompt is inline or reference. FP-INLINE-DETECT. |
| RC-I4  | Prompt Builder 只负责渲染，不读取未授权资源 (arch §5.2)                                  | 已纳入本工作流 — inline prompt content is resolved in `buildContext()`, not in prompt builder. FP-INLINE-RESOLVE. |
| RC-I5  | `zigma-flow prompt` flow: buildContext → buildPromptPacket → render (arch §12.2)         | 已纳入本工作流 — inline prompt flows through the same pipeline stages. FP-INLINE-RENDER verifies the template rendering layer. |
| RC-I6  | prompt 只含当前 step 允许能力、输出 schema、artifact 摘要和停止要求 (arch §14 可读性)    | Design constraint — inline prompt content is user-authored and does not bypass the existing Context Bundle filtration. Verified by architecture review. |
| RC-I7  | 所有导出路径必须位于 Skill Pack 目录内 (mvp-contracts §2.2)                               | 规范不适用 — inline prompts have no on-disk path within a Skill Pack. The `path: "(inline template)"` marker is not a real file path. |
| RC-I8  | `prompt` 字段类型 `z.string().optional()` 不拒绝多行字符串 (StepBaseSchema)                | 已纳入本工作流 — schema already accepts multiline strings; no schema change needed. Verified by existing schema tests. |

Spec clause budget: 8 / max 30. No TD references needed — all clauses
are traceable to the frozen development plan or existing architecture.

## Functional Points

| FP id              | Area                          | Source                          | Summary                                                                                                   |
| ------------------ | ----------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| FP-INLINE-DETECT   | Inline prompt detection       | Issue #83, dev plan §3          | `isInlinePrompt(prompt)` returns `true` for multiline or `${{ }}`-containing strings, `false` otherwise.  |
| FP-INLINE-RESOLVE  | Inline prompt resolution      | Issue #83, dev plan §3          | `buildContext` skips Skill Pack lookup for inline prompts, resolves expressions, populates `PrimaryPrompt`. |
| FP-INLINE-CONFLICT | Conflict detection            | Issue #83, dev plan §3          | When inline AND Skill Pack prompt ID matches raw text → `WorkflowError`.                                  |
| FP-INLINE-COMPAT   | Backward compatibility        | dev plan §2 Scope               | Existing Skill Pack prompt references, fallback, and non-agent step behavior unchanged.                   |
| FP-INLINE-RENDER   | Template rendering            | dev plan §3 Module Changes      | Inline prompt content rendered through `step-prompt.md` template; golden snapshot captures output.         |

## Use Cases

| UC id                | Actor | Trigger                                                                                     | Pre-conditions                                                       | Steps (happy path)                                                                                                                         | Post-conditions / observable result                                                                                   |
| -------------------- | ----- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| UC-INLINE-DETECT-1   | Lib   | `isInlinePrompt("line1\nline2")` (multiline)                                                | `step.prompt` is a string with newlines                              | Check for `\n` → inline.                                                                                                                  | Returns `true`.                                                                                                       |
| UC-INLINE-DETECT-2   | Lib   | `isInlinePrompt("Use ${{ inputs.task }}")` (single line with `${{ }}`)                     | `step.prompt` contains expression pattern                            | Check for `${{ }}` → inline.                                                                                                             | Returns `true`.                                                                                                       |
| UC-INLINE-DETECT-3   | Lib   | `isInlinePrompt("review")` (single line, no `${{ }}`)                                       | `step.prompt` is a short single-line string                          | No newlines, no `${{ }}` → reference ID.                                                                                                  | Returns `false`.                                                                                                      |
| UC-INLINE-DETECT-4   | Lib   | `isInlinePrompt("")` (empty string)                                                         | `step.prompt` is `""`                                                | Empty → not inline.                                                                                                                       | Returns `false`.                                                                                                      |
| UC-INLINE-DETECT-5   | Lib   | `isInlinePrompt(undefined)`                                                                 | `step.prompt` is absent                                              | Undefined → not inline.                                                                                                                   | Returns `false`.                                                                                                      |
| UC-INLINE-DETECT-6   | Lib   | `isInlinePrompt("  ")` (whitespace-only)                                                    | `step.prompt` is whitespace                                          | Trimmed to empty → not inline.                                                                                                            | Returns `false`.                                                                                                      |
| UC-INLINE-DETECT-7   | Lib   | `isInlinePrompt("line1\r\nline2")` (Windows line endings)                                   | `step.prompt` contains `\r\n`                                        | `\r\n` contains `\n` → inline.                                                                                                           | Returns `true`.                                                                                                       |
| UC-INLINE-RESOLVE-1  | Lib   | `buildContext` with agent step, multiline `step.prompt`, `expose.skills` present            | Skill pack loaded; inline prompt detected                            | Detect inline → skip file lookup → resolve expressions → populate `primaryPrompt` with `source: "step.prompt"`.                           | `bundle.primaryPrompt.content` is the expression-resolved inline body; `id` is `"(inline)"`; `path` is `"(inline template)"`. |
| UC-INLINE-RESOLVE-2  | Lib   | `buildContext` with agent step, inline prompt, NO `expose.skills`                           | step has no expose field                                             | Detect inline → skip Skill Pack loading for prompts → resolve expressions → populate `primaryPrompt`. `skill` is `""`.                    | `bundle.primaryPrompt` is populated; no warning emitted.                                                             |
| UC-INLINE-RESOLVE-3  | Lib   | `buildContext` with inline prompt containing `${{ inputs.task }}`                           | `state.task = "fix bug"`                                             | `resolveExpression("Do ${{ inputs.task }}", ctx)` → `"Do fix bug"`.                                                                       | `bundle.primaryPrompt.content` contains `"Do fix bug"`.                                                                |
| UC-INLINE-RESOLVE-4  | Lib   | `buildContext` with inline prompt containing `${{ jobs.x.outputs.y }}`                      | unsupported expression                                               | Pattern passes through unchanged.                                                                                                        | `bundle.primaryPrompt.content` contains literal `"${{ jobs.x.outputs.y }}"`.                                         |
| UC-INLINE-CONFLICT-1 | Lib   | `buildContext` with inline prompt "review", Skill Pack has prompt `id: "review"`            | Inline detected; pack loaded; prompt id matches raw text             | Conflict check finds match → throw.                                                                                                      | Throws `WorkflowError` with conflict message.                                                                         |
| UC-INLINE-CONFLICT-2 | Lib   | `buildContext` with inline prompt, no matching Skill Pack prompt id                         | Inline detected; no prompt id matches                                | No conflict; normal inline resolution.                                                                                                   | `bundle.primaryPrompt` populated; no error.                                                                           |
| UC-INLINE-CONFLICT-3 | Lib   | `buildContext` with single-line reference "review" (NOT inline), Skill Pack has `id: "review"` | NOT detected as inline; normal reference resolution                  | Skill Pack prompt file loaded normally.                                                                                                   | `bundle.primaryPrompt.source = "step.prompt"`, content from file; no conflict error.                                  |
| UC-INLINE-COMPAT-1   | Lib   | `buildContext` with `step.prompt = "review"` (single-line, no `${{ }}`), Skill Pack present | Normal Skill Pack reference flow                                     | Matched against Skill Pack prompts, file read from disk.                                                                                   | `bundle.primaryPrompt` populated from file; id, path, content from Skill Pack.                                        |
| UC-INLINE-COMPAT-2   | Lib   | `buildContext` with no `step.prompt` (undefined)                                             | step.prompt absent                                                   | Fallback to `job.id` / `step.id` matching.                                                                                                | `bundle.primaryPrompt` from fallback or warning if no match.                                                          |
| UC-INLINE-COMPAT-3   | Lib   | `buildContext` with non-agent step that has `prompt: "some text"`                           | step.type !== "agent"                                                | `prompt` field ignored for non-agent steps.                                                                                               | `bundle.primaryPrompt` undefined; capabilities empty.                                                                  |
| UC-INLINE-RENDER-1   | Lib   | `buildAgentPrompt(bundle)` where `primaryPrompt` represents an inline prompt                | `primaryPrompt.source = "step.prompt"`, `id = "(inline)"`, `path = "(inline template)"` | Template renders `{{promptContent}}` with inline body.                                                                                    | Prompt output includes `"(inline)"` in the source line, inline content in step prompt section.                        |

## Test Mapping

| Test id             | File                            | Test name                                                                                              | UCs covered                | FPs covered            |
| ------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------- | ---------------------- |
| T-INLINE-DETECT-1   | `tests/context/context.test.ts` | `isInlinePrompt returns true for multiline prompt`                                                     | UC-INLINE-DETECT-1         | FP-INLINE-DETECT       |
| T-INLINE-DETECT-2   | `tests/context/context.test.ts` | `isInlinePrompt returns true for single-line prompt with expression`                                  | UC-INLINE-DETECT-2         | FP-INLINE-DETECT       |
| T-INLINE-DETECT-3   | `tests/context/context.test.ts` | `isInlinePrompt returns false for single-line reference ID`                                           | UC-INLINE-DETECT-3         | FP-INLINE-DETECT       |
| T-INLINE-DETECT-4   | `tests/context/context.test.ts` | `isInlinePrompt returns false for empty string`                                                        | UC-INLINE-DETECT-4         | FP-INLINE-DETECT       |
| T-INLINE-DETECT-5   | `tests/context/context.test.ts` | `isInlinePrompt returns false for undefined`                                                           | UC-INLINE-DETECT-5         | FP-INLINE-DETECT       |
| T-INLINE-DETECT-6   | `tests/context/context.test.ts` | `isInlinePrompt returns false for whitespace-only prompt`                                              | UC-INLINE-DETECT-6         | FP-INLINE-DETECT       |
| T-INLINE-DETECT-7   | `tests/context/context.test.ts` | `isInlinePrompt returns true for Windows line endings`                                                 | UC-INLINE-DETECT-7         | FP-INLINE-DETECT       |
| T-INLINE-CONFLICT-1 | `tests/context/context.test.ts` | `isInlinePrompt detects conflict candidate when inline prompt text matches prompt id`                 | UC-INLINE-CONFLICT-1       | FP-INLINE-CONFLICT     |
| T-INLINE-CONFLICT-2 | `tests/context/context.test.ts` | `isInlinePrompt returns false for reference ID (no conflict)`                                         | UC-INLINE-CONFLICT-3       | FP-INLINE-COMPAT       |
| T-INLINE-SNAPSHOT-1 | `tests/prompt/prompt.test.ts`   | `Golden snapshot: inline prompt Agent Step renders with resolved content and inline origin markers`    | UC-INLINE-RENDER-1         | FP-INLINE-RENDER       |

## Test Design Summary

- **Test framework**: vitest (`describe`, `it`, `expect`, `beforeEach`,
  `afterEach`). Pattern follows the existing `tests/context/context.test.ts`
  and `tests/prompt/prompt.test.ts`.
- **Imports**:
  - For `tests/context/context.test.ts`: `isInlinePrompt()` is defined as a
    **local test helper** in the test file. Step 2 will move it to
    `src/context/index.ts` and the test import will be updated.
  - For `tests/prompt/prompt.test.ts`: `buildAgentPrompt`, `buildPromptPacket`
    from `../../src/prompt/index.js`; `makeContextBundle` is already defined
    in the test file.
- **`isInlinePrompt` local helper**: defined at the top of the test describe
  block. The implementation follows the frozen plan exactly: check for
  `\n` first, then check for `${{ }}` regex, otherwise `false`.
  This ensures the test validates the exact heuristic the implementation
  must use. Step 2 will move this function to `src/context/index.ts`,
  export it, and update the test import.
- **Golden snapshot**: A new `makeContextBundle` call constructs a
  `ContextBundle` with a `PrimaryPrompt` representing an inline prompt
  (source `"step.prompt"`, id `"(inline)"`, path `"(inline template)"`,
  resolved content). `buildAgentPrompt` renders it and the output is
  snapshot-tested. This test PASSES with the current code because the
  prompt renderer already handles any `PrimaryPrompt` content generically.
- **Red phase note**: `isInlinePrompt` tests pass immediately (local helper).
  Golden snapshot test passes immediately (rendering layer is generic).
  Full `buildContext`-level inline resolution tests will be added in
  Step 2 once `buildContext` is updated to use `isInlinePrompt`.
  Conflict detection integration tests will also be added in Step 2.

## Test Gaps

- **`buildContext` inline resolution integration**: Tests that call
  `buildContext` with inline prompts and verify the full pipeline
  (detection → skip lookup → resolve → populate) are deferred to
  Step 2. The local `isInlinePrompt` tests and golden snapshot test
  cover the critical contract boundaries.
- **Conflict detection in `buildContext`**: The `isInlinePrompt` test
  suite verifies the detection logic, but the `buildContext`-level
  integration test (throw `WorkflowError` when inline + matching Skill
  Pack prompt ID) is deferred to Step 2. A unit-level test verifies
  that `isInlinePrompt` correctly flags conflict candidates.
- **`step-prompt.md` template update**: The development plan mentions
  updating the template to clarify inline prompt source display. This
  is a Step 2 concern and does not change the test contract — the
  golden snapshot will capture any template changes.
- **Expression substitution edge cases**: Heavy substitution testing
  is already covered by the existing `resolveExpression` tests in
  `tests/context/context.test.ts`. Inline prompt tests reuse the
  same resolver without additional edge cases.
- **Large inline prompt content**: Not tested. Inline prompts are
  expected to be human-authored and reasonably sized. The template
  rendering layer has no size limit beyond what `renderTemplate`
  handles.

## Step 2 Handoff Notes

1. Move `isInlinePrompt()` from the test file into
   `src/context/index.ts`, export it, and update the test import from
   `../../src/context/index.js`.
2. In `buildContext()`, before the primary prompt resolution loop:
   - Check `isInlinePrompt(step.prompt)`.
   - If inline, skip the Skill Pack prompt matching loop for this
     candidate. Instead, resolve expressions on the raw text and
     construct `PrimaryPrompt` with `source: "step.prompt"`,
     `id: "(inline)"`, `path: "(inline template)"`.
   - If inline AND Skill Packs are loaded, run conflict detection:
     compare trimmed `step.prompt` (interpreted as a single-line ID)
     against each `pack.prompts[].id` using `promptIdMatches()`.
     Throw `WorkflowError` on match.
3. Ensure inline prompt resolution works even when `step.expose.skills`
   is absent (no packs loaded). The `skill` field on `PrimaryPrompt`
   defaults to `""` in this case.
4. The `primaryPromptCandidates()` function needs to be aware of inline
   prompts: when `step.prompt` is inline, it should NOT produce a
   `step.prompt` candidate (since the Skill Pack lookup loop is
   skipped). The inline prompt takes priority and short-circuits the
   candidate resolution loop.
5. Update `src/prompt/templates/step-prompt.md` only if needed to
   display inline origin more clearly. The current template works
   as-is with `"(inline)"` id and `"(inline template)"` path.
6. After implementation, run `pnpm vitest run --update` to regenerate
   golden snapshots, then verify that existing Skill Pack prompt
   snapshots are unchanged (only the new inline snapshot is added).
7. Existing tests (376+) must continue to pass.
