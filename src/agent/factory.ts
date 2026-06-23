/**
 * Agent Backend Factory — registry for pluggable agent backends.
 *
 * Backends are registered by name and can be instantiated from config.
 */

import type { AgentBackend, AgentBackendConfig } from "./types.js";

export class AgentBackendFactory {
  private registry = new Map<string, new (config: AgentBackendConfig) => AgentBackend>();

  /** Register a backend constructor under a name. */
  register(name: string, ctor: new (config: AgentBackendConfig) => AgentBackend): void {
    this.registry.set(name, ctor);
  }

  /** Get a registered backend constructor by name. */
  get(name: string): (new (config: AgentBackendConfig) => AgentBackend) | undefined {
    return this.registry.get(name);
  }

  /** List all registered backend names. */
  list(): string[] {
    return [...this.registry.keys()];
  }

  /** Create a backend instance from a name and config. */
  createBackend(name: string, config: AgentBackendConfig): AgentBackend {
    const Ctor = this.registry.get(name);
    if (Ctor === undefined) {
      throw new Error(
        `Unknown agent backend "${name}". Available backends: ${this.list().join(", ") || "(none)"}`
      );
    }
    return new Ctor(config);
  }
}

/** Singleton factory instance. */
export const agentFactory = new AgentBackendFactory();
