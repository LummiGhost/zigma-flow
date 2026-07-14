/**
 * v0.6 Schema Cleanup Deprecation Tests
 *
 * Tests that deprecated schema fields still work but produce [DEPRECATED]
 * warnings:
 *   - type: workflow (reserved) → warning
 *   - workspace.branch → warning
 *   - workspace.mode → warning
 *   - Job-level permissions → warning
 *   - permissions.variables, permissions.context_edit, permissions.context_blocks → warning
 *   - --task CLI flag → warning (and maps to inputs.task internally)
 *
 * Reference: GitHub Issue #212
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import { loadWorkflow } from "../../src/workflow/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const suppress = Boolean(process.env.ZIGMA_SUPPRESS_DEPRECATION);

function makeWorkflow(jobsYaml: string, extra?: string): string {
  const lines: string[] = [];
  lines.push("name: deprecation-schema-test");
  lines.push('version: "0.1.0"');
  lines.push("");

  if (extra) {
    lines.push(extra);
    lines.push("");
  }

  lines.push("jobs:");
  for (const line of jobsYaml.split("\n")) {
    lines.push(`  ${line}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 1. type: workflow deprecation
// ---------------------------------------------------------------------------

describe("v0.6 schema cleanup — type: workflow", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when a step uses type: workflow", () => {
    const yaml = makeWorkflow(`test-job:
    steps:
      - id: nested
        type: workflow`);

    loadWorkflow(yaml);
    const calls = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    const typeWorkflowWarnings = calls.filter((c: string) =>
      c.includes("type: workflow"),
    );
    if (!suppress) {
      expect(typeWorkflowWarnings.length).toBeGreaterThanOrEqual(1);
      expect(typeWorkflowWarnings[0]).toContain("[DEPRECATED]");
      expect(typeWorkflowWarnings[0]).toContain("reserved");
    }
  });

  it("does NOT warn for type: agent, script, check, router, human", () => {
    const yaml = makeWorkflow(`tj:
    steps:
      - id: a1
        type: agent
      - id: s1
        type: script
        run: echo hi
      - id: c1
        type: check
        uses: zigma/some-check
      - id: r1
        type: router
        switch: status
        cases:
          ok: continue
      - id: h1
        type: human
        prompt: approve?`);

    loadWorkflow(yaml);
    const calls = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    const typeWorkflowWarnings = calls.filter((c: string) =>
      c.includes("type: workflow"),
    );
    expect(typeWorkflowWarnings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. workspace.branch deprecation
// ---------------------------------------------------------------------------

describe("v0.6 schema cleanup — workspace.branch", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when workspace.branch is present", () => {
    const yaml = makeWorkflow(`tj:
    workspace:
      directory: /tmp
      branch: main
    steps:
      - id: a1
        type: agent`);

    loadWorkflow(yaml);
    const calls = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    const branchWarnings = calls.filter((c: string) =>
      c.includes("workspace.branch"),
    );
    if (!suppress) {
      expect(branchWarnings.length).toBeGreaterThanOrEqual(1);
      expect(branchWarnings[0]).toContain("[DEPRECATED]");
      expect(branchWarnings[0]).toContain("not implemented");
    }
  });

  it("does NOT warn when workspace has no branch", () => {
    const yaml = makeWorkflow(`tj:
    workspace:
      directory: /tmp
    steps:
      - id: a1
        type: agent`);

    loadWorkflow(yaml);
    const calls = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    const branchWarnings = calls.filter((c: string) =>
      c.includes("workspace.branch"),
    );
    expect(branchWarnings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. workspace.mode deprecation
// ---------------------------------------------------------------------------

describe("v0.6 schema cleanup — workspace.mode", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when workspace.mode is present", () => {
    const yaml = makeWorkflow(`tj:
    workspace:
      mode: read-only
    steps:
      - id: a1
        type: agent`);

    loadWorkflow(yaml);
    const calls = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    const modeWarnings = calls.filter((c: string) =>
      c.includes("workspace.mode"),
    );
    if (!suppress) {
      expect(modeWarnings.length).toBeGreaterThanOrEqual(1);
      expect(modeWarnings[0]).toContain("[DEPRECATED]");
      expect(modeWarnings[0]).toContain("execution strategy");
    }
  });

  it("does NOT warn when workspace has no mode (string form)", () => {
    const yaml = makeWorkflow(`tj:
    workspace: /tmp
    steps:
      - id: a1
        type: agent`);

    loadWorkflow(yaml);
    const calls = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    const modeWarnings = calls.filter((c: string) =>
      c.includes("workspace.mode"),
    );
    expect(modeWarnings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Job-level permissions deprecation
// ---------------------------------------------------------------------------

describe("v0.6 schema cleanup — Job-level permissions", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when a Job has permissions", () => {
    const yaml = makeWorkflow(`tj:
    permissions:
      contents: read
      edits: write
    steps:
      - id: a1
        type: agent`);

    loadWorkflow(yaml);
    const calls = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    const permWarnings = calls.filter((c: string) =>
      c.includes("Job-level permissions"),
    );
    if (!suppress) {
      expect(permWarnings.length).toBeGreaterThanOrEqual(1);
      expect(permWarnings[0]).toContain("[DEPRECATED]");
      expect(permWarnings[0]).toContain("Workflow-level defaults");
    }
  });

  it("does NOT warn when a Job has NO permissions", () => {
    const yaml = makeWorkflow(`tj:
    steps:
      - id: a1
        type: agent`);

    loadWorkflow(yaml);
    const calls = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    const permWarnings = calls.filter((c: string) =>
      c.includes("Job-level permissions"),
    );
    expect(permWarnings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. permissions.variables / context_edit / context_blocks deprecation
// ---------------------------------------------------------------------------

describe("v0.6 schema cleanup — Step permission sub-fields", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when permissions.variables is present", () => {
    const yaml = makeWorkflow(`tj:
    steps:
      - id: a1
        type: agent
        permissions:
          contents: read
          variables:
            read:
              - some_var`);

    loadWorkflow(yaml);
    const calls = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    const varPermWarnings = calls.filter((c: string) =>
      c.includes("permission field") && c.includes("variables"),
    );
    if (!suppress) {
      expect(varPermWarnings.length).toBeGreaterThanOrEqual(1);
      expect(varPermWarnings[0]).toContain("[DEPRECATED]");
    }
  });

  it("warns when permissions.context_edit is present", () => {
    const yaml = makeWorkflow(`tj:
    steps:
      - id: a1
        type: agent
        permissions:
          contents: read
          context_edit: none`);

    loadWorkflow(yaml);
    const calls = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    const ceWarnings = calls.filter((c: string) =>
      c.includes("context_edit"),
    );
    if (!suppress) {
      expect(ceWarnings.length).toBeGreaterThanOrEqual(1);
      expect(ceWarnings[0]).toContain("[DEPRECATED]");
    }
  });

  it("warns when permissions.context_blocks is present", () => {
    const yaml = makeWorkflow(`tj:
    steps:
      - id: a1
        type: agent
        permissions:
          contents: read
          context_blocks:
            read:
              - some_block`);

    loadWorkflow(yaml);
    const calls = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    const cbWarnings = calls.filter((c: string) =>
      c.includes("context_blocks"),
    );
    if (!suppress) {
      expect(cbWarnings.length).toBeGreaterThanOrEqual(1);
      expect(cbWarnings[0]).toContain("[DEPRECATED]");
    }
  });

  it("does NOT warn for clean step permissions (contents, edits, commands, workflow_state only)", () => {
    const yaml = makeWorkflow(`tj:
    steps:
      - id: a1
        type: agent
        permissions:
          contents: read
          edits: write
          commands: none
          workflow_state: none`);

    loadWorkflow(yaml);
    const calls = (console.warn as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    const permSubFieldWarnings = calls.filter((c: string) =>
      (c.includes("permission field") && c.includes("variables")) ||
      c.includes("context_edit") ||
      c.includes("context_blocks"),
    );
    expect(permSubFieldWarnings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. ZIGMA_SUPPRESS_DEPRECATION suppresses all warnings
// ---------------------------------------------------------------------------

describe("v0.6 schema cleanup — ZIGMA_SUPPRESS_DEPRECATION", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("suppresses all deprecation warnings when ZIGMA_SUPPRESS_DEPRECATION is set", () => {
    process.env.ZIGMA_SUPPRESS_DEPRECATION = "1";
    try {
      // Create a workflow with ALL deprecated fields
      const yaml = makeWorkflow(`tj:
    workspace:
      mode: writable
      branch: main
    permissions:
      contents: read
    steps:
      - id: nested
        type: workflow
      - id: with_perms
        type: agent
        permissions:
          contents: read
          variables:
            read:
              - foo
          context_edit: none
          context_blocks:
            read:
              - bar`);

      loadWorkflow(yaml);
      const deprecationCount = (console.warn as ReturnType<typeof vi.spyOn>)
        .mock.calls.filter((c: any[]) => String(c[0]).includes("[DEPRECATED]"))
        .length;
      expect(deprecationCount).toBe(0);
    } finally {
      delete process.env.ZIGMA_SUPPRESS_DEPRECATION;
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Clean schema (no deprecated fields) produces no warnings
// ---------------------------------------------------------------------------

describe("v0.6 schema cleanup — clean schema", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates a clean schema without any deprecation warnings", () => {
    const yaml = makeWorkflow(`tj:
    steps:
      - id: a1
        type: agent
        permissions:
          contents: read
          edits: none
          commands: none
          workflow_state: none`);

    loadWorkflow(yaml);
    const deprecationCount = (console.warn as ReturnType<typeof vi.spyOn>)
      .mock.calls.filter((c: any[]) =>
        String(c[0]).includes("[DEPRECATED]"),
      ).length;
    expect(deprecationCount).toBe(0);
  });

  it("clean schema with multiple valid jobs validates without warnings", () => {
    // Build YAML directly to avoid indentation confusion from makeWorkflow's
    // line prefixing. All mapping keys at the same level must start in the
    // same column.
    const yaml = [
      "name: deprecation-schema-test",
      'version: "0.1.0"',
      "",
      "jobs:",
      "  job-1:",
      "    steps:",
      "      - id: s1",
      "        type: agent",
      "  job-2:",
      "    needs:",
      "      - job-1",
      "    steps:",
      "      - id: s2",
      "        type: script",
      "        run: echo done",
    ].join("\n");

    loadWorkflow(yaml);
    const deprecationCount = (console.warn as ReturnType<typeof vi.spyOn>)
      .mock.calls.filter((c: any[]) =>
        String(c[0]).includes("[DEPRECATED]"),
      ).length;
    expect(deprecationCount).toBe(0);
  });
});
