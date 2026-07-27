import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CodexCliBackend,
  createBackend,
  resolveBackendForStep,
} from "../../src/agent/index.js";

const fixtureScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "fake-codex-cli.mjs",
);

describe("CodexCliBackend", () => {
  it("is available as a zero-configuration built-in backend", () => {
    const resolved = resolveBackendForStep({
      backend: "codex-cli",
      backends: {},
    });

    expect(resolved).toMatchObject({
      name: "codex-cli",
      config: {
        command: "codex",
        args: ["exec", "-", "--json", "--color", "never"],
        sandbox: "workspace-write",
        ephemeral: true,
      },
    });
    expect(createBackend(resolved.name, resolved.config)).toBeInstanceOf(CodexCliBackend);
  });

  it("transports prompts through stdin and captures structured output artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "zigma-codex-backend-"));
    const stepDir = join(root, "step");
    const reportPath = join(stepDir, "report.json");
    const backend = new CodexCliBackend({
      command: process.execPath,
      args: [fixtureScript],
      timeout: 10_000,
    });

    const result = await backend.execute({
      prompt: "fixture prompt with a large context payload",
      reportPath,
      stepDir,
      projectRoot: root,
    });

    expect(result.success).toBe(true);
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
      outputs: { prompt_received: true },
      summary: "fake codex completed",
    });
    expect(await readFile(join(stepDir, "agent.stdout.log"), "utf8")).toContain("thread.started");
    expect(JSON.parse(await readFile(join(stepDir, "agent.invocation.json"), "utf8"))).toMatchObject({
      prompt_transport: "stdin",
      command: process.execPath,
    });
  });

  it("reports a clear configuration error when the Codex executable is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "zigma-codex-missing-"));
    const stepDir = join(root, "step");
    const backend = new CodexCliBackend({ command: "missing-codex-command-for-test" });

    const result = await backend.execute({
      prompt: "fixture prompt",
      reportPath: join(stepDir, "report.json"),
      stepDir,
      projectRoot: root,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("ConfigError");
  });
});
