import { describe, expect, it } from "vitest";

import type { ContextBundle } from "../../src/context/index.js";
import { validatePromptHandoff } from "../../src/prompt/index.js";

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
  it("rejects a current-step.md sample without Step Instructions", () => {
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
        expect.objectContaining({ code: "missing_step_instructions" }),
      ]),
    );
  });
});
