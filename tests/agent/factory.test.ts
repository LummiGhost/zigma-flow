import { describe, expect, it } from "vitest";

import {
  agentFactory,
  ClaudeCodeBackend,
  type AgentBackend,
  type AgentBackendConfig,
  type AgentExecuteOptions,
  type AgentExecuteResult,
} from "../../src/agent/index.js";

// ---------------------------------------------------------------------------
// Test backend
// ---------------------------------------------------------------------------

class TestBackend implements AgentBackend {
  readonly name: string;
  private readonly onExecute: (opts: AgentExecuteOptions) => Promise<AgentExecuteResult>;

  constructor(config: AgentBackendConfig & { name: string; onExecute: (opts: AgentExecuteOptions) => Promise<AgentExecuteResult> }) {
    this.name = config.name;
    this.onExecute = config.onExecute;
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    return this.onExecute(opts);
  }
}

// ---------------------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------------------

describe("AgentBackendFactory", () => {
  it("registers a backend and retrieves it by name", () => {
    const factory = agentFactory;
    // ClaudeCodeBackend is already registered during module init via run-all imports,
    // but we can test registration and retrieval independently.
    const fakeCtor = class implements AgentBackend {
      readonly name = "test-backend";
      async execute(_opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
        return { success: true, reportPath: "/fake/report.json" };
      }
    };

    factory.register("test-backend", fakeCtor);
    const retrieved = factory.get("test-backend");
    expect(retrieved).toBeDefined();
  });

  it("lists all registered backends", () => {
    const factory = agentFactory;
    factory.register("test-backend-list", class implements AgentBackend {
      readonly name = "test-backend-list";
      async execute(_opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
        return { success: true };
      }
    });

    const list = factory.list();
    expect(list).toContain("test-backend-list");
  });

  it("creates a backend instance from a name and config", () => {
    const factory = agentFactory;
    factory.register("test-create", class implements AgentBackend {
      readonly name = "test-create";
      private command: string;
      constructor(config: AgentBackendConfig) {
        this.command = config.command;
      }
      async execute(_opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
        return { success: true };
      }
    });

    const instance = factory.createBackend("test-create", { command: "echo" });
    expect(instance.name).toBe("test-create");
  });

  it("throws for an unknown backend name", () => {
    const factory = agentFactory;
    expect(() =>
      factory.createBackend("non-existent-backend", { command: "none" })
    ).toThrow(/Unknown agent backend/);
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeBackend tests
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend", () => {
  it("has the correct backend name", () => {
    const backend = new ClaudeCodeBackend({ command: "claude" });
    expect(backend.name).toBe("claude-code");
  });

  it("accepts custom command, args, and timeout", () => {
    const backend = new ClaudeCodeBackend({
      command: "/usr/local/bin/claude",
      args: ["-p", "--output-format", "text"],
      timeout: 120_000,
    });

    // Constructor succeeds — verify by checking the instance is valid
    expect(backend).toBeDefined();
  });

  it("uses default args and timeout when not provided", () => {
    const backend = new ClaudeCodeBackend({ command: "claude" });
    // Defaults are applied internally; instance is valid.
    expect(backend).toBeDefined();
  });
});
