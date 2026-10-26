# Agent workflow

## Rapid iteration

- Deliver one small, reviewable behavior change at a time. Clarify the outcome, implement, validate by risk, and deliver. A small change needs no separate plan or phase report.
- Inspect Git status and relevant code before editing. Preserve unrelated work. Use a task branch for code; isolate work when concurrent edits or user changes require it. Read design and history documents to resolve specific questions rather than as a fixed reading bundle.
- Keep task progress in the existing issue/project when one is used, and keep validation evidence in the PR. Do not duplicate these in Markdown trackers or routine round reports.
- Run the smallest sufficient checks, then broaden for cross-module or high-risk changes. Preserve executable gates for contracts, lifecycle, cancellation, cleanup and data integrity. Do not repeat successful checks unless the code changed or an unresolved concern warrants it.
- Submit implementation through a scoped PR with behavior, validation and material limitations. Required CI must pass and an independent reviewer must check the change. Merge and publish only within the maintainer's current authorization; do not add per-step approvals where that authorization already exists.
- With maintainer authorization, merge a reviewed change promptly and publish a patch for affected packages. Keep documentation in one authoritative location; direct-to-main documentation updates are allowed when the maintainer requests them. Documentation-only changes do not require a package release.
- Use exact published suite identities for downstream dogfood runs. Stop admission on unknown or incompatible provider state. Separate execution completion, independent acceptance and delivery; do not rewrite runtime state to manufacture success.
- Preserve failed evidence and report actual interventions. Keep candidate changes isolated from authoritative downstream repositories. Independent review, scientific/data contracts and rollback boundaries remain mandatory when applicable.

These instructions replace older fixed phase paperwork, mandatory report bundles, bulk reading and worktree creation for every edit. Relevant product contracts and technical boundaries still apply. User instructions in the current conversation take precedence.

## Zigma Flow boundaries

- Use pnpm and the package's pinned package manager. Check package.json for available commands; focused tests, typecheck and build cover ordinary changes. Use the lifecycle gate when changing process ownership, cancellation or provider integration.
- Engine owns state transitions. Agent steps submit structured reports and signals; scripts, checks, routers, artifacts and events provide deterministic execution and audit evidence.
- CLI, scripts, checks, routers and adapters must not bypass Engine transitions. Skill Pack definitions do not own workflow state. Preserve artifact and event auditability.
- Consult docs/mvp-contracts.md when changing execution contracts and docs/architecture.md when changing boundaries. Keep changes within the requested scope.
