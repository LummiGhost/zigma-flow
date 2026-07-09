/**
 * Step 1 (Cases and Tests): Error class exit codes, kinds, and option propagation.
 *
 * These tests verify the error taxonomy contract defined in
 * docs/phases/v0.4-productization/workflows/wf-error-codes/01-cases-and-tests.md
 * and docs/error-codes.md.
 *
 * Red phase: tests for new stable exit codes (10, 11, 12, 13, 14, 20, 21, 22, 23, 30)
 * will FAIL because the current implementation uses shared codes (1 and 3).
 */

import { describe, expect, it } from "vitest";

import {
  ZigmaFlowError,
  UserInputError,
  ValidationError,
  ConfigError,
  FilesystemError,
  SkillPackError,
  WorkflowError,
  ArtifactError,
  StateError,
  ScriptError,
  CheckError,
  RouterError,
  PermissionError,
  PromptBuildError,
} from "../../src/utils/errors.js";

// ---------------------------------------------------------------------------
// UC-ERR-2: Stable exit codes
// ---------------------------------------------------------------------------

describe("Error class exit codes match stable taxonomy", () => {
  it("T-ERR-1: UserInputError has exit code 2", () => {
    const err = new UserInputError("test");
    expect(err.exitCode).toBe(2);
  });

  it("T-ERR-2: ConfigError has exit code 4", () => {
    const err = new ConfigError("test");
    expect(err.exitCode).toBe(4);
  });

  it("T-ERR-3: FilesystemError has exit code 5", () => {
    const err = new FilesystemError("test");
    expect(err.exitCode).toBe(5);
  });

  it("T-ERR-4: ValidationError has exit code 10", () => {
    const err = new ValidationError("test");
    expect(err.exitCode).toBe(10);
  });

  it("T-ERR-5: WorkflowError has exit code 11", () => {
    const err = new WorkflowError("test");
    expect(err.exitCode).toBe(11);
  });

  it("T-ERR-6: SkillPackError has exit code 12", () => {
    const err = new SkillPackError("test");
    expect(err.exitCode).toBe(12);
  });

  it("T-ERR-7: PromptBuildError has exit code 13", () => {
    const err = new PromptBuildError("test");
    expect(err.exitCode).toBe(13);
  });

  it("T-ERR-8: PermissionError has exit code 14", () => {
    const err = new PermissionError("test");
    expect(err.exitCode).toBe(14);
  });

  it("T-ERR-9: StateError has exit code 20", () => {
    const err = new StateError("test");
    expect(err.exitCode).toBe(20);
  });

  it("T-ERR-10: ScriptError has exit code 21", () => {
    const err = new ScriptError("test");
    expect(err.exitCode).toBe(21);
  });

  it("T-ERR-11: CheckError has exit code 22", () => {
    const err = new CheckError("test");
    expect(err.exitCode).toBe(22);
  });

  it("T-ERR-12: RouterError has exit code 23", () => {
    const err = new RouterError("test");
    expect(err.exitCode).toBe(23);
  });

  it("T-ERR-13: ArtifactError has exit code 30", () => {
    const err = new ArtifactError("test");
    expect(err.exitCode).toBe(30);
  });

  it("T-ERR-14: All exit codes are unique (no duplicates among 13 classes)", () => {
    const allErrors: ZigmaFlowError[] = [
      new UserInputError(""),
      new ConfigError(""),
      new FilesystemError(""),
      new ValidationError(""),
      new WorkflowError(""),
      new SkillPackError(""),
      new PromptBuildError(""),
      new PermissionError(""),
      new StateError(""),
      new ScriptError(""),
      new CheckError(""),
      new RouterError(""),
      new ArtifactError(""),
    ];

    const codes = allErrors.map((e) => e.exitCode);
    const uniqueCodes = new Set(codes);

    expect(uniqueCodes.size).toBe(allErrors.length);

    // For a more helpful failure message, identify duplicates
    if (uniqueCodes.size < allErrors.length) {
      const seen = new Map<number, string[]>();
      for (const e of allErrors) {
        const existing = seen.get(e.exitCode);
        if (existing) {
          existing.push(e.kind);
        } else {
          seen.set(e.exitCode, [e.kind]);
        }
      }
      const duplicates = [...seen.entries()]
        .filter(([, kinds]) => kinds.length > 1)
        .map(([code, kinds]) => `  exitCode ${code}: ${kinds.join(", ")}`)
        .join("\n");
      throw new Error(`Duplicate exit codes found:\n${duplicates}`);
    }
  });
});

// ---------------------------------------------------------------------------
// UC-ERR-3: Details and suggestion propagation
// ---------------------------------------------------------------------------

describe("Error details and suggestion are preserved", () => {
  it("T-ERR-15: details are stored and accessible", () => {
    const details = { runId: "run-123", jobId: "static-check" };
    const err = new ConfigError("test", { details });
    expect(err.details).toEqual(details);
  });

  it("T-ERR-16: suggestion is stored and accessible", () => {
    const suggestion = "Run `zigma-flow run` to create a new run.";
    const err = new ConfigError("test", { suggestion });
    expect(err.suggestion).toBe(suggestion);
  });

  it("T-ERR-17: cause is stored and accessible", () => {
    const cause = new Error("root cause");
    const err = new FilesystemError("test", { cause });
    expect(err.cause).toBe(cause);
  });

  it("T-ERR-18: error.name equals error.kind for all 13 classes", () => {
    const allErrors: ZigmaFlowError[] = [
      new UserInputError(""),
      new ValidationError(""),
      new ConfigError(""),
      new FilesystemError(""),
      new SkillPackError(""),
      new WorkflowError(""),
      new ArtifactError(""),
      new StateError(""),
      new ScriptError(""),
      new CheckError(""),
      new RouterError(""),
      new PermissionError(""),
      new PromptBuildError(""),
    ];

    for (const err of allErrors) {
      expect(err.name, `${err.kind}: error.name should equal error.kind`).toBe(
        err.kind,
      );
    }
  });

  it("T-ERR-19: message is set as the Error message property", () => {
    const msg = "This is the error message";
    const err = new ValidationError(msg);
    expect(err.message).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// UC-ERR-3e: Constructing with run/job/step/artifact context in details
// ---------------------------------------------------------------------------

describe("Error construction with run/job/step/artifact context", () => {
  it("constructs ScriptError with full context", () => {
    const err = new ScriptError("Script step failed with exit code 2.", {
      details: {
        runId: "run-20260709-abc123",
        jobId: "static-check",
        stepId: "typecheck",
      },
      suggestion:
        "Review the script output. Fix errors and re-run with `zigma-flow step --job static-check`.",
    });

    expect(err.details?.runId).toBe("run-20260709-abc123");
    expect(err.details?.jobId).toBe("static-check");
    expect(err.details?.stepId).toBe("typecheck");
    expect(err.suggestion).toContain("zigma-flow step --job static-check");
  });

  it("constructs ArtifactError with artifact path context", () => {
    const err = new ArtifactError("Artifact path not found.", {
      details: {
        runId: "run-abc",
        jobId: "unit-test",
        artifactPath: ".zigma-flow/runs/run-abc/artifacts/coverage/index.html",
      },
      suggestion:
        "Check that the artifact was produced by a previous step. Run `zigma-flow artifacts run-abc` to list available artifacts.",
    });

    expect(err.details?.artifactPath).toContain("coverage/index.html");
    expect(err.suggestion).toContain("zigma-flow artifacts");
  });

  it("constructs ConfigError with minimal context (no run/job/step)", () => {
    const err = new ConfigError(
      "No active run found. Run `zigma-flow run` first to create a run.",
      {
        details: { zigmaflowDir: "/home/user/project" },
        suggestion:
          "Run `zigma-flow run <workflow> --task <task>` to create a new run.",
      },
    );

    expect(err.details?.runId).toBeUndefined();
    expect(err.details?.jobId).toBeUndefined();
    expect(err.details?.stepId).toBeUndefined();
    expect(err.suggestion).toContain("zigma-flow run");
  });

  it("constructs StateError with run and job context, no step", () => {
    const err = new StateError(
      'Job "static-check" not found in state for run run-abc.',
      {
        details: {
          runId: "run-abc",
          jobId: "static-check",
        },
        suggestion: "Run `zigma-flow status` to see the current jobs.",
      },
    );

    expect(err.details?.runId).toBe("run-abc");
    expect(err.details?.jobId).toBe("static-check");
    expect(err.details?.stepId).toBeUndefined();
  });
});
