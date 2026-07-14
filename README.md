# Zigma Flow -- Agent Workflow Runtime

A local, single-process TypeScript CLI that orchestrates multi-job workflows for Agent-assisted software development. It breaks complex tasks into discrete, auditable steps so an AI agent (like Claude Code) only handles one step at a time, preventing context overload and skipped gates.

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [CLI Commands](#cli-commands)
- [code-change Workflow](#code-change-workflow)
- [Customizing the Workflow](#customizing-the-workflow)
- [Development](#development)

---

## Quick Start

1. **Install zigma-flow globally:**

   ```bash
   npm install -g @zigma-ai/zigma-flow
   ```

2. **Navigate to your project** (or a fresh directory):

   ```bash
   cd my-project
   ```

3. **Initialize zigma-flow:**

   ```bash
   zigma-flow init
   ```

   This creates `.zigma-flow/` with a default `code-change` workflow, Skill Pack
   prompts, and configuration. See the [init reference](./docs/phases/v0.4-productization/workflows/wf-init/01-cases-and-tests.md)
   for how init detects your project's package manager and scripts.

4. **Validate the generated workflow:**

   ```bash
   zigma-flow validate .zigma-flow/workflows/code-change.yml
   ```

   Expected output: `Workflow is valid.`

5. **Try a fully automated run:**

   ```bash
   zigma-flow run-all code-change --task "Add null check to parse function"
   ```

   The engine drives every job -- agent steps, script steps, and checks --
   automatically, writing results to `.zigma-flow/runs/`.

6. **Check the run status:**

   ```bash
   zigma-flow status
   ```

   Shows the current state of the latest run (completed, running, or failed).

7. **Explore the example project** in [`examples/basic-code-change/`](./examples/basic-code-change/).
   It includes a pre-initialized `.zigma-flow/` directory, a TypeScript source
   file, and matching tests -- a concrete reference for your own project setup.

> **Package managers:** This project uses **pnpm** for its own development (see
> [Development](#development)). The `init` command auto-detects your project's
> lockfile and generates script steps (typecheck, lint, test) that use your
> project's own package manager. `npm`, `yarn`, and `bun` are all supported.

---

## How It Works

A **workflow** is a DAG of **jobs**. Each job contains one or more **steps**, which are the smallest execution units. Steps come in four kinds: **Agent steps** (require LLM judgment), **Script steps** (shell commands), **Check steps** (deterministic validation), and **Router steps** (conditional branching). The workflow YAML lives in `.zigma-flow/workflows/` and is read by the Engine at runtime.

The Engine owns all state transitions. Agents cannot directly modify workflow state; they can only emit **signals** in their `report.json`. The Engine evaluates signals against declared rules and decides whether to activate an optional job, retry a previous job, or continue normally. All state changes are written to an event log under `.zigma-flow/runs/`, making every run auditable and replayable.

For a visual walkthrough, see the [getting-started tutorial](docs/getting-started.md) (coming soon).

---

## CLI Commands

| Command | Purpose |
|---------|---------|
| `init` | Initialize `.zigma-flow/` scaffold in the current directory |
| `validate <path>` | Validate a workflow YAML or Skill Pack manifest |
| `run <workflow> --task <description>` | Create a new workflow run |
| `run-all <workflow> --task <description>` | Fully automated execution (create run, loop through jobs) |
| `run-all <workflow> --resume <run-id>` | Resume an interrupted run |
| `status` | Show current run status (latest run by default) |
| `prompt --job <id>` | Generate the agent prompt for a job's current step |
| `step --job <id>` | Execute a script, check, or router step automatically |
| `next --job <id>` | Accept the agent report and advance the run to the next step |
| `retry --job <id>` | Retry a failed job |
| `abort` | Abort the current run |
| `approve --job <id>` | Approve a manual gate (e.g., `gate-merge`) |
| `reject --job <id> --comment <msg>` | Reject a manual gate with a reason |
| `list-runs` | List all runs |
| `show <run-id>` | Show detailed run information |
| `artifacts <run-id>` | List artifacts produced by a run |
| `events <run-id>` | List events recorded during a run |
| `doctor` | Diagnose common environment and configuration issues |
| `check` | Run Skill Pack checks against the project |
| `skill-add <name> [source]` | Add a Skill Pack to the project |

For a complete reference of every subcommand and its options, see the
workflow language reference at [docs/workflow-language.md](./docs/workflow-language.md)
and the [error code reference](./docs/error-codes.md).

---

## code-change Workflow

The built-in `code-change` workflow covers the full lifecycle of a code change:
from understanding the task through implementation, validation, and review.

```
intake
  └── code-map
        └── risk-scan
              └── plan
                    ├── architecture-design [optional, signals]
                    └── implement (optional_needs: architecture-design)
                          ├── static-check
                          ├── unit-test
                          └── review
                                └── summarize
```

| Job | Kind | Description |
|-----|------|-------------|
| `intake` | Agent | Analyze the task description; produce an intake-summary artifact |
| `code-map` | Agent | Map relevant files and modules; produce a code-map artifact |
| `risk-scan` | Check | Validate that the code-map artifact exists and is well-formed |
| `plan` | Agent | Create an implementation plan; may emit `needs_architecture_design` |
| `architecture-design` | Agent | Produce architecture design (optional; activated by signal) |
| `implement` | Agent | Implement the change; up to 3 retry attempts |
| `static-check` | Script | Run typecheck and lint (`pnpm typecheck && pnpm lint` by default) |
| `unit-test` | Script | Run the test suite (`pnpm test:ci` by default) |
| `review` | Agent | Review the implementation; may emit `review_rejected` |
| `gate-merge` | Human | Manual approval gate before final merge (optional) |
| `summarize` | Agent | Produce a final change summary artifact |

### Signals

- `needs_architecture_design` -- emitted by `plan` or `review`. The Engine activates the optional `architecture-design` job, which `implement` waits for before starting.
- `review_rejected` -- emitted by `review`. The Engine retries the `implement` job (up to 3 total attempts). If attempts are exhausted, the run fails.

### Agent Backend Configuration

The agent backend (default: `claude-code`) is configured in `.zigma-flow/config.json`:

```json
{
  "tool_version": "0.3.6",
  "active_run": null,
  "agent": {
    "backend": "claude-code",
    "backends": {
      "claude-code": {
        "command": "claude",
        "args": ["-p"],
        "timeout": 600000
      }
    },
    "parallelism": 4
  }
}
```

Parallelism controls how many read-only jobs run concurrently during
`run-all`. Set `agent.parallelism` in the config or pass `--parallelism <N>`
on the command line. The default is 4. Use `--parallelism 1` for strictly
sequential execution.

For advanced execution semantics, see the
[concurrency model documentation](./docs/architecture.md#74-concurrency-model).

---

## Customizing the Workflow

After `zigma-flow init`, edit `.zigma-flow/workflows/code-change.yml` to:

- Add new jobs by declaring them under `jobs:` and setting `needs:` dependencies.
- Change retry limits by updating `retry.max_attempts` on a job.
- Add new signals by declaring them under `signals:` with an `action`.
- Update script steps if your project uses different validation commands.
  The generated defaults use your detected package manager. The `static-check`
  and `unit-test` jobs can be changed to run custom scripts, lint rules, or
  test frameworks.

Skill Pack prompts and knowledge files live in `.zigma-flow/skills/code-change/`
and can be edited to match your project's conventions. See
[custom-workflow tutorial](docs/custom-workflow.md) and
[skill-pack-authoring tutorial](docs/skill-pack-authoring.md) (both coming
soon) for detailed guidance.

---

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Requirements: Node >= 20.11.0, pnpm 10+.

### Project Layout

- `src/` -- TypeScript source files (CLI entry point, Engine, init, etc.)
- `tests/` -- Vitest test suite
- `examples/` -- Runnable example projects
- `docs/` -- Architecture, contracts, error codes, and wiki documentation
  - [docs/architecture.md](./docs/architecture.md) -- System design and module boundaries
  - [docs/mvp-contracts.md](./docs/mvp-contracts.md) -- MVP execution contracts
  - [docs/error-codes.md](./docs/error-codes.md) -- Stable exit code reference
  - [docs/wiki/](./docs/wiki/) -- Chinese-language wiki (existing reference)
- `.zigma-flow/` -- The project's own workflow configuration (dogfooding)
