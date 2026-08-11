---
name: zigma-flow
description: Design efficient Zigma Flow workflow YAML and operate auditable runs. Apply when an agent needs to create or revise a workflow, validate its DAG and contracts, invoke or resume a run, or inspect workflow evidence.
---

# Zigma Flow

Design the workflow before running it. Put orchestration, gates, retries, and state transitions in workflow YAML; keep each Agent focused on the judgment required by its current Step.

## Design an efficient workflow

### 1. Freeze the execution contract

Before writing YAML, state:

- the outcome the workflow must produce;
- required named `inputs`;
- final outputs and evidence;
- deterministic validation commands;
- decisions that require an Agent or human;
- failure, retry, and iteration limits.

Create one workflow for one coherent outcome. Split unrelated outcomes into separate workflows instead of adding modes and branches to a single file.

### 2. Build the smallest useful DAG

Use a Job when work needs its own dependency boundary, retry policy, workspace permission, parallel scheduling, or auditable output. Keep tightly coupled sequential actions as Steps in the same Job.

- Add `needs` only for real data or ordering dependencies.
- Keep the critical path short.
- Run independent read-only analysis or verification Jobs in parallel.
- Keep writable work in one clearly owned Job when possible.
- Do not create a Job for every command or a single oversized Job for the whole task.
- Use explicit, stable lowercase IDs that describe outcomes, such as `plan`, `implement`, and `unit-test`.

### 3. Choose the cheapest correct Step

- Use `type: script` for builds, tests, linting, file checks, and other deterministic commands.
- Use `type: agent` only for interpretation, planning, editing, review, or synthesis that requires model judgment.
- Use `type: human` for decisions that require accountable approval or external input.
- Avoid deprecated control flow in new workflows. Prefer DAG dependencies, Job `retry`, `failure_policy`, and bounded `job_groups.repeat`.
- Do not use reserved Step types whose runtime is not implemented.

Moving deterministic work out of Agent prompts improves speed, cost, repeatability, and auditability.

### 4. Minimize Agent context

For every Agent Step:

- write a narrow primary `prompt` describing only the current responsibility;
- pass only required values through `with`;
- declare structured `outputs` consumed by later Jobs;
- expose only the Skill Pack aliases needed by this Step;
- pass large logs, diffs, and reports as artifacts instead of embedding them in prompts;
- use `${{ inputs.<key> }}` and `${{ jobs.<id>.outputs.<key> }}` rather than copying context manually.

Make output keys specific enough to form a stable contract. A downstream Job should depend on structured outputs or artifacts, not on prose hidden in a previous conversation.

### 5. Make failure behavior explicit

- Set `failure_policy` according to whether failure must stop, continue with warnings, or block for intervention.
- Retry only failures that can plausibly succeed on another Attempt. Use a small `max_attempts` and a `when` whitelist for transient FailureKinds.
- Use `job_groups.repeat` only for genuine multi-Job feedback loops.
- Always bound repeat loops with `max_iterations`.
- Write `until` against a structured Job output. If a declared `until` never passes, the Run fails closed and downstream Jobs remain waiting.
- Preserve prior Attempt and Iteration evidence; never emulate retry by resetting state files.

### 6. Apply least privilege

Default Jobs to read-only access. Grant writable workspace access only to Jobs that must modify project files. Engine owns state transitions; Agent, Script, and Human Steps submit results or decisions rather than writing state directly.

### 7. Validate the design

After writing or changing a workflow:

```text
zigma-flow validate .zigma-flow/workflows/<workflow>.yml
zigma-flow invoke <workflow> --task "contract check" --dry-run
```

Fix schema errors, missing references, DAG cycles, unsupported expressions, and deprecated-field warnings before a real run. Re-read the YAML and verify:

- every input is declared and used;
- every `needs` edge is necessary;
- each deterministic check is a Script Step;
- Agent prompts and exposed Skills are minimal;
- outputs required downstream are declared;
- writable Jobs cannot overlap unsafely;
- retries and iterations have hard bounds;
- the final Job produces the promised evidence.

## Compact pattern

```yaml
name: focused-change
version: 1.0.0

on:
  manual:

inputs:
  task:
    type: string
    required: true

skills:
  code:
    uses: skill://zigma.code-change@1

permissions:
  contents: read
  edits: write
  commands: none
  workflow_state: none

jobs:
  plan:
    workspace:
      mode: read-only
    steps:
      - id: plan
        type: agent
        prompt: plan
        with:
          task: "${{ inputs.task }}"
        outputs:
          plan: {}
        expose:
          skills: [code]

  implement:
    needs: [plan]
    retry:
      max_attempts: 2
      when: [infrastructure_error, agent_error]
      on_exceeded:
        status: failed
    steps:
      - id: implement
        type: agent
        prompt: implement
        with:
          task: "${{ inputs.task }}"
          plan: "${{ jobs.plan.outputs.plan }}"
        expose:
          skills: [code]

  typecheck:
    needs: [implement]
    workspace:
      mode: read-only
    steps:
      - id: typecheck
        type: script
        run: "pnpm typecheck"
        timeout: 5m

  unit-test:
    needs: [implement]
    workspace:
      mode: read-only
    steps:
      - id: test
        type: script
        run: "pnpm test:ci"
        timeout: 10m

  summarize:
    needs: [typecheck, unit-test]
    workspace:
      mode: read-only
    steps:
      - id: summarize
        type: agent
        prompt: summarize
        with:
          task: "${{ inputs.task }}"
        expose:
          skills: [code]
```

The two validation Jobs run in parallel because they share only the `implement` dependency. The workflow uses Agents for judgment and editing, Scripts for deterministic evidence, and the DAG for orchestration.

## Operate the run

Invoke with all required inputs and keep the returned run ID:

```text
zigma-flow invoke <workflow> --task "<task>" --input <key>=<value>
zigma-flow inspect <run-id> --jobs --events --artifacts
```

When paused, inspect the waiting Job and Step before using `resume`. Continue an interrupted automatic lifecycle with `zigma-flow invoke <workflow> --resume <run-id>`. Cancel through `zigma-flow abort`.

Report the run ID, final status, failed or completed Job and Attempt, validation results, relevant artifacts, and unresolved human decisions.

Never edit `.zigma-flow/runs/*/state.json` or `events.jsonl`. Use `zigma-flow <command> --help` as the installed-version authority when syntax differs from this guide.
