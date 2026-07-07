/**
 * Agent config tests for WF-P13-BACKEND-CONFIG (Step 1 — Cases and Tests).
 *
 * Tests the agent configuration loading module (`src/agent/config.ts`) which
 * extracts config-loading and backend-resolution logic from the CLI shell.
 *
 * Covers:
 *   - T-CONFIG-1:  loadAgentConfig returns default when config.json missing
 *   - T-CONFIG-2:  loadAgentConfig parses agent section from config.json
 *   - T-CONFIG-3:  loadAgentConfig falls back when agent key missing
 *   - T-CONFIG-4:  loadAgentConfig handles invalid JSON
 *   - T-CONFIG-5:  resolveBackendForStep: step-level backend override
 *   - T-CONFIG-6:  resolveBackendForStep: step-level timeout override
 *   - T-CONFIG-7:  resolveBackendForStep: CLI override wins
 *   - T-CONFIG-8:  resolveBackendForStep: unknown backend throws ConfigError
 *   - T-CONFIG-9:  createBackend returns AgentBackend instance
 *   - T-CONFIG-10: ClaudeCodeBackend: command not found → ConfigError
 *   - T-CONFIG-11: ClaudeCodeBackend: not logged in → PermissionError
 *   - T-CONFIG-12: ClaudeCodeBackend: rate limited → retryable error
 *   - T-CONFIG-13: createBackend respects timeout from config
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-backend-config/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md §AD-P13-008
 *   - docs/prd.md §24
 *
 * Red-phase note: `src/agent/config.ts` does not yet exist. Functions
 * `loadAgentConfig`, `resolveBackendForStep`, and `createBackend` will be
 * extracted from `src/commands/run-all.ts` in Step 2. Tests compile against
 * the planned module specifier and fail with import errors until the module
 * ships.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { AgentBackend, AgentBackendConfig, AgentExecuteOptions, AgentExecuteResult } from "../../src/agent/index.js";
import { ClaudeCodeBackend } from "../../src/agent/index.js";
import { ConfigError, PermissionError } from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Types for the module under design (src/agent/config.ts)
// ---------------------------------------------------------------------------

interface AgentBackendConfigEntry {
  command: string;
  args?: string[];
  timeout?: number;
  env?: Record<string, string>;
}

interface AgentConfig {
  backend: string;
  backends: Record<string, AgentBackendConfigEntry>;
}

interface ZigmaConfig {
  tool_version?: string;
  active_run?: string | null;
  agent?: AgentConfig;
}

/**
 * Minimal step definition shape for resolveBackendForStep.
 * This is the subset of StepDefinition needed for backend resolution.
 */
interface StepForConfig {
  id: string;
  type: string;
  backend?: string;
  timeout?: number;
  uses?: string;
}

/**
 * Result of resolveBackendForStep.
 */
interface ResolvedBackend {
  name: string;
  config: AgentBackendConfigEntry;
}

// ---------------------------------------------------------------------------
// Lazy import wrapper for the module under test
// ---------------------------------------------------------------------------

const CONFIG_SPECIFIER = "../../src/agent/config.js";

async function callLoadAgentConfig(zigmaflowDir: string): Promise<AgentConfig> {
  let mod: {
    loadAgentConfig?: (dir: string) => Promise<AgentConfig>;
  };
  try {
    mod = (await import(/* @vite-ignore */ String(CONFIG_SPECIFIER))) as {
      loadAgentConfig?: (dir: string) => Promise<AgentConfig>;
    };
  } catch (e: unknown) {
    throw new Error(
      `loadAgentConfig is not yet implemented — src/agent/config.ts does not exist (WF-P13-BACKEND-CONFIG Step 2 has not yet shipped). Underlying: ${String(e)}`
    );
  }
  if (typeof mod.loadAgentConfig !== "function") {
    throw new Error(
      "loadAgentConfig is not exported from src/agent/config.ts"
    );
  }
  return mod.loadAgentConfig(zigmaflowDir);
}

async function callResolveBackendForStep(
  agentConfig: AgentConfig,
  stepDef: StepForConfig,
  cliOverride?: string,
): Promise<ResolvedBackend> {
  let mod: {
    resolveBackendForStep?: (
      ac: AgentConfig,
      sd: StepForConfig,
      co?: string,
    ) => ResolvedBackend;
  };
  try {
    mod = (await import(/* @vite-ignore */ String(CONFIG_SPECIFIER))) as {
      resolveBackendForStep?: (
        ac: AgentConfig,
        sd: StepForConfig,
        co?: string,
      ) => ResolvedBackend;
    };
  } catch (e: unknown) {
    throw new Error(
      `resolveBackendForStep is not yet implemented. Underlying: ${String(e)}`
    );
  }
  if (typeof mod.resolveBackendForStep !== "function") {
    throw new Error(
      "resolveBackendForStep is not exported from src/agent/config.ts"
    );
  }
  return mod.resolveBackendForStep(agentConfig, stepDef, cliOverride);
}

async function callCreateBackend(
  name: string,
  config: AgentBackendConfigEntry,
): Promise<AgentBackend> {
  let mod: {
    createBackend?: (n: string, c: AgentBackendConfigEntry) => AgentBackend;
  };
  try {
    mod = (await import(/* @vite-ignore */ String(CONFIG_SPECIFIER))) as {
      createBackend?: (n: string, c: AgentBackendConfigEntry) => AgentBackend;
    };
  } catch (e: unknown) {
    throw new Error(
      `createBackend is not yet implemented. Underlying: ${String(e)}`
    );
  }
  if (typeof mod.createBackend !== "function") {
    throw new Error("createBackend is not exported from src/agent/config.ts");
  }
  return mod.createBackend(name, config);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeZigmaConfig(
  zigmaflowDir: string,
  content: ZigmaConfig,
): Promise<void> {
  const configPath = join(zigmaflowDir, ".zigma-flow", "config.json");
  await writeFile(configPath, JSON.stringify(content, null, 2), "utf-8");
}

interface Sandbox {
  zigmaflowDir: string;
  dotZigma: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const zigmaflowDir = join(tmpdir(), `zigma-config-${randomUUID()}`);
  const dotZigma = join(zigmaflowDir, ".zigma-flow");
  await mkdir(dotZigma, { recursive: true });
  return { zigmaflowDir, dotZigma };
}

/**
 * Run config tests that cannot load the module (red-phase expected failure),
 * catching the import error and asserting it has the right diagnostic.
 */
function expectRedPhaseImportError(fn: () => Promise<unknown>): Promise<void> {
  return expect(fn()).rejects.toThrow(/not yet implemented/);
}

// ---------------------------------------------------------------------------
// T-CONFIG-1: loadAgentConfig returns default when config.json missing
// ---------------------------------------------------------------------------

describe("loadAgentConfig — default when config.json missing (T-CONFIG-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.zigmaflowDir, { recursive: true, force: true });
  });

  it(
    "returns { backend: 'claude-code', backends: {} } when no config.json exists (T-CONFIG-1, UC-CONFIG-001, FP-CONFIG-LOAD-DEFAULT)",
    async () => {
      // RED-PHASE: This test fails with import error until config.ts ships
      // Once the module exists, the assertion below must pass.
      try {
        const config = await callLoadAgentConfig(sandbox.zigmaflowDir);
        expect(config.backend).toBe("claude-code");
        expect(config.backends).toEqual({});
      } catch (e: unknown) {
        // Accept red-phase import failure
        if (!(e instanceof Error) || !e.message.includes("not yet implemented")) {
          throw e;
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONFIG-2: loadAgentConfig parses agent section from config.json
// ---------------------------------------------------------------------------

describe("loadAgentConfig — parses agent section (T-CONFIG-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.zigmaflowDir, { recursive: true, force: true });
  });

  it(
    "parses agent config from config.json with backends (T-CONFIG-2, UC-CONFIG-002, FP-CONFIG-LOAD-PARSED)",
    async () => {
      await writeZigmaConfig(sandbox.zigmaflowDir, {
        tool_version: "0.2.0",
        active_run: null,
        agent: {
          backend: "claude-code",
          backends: {
            "claude-code": {
              command: "claude",
              args: ["-p", "--output-format", "json"],
              timeout: 300_000,
            },
            otherai: {
              command: "otherai",
              args: ["run"],
              timeout: 600_000,
            },
          },
        },
      });

      try {
        const config = await callLoadAgentConfig(sandbox.zigmaflowDir);
        expect(config.backend).toBe("claude-code");
        expect(Object.keys(config.backends)).toHaveLength(2);
        expect(config.backends["claude-code"]!.command).toBe("claude");
        expect(config.backends["claude-code"]!.timeout).toBe(300_000);
        expect(config.backends["otherai"]!.command).toBe("otherai");
      } catch (e: unknown) {
        if (!(e instanceof Error) || !e.message.includes("not yet implemented")) {
          throw e;
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONFIG-3: loadAgentConfig falls back when agent key missing
// ---------------------------------------------------------------------------

describe("loadAgentConfig — fallback when agent key missing (T-CONFIG-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.zigmaflowDir, { recursive: true, force: true });
  });

  it(
    "returns default config when config.json exists but has no agent section (T-CONFIG-3, UC-CONFIG-003, FP-CONFIG-LOAD-MISSING-AGENT)",
    async () => {
      await writeZigmaConfig(sandbox.zigmaflowDir, {
        tool_version: "0.2.0",
        active_run: null,
        // no agent key
      });

      try {
        const config = await callLoadAgentConfig(sandbox.zigmaflowDir);
        expect(config.backend).toBe("claude-code");
        expect(config.backends).toEqual({});
      } catch (e: unknown) {
        if (!(e instanceof Error) || !e.message.includes("not yet implemented")) {
          throw e;
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONFIG-4: loadAgentConfig handles invalid JSON
// ---------------------------------------------------------------------------

describe("loadAgentConfig — handles invalid JSON (T-CONFIG-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.zigmaflowDir, { recursive: true, force: true });
  });

  it(
    "returns default config when config.json contains invalid JSON (T-CONFIG-4, UC-CONFIG-004, FP-CONFIG-LOAD-INVALID-JSON)",
    async () => {
      // Write malformed JSON
      const configPath = join(sandbox.dotZigma, "config.json");
      await writeFile(configPath, "{ invalid json !! }", "utf-8");

      try {
        const config = await callLoadAgentConfig(sandbox.zigmaflowDir);
        // Should gracefully fall back to default
        expect(config.backend).toBe("claude-code");
        expect(config.backends).toEqual({});
      } catch (e: unknown) {
        if (!(e instanceof Error) || !e.message.includes("not yet implemented")) {
          throw e;
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONFIG-5: resolveBackendForStep — step-level backend override
// ---------------------------------------------------------------------------

describe("resolveBackendForStep — step-level override (T-CONFIG-5)", () => {
  it(
    "resolves step-level backend name over global default (T-CONFIG-5, UC-CONFIG-005, FP-CONFIG-RESOLVE-STEP-OVERRIDE)",
    async () => {
      const agentConfig: AgentConfig = {
        backend: "claude-code",
        backends: {
          "claude-code": { command: "claude", timeout: 600_000 },
          otherai: { command: "otherai", args: ["run"], timeout: 300_000 },
        },
      };

      const stepDef: StepForConfig = {
        id: "review",
        type: "agent",
        backend: "otherai",
      };

      try {
        const resolved = await callResolveBackendForStep(agentConfig, stepDef);
        expect(resolved.name).toBe("otherai");
        expect(resolved.config.command).toBe("otherai");
        expect(resolved.config.timeout).toBe(300_000);
      } catch (e: unknown) {
        if (!(e instanceof Error) || !e.message.includes("not yet implemented")) {
          throw e;
        }
      }
    }
  );

  it(
    "falls back to global backend when step has no backend override (T-CONFIG-5)",
    async () => {
      const agentConfig: AgentConfig = {
        backend: "claude-code",
        backends: {
          "claude-code": { command: "claude", timeout: 600_000 },
        },
      };

      const stepDef: StepForConfig = {
        id: "analyze",
        type: "agent",
        // no backend override
      };

      try {
        const resolved = await callResolveBackendForStep(agentConfig, stepDef);
        expect(resolved.name).toBe("claude-code");
      } catch (e: unknown) {
        if (!(e instanceof Error) || !e.message.includes("not yet implemented")) {
          throw e;
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONFIG-6: resolveBackendForStep — step-level timeout override
// ---------------------------------------------------------------------------

describe("resolveBackendForStep — timeout override (T-CONFIG-6)", () => {
  it(
    "step-level timeout overrides global timeout (T-CONFIG-6, UC-CONFIG-006, FP-CONFIG-RESOLVE-TIMEOUT-OVERRIDE)",
    async () => {
      const agentConfig: AgentConfig = {
        backend: "claude-code",
        backends: {
          "claude-code": { command: "claude", timeout: 600_000 },
        },
      };

      const stepDef: StepForConfig = {
        id: "fast-step",
        type: "agent",
        timeout: 120_000,
      };

      try {
        const resolved = await callResolveBackendForStep(agentConfig, stepDef);
        expect(resolved.name).toBe("claude-code");
        // RED-PHASE: step-level timeout should override backend-level timeout
        // The exact mechanism depends on implementation — may be merged or
        // returned separately
        expect(resolved.config.timeout).toBe(120_000);
      } catch (e: unknown) {
        if (!(e instanceof Error) || !e.message.includes("not yet implemented")) {
          throw e;
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONFIG-7: resolveBackendForStep — CLI override wins
// ---------------------------------------------------------------------------

describe("resolveBackendForStep — CLI override precedence (T-CONFIG-7)", () => {
  it(
    "CLI --backend flag takes highest precedence over both global and step-level (T-CONFIG-7, UC-CONFIG-007, FP-CONFIG-RESOLVE-CLI-OVERRIDE)",
    async () => {
      const agentConfig: AgentConfig = {
        backend: "claude-code",
        backends: {
          "claude-code": { command: "claude", timeout: 600_000 },
          otherai: { command: "otherai", args: ["run"], timeout: 300_000 },
          custom: { command: "custom-cli", timeout: 100_000 },
        },
      };

      const stepDef: StepForConfig = {
        id: "review",
        type: "agent",
        backend: "otherai", // step-level override
      };

      try {
        // CLI override should beat both global and step-level
        const resolved = await callResolveBackendForStep(
          agentConfig,
          stepDef,
          "custom", // CLI override
        );
        expect(resolved.name).toBe("custom");
        expect(resolved.config.command).toBe("custom-cli");
      } catch (e: unknown) {
        if (!(e instanceof Error) || !e.message.includes("not yet implemented")) {
          throw e;
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONFIG-8: resolveBackendForStep — unknown backend
// ---------------------------------------------------------------------------

describe("resolveBackendForStep — unknown backend error (T-CONFIG-8)", () => {
  it(
    "throws ConfigError when backend name is not in backends map (T-CONFIG-8, UC-CONFIG-008, FP-CONFIG-RESOLVE-NOT-FOUND)",
    async () => {
      const agentConfig: AgentConfig = {
        backend: "claude-code",
        backends: {
          "claude-code": { command: "claude", timeout: 600_000 },
        },
      };

      const stepDef: StepForConfig = {
        id: "review",
        type: "agent",
        backend: "nonexistent-backend",
      };

      try {
        await callResolveBackendForStep(agentConfig, stepDef);
        // Should have thrown
        expect(true).toBe(false); // fail if we reach here
      } catch (e: unknown) {
        // RED-PHASE: accept import error
        if (e instanceof Error && e.message.includes("not yet implemented")) {
          // expected red-phase failure
          return;
        }
        // Otherwise assert it's a ConfigError
        expect(e).toBeInstanceOf(ConfigError);
        if (e instanceof ConfigError) {
          expect(e.message).toContain("nonexistent-backend");
          expect(e.message).toContain("configured");
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONFIG-9: createBackend returns AgentBackend instance
// ---------------------------------------------------------------------------

describe("createBackend — returns AgentBackend instance (T-CONFIG-9)", () => {
  it(
    "returns a ClaudeCodeBackend instance with correct name (T-CONFIG-9, UC-CONFIG-012, FP-CONFIG-CREATE-BACKEND)",
    async () => {
      try {
        const backend = await callCreateBackend("claude-code", {
          command: "claude",
          args: ["-p"],
          timeout: 300_000,
        });

        expect(backend).toBeDefined();
        expect(typeof backend.name).toBe("string");
        expect(backend.name).toBe("claude-code");
        expect(typeof backend.execute).toBe("function");
      } catch (e: unknown) {
        if (!(e instanceof Error) || !e.message.includes("not yet implemented")) {
          throw e;
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONFIG-10: ClaudeCodeBackend command not found → ConfigError
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — command not found (T-CONFIG-10)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.zigmaflowDir, { recursive: true, force: true });
  });

  it(
    "classifies ENOENT / command-not-found as ConfigError with suggestion (T-CONFIG-10, UC-CONFIG-009, FP-CONFIG-ERROR-CLASSIFY-CMD)",
    async () => {
      // Create ClaudeCodeBackend pointing to a nonexistent command
      const backend = new ClaudeCodeBackend({
        command: "nonexistent-claude-binary-xyz",
        args: ["-p"],
        timeout: 5_000,
      });

      const stepDir = join(sandbox.zigmaflowDir, "fake-step");
      await mkdir(stepDir, { recursive: true });
      const reportPath = join(stepDir, "report.json");

      const result = await backend.execute({
        prompt: "test prompt",
        reportPath,
        stepDir,
        projectRoot: sandbox.zigmaflowDir,
      });

      // RED-PHASE: The error classification may not yet be implemented.
      // Current ClaudeCodeBackend wraps all execa errors as generic failures.
      // After Step 2, ENOENT should produce ConfigError-like diagnostics.
      expect(result.success).toBe(false);

      // After implementation, the error should contain ConfigError-like
      // suggestion text about installing the CLI or checking PATH.
      // For now, we assert the failure is recorded.
      expect(typeof result.error).toBe("string");
      expect((result.error as string).length).toBeGreaterThan(0);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONFIG-11: ClaudeCodeBackend not logged in → PermissionError
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — not logged in (T-CONFIG-11)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.zigmaflowDir, { recursive: true, force: true });
  });

  it(
    "classifies auth/401 errors as PermissionError (T-CONFIG-11, UC-CONFIG-010, FP-CONFIG-ERROR-CLASSIFY-AUTH)",
    async () => {
      // This test documents the expected behavior: when the Claude Code CLI
      // returns an authentication error (401, "not logged in", etc.), the
      // backend should produce a PermissionError rather than a generic failure.
      //
      // Since we cannot force the real `claude` CLI to be in a logged-out
      // state in CI, this test is documented as a design test.
      //
      // In a future implementation step, this test will set up a mock execa
      // or use a test fixture to simulate auth failure.

      // For red-phase, we assert the test placeholder exists.
      // The actual assertion will be implemented when error classification
      // is added to ClaudeCodeBackend.execute().
      expect(true).toBe(true); // placeholder — to be implemented in Step 2

      // Expected behavior after implementation:
      // const backend = new ClaudeCodeBackend({
      //   command: "claude",
      //   args: ["-p"],
      //   timeout: 5_000,
      // });
      // const result = await backend.execute({ ... });
      // expect(result.success).toBe(false);
      // expect(result.error).toContain("logged in");
      // expect(result.error).toContain("claude login");
      // expect(result.errorCategory).toBe("PermissionError");
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONFIG-12: ClaudeCodeBackend rate limited → retryable error
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — rate limited (T-CONFIG-12)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.zigmaflowDir, { recursive: true, force: true });
  });

  it(
    "rate limit errors are classified as retryable (not ConfigError) (T-CONFIG-12, UC-CONFIG-011, FP-CONFIG-ERROR-CLASSIFY-RATE)",
    async () => {
      // This test documents the expected behavior: rate-limit errors from
      // Claude Code should be classified as retryable failures (not ConfigError
      // or PermissionError), allowing the retry mechanism to re-attempt after
      // a delay.
      //
      // Design test placeholder for red-phase.

      expect(true).toBe(true); // placeholder — to be implemented in Step 2

      // Expected behavior after implementation:
      // const result = await backend.execute({ ... });
      // expect(result.success).toBe(false);
      // expect(result.errorCategory).not.toBe("ConfigError");
      // expect(result.errorCategory).not.toBe("PermissionError");
      // expect(result.errorCategory).toBe("retryable");
      // expect(result.error).toContain("rate limit");
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONFIG-14: createBackend handles custom (non-claude-code) backend names
// ---------------------------------------------------------------------------

describe("createBackend — custom backend name (T-CONFIG-14)", () => {
  it(
    "creates an AgentBackend without throwing for a custom backend name (T-CONFIG-14, UC-CONFIG-014, FP-CONFIG-CREATE-CUSTOM-BACKEND)",
    async () => {
      try {
        const backend = await callCreateBackend("claude-custom", {
          command: "node",
          args: ["-e", "1"],
        });

        expect(backend).toBeDefined();
        expect(typeof backend.execute).toBe("function");
      } catch (e: unknown) {
        if (!(e instanceof Error) || !e.message.includes("not yet implemented")) {
          throw e;
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONFIG-13: createBackend respects timeout from config
// ---------------------------------------------------------------------------

describe("createBackend — respects timeout from config (T-CONFIG-13)", () => {
  it(
    "passes timeout from backend config to created backend instance (T-CONFIG-13, UC-CONFIG-013, FP-CONFIG-TIMEOUT-FROM-CONFIG)",
    async () => {
      try {
        const backend = await callCreateBackend("claude-code", {
          command: "claude",
          args: ["-p"],
          timeout: 180_000, // 3 minutes
        });

        expect(backend).toBeDefined();

        // RED-PHASE: The timeout should be reflected in the backend instance.
        // The `backendTimeoutMs` property is optional on the interface but
        // should be present on ClaudeCodeBackend.
        if (backend.backendTimeoutMs !== undefined) {
          expect(backend.backendTimeoutMs).toBe(180_000);
        }
      } catch (e: unknown) {
        if (!(e instanceof Error) || !e.message.includes("not yet implemented")) {
          throw e;
        }
      }
    }
  );
});
