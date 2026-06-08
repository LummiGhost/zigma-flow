# WF-P5-PROMPT — Cases and Tests

- Workflow: WF-P5-PROMPT
- Phase: P5 Context Builder and Agent Prompt
- Step: 1 (Cases and Tests)
- Date: 2026-06-08
- Author: subagent (workflow Step 1)

## Slice Boundary

- Slice name: **P5-PROMPT**
- Bounded contexts:
  - **Agent Context — Prompt Builder side** (architecture.md §5.2,
    §6.1). WF-P5-PROMPT owns the Markdown rendering surface
    (`buildAgentPrompt`) and the `<runDir>/current-step.md` artifact.
  - **CLI Layer / Command handler** (architecture.md §12.2). Owns
    `promptAction` and the `zigma-flow prompt [--job]` wiring.
  - **Run runtime — active-run pointer**. Owns the `active_run` field in
    `.zigma-flow/config.json` and the helpers that read/write it.
- Bounded context interactions:
  - **Consumes** `src/context/index.js` (`buildContext`, `ContextBundle`
    types) produced by WF-P5-CONTEXT.
  - **Consumes** `src/run/index.js` (`LocalStateStore.readSnapshot`),
    `src/workflow/index.js` (`loadWorkflowFile`), `src/artifact/index.js`
    (`writeArtifact`, `appendArtifactIndex`), `src/events/index.js`
    (`JsonlEventWriter`, `nextEventId`) and `src/utils/index.js` (error
    classes).
  - **Extends** `src/engine/index.js` `createRun` so the new active-run
    pointer is written on run creation.
  - **MUST NOT** mutate run state in ways that bypass the Engine: the
    only state.json write performed by `promptAction` is the existing
    snapshot write performed via `LocalStateStore`, where the engine
    contract permits CLI-driven transitions for the current MVP.
  - **MUST NOT** include other jobs' steps, the entire workflow YAML, or
    a full step list in the rendered Markdown (PRD FR-006, dev-plan
    §Quality Bar).
- User tasks covered (3 / max 3):
  1. 用户可完成 `zigma-flow prompt --job <job>` 并在 run 目录获得
     `current-step.md`.
  2. 用户可完成 `zigma-flow prompt`（单 ready job 时省略 `--job`）并获得
     `current-step.md`.
  3. 用户可完成 `zigma-flow prompt --job <job>` 后查看事件日志确认
     `prompt_generated` 已记录.
- Planned test files (2 / max 2):
  - `tests/prompt/prompt.test.ts` — unit tests for `buildAgentPrompt`,
    `writePromptArtifact`, `readActiveRun`/`writeActiveRun`, and a
    `promptAction` happy-path + error-path coverage block.
  - `tests/commands/prompt.test.ts` — CLI integration of `promptAction`
    against a real `.zigma-flow/` tmpdir including the `createRun` →
    `prompt` end-to-end flow that proves `active_run` is wired and that
    `current-step.md` + `prompt_generated` are produced.

Slice within 3-user-task and 2-test-file budget.

## Workflow Goal

Deliver:

1. `buildAgentPrompt(context: ContextBundle): string` in
   `src/prompt/index.ts`, plus an internal `writePromptArtifact` helper.
2. Active-run pointer helpers `readActiveRun(zigmaflowDir)` and
   `writeActiveRun(zigmaflowDir, runId)` (added to `src/run/index.ts` or
   a sibling `src/run/activeRun.ts`).
3. `createRun` extension in `src/engine/index.ts` that calls
   `writeActiveRun` after the run directory is initialized so subsequent
   `prompt` invocations can locate the active run.
4. `promptAction({ job?, zigmaflowDir, clock? })` in
   `src/commands/prompt.ts` implementing the architecture.md §12.2 flow.
5. `zigma-flow prompt [--job <job-id>]` wiring in `src/cli.ts`.

The deliverable is shaped so that, given a real run directory that
contains an Agent step in a ready job, running `zigma-flow prompt` (with
or without `--job`) produces `current-step.md` matching the FR-006
sections, registers the prompt artifact in `artifacts.jsonl`, appends a
`prompt_generated` event to `events.jsonl`, and updates `state.json` to
reflect that the step is now `running`.

### 1. `buildAgentPrompt(context)`

```ts
export function buildAgentPrompt(context: ContextBundle): string;
```

Contract:

- Renders Markdown suitable for both human reading and Agent
  consumption.
- The output MUST contain the following sections, in order:
  1. **Header** — `# Agent Step: <stepId>` plus a short metadata block
     reporting `runId`, `jobId`, `stepId` and `stepType`.
  2. **Responsibility / Goal** — section heading `## Responsibility`
     (or `## 当前职责`). Sourced from the step's `uses` (and `description`
     when present in `with`). If neither is provided the section still
     appears with a fallback line stating the step's id and type.
  3. **Inputs** — `## Inputs` (or `## 当前输入`). Renders
     `context.inputs` as a Markdown table or bullet list. If empty the
     section contains an explicit `(none)` marker.
  4. **Capabilities** — `## Exposed Capabilities` with four
     sub-sections in order:
     - `### Knowledge` — from `context.capabilities.knowledge`
       (id, description if present, skill alias). `(none)` if empty.
     - `### Prompts` — from `context.capabilities.prompts`. `(none)` if
       empty.
     - `### Functions` — from `context.capabilities.functions` (id,
       description, inputs schema summary, outputs schema summary).
       `(none)` if empty.
     - `### Tools` — from `context.capabilities.tools`. `(none)` if
       empty.
  5. **Signals** — `## Available Workflow Signals`. Lists
     `context.signals` by id with description. Includes a line
     reminding the Agent that emitted signals are validated by the
     Signal Handler.
  6. **Permissions and Forbidden Actions** — `## Permissions and
     Forbidden Actions`. Renders `context.permissions` plus a fixed
     forbidden-actions list including: "You cannot modify workflow
     state directly", "You cannot bypass the Signal Handler", and "You
     cannot read Skill Pack resources beyond those listed under
     `Exposed Capabilities`".
  7. **Output** — `## Output`. States the report.json path
     (`report.json` under the step artifacts directory) and reminds the
     Agent that artifacts referenced in the report must use
     `artifact://` URIs. Also includes the literal text "完成当前 step
     后停止" (or an exact equivalent phrase) per FR-006.
- MUST NOT include other jobs' steps.
- MUST NOT include the complete workflow YAML.
- MUST NOT include any step ids except the current step.
- MUST NOT include capability entries (knowledge/prompts/functions/tools)
  for any skill that is not in `context.capabilities.skills`.
- Output is deterministic for a given `ContextBundle` (no clock
  injection inside the renderer, no random ids).

### 2. `writePromptArtifact(opts)`

```ts
export interface WritePromptArtifactOpts {
  runDir: string;
  runId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  prompt: string;
  clock: Clock;
}

export interface WritePromptArtifactResult {
  promptPath: string;       // relative POSIX-style path from runDir
  artifactRef: string;      // artifact:// URI
}

export function writePromptArtifact(
  opts: WritePromptArtifactOpts
): Promise<WritePromptArtifactResult>;
```

Contract:

- Writes the prompt text to `<runDir>/current-step.md` as the canonical
  prompt drop location for the active step (PRD FR-006).
- Also writes a step-scoped artifact via `writeArtifact()` under
  `jobs/<job>/attempts/<attempt>/steps/<step>/current-step.md` and
  appends its metadata to `artifacts.jsonl` via `appendArtifactIndex`
  (mvp-contracts §2.5). The returned `artifactRef` MUST be the
  step-scoped artifact id, not the top-level mirror.
- The two files MUST contain identical bytes.

### 3. `readActiveRun` / `writeActiveRun`

```ts
export function readActiveRun(zigmaflowDir: string): Promise<string | null>;
export function writeActiveRun(
  zigmaflowDir: string,
  runId: string
): Promise<void>;
```

Contract:

- `readActiveRun` reads `<zigmaflowDir>/.zigma-flow/config.json`,
  returns the `active_run` string value, or `null` when the file is
  missing, the field is absent, or the field is JSON `null`.
- `writeActiveRun` reads the existing config, sets `active_run` to the
  supplied id, and writes it back atomically (tmp+rename) to preserve
  the same atomicity guarantee as `LocalStateStore.writeSnapshot`.
- If `config.json` is missing, `writeActiveRun` MUST throw a
  `ConfigError` (the file is created by `zigma-flow init`; absence is a
  user-environment failure, not a recoverable case).
- `createRun` extension: at the end of run creation, after `state.json`
  is written, `createRun` MUST call `writeActiveRun(zigmaflowDir,
  runId)` so the new run becomes the active run.

### 4. `promptAction(opts)`

```ts
export interface PromptOptions {
  job?: string;
  zigmaflowDir: string;
  clock?: Clock;
}

export function promptAction(opts: PromptOptions): Promise<void>;
```

Pipeline (matches architecture.md §12.2):

1. `runId = await readActiveRun(zigmaflowDir)`; throw `ConfigError`
   when null.
2. Resolve `runDir = <zigmaflowDir>/.zigma-flow/runs/<runId>`.
3. `state = await LocalStateStore().readSnapshot(runDir)`; throw
   `StateError` when null.
4. Read `<runDir>/run.yml`, resolve `workflow.path`, load
   `WorkflowDefinition` via `loadWorkflowFile`.
5. Resolve `jobId`:
   - If `opts.job` is provided, assert it exists in `state.jobs`
     **and** `workflowDef.jobs`; throw `UserInputError` otherwise.
   - If `opts.job` is absent, collect the set of jobs whose
     `state.jobs[id].status === "ready"`. With exactly 1 → use it.
     With 0 → throw `UserInputError` (no ready job). With ≥2 → throw
     `UserInputError` (must specify `--job`).
6. Pick the current step using the same rule as `buildContext`:
   `state.jobs[jobId].current_step` if set, otherwise the first step
   in the workflow definition.
7. Assert `step.type === "agent"`; throw `WorkflowError` otherwise.
8. `bundle = await buildContext({ runDir, zigmaflowDir, workflowDef,
   state, jobId })`.
9. `prompt = buildAgentPrompt(bundle)`.
10. `attempt = state.jobs[jobId].attempt ?? 1`.
11. `writePromptArtifact({ runDir, runId: state.run_id, jobId, stepId:
    bundle.stepId, attempt, prompt, clock })`.
12. Append a `prompt_generated` event via `JsonlEventWriter`. The
    event id MUST be derived by incrementing the snapshot's current
    `last_event_id` (parse the numeric suffix; reuse
    `nextEventId(counter)` from `src/events/index.js`).
13. Update `state.jobs[jobId].status` from `"ready"` to `"running"`;
    update `state.last_event_id` to the new event id; write the
    snapshot via `LocalStateStore.writeSnapshot`.
14. On success, print ``prompt: <runDir>/current-step.md`` to stdout.
- On failure, throw the corresponding `ZigmaFlowError` subclass and let
  the CLI shell map it to exit code per mvp-contracts §7.

### 5. CLI wiring

```bash
zigma-flow prompt [--job <job-id>]
```

- `--job` is optional. When supplied, it routes through `opts.job`;
  when absent, `promptAction` performs auto-detection.
- The handler uses the same `commander.exitOverride()` shape as the
  other commands so the existing error-mapping in `cli.ts` continues to
  set exit codes for `UserInputError` (2), `ConfigError` (4),
  `WorkflowError` (3), `StateError` (1) and `FilesystemError` (5).

## Acceptance Criteria

1. **M1 Prompt Markdown Sections (FP-PROMPT-RENDER)**
   - The rendered Markdown contains the H1 step header and the six
     section headers listed in the §1 contract, in order.
   - Inputs / capabilities / signals / permissions are rendered from
     the supplied `ContextBundle` only; no other source is consulted.
   - Empty arrays/maps render an explicit `(none)` marker rather than
     omitting the section.
   - The Markdown contains the literal phrase
     `完成当前 step 后停止` and a `report.json` reference.
   - The Markdown contains an explicit "cannot modify workflow state"
     line.

2. **M2 Prompt Confinement (FP-PROMPT-CONFINE)**
   - The rendered Markdown does NOT contain the YAML serialization of
     the workflow (no `name:` / `version:` / `jobs:` lines).
   - The rendered Markdown does NOT contain ids of jobs other than
     `bundle.jobId`.
   - The rendered Markdown does NOT contain ids of steps other than
     `bundle.stepId`.
   - The rendered Markdown does NOT contain capability entries
     belonging to skills outside `bundle.capabilities.skills`.

3. **M3 `writePromptArtifact` (FP-PROMPT-ARTIFACT)**
   - `<runDir>/current-step.md` exists after the call and contains the
     supplied prompt text byte-for-byte.
   - A second file at
     `<runDir>/jobs/<job>/attempts/<attempt>/steps/<step>/current-step.md`
     exists with identical bytes.
   - `<runDir>/artifacts.jsonl` gains exactly one new JSON line whose
     `producer` is `{ job, step, attempt }`, `kind === "prompt"`, and
     `content_type` begins with `text/markdown`.
   - The returned `artifactRef` matches the artifact id of the
     step-scoped file.

4. **M4 Active-Run Pointer (FP-ACTIVE-RUN)**
   - `readActiveRun` returns `null` when `config.json` is missing OR
     when the `active_run` field is null/missing.
   - `readActiveRun` returns the stored string when present.
   - `writeActiveRun` round-trips through `readActiveRun`.
   - `writeActiveRun` preserves other fields in `config.json`
     (tool_version etc.).
   - `writeActiveRun` throws `ConfigError` when `config.json` is
     missing.

5. **M5 `createRun` Sets Active Run (FP-ACTIVE-RUN-INTEG)**
   - After `createRun({ workflowPath, task, runsDir, skillLockPath })`
     returns successfully, the project's
     `<zigmaflowDir>/.zigma-flow/config.json` has `active_run` equal to
     the returned `runId`.

6. **M6 Job/Step Selection (FP-PROMPT-SELECT)**
   - With `opts.job` supplied: chosen job equals `opts.job`.
   - With `opts.job` absent and exactly one ready job: that job is
     chosen.
   - With `opts.job` absent and zero ready jobs: throws
     `UserInputError`.
   - With `opts.job` absent and ≥2 ready jobs: throws
     `UserInputError` (message references "multiple ready jobs").
   - With `opts.job` set to an unknown id: throws `UserInputError`.

7. **M7 Agent-Step Assertion (FP-PROMPT-AGENT)**
   - When the resolved current step has `type === "script"` (or any
     other non-agent type), `promptAction` throws `WorkflowError`.
   - When the current step is `agent`, the pipeline proceeds.

8. **M8 `prompt_generated` Event (FP-PROMPT-EVENT)**
   - After a successful `promptAction`, `events.jsonl` gains exactly
     one new line whose parsed object has `type === "prompt_generated"`
     and `payload.job_id`, `payload.step_id`,
     `payload.prompt_artifact` filled in.
   - The new event's `id` strictly succeeds the previous
     `state.last_event_id` (e.g. `evt-001` → `evt-002`).
   - The snapshot written after the event has its `last_event_id` set
     to the new event id.

9. **M9 State Transition (FP-PROMPT-TRANSITION)**
   - The job's `status` in `state.json` transitions from `"ready"` to
     `"running"` exactly when `promptAction` succeeds.
   - On any failure between `readSnapshot` and `writeSnapshot`,
     `state.json` is left unchanged (no partial transition).

10. **M10 Error Mapping (FP-PROMPT-ERRORS)**
    - Missing `active_run` → `ConfigError` (exit 4).
    - Unknown `--job` id → `UserInputError` (exit 2).
    - Non-agent current step → `WorkflowError` (exit 3).
    - Missing `state.json` in active runDir → `StateError` (exit 1).
    - The CLI wrapper maps these via the existing `cli.ts` error
      handler; this is asserted at the command-integration layer.

## Spec Compliance Matrix

PRD §14, FR-006, §17, architecture.md §5.2/§10/§12.2 and
mvp-contracts.md §2.4/§2.5/§5 MUST/SHALL clauses relevant to the
Prompt Builder. RC numbers continue from WF-P5-CONTEXT (last allocated
`RC-C26`); WF-P5-PROMPT begins at `RC-P1`.

| #     | Clause (origin)                                                                                          | Status                                                                |
| ----- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| RC-P1 | prompt MUST include current responsibility / goal (PRD FR-006)                                            | 已纳入本工作流 — FP-PROMPT-RENDER (Responsibility section)            |
| RC-P2 | prompt MUST include current inputs (PRD FR-006)                                                          | 已纳入本工作流 — FP-PROMPT-RENDER (Inputs section)                    |
| RC-P3 | prompt MUST include exposed knowledge / prompts / functions / tools (PRD FR-006)                          | 已纳入本工作流 — FP-PROMPT-RENDER (Capabilities sub-sections)         |
| RC-P4 | prompt MUST include available workflow signals (PRD FR-006)                                              | 已纳入本工作流 — FP-PROMPT-RENDER (Signals section)                   |
| RC-P5 | prompt MUST include permissions and forbidden actions (PRD FR-006, arch §10 prompt scenario)              | 已纳入本工作流 — FP-PROMPT-RENDER (Permissions section)               |
| RC-P6 | prompt MUST include output path and report.json reference (PRD FR-006)                                   | 已纳入本工作流 — FP-PROMPT-RENDER (Output section)                    |
| RC-P7 | prompt MUST include "完成当前 step 后停止" (PRD FR-006 literal requirement)                              | 已纳入本工作流 — FP-PROMPT-RENDER (Output section)                    |
| RC-P8 | prompt MUST NOT contain full workflow YAML, other jobs' steps, or full step list (PRD FR-006, dev-plan §Quality Bar) | 已纳入本工作流 — FP-PROMPT-CONFINE                            |
| RC-P9 | prompt MUST be written to `<runDir>/current-step.md` and registered as an artifact (PRD FR-006, mvp-contracts §2.5) | 已纳入本工作流 — FP-PROMPT-ARTIFACT                            |
| RC-P10 | `zigma-flow prompt --job <job-id>` MUST exist (PRD §17, FR-006)                                          | 已纳入本工作流 — FP-PROMPT-CLI                                         |
| RC-P11 | `--job` MAY be omitted when exactly one job is ready; multiple ready jobs MUST require `--job` (PRD §17) | 已纳入本工作流 — FP-PROMPT-SELECT                                      |
| RC-P12 | `prompt` MUST apply only to Agent Step (PRD §17, FR-006, arch §12.2)                                    | 已纳入本工作流 — FP-PROMPT-AGENT                                       |
| RC-P13 | `prompt_generated` event MUST be appended (mvp-contracts §2.4)                                          | 已纳入本工作流 — FP-PROMPT-EVENT                                       |
| RC-P14 | `active_run` lives in `.zigma-flow/config.json` and is consulted by default-runs commands (PRD §17 line 1755-1759, dev-plan §Open Decisions) | 已纳入本工作流 — FP-ACTIVE-RUN, FP-ACTIVE-RUN-INTEG |
| RC-P15 | CLI errors MUST map to mvp-contracts §7 exit codes (UserInputError=2, StateError=1, ConfigError=4, WorkflowError=3) | 已纳入本工作流 — FP-PROMPT-ERRORS                              |

Spec clause budget: 15 / max 15. Capability-level clauses (RC-C10..C13)
were resolved against `ContextBundle` in WF-P5-CONTEXT and are not
re-litigated here; this workflow only verifies that the rendered
Markdown surfaces them. Out-of-scope items inherited from the frozen
plan:

- TD-P5-001 (`${{ jobs.*.outputs.* }}` etc.) — P6+.
- TD-P5-002 (knowledge file content auto-injection) — P10 dogfood.
- TD-P5-003 (Agent report schema rendering) — P6 agent step execution.

## Functional Points

| FP id                  | Area                                  | Source                            | Summary                                                                                                                |
| ---------------------- | ------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| FP-PROMPT-RENDER       | Prompt Markdown render                | PRD FR-006, dev plan §M5.2        | `buildAgentPrompt` emits the six required sections in fixed order with `(none)` markers for empty fields.            |
| FP-PROMPT-CONFINE      | Prompt confinement                    | PRD FR-006, dev plan §Quality Bar | Rendered Markdown excludes full workflow YAML, other jobs' steps, capabilities outside `expose`.                       |
| FP-PROMPT-ARTIFACT     | Prompt artifact write                 | PRD FR-006, mvp-contracts §2.5    | `writePromptArtifact` produces both `current-step.md` mirror and a step-scoped artifact + index entry.                |
| FP-ACTIVE-RUN          | Active-run pointer helpers            | PRD §17, dev plan §Open Decisions | `readActiveRun` / `writeActiveRun` round-trip through `config.json`; missing config raises `ConfigError`.             |
| FP-ACTIVE-RUN-INTEG    | `createRun` writes `active_run`       | dev plan §Open Decisions          | `createRun` extension writes `active_run` to project config so `prompt` can locate the run.                          |
| FP-PROMPT-SELECT       | Job/step selection                    | PRD §17, arch §12.2               | `promptAction` resolves the target job from `--job` or the single-ready-job rule; errors on ambiguity.                |
| FP-PROMPT-AGENT        | Agent-step assertion                  | PRD FR-006, arch §12.2            | `promptAction` rejects non-agent steps with `WorkflowError`.                                                          |
| FP-PROMPT-EVENT        | `prompt_generated` emission           | mvp-contracts §2.4                | `promptAction` appends a `prompt_generated` event with payload `{ job_id, step_id, prompt_artifact }`.                |
| FP-PROMPT-TRANSITION   | State transition                      | arch §12.2                        | Job status goes `ready` → `running` and `state.last_event_id` advances atomically with the event append.              |
| FP-PROMPT-CLI          | CLI subcommand wiring                 | PRD §17                           | `zigma-flow prompt [--job <id>]` registered with `commander.exitOverride()` consistent with other commands.           |
| FP-PROMPT-ERRORS       | Error → exit code mapping             | mvp-contracts §7                  | Each documented failure raises a `ZigmaFlowError` subclass with the corresponding `exitCode`.                          |

## Use Cases

| UC id                  | Actor   | Trigger                                                                       | Pre-conditions                                                                            | Steps (happy path)                                                                                                                                                                                              | Post-conditions / observable result                                                                              |
| ---------------------- | ------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| UC-RENDER-1            | Lib     | `buildAgentPrompt(bundle)` with a fully populated bundle                      | bundle has 2 knowledge entries, 1 function, 1 signal, permissions                          | Render each section.                                                                                                                                                                                            | All six headers present in fixed order; every input/knowledge/function/signal id appears in the text.            |
| UC-RENDER-2            | Lib     | `buildAgentPrompt(bundle)` with empty capabilities and empty signals          | bundle.capabilities arrays are empty; signals = []                                          | Render `(none)` markers.                                                                                                                                                                                        | Every section header appears; each empty subsection contains a `(none)` line.                                    |
| UC-RENDER-3            | Lib     | `buildAgentPrompt(bundle)` always                                              | any                                                                                       | Render Output section.                                                                                                                                                                                          | Output contains the literal `完成当前 step 后停止` and a `report.json` reference.                                |
| UC-RENDER-4            | Lib     | `buildAgentPrompt(bundle)` always                                              | any                                                                                       | Render Permissions section.                                                                                                                                                                                     | Output contains an explicit "cannot modify workflow state" forbidden-action line.                                |
| UC-CONFINE-1           | Lib     | `buildAgentPrompt(bundle)` with a bundle whose workflow has multiple jobs     | only one job is rendered (bundle.jobId = "plan")                                          | Render prompt.                                                                                                                                                                                                  | Output does not contain ids of other jobs in the workflow.                                                       |
| UC-CONFINE-2           | Lib     | `buildAgentPrompt(bundle)` where source workflow YAML has many steps          | bundle.stepId references only the current step                                            | Render prompt.                                                                                                                                                                                                  | Output does not contain ids of other steps in the same job.                                                      |
| UC-CONFINE-3           | Lib     | `buildAgentPrompt(bundle)` always                                              | any                                                                                       | Render prompt.                                                                                                                                                                                                  | Output does not contain the lines `name:`, `version:`, `jobs:` (no workflow YAML reproduction).                  |
| UC-ARTIFACT-1          | Lib     | `writePromptArtifact({ runDir, ..., prompt: "X" })`                            | runDir exists; runId/job/step/attempt are valid                                            | Write mirror at `<runDir>/current-step.md`; write step-scoped artifact; append to `artifacts.jsonl`.                                                                                                            | Both files exist with byte-equal content; `artifacts.jsonl` has one new line with `kind = "prompt"`.            |
| UC-ARTIFACT-2          | Lib     | `writePromptArtifact` returns                                                  | as UC-ARTIFACT-1                                                                          | Compute artifact id from step-scoped path.                                                                                                                                                                      | Returned `artifactRef` matches the artifact id of the step-scoped file.                                          |
| UC-ACTIVE-1            | Lib     | `readActiveRun(zigmaflowDir)` with no `.zigma-flow/config.json`               | dir not initialized                                                                       | Read fails ENOENT.                                                                                                                                                                                              | Returns `null` (does not throw).                                                                                 |
| UC-ACTIVE-2            | Lib     | `readActiveRun(zigmaflowDir)` with `{"active_run": null}`                     | config exists                                                                             | Parse; `active_run` is JSON null.                                                                                                                                                                               | Returns `null`.                                                                                                  |
| UC-ACTIVE-3            | Lib     | `writeActiveRun(zigmaflowDir, "20260608-0001")`                               | config exists with `{"tool_version": "0.1.0", "active_run": null}`                        | Write back atomically.                                                                                                                                                                                          | `readActiveRun` now returns `"20260608-0001"`; the `tool_version` field is preserved.                            |
| UC-ACTIVE-4            | Lib     | `writeActiveRun` with no config file                                          | `.zigma-flow/` exists but no `config.json`                                                | Write fails.                                                                                                                                                                                                    | Throws `ConfigError`.                                                                                            |
| UC-CREATE-ACTIVE-1     | Lib     | `createRun({...})` against a freshly init'd `.zigma-flow/`                    | config.json has `active_run: null`                                                        | Engine creates run and writes active_run.                                                                                                                                                                       | After return, `readActiveRun` returns the new runId.                                                             |
| UC-SELECT-1            | Lib     | `promptAction({ job: "plan", zigmaflowDir })`                                 | state.jobs = { plan: ready, build: waiting }                                              | Use supplied job.                                                                                                                                                                                               | Pipeline proceeds with `jobId = "plan"`.                                                                         |
| UC-SELECT-2            | Lib     | `promptAction({ zigmaflowDir })` (no `--job`)                                 | exactly one ready job ("plan")                                                            | Auto-detect job.                                                                                                                                                                                                | Pipeline proceeds with `jobId = "plan"`.                                                                         |
| UC-SELECT-3            | Lib     | `promptAction({ zigmaflowDir })`                                              | two ready jobs                                                                            | Auto-detect fails.                                                                                                                                                                                              | Throws `UserInputError` (multiple ready jobs).                                                                   |
| UC-SELECT-4            | Lib     | `promptAction({ zigmaflowDir })`                                              | zero ready jobs                                                                           | Auto-detect fails.                                                                                                                                                                                              | Throws `UserInputError` (no ready job).                                                                          |
| UC-SELECT-5            | Lib     | `promptAction({ job: "nope", zigmaflowDir })`                                 | job not declared in state                                                                 | Job lookup fails.                                                                                                                                                                                               | Throws `UserInputError`.                                                                                         |
| UC-AGENT-1             | Lib     | `promptAction({ job: "build", zigmaflowDir })`                                | build's current step has `type === "script"`                                              | Step kind assertion fails.                                                                                                                                                                                      | Throws `WorkflowError`.                                                                                          |
| UC-EVENT-1             | Lib     | `promptAction` happy path                                                     | state.last_event_id = "evt-002"                                                           | Append event with id `"evt-003"`.                                                                                                                                                                               | events.jsonl tail is a `prompt_generated` line with id `evt-003`; payload contains `job_id`, `step_id`, `prompt_artifact`. |
| UC-TRANSITION-1        | Lib     | `promptAction` happy path                                                     | state.jobs.plan = ready                                                                   | Writes new snapshot.                                                                                                                                                                                            | state.jobs.plan.status === "running"; state.last_event_id matches the appended event id.                         |
| UC-TRANSITION-2        | Lib     | `promptAction` raises after `readSnapshot` but before `writeSnapshot`         | We force a failure by deleting the workflow file referenced by run.yml after init        | Pipeline fails between read and write.                                                                                                                                                                          | state.json on disk is byte-identical to the pre-call version (no partial transition).                            |
| UC-ERR-1               | CLI     | `zigma-flow prompt --job nope` against a real `.zigma-flow/`                  | active_run set; job not declared                                                          | CLI catches `UserInputError`.                                                                                                                                                                                   | Process exit code = 2; no `current-step.md` written.                                                             |
| UC-ERR-2               | CLI     | `zigma-flow prompt` with no active_run                                        | config has `active_run: null`                                                             | CLI catches `ConfigError`.                                                                                                                                                                                      | Process exit code = 4.                                                                                           |
| UC-ERR-3               | CLI     | `zigma-flow prompt` after `createRun` (happy)                                 | engine has just created a run with an Agent step in a ready job                            | CLI runs to completion.                                                                                                                                                                                         | `current-step.md` present; `events.jsonl` contains a `prompt_generated` line; exit code = 0.                     |

## Test Mapping

| Test id            | File                                | Test name                                                                                                                  | UCs covered                              | FPs covered                                              |
| ------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| T-RENDER-1         | `tests/prompt/prompt.test.ts`       | `buildAgentPrompt renders all six required sections in order`                                                              | UC-RENDER-1                              | FP-PROMPT-RENDER                                         |
| T-RENDER-2         | `tests/prompt/prompt.test.ts`       | `buildAgentPrompt emits (none) markers for empty capabilities and signals`                                                  | UC-RENDER-2                              | FP-PROMPT-RENDER                                         |
| T-RENDER-3         | `tests/prompt/prompt.test.ts`       | `buildAgentPrompt includes 完成当前 step 后停止 and a report.json reference`                                                | UC-RENDER-3                              | FP-PROMPT-RENDER                                         |
| T-RENDER-4         | `tests/prompt/prompt.test.ts`       | `buildAgentPrompt includes an explicit "cannot modify workflow state" forbidden-action line`                                | UC-RENDER-4                              | FP-PROMPT-RENDER                                         |
| T-CONFINE-1        | `tests/prompt/prompt.test.ts`       | `buildAgentPrompt does not name jobs other than bundle.jobId`                                                              | UC-CONFINE-1                             | FP-PROMPT-CONFINE                                        |
| T-CONFINE-2        | `tests/prompt/prompt.test.ts`       | `buildAgentPrompt does not name steps other than bundle.stepId`                                                            | UC-CONFINE-2                             | FP-PROMPT-CONFINE                                        |
| T-CONFINE-3        | `tests/prompt/prompt.test.ts`       | `buildAgentPrompt does not reproduce workflow YAML (no name:/version:/jobs: lines)`                                         | UC-CONFINE-3                             | FP-PROMPT-CONFINE                                        |
| T-ARTIFACT-1       | `tests/prompt/prompt.test.ts`       | `writePromptArtifact writes current-step.md mirror and step-scoped artifact with identical bytes`                            | UC-ARTIFACT-1                            | FP-PROMPT-ARTIFACT                                       |
| T-ARTIFACT-2       | `tests/prompt/prompt.test.ts`       | `writePromptArtifact appends one prompt-kind line to artifacts.jsonl and returns its artifact id`                            | UC-ARTIFACT-1, UC-ARTIFACT-2             | FP-PROMPT-ARTIFACT                                       |
| T-ACTIVE-1         | `tests/prompt/prompt.test.ts`       | `readActiveRun returns null when config.json is missing`                                                                    | UC-ACTIVE-1                              | FP-ACTIVE-RUN                                            |
| T-ACTIVE-2         | `tests/prompt/prompt.test.ts`       | `readActiveRun returns null when active_run is JSON null`                                                                  | UC-ACTIVE-2                              | FP-ACTIVE-RUN                                            |
| T-ACTIVE-3         | `tests/prompt/prompt.test.ts`       | `writeActiveRun round-trips through readActiveRun and preserves tool_version`                                              | UC-ACTIVE-3                              | FP-ACTIVE-RUN                                            |
| T-ACTIVE-4         | `tests/prompt/prompt.test.ts`       | `writeActiveRun throws ConfigError when config.json is absent`                                                              | UC-ACTIVE-4                              | FP-ACTIVE-RUN                                            |
| T-CREATE-1         | `tests/prompt/prompt.test.ts`       | `createRun sets active_run in .zigma-flow/config.json to the new runId`                                                    | UC-CREATE-ACTIVE-1                       | FP-ACTIVE-RUN-INTEG                                      |
| T-SELECT-1         | `tests/prompt/prompt.test.ts`       | `promptAction uses the supplied --job argument`                                                                            | UC-SELECT-1                              | FP-PROMPT-SELECT                                         |
| T-SELECT-2         | `tests/prompt/prompt.test.ts`       | `promptAction auto-detects the only ready job when --job is omitted`                                                       | UC-SELECT-2                              | FP-PROMPT-SELECT                                         |
| T-SELECT-3         | `tests/prompt/prompt.test.ts`       | `promptAction throws UserInputError when multiple ready jobs exist and --job is omitted`                                   | UC-SELECT-3                              | FP-PROMPT-SELECT, FP-PROMPT-ERRORS                       |
| T-SELECT-4         | `tests/prompt/prompt.test.ts`       | `promptAction throws UserInputError when no ready job exists`                                                              | UC-SELECT-4                              | FP-PROMPT-SELECT, FP-PROMPT-ERRORS                       |
| T-SELECT-5         | `tests/prompt/prompt.test.ts`       | `promptAction throws UserInputError when --job names an unknown job`                                                       | UC-SELECT-5                              | FP-PROMPT-SELECT, FP-PROMPT-ERRORS                       |
| T-AGENT-1          | `tests/prompt/prompt.test.ts`       | `promptAction throws WorkflowError when current step is a script step`                                                     | UC-AGENT-1                               | FP-PROMPT-AGENT, FP-PROMPT-ERRORS                        |
| T-EVENT-1          | `tests/prompt/prompt.test.ts`       | `promptAction appends a prompt_generated event whose id strictly succeeds the previous last_event_id`                       | UC-EVENT-1                               | FP-PROMPT-EVENT                                          |
| T-TRANSITION-1     | `tests/prompt/prompt.test.ts`       | `promptAction transitions job status from ready to running and advances last_event_id`                                      | UC-TRANSITION-1                          | FP-PROMPT-TRANSITION                                     |
| T-TRANSITION-2     | `tests/prompt/prompt.test.ts`       | `promptAction does not mutate state.json when buildContext fails`                                                          | UC-TRANSITION-2                          | FP-PROMPT-TRANSITION                                     |
| T-CLI-1            | `tests/commands/prompt.test.ts`     | `promptAction (CLI integration) writes current-step.md and a prompt_generated event after createRun`                       | UC-ERR-3, UC-CREATE-ACTIVE-1             | FP-PROMPT-CLI, FP-ACTIVE-RUN-INTEG, FP-PROMPT-EVENT      |
| T-CLI-2            | `tests/commands/prompt.test.ts`     | `promptAction (CLI integration) throws UserInputError for an unknown --job`                                                | UC-ERR-1                                 | FP-PROMPT-CLI, FP-PROMPT-ERRORS                          |
| T-CLI-3            | `tests/commands/prompt.test.ts`     | `promptAction (CLI integration) throws ConfigError when active_run is null`                                                | UC-ERR-2                                 | FP-PROMPT-CLI, FP-PROMPT-ERRORS                          |

## Test Design Summary

- **Test framework**: `vitest` (`describe`, `it`, `expect`,
  `beforeEach`, `afterEach`). Pattern follows
  `tests/run/state.test.ts`, `tests/artifact/artifact.test.ts`, and
  `tests/commands/status.test.ts`.
- **Imports**:
  - Unit under test:
    - `buildAgentPrompt`, `writePromptArtifact` from
      `../../src/prompt/index.js`.
    - `readActiveRun`, `writeActiveRun` from `../../src/run/index.js`
      (Step 2 may re-export from a new `src/run/activeRun.ts`; the
      `index.js` surface is the test contract).
    - `promptAction` from `../../src/commands/prompt.js`.
    - `createRun` from `../../src/engine/index.js` (for the integration
      test that asserts `active_run` is written).
  - Supporting types: `ContextBundle` from `../../src/context/index.js`,
    `RunState`, `Clock` from `../../src/run/index.js`,
    `ArtifactMetadata` from `../../src/artifact/index.js`.
  - Error classes: `UserInputError`, `WorkflowError`, `StateError`,
    `ConfigError` from `../../src/utils/index.js`.
- **Filesystem**: real tmp directories under `os.tmpdir()` with
  `node:crypto.randomUUID()` suffixes — not fs mocks. Each test creates
  its own `<sandbox>/.zigma-flow/` skeleton:
  - `<sandbox>/.zigma-flow/config.json` (a fixture writer mirrors
    `init`'s template — `tool_version` + `active_run`).
  - `<sandbox>/.zigma-flow/skill-lock.json` (matches the canonical
    WF-P5-CONTEXT fixture so `buildContext` can resolve skills).
  - `<sandbox>/.zigma-flow/runs/<runId>/{run.yml, state.json,
    events.jsonl}` seeded directly with `writeFile`.
  - Optional skill pack files when the test exercises the
    capabilities sections.
- **Clock**: `FakeClock { now(): "2026-06-08T00:00:00.000Z" }` reused
  from the artifact tests (locally defined in this file rather than
  imported from `src/artifact/writeArtifact.js` so the test stays
  isolated; the type signature is the same).
- **Bundle fixtures**: a `makeContextBundle()` helper builds a fully
  populated `ContextBundle` in-place so the render tests do not depend
  on `buildContext`. This keeps render tests independent of the
  WF-P5-CONTEXT implementation: even if `buildContext` regresses, the
  render contract is tested directly.
- **Integration tests** (`promptAction` and CLI): build a workflow YAML
  on disk, seed `.zigma-flow/config.json` + skill-lock, then call
  either `createRun` followed by `promptAction`, or `promptAction`
  alone against a hand-crafted run dir. Tests that assert
  `current-step.md` presence read it back with `readFile`.
- **Side-effect assertions**: T-TRANSITION-2 captures `state.json`
  bytes before and after the call and asserts byte equality on
  failure paths.
- **Determinism**: render tests assert exact string membership (`toContain`)
  and structural ordering (`indexOf` comparisons), not full string
  equality, so that minor whitespace/punctuation differences in the
  Step 2 implementation do not force test churn. Where the contract
  literally requires a phrase (e.g. `完成当前 step 后停止`,
  `report.json`, `cannot modify workflow state`), tests assert that
  literal string membership.
- **Red phase**: tests will fail with import errors against the
  current `src/prompt/index.ts` (`export {}`) and the missing
  `src/commands/prompt.ts`. They will also fail because
  `readActiveRun` / `writeActiveRun` are not yet exported from
  `src/run/index.ts` and because `createRun` does not yet write the
  active-run pointer. Step 2 implements all five surfaces and turns
  the suite green.

## Test Gaps

- **Concurrent `promptAction` invocations**: not exercised — MVP CLI
  is single-process and the active_run pointer is last-writer-wins per
  the frozen development plan. No locking is in scope.
- **Filesystem race between event append and snapshot write**: not
  exercised — `JsonlEventWriter.appendEvent` and
  `LocalStateStore.writeSnapshot` are sequenced inside `promptAction`,
  and divergence detection is already covered by
  `tests/run/state.test.ts` via `validateLastEventId`.
- **Snapshot format stability of the rendered Markdown**: this slice
  asserts structural sections and required phrases only, NOT a full
  snapshot. A pinned snapshot test belongs to Step 3 acceptance
  (compliance review checks "prompt does not include full workflow
  YAML"). Tests intentionally avoid pinning the entire string so
  rendering refinements during P5.3 do not constantly break the
  suite.
- **Knowledge / prompt file contents auto-injection**: out of scope
  (TD-P5-002).
- **`${{ jobs.*.outputs.* }}` and friends**: out of scope (TD-P5-001);
  expression resolution remains the WF-P5-CONTEXT responsibility.
- **Symlinked active runDir**: skipped, per the same Windows ACL
  rationale as WF-P4-ARTIFACT.
- **Step report schema rendering**: out of scope (TD-P5-003); the
  Output section names `report.json` but does not render the schema
  shape.

## Step 2 Handoff Notes

1. `src/prompt/index.ts` MUST export `buildAgentPrompt`,
   `writePromptArtifact`, and `WritePromptArtifactResult`. Recommended
   internal shape:
   - `renderHeader(bundle)`, `renderResponsibility(bundle)`,
     `renderInputs(bundle)`, `renderCapabilities(bundle)`,
     `renderSignals(bundle)`, `renderPermissions(bundle)`,
     `renderOutput(bundle)` — small functions joined by `\n\n`.
   - The "cannot modify workflow state" line MUST be a constant
     string (so the test can assert literal membership without
     coupling to phrasing variations) — e.g.
     ``"You cannot modify workflow state directly. The Workflow
     Engine applies all state transitions based on the report.json
     you write."``.
   - `(none)` markers: render as `- (none)` so they look like
     consistent list items.
   - The `完成当前 step 后停止` phrase belongs in the Output section.
2. `writePromptArtifact` MUST:
   - Build `attempt = opts.attempt`.
   - Call `writeArtifact({ runDir, runId, job: jobId, step: stepId,
     attempt, kind: "prompt", filename: "current-step.md",
     contentType: "text/markdown; charset=utf-8", summary: "Agent
     prompt for current step", content: prompt, clock })`.
   - Call `appendArtifactIndex(runDir, metadata)`.
   - Additionally `writeFile(join(runDir, "current-step.md"), prompt,
     "utf-8")` as the top-level mirror (PRD FR-006 calls out
     `current-step.md` in the run directory).
   - Return `{ promptPath: "current-step.md", artifactRef: metadata.id
     }`.
3. `readActiveRun` / `writeActiveRun` MUST live in `src/run/index.ts`
   (or be re-exported from there). Suggested implementation:
   - `readActiveRun`: `await readFile(join(zigmaflowDir, ".zigma-flow",
     "config.json"), "utf-8")`; on ENOENT return `null`; parse JSON;
     return `typeof obj.active_run === "string" ? obj.active_run :
     null`.
   - `writeActiveRun`: read the existing config (throw `ConfigError`
     if ENOENT), set `active_run`, write to a tmp path and rename. Do
     NOT recreate `config.json` from scratch — preserve unrelated
     fields.
4. `createRun` MUST call `writeActiveRun(<zigmaflowDir>, runId)` after
   `state.json` is written. The `zigmaflowDir` argument is the parent
   of the `.zigma-flow/` directory; existing `CreateRunInputs` does
   not carry it directly. Two options for Step 2:
   - **Preferred**: derive `zigmaflowDir = dirname(dirname(runsDir))`
     when `runsDir` ends with `.zigma-flow/runs`. The current `runAction`
     handler already passes that shape (`join(projectRoot,
     ".zigma-flow", "runs")`), so this derivation is safe for the MVP.
   - **Fallback**: extend `CreateRunInputs` with `zigmaflowDir?:
     string` and have the CLI pass it explicitly. Tests in this file
     do not over-specify which approach Step 2 takes — they only
     assert the observable post-condition.
5. `promptAction` MUST:
   - Use `LocalStateStore` to read AND write state.json — do not
     re-implement atomic write.
   - Use `JsonlEventWriter` to append events.
   - The new event id is `nextEventId(parseInt(state.last_event_id.replace("evt-", ""), 10) + 1)`
     — note: `evt-1000` parses as 1000 and round-trips correctly
     through `nextEventId`.
   - Print the absolute path to `current-step.md` on success (the
     CLI integration test asserts via the spied `console.log`).
6. CLI: register the command with
   `program.command("prompt").option("--job <job>", ...)
     .exitOverride().action(async (opts) => promptAction({ job:
     opts.job, zigmaflowDir: process.cwd() }))`. The existing
   `ZigmaFlowError` catch in `cli.ts` already maps errors → exit
   codes; no new error mapping is needed.
7. The render tests assert section presence and ordering via
   `output.indexOf(headerA) < output.indexOf(headerB)`. Step 2 should
   therefore emit headers in the order documented in §1 above and
   should not relocate them between releases without updating both
   contract and tests.
