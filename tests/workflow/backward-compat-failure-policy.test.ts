/**
 * Backward compatibility tests for on_failure -> failure_policy normalization (WF-7.3b).
 *
 * Tests that the workflow loader correctly normalizes old-style on_failure values
 * to the new failure_policy field while maintaining backward compatibility.
 *
 * Reference:
 *   - docs/phases/v0.7-execution-model/research/r4-failure-policy-cascade.md
 *   - docs/architecture.md section 7.4
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadWorkflow } from "../../src/workflow/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress deprecation warnings during tests. */
beforeEach(() => {
  vi.stubEnv("ZIGMA_SUPPRESS_DEPRECATION", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function load(yaml: string) {
  return loadWorkflow(yaml);
}

// ---------------------------------------------------------------------------
// BACKWARD COMPAT: on_failure string forms normalized to failure_policy
// ---------------------------------------------------------------------------

describe("on_failure -> failure_policy backward compat (WF-7.3b)", () => {
  it("normalizes on_failure: 'fail' to failure_policy: 'fail' (T-BC-OF-1)", () => {
    const wf = load(`
name: test
version: "1.0"
jobs:
  test-job:
    steps:
      - id: step-1
        type: script
        run: echo hello
        on_failure: fail
`);
    const step = wf.jobs["test-job"]!.steps[0]!;
    expect(step.failure_policy).toBe("fail");
  });

  it("normalizes on_failure: 'continue' to failure_policy: 'continue' (T-BC-OF-2)", () => {
    const wf = load(`
name: test
version: "1.0"
jobs:
  test-job:
    steps:
      - id: step-1
        type: script
        run: echo hello
        on_failure: continue
`);
    const step = wf.jobs["test-job"]!.steps[0]!;
    expect(step.failure_policy).toBe("continue");
  });

  it("normalizes on_failure: 'block' to failure_policy: 'block' (T-BC-OF-3)", () => {
    const wf = load(`
name: test
version: "1.0"
jobs:
  test-job:
    steps:
      - id: step-1
        type: script
        run: echo hello
        on_failure: block
`);
    const step = wf.jobs["test-job"]!.steps[0]!;
    expect(step.failure_policy).toBe("block");
  });

  it("normalizes on_failure: { status: 'failed' } to failure_policy: 'fail' (T-BC-OF-4)", () => {
    const wf = load(`
name: test
version: "1.0"
jobs:
  test-job:
    steps:
      - id: step-1
        type: script
        run: echo hello
        on_failure:
          status: failed
`);
    const step = wf.jobs["test-job"]!.steps[0]!;
    expect(step.failure_policy).toBe("fail");
  });

  it("normalizes on_failure: { status: 'blocked' } to failure_policy: 'block' (T-BC-OF-5)", () => {
    const wf = load(`
name: test
version: "1.0"
jobs:
  test-job:
    steps:
      - id: step-1
        type: script
        run: echo hello
        on_failure:
          status: blocked
`);
    const step = wf.jobs["test-job"]!.steps[0]!;
    expect(step.failure_policy).toBe("block");
  });

  it("failure_policy explicitly set takes precedence over on_failure (T-BC-OF-6)", () => {
    const wf = load(`
name: test
version: "1.0"
jobs:
  test-job:
    steps:
      - id: step-1
        type: script
        run: echo hello
        on_failure: fail
        failure_policy: continue
`);
    const step = wf.jobs["test-job"]!.steps[0]!;
    // failure_policy explicitly set wins over on_failure normalization
    expect(step.failure_policy).toBe("continue");
  });

  it("preserves object-form on_failure actions that can't be normalized (T-BC-OF-7)", () => {
    const wf = load(`
name: test
version: "1.0"
jobs:
  test-job:
    steps:
      - id: step-1
        type: router
        on_failure:
          retry_job: other-job
`);
    const step = wf.jobs["test-job"]!.steps[0]!;
    // The retry_job action cannot be normalized to failure_policy
    // on_failure should remain as-is, failure_policy should be undefined
    expect(step.failure_policy).toBeUndefined();
    expect(step.on_failure).toEqual({ retry_job: "other-job" });
  });

  it("preserves goto_step on_failure actions that can't be normalized (T-BC-OF-8)", () => {
    const wf = load(`
name: test
version: "1.0"
jobs:
  test-job:
    steps:
      - id: step-1
        type: router
        on_failure:
          goto_step: step-2
`);
    const step = wf.jobs["test-job"]!.steps[0]!;
    expect(step.failure_policy).toBeUndefined();
    expect(step.on_failure).toEqual({ goto_step: "step-2" });
  });

  it("handles multiple steps with mixed on_failure forms (T-BC-OF-9)", () => {
    const wf = load(`
name: test
version: "1.0"
jobs:
  test-job:
    steps:
      - id: step-1
        type: script
        run: echo hello
        on_failure: continue
      - id: step-2
        type: script
        run: echo world
        on_failure: fail
`);
    expect(wf.jobs["test-job"]!.steps[0]!.failure_policy).toBe("continue");
    expect(wf.jobs["test-job"]!.steps[1]!.failure_policy).toBe("fail");
  });

  it("leaves failure_policy undefined when on_failure is absent (T-BC-OF-10)", () => {
    const wf = load(`
name: test
version: "1.0"
jobs:
  test-job:
    steps:
      - id: step-1
        type: agent
`);
    const step = wf.jobs["test-job"]!.steps[0]!;
    expect(step.failure_policy).toBeUndefined();
    expect(step.on_failure).toBeUndefined();
  });

  it("always_valid failure_policy can be set directly at job level (T-BC-OF-11)", () => {
    const wf = load(`
name: test
version: "1.0"
jobs:
  test-job:
    failure_policy: continue
    steps:
      - id: step-1
        type: agent
`);
    expect(wf.jobs["test-job"]!.failure_policy).toBe("continue");
  });

  it("step-level failure_policy overrides job-level failure_policy (T-BC-OF-12)", () => {
    const wf = load(`
name: test
version: "1.0"
jobs:
  test-job:
    failure_policy: continue
    steps:
      - id: step-1
        type: agent
        failure_policy: block
`);
    expect(wf.jobs["test-job"]!.failure_policy).toBe("continue");
    expect(wf.jobs["test-job"]!.steps[0]!.failure_policy).toBe("block");
  });
});
