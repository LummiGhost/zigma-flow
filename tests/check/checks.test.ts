/**
 * File / JSON check-kind tests for WF-P7-FILECHECK (Step 1 — Cases and Tests).
 *
 * These tests exercise the four pure check functions that WF-P7-CHECK's
 * executor dispatches to: `checkFileExists`, `checkJsonParse`,
 * `checkJsonSchema`, `checkRequiredFields`. Each check function reads its
 * `with` arguments + the `runDir`, inspects the filesystem, and returns a
 * canonical `CheckResult` (`{ passed, check_id, failures, artifacts }`).
 *
 * Covers:
 *   - T-FC-1: file-exists pass (all files present, both `file` and `files`)
 *   - T-FC-2: file-exists fail (missing files listed in `failures[]`)
 *   - T-FC-3: json-parse pass (valid JSON)
 *   - T-FC-4: json-parse fail (invalid JSON; failure mentions location)
 *   - T-FC-5: json-schema pass (validates against draft-07 schema)
 *   - T-FC-6: json-schema fail (missing required field; failures list errors)
 *   - T-FC-7: required-fields pass (all top-level fields non-empty)
 *   - T-FC-8: required-fields fail (missing + empty field both reported)
 *
 * Reference:
 *   - docs/phases/p7-check-step/workflows/wf-p7-filecheck/01-cases-and-tests.md
 *   - docs/phases/p7-check-step/02-development-plan.md §4 WF-P7-FILECHECK
 *   - docs/prd.md FR-008
 *   - docs/architecture.md §9.4, §13 phase 7
 *   - docs/mvp-contracts.md §2.8
 *
 * Red-phase note: `src/check/checks/{file-exists,json-parse,json-schema,
 * required-fields}.ts` do not exist yet; tests fail at module resolution.
 * `ajv` is not yet a dependency either — the json-schema check function
 * (WF-P7-FILECHECK Step 2) introduces it. After Step 2 ships all four
 * source files and adds ajv, the eight T-FC-N tests should turn green.
 *
 * Function contract (uniform across all four kinds):
 *   ({ with: Record<string, unknown>, runDir: string }) => Promise<CheckResult>
 *
 *   - Paths in `with.file` / `with.files` / `with.schema` are resolved
 *     relative to `runDir`. Absolute paths are honoured as-is.
 *   - The returned `check_id` equals the canonical kind identifier:
 *     `"zigma/file-exists"`, `"zigma/json-parse"`, `"zigma/json-schema"`,
 *     `"zigma/required-fields"`.
 *   - `artifacts` is always `[]` (pure-logic checks).
 *   - Semantic failures (missing file, invalid JSON, schema violation,
 *     missing field) return `passed: false` with descriptive `failures[]`.
 *   - Malformed `with` (wrong type, missing required key) throws
 *     `CheckError` (not asserted in these red-phase tests — covered
 *     indirectly by WF-P7-CHECK T-CHECK-5 and Step 2 additions).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { CheckResult } from "../../src/check/index.js";
import { checkFileExists } from "../../src/check/checks/file-exists.js";
import { checkJsonParse } from "../../src/check/checks/json-parse.js";
import { checkJsonSchema } from "../../src/check/checks/json-schema.js";
import { checkRequiredFields } from "../../src/check/checks/required-fields.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

interface Sandbox {
  /** Absolute path to a per-test temp directory used as the check `runDir`. */
  runDir: string;
}

/**
 * Create a fresh temp directory to serve as the check's `runDir`. Each
 * test owns its own sandbox so fixture files do not bleed across cases.
 */
async function makeSandbox(): Promise<Sandbox> {
  const runDir = join(tmpdir(), `zigma-checks-${randomUUID()}`);
  await mkdir(runDir, { recursive: true });
  return { runDir };
}

/**
 * Write a fixture file under the sandbox at `relPath` with `content`.
 * Creates intermediate directories as needed and returns the absolute
 * path of the file. `relPath` MAY contain `/` for nested subdirectories.
 */
async function writeFixture(
  sandbox: Sandbox,
  relPath: string,
  content: string
): Promise<string> {
  const absPath = join(sandbox.runDir, relPath);
  const lastSep = Math.max(absPath.lastIndexOf("/"), absPath.lastIndexOf("\\"));
  if (lastSep > 0) {
    const dirPath = absPath.substring(0, lastSep);
    if (dirPath !== sandbox.runDir) {
      await mkdir(dirPath, { recursive: true });
    }
  }
  await writeFile(absPath, content, "utf-8");
  return absPath;
}

/**
 * Assert that a value is shaped like a canonical `CheckResult`:
 *   { passed: boolean, check_id: string, failures: string[], artifacts: string[] }
 *
 * Used as a precondition before per-case field assertions so a wrong-shape
 * regression surfaces as a clearer failure than a downstream `undefined`.
 */
function expectCheckResultShape(value: unknown): asserts value is CheckResult {
  expect(value).toBeDefined();
  expect(typeof value).toBe("object");
  const result = value as Record<string, unknown>;
  expect(typeof result["passed"]).toBe("boolean");
  expect(typeof result["check_id"]).toBe("string");
  expect(Array.isArray(result["failures"])).toBe(true);
  expect(Array.isArray(result["artifacts"])).toBe(true);
}

// ===========================================================================
// T-FC-1 / T-FC-2: file-exists
// ===========================================================================

describe("checkFileExists — file-exists kind", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.runDir, { recursive: true, force: true });
  });

  it(
    "passes when all listed files exist on disk (T-FC-1, UC-FC-1)",
    async () => {
      // Fixtures: two existing files at the sandbox root.
      await writeFixture(sandbox, "alpha.txt", "alpha");
      await writeFixture(sandbox, "beta.txt", "beta");

      // (a) Single-file form: with.file
      const single = await checkFileExists({
        with: { file: "alpha.txt" },
        runDir: sandbox.runDir,
      });
      expectCheckResultShape(single);
      expect(single.passed).toBe(true);
      expect(single.failures).toEqual([]);
      expect(single.check_id).toBe("zigma/file-exists");
      expect(single.artifacts).toEqual([]);

      // (b) Multi-file form: with.files
      const multi = await checkFileExists({
        with: { files: ["alpha.txt", "beta.txt"] },
        runDir: sandbox.runDir,
      });
      expectCheckResultShape(multi);
      expect(multi.passed).toBe(true);
      expect(multi.failures).toEqual([]);
      expect(multi.check_id).toBe("zigma/file-exists");
      expect(multi.artifacts).toEqual([]);
    }
  );

  it(
    "fails listing every missing path when one or more files are absent (T-FC-2, UC-FC-2)",
    async () => {
      // Only "present.txt" exists; "absent.txt" and "also-absent.txt" do not.
      await writeFixture(sandbox, "present.txt", "ok");

      const result = await checkFileExists({
        with: { files: ["present.txt", "absent.txt", "also-absent.txt"] },
        runDir: sandbox.runDir,
      });

      expectCheckResultShape(result);
      expect(result.passed).toBe(false);
      expect(result.check_id).toBe("zigma/file-exists");
      expect(result.artifacts).toEqual([]);

      // Both missing paths MUST appear somewhere in the failures list.
      expect(result.failures.length).toBe(2);
      const joined = result.failures.join("\n");
      expect(joined).toContain("absent.txt");
      expect(joined).toContain("also-absent.txt");
      // The present file MUST NOT appear in failures.
      expect(joined).not.toContain("present.txt");
    }
  );
});

// ===========================================================================
// T-FC-3 / T-FC-4: json-parse
// ===========================================================================

describe("checkJsonParse — json-parse kind", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.runDir, { recursive: true, force: true });
  });

  it(
    "passes for valid JSON file content (T-FC-3, UC-FC-3)",
    async () => {
      await writeFixture(
        sandbox,
        "good.json",
        JSON.stringify({ a: 1, b: [2, 3], c: { nested: true } })
      );

      const result = await checkJsonParse({
        with: { file: "good.json" },
        runDir: sandbox.runDir,
      });

      expectCheckResultShape(result);
      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.check_id).toBe("zigma/json-parse");
      expect(result.artifacts).toEqual([]);
    }
  );

  it(
    "fails with a failure string referencing the path, SyntaxError, and a location indicator (T-FC-4, UC-FC-4)",
    async () => {
      // Invalid JSON: truncated object. JSON.parse will throw SyntaxError
      // and its message includes a position indicator (Node native parser
      // uses "position N"; tests accept any of the common location markers).
      await writeFixture(sandbox, "broken.json", '{ "broken":');

      const result = await checkJsonParse({
        with: { file: "broken.json" },
        runDir: sandbox.runDir,
      });

      expectCheckResultShape(result);
      expect(result.passed).toBe(false);
      expect(result.check_id).toBe("zigma/json-parse");
      expect(result.artifacts).toEqual([]);
      expect(result.failures.length).toBeGreaterThanOrEqual(1);

      const first = result.failures[0] ?? "";
      // (a) The failure message includes the file path.
      expect(first).toContain("broken.json");
      // (b) The failure message identifies the error class.
      expect(first).toContain("SyntaxError");
      // (c) The failure message includes a location indicator. Match any
      // of the standard JSON.parse location vocabularies (position, line,
      // column, character, offset) case-insensitively.
      expect(first).toMatch(/position|line|column|character|offset|at /i);
    }
  );
});

// ===========================================================================
// T-FC-5 / T-FC-6: json-schema
// ===========================================================================

describe("checkJsonSchema — json-schema kind", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.runDir, { recursive: true, force: true });
  });

  // Shared JSON Schema (draft-07): top-level object with required fields
  // `name: string` and `count: number`. No `additionalProperties` constraint.
  const SCHEMA_DRAFT_07 = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["name", "count"],
    properties: {
      name: { type: "string" },
      count: { type: "number" },
    },
  };

  it(
    "passes when data validates against the schema (T-FC-5, UC-FC-5)",
    async () => {
      await writeFixture(sandbox, "schema.json", JSON.stringify(SCHEMA_DRAFT_07));
      await writeFixture(
        sandbox,
        "data.json",
        JSON.stringify({ name: "n", count: 3 })
      );

      const result = await checkJsonSchema({
        with: { file: "data.json", schema: "schema.json" },
        runDir: sandbox.runDir,
      });

      expectCheckResultShape(result);
      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.check_id).toBe("zigma/json-schema");
      expect(result.artifacts).toEqual([]);
    }
  );

  it(
    "fails with field-level errors when data violates the schema (T-FC-6, UC-FC-6)",
    async () => {
      await writeFixture(sandbox, "schema.json", JSON.stringify(SCHEMA_DRAFT_07));
      // Violations: `name` is missing (required); `count` has wrong type.
      await writeFixture(
        sandbox,
        "data.json",
        JSON.stringify({ count: "three" })
      );

      const result = await checkJsonSchema({
        with: { file: "data.json", schema: "schema.json" },
        runDir: sandbox.runDir,
      });

      expectCheckResultShape(result);
      expect(result.passed).toBe(false);
      expect(result.check_id).toBe("zigma/json-schema");
      expect(result.artifacts).toEqual([]);

      // At least one failure entry; every failure entry is a non-empty string.
      expect(result.failures.length).toBeGreaterThanOrEqual(1);
      for (const f of result.failures) {
        expect(typeof f).toBe("string");
        expect(f.length).toBeGreaterThan(0);
      }

      // The missing required property MUST be referenced somewhere in the
      // failures list (ajv emits a "must have required property 'name'"
      // message that includes the field name).
      const joined = result.failures.join("\n");
      expect(joined).toContain("name");
    }
  );
});

// ===========================================================================
// T-FC-7 / T-FC-8: required-fields
// ===========================================================================

describe("checkRequiredFields — required-fields kind", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.runDir, { recursive: true, force: true });
  });

  it(
    "passes when all listed top-level fields are present and non-empty (T-FC-7, UC-FC-7)",
    async () => {
      await writeFixture(
        sandbox,
        "report.json",
        JSON.stringify({ title: "T", body: "B" })
      );

      const result = await checkRequiredFields({
        with: { file: "report.json", fields: ["title", "body"] },
        runDir: sandbox.runDir,
      });

      expectCheckResultShape(result);
      expect(result.passed).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.check_id).toBe("zigma/required-fields");
      expect(result.artifacts).toEqual([]);
    }
  );

  it(
    "fails listing every missing or empty field (T-FC-8, UC-FC-8)",
    async () => {
      // `title` present + non-empty (OK); `body` present but empty string
      // (empty); `extra` absent (missing). Both `body` and `extra` MUST
      // surface in failures.
      await writeFixture(
        sandbox,
        "report.json",
        JSON.stringify({ title: "T", body: "" })
      );

      const result = await checkRequiredFields({
        with: { file: "report.json", fields: ["title", "body", "extra"] },
        runDir: sandbox.runDir,
      });

      expectCheckResultShape(result);
      expect(result.passed).toBe(false);
      expect(result.check_id).toBe("zigma/required-fields");
      expect(result.artifacts).toEqual([]);

      // Exactly two failing fields are expected (`body` and `extra`).
      expect(result.failures.length).toBe(2);
      const joined = result.failures.join("\n");
      expect(joined).toContain("body");
      expect(joined).toContain("extra");
      // The passing field MUST NOT appear in failures.
      expect(joined).not.toContain("title");
    }
  );
});
