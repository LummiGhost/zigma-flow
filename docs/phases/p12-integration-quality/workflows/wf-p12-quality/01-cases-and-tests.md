# WF-P12-QUALITY — Cases and Tests

Reference: docs/phases/p12-integration-quality/

## Scope

P12 covers two quality gate items:

- **P12.1** — Dogfood integration tests for the code-change workflow
  (TC-DOGFOOD-1..5 in `tests/dogfood/code-change.test.ts`)
- **P12.2** — Test classification scripts and build smoke test
  (`package.json` scripts: `test:unit`, `test:integration`, `test:e2e`, `test:ci`, `smoke`)

---

## P12.1 — TC-DOGFOOD-5

### Test Case: needs_architecture_design signal activates architecture-design optional job

**ID**: TC-DOGFOOD-5  
**File**: `tests/dogfood/code-change.test.ts`  
**Test name**: `"needs_architecture_design signal from plan activates architecture-design and completes full workflow (TC-DOGFOOD-5)"`

#### Description

Exercises the full 10-job code-change workflow including the optional
`architecture-design` job activated by the `needs_architecture_design` signal
from the `plan` agent step.

This is the complement to TC-DOGFOOD-3 (happy-path, architecture-design stays
inactive). TC-DOGFOOD-5 validates the signal-activation path end-to-end.

#### Path Under Test

1. `runInit` creates the `.zigma-flow/` scaffold.
2. `createRun` creates a run with the generated `code-change.yml`.
3. `intake` → agent step `analyze` → completes.
4. `code-map` → agent step `map` → completes.
5. `risk-scan` → check step `validate` → completes.
6. `plan` → agent step `plan` → emits `needs_architecture_design` signal
   (`signals: [{ type: "needs_architecture_design" }]`).
   - Signal handler calls `applyRoutingAction({ activate_job: "architecture-design" })`.
   - `architecture-design` transitions `inactive` → `ready`.
   - `advanceJob` completes `plan`.
7. `architecture-design` → agent step `design` → completes.
   - `implement` (needs: [plan], optional_needs: [architecture-design]) is
     promoted to "ready" by `promoteReadyJobs` (called inside `runAgentJob`).
8. `implement` → agent step `implement` → script step `collect-diff` → completes.
9. `static-check` → script step `check` → completes.
10. `unit-test` → script step `test` → completes.
11. `review` → agent step `review` → completes.
12. `summarize` → agent step `summarize` → completes.

#### Assertions

- After `plan` completes with signal:
  - `plan` status = `"completed"`
  - `architecture-design` status = `"ready"` (activated by signal)
  - `events.jsonl` contains `signal_received` (type=`needs_architecture_design`, from_job=`plan`)
  - `events.jsonl` contains `job_activated` (job_id=`architecture-design`)
- After `architecture-design` completes:
  - `architecture-design` status = `"completed"`
  - `implement` status = `"ready"` (promoted because `needs: [plan]` is satisfied;
    `optional_needs` are ignored for readiness per `computeReadyJobs`)
- Final state: ALL 10 jobs status = `"completed"` (including `architecture-design`)

#### Design Notes

- `optional_needs` are ignored by `computeReadyJobs` and `promoteReadyJobs` —
  they never block readiness. `implement` becomes "ready" as soon as `plan`
  completes, regardless of `architecture-design` status.
- `architecture-design` has `activation: "manual"`, so `promoteReadyJobs`
  skips it. The signal is the sole mechanism that transitions it to "ready".
- After the signal path in `acceptAgentReport`: `applyRoutingAction` activates
  `architecture-design`, then `advanceJob` completes `plan` (the source job).
- `runAgentJob("architecture-design")` calls `promoteReadyJobs` internally,
  which promotes `implement` to "ready" (plan is now completed).

---

## P12.2 — Test Classification Scripts

### P12.2.1 — Classified test scripts in package.json

**Added scripts**:

| Script | Command | Purpose |
|---|---|---|
| `test:unit` | `vitest run tests/artifact tests/check ... tests/workflow` | Pure unit tests (no I/O) |
| `test:integration` | `vitest run tests/commands tests/engine tests/init` | Integration tests (filesystem, engine) |
| `test:e2e` | `vitest run tests/dogfood tests/cli` | End-to-end/dogfood tests |
| `test:ci` | `vitest run` | Full CI suite (all tests) |

#### Unit test directories

`tests/artifact`, `tests/check`, `tests/context`, `tests/dag`, `tests/events`,
`tests/expression`, `tests/git`, `tests/prompt`, `tests/router`, `tests/run`,
`tests/script`, `tests/workflow`

#### Notes

- `tests/fixtures`, `tests/skill-pack`, `tests/smoke`, `tests/workspace` are
  intentionally excluded from named suites; they are covered by `test:ci`.
- `test:unit` and `test:integration` may partially overlap in practice (the
  engine tests use real filesystem), but the classification reflects intent.

### P12.2.3 — Build smoke test

**Added script**: `"smoke": "node dist/cli.js --help"`

Requires running `pnpm build` first. Validates that the CLI binary is present
in `dist/` and responds to `--help` without crashing.

Usage:
```
pnpm build && pnpm smoke
```
