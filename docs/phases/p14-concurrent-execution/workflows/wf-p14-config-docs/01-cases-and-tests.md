---
workflow: WF-P14-CONFIG-DOCS
phase: P14 Concurrent Read-Only Job Execution
step: 1 — Cases and Tests
authority: docs/phases/p14-concurrent-execution/02-development-plan.md §4 AD-P14-007, §5 WF-P14-CONFIG-DOCS
date: 2026-06-28
---

# WF-P14-CONFIG-DOCS — Cases and Tests

## 1. Slice Boundary Declaration

| Field | Value |
|---|---|
| **Slice name** | WF-P14-CONFIG-DOCS |
| **Bounded context** | Agent Configuration / Documentation |
| **User tasks** | Configure parallelism via `.zigma-flow/config.json`; understand concurrency from documentation |
| **Target new source** | `src/agent/config.ts` (extend existing) |
| **Files to modify** | `src/agent/config.ts`, `src/agent/index.ts`, `README.md`, `docs/architecture.md`, `CHANGELOG.md` |
| **New doc files** | This cases doc |
| **Predecessor** | WF-P14-RUN-ALL-CONCURRENT (consumes the parallelism config) |

**Scope:** Add `parallelism` to `AgentConfig`, add `getParallelism()` helper, add `DEFAULT_PARALLELISM` constant, and update all three documentation files (README, architecture, CHANGELOG). No runtime logic beyond the helper function.

## 2. Architecture Decision Reference

### AD-P14-007 — Default parallelism (from development plan §4)

> - CLI `--parallelism N` (≥1).
> - 未指定时：读 `.zigma-flow/config.json` 的 `agent.parallelism`。
> - 仍未指定时：默认 4。
> - 实际 batch size = min(parallelism, ready 队列长度)。
> - 上限不做强制，但建议文档中标注 Claude CLI 速率限制风险。

### AD-P14-007-derived API

```ts
export const DEFAULT_PARALLELISM = 4;

export interface AgentConfig {
  backend: string;
  backends: Record<string, AgentBackendConfigEntry>;
  parallelism?: number;                          // NEW
}

/** Resolve effective parallelism, defaulting to DEFAULT_PARALLELISM. */
export function getParallelism(agentConfig: AgentConfig): number;
```

**Configuration priority:**

1. CLI `--parallelism N` (handled in `commands/run-all.ts`)
2. `.zigma-flow/config.json` `agent.parallelism` (read by `loadAgentConfig`)
3. `DEFAULT_PARALLELISM = 4` (fallback in `getParallelism`)

## 3. Functional Points and Use Cases

### 3.1 Config Interface

| ID | Name | Description |
|---|---|---|
| UC-PARALLEL-CONFIG-001 | parallelism in AgentConfig | `AgentConfig.parallelism` is an optional number field; absent = undefined |
| UC-PARALLEL-CONFIG-002 | DEFAULT_PARALLELISM | Exported constant equals 4 |
| UC-PARALLEL-CONFIG-003 | getParallelism returns config value | When `agentConfig.parallelism` is set, `getParallelism()` returns that value |
| UC-PARALLEL-CONFIG-004 | getParallelism falls back to default | When `agentConfig.parallelism` is undefined, `getParallelism()` returns `DEFAULT_PARALLELISM` (4) |
| UC-PARALLEL-CONFIG-005 | getParallelism clamps to >= 1 | When `agentConfig.parallelism` is 0 or negative, `getParallelism()` returns 1 |
| UC-PARALLEL-CONFIG-006 | loadAgentConfig carries parallelism | `loadAgentConfig` returns `AgentConfig` with `parallelism` from JSON parse (or undefined if not in config) |

### 3.2 Documentation Coverage

| ID | Name | Description |
|---|---|---|
| UC-DOC-README-001 | README section | README has "并发执行" section with `--parallelism`, `--fail-fast` usage, and batch loop diagram |
| UC-DOC-ARCH-001 | Architecture §7.4 | `docs/architecture.md` has §7.4 Concurrency model subsection |
| UC-DOC-CHANGELOG-001 | CHANGELOG entry | CHANGELOG has P14 entry covering all major changes |

## 4. Spec Compliance Matrix

| # | Clause | Source | Status |
|---|---|---|---|
| SC-CONFIG-DOCS-1 | AgentConfig MUST include optional `parallelism` field | AD-P14-007 | Covered by UC-PARALLEL-CONFIG-001 |
| SC-CONFIG-DOCS-2 | DEFAULT_PARALLELISM MUST equal 4 | AD-P14-007 | Covered by UC-PARALLEL-CONFIG-002 |
| SC-CONFIG-DOCS-3 | `getParallelism` MUST return `agentConfig.parallelism` when set | AD-P14-007 | Covered by UC-PARALLEL-CONFIG-003 |
| SC-CONFIG-DOCS-4 | `getParallelism` MUST fall back to `DEFAULT_PARALLELISM` when undefined | AD-P14-007 | Covered by UC-PARALLEL-CONFIG-004 |
| SC-CONFIG-DOCS-5 | `getParallelism` MUST clamp to >= 1 | AD-P14-007 (CLI `--parallelism N` >= 1) | Covered by UC-PARALLEL-CONFIG-005 |
| SC-CONFIG-DOCS-6 | `loadAgentConfig` MUST pass through `parallelism` from config.json | AD-P14-007 | Covered by UC-PARALLEL-CONFIG-006 |
| SC-CONFIG-DOCS-7 | README MUST document `--parallelism` and `--fail-fast` | WF-P14-CONFIG-DOCS acceptance | Covered by UC-DOC-README-001 |
| SC-CONFIG-DOCS-8 | architecture.md MUST document concurrency model | WF-P14-CONFIG-DOCS acceptance | Covered by UC-DOC-ARCH-001 |
| SC-CONFIG-DOCS-9 | CHANGELOG MUST include P14 entry | WF-P14-CONFIG-DOCS acceptance | Covered by UC-DOC-CHANGELOG-001 |

**Compliance summary:** All 9 MUST clauses are covered. No gaps.

## 5. Test Plan

Since WF-P14-CONFIG-DOCS primarily modifies documentation and extends `config.ts` with a simple pure function, the validation strategy is:

### 5.1 Automated tests

Extend `tests/agent/config.test.ts` with:

| Test ID | Description | Use Case | Spec Clause |
|---|---|---|---|
| T-PARALLEL-CONFIG-1 | AgentConfig.parallelism type smoke (compile-time) | UC-PARALLEL-CONFIG-001 | SC-CONFIG-DOCS-1 |
| T-PARALLEL-CONFIG-2 | getParallelism returns config value | UC-PARALLEL-CONFIG-003 | SC-CONFIG-DOCS-3 |
| T-PARALLEL-CONFIG-3 | getParallelism returns default when undefined | UC-PARALLEL-CONFIG-004 | SC-CONFIG-DOCS-4 |
| T-PARALLEL-CONFIG-4 | getParallelism clamps to 1 | UC-PARALLEL-CONFIG-005 | SC-CONFIG-DOCS-5 |

### 5.2 Documentation audit (manual)

- README "并发执行" section: `--parallelism` usage shown, `--fail-fast` usage shown, batch loop described. (Check UC-DOC-README-001)
- architecture.md §7.4: scheduler pure function, AsyncQueue, event ordering, batch loop diagram, fail-fast, default parallelism. (Check UC-DOC-ARCH-001)
- CHANGELOG.md P14 entry covers scheduler, AsyncQueue, concurrent loop, CLI flags, events, config. (Check UC-DOC-CHANGELOG-001)

### 5.3 Exclusions

- No integration tests (concurrent execution behavior is covered by WF-P14-RUN-ALL-CONCURRENT).
- No CLI e2e tests (parallelism CLI flag handling tested alongside the runAll concurrent workflow).
- No snapshot tests for docs files (documentation is human-reviewed).

## 6. Error Conditions

| Condition | Behavior |
|---|---|
| `agent.parallelism` is 0 or negative in config.json | `getParallelism` clamps to 1 |
| `agent.parallelism` is missing from config.json | `getParallelism` returns 4 |
| `agent` section is entirely missing from config.json | `loadAgentConfig` returns `DEFAULT_AGENT_CONFIG` with `parallelism` undefined; `getParallelism` returns 4 |
| `agent.parallelism` is a non-number (e.g. string) | JSON parse will either succeed (coercion possible) or fail; `getParallelism` receives the raw value; the `>=1` Math.max will produce NaN if value is non-numeric, which Math.max(1, NaN) returns NaN. This is accepted as a misconfiguration — the config.json should be validated at a higher level. |
| `--parallelism` flag provides value lower than 1 | CLI layer (`commands/run-all.ts`) should clamp or validate; scheduler's `config.parallelism` is trusted input. |
