---
workflow: WF-P13-BACKEND-CONFIG
title: Backend Configuration — Use Cases and Test Plan
status: proposed
date: 2026-06-27
target: AD-P13-008
references:
  - docs/phases/p13-agent-adapter-hardening/02-development-plan.md §5 WF-P13-BACKEND-CONFIG
  - docs/mvp-contracts.md §2.5
  - docs/prd.md §24
---

# WF-P13-BACKEND-CONFIG — Use Cases and Test Plan

## 1. Summary

`src/agent/config.ts` extracts the agent configuration-loading and backend
resolution logic from `src/commands/run-all.ts` into a dedicated Engine module.
This allows the same configuration logic to be reused by `commands/step.ts`,
`commands/next.ts`, and the P14 concurrent executor.

The module exports:

- `loadAgentConfig(zigmaflowDir): Promise<AgentConfig>` — reads `.zigma-flow/config.json` agent section
- `resolveBackendForStep(agentConfig, stepDef, cliOverride): { name, config }` — resolves the final backend config considering step-level overrides
- `createBackend(name, config): AgentBackend` — factory function that creates a backend instance

Additionally, `ClaudeCodeBackend` gains error classification: command not found
maps to `ConfigError` with install suggestion, 401/not-logged-in maps to
`PermissionError`, and rate-limit detection produces a distinct error category.

## 2. Use Case Enumeration

| ID | Title | Trigger | Expected Outcome |
|---|---|---|---|
| UC-CONFIG-001 | Load default agent config when config.json is missing | `config.json` file does not exist | Returns `{ backend: "claude-code", backends: {} }` |
| UC-CONFIG-002 | Load agent config from config.json | `config.json` has `agent` section with backends | Parsed `AgentConfig` matches JSON structure |
| UC-CONFIG-003 | Load agent config when config.json has no agent section | `config.json` exists but `agent` key is absent | Returns `{ backend: "claude-code", backends: {} }` (default) |
| UC-CONFIG-004 | Load agent config with invalid JSON | `config.json` contains malformed JSON | Returns default config gracefully (no crash) |
| UC-CONFIG-005 | Step-level backend override | Step declares `backend: "otherai"` in workflow YAML | `resolveBackendForStep` returns the step-level backend, not the global default |
| UC-CONFIG-006 | Step-level timeout override | Step declares `timeout: 300000` in backend config | Backend config resolves with step-level timeout, not global |
| UC-CONFIG-007 | CLI backend override takes precedence | `--backend otherai` passed to CLI | `resolveBackendForStep` receives `cliOverride` and it wins over both global and step-level |
| UC-CONFIG-008 | Backend not found in config | Backend name not in `backends` map | `ConfigError` with available backends listed and suggestion |
| UC-CONFIG-009 | Claude Code backend: command not found | `claude` binary is not on PATH | `ConfigError` with suggestion "install claude CLI or check PATH" |
| UC-CONFIG-010 | Claude Code backend: not logged in / 401 | Claude returns exit code indicating auth failure | `PermissionError` with suggestion to run `claude login` |
| UC-CONFIG-011 | Claude Code backend: rate limited | Claude stderr or exit code indicates rate limit | Error classified as retryable (not ConfigError), with suggestion to wait |
| UC-CONFIG-012 | createBackend uses agentFactory | Valid backend name and config | Returns an `AgentBackend` instance; ClaudeCodeBackend for default |
| UC-CONFIG-013 | Config respects timeout from config.json | `config.json` has `backends.claude-code.timeout: 300000` | Backend is created with timeout=300000 |

## 3. Functional Point Coverage Matrix

| FP ID | Description | UC Coverage | Test Case ID |
|---|---|---|---|
| FP-CONFIG-LOAD-DEFAULT | Returns default config when no config.json | UC-CONFIG-001 | T-CONFIG-1 |
| FP-CONFIG-LOAD-PARSED | Parses agent section from config.json | UC-CONFIG-002 | T-CONFIG-2 |
| FP-CONFIG-LOAD-MISSING-AGENT | Falls back to default when agent key missing | UC-CONFIG-003 | T-CONFIG-3 |
| FP-CONFIG-LOAD-INVALID-JSON | Handles malformed JSON gracefully | UC-CONFIG-004 | T-CONFIG-4 |
| FP-CONFIG-RESOLVE-STEP-OVERRIDE | Step-level backend name overrides global default | UC-CONFIG-005 | T-CONFIG-5 |
| FP-CONFIG-RESOLVE-TIMEOUT-OVERRIDE | Step-level timeout overrides global timeout | UC-CONFIG-006 | T-CONFIG-6 |
| FP-CONFIG-RESOLVE-CLI-OVERRIDE | CLI `--backend` flag takes highest precedence | UC-CONFIG-007 | T-CONFIG-7 |
| FP-CONFIG-RESOLVE-NOT-FOUND | Throws ConfigError for unknown backend | UC-CONFIG-008 | T-CONFIG-8, T-CONFIG-5 (step override to unknown) |
| FP-CONFIG-CREATE-BACKEND | createBackend returns AgentBackend instance | UC-CONFIG-012 | T-CONFIG-9 |
| FP-CONFIG-ERROR-CLASSIFY-CMD | ClaudeCodeBackend classifies command-not-found as ConfigError | UC-CONFIG-009 | T-CONFIG-10 |
| FP-CONFIG-ERROR-CLASSIFY-AUTH | ClaudeCodeBackend classifies auth failure as PermissionError | UC-CONFIG-010 | T-CONFIG-11 |
| FP-CONFIG-ERROR-CLASSIFY-RATE | ClaudeCodeBackend classifies rate limit as retryable error | UC-CONFIG-011 | T-CONFIG-12 |
| FP-CONFIG-TIMEOUT-FROM-CONFIG | Timeout from config.json is applied | UC-CONFIG-013 | T-CONFIG-13 |

## 4. Spec Compliance Matrix

| ADR / Contract | Requirement | Evidence |
|---|---|---|
| AD-P13-008 §1 | `loadAgentConfig` reads from `.zigma-flow/config.json` | T-CONFIG-1 through T-CONFIG-4 test all config loading paths |
| AD-P13-008 §2 | `resolveBackendForStep` accepts `stepDef`, `cliOverride` | T-CONFIG-5 through T-CONFIG-8 test override precedence |
| AD-P13-008 §3 | `createBackend` returns `AgentBackend` | T-CONFIG-9 asserts instanceof check |
| AD-P13-008 §4 | ClaudeCodeBackend classifies errors (command not found, 401, rate limit) | T-CONFIG-10 through T-CONFIG-12 |
| mvp-contracts §2.5 | Backend config is separate from workflow definition | Config lives in .zigma-flow/config.json, not in workflow YAML |
| mvp-contracts §2.6 | Agent backend lifecycle events | Error classification feeds into ConfigError/PermissionError which bypass retry (AD-P13-004 §5) |

## 5. Test Plan

### Test File: `tests/agent/config.test.ts`

| Test Case ID | Description | Method |
|---|---|---|
| T-CONFIG-1 | loadAgentConfig returns default when config.json missing | Point `loadAgentConfig` at temp dir without config.json; assert default `{ backend: "claude-code", backends: {} }` |
| T-CONFIG-2 | loadAgentConfig parses agent section from config.json | Write config.json with agent section; assert parsed result matches |
| T-CONFIG-3 | loadAgentConfig falls back when agent key missing | Write config.json without agent key; assert default returned |
| T-CONFIG-4 | loadAgentConfig handles invalid JSON | Write malformed JSON to config.json; assert default returned (no throw) |
| T-CONFIG-5 | resolveBackendForStep: step-level backend override | Pass stepDef with `backend: "otherai"`, agentConfig has both default and otherai; assert returned backend name is "otherai" |
| T-CONFIG-6 | resolveBackendForStep: step-level timeout override | Step-level config has timeout; assert returned config.timeout matches step-level value |
| T-CONFIG-7 | resolveBackendForStep: CLI override wins | Pass `cliOverride: "claude-code"` when step has `backend: "otherai"`; assert returned backend is "claude-code" |
| T-CONFIG-8 | resolveBackendForStep: unknown backend throws ConfigError | Step or override references backend not in config; assert ConfigError with suggestion |
| T-CONFIG-9 | createBackend returns AgentBackend instance | Call createBackend("claude-code", { command: "claude" }); assert result has `name`, `execute` method |
| T-CONFIG-10 | ClaudeCodeBackend: command not found → ConfigError | Mock execa to throw ENOENT; assert result is failure with ConfigError suggestion text |
| T-CONFIG-11 | ClaudeCodeBackend: not logged in → PermissionError | Mock execa to throw with auth error message; assert result includes PermissionError classification |
| T-CONFIG-12 | ClaudeCodeBackend: rate limited → retryable error | Mock execa to throw with rate limit message; assert result is failure but NOT classified as ConfigError/PermissionError |
| T-CONFIG-13 | createBackend respects timeout from config | Pass `{ command: "claude", timeout: 300000 }`; assert backend instance has timeout=300000 |

### Test Strategy

- **Direct imports**: Unlike the engine tests, `config.test.ts` imports the module directly from `../../src/agent/config.js`. The functions being tested are straightforward unit-level exports.
- **Temp directories**: Use `tmpdir()` + `randomUUID()` for isolated config files (same pattern as other tests).
- **ClaudeCodeBackend error classification**: Test by spying on or mocking `execa`. The classification logic lives in the `catch` block of `ClaudeCodeBackend.execute`. We can test it by instantiating a `ClaudeCodeBackend` and observing error categories.

### Fixtures Needed

- Various `config.json` fixtures with different agent sections
- Workflow YAML fragments with step-level `backend` and `timeout` declarations
