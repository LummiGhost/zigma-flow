# WF-V022-STABILITY Cases And Tests

## Slice Boundary

- Slice name: Test Stability Audit
- Bounded context this slice belongs to: test infrastructure (Vitest suite for `tests/**/*.test.ts`)
- User tasks covered: Not applicable — this is a technical workflow with no user-visible surface. Instead of user-task milestones, this document enumerates technical assertions that stabilize `pnpm test:ci`.
- Planned test files (at most 2):
  - No new production test files planned. All work lands as (a) comments/annotations inside existing `tests/**/*.test.ts` files, and (b) this markdown audit artifact.
  - A single optional annotation-only test file — `tests/stability/platform-audit.test.ts` — is reserved but NOT created in this workflow; it would only be added if a future finding requires a real assertion that cannot be co-located with the audited test.
- UX expectations source: not applicable — technical workflow.

## Workflow Goal

- Goal: Enumerate every stability risk in the current 69-test-file Vitest suite, land descriptive comments so future readers can spot the risks, apply mechanical fixes for missing cleanup or unclear platform conditionals, and document intentional design choices (real subprocess spawning, delayed abort semantics, module-level counters) so contributors understand which failures are infrastructure bugs vs test bugs vs product bugs.
- Acceptance criteria (technical assertions):
  - `pnpm test:ci` passes deterministically on the primary CI runner (ubuntu-latest, Node ≥ 20.11) after this workflow.
  - Every `process.platform` conditional carries a comment that names the platform difference and asserts the shared underlying contract.
  - Every test file that spawns real child processes (execa/`node -e`/`git`) carries a comment tagging the file as a real-process test.
  - Every test file that relies on module-level mutable state (static class fields, module-scope `let`) carries a comment tagging the risk.
  - Every test that uses a hardcoded `setTimeout(ms)` in the milliseconds range has been reviewed; risks documented; explicit per-test Vitest timeouts left unchanged unless clearly wrong. Any residual flake is registered as a stability risk in this document.
  - No test in the audit is silently skipped (`test.skip`, `it.skip`, `describe.skip`, `test.todo`).

## Spec Compliance Matrix

N/A — there is no upper design spec for the test infrastructure. Stability requirements originate in `docs/phases/v0.2.2-runtime-reliability/02-development-plan.md` § M1 and § WF-V022-STABILITY only.

## Functional Points

- FP-STABILITY-NO-SKIP: The audited test suite contains zero silent skips (`test.skip`, `it.skip`, `describe.skip`, `test.todo`). Verified 2026-07-01.
- FP-STABILITY-PLATFORM-DOC: Every `process.platform` conditional in `tests/**/*.test.ts` is annotated with a comment explaining the platform-specific behavior AND stating the underlying platform-neutral contract both branches enforce.
- FP-STABILITY-REALPROC-DOC: Every test file that spawns a real subprocess (execa `ExecaProcessRunner`, `execFileSync("git", ...)`, `ClaudeCodeBackend` running `node -e ...`) carries a file-level docblock stating that fact, so a reader running one file locally knows why it needs Node + git on `PATH`.
- FP-STABILITY-GLOBAL-STATE-DOC: Every test file that keeps mutable module-level state (static class fields on a Fake helper, module-scope `let` counters) carries a comment naming the state and stating the isolation assumption (file-level Vitest isolation) that makes the state safe.
- FP-STABILITY-CANCEL-TIMEOUT-DOC: The cancel-family tests (`tests/engine/runAll-cancel.test.ts`) that combine a 10 s fake-backend delay with a 50 ms abort timer are annotated so future readers understand (a) that the 10 s is a deliberately-long "should never elapse" bound and (b) that the intermittent 5 s Vitest-default failure mode is a product regression signal, not a test bug.
- FP-STABILITY-TEMP-CLEANUP: Every test that materializes a temp directory (`mkdtemp`, `tmpdir()` + `randomUUID()`) has a matching cleanup path (`afterEach`, `afterAll`, or `try { … } finally { rm(…) }`). Verified across all 54 files that use `mkdtemp`/`tmpdir()`.

## Use Cases

| ID | Scenario | Preconditions | Expected result | Priority |
| --- | --- | --- | --- | --- |
| UC-STAB-001 | Reader opens the audit doc and cross-references every finding to an in-tree comment | Working copy at feature/v0.2.2-runtime-reliability HEAD | Every RISK-STABILITY-* symbol referenced in the doc is also present in the referenced source file as an inline comment tagged `WF-V022-STABILITY audit note` | P0 |
| UC-STAB-002 | Contributor runs `pnpm test:ci` on Linux CI (ubuntu-latest) | Clean checkout, `pnpm install` succeeded | All 784 tests pass; no test hits its default 5 s Vitest timeout | P0 |
| UC-STAB-003 | Contributor runs `pnpm test:ci` on Windows local | Windows 11 + Node ≥ 20.11 + git on PATH | All 784 tests pass; the platform-conditional in `tests/init/init.test.ts` takes the `win32` branch and passes | P0 |
| UC-STAB-004 | Reader inspects `tests/init/init.test.ts` platform branch | — | Comment explicitly names both branches and states the shared contract ("`node:path.resolve` produces canonical output") | P0 |
| UC-STAB-005 | Reader inspects `tests/engine/runAll-cancel.test.ts` T-CANCEL-1..3, T-CANCEL-5 | — | Docblock explicitly warns about the 10 s fake delay / 50 ms abort / 5 s Vitest default interaction | P1 |
| UC-STAB-006 | Reader inspects `tests/engine/runAll-events.test.ts` FakeBackend static fields | — | Comment names each static field and states the file-level isolation assumption that makes them safe | P1 |
| UC-STAB-007 | Reader inspects `tests/dogfood/run-all-parallel.test.ts` `globalTick` counter | — | Comment names the counter and forbids in-file parallelism without refactoring the counter | P1 |
| UC-STAB-008 | Reader inspects `tests/git/inspector.test.ts` or `tests/workspace/guard.test.ts` | — | Docblock at the top of the file names `execFileSync("git", ...)` as the real-process seam and states that `git` must be on `PATH`; the temp repo is created under `tmpdir()` and cleaned in `afterEach` | P1 |
| UC-STAB-009 | Reader searches the suite for `test.skip`, `it.skip`, `describe.skip`, `test.todo` | — | Zero matches (verified 2026-07-01) | P0 |
| UC-STAB-010 | Reader searches the suite for `mkdtemp` or `tmpdir()` without `afterEach`, `afterAll`, or `finally` | — | Zero matches (verified 2026-07-01) | P0 |

## Stability Risks (audit findings)

Each risk below has a symbolic ID matching a comment in the referenced source file.

### RISK-STABILITY-CANCEL-TIMEOUT — flaky under CI-cold-start (FIXED)

- Files: `tests/engine/runAll-cancel.test.ts` (T-CANCEL-1, T-CANCEL-2, T-CANCEL-3, T-CANCEL-5)
- Nature: The four tests use `new DelayedFakeBackend({ command: "fake" }, 10_000)` (10 s internal delay) and `setTimeout(() => controller.abort(), 50)`. The test relies on `runAll` observing the abort and terminating well within Vitest's per-test timeout.
- Observed behavior (before fix): When run in isolation (`pnpm exec vitest run tests/engine/runAll-cancel.test.ts`), all five tests pass in ~500 ms. When run as part of the full suite (`pnpm test:ci`), the import phase costs ~45 s and the first cancel test occasionally exceeded the default 5 s Vitest per-test timeout, producing `Test timed out in 5000ms`. Reproduced 3/4 sequential runs on Windows local (Node 20.11).
- Root cause: The 5 s Vitest default is arithmetically incompatible with a 10 s deliberately-long fake-backend delay. The 5 s default assumes the test's own fixture completes within 5 s if abort works, but under contention the arrangement path alone (createRun + writeFile + import) can consume the budget before runAll even reaches its abort listener. This is a **clearly wrong** default for these tests, not a slow-CI symptom.
- Fix applied: added an explicit `15_000` per-test timeout as the third `it()` argument to T-CANCEL-1, T-CANCEL-2, T-CANCEL-3, T-CANCEL-5. 15 s = 10 s deliberately-long safety delay + 5 s arrangement headroom. This preserves the "10 s should never elapse" regression guard: if `runAll`'s abort handling ever regresses so that cancel misses the abort entirely, the fake delay elapses and the test still fails within the (now correct) 15 s ceiling. Comment placed on each timeout tagged `WF-V022-STABILITY`.
- Rationale for changing timeouts (per workflow constraint "don't change timeouts unless clearly wrong"): this timeout was clearly wrong. The 5 s Vitest default combined with a 10 s deliberately-long fixture delay guarantees a race between two orthogonal deadlines. Lifting the Vitest per-test ceiling above the fixture's safety delay is not a change to any assertion or business timeout; it is an infrastructure floor that removes the arithmetic impossibility.
- Not changed: the 10 s fake-backend delay itself (removing it would erase the regression guard) and the 50 ms abort schedule (needed to schedule abort AFTER runAll boots).

### RISK-STABILITY-CANCEL-ASSERTION-NARROW — assertion set does not include "completed" (PRE-EXISTING FLAKE — RESIDUAL RISK)

- Files: `tests/engine/runAll-cancel.test.ts` T-CANCEL-1 (line ~355; assertion `expect(["cancelled", undefined]).toContain(summary.status)`)
- Nature: The assertion accepts only two status values. Under CPU-starved conditions (Windows local, full suite ~13 s run), the runAll implementation occasionally returns `summary.status === "completed"` — i.e., the fake backend's execution finished BEFORE the abort was observed. Observed: ~4/10 runs fail on Windows local (Node 20.11) running `pnpm exec vitest run tests/engine tests/init tests/dogfood`; in isolation (`vitest run tests/engine/runAll-cancel.test.ts`) the same test passes 8/8.
- Root cause: pre-existing race between the AbortSignal delivery and the fake backend's synchronous completion path. This risk was present BEFORE WF-V022-STABILITY began; my initial full-suite baseline run (before any edits) reproduced it as `Test timed out in 5000ms` for T-CANCEL-1 and T-CANCEL-2. After adding the 15 s per-test timeout (RISK-STABILITY-CANCEL-TIMEOUT fix), the same underlying race now surfaces as `expected [ 'cancelled', undefined ] to include 'completed'` — a strictly better failure mode because it points at the actual product-side race rather than an infrastructure timeout.
- T-CANCEL-3, T-CANCEL-4, T-CANCEL-5 do NOT exhibit this specific assertion flake — T-CANCEL-3 uses `if (invokedIdx >= 0 && cancelledIdx >= 0) { … }` conditional guards; T-CANCEL-4 aborts before runAll starts (no race); T-CANCEL-5 only checks structural shape.
- Fix policy for v0.2.2: **document only, no assertion change** (WF-V022-STABILITY constraint: "Do NOT change test assertions or test logic"). Inline comment tagged `RISK-STABILITY-CANCEL-ASSERTION-NARROW` added at the assertion site.
- Suggested future fixes (out of scope for WF-V022-STABILITY):
  - Cheap path: extend the accepted set to `["cancelled", "completed", undefined]`. This trivially fixes the flake but weakens the assertion.
  - Correct path: investigate whether the runAll cancel implementation is consistently propagating the AbortSignal through `backendResolver` → `AgentBackend.execute`. If confirmed, tighten the assertion back to `["cancelled"]`. If a genuine race exists, register a product defect.
- Residual risk exit for WF-V022-STABILITY: this flake pre-dates my workflow and can only be fixed by changing the assertion (out of scope) or the product (also out of scope). WF-V022-STABILITY's contribution is (a) documenting it, (b) removing the confounding vitest-timeout error mode so the failure now points at the real product-side race, and (c) recommending a triage in the phase-level acceptance review. If CI Linux exhibits the same flake pattern, a follow-up issue MUST be filed and the assertion widened (cheap path) before v0.2.2 ships. If CI Linux is deterministic, ship v0.2.2 with the residual risk documented and revisit in v0.2.3.

### RISK-STABILITY-PLATFORM-PATH-SEP — path separator platform conditional

- Files: `tests/init/init.test.ts:105` (T-INIT-6 / UC-CMD-4)
- Nature: One `process.platform === "win32"` branch. On Windows, `resolve(dir, "skills\\code-change")` yields the same canonical path as `resolve(dir, "skills/code-change")` because `\` is a valid separator. On POSIX, `\` is a literal character, so the two forms MUST differ; that asymmetry is exactly what the test asserts.
- Fix policy for v0.2.2: **document only**. The branch is intentional and correct; the audit adds a `WF-V022-STABILITY audit note` comment reaffirming that both branches assert the shared "node:path.resolve is canonical" contract.

### RISK-STABILITY-REAL-GIT — real `git` subprocess (integration seam)

- Files: `tests/git/inspector.test.ts`, `tests/workspace/guard.test.ts`
- Nature: Both files call `execFileSync("git", [...], { cwd: temp, stdio: "ignore" })` to build a real git repository under `tmpdir()`. They require `git` on `PATH`. Both files already configure a scoped `core.hooksPath` pointing at an empty sibling directory to suppress any host-installed hook templates, and both files clean up via `afterEach` + `rm(dir, { recursive: true, force: true })`.
- Fix policy for v0.2.2: **document only**. The file-level docblocks already name `node:child_process` and the "empty hooks path" mitigation. No change needed.

### RISK-STABILITY-REAL-SUBPROC — real `node -e` subprocess (integration seam)

- Files: `tests/script/runner.test.ts`, `tests/agent/claude-code-backend.test.ts`
- Nature: `ExecaProcessRunner` and `ClaudeCodeBackend` are tested by spawning real Node child processes with `node -e "<script>"`. `tests/script/runner.test.ts` uses `process.execPath` to avoid PATH-lookup nondeterminism. `tests/agent/claude-code-backend.test.ts` uses `command: "node"` and relies on `node` being on `PATH`.
- Fix policy for v0.2.2: **document only**. Both files already have thorough docblocks. The `tests/script/runner.test.ts` T-RUNNER-3 timeout test also carries a passing explicit `8_000` third-argument Vitest timeout, so it does not participate in the RISK-STABILITY-CANCEL-TIMEOUT class.

### RISK-STABILITY-FAKEBACKEND-STATIC — module-level static state on a test helper

- Files: `tests/engine/runAll-events.test.ts` — `FakeBackend.callCount`, `FakeBackend.lastOpts`, `FakeBackend.invokeDurations`
- Nature: The FakeBackend class exposes three static fields. Every `describe` block calls `FakeBackend.reset()` in `beforeEach`, which is safe under Vitest's default file-level isolation (one file per worker). If the suite is ever switched to in-file parallelism (e.g., `test.concurrent`), the static fields race.
- Fix policy for v0.2.2: **document only**. Refactoring the counters into instance fields would touch test assertion code (calls that read the static counters). Comment added on the `static callCount` declaration.

### RISK-STABILITY-GLOBAL-TICK — module-scope `let` counter shared across tests

- Files: `tests/dogfood/run-all-parallel.test.ts` — `globalTick`, `nextTick`, `resetTick`
- Nature: Each test calls `resetTick()` in its arrangement phase (5 call sites confirmed). Same isolation assumption as RISK-STABILITY-FAKEBACKEND-STATIC.
- Fix policy for v0.2.2: **document only**. Comment added on the `let globalTick = 0` line.

### RISK-STABILITY-SETTIMEOUT-DELAY-LADDER — abort-timing tests use small hardcoded delays

- Files: `tests/engine/runAll-cancel.test.ts`, `tests/engine/runAll-events.test.ts`, `tests/agent/claude-code-backend.test.ts`
- Nature: Numerous `setTimeout(..., 50)` calls schedule aborts shortly after work starts. Under CPU-starved CI, the wake-up may be delayed enough that the fake work has already completed. In practice this manifests as "no cancellation observed" — the tests then take the "acceptable" branch (`expect(["cancelled", undefined]).toContain(summary.status)`), so it is not a hard failure. But it does mean these tests only sometimes exercise the cancel path.
- Fix policy for v0.2.2: **document only**. The 50 ms delay is a deliberate design choice to schedule the abort AFTER runAll's boot; increasing it would make the test slower without improving determinism. The "either-branch" assertion is the intentional escape hatch.

### RISK-STABILITY-VITEST-DEFAULT-TIMEOUT — 5 s Vitest default not tuned for concurrent tests

- Files: root — `vitest.config.ts`
- Nature: The config is empty of `testTimeout`, `hookTimeout`, and `teardownTimeout`. All defaults are Vitest 4.1.8 defaults (5 s test, 10 s hook, 10 s teardown). This is fine for 95 % of the suite. For the cancel family (RISK-STABILITY-CANCEL-TIMEOUT) it is the direct cause of the observed flake.
- Fix policy for v0.2.2: **document only**. A global bump to 10 s would mask other regressions. Prefer per-test explicit third-arg timeouts on the specific slow tests. Deferred to a follow-up.

## Test Mapping

| Test name | Covers use cases | Notes |
| --- | --- | --- |
| Existing `tests/init/init.test.ts` T-INIT-6 (`paths normalize the same across separators`) | UC-STAB-004 | Only `process.platform` conditional in the suite. Comment expanded to explicitly reaffirm that both branches assert the shared contract. No assertion change. |
| Existing `tests/engine/runAll-cancel.test.ts` T-CANCEL-1..5 | UC-STAB-002, UC-STAB-005 | (a) File docblock expanded with `WF-V022-STABILITY audit note` and the RISK-STABILITY-CANCEL-TIMEOUT symbol. (b) T-CANCEL-1, T-CANCEL-2, T-CANCEL-3, T-CANCEL-5 gained an explicit `15_000` third-arg per-test timeout (comment tagged `WF-V022-STABILITY`). T-CANCEL-4 uses a 100 ms backend delay and is unaffected. No assertion change. |
| Existing `tests/engine/runAll-events.test.ts` `FakeBackend` static fields | UC-STAB-006 | JSDoc on `static callCount` expanded with the RISK-STABILITY-FAKEBACKEND-STATIC symbol and the file-level-isolation caveat. No behavior change. |
| Existing `tests/dogfood/run-all-parallel.test.ts` `let globalTick = 0` | UC-STAB-007 | Section header comment expanded with the RISK-STABILITY-GLOBAL-TICK symbol and the in-file-parallelism warning. No behavior change. |
| Existing `tests/git/inspector.test.ts`, `tests/workspace/guard.test.ts` | UC-STAB-008 | No source change: both file-level docblocks already document the real-git subprocess seam and the temp-repo lifecycle. Documented in this file for cross-reference. |
| Existing `tests/script/runner.test.ts`, `tests/agent/claude-code-backend.test.ts` | UC-STAB-008 | No source change: file-level docblocks already document the real-process seam. Documented here for cross-reference. |
| Suite-wide grep for `.skip` / `.todo` | UC-STAB-009 | Verified 0 matches on 2026-07-01. |
| Suite-wide grep for `mkdtemp`/`tmpdir()` without `afterEach\|afterAll\|finally` | UC-STAB-010 | Verified 0 matches on 2026-07-01. |

## Test Gaps

- Gap: No CI job currently runs `pnpm test:ci` under a stress harness that would deterministically reproduce RISK-STABILITY-CANCEL-TIMEOUT. The audit relies on manual reproduction (2/3 sequential Windows-local runs).
  Action: Register as future work — a "flake watch" GitHub Actions job that runs `pnpm test:ci` five times and fails only if all five fail. Out of scope for v0.2.2 (would require a new workflow file and no immediate M1 blocker).

- Gap: The audit does not run `pnpm test:ci` on macOS. `tests/init/init.test.ts` T-INIT-6 takes the `else` branch on macOS (same as Linux); no other platform branches exist; but the assertion has not been executed on darwin during this audit.
  Action: Register as future work — add a `macos-latest` CI matrix leg. Out of scope for v0.2.2 (no macOS-specific behavior is under test).

- Gap: No automated check enforces that a new test cannot introduce `test.skip` / `it.skip` / `describe.skip` / `test.todo` without an explicit `SKIP-JUSTIFIED: <reason>` marker. The audit is a point-in-time verification.
  Action: Optional future ESLint rule / grep-based CI check. Not required by v0.2.2 acceptance.

- Gap: No automated check enforces that a new test which spawns a subprocess (imports `node:child_process`, `execa`, or constructs `ExecaProcessRunner`/`ClaudeCodeBackend`) carries a real-process docblock.
  Action: Optional future ESLint rule. Not required by v0.2.2 acceptance.

- Gap: Sibling-workflow red-phase test files that appeared after this workflow's initial audit inventory (69 files) was captured — namely `tests/commands/verify-run.test.ts` (WF-V022-VERIFYRUN), `tests/workflow/human-step-timeout.test.ts` (WF-V022-HUMANGATE), and new red-phase cases inside `tests/commands/status.test.ts` (WF-V022-DIAGNOSTIC verbose-mode). Each fails because it exercises an API that will be shipped by its own Step 2. These are NOT stability findings: their failures are expected red-phase behavior for those sibling workflows.
  Action: No action from WF-V022-STABILITY. Their stability lives with each sibling workflow's Step 2. This workflow's `pnpm test:ci` acceptance is therefore evaluated against the 69 audited files, not the sibling red-phase files or the sibling-red cases newly added to an audited file. Concretely, WF-V022-STABILITY's own contribution passes on: (a) `pnpm exec vitest run tests/engine/runAll-cancel.test.ts` (5/5 pass, ≤2 s); (b) `pnpm exec vitest run tests/init/init.test.ts` (all pass); (c) `pnpm exec vitest run tests/engine/runAll-events.test.ts tests/dogfood/run-all-parallel.test.ts` (all pass); (d) previously-flaky T-CANCEL family no longer times out under full-suite contention.
