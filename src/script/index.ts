/**
 * ProcessRunner port and ExecaProcessRunner adapter for WF-P6-RUNNER.
 *
 * Reference: docs/phases/p6-script-step/02-development-plan.md §4 (WF-P6-RUNNER)
 */

import { execSync, spawn } from "node:child_process";

import { execa } from "execa";

import { ScriptError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface RunCommandOptions {
  /** Single command string passed to the shell (or directly to execa if no shell). */
  command: string;
  /**
   * Shell executable ("bash", "sh", "cmd", etc.) or `false` to disable shell
   * and perform a direct binary exec. If omitted, the OS default shell is used.
   */
  shell?: string | false;
  /** Working directory; defaults to `process.cwd()`. */
  cwd?: string;
  /** Extra env vars merged onto `process.env`. */
  env?: Record<string, string>;
  /** Upper bound on wall-clock duration in milliseconds; no timeout if omitted. */
  timeoutMs?: number;
}

/** Raw result from the subprocess (camelCase; distinct from the persisted ScriptResult artifact). */
export interface ScriptRunResult {
  /** 0 on success; subprocess exit code on failure; 124 on timeout. */
  exitCode: number;
  /** true iff timeoutMs was exceeded and the process was killed. */
  timedOut: boolean;
  /** Raw captured stdout (may be empty). */
  stdout: string;
  /** Raw captured stderr (may be empty). */
  stderr: string;
  /** ISO 8601 timestamp recorded before spawn. */
  startedAt: string;
  /** ISO 8601 timestamp recorded after subprocess settles. */
  endedAt: string;
}

export interface ProcessRunner {
  run(opts: RunCommandOptions): Promise<ScriptRunResult>;
}

// ---------------------------------------------------------------------------
// ExecaProcessRunner adapter
// ---------------------------------------------------------------------------

/**
 * Attempt to spawn a binary directly (no shell) and detect spawn-level errors
 * such as ENOENT or EACCES. Returns the error if spawn fails, otherwise kills
 * the probe process and returns null.
 *
 * We use raw child_process.spawn here because execa with reject:false absorbs
 * spawn errors on Windows (ENOENT from cmd.exe is returned as exitCode:1, not
 * thrown), whereas Node's spawn always emits an 'error' event for genuine ENOENT.
 */
async function probeSpawn(command: string, cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<Error | null> {
  return new Promise<Error | null>((resolve) => {
    const child = spawn(command, [], {
      shell: false,
      ...(cwd !== undefined ? { cwd } : {}),
      env,
      stdio: "ignore",
    });

    let settled = false;

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        resolve(err);
      }
    });

    child.on("spawn", () => {
      // Spawn succeeded — kill the probe and report no error.
      if (!settled) {
        settled = true;
        child.kill();
        resolve(null);
      }
    });

    child.on("close", () => {
      // Close fires after kill() if no error was emitted first.
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
  });
}

/**
 * Kill a process and its entire process tree cross-platform.
 *
 * On Windows, Node's ChildProcess.kill() only terminates the immediate child
 * (cmd.exe when shell:true), leaving any grandchild processes (e.g. node.exe)
 * running as orphans. `taskkill /F /T` terminates the tree recursively.
 *
 * On POSIX, subprocess.kill() sends the signal to the process group which
 * propagates to children, so a direct kill() is sufficient.
 */
function killProcessTree(subprocess: { readonly pid?: number; kill(): boolean }): void {
  const pid = subprocess.pid;
  if (process.platform === "win32" && pid !== undefined) {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
    } catch {
      // Process was already terminated — ignore.
    }
  } else {
    subprocess.kill();
  }
}

export class ExecaProcessRunner implements ProcessRunner {
  async run(opts: RunCommandOptions): Promise<ScriptRunResult> {
    const startedAt = new Date().toISOString();

    // Determine the shell option for execa:
    //   - opts.shell is a string  → pass that string as the shell executable
    //   - opts.shell is false     → disable shell (direct binary exec)
    //   - opts.shell is undefined → use OS default shell (true)
    const shellOpt: string | boolean =
      opts.shell === false ? false : opts.shell !== undefined ? opts.shell : true;

    // When shell is explicitly disabled, probe for spawn failure first.
    // We do this because execa with reject:false absorbs spawn errors on
    // Windows (ENOENT from cmd.exe is returned as exitCode:1, not thrown).
    // Node's child_process.spawn always emits 'error' for genuine ENOENT.
    if (shellOpt === false) {
      const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
      const spawnError = await probeSpawn(opts.command, opts.cwd, mergedEnv);
      if (spawnError !== null) {
        throw new ScriptError(
          `Failed to spawn process: ${opts.command}`,
          { cause: spawnError }
        );
      }
    }

    // Use manual timeout + cross-platform process tree kill rather than
    // execa's built-in timeout. Execa's timeout only kills the immediate child
    // (cmd.exe on Windows), leaving grandchild processes alive until the
    // forceKillAfterDelay fires — which takes 5s by default and races against
    // the vitest test timeout.
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const subprocess = execa(opts.command, {
      shell: shellOpt,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: { ...process.env, ...opts.env },
      reject: false,
      encoding: "utf8",
    });

    if (opts.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killProcessTree(subprocess);
      }, opts.timeoutMs);
    }

    try {
      const result = await subprocess;
      const endedAt = new Date().toISOString();

      const isTimedOut = timedOut || result.timedOut === true;
      const exitCode = isTimedOut ? 124 : (result.exitCode ?? 0);
      const stdout = typeof result.stdout === "string" ? result.stdout : "";
      const stderr = typeof result.stderr === "string" ? result.stderr : "";

      return {
        exitCode,
        timedOut: isTimedOut,
        stdout,
        stderr,
        startedAt,
        endedAt,
      };
    } catch (err: unknown) {
      // execa throws even with reject:false for certain spawn failure modes
      // (e.g. on POSIX, ENOENT on the executable path).
      throw new ScriptError(
        `Failed to spawn process: ${opts.command}`,
        { cause: err }
      );
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }
}
