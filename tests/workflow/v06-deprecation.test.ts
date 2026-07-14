/**
 * v0.6 deprecation warning tests (Issue #209).
 *
 * Validates that each deprecated feature prints a warning to stderr
 * while still functioning normally. Also validates that clean workflows
 * produce no warnings, and that ZIGMA_SUPPRESS_DEPRECATION suppresses them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorkflow } from "../../src/workflow/index.js";
import { validateReportShape } from "../../src/engine/accept.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress ZIGMA_SUPPRESS_DEPRECATION during test setup. */
function suppressDeprecation() {
  vi.stubEnv("ZIGMA_SUPPRESS_DEPRECATION", "1");
}

function allowDeprecation() {
  vi.stubEnv("ZIGMA_SUPPRESS_DEPRECATION", undefined);
}

function minimalWorkflow(extra: string): string {
  return `name: test-wf
version: 0.6.0

jobs:
  hello:
    steps:
      - id: greet
        type: agent
        prompt: hello
${extra}`;
}

/**
 * Load the workflow and collect deprecation warnings from stderr.
 */
function loadAndCollectWarnings(yaml: string): string[] {
  const warnings: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((msg: string) => {
    if (msg.startsWith("[DEPRECATED]")) {
      warnings.push(msg);
    }
  });
  try {
    loadWorkflow(yaml);
  } finally {
    spy.mockRestore();
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// TC-DEP-01: Clean workflow produces no deprecation warnings
// ---------------------------------------------------------------------------

describe("TC-DEP-01: clean workflow", () => {
  beforeEach(() => allowDeprecation());

  it("produces no deprecation warnings for a clean modern workflow", () => {
    const yaml = minimalWorkflow(`
      - id: build
        type: script
        run: 'echo ok'
    `);
    const warnings = loadAndCollectWarnings(yaml);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TC-DEP-02: Deprecated signals warning (top-level)
// ---------------------------------------------------------------------------

describe("TC-DEP-02: signals deprecation", () => {
  beforeEach(() => allowDeprecation());

  it("warns when top-level signals is present", () => {
    const yaml = `name: test-wf
version: 0.6.0

signals:
  emergency:
    severity: critical
    priority: 100
    allowed_from:
      - hello
    action:
      fail

jobs:
  hello:
    steps:
      - id: greet
        type: agent
        prompt: hello
`;
    const warnings = loadAndCollectWarnings(yaml);
    expect(warnings).toContain(
      "[DEPRECATED] The signals system is deprecated. Use returns/on_return for agent flow control. This will be removed in v1.0."
    );
  });

  it("warns about signal priority, severity, and allowed_from", () => {
    const yaml = `name: test-wf
version: 0.6.0

signals:
  emergency:
    severity: critical
    priority: 100
    allowed_from:
      - hello
    action:
      fail

jobs:
  hello:
    steps:
      - id: greet
        type: agent
        prompt: hello
`;
    const warnings = loadAndCollectWarnings(yaml);
    // Should warn about each signal-related field
    expect(warnings.some((w) => w.includes("priority"))).toBe(true);
    expect(warnings.some((w) => w.includes("severity"))).toBe(true);
    expect(warnings.some((w) => w.includes("allowed_from"))).toBe(true);
  });

  it("signals still work (workflow loads normally)", () => {
    const yaml = `name: test-wf
version: 0.6.0

signals:
  ok_signal:
    action:
      continue

jobs:
  hello:
    steps:
      - id: greet
        type: agent
        prompt: hello
`;
    // Should not throw — deprecated feature still works
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TC-DEP-03: Deprecated RouterAction warnings (goto_step, goto_job, goto_with, retry_with)
// ---------------------------------------------------------------------------

describe("TC-DEP-03: RouterAction deprecation", () => {
  beforeEach(() => allowDeprecation());

  it("warns about goto_step", () => {
    const yaml = minimalWorkflow(`
      - id: router
        type: router
        switch: status
        cases:
          redo:
            goto_step: greet
    `);
    const warnings = loadAndCollectWarnings(yaml);
    expect(warnings.some((w) => w.includes("goto_step"))).toBe(true);
  });

  it("warns about goto_job", () => {
    const yaml = minimalWorkflow(`
      - id: router
        type: router
        switch: status
        cases:
          skip:
            goto_job: hello
    `);
    const warnings = loadAndCollectWarnings(yaml);
    expect(warnings.some((w) => w.includes("goto_job"))).toBe(true);
  });

  it("warns about goto_with (alongside goto_step)", () => {
    const yaml = minimalWorkflow(`
      - id: router
        type: router
        switch: status
        cases:
          redo:
            goto_step: greet
            goto_with:
              reason: "retry"
    `);
    const warnings = loadAndCollectWarnings(yaml);
    expect(warnings.some((w) => w.includes("goto_with"))).toBe(true);
  });

  it("warns about retry_with in RouterAction", () => {
    const yaml = minimalWorkflow(`
      - id: router
        type: router
        switch: status
        cases:
          redo:
            retry_job: hello
            retry_with:
              reason: "fix"
    `);
    const warnings = loadAndCollectWarnings(yaml);
    expect(warnings.some((w) => w.includes("retry_with"))).toBe(true);
  });

  it("deprecated RouterAction features still work (workflow loads normally)", () => {
    const yaml = minimalWorkflow(`
      - id: router
        type: router
        switch: status
        cases:
          redo:
            goto_step: greet
            goto_with:
              reason: "retry"
          skip:
            goto_job: hello
    `);
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TC-DEP-04: Deprecated max_visits warning
// ---------------------------------------------------------------------------

describe("TC-DEP-04: max_visits deprecation", () => {
  beforeEach(() => allowDeprecation());

  it("warns about max_visits on a step", () => {
    const yaml = `name: test-wf
version: 0.6.0

jobs:
  hello:
    steps:
      - id: greet
        type: agent
        prompt: hello
        max_visits: 5
`;
    const warnings = loadAndCollectWarnings(yaml);
    expect(warnings.some((w) => w.includes("max_visits"))).toBe(true);
  });

  it("max_visits still works (workflow loads normally)", () => {
    const yaml = `name: test-wf
version: 0.6.0

jobs:
  hello:
    steps:
      - id: greet
        type: agent
        prompt: hello
        max_visits: 5
`;
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TC-DEP-05: Deprecated optional_needs warning
// ---------------------------------------------------------------------------

describe("TC-DEP-05: optional_needs deprecation", () => {
  beforeEach(() => allowDeprecation());

  it("warns about optional_needs on a job", () => {
    const yaml = `name: test-wf
version: 0.6.0

jobs:
  hello:
    steps:
      - id: greet
        type: agent
        prompt: hello
  world:
    needs:
      - hello
    optional_needs:
      - hello
    steps:
      - id: greet2
        type: agent
        prompt: hello
`;
    const warnings = loadAndCollectWarnings(yaml);
    expect(warnings.some((w) => w.includes("optional_needs"))).toBe(true);
  });

  it("optional_needs still works (workflow loads normally)", () => {
    const yaml = `name: test-wf
version: 0.6.0

jobs:
  hello:
    steps:
      - id: greet
        type: agent
        prompt: hello
  world:
    needs:
      - hello
    optional_needs:
      - hello
    steps:
      - id: greet2
        type: agent
        prompt: hello
`;
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TC-DEP-06: Deprecated activation: manual warning
// ---------------------------------------------------------------------------

describe("TC-DEP-06: activation: manual deprecation", () => {
  beforeEach(() => allowDeprecation());

  it("warns about activation: manual on a job", () => {
    const yaml = `name: test-wf
version: 0.6.0

jobs:
  hello:
    activation: manual
    steps:
      - id: greet
        type: agent
        prompt: hello
`;
    const warnings = loadAndCollectWarnings(yaml);
    expect(warnings.some((w) => w.includes("activation: manual"))).toBe(true);
  });

  it("activation: optional does NOT warn", () => {
    const yaml = `name: test-wf
version: 0.6.0

jobs:
  hello:
    activation: optional
    steps:
      - id: greet
        type: agent
        prompt: hello
`;
    const warnings = loadAndCollectWarnings(yaml);
    expect(warnings.some((w) => w.includes("activation"))).toBe(false);
  });

  it("activation: manual still works (workflow loads normally)", () => {
    const yaml = `name: test-wf
version: 0.6.0

jobs:
  hello:
    activation: manual
    steps:
      - id: greet
        type: agent
        prompt: hello
`;
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TC-DEP-07: Deprecated type: check warning
// ---------------------------------------------------------------------------

describe("TC-DEP-07: type: check deprecation", () => {
  beforeEach(() => allowDeprecation());

  it("warns about type: check on a step", () => {
    const yaml = `name: test-wf
version: 0.6.0

jobs:
  hello:
    steps:
      - id: validate
        type: check
        uses: zigma/file-exists
        with:
          file: something.txt
        on_fail: fail
`;
    const warnings = loadAndCollectWarnings(yaml);
    expect(warnings.some((w) => w.includes("type: check"))).toBe(true);
  });

  it("type: check still works (workflow loads normally)", () => {
    const yaml = `name: test-wf
version: 0.6.0

jobs:
  hello:
    steps:
      - id: validate
        type: check
        uses: zigma/file-exists
        with:
          file: something.txt
        on_fail: fail
`;
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TC-DEP-08: Deprecated retry_with on job config
// ---------------------------------------------------------------------------

describe("TC-DEP-08: retry_with deprecation", () => {
  beforeEach(() => allowDeprecation());

  it("warns about retry_with on job retry config", () => {
    const yaml = `name: test-wf
version: 0.6.0

jobs:
  hello:
    retry:
      max_attempts: 3
      retry_with:
        reason: fix
    steps:
      - id: greet
        type: agent
        prompt: hello
`;
    const warnings = loadAndCollectWarnings(yaml);
    expect(warnings.some((w) => w.includes("retry_with"))).toBe(true);
  });

  it("retry_with still works (workflow loads normally)", () => {
    const yaml = `name: test-wf
version: 0.6.0

jobs:
  hello:
    retry:
      max_attempts: 3
      retry_with:
        reason: fix
    steps:
      - id: greet
        type: agent
        prompt: hello
`;
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TC-DEP-09: Clean returns/on_return pattern works without warnings
// ---------------------------------------------------------------------------

describe("TC-DEP-09: returns/on_return clean pattern", () => {
  beforeEach(() => allowDeprecation());

  it("returns/on_return produces no deprecation warnings", () => {
    const yaml = `name: test-wf
version: 0.6.0

jobs:
  review:
    steps:
      - id: review
        type: agent
        prompt: review
        outputs:
          verdict: {}
        returns:
          status:
            values:
              - approved
              - rejected
        on_return:
          rejected:
            retry_job: implement
  implement:
    steps:
      - id: implement
        type: agent
        prompt: implement
`;
    const warnings = loadAndCollectWarnings(yaml);
    // retry_job in on_return is a supported pattern — but retry_with
    // may still trigger if present. The clean pattern should have
    // no deprecated features.
    expect(warnings.filter((w) => w.includes("[DEPRECATED]")).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TC-DEP-10: ZIGMA_SUPPRESS_DEPRECATION suppresses warnings
// ---------------------------------------------------------------------------

describe("TC-DEP-10: ZIGMA_SUPPRESS_DEPRECATION", () => {
  beforeEach(() => suppressDeprecation());

  it("suppresses all deprecation warnings when env var is set", () => {
    const yaml = `name: test-wf
version: 0.6.0

signals:
  emergency:
    action:
      fail

jobs:
  hello:
    activation: manual
    optional_needs:
      - hello
    steps:
      - id: greet
        type: check
        uses: zigma/file-exists
        with:
          file: something.txt
        max_visits: 5
        on_fail: fail
`;
    const warnings = loadAndCollectWarnings(yaml);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TC-DEP-11: Agent report signals deprecation
// ---------------------------------------------------------------------------

describe("TC-DEP-11: Agent report signals deprecation", () => {
  it("validateReportShape returns a report with signals field", () => {
    const report = {
      outputs: { key: "value" },
      artifacts: [],
      signals: [{ type: "emergency", reason: "test" }],
      summary: "test summary",
    };
    // validateReportShape should not throw — it just validates the shape
    // (the actual deprecation warning fires in acceptAgentReport, not here)
    const parsed = validateReportShape(report);
    expect(parsed.signals).toHaveLength(1);
    expect(parsed.signals[0]!.type).toBe("emergency");
  });
});

// ---------------------------------------------------------------------------
// TC-DEP-12: activation: manual treated as optional for needs satisfaction
// ---------------------------------------------------------------------------

describe("TC-DEP-12: activation semantics", () => {
  it("activation: manual job in needs does not block readiness (treated as optional)", async () => {
    const { computeReadyJobs } = await import("../../src/dag/index.js");
    const jobs = {
      intake: {
        needs: [] as string[],
      },
      optional_job: {
        needs: ["intake"] as string[],
        activation: "manual" as const, // deprecated but treated as optional
      },
      downstream: {
        needs: ["intake", "optional_job"] as string[],
      },
    };
    // intake completed, optional_job is inactive → downstream should still be ready
    // because optional_job has activation: manual which is treated as optional
    const completed = new Set(["intake"]);
    const active = new Set<string>();
    const ready = computeReadyJobs(jobs, completed, active);
    // downstream should be ready because optional_job with activation is treated as satisfied
    expect(ready).toContain("downstream");
  });

  it("activation: optional job in needs does not block readiness", async () => {
    const { computeReadyJobs } = await import("../../src/dag/index.js");
    const jobs = {
      intake: {
        needs: [] as string[],
      },
      optional_job: {
        needs: ["intake"] as string[],
        activation: "optional" as const,
      },
      downstream: {
        needs: ["intake", "optional_job"] as string[],
      },
    };
    const completed = new Set(["intake"]);
    const active = new Set<string>();
    const ready = computeReadyJobs(jobs, completed, active);
    expect(ready).toContain("downstream");
  });
});
