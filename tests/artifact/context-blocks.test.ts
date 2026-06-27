/**
 * Context Block artifact tests for WF-P13-VARIABLES (Step 1 — Cases and Tests).
 *
 * These tests exercise the new `context_block` artifact kind for versioned
 * context blocks at `context-blocks/<block-id>/v<N>.md`. Each new write
 * creates a new version; old versions are never overwritten.
 *
 * New artifact kind: `context_block`
 * Artifact path: `context-blocks/<block-id>/v<N>.md`
 *
 * New function: `writeContextBlockArtifact(opts)` — writes a new version
 * without overwriting old versions.
 *
 * Covers:
 *   - FR-ART-CB-001 through FR-ART-CB-004
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-variables/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md AD-P13-011
 *
 * Red-phase note: `src/artifact/` does not yet support the `context_block`
 * kind or `writeContextBlockArtifact`. Until Step 2 implements them, the
 * dynamic import will fail.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { ArtifactMetadata, Clock } from "../../src/artifact/index.js";
import { writeArtifact, appendArtifactIndex } from "../../src/artifact/index.js";

// ---------------------------------------------------------------------------
// Lazy import wrapper for writeContextBlockArtifact (red-phase compatible)
// ---------------------------------------------------------------------------

export interface WriteContextBlockArtifactOpts {
  runDir: string;
  runId: string;
  /** The context block identifier (e.g. "design_notes") */
  blockId: string;
  /** The version number to write (1, 2, ...) */
  version: number;
  /** The content string to write */
  content: string;
  /** The job/step/attempt that wrote this block */
  job: string;
  step: string;
  attempt: number;
  clock: Clock;
}

const CTX_BLOCK_MODULE_SPECIFIER = "../../src/artifact/index.js";

async function callWriteContextBlockArtifact(
  opts: WriteContextBlockArtifactOpts
): Promise<ArtifactMetadata> {
  let mod: {
    writeContextBlockArtifact?: (
      o: WriteContextBlockArtifactOpts
    ) => Promise<ArtifactMetadata>;
  };
  try {
    mod = (await import(
      /* @vite-ignore */ String(CTX_BLOCK_MODULE_SPECIFIER)
    )) as {
      writeContextBlockArtifact?: (
        o: WriteContextBlockArtifactOpts
      ) => Promise<ArtifactMetadata>;
    };
  } catch (e: unknown) {
    throw new Error(
      `writeContextBlockArtifact is not yet implemented — src/artifact/ does not export writeContextBlockArtifact (WF-P13-VARIABLES Step 2 has not yet shipped). Underlying: ${String(e)}`
    );
  }
  if (typeof mod.writeContextBlockArtifact !== "function") {
    throw new Error(
      "writeContextBlockArtifact is not exported from src/artifact/index.ts — WF-P13-VARIABLES Step 2 has not yet shipped the implementation."
    );
  }
  return mod.writeContextBlockArtifact(opts);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-28T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

const FIXED_RUN_ID = "20260628-0001";

async function makeRunDir(): Promise<string> {
  const tmp = join(tmpdir(), `zigma-ctx-block-${randomUUID()}`);
  await mkdir(tmp, { recursive: true });
  return tmp;
}

// ---------------------------------------------------------------------------
// FR-ART-CB-001: context_block v1 artifact created with correct path
// ---------------------------------------------------------------------------

describe("context block artifact — v1 creation (FR-ART-CB-001)", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await makeRunDir();
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it(
    "writeContextBlockArtifact creates v1 at context-blocks/<block-id>/v1.md (FR-ART-CB-001, UC-VAR-021)",
    async () => {
      const meta = await callWriteContextBlockArtifact({
        runDir,
        runId: FIXED_RUN_ID,
        blockId: "design_notes",
        version: 1,
        content: "# Design Notes\n\nInitial version.",
        job: "plan",
        step: "draft",
        attempt: 1,
        clock: new FakeClock(),
      });

      // Verify metadata
      expect(meta).toBeDefined();
      expect(meta.kind).toBe("context_block");
      expect(meta.path).toContain("context-blocks/design_notes/v1");
      expect(meta.path).toContain(".md");
      expect(meta.run_id).toBe(FIXED_RUN_ID);
      expect(meta.producer).toMatchObject({
        job: "plan",
        step: "draft",
        attempt: 1,
      });

      // Verify the file was actually written on disk
      const fullPath = join(runDir, meta.path);
      const content = await readFile(fullPath, "utf-8");
      expect(content).toContain("# Design Notes");
      expect(content).toContain("Initial version.");
    }
  );
});

// ---------------------------------------------------------------------------
// FR-ART-CB-002: context_block v2 created, v1 still exists
// ---------------------------------------------------------------------------

describe("context block artifact — versioning (FR-ART-CB-002)", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await makeRunDir();
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it(
    "context_block v2 created, v1 still exists with no overwrite (FR-ART-CB-002, UC-VAR-021)",
    async () => {
      // Write v1
      const v1 = await callWriteContextBlockArtifact({
        runDir,
        runId: FIXED_RUN_ID,
        blockId: "design_notes",
        version: 1,
        content: "# Version 1",
        job: "plan",
        step: "draft",
        attempt: 1,
        clock: new FakeClock(),
      });

      // Write v2
      const v2 = await callWriteContextBlockArtifact({
        runDir,
        runId: FIXED_RUN_ID,
        blockId: "design_notes",
        version: 2,
        content: "# Version 2\n\nUpdated.",
        job: "plan",
        step: "draft",
        attempt: 1,
        clock: new FakeClock("2026-06-28T01:00:00.000Z"),
      });

      // Verify v2 path is different from v1
      expect(v2.path).not.toBe(v1.path);
      expect(v2.path).toContain("v2");
      expect(v1.path).toContain("v1");

      // Verify v1 still exists on disk (not overwritten)
      const v1Path = join(runDir, v1.path);
      const v1Content = await readFile(v1Path, "utf-8");
      expect(v1Content).toContain("# Version 1");

      // Verify v2 exists on disk with its content
      const v2Path = join(runDir, v2.path);
      const v2Content = await readFile(v2Path, "utf-8");
      expect(v2Content).toContain("# Version 2");
      expect(v2Content).toContain("Updated.");

      // Both files should exist independently
      expect(v1Path).not.toBe(v2Path);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-ART-CB-003: artifact metadata includes producer, version, size
// ---------------------------------------------------------------------------

describe("context block artifact — metadata (FR-ART-CB-003)", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await makeRunDir();
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it(
    "context_block artifact metadata includes producer, version, size (FR-ART-CB-003)",
    async () => {
      const content = "# Design Notes\n\n## Section 1\nContent here.\n\n## Section 2\nMore content.";
      const expectedSize = Buffer.byteLength(content, "utf-8");

      const meta = await callWriteContextBlockArtifact({
        runDir,
        runId: FIXED_RUN_ID,
        blockId: "design_notes",
        version: 1,
        content,
        job: "plan",
        step: "draft",
        attempt: 1,
        clock: new FakeClock(),
      });

      // Verify metadata fields
      expect(meta.producer).toBeDefined();
      expect(meta.producer.job).toBe("plan");
      expect(meta.producer.step).toBe("draft");
      expect(meta.producer.attempt).toBe(1);

      // Size should match the content byte length
      expect(meta.size).toBe(expectedSize);

      // Should have a created_at timestamp
      expect(meta.created_at).toBeDefined();
      expect(typeof meta.created_at).toBe("string");

      // Content type should be markdown
      expect(meta.content_type).toBe("text/markdown");

      // Summary should be present
      expect(typeof meta.summary).toBe("string");
    }
  );
});

// ---------------------------------------------------------------------------
// FR-ART-CB-004: artifact kind is "context_block"
// ---------------------------------------------------------------------------

describe("context block artifact — kind (FR-ART-CB-004)", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await makeRunDir();
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it(
    "context_block artifact has kind: context_block (FR-ART-CB-004)",
    async () => {
      const meta = await callWriteContextBlockArtifact({
        runDir,
        runId: FIXED_RUN_ID,
        blockId: "design_notes",
        version: 1,
        content: "# Notes",
        job: "plan",
        step: "draft",
        attempt: 1,
        clock: new FakeClock(),
      });

      // The kind must be exactly "context_block"
      expect(meta.kind).toBe("context_block");

      // Also verify the artifact can be indexed
      await appendArtifactIndex(runDir, meta);

      // Read back the index
      const indexPath = join(runDir, "artifacts.jsonl");
      const indexContent = await readFile(indexPath, "utf-8");
      const parsed = JSON.parse(indexContent.trim()) as ArtifactMetadata;
      expect(parsed.kind).toBe("context_block");
      expect(parsed.path).toContain("context-blocks/design_notes/v1");
    }
  );
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("context block artifact — edge cases", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await makeRunDir();
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("handles empty content", async () => {
    const meta = await callWriteContextBlockArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      blockId: "empty_block",
      version: 1,
      content: "",
      job: "plan",
      step: "draft",
      attempt: 1,
      clock: new FakeClock(),
    });

    expect(meta.kind).toBe("context_block");
    expect(meta.size).toBe(0);

    const fullPath = join(runDir, meta.path);
    const content = await readFile(fullPath, "utf-8");
    expect(content).toBe("");
  });

  it("handles multi-line markdown content", async () => {
    const content = [
      "# Multi-line Block",
      "",
      "## Section A",
      "- item 1",
      "- item 2",
      "- item 3",
      "",
      "## Section B",
      "",
      "```",
      "code block",
      "```",
      "",
      "> A blockquote",
    ].join("\n");

    const meta = await callWriteContextBlockArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      blockId: "multi_block",
      version: 1,
      content,
      job: "plan",
      step: "draft",
      attempt: 1,
      clock: new FakeClock(),
    });

    const fullPath = join(runDir, meta.path);
    const readBack = await readFile(fullPath, "utf-8");
    expect(readBack).toBe(content);
  });

  it("handles high version numbers (e.g., v42)", async () => {
    const meta = await callWriteContextBlockArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      blockId: "frequent_block",
      version: 42,
      content: "# Version 42",
      job: "plan",
      step: "draft",
      attempt: 1,
      clock: new FakeClock(),
    });

    expect(meta.path).toContain("v42");
    const fullPath = join(runDir, meta.path);
    const content = await readFile(fullPath, "utf-8");
    expect(content).toBe("# Version 42");
  });

  it("handles multiple different block IDs", async () => {
    const block1 = await callWriteContextBlockArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      blockId: "block_a",
      version: 1,
      content: "Block A v1",
      job: "plan",
      step: "draft",
      attempt: 1,
      clock: new FakeClock(),
    });

    const block2 = await callWriteContextBlockArtifact({
      runDir,
      runId: FIXED_RUN_ID,
      blockId: "block_b",
      version: 1,
      content: "Block B v1",
      job: "implement",
      step: "code",
      attempt: 1,
      clock: new FakeClock(),
    });

    // Paths should be in different directories
    expect(block1.path).toContain("context-blocks/block_a/v1");
    expect(block2.path).toContain("context-blocks/block_b/v1");
    expect(block1.path).not.toBe(block2.path);

    // Content should be independent
    const content1 = await readFile(join(runDir, block1.path), "utf-8");
    const content2 = await readFile(join(runDir, block2.path), "utf-8");
    expect(content1).toBe("Block A v1");
    expect(content2).toBe("Block B v1");
  });
});
