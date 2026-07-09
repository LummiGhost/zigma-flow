# basic-code-change

A minimal TypeScript project that demonstrates how to use the **zigma-flow**
`code-change` workflow to automate Agent-assisted code development.

This example is referenced by the [main README Quick Start](../../README.md#quick-start).
After completing the Quick Start, come back here to see a concrete project
that you can inspect, modify, and experiment with.

## What This Example Shows

- A small TypeScript project with `typecheck`, `lint`, and `test` scripts
  in `package.json` -- the three scripts that the `code-change` workflow's
  `static-check` and `unit-test` jobs expect.
- A pre-initialized `.zigma-flow/` directory with a complete workflow
  definition, Skill Pack, prompts, and checks.
- A simple source file (`src/index.ts`) and its matching test file
  (`src/index.test.ts`) that serve as targets for the `code-change`
  workflow.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20.11.0
- [pnpm](https://pnpm.io/) 10+ (or substitute your preferred package manager)
- zigma-flow installed globally (`npm install -g zigma-flow`)

## Next Steps

1. Browse `.zigma-flow/workflows/code-change.yml` to understand the workflow DAG.
2. Read the Skill Pack prompts under `.zigma-flow/skills/code-change/prompts/`.
3. Try running `zigma-flow validate` on the workflow file.
4. Follow the [getting-started tutorial](../../docs/getting-started.md) (Slice B)
   for a complete walkthrough.

## Project Structure

```
basic-code-change/
  package.json          # Project manifest with scripts
  tsconfig.json         # TypeScript configuration
  src/
    index.ts            # Hello-world source module
    index.test.ts       # Unit test for index.ts
  .zigma-flow/
    config.json         # Agent backend configuration
    skill-lock.json     # Resolved Skill Pack lockfile
    workflows/
      code-change.yml   # The code-change workflow definition
    skills/
      code-change/
        skill.yml       # Code-change Skill Pack manifest
        knowledge/      # Agent knowledge documents
        prompts/        # Agent prompt templates
        scripts/        # Script step definitions
        checks/         # Check step definitions
```
