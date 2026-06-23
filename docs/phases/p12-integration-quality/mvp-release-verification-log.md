# MVP Release Candidate Verification Log

Date: 2026-06-23

Scope: Issue #85 / P12.4 MVP release candidate.

Branch: `release/issue-85-mvp-rc`

Baseline commit: `05a2bd8`

Environment:

- OS: Windows PowerShell
- Node: `v22.16.0`
- pnpm: `10.15.0`
- GitHub CLI: `gh version 2.78.0`

## Summary

P12.4 release verification found two release-candidate quality issues in the real init/run/status/prompt path and fixed both before publishing the release candidate PR:

- `zigma-flow run code-change --task ...` did not resolve initialized workflow names from `.zigma-flow/workflows/`.
- `zigma-flow status` could render long job names without a separator before the job status.

Both fixes are covered by command-level regression tests and by real CLI dogfood evidence below.

## Source Fix Evidence

| ID | Finding | Fix | Regression Evidence |
| --- | --- | --- | --- |
| DF-P12-001 | `run code-change` resolved `code-change` as a filesystem path under the repository root instead of `.zigma-flow/workflows/code-change.yml`. | `runAction` now resolves explicit paths first, then bare workflow names under `.zigma-flow/workflows/<name>.yml` or `.yaml`. | `tests/commands/run.test.ts`; real CLI run `node dist/cli.js run code-change --task "MVP release candidate final smoke task"` produced run `20260623-0003`. |
| DF-P12-002 | `status` output glued a long job id to its state: `architecture-designinactive`. | Job table rendering now keeps at least two spaces after job ids wider than the default column. | `tests/commands/status.test.ts`; real CLI status rendered `architecture-design  inactive  [activation: manual]`. |

## Validation Commands

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | Pass | Lockfile was current; pnpm completed with only the existing esbuild build-script warning. |
| `pnpm run typecheck` | Pass | `tsc --noEmit` completed. |
| `pnpm run lint` | Pass | Repository lint script is currently `tsc --noEmit`; completed. |
| `pnpm run test:unit` | Pass | 17 test files, 298 tests. |
| `pnpm run test:integration` | Pass | 13 test files, 138 tests. |
| `pnpm run test:e2e` | Pass | 3 test files, 12 tests. |
| `pnpm run test:ci` | Pass | 36 test files, 469 tests. |
| `pnpm test -- tests/commands/run.test.ts` | Pass | Full Vitest suite completed with 36 files and 468 tests after adding run-name regression coverage. |
| `pnpm test -- tests/commands/status.test.ts` | Pass | Full Vitest suite completed with 36 files and 469 tests after adding status-format regression coverage. |
| `pnpm run build` | Pass | `dist/cli.js` and source map built successfully. |
| `pnpm run smoke` | Pass | CLI help rendered successfully. |

## CLI Dogfood

| Command | Result | Evidence |
| --- | --- | --- |
| `node dist/cli.js init` | Pass | Existing `.zigma-flow/config.json` was detected; all init assets were skipped idempotently. |
| `node dist/cli.js validate .zigma-flow\workflows\code-change.yml` | Pass | Output: `valid: .zigma-flow\workflows\code-change.yml`. |
| `node dist/cli.js validate .zigma-flow\skills\code-change\skill.yml` | Pass | Output: `valid: .zigma-flow\skills\code-change\skill.yml`. |
| `node dist/cli.js run code-change --task "MVP release candidate final smoke task"` | Pass | Output created run `20260623-0003`. |
| `node dist/cli.js status` | Pass | Output showed workflow `code-change`, task text, dependency statuses, and readable long-job formatting. |
| `node dist/cli.js prompt --job intake` | Pass | Wrote `.zigma-flow/runs/20260623-0003/current-step.md`. |

Prompt content checks for run `20260623-0003`:

- Task text present: pass.
- `## Workflow Step Prompt` present: pass.
- Canonical report path present: `.zigma-flow/runs/20260623-0003/jobs/intake/attempts/1/steps/analyze/report.json`.
- Read-only mode instruction present: pass.
- `edits: write` absent: pass.

## Release Decision

The MVP release candidate is ready for PR review. The actual release tag remains separate and should only be cut after the PR is merged and main-branch CI is green.
