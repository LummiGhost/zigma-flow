import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import { loadWorkflow, loadWorkflowFile } from "../../src/workflow/index.js";
import {
  FilesystemError,
  ValidationError,
  WorkflowError
} from "../../src/utils/index.js";

/**
 * Workflow loader + validate-CLI tests for WF-P2-VALIDATE (Step 1).
 *
 * These tests describe the expected behavior of the workflow loader, semantic
 * checks, and the `zigma-flow validate` command. They are intentionally red:
 * `src/workflow/index.ts` and the CLI `validate` subcommand are stubs until
 * Step 2.
 *
 * Reference:
 *   - docs/prd.md FR-002, §12
 *   - docs/mvp-contracts.md §7 (error -> exit code mapping)
 *   - docs/phases/p2-validate/workflows/wf-p2-validate/01-cases-and-tests.md
 */

// ---------------------------------------------------------------------------
// CLI capture helper (mirrors tests/cli/cli.test.ts)
// ---------------------------------------------------------------------------

interface CapturedRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly error: unknown;
}

async function runMain(args: ReadonlyArray<string>): Promise<CapturedRun> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdoutChunks.push(parts.map(String).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderrChunks.push(parts.map(String).join(" "));
  });

  const previousExitCode = process.exitCode;
  process.exitCode = 0;

  let caught: unknown = undefined;
  try {
    await main(["node", "zigma-flow", ...args]);
  } catch (error: unknown) {
    caught = error;
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  const observedExitCode = process.exitCode;
  process.exitCode = previousExitCode;

  return {
    stdout: stdoutChunks.join("\n"),
    stderr: stderrChunks.join("\n"),
    exitCode: typeof observedExitCode === "number" ? observedExitCode : undefined,
    error: caught
  };
}

// ---------------------------------------------------------------------------
// Inline YAML fixtures
// ---------------------------------------------------------------------------

/**
 * Canonical workflow: minimal but exercises the surface area validated in P2:
 * top-level `skills`, `signals`, one job, one agent step with `expose.skills`,
 * and one router step with a legal action.
 */
const CANONICAL_WORKFLOW_YAML = `name: code-change
version: 0.3.0

on:
  manual:
    inputs:
      task:
        type: string
        required: true

skills:
  code:
    uses: skill://zigma.code-change@1
    expose_to_agent: true

permissions:
  contents: read
  edits: none
  commands: none
  workflow_state: none

signals:
  blocked:
    severity: high
    priority: 100
    allowed_from:
      - intake
    action:
      status: blocked

jobs:
  intake:
    workspace:
      mode: read-only
    steps:
      - id: analyze
        type: agent
        uses: agent://planner
        expose:
          skills:
            - code
        with:
          task: "\${{ inputs.task }}"
        outputs:
          summary: report.summary

      - id: route
        type: router
        switch: "\${{ steps.analyze.outputs.signals }}"
        cases:
          default:
            continue
`;

function withoutLine(yaml: string, predicate: (line: string) => boolean): string {
  return yaml
    .split("\n")
    .filter((line) => !predicate(line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Schema tests (FP-WF-SCH)
// ---------------------------------------------------------------------------

describe("workflow schema (FP-WF-SCH)", () => {
  it("loadWorkflow accepts canonical workflow YAML (T-WF-1 / UC-WF-1)", () => {
    const def = loadWorkflow(CANONICAL_WORKFLOW_YAML);
    expect(def).toBeDefined();
    // Spot-check parsed shape so we know schema passed and yielded a usable object.
    expect((def as { name: string }).name).toBe("code-change");
    expect((def as { version: string }).version).toBe("0.3.0");
    expect((def as { jobs: Record<string, unknown> }).jobs).toBeDefined();
  });

  it("loadWorkflow rejects missing name with field path (T-WF-2 / UC-WF-2)", () => {
    const yaml = withoutLine(CANONICAL_WORKFLOW_YAML, (line) => line.startsWith("name:"));

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    const err = thrown as ValidationError;
    expect(JSON.stringify(err.details ?? {})).toContain("name");
  });

  it("loadWorkflow rejects missing version with field path (T-WF-3 / UC-WF-3)", () => {
    const yaml = withoutLine(CANONICAL_WORKFLOW_YAML, (line) => line.startsWith("version:"));

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    const err = thrown as ValidationError;
    expect(JSON.stringify(err.details ?? {})).toContain("version");
  });

  it("loadWorkflow rejects missing jobs with field path (T-WF-4 / UC-WF-4)", () => {
    // Use only the top stanza; everything after `jobs:` is dropped.
    const yaml = CANONICAL_WORKFLOW_YAML.split("\njobs:")[0] + "\n";

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    const err = thrown as ValidationError;
    expect(JSON.stringify(err.details ?? {})).toContain("jobs");
  });

  it("loadWorkflow rejects illegal step type with field path (T-WF-5 / UC-WF-5)", () => {
    const yaml = CANONICAL_WORKFLOW_YAML.replace("        type: agent", "        type: bogus");

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    const err = thrown as ValidationError;
    const detailsBlob = JSON.stringify(err.details ?? {});
    // Path should locate the offending step's `type` field. Different Zod
    // serializations may emit `jobs.intake.steps.0.type` or
    // ["jobs","intake","steps",0,"type"]; both must mention `type`.
    expect(detailsBlob).toContain("type");
  });

  it("loadWorkflow rejects router step with illegal action (T-WF-6 / UC-WF-6)", () => {
    const yaml = CANONICAL_WORKFLOW_YAML.replace(
      "          default:\n            continue",
      "          default:\n            delete_job: intake"
    );

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Loader tests (FP-WF-LOAD)
// ---------------------------------------------------------------------------

describe("workflow loader (FP-WF-LOAD)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-wf-load-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loadWorkflowFile returns FilesystemError when file missing (T-WF-7 / UC-WF-7)", async () => {
    const missing = join(tempDir, "does-not-exist.yml");

    let thrown: unknown;
    try {
      await loadWorkflowFile(missing);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(FilesystemError);
  });

  it("loadWorkflow surfaces YAML syntax errors as ValidationError (T-WF-8 / UC-WF-8)", () => {
    // Mismatched indentation + unclosed bracket -> YAML parse failure.
    const badYaml = "name: oops\nversion: 0.1.0\njobs:\n  intake:\n    steps: [\n";

    let thrown: unknown;
    try {
      loadWorkflow(badYaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Semantic tests (FP-WF-SEM)
// ---------------------------------------------------------------------------

describe("workflow semantic checks (FP-WF-SEM)", () => {
  it("loadWorkflow rejects duplicate job ids (T-WF-9 / UC-WF-9)", () => {
    // YAML allows duplicate keys but parsers typically keep last; we model
    // the duplicate by appending a sibling job whose key collides with
    // `intake` via explicit !!map merge would be ambiguous, so instead we
    // append an additional `intake` block. Most YAML parsers emit a warning
    // or override the prior key; in that case the semantic check must use a
    // multi-document or pre-parse hook. To remain parser-agnostic, this
    // test exercises the canonical case where two distinct top-level mapping
    // keys collide; if the parser collapses them, the semantic layer must
    // still raise (e.g. by inspecting the raw YAML source for duplicates).
    const yaml = `${CANONICAL_WORKFLOW_YAML}
  intake:
    steps:
      - id: again
        type: agent
        uses: agent://planner
        expose:
          skills:
            - code
        outputs:
          summary: report.summary
`;

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkflowError);
    const err = thrown as WorkflowError;
    expect(JSON.stringify(err.details ?? {}).toLowerCase()).toContain("intake");
  });

  it("loadWorkflow rejects duplicate step ids within a job (T-WF-10 / UC-WF-10)", () => {
    // Append a second step with the same id as `analyze`.
    const yaml = CANONICAL_WORKFLOW_YAML.replace(
      "      - id: route\n        type: router",
      `      - id: analyze
        type: agent
        uses: agent://planner
        expose:
          skills:
            - code
        outputs:
          summary: report.summary2

      - id: route
        type: router`
    );

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkflowError);
    const err = thrown as WorkflowError;
    expect(JSON.stringify(err.details ?? {}).toLowerCase()).toContain("analyze");
  });

  it("loadWorkflow rejects Agent expose.skills referencing undeclared alias (T-WF-11 / UC-WF-11)", () => {
    // The top-level `skills` map only declares `code`. Reference `project`
    // (undeclared) from an Agent Step's expose.skills list.
    const yaml = CANONICAL_WORKFLOW_YAML.replace(
      "        expose:\n          skills:\n            - code",
      "        expose:\n          skills:\n            - code\n            - project"
    );

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    const err = thrown as ValidationError;
    expect(JSON.stringify(err.details ?? {}).toLowerCase()).toContain("project");
  });
});

// ---------------------------------------------------------------------------
// validate CLI -> workflow tests (FP-CLI-VAL + FP-CLI-ERR + FP-CLI-EXIT)
// ---------------------------------------------------------------------------

describe("validate CLI (workflow)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-validate-wf-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("validate CLI returns 0 on legal workflow file (T-WF-CLI-1 / UC-CLI-V1)", async () => {
    const file = join(tempDir, "code-change.yml");
    await writeFile(file, CANONICAL_WORKFLOW_YAML, "utf-8");

    const result = await runMain(["validate", file]);
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("validate CLI returns non-zero on illegal workflow with field-level errors (T-WF-CLI-2 / UC-CLI-V3)", async () => {
    const file = join(tempDir, "bad.yml");
    const yaml = withoutLine(CANONICAL_WORKFLOW_YAML, (line) => line.startsWith("name:"));
    await writeFile(file, yaml, "utf-8");

    const result = await runMain(["validate", file]);

    const failureSignaled =
      (typeof result.exitCode === "number" && result.exitCode !== 0) ||
      result.error !== undefined;
    expect(failureSignaled).toBe(true);
    // Field path must be surfaced to the user on stderr. We assert the
    // missing field name appears in the rendered output.
    expect(result.stderr.toLowerCase()).toContain("name");
  });

  it("validate CLI returns non-zero on missing file (T-WF-CLI-3 / UC-CLI-V4)", async () => {
    const file = join(tempDir, "nope.yml");

    const result = await runMain(["validate", file]);

    const failureSignaled =
      (typeof result.exitCode === "number" && result.exitCode !== 0) ||
      result.error !== undefined;
    expect(failureSignaled).toBe(true);
  });
});
