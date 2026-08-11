/**
 * Integration tests: ProcessRunner streaming (Issue #280).
 *
 * Verifies that stdout/stderr chunks are forwarded in real time through the
 * onStdout/onStderr callbacks while the full output is still captured.
 */

import { describe, test, expect } from "vitest";
import { ExecaProcessRunner } from "../../src/script/index.js";

describe("ProcessRunner streaming", () => {
  test("onStdout receives real-time chunks", async () => {
    const runner = new ExecaProcessRunner();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const result = await runner.run({
      command: process.platform === "win32"
        ? "node -e \"console.log('hello');console.error('world');console.log('done')\""
        : "node -e \"console.log('hello');console.error('world');console.log('done')\"",
      onStdout: (chunk) => { stdoutChunks.push(chunk); },
      onStderr: (chunk) => { stderrChunks.push(chunk); },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.stdout).toContain("done");
    expect(result.stderr).toContain("world");

    // Chunks were forwarded
    const allStdout = stdoutChunks.join("");
    expect(allStdout).toContain("hello");
    expect(allStdout).toContain("done");

    const allStderr = stderrChunks.join("");
    expect(allStderr).toContain("world");
  });

  test("onStdout works with multi-line output", async () => {
    const runner = new ExecaProcessRunner();
    const chunks: string[] = [];

    const result = await runner.run({
      command: process.platform === "win32"
        ? "node -e \"for(let i=0;i<5;i++) console.log('line '+i)\""
        : "node -e 'for(let i=0;i<5;i++) console.log(\"line \"+i)'",
      onStdout: (chunk) => { chunks.push(chunk); },
    });

    expect(result.exitCode).toBe(0);

    for (let i = 0; i < 5; i++) {
      expect(result.stdout).toContain(`line ${i}`);
    }

    // Verify streaming captured output
    const allChunks = chunks.join("");
    for (let i = 0; i < 5; i++) {
      expect(allChunks).toContain(`line ${i}`);
    }
  });

  test("full stdout is captured even when streaming", async () => {
    const runner = new ExecaProcessRunner();
    const chunks: string[] = [];

    const result = await runner.run({
      command: process.platform === "win32"
        ? "node -e \"console.log('a'.repeat(1000))\""
        : "node -e 'console.log(\"a\".repeat(1000))'",
      onStdout: (chunk) => { chunks.push(chunk); },
    });

    // Full output captured (with trailing newline from console.log)
    expect(result.stdout.trim().length).toBe(1000);

    // Stream chunks also sum to full output
    const streamed = chunks.join("").trim();
    expect(streamed.length).toBe(1000);
  });

  test("onStdout works with timeout", async () => {
    const runner = new ExecaProcessRunner();
    const chunks: string[] = [];

    const result = await runner.run({
      command: process.platform === "win32"
        ? "node -e \"console.log('start');setTimeout(()=>{},10000)\""
        : "node -e 'console.log(\"start\");setTimeout(()=>{},10000)'",
      timeoutMs: 2000,
      onStdout: (chunk) => { chunks.push(chunk); },
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);

    // stdout emitted before timeout was captured
    const allStdout = chunks.join("");
    expect(allStdout).toContain("start");
  });

  test("onStderr captures error output", async () => {
    const runner = new ExecaProcessRunner();
    const chunks: string[] = [];

    const result = await runner.run({
      command: process.platform === "win32"
        ? "node -e \"console.error('error message')\""
        : "node -e 'console.error(\"error message\")'",
      onStderr: (chunk) => { chunks.push(chunk); },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("error message");

    const allStderr = chunks.join("");
    expect(allStderr).toContain("error message");
  });

  test("streaming works without onStdout/onStderr (no-op)", async () => {
    const runner = new ExecaProcessRunner();

    const result = await runner.run({
      command: process.platform === "win32"
        ? "node -e \"console.log('hello')\""
        : "node -e 'console.log(\"hello\")'",
      // No onStdout/onStderr
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });
});
