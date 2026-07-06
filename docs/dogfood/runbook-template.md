# Dogfood Runbook — {{workflow}} v{{version}}

Generic template. Copy to `docs/dogfood/{{workflow}}-runbook.md` and fill in workflow-specific sections.

---

## Pre-Run Setup

```sh
# working directory
cd D:\zigma\zigma-flow

# verify CLI
pnpm build && node dist/cli.js --version

# start a new run
node dist/cli.js run .zigma-flow/workflows/{{workflow}}.yml \
  --input key=value \
  --run-id dogfood-$(date +%Y%m%d)-0001
```

## Workflow DAG

```
{{job-A}} → {{job-B}} → {{job-C}} → ...
```

## Step-by-Step Execution

For each job: record the step type, the CLI command to advance or inspect, and the artifact path to verify.

### {{job}}: {{step}}

- **Type**: agent / script / check / human / router
- **Advance**: `node dist/cli.js step <run-id> {{job}} {{step}}`
- **Verify**: `cat docs/temp/dogfood-<date>-{{workflow}}/steps/{{job}}/{{step}}/report.json`
- **Watch for**:
  - {{observation note}}

---

## Observation Checklist

Work through these during the run and record pass/fail/note next to each.

| # | Observation | Result |
|---|---|---|
| O1 | All jobs transition to `ready` automatically after upstream completes | |
| O2 | Agent outputs match declared output schema | |
| O3 | Script steps capture stdout/stderr to artifact paths | |
| O4 | Check steps write `check-result.json` with `pass`/`fail` verdict | |
| O5 | Signals dispatched correctly and trigger expected job actions | |
| O6 | Human gate blocks until decision is recorded | |
| O7 | Router step routes to correct next job | |
| O8 | Retry counter increments and stops at `max_attempts` | |
| O9 | Context blocks are written and readable by downstream steps | |

---

## Finding Format

```
DF-<TYPE>-NNN: <one-line title>
  Severity: P0/P1/P2/P3
  Trigger: <reproduce steps>
  Observed: <actual>
  Expected: <expected>
  Status: open
```

Types: `RT` runtime bug · `WD` workflow design bug · `PR` prompt bug · `CG` contract gap · `DG` documentation gap

---

## Post-Run

1. Copy `report-template.md` → `docs/temp/dogfood-<date>-{{workflow}}/dogfood-report.md`
2. Fill in all sections.
3. Record findings in the report under **Known Risks / Findings**.
4. File issues for P0/P1 findings before closing the run.
