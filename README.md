# Zigma Flow — Agent Workflow Runtime

A local, single-process TypeScript CLI that orchestrates multi-job workflows for Agent-assisted software development. It breaks complex tasks into discrete, auditable steps so an AI agent (like Claude Code) only handles one step at a time, preventing context overload and skipped gates.

## Quick Start

```bash
# Install (or use a local path)
npm install -g zigma-flow

# Initialize a project
cd my-project
zigma-flow init

# Validate the generated workflow
zigma-flow validate .zigma-flow/workflows/code-change.yml

# Start a run
zigma-flow run code-change --task "Add null check to parse function in src/parser.ts"

# Check status
zigma-flow status
```

## How It Works

A **workflow** is a DAG of **jobs**. Each job contains one or more **steps**, which are the smallest execution units. Steps come in four kinds: Agent steps (require LLM judgment), Script steps (shell commands), Check steps (deterministic validation), and Router steps (conditional branching). The workflow YAML lives in `.zigma-flow/workflows/` and is read by the Engine at runtime.

When a job becomes ready, the Engine determines what kind of step to run next. For **Agent steps**, you generate a prompt with `zigma-flow prompt --job <id>`, paste it into your AI agent (e.g. Claude Code), and the agent writes a structured `report.json` to the artifact path shown in the prompt output. You then run `zigma-flow next --job <id>` to have the Engine read the report, validate it, process any signals, and advance the run. For **Script and Check steps**, `zigma-flow step --job <id>` runs the step automatically — no agent involvement needed.

The Engine owns all state transitions. Agents cannot directly modify workflow state; they can only emit **signals** in their `report.json`. The Engine evaluates signals against declared rules and decides whether to activate an optional job, retry a previous job, or continue normally. All state changes are written to an event log under `.zigma-flow/runs/`, making every run auditable and replayable.

## CLI Commands

| Command | Purpose |
|---------|---------|
| `init` | Initialize `.zigma-flow/` scaffold in the current directory |
| `validate <path>` | Validate a workflow YAML or Skill Pack manifest |
| `run <workflow> --task <description>` | Create a new workflow run |
| `status` | Show current run status (latest run by default) |
| `prompt --job <id>` | Generate the agent prompt for a job's current step |
| `step --job <id>` | Execute a script, check, or router step automatically |
| `next --job <id>` | Accept the agent report and advance the run to the next step |
| `run-all <workflow> --task <description>` | Automate full workflow execution (create run → loop through jobs) |
| `run-all <workflow> --resume <run-id>` | Resume an existing run from where it left off |

### `run-all` — Fully Automated Execution (v0.2)

The `run-all` command drives a workflow run from creation to completion without manual prompt/next steps. The Engine loops through ready jobs, invoking the configured agent backend for agent steps and executing script/check/router steps directly.

**New run:**
```bash
zigma-flow run-all code-change --task "Add null check to parse function"
```

**Resume an interrupted run:**
```bash
zigma-flow run-all code-change --resume <run-id>
```

`--resume` reads the existing run state and continues from the last incomplete step. It rejects runs that are already in a terminal state (completed/failed/blocked/cancelled). `--resume` and `--task` are mutually exclusive.

**Agent backend configuration** lives in `.zigma-flow/config.json`:
```json
{
  "agent": {
    "backend": "claude-code",
    "backends": {
      "claude-code": {
        "command": "claude",
        "args": ["-p"],
        "timeout": 600000
      }
    }
  }
}
```

During execution, the Engine emits agent lifecycle events (`agent_invoked`, `agent_completed`, etc.) and registers backend stdout/stderr as artifacts for auditability. Failed agent steps are retried according to the job's `retry` configuration; configuration errors (backend not found, not logged in) skip retry and fail the run immediately.

## 并发执行 (Concurrent Execution, v0.2)

`run-all` dispatches read-only jobs concurrently to reduce wall-clock time. Writable jobs (where `workspace.mode` is `"writable"` or not set) are always serialized — at most one writable job runs at a time. This ensures workspace safety while maximizing throughput for independent analysis jobs.

**Parallelism control:**
```bash
# Run with the default parallelism (4)
zigma-flow run-all code-change --task "Add null check to parse function"

# Override parallelism — at most N jobs run simultaneously
zigma-flow run-all code-change --task "..." --parallelism 2

# Disable concurrency entirely (sequential execution)
zigma-flow run-all code-change --task "..." --parallelism 1
```

When `--parallelism` is not specified, the engine checks `.zigma-flow/config.json` for `agent.parallelism`:
```json
{
  "agent": {
    "parallelism": 4,
    "backend": "claude-code",
    "backends": { ... }
  }
}
```

If neither the CLI flag nor the config file specifies a value, the default is **4**.

**Fail-fast mode:**
```bash
# Stop all jobs in the batch if any single job fails
zigma-flow run-all code-change --task "..." --fail-fast
```

By default `--fail-fast` is `false`: a failed job does not abort peer jobs in the same batch. The failing job enters retry or failure; other jobs continue normally. In CI or time-sensitive scenarios, enable `--fail-fast` to abort the batch immediately on first failure.

**Batch execution loop:**

```text
Loop iteration:
  1. Scheduler (pure function) selects an executable batch:
     - Collect ready read-only jobs, limited by parallelism
     - If no writable is running and slots remain, add 1 writable job
  2. Dispatch all batch jobs concurrently via Promise.allSettled
     - Each job runs its current step independently
     - State writes are serialized per-runDir via AsyncQueue
  3. Post-batch: re-read state snapshot for next iteration
  4. Repeat until terminal state or no jobs remain
```

See [docs/architecture.md §7.4](./docs/architecture.md#74-concurrency-model) for the full concurrency model.

## code-change Workflow

The built-in `code-change` workflow covers the full lifecycle of a code change, from understanding the task to a final review.

```
intake → code-map → risk-scan → plan ─┬─ [architecture-design?]
                                       │
                                       └─ implement → static-check ─┐
                                                   → unit-test ─────┴→ review → summarize
```

| Job | Kind | Description |
|-----|------|-------------|
| `intake` | Agent | Analyze the task description; produce an intake-summary artifact |
| `code-map` | Agent | Map relevant files and modules; produce a code-map artifact |
| `risk-scan` | Check | Validate that the code-map artifact exists and is well-formed |
| `plan` | Agent | Create an implementation plan; may emit `needs_architecture_design` |
| `architecture-design` | Agent | Produce architecture artifact (optional; activated by signal) |
| `implement` | Agent | Implement the change; up to 3 retry attempts |
| `static-check` | Script | Run typecheck and lint (`pnpm typecheck && pnpm lint` by default) |
| `unit-test` | Script | Run the test suite (`pnpm test:ci` by default) |
| `review` | Agent | Review the implementation; may emit `review_rejected` |
| `summarize` | Agent | Produce a final change summary artifact |

**Signals:**

- `needs_architecture_design` — emitted by `plan` or `review`. The Engine activates the optional `architecture-design` job, which `implement` will wait for before starting.
- `review_rejected` — emitted by `review`. The Engine retries the `implement` job (up to 3 total attempts). If attempts are exhausted, the run fails.

## Typical Workflow Session

```bash
# 1. Start the run
zigma-flow run code-change --task "Add null check to parse function in src/parser.ts"

# 2. Check which job is ready
zigma-flow status

# 3. Generate the prompt for the intake job
zigma-flow prompt --job intake
# Output includes the artifact path where report.json must be written,
# e.g. .zigma-flow/runs/<run-id>/jobs/intake/attempts/1/steps/analyze/report.json

# 4. Paste the prompt into Claude Code (or another agent).
#    The agent reads context, does its work, and writes report.json to the shown path.

# 5. Accept the report and advance
zigma-flow next --job intake

# 6. Repeat for code-map and plan (both Agent steps)
zigma-flow prompt --job code-map
zigma-flow next --job code-map

zigma-flow prompt --job plan
zigma-flow next --job plan

# 7. risk-scan is a Check step — run it automatically
zigma-flow step --job risk-scan

# 8. Continue through implement, then run the script steps
zigma-flow prompt --job implement
zigma-flow next --job implement

zigma-flow step --job static-check
zigma-flow step --job unit-test

# 9. Review — agent may emit review_rejected to trigger a retry of implement
zigma-flow prompt --job review
zigma-flow next --job review

# 10. Final summary
zigma-flow prompt --job summarize
zigma-flow next --job summarize

# Run is complete
zigma-flow status
```

The artifact path for each `report.json` is printed by `zigma-flow prompt`. The agent must write its output to exactly that path before you run `next`.

## Customizing the Workflow

After `zigma-flow init`, edit `.zigma-flow/workflows/code-change.yml` to:

- Add new jobs by declaring them under `jobs:` and setting `needs:` dependencies
- Change retry limits by updating `retry.max_attempts` on a job
- Add new signals by declaring them under `signals:` with an `action`
- Update script steps if your project uses different validation commands; the generated defaults are `pnpm typecheck && pnpm lint` and `pnpm test:ci`

Skill Pack prompts and knowledge files live in `.zigma-flow/skills/code-change/` and can be edited to match your project's conventions.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Requirements: Node >= 20.11.0, pnpm 10+.
