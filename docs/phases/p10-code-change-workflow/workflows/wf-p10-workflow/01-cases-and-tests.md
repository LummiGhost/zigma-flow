---
workflow: WF-P10-WORKFLOW
title: code-change Workflow + Skill Pack template refinement — Cases and Failing Tests
phase: P10
status: red (Step 1)
date: 2026-06-11
authority: docs/prd.md §11, §12, §16, §20, docs/mvp-contracts.md §2.4, §3, docs/architecture.md §6.2, §7
spec-source:
  - docs/phases/p10-code-change-workflow/02-development-plan.md §3 AD-P10-001..AD-P10-005, §4 WF-P10-WORKFLOW
  - src/init/templates.ts (P1 baseline — will be rewritten by Step 2)
  - src/init/index.ts (P1 baseline — file list will be extended by Step 2)
  - src/workflow/index.ts (P2/P7/P8/P9 baseline — schema authority)
  - src/skill-pack/index.ts (P2 baseline — manifest authority)
---

# WF-P10-WORKFLOW — Cases and Failing Tests

## 0. Purpose

The `zigma-flow init` templates shipped in P1 only produce a skeleton workflow
(`intake → collect-diff → route`) with three steps, plus a Skill Pack that
references unsupported features (`uses: code.scripts.collect-diff`,
`uses: agent://planner`, Skill Pack `uses:` routing, cross-step expressions).
P10 demands a full ten-job code-change workflow that lives entirely within the
expression and routing surfaces implemented in P1–P9.

WF-P10-WORKFLOW must rewrite `src/init/templates.ts` so that
`zigma-flow init`:

1. Lays down a valid 10-job DAG that `loadWorkflow()` accepts without warnings.
2. Lays down a Skill Pack whose `skill.yml` and content files satisfy
   `loadSkillPack()` (path safety + existence) end-to-end.
3. Uses only expression features implemented today: `${{ inputs.<k> }}`,
   `${{ run.<k> }}`, `${{ retry.inputs.<k> }}` (AD-P10-001).
4. Encodes the `review_rejected` and `needs_architecture_design` signals with
   the actions in AD-P10-004 / AD-P10-005.
5. Updates `src/init/index.ts` (in Step 2 only) to write the new file set
   produced by templates.

This document drives the **red** phase of WF-P10-WORKFLOW. Step 2 must turn
TC-WORKFLOW-1..10 green by replacing the templates and extending the runInit
file list; no other source files may be touched. Step 2 must also keep the
pre-existing T-INIT-1..12 tests passing where they assert behavior still in
scope (the auxiliary-file test T-INIT-12 and the YAML-substring test T-INIT-9
will be updated alongside the template rewrite, but only as a contract
refinement — not as a behavioral regression).

## 1. Functional Point Inventory

| ID                      | Functional Point                                                                                                                       | Spec Source                | Impacted File                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| FP-INIT-FILE-LIST       | `runInit` writes `workflows/code-change.yml`, `skill.yml`, two knowledge MDs, six prompt MDs, plus `config.json` and `skill-lock.json` | AD-P10-001..005, §16        | `src/init/templates.ts`, `src/init/index.ts`               |
| FP-WORKFLOW-LOADS       | Generated `code-change.yml` is parsed by `loadWorkflow()` without error                                                                | §12, AD-P10-001            | `src/init/templates.ts` → `src/workflow/index.ts`          |
| FP-WORKFLOW-JOBS-10     | Workflow declares exactly 10 jobs: `intake`, `code-map`, `risk-scan`, `plan`, `architecture-design`, `implement`, `static-check`, `unit-test`, `review`, `summarize` | §20, plan §4               | `src/init/templates.ts`                                    |
| FP-WORKFLOW-DAG         | DAG edges: `intake → code-map → risk-scan → plan`; `plan → architecture-design (optional)`; `plan → implement (optional_needs: arch)`; `implement → static-check, unit-test`; `static-check, unit-test → review`; `review → summarize` | plan §4 graph              | `src/init/templates.ts`                                    |
| FP-WORKFLOW-EXPOSE      | Every agent step declares `expose.skills: [code]`; the `code` alias is declared in top-level `skills`                                  | §11, plan §4               | `src/init/templates.ts`                                    |
| FP-WORKFLOW-ARCH-OPT    | `architecture-design` declares `activation: "manual"` and `needs: [plan]`                                                              | AD-P10-004                 | `src/init/templates.ts`                                    |
| FP-WORKFLOW-OPT-NEEDS   | `implement` declares `optional_needs: [architecture-design]` and `retry: { max_attempts: 3, on_exceeded: { status: failed } }`         | AD-P10-004, AD-P10-005     | `src/init/templates.ts`                                    |
| FP-WORKFLOW-SIGNALS     | Top-level `signals` declares `needs_architecture_design` (action `activate_job: architecture-design`, allowed_from: [plan, review]) and `review_rejected` (action `retry_job: implement`, allowed_from: [review]) | AD-P10-004, AD-P10-005     | `src/init/templates.ts`                                    |
| FP-WORKFLOW-SCRIPT      | `static-check` and `unit-test` each contain a single `type: script` step with a `run:` command and `on_failure: fail`                  | AD-P10-002                 | `src/init/templates.ts`                                    |
| FP-WORKFLOW-CHECK       | `risk-scan` step uses `type: check` with `kind:` inline (`json-schema` or `file-exists`) — no Skill Pack `uses:` routing                | AD-P10-002                 | `src/init/templates.ts`                                    |
| FP-SKILL-PACK-LOADS     | Generated `skill.yml` plus content files satisfy `loadSkillPack()` end-to-end                                                          | §11, FR-003                | `src/init/templates.ts`, `src/init/index.ts`               |
| FP-SKILL-PACK-INVENTORY | `skill.yml` declares two knowledge IDs and six prompt IDs (intake, code-map, plan, implement, review, summarize); `scripts: []`, `checks: []`, `functions: []` | plan §4, AD-P10-002        | `src/init/templates.ts`                                    |

## 2. Contract Matrix

| Contract                                                                                              | Source                | Status     | Landing                                                       |
| ----------------------------------------------------------------------------------------------------- | --------------------- | ---------- | ------------------------------------------------------------- |
| Workflow YAML must parse via `loadWorkflow()` without `ValidationError` / `WorkflowError`              | §12, §2.4             | enforced   | TC-WORKFLOW-2                                                 |
| Every agent step exposes a declared skill alias                                                       | `src/workflow` §6b   | enforced   | TC-WORKFLOW-4                                                 |
| DAG validation (cycle + needs resolution)                                                             | §2.4 routing          | enforced   | TC-WORKFLOW-2, TC-WORKFLOW-5                                  |
| Expressions limited to `inputs.*`, `run.*`, `retry.inputs.*`                                          | AD-P10-001            | enforced   | TC-WORKFLOW-2 (parse), template review (TC-WORKFLOW-2 negative if foreign expression present) |
| Signals declared at workflow top-level with `allowed_from` + `action`                                 | §2.4, AD-P10-005      | enforced   | TC-WORKFLOW-8                                                 |
| Skill Pack `uses:` routing is forbidden in script/check steps                                         | AD-P10-002            | enforced   | TC-WORKFLOW-9 (script must have `run:`), TC-WORKFLOW-2 (no `uses: skill://`/`uses: code.*` on non-agent steps) |
| `loadSkillPack()` enforces path safety + existence for all referenced files                           | §11, FR-003           | enforced   | TC-WORKFLOW-10                                                |
| `init` is idempotent (T-INIT-4) and uses `node:path` for separators (T-INIT-6)                        | §16                   | preserved  | regression: existing T-INIT-1..8                              |

## 3. Cases

Each case maps to one `it(...)` in the new `code-change template (WF-P10-WORKFLOW)`
`describe` block added to `tests/init/init.test.ts`. The cases are red until
Step 2 rewrites the templates.

### TC-WORKFLOW-1 — `zigma-flow init` writes the full P10 file set

- **Setup**: empty temp directory.
- **Trigger**: `await runInit({ cwd: tempDir })`.
- **Assert**: each of the following paths exists under `.zigma-flow/`:
  - `config.json`
  - `skill-lock.json`
  - `workflows/code-change.yml`
  - `skills/code-change/skill.yml`
  - `skills/code-change/knowledge/workflow-guide.md`
  - `skills/code-change/knowledge/coding-guidelines.md`
  - `skills/code-change/prompts/intake.md`
  - `skills/code-change/prompts/code-map.md`
  - `skills/code-change/prompts/plan.md`
  - `skills/code-change/prompts/implement.md`
  - `skills/code-change/prompts/review.md`
  - `skills/code-change/prompts/summarize.md`
- **Red reason**: current templates lack `workflow-guide.md`, `intake.md`,
  `code-map.md`, `plan.md`, `summarize.md`; the `runInit` file list omits them.

Covers FP-INIT-FILE-LIST.

### TC-WORKFLOW-2 — `loadWorkflow()` accepts the generated YAML

- **Setup**: run `runInit` into a temp dir.
- **Trigger**: read `.zigma-flow/workflows/code-change.yml`, call
  `loadWorkflow(yamlText)`.
- **Assert**: returns a `WorkflowDefinition`; no exception thrown.
- **Red reason / current state**: today's 1-job YAML happens to parse
  successfully because `loadWorkflow()` does not evaluate the `${{ steps.* }}`
  expression at load time — that surface lives in router execution
  (P8/P9). This case therefore **passes green even pre-Step 2**, but the
  failures in TC-WORKFLOW-3..9 already prove the YAML is not the contract
  payload. After Step 2 rewrites the YAML into the 10-job shape, this case
  must continue to pass — it is the structural baseline guarding against the
  Step 2 rewrite introducing a parse error or undeclared expose alias.

Covers FP-WORKFLOW-LOADS.

### TC-WORKFLOW-3 — Workflow contains exactly the 10 expected jobs

- **Setup**: load the generated YAML via `loadWorkflow()`.
- **Assert**:
  - `Object.keys(wf.jobs).sort()` equals
    `["architecture-design", "code-map", "implement", "intake", "plan", "review", "risk-scan", "static-check", "summarize", "unit-test"]`.
- **Red reason**: current YAML declares only `intake`.

Covers FP-WORKFLOW-JOBS-10.

### TC-WORKFLOW-4 — All agent steps expose the `code` skill

- **Setup**: load the generated YAML.
- **Assert**:
  - `wf.skills` declares the `code` alias.
  - For each job whose first step has `type === "agent"`, the step has
    `expose.skills` containing `"code"`.
  - The set of agent-step job names is exactly
    `{intake, code-map, plan, architecture-design, implement, review, summarize}`.
- **Red reason**: current YAML has only one agent step.

Covers FP-WORKFLOW-EXPOSE.

### TC-WORKFLOW-5 — DAG edges match the documented graph

- **Setup**: load the generated YAML.
- **Assert** `needs` arrays (order-insensitive equality after sort):
  - `intake.needs` is undefined or `[]`.
  - `code-map.needs` is `["intake"]`.
  - `risk-scan.needs` is `["code-map"]`.
  - `plan.needs` is `["risk-scan"]`.
  - `architecture-design.needs` is `["plan"]`.
  - `implement.needs` is `["plan"]`.
  - `static-check.needs` is `["implement"]`.
  - `unit-test.needs` is `["implement"]`.
  - `review.needs.sort()` equals `["static-check", "unit-test"]`.
  - `summarize.needs` is `["review"]`.
- **Red reason**: current YAML has no needs edges.

Covers FP-WORKFLOW-DAG.

### TC-WORKFLOW-6 — `architecture-design` declares `activation: "manual"`

- **Setup**: load the generated YAML.
- **Assert**: `wf.jobs["architecture-design"].activation === "manual"`.
- **Red reason**: job does not yet exist.

Covers FP-WORKFLOW-ARCH-OPT.

### TC-WORKFLOW-7 — `implement` has optional_needs + retry config

- **Setup**: load the generated YAML.
- **Assert**:
  - `wf.jobs["implement"].optional_needs` equals `["architecture-design"]`.
  - `wf.jobs["implement"].retry` is an object with
    `max_attempts === 3` and `on_exceeded.status === "failed"`.
- **Red reason**: job does not yet exist.

Covers FP-WORKFLOW-OPT-NEEDS.

### TC-WORKFLOW-8 — Signals `review_rejected` and `needs_architecture_design`

- **Setup**: load the generated YAML.
- **Assert**:
  - `wf.signals["review_rejected"].allowed_from` equals `["review"]`.
  - `wf.signals["review_rejected"].action` equals `{ retry_job: "implement" }`.
  - `wf.signals["needs_architecture_design"].allowed_from.sort()` equals
    `["plan", "review"]`.
  - `wf.signals["needs_architecture_design"].action` equals
    `{ activate_job: "architecture-design" }`.
- **Red reason**: current YAML declares only the `blocked` signal.

Covers FP-WORKFLOW-SIGNALS.

### TC-WORKFLOW-9 — `static-check` and `unit-test` use inline `script` steps

- **Setup**: load the generated YAML.
- **Assert** for each job in `["static-check", "unit-test"]`:
  - Has exactly one step.
  - `step.type === "script"`.
  - `step.run` is a non-empty string (does not reference `uses: skill://`).
  - `step.on_failure === "fail"`.
- **Red reason**: jobs do not yet exist.

Covers FP-WORKFLOW-SCRIPT.

### TC-WORKFLOW-10 — `loadSkillPack()` accepts the generated Skill Pack

- **Setup**: run `runInit` into a temp dir.
- **Trigger**: call `loadSkillPack(join(tempDir, ".zigma-flow", "skills", "code-change"))`.
- **Assert**:
  - Returns a `SkillPackDefinition` whose `id === "zigma.code-change"`,
    `kind === "skill-pack"`, `version === "1.0.0"`.
  - `knowledge` has entries for `workflow-guide` and `coding-guidelines`,
    and every `knowledge.path` resolves to an existing file under the
    pack root.
  - `prompts` has entries for `intake`, `code-map`, `plan`, `implement`,
    `review`, `summarize`, and every `prompts.path` resolves to an existing
    file.
  - `scripts`, `checks`, `functions` are each empty arrays.
- **Red reason**: current `skill.yml` declares `scripts`/`checks` paths that
  the rewritten init will no longer ship (since AD-P10-002 forbids Skill Pack
  `uses:` routing); the new `skill.yml` and the runInit file list must align.

Covers FP-SKILL-PACK-LOADS, FP-SKILL-PACK-INVENTORY.

## 4. Failing Test Inventory

| Test ID          | Description                                                              | Red Reason                                                                                       | Covers                          |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------- |
| TC-WORKFLOW-1    | `runInit` writes the P10 file set                                        | New `workflow-guide.md` / `intake.md` / `code-map.md` / `plan.md` / `summarize.md` not written | FP-INIT-FILE-LIST               |
| TC-WORKFLOW-2    | Generated workflow YAML loads via `loadWorkflow()`                       | Baseline guard — passes today (1-job YAML parses) and must keep passing after Step 2 rewrite     | FP-WORKFLOW-LOADS               |
| TC-WORKFLOW-3    | 10-job DAG exists                                                        | Current YAML has 1 job                                                                           | FP-WORKFLOW-JOBS-10             |
| TC-WORKFLOW-4    | Agent steps expose `code`                                                | Current YAML has 1 agent step                                                                    | FP-WORKFLOW-EXPOSE              |
| TC-WORKFLOW-5    | DAG edges match plan §4                                                  | Current YAML has no needs                                                                        | FP-WORKFLOW-DAG                 |
| TC-WORKFLOW-6    | `architecture-design.activation === "manual"`                            | Job missing                                                                                      | FP-WORKFLOW-ARCH-OPT            |
| TC-WORKFLOW-7    | `implement` has optional_needs + retry                                   | Job missing                                                                                      | FP-WORKFLOW-OPT-NEEDS           |
| TC-WORKFLOW-8    | Signals declared with proper actions                                     | Current YAML declares only `blocked`                                                             | FP-WORKFLOW-SIGNALS             |
| TC-WORKFLOW-9    | `static-check` + `unit-test` use inline `script` steps                   | Jobs missing                                                                                     | FP-WORKFLOW-SCRIPT              |
| TC-WORKFLOW-10   | `loadSkillPack()` accepts the generated pack                             | New `skill.yml` content + files not yet emitted                                                  | FP-SKILL-PACK-LOADS, FP-SKILL-PACK-INVENTORY |

## 5. Implementation Boundary (Step 2)

- **Files Step 2 may modify**:
  - `src/init/templates.ts` — full rewrite of every template function below
    `configJsonTemplate` / `skillLockJsonTemplate`; add new templates for
    `workflowGuideMd`, `intakeMd`, `codeMapMd`, `planMd`, `summarizeMd`;
    remove `collectDiffTs`, `reportSchemaJson`, `forbiddenPathsYml`.
  - `src/init/index.ts` — replace the `fileEntries` and `dirPaths` lists so
    they match the new template inventory.
  - `tests/init/init.test.ts` — update the legacy `T-INIT-9` and `T-INIT-12`
    expectations so they continue to describe the new template surface
    (e.g., drop assertions about `scripts/collect-diff.ts`, replace
    `type: router` substring with a script-step substring). The new
    TC-WORKFLOW-1..10 block stays as the primary contract.
- **Files Step 2 must NOT modify**: `src/workflow/index.ts`,
  `src/skill-pack/index.ts`, `src/engine/**`, any other runtime code.
- **Expression discipline**: only `${{ inputs.<k> }}`, `${{ run.<k> }}`,
  `${{ retry.inputs.<k> }}`. No `${{ jobs.*.outputs.* }}` or
  `${{ steps.*.outputs.* }}`.
- **No Skill Pack routing**: script steps use `run:`; check steps use `kind:`
  inline; agent steps may use `uses: agent://<id>` only if implemented
  upstream — Step 2 should omit `uses:` from agent steps and rely on
  `expose.skills` + `with:` semantics already validated by `loadWorkflow()`.

## 6. Acceptance Checklist

- TC-WORKFLOW-1..10 turn green after Step 2.
- Pre-existing T-INIT-1..8 stay green; T-INIT-9 and T-INIT-12 are updated in
  Step 2 to describe the new template surface without losing coverage on
  config / skill-lock / idempotency.
- `pnpm typecheck && pnpm lint && pnpm test:ci` passes.
- No new tech debt introduced; the AD-P10-001/002 expression/routing
  restrictions remain documented in this file.
