# Dogfood Runbook — release-candidate v0.3.0

## Pre-Run Setup

```sh
cd D:\zigma\zigma-flow
pnpm build && node dist/cli.js --version

node dist/cli.js run .zigma-flow/workflows/release-candidate.yml \
  --input version="v0.X.Y" \
  --run-id dogfood-$(date +%Y%m%d)-release-candidate-0001
```

Output root: `docs/temp/dogfood-<date>-release-candidate/`

---

## Workflow DAG

```
scope-freeze → build ─┬─ typecheck ─┐
                      └─ unit ───────┴─ integration → smoke → release-notes → tag-readiness-gate
```

Parallel branches after `build`: `typecheck` and `unit` run concurrently; `integration` needs both.

Human gate at end: `tag-readiness-gate` blocks until approved.

---

## Step-by-Step Execution

### scope-freeze: document-scope (agent)

- **Task**: document scope for `${{ inputs.version }}` from git log and CHANGELOG.md
- **Outputs**: `scope_summary`, `known_risks`
- **Artifact**: `steps/scope-freeze/document-scope/report.json`
- **Watch for**:
  - `scope_summary` must list included PRs/commits and excluded items
  - `known_risks` must be present (even `[]`) — verify not omitted

### build: build (script)

- **Command**: `pnpm build`
- **Artifacts**: `steps/build/build/stdout.txt`, `stderr.txt`, `result.json`
- **Watch for**:
  - `result.json` must capture exit code
  - Build failure must block `typecheck` and `unit` (verify dependency enforcement)

### typecheck: typecheck (script)

- **Command**: `pnpm typecheck`
- **Artifacts**: `steps/typecheck/typecheck/stdout.txt`, `stderr.txt`, `result.json`
- **Watch for**:
  - Runs concurrently with `unit` — verify both start after `build` completes
  - Non-zero exit must block `integration`

### unit: unit-tests (script)

- **Command**: `pnpm test:ci`
- **Artifacts**: `steps/unit/unit-tests/stdout.txt`, `stderr.txt`, `result.json`
- **Watch for**:
  - Runs concurrently with `typecheck`
  - Failure must block `integration`

### integration: integration-tests (script)

- **Command**: `pnpm test:ci --reporter verbose`
- **Needs**: `unit` AND `typecheck` (both must pass)
- **Artifacts**: `steps/integration/integration-tests/stdout.txt`, `stderr.txt`, `result.json`
- **Watch for**:
  - Does not start until both `unit` and `typecheck` complete successfully
  - Verbose output should be captured fully in stdout.txt

### smoke: smoke-cli (check — zigma/file-exists)

- **Check**: `zigma/file-exists` on `dist/cli.js`
- **Artifact**: `steps/smoke/smoke-cli/check-result.json`
- **Watch for**:
  - `check-result.json` verdict must be `pass` when `dist/cli.js` exists
  - A missing `dist/cli.js` must produce `fail` and block `release-notes`

### release-notes: generate-notes (agent)

- **Task**: generate release notes for `${{ inputs.version }}` with PR/commit references
- **Outputs**: `release_notes`, `verification_log`
- **Artifact**: `steps/release-notes/generate-notes/report.json`
- **Watch for**:
  - Every item in `release_notes` must cite a commit hash or PR number
  - `verification_log` must reference script step artifact paths (not assert from memory)

### tag-readiness-gate: approve-release (human)

- **Approver**: LummiGhost
- **Timeout**: 1440 minutes (24 hours)
- **Advance**: `node dist/cli.js approve <run-id> tag-readiness-gate approve-release --decision approve`
- **Watch for**:
  - Workflow blocks here until explicit approval
  - Rejection must leave workflow in a terminal `blocked` state (not silently complete)
  - Prompt surfaces CI results and release notes — verify context is readable

---

## Observation Checklist

| # | Observation | Result |
|---|---|---|
| O1 | `scope_summary` lists included PRs/commits with identifiers | |
| O2 | `build` failure blocks both `typecheck` and `unit` | |
| O3 | `typecheck` and `unit` start concurrently after `build` passes | |
| O4 | `integration` waits for both `typecheck` and `unit` to pass | |
| O5 | `smoke` check produces `check-result.json` with `pass`/`fail` | |
| O6 | `release_notes` items cite commit or PR number | |
| O7 | `verification_log` references artifact paths (not memory claims) | |
| O8 | Human gate blocks until approval command is run | |
| O9 | `result.json` captured for all three script steps (build, typecheck, unit, integration) | |

---

## Known Issues

_None recorded. File issues here after each dogfood run._

---

## Post-Run

1. Copy `report-template.md` → `docs/temp/dogfood-<date>-release-candidate/dogfood-report.md`
2. Fill **Prompt Packet Index** (2 agent steps: scope-freeze, release-notes).
3. Fill **Artifact Index** (4 script steps: build, typecheck, unit, integration; 1 check: smoke).
4. Fill **Event Summary** — record parallel branch timing and human gate decision.
5. Record findings and file P0/P1 issues before closing.
