/**
 * Traverse schema validation tests (WF-P16-TRAVERSE, Issue #179).
 *
 * Covers:
 *   - Valid TraverseDefinition in workflow YAML
 *   - Invalid input expression (not ${{ }})
 *   - Invalid target.job (references non-existent job)
 *   - Invalid item_context.key (not a valid variable name)
 *   - Concurrency bounds enforcement (1-10)
 *   - on_item_failure enum validation
 *   - Traverse ID conflicts with job ID
 */

import { describe, expect, it } from "vitest";

import { loadWorkflow } from "../../src/workflow/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTraverseYaml(overrides?: Record<string, unknown>): string {
  const opts = overrides ?? {};
  const input = opts.input as string ?? "${{ jobs.list.outputs.items }}";
  const concurrency = opts.concurrency as number | undefined;
  const onItemFailure = opts.on_item_failure as string | undefined;
  const targetJob = opts.target_job as string ?? "process-item";
  const itemKey = opts.item_key as string ?? "item";

  const concurrencyLine = concurrency !== undefined ? `    concurrency: ${concurrency}\n` : "";
  const onItemFailureLine = onItemFailure !== undefined ? `    on_item_failure: ${onItemFailure}\n` : "";

  return [
    'name: test-traverse',
    'version: "1.0"',
    'jobs:',
    '  discover:',
    "    steps:",
    '      - id: s1',
    "        type: script",
    "        run: echo items",
    "        outputs:",
    "          items: string",
    '  process-item:',
    "    steps:",
    '      - id: p1',
    "        type: script",
    "        run: echo process",
    'traverse:',
    '  process-items:',
    `    input: "${input}"`,
    concurrencyLine,
    onItemFailureLine,
    '    target:',
    `      job: ${targetJob}`,
    '    item_context:',
    `      key: ${itemKey}`,
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Valid traverse
// ---------------------------------------------------------------------------

describe("TraverseDefinition schema — valid", () => {
  it("accepts a valid traverse definition", () => {
    const yaml = makeTraverseYaml();
    const wf = loadWorkflow(yaml);
    expect(wf.traverse).toBeDefined();
    expect(wf.traverse!["process-items"]).toBeDefined();
    expect(wf.traverse!["process-items"]!.input).toBe("${{ jobs.list.outputs.items }}");
    expect(wf.traverse!["process-items"]!.target.job).toBe("process-item");
    expect(wf.traverse!["process-items"]!.item_context.key).toBe("item");
  });

  it("accepts traverse with concurrency and on_item_failure", () => {
    const yaml = makeTraverseYaml({ concurrency: 5, on_item_failure: "continue" });
    const wf = loadWorkflow(yaml);
    expect(wf.traverse!["process-items"]!.concurrency).toBe(5);
    expect(wf.traverse!["process-items"]!.on_item_failure).toBe("continue");
  });

  it("accepts traverse with index_key", () => {
    const yaml = [
      'name: test-traverse',
      'version: "1.0"',
      'jobs:',
      '  discover:',
      "    steps:",
      '      - id: s1',
      "        type: script",
      "        run: echo items",
      "        outputs:",
      "          items: string",
      '  process-item:',
      "    steps:",
      '      - id: p1',
      "        type: script",
      "        run: echo process",
      'traverse:',
      '  process-items:',
      '    input: "${{ jobs.discover.outputs.items }}"',
      '    target:',
      '      job: process-item',
      '    item_context:',
      '      key: item',
      '      index_key: item_index',
    ].join("\n");
    const wf = loadWorkflow(yaml);
    expect(wf.traverse!["process-items"]!.item_context.index_key).toBe("item_index");
  });

  it("accepts traverse with outputs", () => {
    const yaml = [
      'name: test-traverse',
      'version: "1.0"',
      'jobs:',
      '  discover:',
      "    steps:",
      '      - id: s1',
      "        type: script",
      "        run: echo items",
      "        outputs:",
      "          items: string",
      '  process-item:',
      "    steps:",
      '      - id: p1',
      "        type: script",
      "        run: echo process",
      'traverse:',
      '  process-items:',
      '    input: "${{ jobs.discover.outputs.items }}"',
      '    target:',
      '      job: process-item',
      '    item_context:',
      '      key: item',
      '    outputs:',
      '      results: "${{ each.outputs.result }}"',
    ].join("\n");
    const wf = loadWorkflow(yaml);
    expect(wf.traverse!["process-items"]!.outputs).toEqual({
      results: "${{ each.outputs.result }}",
    });
  });

  it("defaults concurrency to undefined (will be 1 at runtime)", () => {
    const yaml = makeTraverseYaml();
    const wf = loadWorkflow(yaml);
    expect(wf.traverse!["process-items"]!.concurrency).toBeUndefined();
  });

  it("defaults on_item_failure to undefined (will be fail_all at runtime)", () => {
    const yaml = makeTraverseYaml();
    const wf = loadWorkflow(yaml);
    expect(wf.traverse!["process-items"]!.on_item_failure).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Invalid traverse — input expression
// ---------------------------------------------------------------------------

describe("TraverseDefinition schema — invalid input", () => {
  it("rejects input that is not a ${{ }} expression", () => {
    const yaml = [
      'name: test-traverse',
      'version: "1.0"',
      'jobs:',
      '  discover:',
      "    steps:",
      '      - id: s1',
      "        type: script",
      "        run: echo items",
      "        outputs:",
      "          items: string",
      '  process-item:',
      "    steps:",
      '      - id: p1',
      "        type: script",
      "        run: echo process",
      'traverse:',
      '  process-items:',
      '    input: "not-an-expression"',
      '    target:',
      '      job: process-item',
      '    item_context:',
      '      key: item',
    ].join("\n");
    expect(() => loadWorkflow(yaml)).toThrow(
      /traverse "process-items" input must be a \${{ }} expression/,
    );
  });

  it("rejects input with arithmetic in expression", () => {
    const yaml = makeTraverseYaml({ input: "${{ 1 + 2 }}" });
    expect(() => loadWorkflow(yaml)).toThrow(/Arithmetic expressions are not supported/);
  });

  it("rejects input with function call in expression", () => {
    const yaml = makeTraverseYaml({ input: "${{ foo.bar() }}" });
    expect(() => loadWorkflow(yaml)).toThrow(/Function calls are not supported/);
  });
});

// ---------------------------------------------------------------------------
// Invalid traverse — target job
// ---------------------------------------------------------------------------

describe("TraverseDefinition schema — invalid target", () => {
  it("rejects target.job that references a non-existent job", () => {
    const yaml = makeTraverseYaml({ target_job: "ghost-job" });
    expect(() => loadWorkflow(yaml)).toThrow(
      /traverse "process-items" target.job "ghost-job" does not reference an existing job/,
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid traverse — item_context
// ---------------------------------------------------------------------------

describe("TraverseDefinition schema — invalid item_context", () => {
  it("rejects item_context.key that is not a valid variable name", () => {
    const yaml = [
      'name: test-traverse',
      'version: "1.0"',
      'jobs:',
      '  discover:',
      "    steps:",
      '      - id: s1',
      "        type: script",
      "        run: echo items",
      "        outputs:",
      "          items: string",
      '  process-item:',
      "    steps:",
      '      - id: p1',
      "        type: script",
      "        run: echo process",
      'traverse:',
      '  process-items:',
      '    input: "${{ jobs.discover.outputs.items }}"',
      '    target:',
      '      job: process-item',
      '    item_context:',
      '      key: "123-invalid"',
    ].join("\n");
    expect(() => loadWorkflow(yaml)).toThrow(
      /traverse "process-items" item_context.key "123-invalid" is not a valid variable name/,
    );
  });

  it("rejects item_context.index_key that is not a valid variable name", () => {
    const yaml = [
      'name: test-traverse',
      'version: "1.0"',
      'jobs:',
      '  discover:',
      "    steps:",
      '      - id: s1',
      "        type: script",
      "        run: echo items",
      "        outputs:",
      "          items: string",
      '  process-item:',
      "    steps:",
      '      - id: p1',
      "        type: script",
      "        run: echo process",
      'traverse:',
      '  process-items:',
      '    input: "${{ jobs.discover.outputs.items }}"',
      '    target:',
      '      job: process-item',
      '    item_context:',
      '      key: item',
      '      index_key: "@bad"',
    ].join("\n");
    expect(() => loadWorkflow(yaml)).toThrow(
      /traverse "process-items" item_context.index_key "@bad" is not a valid variable name/,
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid traverse — concurrency bounds
// ---------------------------------------------------------------------------

describe("TraverseDefinition schema — invalid concurrency", () => {
  it("rejects concurrency below 1 (zod validation)", () => {
    const yaml = makeTraverseYaml({ concurrency: 0 });
    expect(() => loadWorkflow(yaml)).toThrow(/concurrency/);
  });

  it("rejects concurrency above 10 (zod validation)", () => {
    const yaml = makeTraverseYaml({ concurrency: 11 });
    expect(() => loadWorkflow(yaml)).toThrow(/concurrency/);
  });
});

// ---------------------------------------------------------------------------
// Invalid traverse — on_item_failure enum
// ---------------------------------------------------------------------------

describe("TraverseDefinition schema — invalid on_item_failure", () => {
  it("rejects on_item_failure with invalid value (zod validation)", () => {
    const yaml = makeTraverseYaml({ on_item_failure: "skip" });
    expect(() => loadWorkflow(yaml)).toThrow(/on_item_failure/);
  });
});

// ---------------------------------------------------------------------------
// Invalid traverse — id conflict with job
// ---------------------------------------------------------------------------

describe("TraverseDefinition schema — id conflicts", () => {
  it("rejects traverse id that conflicts with a job id", () => {
    const yaml = [
      'name: test-traverse',
      'version: "1.0"',
      'jobs:',
      '  discover:',
      "    steps:",
      '      - id: s1',
      "        type: script",
      "        run: echo items",
      "        outputs:",
      "          items: string",
      '  process-item:',
      "    steps:",
      '      - id: p1',
      "        type: script",
      "        run: echo process",
      'traverse:',
      '  discover:',
      '    input: "${{ jobs.discover.outputs.items }}"',
      '    target:',
      '      job: process-item',
      '    item_context:',
      '      key: item',
    ].join("\n");
    expect(() => loadWorkflow(yaml)).toThrow(
      /traverse id "discover" conflicts with an existing job id/,
    );
  });
});

// ---------------------------------------------------------------------------
// Zod schema rejection — missing required fields
// ---------------------------------------------------------------------------

describe("TraverseDefinition schema — zod rejects malformed traverse", () => {
  it("rejects traverse missing input", () => {
    const yaml = [
      'name: test-traverse',
      'version: "1.0"',
      'jobs:',
      '  discover:',
      "    steps:",
      '      - id: s1',
      "        type: script",
      "        run: echo items",
      '  process-item:',
      "    steps:",
      '      - id: p1',
      "        type: script",
      "        run: echo process",
      'traverse:',
      '  process-items:',
      '    target:',
      '      job: process-item',
      '    item_context:',
      '      key: item',
    ].join("\n");
    expect(() => loadWorkflow(yaml)).toThrow(/input/);
  });

  it("rejects traverse missing target", () => {
    const yaml = [
      'name: test-traverse',
      'version: "1.0"',
      'jobs:',
      '  discover:',
      "    steps:",
      '      - id: s1',
      "        type: script",
      "        run: echo items",
      '  process-item:',
      "    steps:",
      '      - id: p1',
      "        type: script",
      "        run: echo process",
      'traverse:',
      '  process-items:',
      '    input: "${{ jobs.discover.outputs.items }}"',
      '    item_context:',
      '      key: item',
    ].join("\n");
    expect(() => loadWorkflow(yaml)).toThrow(/target/);
  });

  it("rejects traverse missing item_context.key", () => {
    const yaml = [
      'name: test-traverse',
      'version: "1.0"',
      'jobs:',
      '  discover:',
      "    steps:",
      '      - id: s1',
      "        type: script",
      "        run: echo items",
      '  process-item:',
      "    steps:",
      '      - id: p1',
      "        type: script",
      "        run: echo process",
      'traverse:',
      '  process-items:',
      '    input: "${{ jobs.discover.outputs.items }}"',
      '    target:',
      '      job: process-item',
      '    item_context:',
      '      index_key: idx',
    ].join("\n");
    expect(() => loadWorkflow(yaml)).toThrow(/key/);
  });
});
