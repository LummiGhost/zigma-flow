# DogFood Report: Prompt Optimization Bundle (2026-06-22)

Run ID: `20260622-0002`
Script: `tools/run-dogfood.ps1`
Generator: Auto-step artifact copying (PR #73)

## Overview

This bundle was produced by the dogfood automation script (`tools/run-dogfood.ps1`)
which runs the full `code-change` workflow end-to-end and captures all step
artifacts for review.  Each workflow step — both Agent and Auto (script/check) —
has its artifacts copied into a dedicated folder under `steps/`.

## Step Artifact Folders

### Agent Steps

Agent step folders contain the prompt that was sent to the AI model and the
structured report it produced.

| Folder | Workflow Job/Step | Contents |
|---|---|---|
| `01-intake/` | `intake/analyze` | `prompt.md`, `prompt-packet/`, `report.json` |
| `02-code-map/` | `code-map/map` | `prompt.md`, `prompt-packet/`, `report.json` |
| `04-plan/` | `plan/plan` | `prompt.md`, `prompt-packet/`, `report.json` |
| `04b-arch-design/` | `architecture-design/design` (optional) | `prompt.md`, `prompt-packet/`, `report.json` |
| `05a-implement/` | `implement/implement` | `prompt.md`, `prompt-packet/`, `report.json` |
| `07-review/` | `review/review` | `prompt.md`, `prompt-packet/`, `report.json` |
| `08-summarize/` | `summarize/summarize` | `prompt.md`, `prompt-packet/`, `report.json` |

### Auto (Script/Check) Steps

Auto step folders contain deterministic tool output: stdout, stderr, structured
results, and any additional artifacts the step produced.

| Folder | Workflow Job/Step | Contents |
|---|---|---|
| `03-risk-scan/` | `risk-scan/validate-report` | `stdout.txt`, `stderr.txt`, `result.json`, `check-result.json` |
| `05b-collect-diff/` | `implement/collect-diff` | `stdout.txt`, `stderr.txt`, `result.json` |
| `06a-static-check/` | `static-check/check` | `stdout.txt`, `stderr.txt`, `result.json`, `check-result.json` |
| `06b-unit-test/` | `unit-test/test` | `stdout.txt`, `stderr.txt`, `result.json`, `check-result.json` |

## Artifact File Descriptions

### Prompt Packet (`prompt-packet/`)

For Agent steps, the prompt-packet directory contains the rendered template
fragments that were assembled into the final prompt.  These files are generated
by the Prompt Builder and include:

- Template blocks from the applicable Skill Pack prompt files
- Context bundle sections (knowledge, functions, permissions)
- Step-specific instructions and output schema

### Report Files

| File | Description |
|---|---|
| `report.json` | Agent step report; contains structured outputs per the step's schema |
| `result.json` | Script/Check step result; contains exit code, duration, and structured output |
| `check-result.json` | Check step gate verdict (`pass`/`fail`) with evidence |

### Standard Streams

| File | Description |
|---|---|
| `stdout.txt` | Standard output from a script or check command |
| `stderr.txt` | Standard error from a script or check command |

## Usage

To reproduce this bundle:

```powershell
# Full run (requires DeepSeek backend module):
.\tools\run-dogfood.ps1

# Inspect prompts and run CLI steps only (no Claude invocation):
.\tools\run-dogfood.ps1 -SkipAgent

# Dry run (no state mutation, no Claude):
.\tools\run-dogfood.ps1 -DryRun

# Custom run ID:
.\tools\run-dogfood.ps1 -RunId "20260622-0003"

# Custom output directory:
.\tools\run-dogfood.ps1 -TempStepsDir "C:\tmp\my-bundle\steps"
```
