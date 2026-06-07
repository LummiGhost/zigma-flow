/**
 * Artifact module unit tests for WF-P4-ARTIFACT (Step 1 — Cases and Tests).
 *
 * The `artifact/` module owns artifact path allocation, path-safety enforcement,
 * content write and the run-level `artifacts.jsonl` append-only index. Tests
 * use real tmp directories (not fs mocks) and inject a deterministic clock for
 * `created_at` assertions.
 *
 * Reference:
 *   - docs/mvp-contracts.md §2.5 Artifact Contract
 *   - docs/architecture.md §8.1 Run directory layout, §8.2 Artifact contract
 *   - docs/prd.md §16 Data directory design
 *   - docs/phases/p4-event-artifact/workflows/wf-p4-artifact/01-cases-and-tests.md
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  type ArtifactMetadata,
  type Clock,
  appendArtifactIndex,
  artifactPath,
  assertPathSafe,
  writeArtifact,
} from "../../src/artifact/index.js";
import { ArtifactError } from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class FakeClock implements Clock {
  constructor(private readonly iso: string) {}
  now(): string {
    return this.iso;
  }
}

const FIXED_ISO = "2026-06-08T00:00:00.000Z";
const FIXED_RUN_ID = "20260608-0001";

async function makeRunDir(): Promise<string> {
  const tmp = join(tmpdir(), `zigma-artifact-test-${randomUUID()}`);
  await mkdir(tmp, { recursive: true });
  return tmp;
}

// ---------------------------------------------------------------------------
// assertPathSafe
// ---------------------------------------------------------------------------

describe("assertPathSafe", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await makeRunDir();
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("accepts a safe relative path under runDir (UC-SAFE-1, T-SAFE-1)", () => {
    expect(() =>
      assertPathSafe(runDir, "jobs/a/attempts/1/steps/b/stdout.log")
    ).not.toThrow();
  });

  it("rejects empty string with ArtifactError (UC-SAFE-2, T-SAFE-2)", () => {
    expect(() => assertPathSafe(runDir, "")).toThrow(ArtifactError);
  });

  it("rejects absolute path with ArtifactError (UC-SAFE-3, T-SAFE-3)", () => {
    expect(() => assertPathSafe(runDir, "/etc/passwd")).toThrow(ArtifactError);
  });

  it("rejects .. traversal escaping runDir with ArtifactError (UC-SAFE-4, T-SAFE-4)", () => {
    expect(() => assertPathSafe(runDir, "../escape")).toThrow(ArtifactError);
    expect(() => assertPathSafe(runDir, "jobs/../../escape")).toThrow(
      ArtifactError
    );
  });

  it("accepts mid-path .. that resolves inside runDir (UC-SAFE-5, T-SAFE-5)", () => {
    expect(() =>
      assertPathSafe(runDir, "jobs/a/../a/file.log")
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// artifactPath
// ---------------------------------------------------------------------------

describe("artifactPath", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await makeRunDir();
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("returns runDir-joined jobs/<job>/attempts/<n>/steps/<step>/<file> path (UC-PATH-1, T-PATH-1)", () => {
    const p = artifactPath(runDir, "build", 1, "compile", "stdout.log");
    const expected = join(
      runDir,
      "jobs",
      "build",
      "attempts",
      "1",
      "steps",
      "compile",
      "stdout.log"
    );
    expect(p).toBe(expected);
  });

  it("output is within runDir (UC-PATH-2, T-PATH-2)", () => {
    const p = artifactPath(runDir, "j", 2, "s", "f.txt");
    // The allocated path must begin with runDir (after node:path normalization).
    expect(p.startsWith(runDir)).toBe(true);
    // And path-safety must hold for the relative form.
    const rel = "jobs/j/attempts/2/steps/s/f.txt";
    expect(() => assertPathSafe(runDir, rel)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// writeArtifact
// ---------------------------------------------------------------------------

describe("writeArtifact", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await makeRunDir();
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("writes the file with the provided content (UC-WRITE-1, T-WRITE-1)", async () => {
    await writeArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      job: "j",
      step: "s",
      attempt: 1,
      kind: "stdout",
      filename: "stdout.log",
      content: "hello world",
      contentType: "text/plain",
      summary: "ok",
      clock: new FakeClock(FIXED_ISO),
    });

    const onDisk = join(
      runDir,
      "jobs",
      "j",
      "attempts",
      "1",
      "steps",
      "s",
      "stdout.log"
    );
    const text = await readFile(onDisk, "utf-8");
    expect(text).toBe("hello world");
  });

  it("returns metadata with all required fields (UC-WRITE-1, T-WRITE-2)", async () => {
    const md = await writeArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      job: "j",
      step: "s",
      attempt: 1,
      kind: "stdout",
      filename: "stdout.log",
      content: "hello",
      contentType: "text/plain",
      summary: "ok",
      clock: new FakeClock(FIXED_ISO),
    });

    expect(md.id).toBeDefined();
    expect(md.run_id).toBe(FIXED_RUN_ID);
    expect(md.producer).toEqual({ job: "j", step: "s", attempt: 1 });
    expect(md.kind).toBe("stdout");
    expect(md.path).toBeDefined();
    expect(md.content_type).toBe("text/plain");
    expect(typeof md.size).toBe("number");
    expect(md.summary).toBe("ok");
    expect(md.created_at).toBeDefined();
  });

  it("returns metadata.size equal to content byte length (UC-WRITE-2, T-WRITE-3)", async () => {
    const content = "hello world"; // 11 bytes ASCII
    const md = await writeArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      job: "j",
      step: "s",
      attempt: 1,
      kind: "stdout",
      filename: "stdout.log",
      content,
      contentType: "text/plain",
      summary: "ok",
      clock: new FakeClock(FIXED_ISO),
    });
    expect(md.size).toBe(Buffer.byteLength(content, "utf-8"));
  });

  it("uses injected clock for created_at (UC-WRITE-3, T-WRITE-4)", async () => {
    const md = await writeArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      job: "j",
      step: "s",
      attempt: 1,
      kind: "stdout",
      filename: "stdout.log",
      content: "hello",
      contentType: "text/plain",
      summary: "ok",
      clock: new FakeClock(FIXED_ISO),
    });
    expect(md.created_at).toBe(FIXED_ISO);
  });

  it("returns metadata.id following the artifact:// scheme (UC-WRITE-4, T-WRITE-5)", async () => {
    const md = await writeArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      job: "j",
      step: "s",
      attempt: 1,
      kind: "stdout",
      filename: "stdout.log",
      content: "hello",
      contentType: "text/plain",
      summary: "ok",
      clock: new FakeClock(FIXED_ISO),
    });
    // Per architecture §8.2 the id ends with the filename stem (no extension).
    expect(md.id).toBe(
      `artifact://${FIXED_RUN_ID}/jobs/j/attempts/1/steps/s/stdout`
    );
  });

  it("returns metadata.path as a relative POSIX-style path (UC-WRITE-1, T-WRITE-6)", async () => {
    const md = await writeArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      job: "j",
      step: "s",
      attempt: 1,
      kind: "stdout",
      filename: "stdout.log",
      content: "hello",
      contentType: "text/plain",
      summary: "ok",
      clock: new FakeClock(FIXED_ISO),
    });
    expect(md.path).toBe("jobs/j/attempts/1/steps/s/stdout.log");
  });
});

// ---------------------------------------------------------------------------
// appendArtifactIndex
// ---------------------------------------------------------------------------

describe("appendArtifactIndex", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await makeRunDir();
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("creates artifacts.jsonl on first call (UC-INDEX-1, T-INDEX-1)", async () => {
    const md: ArtifactMetadata = {
      id: `artifact://${FIXED_RUN_ID}/jobs/j/attempts/1/steps/s/stdout`,
      run_id: FIXED_RUN_ID,
      producer: { job: "j", step: "s", attempt: 1 },
      kind: "stdout",
      path: "jobs/j/attempts/1/steps/s/stdout.log",
      content_type: "text/plain",
      size: 5,
      summary: "ok",
      created_at: FIXED_ISO,
    };

    await appendArtifactIndex(runDir, md);

    const indexPath = join(runDir, "artifacts.jsonl");
    const text = await readFile(indexPath, "utf-8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!)).toEqual(md);
  });

  it("preserves existing entries when appending (UC-INDEX-2, T-INDEX-2)", async () => {
    const md1: ArtifactMetadata = {
      id: `artifact://${FIXED_RUN_ID}/jobs/j/attempts/1/steps/s/stdout`,
      run_id: FIXED_RUN_ID,
      producer: { job: "j", step: "s", attempt: 1 },
      kind: "stdout",
      path: "jobs/j/attempts/1/steps/s/stdout.log",
      content_type: "text/plain",
      size: 5,
      summary: "ok",
      created_at: FIXED_ISO,
    };
    const md2: ArtifactMetadata = {
      ...md1,
      id: `artifact://${FIXED_RUN_ID}/jobs/j/attempts/1/steps/s/stderr`,
      kind: "stderr",
      path: "jobs/j/attempts/1/steps/s/stderr.log",
    };

    await appendArtifactIndex(runDir, md1);
    await appendArtifactIndex(runDir, md2);

    const indexPath = join(runDir, "artifacts.jsonl");
    const text = await readFile(indexPath, "utf-8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!)).toEqual(md1);
    expect(JSON.parse(lines[1]!)).toEqual(md2);
  });
});

// ---------------------------------------------------------------------------
// Retry attempt isolation
// ---------------------------------------------------------------------------

describe("retry attempt isolation", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await makeRunDir();
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("attempts 1 and 2 of same job/step produce different paths (UC-RETRY-1, T-RETRY-1)", async () => {
    const md1 = await writeArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      job: "j",
      step: "s",
      attempt: 1,
      kind: "stdout",
      filename: "stdout.log",
      content: "attempt one",
      contentType: "text/plain",
      summary: "attempt 1",
      clock: new FakeClock(FIXED_ISO),
    });
    const md2 = await writeArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      job: "j",
      step: "s",
      attempt: 2,
      kind: "stdout",
      filename: "stdout.log",
      content: "attempt two",
      contentType: "text/plain",
      summary: "attempt 2",
      clock: new FakeClock(FIXED_ISO),
    });

    expect(md1.path).not.toBe(md2.path);
    expect(md1.path).toBe("jobs/j/attempts/1/steps/s/stdout.log");
    expect(md2.path).toBe("jobs/j/attempts/2/steps/s/stdout.log");

    // Both files exist on disk.
    const p1 = join(runDir, md1.path);
    const p2 = join(runDir, md2.path);
    expect((await stat(p1)).isFile()).toBe(true);
    expect((await stat(p2)).isFile()).toBe(true);
  });

  it("attempt 2 write does not overwrite attempt 1 file (UC-RETRY-1, T-RETRY-2)", async () => {
    await writeArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      job: "j",
      step: "s",
      attempt: 1,
      kind: "stdout",
      filename: "stdout.log",
      content: "attempt one",
      contentType: "text/plain",
      summary: "attempt 1",
      clock: new FakeClock(FIXED_ISO),
    });
    await writeArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      job: "j",
      step: "s",
      attempt: 2,
      kind: "stdout",
      filename: "stdout.log",
      content: "attempt two",
      contentType: "text/plain",
      summary: "attempt 2",
      clock: new FakeClock(FIXED_ISO),
    });

    const p1 = join(
      runDir,
      "jobs",
      "j",
      "attempts",
      "1",
      "steps",
      "s",
      "stdout.log"
    );
    const text = await readFile(p1, "utf-8");
    expect(text).toBe("attempt one");
  });
});
