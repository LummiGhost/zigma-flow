# WF-P5-CONTEXT — Cases and Tests

- Workflow: WF-P5-CONTEXT
- Phase: P5 Context Builder and Agent Prompt
- Step: 1 (Cases and Tests)
- Date: 2026-06-08
- Author: subagent (workflow Step 1)

## Slice Boundary

- Slice name: P5-CONTEXT
- Bounded context: **Agent Context** (architecture.md §6.1) — owned by the
  `context/` module together with `prompt/`. WF-P5-CONTEXT delivers only the
  data side: `ContextBundle` types, `buildContext()` and the minimum
  `expression` resolver that `buildContext()` depends on. Prompt rendering is
  delivered by the sibling workflow WF-P5-PROMPT.
- Bounded context interactions: this slice **consumes** Workflow Definition
  (`src/workflow/`), Skill Pack (`src/skill-pack/`), Run Runtime
  (`src/run/`) and Artifact (`src/artifact/`) read-only. It **does not**
  import `commander`, `execa`, `simple-git`, or any CLI/runner adapter, and
  it **must not** mutate run state or write events.
- User tasks covered: **none — pure library workflow.** No CLI surface, no
  user-visible commands. Tests cover library contracts only.
- Planned test files (1 / max 2):
  - `tests/context/context.test.ts` — unit tests for `resolveExpression` and
    `buildContext`, including all enumerated functional points and edge
    cases.

Slice within 0-user-task and 2-test-file budget. No CLI surface is delivered
in WF-P5-CONTEXT; CLI wiring of `zigma-flow prompt --job` belongs to
WF-P5-PROMPT.

## Workflow Goal

Deliver `src/expression/index.ts` (minimum expression resolver) and
`src/context/index.ts` (`ContextBundle` type + `buildContext()`) so that the
sibling Prompt Builder workflow has a typed, side-effect-free input.

### 1. Minimum expression resolver

```ts
export interface ExpressionContext {
  inputs: Record<string, string>;
  run: { id: string; workflow: string };
}

export function resolveExpression(
  template: string,
  ctx: ExpressionContext
): string;
```

Contract:

- Replaces `${{ inputs.<key> }}` with `ctx.inputs[<key>]` when the key
  exists; otherwise leaves the literal pattern untouched.
- Replaces `${{ run.id }}` with `ctx.run.id`.
- Replaces `${{ run.workflow }}` with `ctx.run.workflow`.
- Unknown patterns (e.g. `${{ jobs.x.outputs.y }}`, `${{ retry.reason }}`,
  malformed `${{ inputs }}`) MUST pass through unchanged — no throw.
- Empty template returns the empty string.
- Whitespace tolerant: `${{  inputs.task  }}` resolves the same as
  `${{ inputs.task }}`.
- Multiple occurrences of the same pattern in one string are all replaced.
- Tokens that do not match the `${{ ... }}` syntax are returned verbatim.

### 2. `ContextBundle` model

```ts
export type StepKind =
  | "agent"
  | "script"
  | "check"
  | "router"
  | "workflow"
  | "human";

export interface ExposedSkillRef {
  alias: string;     // workflow-level skill alias (e.g. "code")
  skillId: string;   // resolved skill pack id (e.g. "zigma.code-change")
  version: string;   // from skill-lock.json entry
}

export interface ExposedKnowledge {
  skill: string;     // workflow-level alias
  id: string;
  description?: string;
}

export interface ExposedPrompt {
  skill: string;
  id: string;
}

export interface ExposedFunction {
  skill: string;
  id: string;
  description?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

export interface ExposedTool {
  skill: string;
  id: string;
}

export interface ExposedCapabilities {
  skills: ExposedSkillRef[];
  knowledge: ExposedKnowledge[];
  prompts: ExposedPrompt[];
  functions: ExposedFunction[];
  tools: ExposedTool[];
}

export interface ArtifactSummary {
  id: string;
  kind: string;
  path: string;
  summary: string;
  size: number;
  content_type: string;
}

export interface SignalSpec {
  id: string;
  description?: string;
  allowed_from: string[];
  schema?: Record<string, unknown>;
  // any additional workflow signal fields passed through as-is
  [key: string]: unknown;
}

export type PermissionSet = Record<string, unknown>;

export interface ContextBundle {
  runId: string;
  jobId: string;
  stepId: string;
  stepType: StepKind;
  capabilities: ExposedCapabilities;
  inputs: Record<string, string>;
  artifacts: ArtifactSummary[];
  signals: SignalSpec[];
  permissions: PermissionSet;
}
```

### 3. `buildContext()`

```ts
export interface BuildContextOpts {
  runDir: string;             // .zigma-flow/runs/<run-id>
  zigmaflowDir: string;       // project root (parent of .zigma-flow/)
  workflowDef: WorkflowDefinition;
  state: RunState;
  jobId: string;
}

export function buildContext(opts: BuildContextOpts): Promise<ContextBundle>;
```

Contract:

1. Identify the **current step** of `jobId`:
   - Use `state.jobs[jobId].current_step` if present.
   - Otherwise default to `workflowDef.jobs[jobId].steps[0]`.
   - If `jobId` is missing from either `state.jobs` or `workflowDef.jobs`,
     throw `WorkflowError` (kind = `"WorkflowError"`).
2. Resolve `step.expose.skills` (Agent Step only) into
   `capabilities.skills` via `resolveSkillLock` + `loadSkillPack`:
   - For each alias in `step.expose.skills`, look up the workflow-level
     `skills[alias]` declaration to obtain the skill id.
   - Resolve the absolute pack root via
     `resolveSkillLock(zigmaflowDir, skillId)`, then load the pack via
     `loadSkillPack(packRoot)`.
   - Collect knowledge (id, description), prompts (id), functions
     (id, description, inputs, outputs) and tools (id) from each loaded
     pack into `capabilities.knowledge / prompts / functions / tools`.
   - If `step.expose` is absent or `step.type !== "agent"`, capabilities
     fields are empty arrays (no error).
3. Resolve `step.with` fields using `resolveExpression` with
   `ctx = { inputs: { task: state.task, ...string-valued state.jobs.<job>.outputs (none in MVP) }, run: { id: state.run_id, workflow: state.workflow } }`.
   Only string values are subject to expression resolution; non-string
   values pass through unchanged. The resulting `inputs` field on
   `ContextBundle` contains only the **string-valued** `with` entries after
   resolution.
4. Read `<runDir>/artifacts.jsonl`:
   - If the file is missing or empty, `artifacts` is `[]`.
   - Otherwise parse one metadata record per line and project each to
     `{ id, kind, path, summary, size, content_type }`.
5. Filter `workflowDef.signals` to those whose `allowed_from` array
   contains `jobId`. If `workflowDef.signals` is absent, `signals` is `[]`.
   The `allowed_from` accepted format MUST be the same one declared at the
   workflow level; signals without `allowed_from` are excluded.
6. Effective permissions: shallow-merge `workflowDef.permissions` (workflow
   defaults) with `workflowDef.jobs[jobId].permissions` (job overrides
   wins). If neither is declared, `permissions` is `{}`.

`buildContext()` MUST be a pure read operation: no writes to `state.json`,
no writes to `events.jsonl`, no writes to any file in `runDir`.

## Acceptance Criteria

1. **M1 Expression Resolver (FP-EXPR)**
   - `${{ inputs.task }}` → `ctx.inputs.task`.
   - `${{ run.id }}` → `ctx.run.id`.
   - `${{ run.workflow }}` → `ctx.run.workflow`.
   - Unknown patterns pass through as literal text.
   - Empty template returns empty string.
   - Mixed occurrences in one string are all resolved.
   - Whitespace inside `${{ ... }}` is tolerated.

2. **M2 Step Selection (FP-CTX-STEP)**
   - With `state.jobs.<job>.current_step` set, that step id wins.
   - With no `current_step`, the first step of the job definition is used.
   - Unknown `jobId` (missing from state OR missing from workflow def)
     throws `WorkflowError`.

3. **M3 Capability Exposure (FP-CTX-EXPOSE)**
   - Agent step with `expose.skills = ["code"]` produces
     `capabilities.skills` with one entry whose `alias = "code"` and
     `skillId` taken from `workflowDef.skills.code`.
   - Knowledge / prompts / functions / tools from the loaded skill pack
     appear in the corresponding `capabilities.*` arrays, each tagged with
     `skill = "code"`.
   - Step with no `expose` produces empty capability arrays.
   - Non-agent step (script/check/router/workflow/human) produces empty
     capability arrays even if `expose` is declared.
   - Resolving an alias not declared in `workflowDef.skills` throws
     `WorkflowError`.

4. **M4 Input Resolution (FP-CTX-INPUTS)**
   - String `with` values containing `${{ inputs.task }}` are substituted.
   - String values without templates pass through unchanged.
   - `${{ run.id }}` and `${{ run.workflow }}` are resolved from `state`.
   - Unknown templates pass through literally.
   - Non-string `with` values (numbers, booleans, arrays) are excluded
     from the resulting `inputs` field (MVP scope: `inputs` is
     `Record<string, string>`).

5. **M5 Artifact Summary Read (FP-CTX-ARTIFACT)**
   - Existing `artifacts.jsonl` with N lines produces N entries in
     `bundle.artifacts`.
   - Missing `artifacts.jsonl` produces `bundle.artifacts === []`.
   - Empty `artifacts.jsonl` produces `bundle.artifacts === []`.
   - Each summary entry contains the 6 fields `id, kind, path, summary,
     size, content_type` and only these (no full metadata leakage of
     `producer`, `run_id`, `created_at`).

6. **M6 Signal Filtering (FP-CTX-SIGNAL)**
   - Workflow signal whose `allowed_from` includes `jobId` is present.
   - Workflow signal whose `allowed_from` does NOT include `jobId` is
     filtered out.
   - Workflow signal without `allowed_from` is filtered out.
   - Workflow with no `signals` block produces `bundle.signals === []`.

7. **M7 Permission Merging (FP-CTX-PERM)**
   - Workflow defaults appear when job declares no permissions.
   - Job permissions override workflow defaults for shared keys.
   - Workflow-only keys remain; job-only keys are added.
   - Workflow with no `permissions` and job with no `permissions` produces
     `bundle.permissions === {}`.

8. **M8 Side-effect Free (FP-CTX-PURE)**
   - `buildContext()` does not mutate `state.json`, `events.jsonl`, or
     write any new file under `runDir`.

## Spec Compliance Matrix

PRD §14, FR-006, architecture.md §5.2/§6.1/§12.2 and mvp-contracts.md §2.3/§2.4/§2.5/§5
MUST / SHALL clauses relevant to Context Builder. RC numbers continue from
WF-P4 (last allocated `RC-A15`); WF-P5-CONTEXT begins at `RC-C1`.

| #     | Clause (origin)                                                                                       | Status                                                  |
| ----- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| RC-C1 | Context Builder decides which `inputs` are visible to current step (PRD §14)                          | 已纳入本工作流 — FP-CTX-INPUTS                          |
| RC-C2 | Context Builder decides which artifact summaries are visible (PRD §14, §18)                           | 已纳入本工作流 — FP-CTX-ARTIFACT                        |
| RC-C3 | Context Builder decides which knowledge entries are visible (PRD §14, FR-006)                         | 已纳入本工作流 — FP-CTX-EXPOSE                          |
| RC-C4 | Context Builder decides which tools are visible (PRD §14, FR-006)                                     | 已纳入本工作流 — FP-CTX-EXPOSE                          |
| RC-C5 | Context Builder decides which agent functions are callable (PRD §14, FR-006)                          | 已纳入本工作流 — FP-CTX-EXPOSE                          |
| RC-C6 | Context Builder decides which signals can be emitted (PRD §14, FR-006)                                | 已纳入本工作流 — FP-CTX-SIGNAL                          |
| RC-C7 | Context Builder MUST hide content not exposed by current step (PRD §14, mvp-contracts §5)             | 已纳入本工作流 — FP-CTX-EXPOSE (non-agent / no-expose → empty arrays) |
| RC-C8 | Context Builder MUST NOT bypass `expose` when reading Skill Pack resources (mvp-contracts §5)         | 已纳入本工作流 — FP-CTX-EXPOSE                          |
| RC-C9 | `expose` only references workflow top-level declared skills (arch §6.2 WorkflowDefinition invariants) | 已纳入本工作流 — FP-CTX-EXPOSE (undeclared alias throws) |
| RC-C10 | prompt MUST include current inputs (FR-006)                                                          | 已纳入本工作流 — `ContextBundle.inputs` populated for renderer |
| RC-C11 | prompt MUST include artifact summaries (FR-006)                                                      | 已纳入本工作流 — `ContextBundle.artifacts` populated    |
| RC-C12 | prompt MUST include available knowledge / tools / functions / signals (FR-006)                       | 已纳入本工作流 — `ContextBundle.capabilities` + `signals` |
| RC-C13 | prompt MUST include permissions and forbidden actions (FR-006)                                       | 已纳入本工作流 — `ContextBundle.permissions` populated  |
| RC-C14 | Minimum expression resolver MUST support `${{ inputs.* }}` (PRD §14, dev plan §Open Decisions)        | 已纳入本工作流 — FP-EXPR                                |
| RC-C15 | Minimum expression resolver MUST support `${{ run.id }}` and `${{ run.workflow }}` (dev plan)         | 已纳入本工作流 — FP-EXPR                                |
| RC-C16 | Unsupported expression patterns MUST pass through as literals, not throw (dev plan §Risks)            | 已纳入本工作流 — FP-EXPR (passthrough)                  |
| RC-C17 | Context Builder MUST NOT mutate run state (arch §5.2 module boundaries)                               | 已纳入本工作流 — FP-CTX-PURE                            |
| RC-C18 | Context Builder MUST NOT write events (arch §5.2; events ownership is Engine)                        | 已纳入本工作流 — FP-CTX-PURE                            |
| RC-C19 | Artifact prompt injection uses metadata + summary only, not file content (PRD §18, mvp-contracts §2.5 line 133) | 已纳入本工作流 — FP-CTX-ARTIFACT (returns ArtifactSummary, no file read) |
| RC-C20 | `signals.allowed_from` filters which signals current job/step may emit (PRD §13/§14)                  | 已纳入本工作流 — FP-CTX-SIGNAL                          |
| RC-C21 | `${{ jobs.*.outputs.* }}`, `${{ steps.*.outputs.* }}`, `${{ retry.* }}`, `${{ signals.* }}` (PRD §14) | 计划外 (TD-P5-001) — P6+                                |
| RC-C22 | Knowledge / function file content auto-injection (PRD §14 “按需展开”)                                 | 计划外 (TD-P5-002) — P10 dogfood                        |
| RC-C23 | Agent report schema rendering (FR-006 “包含输出 schema”)                                              | 计划外 (TD-P5-003) — P6 agent step execution            |
| RC-C24 | `prompt_generated` event emission                                                                     | 规范不适用 — Engine 责任，由 WF-P5-PROMPT 承担           |
| RC-C25 | Prompt markdown rendering (`buildAgentPrompt`)                                                       | 规范不适用 — 由 WF-P5-PROMPT 承担                       |
| RC-C26 | `zigma-flow prompt --job` CLI command                                                                 | 规范不适用 — 由 WF-P5-PROMPT 承担                       |

Spec clause budget: 26 / max 30. Three TD references (TD-P5-001/002/003)
are inherited from the frozen development plan and not relitigated here.

## Functional Points

| FP id             | Area                              | Source                       | Summary                                                                                                  |
| ----------------- | --------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| FP-EXPR           | Expression resolver               | PRD §14, dev plan §Open Decisions | `resolveExpression(template, ctx)` substitutes the three supported patterns and passes unknowns through |
| FP-CTX-STEP       | Current step selection            | PRD §14, arch §12.2          | `buildContext` picks `state.jobs[jobId].current_step` or first defined step                              |
| FP-CTX-EXPOSE     | Capability exposure               | PRD §14, FR-006              | `expose.skills` → loaded packs → `capabilities.{skills,knowledge,prompts,functions,tools}`              |
| FP-CTX-INPUTS     | Input resolution                  | PRD §14, FR-006              | `step.with` string values are resolved via `resolveExpression`                                          |
| FP-CTX-ARTIFACT   | Artifact summaries                | PRD §14/§18, mvp-contracts §2.5 | `artifacts.jsonl` lines are projected to `ArtifactSummary[]`                                          |
| FP-CTX-SIGNAL     | Signal filtering                  | PRD §13/§14                  | workflow signals filtered by `allowed_from.includes(jobId)`                                              |
| FP-CTX-PERM       | Permission merging                | PRD FR-014, arch §6.1        | workflow defaults overlaid by job overrides                                                              |
| FP-CTX-PURE       | Side-effect-free contract         | arch §5.2 module boundaries  | `buildContext` does not write any file under `runDir`                                                    |
| FP-CTX-EDGE       | Edge cases (missing data)         | dev plan §Risks              | missing job, missing skill-lock entry, missing artifacts, no signals all handled gracefully              |

## Use Cases

| UC id             | Actor | Trigger                                                                       | Pre-conditions                                                | Steps (happy path)                                                                                                          | Post-conditions / observable result                                                                |
| ----------------- | ----- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| UC-EXPR-1         | Lib   | `resolveExpression("hello ${{ inputs.task }}", ctx)` with `task = "fix bug"` | `ctx.inputs.task` is a string                                  | Find `${{ inputs.task }}`, look up `ctx.inputs["task"]`, substitute.                                                       | Returns `"hello fix bug"`.                                                                          |
| UC-EXPR-2         | Lib   | `resolveExpression("run is ${{ run.id }}", ctx)`                              | `ctx.run.id = "20260608-0001"`                                | Substitute `${{ run.id }}`.                                                                                                | Returns `"run is 20260608-0001"`.                                                                  |
| UC-EXPR-3         | Lib   | `resolveExpression("wf=${{ run.workflow }}", ctx)`                            | `ctx.run.workflow = "code-change"`                            | Substitute `${{ run.workflow }}`.                                                                                          | Returns `"wf=code-change"`.                                                                       |
| UC-EXPR-4         | Lib   | `resolveExpression("unknown ${{ jobs.x.outputs.y }}", ctx)`                   | any ctx                                                       | Pattern not in supported set; pass through verbatim.                                                                       | Returns `"unknown ${{ jobs.x.outputs.y }}"`.                                                       |
| UC-EXPR-5         | Lib   | `resolveExpression("", ctx)`                                                  | empty template                                                | No tokens to substitute.                                                                                                   | Returns `""`.                                                                                       |
| UC-EXPR-6         | Lib   | `resolveExpression("${{ inputs.a }} and ${{ inputs.b }}", ctx)`               | `ctx.inputs = { a: "1", b: "2" }`                             | Substitute both occurrences.                                                                                               | Returns `"1 and 2"`.                                                                                |
| UC-EXPR-7         | Lib   | `resolveExpression("${{  inputs.task  }}", ctx)` (extra whitespace)           | `ctx.inputs.task = "x"`                                       | Tolerate whitespace inside braces.                                                                                         | Returns `"x"`.                                                                                      |
| UC-EXPR-8         | Lib   | `resolveExpression("${{ inputs.missing }}", ctx)`                             | `ctx.inputs` has no `missing` key                             | Key not in ctx → leave literal.                                                                                            | Returns `"${{ inputs.missing }}"`.                                                                  |
| UC-CTX-STEP-1     | Lib   | `buildContext({ runDir, zigmaflowDir, workflowDef, state, jobId: "plan" })`   | `state.jobs.plan.current_step === "draft"`                    | Step lookup uses `current_step`.                                                                                           | `bundle.stepId === "draft"`, `bundle.stepType === step.type`.                                       |
| UC-CTX-STEP-2     | Lib   | same as above without `current_step`                                          | `state.jobs.plan = { status: "ready" }`                       | Fall back to `workflowDef.jobs.plan.steps[0]`.                                                                             | `bundle.stepId === steps[0].id`.                                                                    |
| UC-CTX-STEP-3     | Lib   | `buildContext` with `jobId: "nope"`                                           | jobId absent from state and workflow                          | Lookup fails.                                                                                                              | Throws `WorkflowError` with `kind = "WorkflowError"`.                                              |
| UC-CTX-EXPOSE-1   | Lib   | Agent step with `expose.skills = ["code"]`, workflow declares `skills.code = "zigma.code-change"`, skill-lock + pack present | `resolveSkillLock` resolves; pack has 2 knowledge entries | Load pack; collect knowledge/prompts/functions/tools.                                                                      | `bundle.capabilities.skills[0] = { alias: "code", skillId: "zigma.code-change", version: ... }`; `bundle.capabilities.knowledge.length === 2`. |
| UC-CTX-EXPOSE-2   | Lib   | Agent step with no `expose` field                                             | step.expose === undefined                                     | Skip skill loading.                                                                                                        | All `capabilities.*` arrays empty.                                                                  |
| UC-CTX-EXPOSE-3   | Lib   | Non-agent step (script) with `expose.skills = ["code"]`                       | step.type !== "agent"                                         | Skip skill loading for non-agent steps.                                                                                    | All `capabilities.*` arrays empty.                                                                  |
| UC-CTX-EXPOSE-4   | Lib   | Agent step exposes alias `"nope"` not declared in `workflowDef.skills`        | undeclared alias                                              | Alias lookup fails.                                                                                                        | Throws `WorkflowError`.                                                                            |
| UC-CTX-INPUTS-1   | Lib   | step.with = { goal: "${{ inputs.task }}", note: "static" }                    | `state.task = "fix the bug"`                                  | Resolve goal; pass through note.                                                                                           | `bundle.inputs = { goal: "fix the bug", note: "static" }`.                                          |
| UC-CTX-INPUTS-2   | Lib   | step.with = { ref: "${{ run.id }}/${{ run.workflow }}" }                      | `state.run_id = "20260608-0001"`, `state.workflow = "wf"`     | Substitute both run.id and run.workflow.                                                                                   | `bundle.inputs.ref === "20260608-0001/wf"`.                                                         |
| UC-CTX-INPUTS-3   | Lib   | step.with = { x: "${{ jobs.foo.outputs.bar }}" } (unsupported)                | any state                                                     | Pass through literal.                                                                                                      | `bundle.inputs.x === "${{ jobs.foo.outputs.bar }}"`.                                               |
| UC-CTX-INPUTS-4   | Lib   | step.with = { count: 7, flag: true }                                          | non-string with values                                        | MVP scope drops non-string values.                                                                                         | `bundle.inputs` does NOT contain `count` or `flag`.                                                 |
| UC-CTX-ART-1      | Lib   | `<runDir>/artifacts.jsonl` contains 2 valid metadata lines                    | runDir has the file                                           | Read + parse + project to summary shape.                                                                                   | `bundle.artifacts.length === 2`; each entry has 6 fields and no `producer`/`run_id`/`created_at`.   |
| UC-CTX-ART-2      | Lib   | `<runDir>/artifacts.jsonl` does not exist                                     | clean runDir                                                  | ENOENT handled gracefully.                                                                                                 | `bundle.artifacts === []`.                                                                          |
| UC-CTX-ART-3      | Lib   | `<runDir>/artifacts.jsonl` is empty (0 bytes)                                 | empty file                                                    | No lines to parse.                                                                                                          | `bundle.artifacts === []`.                                                                          |
| UC-CTX-SIG-1      | Lib   | workflow.signals = { needs_review: { allowed_from: ["plan"] } }, jobId="plan" | jobId in allowed_from                                         | Filter retains signal.                                                                                                     | `bundle.signals.length === 1`, `bundle.signals[0].id === "needs_review"`.                          |
| UC-CTX-SIG-2      | Lib   | workflow.signals = { needs_review: { allowed_from: ["other"] } }, jobId="plan" | jobId NOT in allowed_from                                   | Filter rejects.                                                                                                            | `bundle.signals === []`.                                                                            |
| UC-CTX-SIG-3      | Lib   | workflow has no `signals` block                                              | undefined signals                                              | Default to empty array.                                                                                                    | `bundle.signals === []`.                                                                            |
| UC-CTX-SIG-4      | Lib   | workflow.signals = { broken: {} } (no allowed_from field)                    | signal without allowed_from                                   | Filter excludes signals lacking allowed_from.                                                                              | `bundle.signals === []`.                                                                            |
| UC-CTX-PERM-1     | Lib   | workflow.permissions = { fs: "ro" }, job.permissions undefined               | workflow defaults only                                        | Use workflow defaults.                                                                                                     | `bundle.permissions = { fs: "ro" }`.                                                                |
| UC-CTX-PERM-2     | Lib   | workflow.permissions = { fs: "ro" }, job.permissions = { fs: "rw" }          | job overrides workflow                                        | Job wins on shared key.                                                                                                    | `bundle.permissions = { fs: "rw" }`.                                                                |
| UC-CTX-PERM-3     | Lib   | workflow.permissions = { fs: "ro" }, job.permissions = { net: "deny" }       | job adds new key                                              | Merge keeps both.                                                                                                          | `bundle.permissions = { fs: "ro", net: "deny" }`.                                                   |
| UC-CTX-PERM-4     | Lib   | neither workflow nor job declares permissions                                | undefined both                                                | Default to empty object.                                                                                                   | `bundle.permissions = {}`.                                                                          |
| UC-CTX-PURE-1     | Lib   | `buildContext` is invoked once on a populated runDir                          | runDir has state.json, events.jsonl, artifacts.jsonl          | Capture mtime and byte length of each file before and after the call.                                                      | All file mtimes and sizes are unchanged after `buildContext` returns.                              |
| UC-CTX-EDGE-1     | Lib   | `buildContext` with state that has no entry for `jobId` (workflow has it)    | state.jobs[jobId] === undefined                               | Use workflow definition; default `current_step` to `steps[0]`.                                                             | Does NOT throw; `bundle.stepId === steps[0].id`. (Matches UC-CTX-STEP-2 contract.)                  |

## Test Mapping

| Test id        | File                            | Test name                                                                                                | UCs covered                       | FPs covered            |
| -------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------- |
| T-EXPR-1       | `tests/context/context.test.ts` | `resolveExpression substitutes ${{ inputs.<key> }}`                                                      | UC-EXPR-1                         | FP-EXPR                |
| T-EXPR-2       | `tests/context/context.test.ts` | `resolveExpression substitutes ${{ run.id }}`                                                            | UC-EXPR-2                         | FP-EXPR                |
| T-EXPR-3       | `tests/context/context.test.ts` | `resolveExpression substitutes ${{ run.workflow }}`                                                      | UC-EXPR-3                         | FP-EXPR                |
| T-EXPR-4       | `tests/context/context.test.ts` | `resolveExpression passes unknown patterns through unchanged`                                            | UC-EXPR-4                         | FP-EXPR                |
| T-EXPR-5       | `tests/context/context.test.ts` | `resolveExpression returns empty string for empty input`                                                 | UC-EXPR-5                         | FP-EXPR                |
| T-EXPR-6       | `tests/context/context.test.ts` | `resolveExpression substitutes multiple occurrences in one template`                                     | UC-EXPR-6                         | FP-EXPR                |
| T-EXPR-7       | `tests/context/context.test.ts` | `resolveExpression tolerates whitespace inside braces`                                                   | UC-EXPR-7                         | FP-EXPR                |
| T-EXPR-8       | `tests/context/context.test.ts` | `resolveExpression keeps literal when inputs key is missing`                                             | UC-EXPR-8                         | FP-EXPR                |
| T-CTX-STEP-1   | `tests/context/context.test.ts` | `buildContext picks step from state.jobs.<job>.current_step`                                            | UC-CTX-STEP-1                     | FP-CTX-STEP            |
| T-CTX-STEP-2   | `tests/context/context.test.ts` | `buildContext defaults to first step when current_step is absent`                                       | UC-CTX-STEP-2, UC-CTX-EDGE-1      | FP-CTX-STEP, FP-CTX-EDGE |
| T-CTX-STEP-3   | `tests/context/context.test.ts` | `buildContext throws WorkflowError when jobId is unknown`                                               | UC-CTX-STEP-3                     | FP-CTX-STEP, FP-CTX-EDGE |
| T-CTX-EXPOSE-1 | `tests/context/context.test.ts` | `buildContext loads skill packs declared in step.expose.skills`                                         | UC-CTX-EXPOSE-1                   | FP-CTX-EXPOSE          |
| T-CTX-EXPOSE-2 | `tests/context/context.test.ts` | `buildContext returns empty capabilities for step with no expose`                                        | UC-CTX-EXPOSE-2                   | FP-CTX-EXPOSE, FP-CTX-EDGE |
| T-CTX-EXPOSE-3 | `tests/context/context.test.ts` | `buildContext returns empty capabilities for non-agent steps`                                            | UC-CTX-EXPOSE-3                   | FP-CTX-EXPOSE          |
| T-CTX-EXPOSE-4 | `tests/context/context.test.ts` | `buildContext throws WorkflowError when expose alias is undeclared`                                      | UC-CTX-EXPOSE-4                   | FP-CTX-EXPOSE          |
| T-CTX-IN-1     | `tests/context/context.test.ts` | `buildContext resolves ${{ inputs.task }} in step.with`                                                  | UC-CTX-INPUTS-1                   | FP-CTX-INPUTS          |
| T-CTX-IN-2     | `tests/context/context.test.ts` | `buildContext resolves ${{ run.id }} and ${{ run.workflow }} in step.with`                              | UC-CTX-INPUTS-2                   | FP-CTX-INPUTS          |
| T-CTX-IN-3     | `tests/context/context.test.ts` | `buildContext leaves unsupported ${{ ... }} patterns as literal`                                         | UC-CTX-INPUTS-3                   | FP-CTX-INPUTS          |
| T-CTX-IN-4     | `tests/context/context.test.ts` | `buildContext drops non-string with values from inputs`                                                  | UC-CTX-INPUTS-4                   | FP-CTX-INPUTS          |
| T-CTX-ART-1    | `tests/context/context.test.ts` | `buildContext projects artifacts.jsonl entries to ArtifactSummary`                                       | UC-CTX-ART-1                      | FP-CTX-ARTIFACT        |
| T-CTX-ART-2    | `tests/context/context.test.ts` | `buildContext returns empty artifacts when artifacts.jsonl is missing`                                   | UC-CTX-ART-2                      | FP-CTX-ARTIFACT, FP-CTX-EDGE |
| T-CTX-ART-3    | `tests/context/context.test.ts` | `buildContext returns empty artifacts when artifacts.jsonl is empty`                                     | UC-CTX-ART-3                      | FP-CTX-ARTIFACT        |
| T-CTX-SIG-1    | `tests/context/context.test.ts` | `buildContext keeps signals whose allowed_from includes the jobId`                                       | UC-CTX-SIG-1                      | FP-CTX-SIGNAL          |
| T-CTX-SIG-2    | `tests/context/context.test.ts` | `buildContext filters out signals whose allowed_from excludes the jobId`                                 | UC-CTX-SIG-2                      | FP-CTX-SIGNAL          |
| T-CTX-SIG-3    | `tests/context/context.test.ts` | `buildContext returns empty signals when workflow has no signals block`                                  | UC-CTX-SIG-3                      | FP-CTX-SIGNAL, FP-CTX-EDGE |
| T-CTX-SIG-4    | `tests/context/context.test.ts` | `buildContext filters out signals without allowed_from`                                                  | UC-CTX-SIG-4                      | FP-CTX-SIGNAL          |
| T-CTX-PERM-1   | `tests/context/context.test.ts` | `buildContext returns workflow defaults when job declares no permissions`                                | UC-CTX-PERM-1                     | FP-CTX-PERM            |
| T-CTX-PERM-2   | `tests/context/context.test.ts` | `buildContext applies job permission overrides on shared keys`                                           | UC-CTX-PERM-2                     | FP-CTX-PERM            |
| T-CTX-PERM-3   | `tests/context/context.test.ts` | `buildContext merges disjoint workflow and job permissions`                                              | UC-CTX-PERM-3                     | FP-CTX-PERM            |
| T-CTX-PERM-4   | `tests/context/context.test.ts` | `buildContext returns empty permissions when neither workflow nor job declares any`                      | UC-CTX-PERM-4                     | FP-CTX-PERM, FP-CTX-EDGE |
| T-CTX-PURE-1   | `tests/context/context.test.ts` | `buildContext does not mutate state.json, events.jsonl, or artifacts.jsonl`                              | UC-CTX-PURE-1                     | FP-CTX-PURE            |

## Test Design Summary

- **Test framework**: vitest (`describe`, `it`, `expect`, `beforeEach`,
  `afterEach`). Pattern follows `tests/run/state.test.ts` and
  `tests/artifact/artifact.test.ts`.
- **Imports**:
  - Unit under test: `resolveExpression` from
    `../../src/expression/index.js` and `buildContext`, `ContextBundle`
    types from `../../src/context/index.js`.
  - Supporting types: `WorkflowDefinition` from
    `../../src/workflow/index.js`; `RunState` from
    `../../src/run/index.js`; `ArtifactMetadata` from
    `../../src/artifact/index.js`.
  - Error class: `WorkflowError` from `../../src/utils/index.js`.
- **Filesystem**: real tmp directories under `os.tmpdir()` with
  `node:crypto.randomUUID()` suffixes — not fs mocks. Each test creates
  and tears down its own runDir + zigmaflowDir. A helper builds a
  `.zigma-flow/skill-lock.json` and a `local://skills/<id>/skill.yml`
  pack on disk for the expose tests.
- **Fixtures**: a `makeRunState`, `makeWorkflowDef`, and
  `seedArtifactsJsonl` helper are co-located in the test file. A
  `seedSkillPack` helper writes a minimal `skill.yml` with knowledge,
  prompts, functions and tools entries plus the referenced files for
  pass-through (path safety in `loadSkillPack`).
- **Side-effect assertions**: T-CTX-PURE-1 uses `stat()` to capture
  `mtimeMs` and `size` before and after `buildContext`; assertion is
  byte-and-mtime equality.
- **Red phase**: tests will fail with import errors against the current
  `src/expression/index.ts` (`export {}`) and
  `src/context/index.ts` (`export {}`). Step 2 will implement the
  exports and turn the suite green.

## Test Gaps

- **Concurrency**: no test for two concurrent `buildContext` invocations
  observing each other. `buildContext` is side-effect-free so this is
  pure-read concurrency — covered structurally by FP-CTX-PURE, not as a
  dedicated test.
- **Skill pack hash/version round-trip**: `ExposedSkillRef.version` is
  read from `skill-lock.json`. Hash verification belongs to
  `loadSkillPack` and is already covered by `tests/skill-pack/`; here we
  only assert the version string surfaces.
- **Large `artifacts.jsonl`**: streaming reads for files >100 MB are not
  exercised; MVP tests use small synthetic fixtures.
- **Unicode normalization in expressions**: only ASCII keys are tested.
  Non-ASCII keys are out of MVP scope.
- **Symlinked `runDir`**: skipped, per the same rationale as
  WF-P4-ARTIFACT (Windows symlink ACLs).
- **prompt rendering / `current-step.md` content**: belongs to
  WF-P5-PROMPT, not WF-P5-CONTEXT.
- **`prompt_generated` event emission**: belongs to WF-P5-PROMPT.
- **CLI integration of `zigma-flow prompt --job`**: belongs to
  WF-P5-PROMPT.

## Step 2 Handoff Notes

1. `src/expression/index.ts` must export `resolveExpression` and
   `ExpressionContext`. Recommended implementation: single regex
   `/\$\{\{\s*([^}\s][^}]*?)\s*\}\}/g` with a `switch`-style dispatcher
   on the captured expression keyed by `inputs.<key>`, `run.id`,
   `run.workflow`.
2. `src/context/index.ts` must export `ContextBundle`,
   `BuildContextOpts`, `buildContext`, and the supporting interfaces
   (`ExposedCapabilities`, `ExposedSkillRef`, `ExposedKnowledge`,
   `ExposedPrompt`, `ExposedFunction`, `ExposedTool`, `ArtifactSummary`,
   `SignalSpec`, `PermissionSet`, `StepKind`).
3. `WorkflowDefinition` already permits `expose.skills` to reference
   workflow `skills` aliases (validated by `loadWorkflow`); Step 2 should
   re-derive the alias → skillId map from `workflowDef.skills`. Values
   in `workflowDef.skills` are currently typed `unknown`; treat each as
   `{ source: string; version?: string }` or a bare skill id string —
   verify against existing skill loader tests when implementing.
4. `resolveSkillLock(zigmaflowDir, skillId)` returns the pack root
   absolute path; pair with `loadSkillPack(packRoot)` to obtain the
   `SkillPackDefinition`.
5. The MVP `functions` field on `SkillPackDefinition` is typed
   `unknown[]`. For exposed capabilities, project each function entry
   to `{ skill, id, description?, inputs?, outputs? }` defensively
   (guard against missing fields).
6. The `signals` field on `WorkflowDefinition` is typed
   `Record<string, unknown>`. Step 2 should narrow each entry safely:
   reject entries lacking an `allowed_from: string[]` and skip them
   (UC-CTX-SIG-4).
7. Permissions merge is shallow `{ ...workflow.permissions, ...job.permissions }`
   per dev plan §Open Decisions; deep merge is out of scope.
