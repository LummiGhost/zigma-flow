/**
 * ExecaProcessRunner tests for WF-P6-RUNNER (Step 1 — Cases and Tests).
 *
 * Covers:
 *   - T-RUNNER-1: zero-exit, stdout capture, ISO 8601 timestamps.
 *   - T-RUNNER-2: non-zero exit + stderr capture (runner does NOT throw).
 *   - T-RUNNER-3: timeout → `timedOut: true`, `exitCode: 124`.
 *   - T-RUNNER-4: custom `cwd` is honoured by the subprocess.
 *   - T-RUNNER-5: custom `env` is merged onto host env.
 *   - T-RUNNER-6: spawn failure (binary not found) → throws `ScriptError`.
 *
 * Reference:
 *   - docs/phases/p6-script-step/workflows/wf-p6-runner/01-cases-and-tests.md
 *   - docs/architecture.md §9.4 (ScriptResult), §10 (timeout scenario)
 *   - docs/mvp-contracts.md §2.7 (Script Result Contract), §6 (ProcessRunner)
 *
 * Red-phase note: `src/script/index.ts` currently exports `{}` and
 * `ScriptError` is not yet declared in `src/utils/errors.ts`. These tests
 * intentionally fail to resolve their named imports until Step 2 implements
 * `ProcessRunner`, `ExecaProcessRunner`, `ScriptRunResult`, and `ScriptError`.
 *
 * Subprocess strategy: NO mocking. Every test spawns a real child via
 * `ExecaProcessRunner`. To avoid shell-syntax portability headaches across
 * PowerShell, cmd, bash, and zsh, the commands are constructed as
 * `"<node> -e \"<script>\""` strings, where `<node>` is the absolute
 * `process.execPath` so PATH lookups cannot interfere.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExecaProcessRunner, type ProcessRunner } from "../../src/script/index.js";
import { ScriptError } from "../../src/utils/index.js";

/**
 * Build a `node -e "<script>"` command using the absolute path of the
 * currently-executing node binary. This is portable across Windows, macOS,
 * and Linux because we never rely on PATH or on shell-specific quoting
 * beyond plain double quotes (which all four target shells accept).
 *
 * The inner JavaScript source must not contain double quotes — we escape
 * via single quotes inside the JS body.
 */
function nodeCommand(jsSource: string): string {
  // Quote the node path in case it contains spaces (e.g. on Windows under
  // "C:\\Program Files\\nodejs\\node.exe").
  return `"${process.execPath}" -e "${jsSource}"`;
}

describe("ExecaProcessRunner", () => {
  let runner: ProcessRunner;

  beforeEach(() => {
    runner = new ExecaProcessRunner();
  });

  it("T-RUNNER-1: returns exitCode 0 and captures stdout when the command succeeds", async () => {
    const result = await runner.run({
      command: nodeCommand("process.stdout.write('hello')"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("hello");
    // startedAt / endedAt must be valid ISO 8601 timestamps.
    expect(Number.isNaN(Date.parse(result.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(result.endedAt))).toBe(false);
    // endedAt must be at or after startedAt.
    expect(Date.parse(result.endedAt)).toBeGreaterThanOrEqual(
      Date.parse(result.startedAt)
    );
  });

  it("T-RUNNER-2: returns the non-zero exitCode and captures stderr without throwing", async () => {
    const result = await runner.run({
      command: nodeCommand(
        "console.error('boom'); process.exit(7)"
      ),
    });

    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("boom");
  });

  it(
    "T-RUNNER-3: marks the result as timedOut with exitCode 124 when the timeout elapses",
    async () => {
      const startMs = Date.now();
      const result = await runner.run({
        // setTimeout(noop, 5000) keeps the event loop alive for ~5s. Our
        // timeoutMs (300) must trip well before that.
        command: nodeCommand("setTimeout(() => {}, 5000)"),
        timeoutMs: 300,
      });
      const elapsedMs = Date.now() - startMs;

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(124);
      // The subprocess was actually killed — we did not just wait 5s.
      // Allow up to 4s for SIGTERM + forceKillAfterDelay(500ms) + overhead.
      expect(elapsedMs).toBeLessThan(4000);
    },
    // Vitest per-test timeout: 8s — well above the 300ms process timeout +
    // 500ms forceKillAfterDelay, but below the 5s subprocess sleep duration.
    8000
  );

  describe("with custom cwd / env", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "zigma-runner-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("T-RUNNER-4: runs the command with the requested cwd", async () => {
      const result = await runner.run({
        command: nodeCommand("process.stdout.write(process.cwd())"),
        cwd: tmpDir,
      });

      expect(result.exitCode).toBe(0);
      // Windows os.tmpdir() can return a short-name (8.3) path while the
      // child reports the long-name (or vice versa). Normalise both sides
      // through realpathSync so the comparison is path-shape-agnostic.
      const expected = realpathSync(tmpDir);
      const actual = realpathSync(result.stdout.trim());
      expect(actual).toBe(expected);
    });

    it("T-RUNNER-5: injects custom env vars and still inherits baseline env", async () => {
      const result = await runner.run({
        command: nodeCommand(
          "process.stdout.write(process.env.ZIGMA_TEST || '')"
        ),
        env: { ZIGMA_TEST: "from-runner" },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("from-runner");
    });
  });

  it("T-RUNNER-6: throws ScriptError when the binary cannot be spawned", async () => {
    // shell: false disables the OS shell so execa performs a direct binary
    // lookup. There is no executable with this name on PATH, so spawn must
    // fail with ENOENT and the runner must wrap it in ScriptError.
    const promise = runner.run({
      command: "this-binary-definitely-does-not-exist-xyzzy",
      shell: false,
    });

    await expect(promise).rejects.toBeInstanceOf(ScriptError);

    try {
      await promise;
      // If we reach this line, the promise unexpectedly resolved.
      expect.fail("expected runner.run to reject with ScriptError");
    } catch (err) {
      expect(err).toBeInstanceOf(ScriptError);
      expect((err as ScriptError).kind).toBe("ScriptError");
    }
  });
});
