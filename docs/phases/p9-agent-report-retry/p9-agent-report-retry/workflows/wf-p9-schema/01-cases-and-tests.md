# WF-P9-SCHEMA — Cases and Tests

- Workflow: WF-P9-SCHEMA
- Phase: P9 Agent Report Acceptance, Retry Inputs, and Attempts
- Step: 1 (Cases and Tests)
- Date: 2026-06-11
- Author: subagent (workflow Step 1)
- Tech-debt resolved: TD-P5-003

## Slice Boundary

- Slice name: **P9-SCHEMA**
- Bounded contexts:
  - **Agent Context — Prompt Builder side** (architecture.md §5.2, §6.1).
    WF-P9-SCHEMA owns the new "Report Schema" section appended to the
    Markdown rendered by `buildAgentPrompt` so that the Agent learns
    the contract for `report.json`.
  - **Agent Report Contract surface** (mvp-contracts.md §2.6). WF-P9-SCHEMA
    surfaces the four MUST-have top-level fields (`outputs`, `artifacts`,
    `signals`, `summary`) directly inside the prompt so that the Agent
    has no ambiguity about what to emit.
- Bounded context interactions:
  - **Consumes** `ContextBundle` (`src/context/index.ts`, produced by
    WF-P5-CONTEXT) — no schema change is introduced here. The renderer
    derives the schema text deterministically from the bundle (signals,
    step id, job id) without external state.
  - **Extends** `buildAgentPrompt` in `src/prompt/index.ts` only — no new
    public function is introduced and no module is added.
  - **MUST NOT** rewrite or relocate the existing six required sections
    (Responsibility, Inputs, Capabilities, Signals, Permissions, Output).
    The new section is **additive**.
  - **MUST NOT** introduce any IO. Rendering remains pure on a
    `ContextBundle`.
  - **MUST NOT** introduce report.json validation logic — that belongs
    to `WF-P9-ACCEPT` (`acceptAgentReport`).
- User tasks covered (2 / max 3):
  1. 用户可完成 `zigma-flow prompt --job <job>` 并在 `current-step.md`
     中读到 Agent Report 的 JSON schema 段落（包含 outputs / artifacts /
     signals / summary 四个字段名）。
  2. 用户可完成 `zigma-flow prompt --job <job>` 并在 `current-step.md`
     中读到 report.json 的写入路径说明（位于 step artifacts
     目录），与 mvp-contracts §2.6 报告契约一致。
- Planned test files (1 / max 1):
  - `tests/prompt/report-schema.test.ts` — unit tests for the new Report
    Schema section emitted by `buildAgentPrompt`. The existing
    `tests/prompt/prompt.test.ts` keeps covering the structural
    contract (six sections, `(none)` markers, confinement); this new
    file covers only the additive schema rendering and is intentionally
    decoupled so a future renderer reshuffle does not collide with
    the existing prompt suite.

Slice within 3-user-task and 2-test-file budget.

## Workflow Goal

Extend `buildAgentPrompt(bundle: ContextBundle)` in `src/prompt/index.ts`
so the rendered Markdown contains an additional section describing the
**Agent Report Contract** (mvp-contracts.md §2.6, PRD §6 FR-006).

The deliverable is shaped so that, when the rendered Markdown is read
by an Agent, the Agent can:

1. Locate where to write its report (`report.json` in the step
   artifacts directory).
2. Know that the JSON object MUST have four top-level fields:
   `outputs`, `artifacts`, `signals`, `summary`.
3. Know which signal ids are emittable from this step (already
   surfaced by the existing "Available Workflow Signals" section, but
   now also reflected inside the schema block as the values allowed
   inside `signals[].type`).
4. Know that the report is the **only** channel through which the
   Agent influences workflow state (reinforces the existing "cannot
   modify workflow state" line).

### `buildAgentPrompt` extension contract

The output MUST gain an additional `## Output` (or sibling) sub-section,
inserted **after** the existing Output paragraph and **before** the
final `完成当前 step 后停止 — stop after completing this step.` line,
that renders an Agent Report Contract block.

Required substrings of the new block:

- A heading or label that names the Agent Report Contract (e.g.
  `### Report Schema` or `### Agent Report Contract`).
- A literal `report.json` reference describing where the file is
  written (step artifacts directory).
- A JSON example block listing the four MUST-have top-level fields
  with quoted JSON-style keys: `"outputs"`, `"artifacts"`, `"signals"`,
  `"summary"`. The block format MAY be either:
    ```json
    {
      "outputs": {},
      "artifacts": [],
      "signals": [],
      "summary": ""
    }
    ```
  or any equivalent JSON object literal that contains the four quoted
  keys.
- The signal subsection inside the schema description MUST list the
  allowed signal ids (from `bundle.signals[*].id`) so the Agent knows
  the only signal types that will pass `allowed_from` validation. When
  `bundle.signals` is empty, the schema MUST still render with the
  four fields and an `(none)` marker for the signal id list.

Contract:

- The new block MUST be additive and MUST NOT change the existing
  section ordering or remove any existing content asserted by
  WF-P5-PROMPT (T-RENDER-1 / T-RENDER-3 / T-RENDER-4 / T-CONFINE-*
  remain green).
- The new block MUST render deterministically from `ContextBundle`
  alone — no clock, no random ids, no filesystem.
- The new block MUST NOT reproduce the workflow YAML, MUST NOT name
  other jobs, and MUST NOT name other steps (FP-PROMPT-CONFINE).

## Acceptance Criteria

1. **M1 Report Schema Path Reference (FP-SCHEMA-PATH)**
   - The rendered Markdown contains a literal `report.json` reference
     **inside or adjacent to** a Report Schema block (this is in
     addition to the existing Output paragraph mention).
   - The reference clarifies that `report.json` is written under the
     step artifacts directory.

2. **M2 Report Schema Fields (FP-SCHEMA-FIELDS)**
   - The rendered Markdown contains the four quoted JSON field names
     `"outputs"`, `"artifacts"`, `"signals"`, `"summary"` in a single
     contiguous block (the Report Schema block).
   - The four fields appear together — they are not scattered across
     unrelated sections.

3. **M3 Schema Block Determinism (FP-SCHEMA-DETERMINISTIC)**
   - Calling `buildAgentPrompt(bundle)` twice on the same bundle
     produces byte-identical output.

4. **M4 Signal Coverage in Schema (FP-SCHEMA-SIGNALS)**
   - When `bundle.signals` contains `[{ id: "needs_review", ... }]`,
     the Report Schema block lists `needs_review` as an allowed
     `signals[].type`.
   - When `bundle.signals` is empty, the Report Schema block still
     renders with the four required fields; the allowed-signal-ids
     subsection shows `(none)`.

5. **M5 Acceptance Milestone — User-Visible Outcome (FP-SCHEMA-USER)**
   - 用户可完成 `zigma-flow prompt --job <job>` 后阅读
     `<runDir>/current-step.md` 并：
     - 看到 report 的写入路径；
     - 看到 outputs / artifacts / signals / summary 四个字段名；
     - 看到可发出的 signal 类型清单；
     - 不需要查阅 mvp-contracts.md 即可写出符合最小 schema 的
       report.json。

## Spec Compliance Matrix

PRD §6 FR-006 and mvp-contracts.md §2.6 MUST/SHALL clauses relevant to
the Agent Report Contract rendered inside the prompt. RC numbering
continues from WF-P5-PROMPT (`RC-P15` was the last allocated tag);
WF-P9-SCHEMA continues with `RC-S1`.

| #     | Clause (origin)                                                                                          | Status                                                                |
| ----- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| RC-S1 | prompt MUST include 输出路径 (report.json path) (PRD §6 FR-006 验收标准)                                  | 已纳入本工作流 — FP-SCHEMA-PATH                                       |
| RC-S2 | prompt MUST include report schema (PRD §6 FR-006 验收标准)                                                | 已纳入本工作流 — FP-SCHEMA-FIELDS                                     |
| RC-S3 | Agent Report MUST have `outputs` top-level field (mvp-contracts.md §2.6 minimum report)                   | 已纳入本工作流 — FP-SCHEMA-FIELDS                                     |
| RC-S4 | Agent Report MUST have `artifacts` top-level field (mvp-contracts.md §2.6 minimum report)                 | 已纳入本工作流 — FP-SCHEMA-FIELDS                                     |
| RC-S5 | Agent Report MUST have `signals` top-level field (mvp-contracts.md §2.6 minimum report)                   | 已纳入本工作流 — FP-SCHEMA-FIELDS                                     |
| RC-S6 | Agent Report MUST have `summary` top-level field (mvp-contracts.md §2.6 minimum report)                   | 已纳入本工作流 — FP-SCHEMA-FIELDS                                     |
| RC-S7 | signal type MUST be validated against `allowed_from` for current job (mvp-contracts.md §2.6 约束二)        | 已纳入本工作流 — FP-SCHEMA-SIGNALS (allowed signal ids list)          |
| RC-S8 | prompt rendering MUST remain deterministic for a given bundle (WF-P5-PROMPT inherited contract)            | 已纳入本工作流 — FP-SCHEMA-DETERMINISTIC                              |
| RC-S9 | Existing six sections MUST remain present and in order (WF-P5-PROMPT FP-PROMPT-RENDER backward compat)     | 已纳入本工作流 — FP-SCHEMA-FIELDS (additive only)                     |

Spec clause budget: 9 / max 15.

Out-of-scope items (deliberately deferred):

- **TD-P9-001 / TD-P9-002**: `${{ jobs.<id>.outputs.<key> }}` and
  `${{ steps.<id>.outputs.<key> }}` expression resolution — not
  surfaced in the schema block. The block only documents the four
  top-level field names; per-key sub-schema rendering belongs to a
  future workflow.
- **`report.json` JSON-Schema (ajv) validation**: belongs to
  WF-P9-ACCEPT (`acceptAgentReport`); this workflow does not enforce
  schema, only documents it inside the prompt.
- **`outputs` typing per skill function**: a function's declared
  `outputs` schema is already surfaced under
  `### Functions` (WF-P5-PROMPT). The Report Schema block does NOT
  re-render per-function outputs.

## Functional Points

| FP id                       | Area                              | Source                            | Summary                                                                                                            |
| --------------------------- | --------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| FP-SCHEMA-PATH              | report.json path mention          | PRD §6 FR-006                     | Schema block names `report.json` under the step artifacts directory.                                              |
| FP-SCHEMA-FIELDS            | Four MUST fields rendered         | mvp-contracts.md §2.6             | Schema block surfaces `"outputs"`, `"artifacts"`, `"signals"`, `"summary"` together.                              |
| FP-SCHEMA-SIGNALS           | Allowed signal ids subsection     | mvp-contracts.md §2.6 约束二      | Schema block lists `bundle.signals[*].id` as allowed `signals[].type` (or `(none)` when empty).                   |
| FP-SCHEMA-DETERMINISTIC     | Pure rendering                    | WF-P5-PROMPT inherited            | Two identical inputs to `buildAgentPrompt` produce byte-identical outputs.                                        |
| FP-SCHEMA-USER              | User-observable outcome           | PRD §6 FR-006 验收标准            | After `zigma-flow prompt`, `current-step.md` carries the schema text the Agent needs to write a valid report.    |

## Use Cases

| UC id              | Actor   | Trigger                                                                       | Pre-conditions                                                  | Steps (happy path)                                              | Post-conditions / observable result                                                       |
| ------------------ | ------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| UC-SCHEMA-1        | Lib     | `buildAgentPrompt(bundle)` with one signal `needs_review`                     | bundle.signals length 1                                          | Render prompt.                                                  | Output contains `report.json` inside the schema block.                                    |
| UC-SCHEMA-2        | Lib     | `buildAgentPrompt(bundle)` always                                              | any                                                              | Render prompt.                                                  | Output contains the literal `"outputs"` quoted key.                                       |
| UC-SCHEMA-3        | Lib     | `buildAgentPrompt(bundle)` always                                              | any                                                              | Render prompt.                                                  | Output contains the literal `"signals"` quoted key.                                       |
| UC-SCHEMA-4        | Lib     | `buildAgentPrompt(bundle)` always                                              | any                                                              | Render prompt.                                                  | Output contains the literal `"summary"` quoted key.                                       |
| UC-SCHEMA-5        | Lib     | `buildAgentPrompt(bundle)` always                                              | any                                                              | Render prompt.                                                  | Output contains all four quoted keys together inside the schema block: `"outputs"`, `"artifacts"`, `"signals"`, `"summary"`. |
| UC-SCHEMA-6        | Lib     | `buildAgentPrompt(bundle)` called twice with identical bundle                  | any                                                              | Render prompt twice.                                            | Both outputs are byte-identical.                                                          |
| UC-SCHEMA-7        | Lib     | `buildAgentPrompt(bundle)` with `bundle.signals = []`                          | empty signals                                                    | Render prompt.                                                  | Schema block still contains all four quoted keys; allowed-signal-ids list shows `(none)`. |

## Test Mapping

| Test id            | File                                       | Test name                                                                                                                  | UCs covered                | FPs covered                                              |
| ------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------- |
| TC-SCHEMA-1        | `tests/prompt/report-schema.test.ts`       | `buildAgentPrompt renders a Report Schema block that names report.json under the step artifacts directory`                  | UC-SCHEMA-1                | FP-SCHEMA-PATH                                           |
| TC-SCHEMA-2        | `tests/prompt/report-schema.test.ts`       | `buildAgentPrompt renders the literal "outputs" quoted key in the Report Schema block`                                      | UC-SCHEMA-2                | FP-SCHEMA-FIELDS                                         |
| TC-SCHEMA-3        | `tests/prompt/report-schema.test.ts`       | `buildAgentPrompt renders the literal "signals" quoted key in the Report Schema block`                                      | UC-SCHEMA-3                | FP-SCHEMA-FIELDS                                         |
| TC-SCHEMA-4        | `tests/prompt/report-schema.test.ts`       | `buildAgentPrompt renders the literal "summary" quoted key in the Report Schema block`                                      | UC-SCHEMA-4                | FP-SCHEMA-FIELDS                                         |
| TC-SCHEMA-5        | `tests/prompt/report-schema.test.ts`       | `buildAgentPrompt renders all four quoted JSON keys together in the Report Schema block`                                    | UC-SCHEMA-5                | FP-SCHEMA-FIELDS                                         |
| TC-SCHEMA-6        | `tests/prompt/report-schema.test.ts`       | `buildAgentPrompt renders the Report Schema block deterministically (idempotent)`                                            | UC-SCHEMA-6                | FP-SCHEMA-DETERMINISTIC                                  |
| TC-SCHEMA-7        | `tests/prompt/report-schema.test.ts`       | `buildAgentPrompt renders the Report Schema block even when bundle.signals is empty`                                         | UC-SCHEMA-7                | FP-SCHEMA-FIELDS, FP-SCHEMA-SIGNALS                      |

## Test Design Summary

- **Test framework**: `vitest` (`describe`, `it`, `expect`). Pattern
  follows `tests/prompt/prompt.test.ts`.
- **Imports**:
  - Unit under test: `buildAgentPrompt` from
    `../../src/prompt/index.js`.
  - Supporting types: `ContextBundle` from
    `../../src/context/index.js`.
- **Filesystem**: none. Pure-renderer tests do not touch the
  filesystem.
- **Bundle fixtures**: a local `makeContextBundle()` helper mirrors
  the one in `tests/prompt/prompt.test.ts` but is intentionally
  duplicated rather than shared, so this test file remains independent
  of changes to the existing prompt test.
- **Determinism**: TC-SCHEMA-6 asserts byte equality across two
  consecutive `buildAgentPrompt` calls.
- **Quoted-key assertions**: TC-SCHEMA-2..5 assert membership of the
  literal substrings `"outputs"`, `"artifacts"`, `"signals"`,
  `"summary"` (each including the JSON quote characters) so that the
  test cannot accidentally pass when the implementation merely
  mentions the bare words `outputs` or `signals` in prose. The
  existing P5 renderer does not emit these quoted keys (the only
  current `outputs:` reference is the YAML-style `outputs:
  {...}` line under `### Functions`, which only appears when a skill
  function declares outputs — and only as unquoted `outputs:`), so
  the assertions reliably fail in the red phase.
- **Empty-bundle isolation (TC-SCHEMA-7)**: uses a bundle with empty
  capabilities and empty artifacts so that the current implementation
  cannot inadvertently satisfy the quoted-key assertions via the
  Capabilities/Functions section or the Prior Artifacts section.
- **Red phase**: the current `buildAgentPrompt` in
  `src/prompt/index.ts` (P5 implementation) does not emit a Report
  Schema block, does not emit the literal substrings `"outputs"`,
  `"artifacts"`, `"signals"`, `"summary"` (with JSON quotes), and does
  not list allowed signal ids inside a schema block. TC-SCHEMA-2
  through TC-SCHEMA-7 fail with assertion errors. TC-SCHEMA-1 fails
  because the current implementation mentions `report.json` only in
  the Output paragraph and not adjacent to a schema block — the
  assertion verifies that `report.json` appears together with a
  Report Schema heading via a regex span that the current
  implementation does not satisfy.

## Test Gaps

- **Per-key JSON Schema content** (e.g. `outputs: object`,
  `artifacts: array<string>`): not asserted — only the four quoted
  top-level keys are asserted. Detailed sub-schema rendering is
  deferred.
- **Snapshot pinning**: not used — the existing prompt suite
  intentionally avoids full snapshots, and WF-P9-SCHEMA follows the
  same convention so renderer phrasing refinements do not churn the
  suite.
- **Markdown formatting validation** (fenced code block vs. inline
  list): not asserted — only that the four quoted keys appear in a
  single contiguous block. Step 2 may choose any concrete formatting.
- **`prompt_generated` event payload**: out of scope — the event
  surface is unchanged by this workflow.
- **`acceptAgentReport` validation**: out of scope (covered by
  WF-P9-ACCEPT).

## Step 2 Handoff Notes

1. `src/prompt/index.ts` MUST extend `buildAgentPrompt` to render an
   additional Report Schema section. The recommended placement is
   immediately after the existing Output paragraph and before the
   final stop-after-step line:

   ```md
   ## Output
   ...existing paragraph...

   ### Report Schema

   Write your report to `report.json` in the step artifacts directory.
   The JSON object MUST contain these four top-level fields:

   ```json
   {
     "outputs": {},
     "artifacts": [],
     "signals": [],
     "summary": ""
   }
   ```

   Allowed `signals[].type` for this step:
   - `needs_review`
   - ...
   (or `(none)` when bundle.signals is empty)

   完成当前 step 后停止 — stop after completing this step.
   ```

2. The block MUST be additive. Do NOT relocate or rename existing
   section headers; the WF-P5-PROMPT suite asserts ordering via
   `indexOf` comparisons and will regress if headers move.
3. The four quoted keys (`"outputs"`, `"artifacts"`, `"signals"`,
   `"summary"`) MUST appear inside one fenced JSON block (or any
   block where they sit on adjacent lines). The TC-SCHEMA-5
   "together" assertion checks pairwise distance between the
   four keys.
4. The allowed-signal-ids list MUST consume `bundle.signals[*].id`
   (already available on the bundle). When the array is empty, emit a
   `- (none)` marker so the list still renders. Do NOT consult any
   external file.
5. No new IO. No clock. No new exports. No new module under
   `src/prompt/`.
