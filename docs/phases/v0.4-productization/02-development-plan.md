# v0.4 Productization Development Plan

## Objective

- Business objective: Transform Zigma Flow from an internal dogfood tool into a local CLI product that external developers can install, initialize, diagnose, and trial without reading source code.
- Technical objective: Enhance CLI init with environment detection, add a doctor command, formalize error codes, create examples and tutorials, and establish a release pipeline — all without breaking existing workflows or the Engine contract.

## Scope

### In scope

1. Init experience: package manager detection, script detection, auto-generated script/check steps, .gitignore management, minimal runnable Skill Pack generation
2. Doctor command: new `zigma-flow doctor` subcommand for environment and config diagnostics
3. Artifact/event inspection: polish existing `artifacts list` and `events tail` subcommands as needed
4. Error output: stable, structured error messages with run/job/step/artifact context and actionable suggestions
5. Examples: `examples/` directory with a minimal runnable TS project
6. Documentation: README Quick Start rewrite, getting-started tutorial, custom-workflow tutorial, skill-pack-authoring tutorial, error code reference
7. Release strategy: license selection, versioning and stability policy, release checklist, CHANGELOG catch-up through v0.3.6
8. Error code taxonomy: formalized reference document mapping error classes to stable exit codes

### Out of scope

- 1.0 stable API commitment
- Web UI
- Enterprise permissions or remote execution
- GitHub PR auto-creation
- Remote skill registry, Docker workspace, MCP runtime, event sourcing (deferred to future phases)
- Feature additions to Engine, scheduler, or agent adapters

## Milestones

| Milestone | Description | Exit criteria |
|---|---|---|
| M1: Init | `zigma-flow init` detects project environment and generates appropriate config | New user in a fresh TS project can run `init` and get a runnable Skill Pack without manual edits; init tests pass with detected env scenarios |
| M2: Diagnostics | `zigma-flow doctor` exists; error output includes actionable context | `doctor` passes in a healthy project; common failure modes (config error, permission error, workflow validation error) produce output that lets the user self-diagnose |
| M3: Docs & Examples | README, examples/, and tutorials support first-time trial | A developer new to the project can follow Quick Start from clone to first successful workflow run in under 30 minutes |
| M4: Release | Package is publishable; release checklist and changelog exist | `package.json` has license, no `private: true`; CHANGELOG is current through v0.3.6; release process is documented |
| M5: Error Codes | Error code taxonomy is documented and stable | Every ZigmaFlowError subclass has a documented stable exit code; error output includes context fields |

## Technical Approach

- Architecture and module changes: New `src/commands/doctor.ts` module; extended `src/init/` with detection logic; error formatting changes in `src/utils/errors.ts`; no Engine or state machine changes.
- Data/API changes: No API or data format changes. Error output format is additive (new fields on existing error objects).
- Testing strategy: Unit tests for init detection, doctor checks, error formatting. Integration tests for CLI command behavior. Existing test suite (85+ files) must remain green.
- Release or migration notes: No migration needed. Existing `.zigma-flow/` directories remain compatible. Init is idempotent.

## Workflow Breakdown

| Workflow | Goal | Dependencies | Acceptance criteria | Research needed |
|---|---|---|---|---|
| wf-init | Init detects package manager and available scripts, generates tailored config | None | `init` in a fresh pnpm/npm/yarn/bun project produces correct script/check steps; existing init tests still pass; idempotent re-run is safe | Yes — detection strategy |
| wf-doctor | New `doctor` command checks environment, config, workflows, and skills | None | `doctor` reports green in healthy project; reports actionable issues in broken project; exit code reflects health | Yes — check scope |
| wf-error-codes | Formalize error code taxonomy; ensure errors carry diagnostic context | None (but aware of wf-doctor for suggestion wording) | Error code reference doc exists; every error class has stable exit code; failed step output includes run/job/step ids | No |
| wf-docs-examples | `examples/` directory, README rewrite, tutorials | wf-init (examples reference init behavior) | `examples/` project is runnable; README Quick Start is followable by a new user; tutorials exist for getting-started, custom-workflow, skill-pack-authoring | No |
| wf-release | License, version policy, release checklist, CHANGELOG catch-up | All other workflows complete (captures final state) | `package.json` has license and is not private; CHANGELOG covers v0.2.2–v0.3.6; release checklist doc exists | Yes — license |

## Risks And Mitigations

| Risk | Probability | Impact | Mitigation | Owner |
|---|---|---|---|---|
| Init detection breaks on unexpected project layouts | Medium | Medium | Detection uses graceful fallback; unknown PM → prompt user; unknown scripts → skip with warning | wf-init subagent |
| Doctor checks are too slow for large projects | Low | Low | Each check is independent and fast (file reads, JSON parse); no network calls | wf-doctor subagent |
| Error message changes break tests that assert on exact output | Medium | Low | Review test snapshots; update golden files as part of wf-error-codes | wf-error-codes subagent |
| CHANGELOG catch-up is labor-intensive | Low | Low | Use git log between tags to enumerate changes; apply classification rules mechanically | wf-release subagent |
| Scope creep from "while we're here" refactors | Medium | Medium | Strict adherence to this plan; any out-of-scope change requires explicit phase supervisor approval | Supervisor |

## Quality Bar

- Required automated tests: Each workflow must have unit tests covering its new behavior. Integration tests for doctor and init detection scenarios. Full `test:ci` must pass before merge.
- Required manual checks: Doctor output reviewed for clarity. Init output reviewed for correctness across package managers. README Quick Start followed step-by-step by a human.
- Performance / reliability constraints: Doctor must complete in under 2 seconds. Init must not overwrite user files without confirmation.
- Documentation updates: README, docs/getting-started.md, docs/custom-workflow.md, docs/skill-pack-authoring.md, docs/error-codes.md, docs/release-process.md, CHANGELOG.md

## Open Decisions

| Decision | Options | Research task | Due trigger |
|---|---|---|---|
| License | MIT / Apache 2.0 / Other | Pre-research: ask user or default MIT | Before wf-release Step 1 |
| Doctor check scope | Minimal (env + config) / Standard (+ workflows + skills) / Comprehensive (+ git + network) | wf-doctor Step 1 subagent defines scope | Before wf-doctor Step 2 |
| Init detection strategy | Detect all PMs at once / Progressive detection / Template-based | wf-init Step 1 subagent defines strategy | Before wf-init Step 2 |
| npm package name | Keep `zigma-flow` / Scoped `@lummi/zigma-flow` / Other | Pre-research | Before wf-release Step 1 |

## Freeze Record

- Plan status: Frozen
- Frozen at: 2026-07-09
- Final decisions:
  - License: Apache 2.0 (Zigma is planned as commercial software; Apache 2.0 provides patent grant while permitting commercial use)
  - Package name: `@zigma/zigma-flow`
- Residual risks:
  - Doctor check scope will be defined by wf-doctor Step 1 subagent; risk of over/under-scoping accepted
  - Init detection strategy will be defined by wf-init Step 1 subagent; risk of unexpected project layouts accepted with graceful fallback
  - npm publish permissions and org setup needed before actual publish; out of scope for this phase
