import { describe, expect, it } from "vitest";

import {
  computeReadyJobs,
  detectCycles,
  validateNeedsReferences,
} from "../../src/dag/index.js";

/**
 * DAG module unit tests for WF-P3-DAG (Step 1 — Cases and Tests).
 *
 * The `dag/` module is a pure-function library: no filesystem, no infrastructure
 * adapters. Tests pass plain objects shaped as
 * `{ needs?: string[]; optional_needs?: string[]; steps: unknown[] }` rather than
 * importing the full `JobDefinition` from `src/workflow/index.ts`, to keep the
 * test layer decoupled from non-DAG schema concerns.
 *
 * Reference:
 *   - docs/prd.md FR-002 (RC-07, RC-08)
 *   - docs/architecture.md §5.2 (dag module boundary), §6.2 (WorkflowDefinition invariants)
 *   - docs/mvp-contracts.md §2.1 Workflow Contract, §4 DoD
 *   - docs/phases/p3-run/workflows/wf-p3-dag/01-cases-and-tests.md
 */

// ---------------------------------------------------------------------------
// Inline test type — matches the DAG-relevant subset of JobDefinition.
// ---------------------------------------------------------------------------

interface DagJob {
  needs?: string[];
  optional_needs?: string[];
  steps: unknown[];
}

type JobMap = Record<string, DagJob>;

const STEPS_EMPTY: unknown[] = [];

function job(needs?: string[], optional_needs?: string[]): DagJob {
  const j: DagJob = { steps: STEPS_EMPTY };
  if (needs !== undefined) j.needs = needs;
  if (optional_needs !== undefined) j.optional_needs = optional_needs;
  return j;
}

// ---------------------------------------------------------------------------
// validateNeedsReferences
// ---------------------------------------------------------------------------

describe("validateNeedsReferences", () => {
  it("returns valid for empty jobs map (UC-NR-1, T-NR-1)", () => {
    const result = validateNeedsReferences({});
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns valid for single job with no needs (UC-NR-2, T-NR-2)", () => {
    const jobs: JobMap = { a: job() };
    const result = validateNeedsReferences(jobs);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns valid for legal linear chain A -> B -> C (UC-NR-3, T-NR-3)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(["a"]),
      c: job(["b"]),
    };
    const result = validateNeedsReferences(jobs);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("flags needs that reference a non-existent job (UC-NR-4, T-NR-4)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(["ghost"]),
    };
    const result = validateNeedsReferences(jobs);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // The error string should identify both the referencing job and the missing target.
    const combined = result.errors.join("\n");
    expect(combined).toContain("b");
    expect(combined).toContain("ghost");
  });

  it("flags optional_needs that reference a non-existent job (UC-NR-5, T-NR-5)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(undefined, ["ghost"]),
    };
    const result = validateNeedsReferences(jobs);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    const combined = result.errors.join("\n");
    expect(combined).toContain("b");
    expect(combined).toContain("ghost");
  });

  it("reports only the invalid reference when needs valid and optional invalid (UC-NR-6, T-NR-6)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(["a"], ["ghost"]),
    };
    const result = validateNeedsReferences(jobs);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("ghost");
  });

  it("surfaces multiple missing references across multiple jobs (UC-NR-7, T-NR-7)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(["x"]),
      c: job(["y"]),
    };
    const result = validateNeedsReferences(jobs);
    expect(result.valid).toBe(false);
    // At least one error per offending job.
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    const combined = result.errors.join("\n");
    expect(combined).toContain("b");
    expect(combined).toContain("x");
    expect(combined).toContain("c");
    expect(combined).toContain("y");
  });
});

// ---------------------------------------------------------------------------
// detectCycles
// ---------------------------------------------------------------------------

describe("detectCycles", () => {
  it("returns null for empty jobs map (UC-CYC-1, T-CYC-1)", () => {
    expect(detectCycles({})).toBeNull();
  });

  it("returns null for single job with no needs (UC-CYC-2, T-CYC-2)", () => {
    const jobs: JobMap = { a: job() };
    expect(detectCycles(jobs)).toBeNull();
  });

  it("returns null for linear chain A -> B -> C (UC-CYC-3, T-CYC-3)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(["a"]),
      c: job(["b"]),
    };
    expect(detectCycles(jobs)).toBeNull();
  });

  it("returns null for fork A -> B, A -> C (UC-CYC-4, T-CYC-4)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(["a"]),
      c: job(["a"]),
    };
    expect(detectCycles(jobs)).toBeNull();
  });

  it("returns null for join B -> D, C -> D (UC-CYC-5, T-CYC-5)", () => {
    const jobs: JobMap = {
      b: job(),
      c: job(),
      d: job(["b", "c"]),
    };
    expect(detectCycles(jobs)).toBeNull();
  });

  it("returns null for diamond A -> B -> D, A -> C -> D (UC-CYC-6, T-CYC-6)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(["a"]),
      c: job(["a"]),
      d: job(["b", "c"]),
    };
    expect(detectCycles(jobs)).toBeNull();
  });

  it("returns a cycle path for self-loop (A needs A) (UC-CYC-7, T-CYC-7)", () => {
    const jobs: JobMap = {
      a: job(["a"]),
    };
    const cycles = detectCycles(jobs);
    expect(cycles).not.toBeNull();
    expect(Array.isArray(cycles)).toBe(true);
    expect(cycles!.length).toBeGreaterThan(0);
    // At least one reported cycle path must include "a".
    const flat = cycles!.flat();
    expect(flat).toContain("a");
  });

  it("returns a cycle path for simple two-node cycle A -> B -> A (UC-CYC-8, T-CYC-8)", () => {
    const jobs: JobMap = {
      a: job(["b"]),
      b: job(["a"]),
    };
    const cycles = detectCycles(jobs);
    expect(cycles).not.toBeNull();
    expect(cycles!.length).toBeGreaterThan(0);
    const flat = cycles!.flat();
    expect(flat).toContain("a");
    expect(flat).toContain("b");
  });

  it("returns a cycle path for multi-node cycle A -> B -> C -> A (UC-CYC-9, T-CYC-9)", () => {
    const jobs: JobMap = {
      a: job(["c"]),
      b: job(["a"]),
      c: job(["b"]),
    };
    const cycles = detectCycles(jobs);
    expect(cycles).not.toBeNull();
    expect(cycles!.length).toBeGreaterThan(0);
    const flat = cycles!.flat();
    expect(flat).toContain("a");
    expect(flat).toContain("b");
    expect(flat).toContain("c");
  });

  it("ignores optional_needs when looking for cycles (UC-CYC-10, T-CYC-10)", () => {
    // The only "ring" here exists through optional_needs; needs forms no cycle.
    const jobs: JobMap = {
      a: job(undefined, ["b"]),
      b: job(undefined, ["a"]),
    };
    expect(detectCycles(jobs)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeReadyJobs
// ---------------------------------------------------------------------------

describe("computeReadyJobs", () => {
  it("returns empty for empty jobs map (UC-RDY-1, T-RDY-1)", () => {
    expect(computeReadyJobs({}, new Set(), new Set())).toEqual([]);
  });

  it("returns jobs with no needs when nothing is completed (UC-RDY-2, T-RDY-2)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(["a"]),
      c: job(),
    };
    const ready = computeReadyJobs(jobs, new Set(), new Set());
    expect(new Set(ready)).toEqual(new Set(["a", "c"]));
  });

  it("unlocks downstream job once its needs are satisfied (UC-RDY-3, T-RDY-3)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(["a"]),
      c: job(),
    };
    const ready = computeReadyJobs(jobs, new Set(["a"]), new Set());
    expect(new Set(ready)).toEqual(new Set(["b", "c"]));
  });

  it("returns empty when all jobs are completed (UC-RDY-4, T-RDY-4)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(["a"]),
      c: job(),
    };
    const ready = computeReadyJobs(jobs, new Set(["a", "b", "c"]), new Set());
    expect(ready).toEqual([]);
  });

  it("excludes jobs that are currently active (UC-RDY-5, T-RDY-5)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(["a"]),
      c: job(),
    };
    // A is completed, B would be ready, but B is already active. C has no needs.
    const ready = computeReadyJobs(jobs, new Set(["a"]), new Set(["b"]));
    expect(new Set(ready)).toEqual(new Set(["c"]));
  });

  it("treats optional_needs as non-blocking (UC-RDY-6, T-RDY-6)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(undefined, ["a"]), // optional dep on a
    };
    const ready = computeReadyJobs(jobs, new Set(), new Set());
    expect(new Set(ready)).toEqual(new Set(["a", "b"]));
  });

  it("keeps a job waiting when only some of its needs are satisfied (UC-RDY-7, T-RDY-7)", () => {
    const jobs: JobMap = {
      a: job(),
      b: job(),
      c: job(["a", "b"]),
    };
    // Only A is completed; C still needs B.
    const ready = computeReadyJobs(jobs, new Set(["a"]), new Set(["a"]));
    // B has no needs and is not active or completed; C is still waiting on B.
    expect(new Set(ready)).toEqual(new Set(["b"]));
  });
});
