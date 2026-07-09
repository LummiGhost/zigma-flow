/**
 * Step 1 (Cases and Tests): formatError structured output utility.
 *
 * These tests verify that formatError produces structured, human-readable
 * error output with kind, message, exit code, and optional context fields
 * (runId, jobId, stepId, artifactPath, suggestion).
 *
 * Red phase: ALL tests will FAIL because formatError currently throws
 * "not yet implemented".
 *
 * Reference: docs/phases/v0.4-productization/workflows/wf-error-codes/01-cases-and-tests.md
 */

import { describe, expect, it } from "vitest";

import {
  ConfigError,
  ScriptError,
  ArtifactError,
  StateError,
  FilesystemError,
} from "../../src/utils/errors.js";
import { formatError } from "../../src/utils/error-format.js";

// ---------------------------------------------------------------------------
// UC-ERR-4a-b: Basic output includes kind, message, and exit code
// ---------------------------------------------------------------------------

describe("formatError basic structure", () => {
  it("T-FMT-1: includes kind and message in first line", () => {
    const err = new ConfigError("No active run found.");
    const output = formatError(err);
    expect(output).toContain("Error [ConfigError]");
    expect(output).toContain("No active run found.");
    // The kind+message line should come before the exit code line
    const lines = output.split("\n");
    expect(lines[0]).toMatch(/^Error \[ConfigError\]:/);
  });

  it("T-FMT-2: includes exit code line", () => {
    const err = new ConfigError("test");
    const output = formatError(err);
    expect(output).toContain("Exit code:");
    expect(output).toContain("4");
  });
});

// ---------------------------------------------------------------------------
// UC-ERR-4c-f: Context fields from details
// ---------------------------------------------------------------------------

describe("formatError context fields", () => {
  it("T-FMT-3: includes Run when details.runId present", () => {
    const err = new StateError("Job not found.", {
      details: { runId: "run-abc123" },
    });
    const output = formatError(err);
    expect(output).toContain("Run:");
    expect(output).toContain("run-abc123");
  });

  it("T-FMT-4: includes Job when details.jobId present", () => {
    const err = new StateError("Job not ready.", {
      details: { jobId: "static-check" },
    });
    const output = formatError(err);
    expect(output).toContain("Job:");
    expect(output).toContain("static-check");
  });

  it("T-FMT-5: includes Step when details.stepId present", () => {
    const err = new ScriptError("Step failed.", {
      details: { stepId: "typecheck" },
    });
    const output = formatError(err);
    expect(output).toContain("Step:");
    expect(output).toContain("typecheck");
  });

  it("T-FMT-6: includes Artifact when details.artifactPath present", () => {
    const err = new ArtifactError("Artifact not found.", {
      details: {
        artifactPath: ".zigma-flow/runs/run-abc/artifacts/coverage/index.html",
      },
    });
    const output = formatError(err);
    expect(output).toContain("Artifact:");
    expect(output).toContain("coverage/index.html");
  });
});

// ---------------------------------------------------------------------------
// UC-ERR-4g: Suggestion
// ---------------------------------------------------------------------------

describe("formatError suggestion", () => {
  it("T-FMT-7: includes Suggestion when suggestion present", () => {
    const suggestion = "Run `zigma-flow run <workflow> --task <task>` to create a new run.";
    const err = new ConfigError("No active run found.", { suggestion });
    const output = formatError(err);
    expect(output).toContain("Suggestion:");
    expect(output).toContain(suggestion);
  });
});

// ---------------------------------------------------------------------------
// UC-ERR-4h: Consistent field ordering
// ---------------------------------------------------------------------------

describe("formatError field ordering", () => {
  it("T-FMT-8: context fields appear in consistent order (Run, Job, Step, Artifact, Suggestion)", () => {
    const err = new ScriptError("Script step failed with exit code 2.", {
      details: {
        runId: "run-20260709-abc123",
        jobId: "static-check",
        stepId: "typecheck",
        artifactPath: ".zigma-flow/runs/run-20260709-abc123/artifacts/report.json",
      },
      suggestion:
        "Review the script output above. Fix errors and re-run with `zigma-flow step --job static-check`.",
    });

    const output = formatError(err);
    const lines = output.split("\n");

    // Find the positions of each field marker (case-insensitive, trim whitespace)
    const detectField = (line: string): string | null => {
      const trimmed = line.trim();
      if (trimmed.startsWith("Error [")) return "kind";
      if (trimmed.startsWith("Exit code:")) return "exitCode";
      if (trimmed.startsWith("Run:")) return "run";
      if (trimmed.startsWith("Job:")) return "job";
      if (trimmed.startsWith("Step:")) return "step";
      if (trimmed.startsWith("Artifact:")) return "artifact";
      if (trimmed.startsWith("Suggestion:")) return "suggestion";
      return null;
    };

    const fieldOrder = lines.map(detectField).filter(Boolean);
    const expectedOrder = [
      "kind",
      "exitCode",
      "run",
      "job",
      "step",
      "artifact",
      "suggestion",
    ];

    expect(fieldOrder).toEqual(expectedOrder);
  });
});

// ---------------------------------------------------------------------------
// UC-ERR-4i: Minimal output when no context
// ---------------------------------------------------------------------------

describe("formatError minimal output", () => {
  it("T-FMT-9: produces minimal output when no details or suggestion", () => {
    const err = new FilesystemError("Read failed.");
    const output = formatError(err);
    const lines = output.split("\n");

    // Should only have kind+message and exit code lines
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Error \[FilesystemError\]:/);
    expect(lines[1]).toContain("Exit code:");
  });
});

// ---------------------------------------------------------------------------
// UC-ERR-4j: Unknown detail keys are silently omitted
// ---------------------------------------------------------------------------

describe("formatError unknown details", () => {
  it("T-FMT-10: silently omits unknown detail keys", () => {
    const err = new ConfigError("test", {
      details: {
        runId: "run-abc",
        internalStack: ["frame1", "frame2"],
        zigmaflowDir: "/home/user/project",
        debugTrace: { level: "verbose" },
      },
    });

    const output = formatError(err);
    // runId is a known key and SHOULD appear
    expect(output).toContain("Run:");
    expect(output).toContain("run-abc");

    // Unknown keys should NOT appear as field headers
    expect(output).not.toContain("internalStack:");
    expect(output).not.toContain("debugTrace:");
    expect(output).not.toContain("zigmaflowDir:");
  });
});
