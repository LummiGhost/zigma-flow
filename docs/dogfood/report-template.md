---
# Dogfood Report — {{workflow}} {{version}}

## Metadata

| Field | Value |
|---|---|
| Date | YYYY-MM-DD |
| Run ID | `zigma-flow-YYYYMMDD-NNNN` |
| Workflow | {{workflow}} v{{version}} |
| Task | {{one-line task description}} |
| Agent Model | claude-{{model}} |
| CLI Version | `pnpm zigma --version` |
| Duration | HH:MM – HH:MM |

---

## Prompt Packet Index

Each agent step produces a prompt packet under `docs/temp/dogfood-<date>-<workflow>/steps/<job>/<step>/prompt-packet/`.

| Job | Step | Type | Prompt packet | Report |
|---|---|---|---|---|
| {{job}} | {{step}} | agent | `steps/{{job}}/{{step}}/prompt-packet/` | `steps/{{job}}/{{step}}/report.json` |

---

## Artifact Index

| Job | Step | Type | Artifact path | Description |
|---|---|---|---|---|
| {{job}} | {{step}} | script | `steps/{{job}}/{{step}}/stdout.txt` | Script stdout |
| {{job}} | {{step}} | script | `steps/{{job}}/{{step}}/stderr.txt` | Script stderr |
| {{job}} | {{step}} | script | `steps/{{job}}/{{step}}/result.json` | Exit code + timing |
| {{job}} | {{step}} | check | `steps/{{job}}/{{step}}/check-result.json` | Check verdict |
| {{job}} | {{step}} | agent | `steps/{{job}}/{{step}}/report.json` | Agent outputs + signals |

---

## Event Summary

Chronological log of workflow state transitions, signals, and retries.

| Time | Event | Job → Job / Details |
|---|---|---|
| HH:MM | `job_started` | `{{job}}` |
| HH:MM | `job_completed` | `{{job}}` → triggers `{{next_job}}` |
| HH:MM | `signal_dispatched` | `{{signal_name}}` from `{{job}}` |
| HH:MM | `job_retried` | `{{job}}` attempt 2/3 |
| HH:MM | `human_gate_opened` | `{{job}}.{{step}}` — awaiting approval |
| HH:MM | `human_gate_closed` | decision: {{approve/reject/request_changes}} |
| HH:MM | `workflow_completed` | status: {{success/failed/blocked}} |

---

## Known Risks / Findings

Use finding IDs in the format `DF-<TYPE>-NNN` (NNN is a 3-digit sequence across all runs of this workflow).

Finding types:

| Code | Category | Description |
|---|---|---|
| `RT` | runtime bug | Engine execution failure, unexpected exit, state corruption |
| `WD` | workflow design bug | Job structure, dependency, or signal logic flaw |
| `PR` | prompt bug | Unclear, incomplete, or conflicting step instructions |
| `CG` | contract gap | Missing or ambiguous output schema, signal, or artifact contract |
| `DG` | documentation gap | Missing or incorrect documentation |

### Findings

#### DF-RT-001 — {{title}}

- **Severity**: P0 / P1 / P2 / P3
- **Trigger**: {{command or condition that reproduces the issue}}
- **Observed**: {{what actually happened}}
- **Expected**: {{what should have happened}}
- **Impact**: {{effect on dogfood run and workflow correctness}}
- **Status**: open / fixed in {{commit}} / deferred

---

## Recommendations

### P0 — Blocking (must fix before next run)

- [ ] {{item}}

### P1 — High (materially degrades run quality)

- [ ] {{item}}

### P2 — Medium (optimization or cleanup)

- [ ] {{item}}

### P3 — Low (future consideration)

- [ ] {{item}}
