/**
 * Workflow `models:` registry + step `constraints` schema tests (Issue #286 Phase 1).
 *
 * Covers zod validation of the model profile registry and step constraint
 * blocks, the loadWorkflow semantic check restricting constraints to agent
 * steps, and backward compatibility for workflows without the new fields.
 */

import { describe, expect, it } from "vitest";

import { loadWorkflow } from "../../src/workflow/index.js";

function makeYaml(modelsBlock: string, stepsBlock: string): string {
  return [
    "name: models-schema-test",
    'version: "1.0"',
    modelsBlock,
    "jobs:",
    "  main:",
    "    steps:",
    stepsBlock,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const DEFAULT_SCRIPT_STEP = [
  "      - id: s1",
  "        type: script",
  "        run: echo hi",
].join("\n");

const VALID_MODELS = [
  "models:",
  "  cheap:",
  "    model: claude-haiku-4-5",
  "    cost_class: low",
  "    latency_class: low",
  "    data_classification: [internal]",
  "    regions: [us-east-1]",
  "  premium:",
  "    model: claude-sonnet-4-6",
  "    cost_class: high",
  "    latency_class: medium",
  "    data_classification: [internal, confidential]",
  "    local_required: true",
  "    backend: claude-code",
  "    capabilities:",
  "      vision: true",
].join("\n");

const AGENT_STEP_WITH_CONSTRAINTS = [
  "      - id: a1",
  "        type: agent",
  "        allow_generic_prompt: true",
  "        uses: zigma/analyze-skill",
  "        constraints:",
  "          max_cost_class: medium",
  "          data_classification: internal",
  "          regions: [us-east-1]",
  "          local_required: false",
].join("\n");

describe("models registry + step constraints — valid", () => {
  it("accepts a valid models registry and parses profile fields", () => {
    const wf = loadWorkflow(makeYaml(VALID_MODELS, DEFAULT_SCRIPT_STEP));
    expect(wf.models).toBeDefined();
    expect(wf.models!["cheap"]!.model).toBe("claude-haiku-4-5");
    expect(wf.models!["cheap"]!.cost_class).toBe("low");
    expect(wf.models!["cheap"]!.latency_class).toBe("low");
    expect(wf.models!["cheap"]!.data_classification).toEqual(["internal"]);
    expect(wf.models!["cheap"]!.regions).toEqual(["us-east-1"]);
    expect(wf.models!["premium"]!.backend).toBe("claude-code");
    expect(wf.models!["premium"]!.local_required).toBe(true);
    expect(wf.models!["premium"]!.capabilities).toEqual({ vision: true });
  });

  it("accepts a step constraints block on an agent step and parses its fields", () => {
    const wf = loadWorkflow(makeYaml(VALID_MODELS, AGENT_STEP_WITH_CONSTRAINTS));
    const step = wf.jobs["main"]!.steps[0]!;
    expect(step.constraints).toEqual({
      max_cost_class: "medium",
      data_classification: "internal",
      regions: ["us-east-1"],
      local_required: false,
    });
  });

  it("accepts and parses a routing_policy objective on step constraints (Phase 4)", () => {
    const stepBlock = [
      "      - id: a1",
      "        type: agent",
      "        allow_generic_prompt: true",
      "        uses: zigma/analyze-skill",
      "        constraints:",
      "          routing_policy:",
      "            objective: accepted_artifact_cost",
    ].join("\n");
    const wf = loadWorkflow(makeYaml(VALID_MODELS, stepBlock));
    expect(wf.jobs["main"]!.steps[0]!.constraints).toEqual({
      routing_policy: { objective: "accepted_artifact_cost" },
    });
  });

  it("loads workflows without models or constraints unchanged (backward compat)", () => {
    const yaml = [
      "name: models-schema-test",
      'version: "1.0"',
      "jobs:",
      "  main:",
      "    steps:",
      "      - id: s1",
      "        type: script",
      "        run: echo hi",
    ].join("\n");
    const wf = loadWorkflow(yaml);
    expect(wf.models).toBeUndefined();
    expect(wf.jobs["main"]!.steps[0]!.constraints).toBeUndefined();
  });

  it("tolerates unknown extra keys on profiles (schema is not strict)", () => {
    const yaml = makeYaml(
      ["models:", "  p:", "    model: m1", "    unknown_field: 1"].join("\n"),
      DEFAULT_SCRIPT_STEP,
    );
    const wf = loadWorkflow(yaml);
    expect(wf.models!["p"]!.model).toBe("m1");
  });
});

describe("models registry + step constraints — invalid", () => {
  it("rejects a profile missing the model field", () => {
    const yaml = makeYaml(["models:", "  bad:", "    cost_class: low"].join("\n"), DEFAULT_SCRIPT_STEP);
    expect(() => loadWorkflow(yaml)).toThrow(/Workflow validation failed at: models\.bad\.model/);
  });

  it("rejects an invalid cost_class enum value", () => {
    const yaml = makeYaml(["models:", "  bad:", "    model: m1", "    cost_class: cheap"].join("\n"), DEFAULT_SCRIPT_STEP);
    expect(() => loadWorkflow(yaml)).toThrow(/Workflow validation failed at: models\.bad\.cost_class/);
  });

  it("rejects an invalid latency_class enum value", () => {
    const yaml = makeYaml(["models:", "  bad:", "    model: m1", "    latency_class: instant"].join("\n"), DEFAULT_SCRIPT_STEP);
    expect(() => loadWorkflow(yaml)).toThrow(/Workflow validation failed at: models\.bad\.latency_class/);
  });

  it("rejects an invalid data_classification enum value", () => {
    const yaml = makeYaml(
      ["models:", "  bad:", "    model: m1", "    data_classification: [top-secret]"].join("\n"),
      DEFAULT_SCRIPT_STEP,
    );
    expect(() => loadWorkflow(yaml)).toThrow(/Workflow validation failed at: models\.bad\.data_classification/);
  });

  it("rejects constraints on a non-agent step (loadWorkflow check 6f)", () => {
    const stepBlock = [
      "      - id: s1",
      "        type: script",
      "        run: echo hi",
      "        constraints:",
      "          max_cost_class: low",
    ].join("\n");
    const yaml = makeYaml(VALID_MODELS, stepBlock);
    expect(() => loadWorkflow(yaml)).toThrow(/model constraints are only valid on agent steps/);
  });

  it("rejects an unknown routing_policy objective value (Phase 4)", () => {
    const stepBlock = [
      "      - id: a1",
      "        type: agent",
      "        allow_generic_prompt: true",
      "        uses: zigma/analyze-skill",
      "        constraints:",
      "          routing_policy:",
      "            objective: cheapest_token_price",
    ].join("\n");
    expect(() => loadWorkflow(makeYaml("", stepBlock))).toThrow(
      /constraints\.routing_policy\.objective/,
    );
  });

  it("rejects unknown keys inside routing_policy (strict)", () => {
    const stepBlock = [
      "      - id: a1",
      "        type: agent",
      "        allow_generic_prompt: true",
      "        uses: zigma/analyze-skill",
      "        constraints:",
      "          routing_policy:",
      "            objective: accepted_artifact_cost",
      "            weights: {}",
    ].join("\n");
    expect(() => loadWorkflow(makeYaml("", stepBlock))).toThrow(
      /constraints\.routing_policy/,
    );
  });

  it("rejects a non-boolean local_required", () => {
    const stepBlock = [
      "      - id: a1",
      "        type: agent",
      "        allow_generic_prompt: true",
      "        uses: zigma/analyze-skill",
      "        constraints:",
      '          local_required: "yes"',
    ].join("\n");
    expect(() => loadWorkflow(makeYaml("", stepBlock))).toThrow(/constraints\.local_required/);
  });

  it("rejects a non-array regions value", () => {
    const stepBlock = [
      "      - id: a1",
      "        type: agent",
      "        allow_generic_prompt: true",
      "        uses: zigma/analyze-skill",
      "        constraints:",
      "          regions: us-east-1",
    ].join("\n");
    expect(() => loadWorkflow(makeYaml("", stepBlock))).toThrow(/constraints\.regions/);
  });

  it("rejects an invalid max_cost_class enum value on a step", () => {
    const stepBlock = [
      "      - id: a1",
      "        type: agent",
      "        allow_generic_prompt: true",
      "        uses: zigma/analyze-skill",
      "        constraints:",
      "          max_cost_class: cheap",
    ].join("\n");
    expect(() => loadWorkflow(makeYaml("", stepBlock))).toThrow(/constraints\.max_cost_class/);
  });
});
