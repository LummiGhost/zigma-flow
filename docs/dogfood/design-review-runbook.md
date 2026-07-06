# Dogfood Runbook — design-review v0.3.0

## Pre-Run Setup

```sh
cd D:\zigma\zigma-flow
pnpm build && node dist/cli.js --version

node dist/cli.js run .zigma-flow/workflows/design-review.yml \
  --input design_doc="<describe the design or provide a path to the design doc>" \
  --run-id dogfood-$(date +%Y%m%d)-design-review-0001
```

Output root: `docs/temp/dogfood-<date>-design-review/`

---

## Workflow DAG

```
intake → context-map → alternatives → risk-review → human-gate → decision-summary
                             ↑_______________________________________________↓
                                        (on request_changes)
```

Context blocks (written during the run, readable by all downstream jobs):
- `design_context` — written by `context-map.capture-context`
- `alternatives` — written by `alternatives.document-alternatives`
- `risk_assessment` — written by `risk-review.assess-risks`

Human gate decisions:
- `approved` → continues to `decision-summary`
- `rejected` → workflow status: `blocked`
- `request_changes` → returns to `alternatives`

---

## Step-by-Step Execution

### intake: capture (agent)

- **Task input**: `inputs.design_doc`
- **Outputs**: `design_summary`
- **Artifact**: `steps/intake/capture/report.json`
- **Watch for**:
  - `design_summary` should frame the design problem, not pre-judge the solution
  - Should not write to any context block (no `context_edit` permission here)

### context-map: capture-context (agent)

- **Task**: map scope, dependencies, constraints — write to `design_context` context block
- **Context write**: `design_context`
- **Artifact**: `steps/context-map/capture-context/report.json`
- **Watch for**:
  - Context block `design_context` must be populated after this step
  - Verify via: `node dist/cli.js show <run-id> --context design_context`
  - Step has `context_edit: write` — verify permission is honored

### alternatives: document-alternatives (agent)

- **Task**: document alternative approaches with trade-offs — write to `alternatives` context block
- **Context write**: `alternatives`
- **Artifact**: `steps/alternatives/document-alternatives/report.json`
- **Watch for**:
  - Must present ≥2 alternatives with explicit trade-off analysis
  - On `request_changes` loop: verify agent sees updated context from prior iteration

### risk-review: assess-risks (agent)

- **Task**: assess technical, operational, migration risks — write to `risk_assessment` context block
- **Context write**: `risk_assessment`
- **Artifact**: `steps/risk-review/assess-risks/report.json`
- **Watch for**:
  - All three context blocks should be readable by this step
  - Risks should reference specific design choices, not generic concerns

### human-gate: decide (human)

- **Approver**: LummiGhost
- **Timeout**: 1440 minutes (24 hours)
- **Valid decisions**: `approve`, `reject`, `request_changes`
- **Advance**: `node dist/cli.js approve <run-id> human-gate decide --decision approve`
- **Watch for**:
  - Workflow must block here until decision is recorded
  - `reject` and `request_changes` decisions must produce distinct outcomes
  - On `request_changes`: verify workflow loops back to `alternatives`, not `intake`

### decision-summary: route (router) + summarize (agent)

- **Router**: `switch: "${{ jobs.human-gate.outputs.decision }}"`
  - `approved` → continue
  - `rejected` → status: blocked
  - `changes_requested` → goto: alternatives
  - `default` → status: blocked
- **Watch for**:
  - Router switch value must match exact decision string from human-gate output
  - `jobs.human-gate.outputs.decision` namespace must resolve correctly
  - Default case should catch unexpected values without crashing
- **summarize outputs**: `final_summary`
- **Artifact**: `steps/decision-summary/summarize/report.json`
- **Watch for**:
  - `final_summary` must cite all three context blocks by path
  - Includes final decision, rationale, and any conditions

---

## Observation Checklist

| # | Observation | Result |
|---|---|---|
| O1 | `design_context` context block is populated after `context-map` | |
| O2 | `alternatives` context block is populated after `alternatives` | |
| O3 | `risk_assessment` context block is populated after `risk-review` | |
| O4 | Human gate blocks workflow until `decide` command is run | |
| O5 | `approve` decision routes to `decision-summary` | |
| O6 | `reject` decision sets workflow status to `blocked` | |
| O7 | `request_changes` loops back to `alternatives` (not `intake`) | |
| O8 | Router `default` case blocks on unrecognized decision value | |
| O9 | `final_summary` cites all three context blocks | |

---

## Known Issues

_None recorded. File issues here after each dogfood run._

---

## Post-Run

1. Copy `report-template.md` → `docs/temp/dogfood-<date>-design-review/dogfood-report.md`
2. Fill **Prompt Packet Index** (5 agent steps: intake, context-map, alternatives, risk-review, decision-summary.summarize).
3. Fill **Artifact Index** — include context block snapshots if captured.
4. Fill **Event Summary** — record human gate timing and decision, any `request_changes` loops.
5. Record findings and file P0/P1 issues before closing.
