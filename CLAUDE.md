# Agent Instructions

These instructions apply to the entire repository. `AGENTS.md` and `CLAUDE.md` are for different agents and must remain identical. When updating either file, update the other in the same change.

## Project Context

- This repository is Zigma Flow, a local Agent Workflow Runtime / Workflow Harness.
- Before implementation work, read `docs/prd.md`, `docs/architecture.md`, and `docs/mvp-contracts.md`.
- Treat `docs/mvp-contracts.md` as the execution contract for MVP tasks. Do not introduce MVP out-of-scope features unless the user explicitly changes scope.
- User instructions in the current conversation take priority over this file.

## Task Tracking

- Task assignment and status tracking depend on GitHub Project.
- For Project-tracked work, confirm the relevant GitHub Project item before implementation when possible.
- After each task is completed, update the GitHub Project status promptly.
- Keep the PR, Project item, and completion evidence synchronized.

## Workspace and PR Workflow

For every task or request, use the independent worktree + PR workflow by default.

Exceptions:

- The user explicitly asks to work in the main workspace.
- The request is only a simple code revision.
- The request is only a simple documentation revision.

Default workflow:

1. Start from `origin/main`.
2. Create an independent git worktree as the working directory.
3. Use a meaningful branch prefix such as `feature/`, `doc/`, `hotfix/`, `test/`, or another prefix that matches the task.
4. Make all changes only inside the task worktree. Do not modify or disturb the main workspace.
5. Before opening the PR, run the necessary test or validation gates for the change.
6. Submit the PR directly when the task is complete. Do not wait for additional confirmation unless the user explicitly asks for review before PR creation.
7. After the PR is submitted, clean up the local worktree.
8. If follow-up changes are requested, recreate a worktree from the PR branch and continue there.

## Validation Gates

- Run the smallest sufficient validation before PR creation.
- For code changes, prefer focused tests first, then broader gates when the changed surface warrants it.
- For documentation-only changes, run lightweight validation such as formatting, link checks, or repository-specific doc checks when available.
- If a required gate cannot be run, record the reason and residual risk in the PR.

## Reports

- If the user requests an implementation report, review report, fix report, or similar report, write the report directly as a PR comment.
- If there is no corresponding PR, write the report to a temporary document, preferably under `docs/temp/`, and mention the path in the final response.
- Reports should include scope, evidence, validation results, remaining risks, and links to relevant artifacts.

## Repository Guardrails

- Keep implementation aligned with the MVP architecture: Engine owns state transitions; Agent steps submit structured reports and signals; script, check, router, artifact, and event layers provide deterministic execution and audit evidence.
- Do not let CLI, script, check, router, or adapters bypass Engine state transitions.
- Do not let Skill Pack definitions own workflow state.
- Preserve artifact and event auditability for new runtime behavior.
- Keep changes scoped to the task and avoid opportunistic refactors.
