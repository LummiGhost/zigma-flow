---
workflow: WF-P7-GITCHECK
phase: p7-check-step
review-type: step1-architecture-review
date: 2026-06-09
reviewer: phase-development-supervisor
verdict: PASS
---

# WF-P7-GITCHECK — Step 1 → Step 2 Architecture Review

## Checklist

| Check | Result | Evidence |
|---|---|---|
| 模块职责单一 | ✅ PASS | `src/git/index.ts` owns the `GitInspector` port interface and `SimpleGitInspector` adapter — a standard port-plus-adapter pair, matching the `src/script/index.ts` precedent. Three check kind files (`git-diff-exists.ts`, `forbidden-paths.ts`, `protected-runtime-files.ts`) each have one responsibility. `src/check/index.ts` registry update extends the dispatch table only. |
| 状态分层清晰 | ✅ PASS | Pure function layer: check kinds return `CheckResult` with no state/event writes. Query layer: `GitInspector` is a read-only port (`changedFiles`, `diffExists`). Executor layer (WF-P7-CHECK) remains the sole writer of `events.jsonl`/`state.json`. Layering: CLI → `executeCurrentStep` → `executeCheckStep` → `LocalCheckRunner.run()` → check function → `GitInspector`. The `simple-git` adapter is behind the port — invisible to the executor and engine layers. |
| 测试边界独立 | ✅ PASS | Two test files with independent lifecycles: `tests/check/git-checks.test.ts` uses `FakeGitInspector` (no real git, unit-level); `tests/git/inspector.test.ts` uses a real temp git repo (integration-level). Each test creates and removes its own sandbox directory. No cross-file state. |
| 领域命令映射 | ✅ PASS | CLI-only workflow. User milestones (M1–M3) map to: user declares `uses: zigma/<kind>` → `executeCheckStep` dispatches via `LocalCheckRunner` → check function consults `GitInspector`. No new public CLI entry points. |
| 共享组件独立収敛 | N/A | CLI-only workflow; no UI shared components. The `GitInspector` port is a new shared component delivered entirely within this workflow's scope. |

## Granularity Check

| Metric | Count | Limit | Status |
|---|---|---|---|
| "用户可完成…" user task milestones | 3 (M1 diff-exists, M2 forbidden-paths, M3 protected-runtime-files) | 3 | ✅ |
| Spec mandatory clause references | 13 in-scope + 2 TD = 15 total | 15 | ✅ Exactly at limit |
| Planned test files | 2 | 2 | ✅ Exactly at limit |

All three granularity metrics within bounds. The 13 in-scope clauses reference 3 distinct documents (prd FR-008, architecture §9.4/§11/§13/§16, mvp-contracts §2.8/§7), with expected cross-referencing overlap. No scope inflation; the three check kinds are the minimal meaningful slice for the git/path axis.

## Risks Noted

1. **Windows path separator normalisation in `micromatch`**: `simple-git` may return paths with backslashes on Windows (`src\\util.ts`), while `micromatch` patterns use POSIX separators (`**/*.secret`). The cases document notes this in Design Risks. Step 2 must verify CI Linux results and, if the local Windows CI gate ever surfaces issues, forward-slash-normalise the `changedFiles` array before passing to `micromatch`. The `micromatch` v4 docs state POSIX normalisation is the default; this may be benign but must be confirmed.

2. **`SimpleGitInspector.changedFiles()` transitive dependency chain**: `LocalCheckRunner` in `src/check/index.ts` will import the three new check functions, which in turn import `SimpleGitInspector` from `src/git/index.ts`, which imports `simple-git`. This means `src/check/index.ts` transitively depends on `simple-git`. The architecture constraint (arch §18) is "engine does not import `simple-git` directly" — the direct import remains clean. Step 2 must confirm `grep -n 'simple-git' src/engine/` returns zero matches.

3. **`@types/micromatch` and NodeNext module resolution**: `micromatch` ships a CJS-only package. Step 2 should verify `import micromatch from "micromatch"` compiles without errors under the project's `NodeNext` TypeScript config. If the ESM import fails the same way `ajv` did, the same `createRequire` workaround should be applied.

4. **`FakeGitInspector` must satisfy the `GitInspector` interface**: The cases document defines the fake inline in the test file. Step 2 must ensure `FakeGitInspector` implements both `changedFiles(cwd: string): Promise<string[]>` and `diffExists(cwd: string): Promise<boolean>`. Structural typing will catch any mismatch at compile time, but Step 2 should verify the type annotation is explicit (`class FakeGitInspector implements GitInspector`).

## Verdict

**PASS — Step 2 implementation may proceed.**

Step 2 must implement the 8 deliverables listed in the cases document §Deliverables:
1. `src/git/index.ts` — `GitInspector` port interface + `SimpleGitInspector` adapter (using `simple-git` v3)
2. `src/check/checks/git-diff-exists.ts` — `checkGitDiffExists(opts)`
3. `src/check/checks/forbidden-paths.ts` — `checkForbiddenPaths(opts)` (uses `micromatch`)
4. `src/check/checks/protected-runtime-files.ts` — `checkProtectedRuntimeFiles(opts)` (uses `micromatch`; hardcoded protected patterns)
5. `src/check/index.ts` — register 3 new kinds; unknown kinds still throw `CheckError`
6. `package.json` — add `simple-git@^3`, `micromatch@^4`, `@types/micromatch@^4` (devDep)
7. `tests/git/inspector.test.ts` — already written (red phase); must be green after Step 2
8. `tests/check/git-checks.test.ts` — already written (red phase); must be green after Step 2
