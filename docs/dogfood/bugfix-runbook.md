# Dogfood Runbook — bugfix v0.3.0

## Pre-Run Setup

```sh
cd D:\zigma\zigma-flow
pnpm build && node dist/cli.js --version

node dist/cli.js run .zigma-flow/workflows/bugfix.yml \
  --input bug_report="<describe the bug>" \
  --input affected_component="<optional component name>" \
  --run-id dogfood-$(date +%Y%m%d)-bugfix-0001
```

Output root: `docs/temp/dogfood-<date>-bugfix/`

---

## Workflow DAG

```
intake → reproduce → diagnose → plan → implement → regression-test → review → summarize
                                             ↑_______________review (on review_rejected)
```

Signals:
- `review_rejected` — dispatched from `review`, retries `implement` (max 3 attempts)

---

## Step-by-Step Execution

### intake: analyze (agent)

- **Task input**: `inputs.bug_report`
- **Outputs**: `bug_summary`, `affected_files`
- **Artifact**: `steps/intake/analyze/report.json`
- **Watch for**:
  - `affected_files` should list specific paths, not just module names
  - `bug_summary` should distinguish observed symptoms from inferred causes

### reproduce: reproduce (agent)

- **Task**: reproduce steps and trigger conditions for the bug
- **Outputs**: `reproduce_artifact`, `is_reproducible`
- **Artifact**: `steps/reproduce/reproduce/report.json`
- **Watch for**:
  - `reproduce_artifact` must document exact steps, not general advice
  - `is_reproducible: false` should block downstream progression (verify behavior)

### diagnose: diagnose (agent)

- **Task**: root-cause analysis with evidence classification
- **Outputs**: `root_cause`, `evidence_map`
- **Artifact**: `steps/diagnose/diagnose/report.json`
- **Watch for**:
  - Every claim must be tagged OBSERVED EVIDENCE / INFERENCE / UNVERIFIED ASSUMPTION
  - `evidence_map` should reference specific lines/files, not generic descriptions

### plan: plan (agent)

- **Task**: fix plan using root cause from diagnose
- **Outputs**: `fix_plan`, `risk_assessment`
- **Artifact**: `steps/plan/plan/report.json`
- **Watch for**:
  - `risk_assessment` should cover regression risk and scope creep risk
  - Plan should not restate the bug; it should describe the fix approach

### implement: implement (agent) + collect-diff (script)

- **implement outputs**: `summary`, `files_changed`
- **Artifact**: `steps/implement/implement/report.json`
- **collect-diff**: `git diff HEAD`
- **Artifact**: `steps/implement/collect-diff/stdout.txt`
- **Watch for**:
  - `files_changed` must match actual diff output
  - Diff should be scoped to the reported affected component
  - On retry: verify agent picks up previous rejection reason

### regression-test: run-tests (script) + verify-fix (agent)

- **run-tests**: `pnpm test:ci`
- **Artifacts**: `steps/regression-test/run-tests/stdout.txt`, `stderr.txt`, `result.json`
- **verify-fix outputs**: `regression_test_artifact`, `fix_verified`
- **Artifact**: `steps/regression-test/verify-fix/report.json`
- **Watch for**:
  - `fix_verified` must reference test output artifact, not assert from memory
  - Test failures should block workflow (verify `on_failure: fail` is respected)

### review: review (agent)

- **Task**: review fix against bug report and regression evidence
- **Outputs**: `verdict`, `issues`
- **Artifact**: `steps/review/review/report.json`
- **Watch for**:
  - `verdict` must be `approved` or `rejected` (no ambiguous values)
  - `issues` must be non-empty when `verdict` is `rejected`
  - On rejection: verify `review_rejected` signal fires and `implement` retries

### summarize: summarize (agent)

- **Task**: final summary citing `reproduce_artifact` and `regression_test_artifact`
- **Outputs**: `final_summary`, `remaining_risks`
- **Artifact**: `steps/summarize/summarize/report.json`
- **Watch for**:
  - Every factual claim must cite a specific artifact path
  - `remaining_risks` must be present even if empty (check for `[]` vs omission)

---

## Observation Checklist

| # | Observation | Result |
|---|---|---|
| O1 | `reproduce_artifact` documents reproducible steps before diagnose starts | |
| O2 | `diagnose` classifies every claim as OBSERVED / INFERENCE / UNVERIFIED | |
| O3 | `implement/collect-diff` stdout is non-empty and scoped to bug area | |
| O4 | `regression-test/run-tests` exit code captured in `result.json` | |
| O5 | `review_rejected` signal retries `implement` (not a new run) | |
| O6 | `summarize` cites `reproduce_artifact` and `regression_test_artifact` | |
| O7 | All agent reports contain non-null values for declared outputs | |
| O8 | No job skipped without explicit condition | |

---

## Known Issues

_None recorded. File issues here after each dogfood run._

---

## Post-Run

1. Copy `report-template.md` → `docs/temp/dogfood-<date>-bugfix/dogfood-report.md`
2. Fill **Prompt Packet Index** (7 agent steps: intake, reproduce, diagnose, plan, implement, verify-fix, review, summarize).
3. Fill **Artifact Index** (script: collect-diff, run-tests; check: none).
4. Fill **Event Summary** with job transitions and any retries.
5. Record findings and file P0/P1 issues before closing.
