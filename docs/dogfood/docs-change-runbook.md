# Dogfood Runbook — docs-change v0.3.0

## Pre-Run Setup

```sh
cd D:\zigma\zigma-flow
pnpm build && node dist/cli.js --version

node dist/cli.js run .zigma-flow/workflows/docs-change.yml \
  --input task="<describe the documentation change>" \
  --run-id dogfood-$(date +%Y%m%d)-docs-change-0001
```

Output root: `docs/temp/dogfood-<date>-docs-change/`

---

## Workflow DAG

```
scope → source-map → draft → consistency-check → review → summarize
```

No signals. No retries. Linear progression.

---

## Step-by-Step Execution

### scope: scope (agent)

- **Task input**: `inputs.task`
- **Outputs**: `scope`
- **Artifact**: `steps/scope/scope/report.json`
- **Watch for**:
  - `scope` must define affected files and excluded areas explicitly
  - Should not pre-draft content; scope only

### source-map: map (agent)

- **Task**: identify authoritative source files and references
- **Outputs**: `sources`
- **Artifact**: `steps/source-map/map/report.json`
- **Watch for**:
  - `sources` should list specific file paths and section anchors
  - Should flag conflicting terminology across source files

### draft: draft (agent)

- **Task**: produce the documentation draft
- **Outputs**: `draft`
- **Artifact**: `steps/draft/draft/report.json`
- **Watch for**:
  - `draft` must stay within the scope defined by `scope` output
  - Terminology must match `sources` (no invented terms)
  - Release note section must be present if the change affects user-visible behavior

### consistency-check: check (check — zigma/file-exists)

- **Check**: `zigma/file-exists` on `.` (existence of workspace)
- **Artifact**: `steps/consistency-check/check/check-result.json`
- **Watch for**:
  - Placeholder check: verify `check-result.json` contains a `pass`/`fail` verdict field
  - Note: this step is a placeholder; real terminology checks are not yet implemented (CG gap candidate)

### review: review (agent)

- **Task**: review draft against scope and sources
- **Outputs**: `verdict`, `issues`
- **Artifact**: `steps/review/review/report.json`
- **Watch for**:
  - `verdict` must be `approved` or `rejected`
  - `issues` must list specific line/section references, not general feedback
  - No retry path exists — a `rejected` verdict blocks the workflow (verify behavior)

### summarize: summarize (agent)

- **Prompt**: cites scope artifact and draft artifact
- **Task input**: `inputs.task`
- **Outputs**: `final_summary`
- **Artifact**: `steps/summarize/summarize/report.json`
- **Watch for**:
  - Uses `prompt:` field (not `with.task` override) — verify prompt packet includes both
  - `final_summary` should reference scope artifact path and draft artifact path

---

## Observation Checklist

| # | Observation | Result |
|---|---|---|
| O1 | `scope` lists affected files and excluded areas | |
| O2 | `source-map` maps specific file paths (not directory-level) | |
| O3 | `draft` stays within scope; no new files invented | |
| O4 | `consistency-check` writes `check-result.json` with verdict | |
| O5 | A `rejected` review verdict halts the workflow without retry | |
| O6 | `summarize` uses the `prompt:` field (check prompt packet) | |
| O7 | `final_summary` cites scope and draft artifacts | |

---

## Known Issues

_None recorded. File issues here after each dogfood run._

---

## Post-Run

1. Copy `report-template.md` → `docs/temp/dogfood-<date>-docs-change/dogfood-report.md`
2. Fill **Prompt Packet Index** (5 agent steps: scope, source-map, draft, review, summarize).
3. Fill **Artifact Index** (check: consistency-check).
4. Fill **Event Summary** — linear run, note any unexpected blocks.
5. Record findings and file P0/P1 issues before closing.
