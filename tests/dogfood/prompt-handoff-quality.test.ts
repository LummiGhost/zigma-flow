import { describe, expect, it } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { ContextBundle } from "../../src/context/index.js";
import { createRun } from "../../src/engine/index.js";
import { runInit } from "../../src/init/index.js";
import { validatePromptHandoff } from "../../src/prompt/index.js";
import { promptAction } from "../../src/commands/prompt.js";
import type { Clock } from "../../src/run/index.js";

class FakeClock implements Clock {
  now(): string {
    return "2026-06-16T00:00:00.000Z";
  }
}

function dogfoodBundle(): ContextBundle {
  return {
    runId: "20260615-0003",
    jobId: "intake",
    stepId: "analyze",
    attempt: 1,
    stepType: "agent",
    capabilities: {
      skills: [],
      knowledge: [],
      prompts: [],
      functions: [],
      tools: [],
    },
    inputs: { task: "P12.3 dogfood prompt handoff" },
    artifacts: [],
    signals: [],
    permissions: { contents: "read", commands: "none", workflow_state: "none" },
  };
}

describe("P12.3 prompt handoff quality regression", () => {
  it("rejects a current-step.md sample without Workflow Step Prompt", () => {
    const prompt = [
      "# intake/analyze Agent Prompt",
      "",
      "You are acting as the `analyze` agent step of job `intake` in run `20260615-0003`.",
      "",
      "## Inputs (当前输入)",
      "",
      "- **task**: P12.3 dogfood prompt handoff",
      "",
      "## Exposed Capabilities",
      "",
      "### Prompts",
      "",
      "- `intake` (skill: code)",
      "",
      "## Output",
      "",
      "`.zigma-flow/runs/20260615-0003/jobs/intake/attempts/1/steps/analyze/report.json`",
      "",
    ].join("\n");

    const result = validatePromptHandoff(prompt, dogfoodBundle());

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_step_prompt" }),
      ]),
    );
  });

  it("generates an intake/analyze prompt with packet layers and explicit report path", async () => {
    const projectDir = join(tmpdir(), `zigma-p12-5-dogfood-${randomUUID()}`);
    await mkdir(projectDir, { recursive: true });

    try {
      await runInit({ cwd: projectDir });

      const workflowPath = join(projectDir, ".zigma-flow", "workflows", "code-change.yml");
      const runsDir = join(projectDir, ".zigma-flow", "runs");
      const skillLockPath = join(projectDir, ".zigma-flow", "skill-lock.json");
      const { runId } = await createRun({
        workflowPath,
        task: "将 prompt 重构为外部可扩展提示词模板 + 自动扫描模式",
        runsDir,
        skillLockPath,
        clock: new FakeClock(),
      });

      await promptAction({
        job: "intake",
        zigmaflowDir: projectDir,
        clock: new FakeClock(),
      });

      const prompt = await readFile(join(runsDir, runId, "current-step.md"), "utf-8");
      const packetDir = join(
        runsDir,
        runId,
        "jobs",
        "intake",
        "attempts",
        "1",
        "steps",
        "analyze",
        "prompt-packet",
      );
      const stepBlock = await readFile(join(packetDir, "step.md"), "utf-8");
      const manifest = JSON.parse(await readFile(join(packetDir, "packet.json"), "utf-8")) as {
        backend_composition: { composition_order: string[] };
        blocks: Array<{ id: string; path: string }>;
      };

      expect(prompt).toMatch(/^##\s+System Prompt/m);
      expect(prompt).toMatch(/^##\s+Task Prompt/m);
      expect(prompt).toMatch(/^##\s+Workflow Step Prompt/m);
      expect(prompt).toMatch(/^##\s+Context Blocks/m);
      expect(prompt).toMatch(/^##\s+Output Contract/m);
      expect(prompt.match(/^#\s+/gm)).toHaveLength(1);
      expect(prompt).toContain("### Intake Step Prompt");
      expect(prompt).not.toMatch(/^#\s+Intake Step Prompt/m);
      expect(prompt).not.toMatch(/^##\s+Task$/m);
      expect(prompt).toContain("Overall run task");
      expect(prompt).toContain("canonical step artifact path");
      expect(prompt).toContain(
        `.zigma-flow/runs/${runId}/jobs/intake/attempts/1/steps/analyze/report.json`,
      );
      expect(prompt).toContain("This job operates in read-only mode.");
      expect(prompt).not.toContain("edits: write");
      expect(stepBlock).toContain("# Intake Step Prompt");
      expect(manifest.backend_composition.composition_order).toEqual([
        "system",
        "task",
        "step",
        "context",
        "output",
      ]);
      expect(manifest.blocks.map((block) => block.path)).toEqual([
        "jobs/intake/attempts/1/steps/analyze/prompt-packet/system.md",
        "jobs/intake/attempts/1/steps/analyze/prompt-packet/task.md",
        "jobs/intake/attempts/1/steps/analyze/prompt-packet/step.md",
        "jobs/intake/attempts/1/steps/analyze/prompt-packet/context.md",
        "jobs/intake/attempts/1/steps/analyze/prompt-packet/output.md",
      ]);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
