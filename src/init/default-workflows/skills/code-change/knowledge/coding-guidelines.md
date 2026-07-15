# Coding Guidelines

## General Principles

- Write clear, readable code with meaningful names for variables, functions, and types.
- Keep functions small and focused on a single responsibility.
- Prefer explicit over implicit: avoid magic numbers and unexplained side effects.
- Handle errors explicitly; never silently swallow exceptions.
- Use TypeScript's strict mode features to catch type errors at compile time.

## Code Style

- Use `const` by default; use `let` only when reassignment is necessary.
- Prefer `async/await` over raw Promises for asynchronous code.
- Import only what you need; avoid wildcard imports.
- Keep imports grouped: Node built-ins first, then external packages, then internal modules.

## Incremental Changes

- Make small, incremental changes rather than large rewrites. Each small step should
  compile, pass tests, and be independently reviewable before moving to the next.
- Prefer tight edit loops: modify one logical unit at a time, verify it works,
  then proceed. Avoid sweeping multi-file refactors in a single step.

## Testing

- Write tests alongside implementation; aim for high coverage on business logic.
- Use descriptive test names that explain the expected behavior.
- Test edge cases and failure paths, not just the happy path.

## State and Runtime File Restrictions

You must not modify any files under `.zigma-flow/`. You must not modify
`state.json`, `config.json`, `skill-lock.json`, or any other runtime
infrastructure file. These files are owned by the Zigma Flow runtime and must
never be changed by agent or script steps.

Do not modify the `.zigma-flow/runs/` directory or any of its contents.
Do not modify `.zigma-flow/state.json`. Violations are treated as forbidden
actions and will fail the step.
