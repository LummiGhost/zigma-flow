# MVP Release Candidate Checklist

Issue: #85 / P12.4 MVP release candidate

Date: 2026-06-23

## Required Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Project item confirmed | Done | Issue #85 is in the Zigma Flow MVP Development project. |
| Independent worktree used | Done | Work performed in `D:\zigma\worktrees\zigma-flow-issue-85` on `release/issue-85-mvp-rc`. |
| MVP docs reviewed | Done | `docs/prd.md`, `docs/architecture.md`, and `docs/mvp-contracts.md` reviewed before release work. |
| P12.4 dogfood completed | Done | Init, validate, run, status, and prompt exercised through `dist/cli.js`. |
| Release-candidate blockers fixed | Done | `run` workflow-name resolution and long job status formatting fixed with regression tests. |
| Final pre-PR local gate | Done | `pnpm install --frozen-lockfile`, typecheck, lint, unit/integration/e2e/full tests, build, smoke, and CLI dogfood passed. |
| PR opened | Pending | Open after final pre-PR gate passes. |
| PR CI checked | Pending | Required before merge. |
| Main branch CI checked after merge | Pending | Required before release tag. |
| Release tag | Deferred | Must happen after merge and green main-branch CI. |

## MVP Boundary Checklist

| Boundary | Status | Evidence |
| --- | --- | --- |
| Local single-process CLI | Pass | Runtime surfaces remain CLI and local filesystem based. |
| Engine owns state transitions | Pass | P12 fixes route through existing command/engine boundaries. |
| Skill Pack does not own workflow state | Pass | No skill-pack state authority was added. |
| Agent steps submit reports/signals | Pass | Prompt dogfood preserved canonical report path and signal guidance. |
| Script/check/router layers remain deterministic | Pass | No LLM or provider dependency was added to deterministic execution paths. |
| Artifact/event auditability preserved | Pass | Dogfood generated run artifacts and prompt event evidence under `.zigma-flow/runs/20260623-0003/`. |

## Out-of-Scope Audit

The release branch did not add implementation support for the MVP out-of-scope list in `docs/mvp-contracts.md`:

- Remote Skill Registry.
- True dynamic Job insertion.
- Runtime YAML patch.
- Arbitrary loops or general expression language.
- Automatic multi-agent concurrent scheduling.
- Docker sandbox.
- MCP runtime.
- PR automation.
- Automatic Issue or Project creation.
- Web UI.
- Mail or virtual mail system.
- Multi-tenant permission platform.
- Complex LLM Judge.
- Full event-sourcing rebuild.
- Full Zigma OS distribution.

Repository grep evidence was reviewed for likely out-of-scope implementation keywords. Hits were documentation references, planned extension points, or explicit "not implemented" boundaries; no new release-candidate implementation dependency was introduced.

## Release Readiness Decision

Release-candidate branch is ready to open a PR. Release tagging remains deferred until after merge and green CI on `main`.
