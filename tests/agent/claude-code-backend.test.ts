/**
 * ClaudeCodeBackend artifact output tests for WF-P13-EVENTS-ARTIFACTS
 * (Step 1 — Cases and Tests).
 *
 * Verifies that `ClaudeCodeBackend.execute`:
 *   - Writes stdout to ${stepDir}/agent.stdout.log (UC-ART-001)
 *   - Writes stderr to ${stepDir}/agent.stderr.log (UC-ART-002)
 *   - Writes invocation metadata to ${stepDir}/agent.invocation.json (UC-ART-003)
 *   - Returns structured result with file paths (AD-P13-003 contract)
 *   - Error messages no longer embed truncated stdout/stderr (UC-ART-005)
 *   - Tracks durationMs (FP-ART-DURATION)
 *   - Writes stdout/stderr files even on failure and timeout
 *
 * Covers:
 *   - T-CCB-001: Writes stdout to agent.stdout.log on success
 *   - T-CCB-002: Writes stderr to agent.stderr.log on success
 *   - T-CCB-003: Writes invocation metadata to agent.invocation.json
 *   - T-CCB-004: Returns structured result with file paths
 *   - T-CCB-005: Error result no longer embeds truncated stdout
 *   - T-CCB-006: Error result no longer embeds truncated stderr
 *   - T-CCB-007: Tracks durationMs in result
 *   - T-CCB-008: Writes stdout/stderr files even on failure
 *   - T-CCB-009: Writes stdout/stderr files even on timeout
 *   - T-CCB-010: Returns exitCode in structured result on failure
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-events-artifacts/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md §5
 *   - AD-P13-002 (Agent invocation lifecycle events)
 *   - AD-P13-003 (Backend artifacts)
 *   - src/agent/backends/claude-code.ts (current implementation)
 *
 * Red-phase note: ClaudeCodeBackend.execute currently does NOT write
 * stdout/stderr files, does NOT track durationMs, and embeds truncated
 * stdout/stderr in error messages. These tests are expected to fail
 * on the new behavior assertions until Step 2 implements the changes.
 *
 * Test strategy:
 *   - Use `node -e "<script>"` as the agent command for deterministic,
 *     fast integration tests that exercise real process I/O capture.
 *   - Use temp directories for file output, cleaned up in afterEach.
 *   - For error-embedding tests, verify the ABSENCE of old patterns.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { ClaudeCodeBackend } from "../../src/agent/index.js";
import type { AgentBackendConfig, AgentExecuteOptions } from "../../src/agent/index.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

interface TempDirs {
  stepDir: string;
  reportPath: string;
  projectRoot: string;
}

async function makeTempDirs(): Promise<TempDirs> {
  const base = join(tmpdir(), `zigma-ccb-${randomUUID()}`);
  const stepDir = join(base, "step");
  const reportPath = join(stepDir, "report.json");
  const projectRoot = join(base, "project");

  await mkdir(stepDir, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

  return { stepDir, reportPath, projectRoot };
}

// ---------------------------------------------------------------------------
// Backend configuration helpers
// ---------------------------------------------------------------------------

/**
 * Create a ClaudeCodeBackend that uses `node` as the command to produce
 * predictable output. The `args` override lets us pass a script.
 *
 * Example: `node -e "console.log('hello'); console.error('world')"`
 * produces stdout="hello\n", stderr="world\n", exitCode=0.
 */
function makeNodeBackend(args: string[] = ["-e", "console.log('hello')"]): {
  backend: ClaudeCodeBackend;
  config: AgentBackendConfig;
} {
  const config: AgentBackendConfig = {
    command: "node",
    args: args,
    timeout: 30_000,
  };
  const backend = new ClaudeCodeBackend(config);
  return { backend, config };
}

/**
 * Execute the backend with the given options and return the result.
 * Provides sensible defaults for reportPath and stepDir.
 */
async function executeBackend(
  backend: ClaudeCodeBackend,
  overrides: Partial<AgentExecuteOptions> = {}
): Promise<Awaited<ReturnType<ClaudeCodeBackend["execute"]>>> {
  const temp = await makeTempDirs();
  const opts: AgentExecuteOptions = {
    prompt: "Test prompt: say hello and write nothing else",
    reportPath: temp.reportPath,
    stepDir: temp.stepDir,
    projectRoot: temp.projectRoot,
    ...overrides,
  };
  const result = await backend.execute(opts);
  return result;
}

// ---------------------------------------------------------------------------
// T-CCB-001: Writes stdout to agent.stdout.log on success
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — stdout artifact (T-CCB-001)", () => {
  let temp: TempDirs;

  beforeEach(async () => {
    temp = await makeTempDirs();
  });

  afterEach(async () => {
    await rm(temp.projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "writes stdout to agent.stdout.log file on successful execution (T-CCB-001, UC-ART-001, FP-ART-STDOUT-FILE)",
    async () => {
      const { backend } = makeNodeBackend([
        "-e",
        "console.log('hello world'); console.error('some stderr')",
      ]);

      // Write a valid report.json in advance (the backend spawns node,
      // which does NOT write report.json — the test simulates an external
      // writer that creates the report before/alongside backend execution).
      // This test exercises just the stdout/stderr file-writing path.
      await writeFile(
        temp.reportPath,
        JSON.stringify({
          outputs: {},
          artifacts: [],
          signals: [],
          summary: "pre-written report",
        }, null, 2),
        "utf-8"
      );

      const result = await backend.execute({
        prompt: "echo hello world to stdout and stderr",
        reportPath: temp.reportPath,
        stepDir: temp.stepDir,
        projectRoot: temp.projectRoot,
      });

      // RED-PHASE: stdoutPath is not yet returned by v0.1 ClaudeCodeBackend
      // This assertion fails until Step 2 extends AgentExecuteResult
      const stdoutPath = (result as unknown as unknown as Record<string, unknown>)["stdoutPath"] as string | undefined;

      if (stdoutPath) {
        // File exists
        const stdoutContent = await readFile(stdoutPath, "utf-8");
        expect(stdoutContent).toContain("hello world");

        // File is in the stepDir
        expect(stdoutPath).toContain(temp.stepDir);
        expect(stdoutPath).toContain("agent.stdout.log");
      } else {
        // RED-PHASE: Flag the missing field clearly
        expect(stdoutPath).toBeDefined();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CCB-002: Writes stderr to agent.stderr.log on success
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — stderr artifact (T-CCB-002)", () => {
  let temp: TempDirs;

  beforeEach(async () => {
    temp = await makeTempDirs();
  });

  afterEach(async () => {
    await rm(temp.projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "writes stderr to agent.stderr.log file on successful execution (T-CCB-002, UC-ART-002, FP-ART-STDERR-FILE)",
    async () => {
      const { backend } = makeNodeBackend([
        "-e",
        "console.log('ok'); console.error('diagnostic info')",
      ]);

      await writeFile(
        temp.reportPath,
        JSON.stringify({ outputs: {}, artifacts: [], signals: [], summary: "ok" }, null, 2),
        "utf-8"
      );

      const result = await backend.execute({
        prompt: "echo stderr",
        reportPath: temp.reportPath,
        stepDir: temp.stepDir,
        projectRoot: temp.projectRoot,
      });

      const stderrPath = (result as unknown as Record<string, unknown>)["stderrPath"] as string | undefined;

      if (stderrPath) {
        const stderrContent = await readFile(stderrPath, "utf-8");
        expect(stderrContent).toContain("diagnostic info");

        expect(stderrPath).toContain(temp.stepDir);
        expect(stderrPath).toContain("agent.stderr.log");
      } else {
        // RED-PHASE: Flag the missing field
        expect(stderrPath).toBeDefined();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CCB-003: Writes invocation metadata to agent.invocation.json
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — invocation artifact (T-CCB-003)", () => {
  let temp: TempDirs;

  beforeEach(async () => {
    temp = await makeTempDirs();
  });

  afterEach(async () => {
    await rm(temp.projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "writes invocation metadata to agent.invocation.json with correct fields (T-CCB-003, UC-ART-003, FP-ART-INVOC-FILE)",
    async () => {
      const { backend, config } = makeNodeBackend([
        "-e",
        "console.log('ok'); require('fs').writeFileSync(process.argv[1], JSON.stringify({outputs:{},artifacts:[],signals:[],summary:'ok'}))",
      ]);

      // This test uses a node script that writes report.json itself
      // by receiving reportPath as an argument.
      const backend2 = new ClaudeCodeBackend({
        command: "node",
        args: ["-e", "console.log('ok'); require('fs').writeFileSync('" + temp.reportPath.replace(/\\/g, "\\\\") + "', JSON.stringify({outputs:{},artifacts:[],signals:[],summary:'ok'}))"],
        timeout: 30_000,
      });

      await backend2.execute({
        prompt: "say ok and write report",
        reportPath: temp.reportPath,
        stepDir: temp.stepDir,
        projectRoot: temp.projectRoot,
      }).catch(() => {
        // The node -e script may have issues with path escaping.
        // The key assertion is below.
      });

      // Read the file that SHOULD be written by Step 2
      const invocationPath = join(temp.stepDir, "agent.invocation.json");
      let invocationExists = false;
      try {
        await readFile(invocationPath, "utf-8");
        invocationExists = true;
      } catch {
        // RED-PHASE: File does not exist yet (Step 2 will create it)
      }

      if (invocationExists) {
        const invocationJson = await readFile(invocationPath, "utf-8");
        const invocation = JSON.parse(invocationJson);

        // Verify required fields
        expect(typeof invocation["command"]).toBe("string");
        expect(Array.isArray(invocation["args"])).toBe(true);
        expect(typeof invocation["timeout_ms"]).toBe("number");
        expect(typeof invocation["start_time"]).toBe("string");
        expect(typeof invocation["end_time"]).toBe("string");
        expect(typeof invocation["project_root"]).toBe("string");
        // exit_code depends on the process outcome
        expect(
          invocation["exit_code"] === undefined ||
          typeof invocation["exit_code"] === "number"
        ).toBe(true);
      } else {
        // RED-PHASE: File should exist after Step 2
        expect(invocationExists).toBe(true);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CCB-004: Returns structured result with file paths on success
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — structured result (T-CCB-004)", () => {
  let temp: TempDirs;

  beforeEach(async () => {
    temp = await makeTempDirs();
  });

  afterEach(async () => {
    await rm(temp.projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "returns result with success, reportPath, stdoutPath, stderrPath, invocationPath, durationMs (T-CCB-004, UC-ART-001,2,3, FP-ART-STRUCTURED-RESULT)",
    async () => {
      const { backend } = makeNodeBackend([
        "-e",
        "console.log('output'); console.error('debug')",
      ]);

      await writeFile(
        temp.reportPath,
        JSON.stringify({ outputs: {}, artifacts: [], signals: [], summary: "ok" }, null, 2),
        "utf-8"
      );

      const result = await backend.execute({
        prompt: "echo output",
        reportPath: temp.reportPath,
        stepDir: temp.stepDir,
        projectRoot: temp.projectRoot,
      });

      // Core fields (v0.1 already has these)
      expect(result.success).toBe(true);
      expect(result.reportPath).toBe(temp.reportPath);

      // New fields (RED-PHASE: fail until Step 2)
      const r = result as unknown as Record<string, unknown>;

      // durationMs must be a positive number
      expect(typeof r["durationMs"]).toBe("number");
      expect((r["durationMs"] as number)).toBeGreaterThanOrEqual(0);

      // stdoutPath must be set
      const stdoutPath = r["stdoutPath"] as string | undefined;
      expect(stdoutPath).toBeDefined();
      if (stdoutPath) {
        expect(stdoutPath).toContain("agent.stdout.log");
      }

      // stderrPath must be set
      const stderrPath = r["stderrPath"] as string | undefined;
      expect(stderrPath).toBeDefined();
      if (stderrPath) {
        expect(stderrPath).toContain("agent.stderr.log");
      }

      // invocationPath must be set
      const invocationPath = r["invocationPath"] as string | undefined;
      expect(invocationPath).toBeDefined();
      if (invocationPath) {
        expect(invocationPath).toContain("agent.invocation.json");
      }

      // exitCode should be present (0 for success)
      expect(r["exitCode"]).toBe(0);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CCB-005: Error result no longer embeds truncated stdout
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — no embedded stdout in error (T-CCB-005)", () => {
  let temp: TempDirs;

  beforeEach(async () => {
    temp = await makeTempDirs();
  });

  afterEach(async () => {
    await rm(temp.projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "error message does not embed truncated stdout text (T-CCB-005, UC-ART-005, FP-ART-NO-EMBED)",
    async () => {
      // Use a command that fails (exit 1) and does NOT write report.json
      const backend = new ClaudeCodeBackend({
        command: "node",
        args: ["-e", "console.log('This is a long stdout output '.repeat(50)); process.exit(1)"],
        timeout: 30_000,
      });

      const result = await backend.execute({
        prompt: "this will fail",
        reportPath: temp.reportPath,
        stepDir: temp.stepDir,
        projectRoot: temp.projectRoot,
      });

      expect(result.success).toBe(false);

      // RED-PHASE: v0.1 embeds stdout in error; Step 2 must remove it
      const errorMsg = result.error ?? "";

      // Must NOT contain the old truncation pattern
      expect(errorMsg).not.toMatch(/stdout \(last \d+ chars\)/i);

      // Must NOT contain large blocks of stdout content
      // (a short summary is OK, but not the actual long output)
      if (errorMsg.length > 500) {
        // If the error message is long, it's still embedding content
        expect(errorMsg.length).toBeLessThanOrEqual(500);
      }

      // Must NOT contain the literal repeated stdout text
      expect(errorMsg).not.toMatch(/This is a long stdout output.*This is a long stdout output/);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CCB-006: Error result no longer embeds truncated stderr
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — no embedded stderr in error (T-CCB-006)", () => {
  let temp: TempDirs;

  beforeEach(async () => {
    temp = await makeTempDirs();
  });

  afterEach(async () => {
    await rm(temp.projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "error message does not embed truncated stderr text (T-CCB-006, UC-ART-005, FP-ART-NO-EMBED)",
    async () => {
      const backend = new ClaudeCodeBackend({
        command: "node",
        args: [
          "-e",
          "console.error('STDERR: ' + 'x'.repeat(2000)); process.exit(2)",
        ],
        timeout: 30_000,
      });

      const result = await backend.execute({
        prompt: "this will fail with stderr",
        reportPath: temp.reportPath,
        stepDir: temp.stepDir,
        projectRoot: temp.projectRoot,
      });

      expect(result.success).toBe(false);

      const errorMsg = result.error ?? "";

      // Must NOT contain the old truncation pattern
      expect(errorMsg).not.toMatch(/stderr \(last \d+ chars\)/i);

      // Must NOT contain large stderr blocks
      if (errorMsg.length > 500) {
        expect(errorMsg.length).toBeLessThanOrEqual(500);
      }

      // Must NOT contain the repeated stderr content
      expect(errorMsg).not.toMatch(/xxxxx{100,}/);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CCB-007: Tracks durationMs in result
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — durationMs tracking (T-CCB-007)", () => {
  let temp: TempDirs;

  beforeEach(async () => {
    temp = await makeTempDirs();
  });

  afterEach(async () => {
    await rm(temp.projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "returns durationMs as a non-negative number in the result (T-CCB-007, UC-EVT-002, FP-ART-DURATION)",
    async () => {
      const { backend } = makeNodeBackend([
        "-e",
        "console.log('hello');",
      ]);

      await writeFile(
        temp.reportPath,
        JSON.stringify({ outputs: {}, artifacts: [], signals: [], summary: "ok" }, null, 2),
        "utf-8"
      );

      const result = await backend.execute({
        prompt: "say hello",
        reportPath: temp.reportPath,
        stepDir: temp.stepDir,
        projectRoot: temp.projectRoot,
      });

      const r = result as unknown as Record<string, unknown>;
      const durationMs = r["durationMs"] as number | undefined;

      // RED-PHASE: durationMs is not yet returned by v0.1
      expect(durationMs).toBeDefined();
      if (durationMs !== undefined) {
        expect(typeof durationMs).toBe("number");
        expect(durationMs).toBeGreaterThanOrEqual(0);
        // Should be reasonable (not 0, not hours)
        expect(durationMs).toBeLessThan(60_000);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CCB-008: Writes stdout/stderr files even on failure
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — files on failure (T-CCB-008)", () => {
  let temp: TempDirs;

  beforeEach(async () => {
    temp = await makeTempDirs();
  });

  afterEach(async () => {
    await rm(temp.projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "writes stdout and stderr files even when the command fails (T-CCB-008, UC-ART-001,2, FP-ART-STDOUT-FILE, FP-ART-STDERR-FILE)",
    async () => {
      const backend = new ClaudeCodeBackend({
        command: "node",
        args: ["-e", "console.log('partial stdout'); console.error('failure stderr'); process.exit(3)"],
        timeout: 30_000,
      });

      const result = await backend.execute({
        prompt: "this will fail",
        reportPath: temp.reportPath,
        stepDir: temp.stepDir,
        projectRoot: temp.projectRoot,
      });

      expect(result.success).toBe(false);

      // RED-PHASE: stdout/stderr files may not be written yet in v0.1
      // Verify files exist (if Step 2 has implemented file writing)
      const stdoutPath = (result as unknown as unknown as Record<string, unknown>)["stdoutPath"] as string | undefined;
      const stderrPath = (result as unknown as Record<string, unknown>)["stderrPath"] as string | undefined;

      if (stdoutPath) {
        const stdoutContent = await readFile(stdoutPath, "utf-8");
        expect(stdoutContent).toContain("partial stdout");
      }

      if (stderrPath) {
        const stderrContent = await readFile(stderrPath, "utf-8");
        expect(stderrContent).toContain("failure stderr");
      }

      // At least one of the paths should be set (even if the other is
      // the assertion above already handles undefined)
      expect(stdoutPath ?? stderrPath).toBeDefined();
    }
  );
});

// ---------------------------------------------------------------------------
// T-CCB-009: Writes stdout/stderr files even on timeout
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — files on timeout (T-CCB-009)", () => {
  let temp: TempDirs;

  beforeEach(async () => {
    temp = await makeTempDirs();
  });

  afterEach(async () => {
    await rm(temp.projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "writes stdout and stderr files even on process timeout (T-CCB-009, UC-ART-001,2, FP-ART-STDOUT-FILE, FP-ART-STDERR-FILE)",
    async () => {
      // Use a very short timeout to force timeout behavior
      const backend = new ClaudeCodeBackend({
        command: "node",
        args: [
          "-e",
          "console.log('partial output before timeout'); setTimeout(() => {}, 100000)",
        ],
        timeout: 2_000, // 2 seconds
      });

      const result = await backend.execute({
        prompt: "this will time out",
        reportPath: temp.reportPath,
        stepDir: temp.stepDir,
        projectRoot: temp.projectRoot,
      });

      expect(result.success).toBe(false);

      // Error should indicate timeout
      const errorMsg = result.error ?? "";
      expect(errorMsg.toLowerCase()).toMatch(/timeout|timed out/);

      // RED-PHASE: File paths might not be in result yet
      const stdoutPath = (result as unknown as unknown as Record<string, unknown>)["stdoutPath"] as string | undefined;
      const stderrPath = (result as unknown as Record<string, unknown>)["stderrPath"] as string | undefined;

      if (stdoutPath) {
        // Even on timeout, some partial stdout may be captured
        const stdoutContent = await readFile(stdoutPath, "utf-8");
        expect(stdoutContent).toContain("partial output before timeout");
      }

      // Error message must NOT contain embedded stdout/stderr
      expect(errorMsg).not.toMatch(/stdout \(last \d+ chars\)/i);
      expect(errorMsg).not.toMatch(/stderr \(last \d+ chars\)/i);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CCB-011: Constructor interpolates ${VAR} in env values
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — env var interpolation (T-CCB-011)", () => {
  it(
    "interpolates ${VAR_NAME} placeholders in env config values at construction time (T-CCB-011, UC-ENV-001, FP-ENV-INTERPOLATE)",
    () => {
      const originalValue = process.env["TEST_ENV_VAR"];
      try {
        process.env["TEST_ENV_VAR"] = "hello";

        const backend = new ClaudeCodeBackend({
          command: "node",
          args: ["-p"],
          timeout: 5_000,
          env: {
            MY_VAR: "${TEST_ENV_VAR}",
            LITERAL: "world",
          },
        });

        // Access the private env field via cast to any
        const env = (backend as unknown as Record<string, unknown>)["env"] as Record<string, string | undefined>;

        expect(env["MY_VAR"]).toBe("hello");
        expect(env["LITERAL"]).toBe("world");
      } finally {
        // Restore original value
        if (originalValue === undefined) {
          delete process.env["TEST_ENV_VAR"];
        } else {
          process.env["TEST_ENV_VAR"] = originalValue;
        }
      }
    }
  );

  it(
    "leaves ${VAR_NAME} as-is when the referenced env variable is not set (T-CCB-011)",
    () => {
      // Ensure the variable is not set
      const key = "ZIGMA_TEST_UNSET_VAR_XYZ";
      delete process.env[key];

      const backend = new ClaudeCodeBackend({
        command: "node",
        args: ["-p"],
        timeout: 5_000,
        env: {
          MY_VAR: `\${${key}}`,
        },
      });

      const env = (backend as unknown as Record<string, unknown>)["env"] as Record<string, string | undefined>;
      expect(env["MY_VAR"]).toBe(`\${${key}}`);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CCB-010: Returns exitCode in structured result on failure
// ---------------------------------------------------------------------------

describe("ClaudeCodeBackend — exitCode in result (T-CCB-010)", () => {
  let temp: TempDirs;

  beforeEach(async () => {
    temp = await makeTempDirs();
  });

  afterEach(async () => {
    await rm(temp.projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "returns exitCode in the structured result on non-zero exit (T-CCB-010, UC-EVT-004, FP-ART-STRUCTURED-RESULT)",
    async () => {
      const backend = new ClaudeCodeBackend({
        command: "node",
        args: ["-e", "console.log('fail'); console.error('err'); process.exit(42)"],
        timeout: 30_000,
      });

      const result = await backend.execute({
        prompt: "this will exit 42",
        reportPath: temp.reportPath,
        stepDir: temp.stepDir,
        projectRoot: temp.projectRoot,
      });

      expect(result.success).toBe(false);

      const r = result as unknown as Record<string, unknown>;

      // RED-PHASE: exitCode is not yet in AgentExecuteResult
      const exitCode = r["exitCode"] as number | undefined;
      expect(exitCode).toBeDefined();
      if (exitCode !== undefined) {
        expect(exitCode).toBe(42);
      }

      // exitCode should be distinct from the generic "unknown" string
      // in the error message (v0.1 uses "unknown" as a fallback string)
      expect(result.error).not.toContain("exit code unknown");
    }
  );
});
