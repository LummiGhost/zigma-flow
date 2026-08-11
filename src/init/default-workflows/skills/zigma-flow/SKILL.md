---
name: zigma-flow
description: Use Zigma Flow to run auditable project workflows. Apply when a task should be executed through a workflow, when a run must be inspected or resumed, or when workflow evidence is needed.
---

# Zigma Flow

Delegate workflow state and progression to Zigma Flow. Work on the user task through the selected workflow; do not reproduce the workflow state machine in chat or edit runtime state by hand.

## Start a task

1. Work from the project root containing `.zigma-flow/`.
2. Select a workflow from `.zigma-flow/workflows/`. Use `code-change` for repository changes unless the user names another workflow.
3. Read the selected workflow's declared inputs and human gates.
4. Validate it before the first run:

   ```text
   zigma-flow validate .zigma-flow/workflows/<workflow>.yml
   ```

5. Invoke it with the user's task and all required named inputs:

   ```text
   zigma-flow invoke <workflow> --task "<task>" --input <key>=<value>
   ```

Use repeated `--input` flags when needed. Use `--dry-run` before execution when the user asks for a preview, and `--json` when another program will consume the result.

## Follow the run

Treat the run ID as the stable handle for all follow-up work. Inspect an explicit run whenever possible:

```text
zigma-flow inspect <run-id> --jobs --events --artifacts
```

Use `zigma-flow inspect --latest` only when the project has a single unambiguous latest run. Base status reports on persisted Job state, structured events, and artifacts rather than terminal text alone.

When a run is paused or interrupted:

- inspect the waiting Job and Step first;
- use `zigma-flow resume --help` and submit the requested Human Step decision through `resume`;
- use `zigma-flow invoke <workflow> --resume <run-id>` to continue an interrupted automatic lifecycle;
- use `zigma-flow abort` to cancel a run.

Never simulate resume, retry, completion, or cancellation by editing files.

## Report evidence

Report the minimum evidence needed to audit the result:

- run ID and final status;
- completed or failed Job, Step, and Attempt;
- relevant artifact paths;
- validation commands and outcomes;
- any unresolved human gate or blocker.

For failures, inspect the corresponding event and step artifacts before proposing a retry. Do not discard prior Attempt or Iteration evidence.

## Respect ownership

- Engine owns state transitions and writes `.zigma-flow/runs/*/state.json`.
- Events are append-only audit facts. Do not edit `events.jsonl`.
- Agent Steps submit structured reports and signals; they do not set Job or Run status directly.
- Script Steps and checks return deterministic results; Engine decides the transition.
- Workflow YAML and Skill Pack resources are project source and may be edited when the user requests customization.
- After editing a workflow or `skill.yml`, run `zigma-flow validate` again.

Use `zigma-flow <command> --help` as the installed-version authority when a command option differs from this guide.
