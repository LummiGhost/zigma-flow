/**
 * Owned child-process lifecycle.
 *
 * Cancellation and timeout both request the same idempotent process-tree
 * termination. Completion is acknowledged only after the child promise and
 * any platform termination helper have settled.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface OwnedSubprocess<Result> extends PromiseLike<Result> {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface WaitForSubprocessOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SettledSubprocess<Result> {
  result: Result;
  timedOut: boolean;
  cancelled: boolean;
}

async function terminateProcessTree(subprocess: OwnedSubprocess<unknown>): Promise<void> {
  const pid = subprocess.pid;
  if (process.platform === "win32" && pid !== undefined) {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
      });
    } catch {
      // The child may have exited between the request and taskkill's lookup.
    }
    return;
  }

  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through when the process is not a process-group leader.
    }
  }

  try {
    subprocess.kill("SIGKILL");
  } catch {
    // The process has already exited.
  }
}

export async function waitForSubprocess<Result>(
  subprocess: OwnedSubprocess<Result>,
  opts: WaitForSubprocessOptions = {},
): Promise<SettledSubprocess<Result>> {
  let timedOut = false;
  let termination: Promise<void> | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const terminateOnce = (): Promise<void> => {
    termination ??= terminateProcessTree(subprocess);
    return termination;
  };
  const onAbort = (): void => {
    void terminateOnce();
  };

  if (opts.signal?.aborted) {
    onAbort();
  } else {
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  }
  if (opts.timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      void terminateOnce();
    }, opts.timeoutMs);
  }

  try {
    const result = await subprocess;
    return { result, timedOut, cancelled: opts.signal?.aborted === true };
  } catch (error: unknown) {
    if (timedOut && typeof error === "object" && error !== null) {
      Object.assign(error, { timedOut: true });
    }
    throw error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    opts.signal?.removeEventListener("abort", onAbort);
    if (termination !== undefined) await termination;
  }
}
