import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDirectories,
  runInit,
  writeFileIfMissing,
  type RunInitSummary,
  type WriteFileResult
} from "../../src/init/index.js";
import { getPackageInfo } from "../../src/utils/index.js";

/**
 * Init filesystem and integration tests for WF-P1-INIT (Step 1: cases-and-tests).
 *
 * Reference:
 *   - docs/prd.md FR-001, §11 (skill pack), §12 (workflow YAML), §16 (data dir),
 *     §17 (CLI)
 *   - docs/mvp-contracts.md §4 (DoD Portability), §7 (errors)
 *   - docs/phases/p1-cli-init/workflows/wf-p1-init/01-cases-and-tests.md
 *
 * Tests are red-phase: the `src/init` module exports signature stubs that
 * throw. They become green once Step 2 implements the helpers and command.
 */

interface CapturedSummary {
  readonly result: RunInitSummary | undefined;
  readonly error: unknown;
}

async function safeRunInit(cwd: string): Promise<CapturedSummary> {
  try {
    const result = await runInit({ cwd });
    return { result, error: undefined };
  } catch (error: unknown) {
    return { result: undefined, error };
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("init filesystem helpers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-init-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("createDirectories creates nested paths and is idempotent (T-INIT-1 / UC-FS-1)", async () => {
    const a = join(tempDir, "a");
    const ab = join(tempDir, "a", "b");

    const first = await createDirectories([a, ab]);
    expect(first.map((entry) => entry.status)).toEqual(["created", "created"]);
    expect(await pathExists(ab)).toBe(true);

    const second = await createDirectories([a, ab]);
    expect(second.map((entry) => entry.status)).toEqual(["skipped", "skipped"]);
  });

  it("writeFileIfMissing creates new file then skips when present (T-INIT-2 / UC-FS-2)", async () => {
    const target = join(tempDir, "marker.txt");
    const original = "hello\n";

    const created: WriteFileResult = await writeFileIfMissing(target, original);
    expect(created.status).toBe("created");
    expect(created.path).toBe(target);
    expect(await readFile(target, "utf-8")).toBe(original);

    // A second write with different content must NOT overwrite the file.
    const skipped: WriteFileResult = await writeFileIfMissing(target, "different\n");
    expect(skipped.status).toBe("skipped");
    expect(await readFile(target, "utf-8")).toBe(original);
  });

  it("paths normalize the same across separators (T-INIT-6 / UC-CMD-4)", async () => {
    const a = resolve(tempDir, "skills/code-change");
    const b = resolve(tempDir, `skills${sep}code-change`);
    const c = resolve(tempDir, "skills\\code-change");

    // Whatever the platform, node:path.resolve must yield identical absolute paths
    // when given equivalent inputs. The init implementation must rely on
    // node:path so that Windows-style and POSIX-style separators converge.
    expect(a).toBe(b);
    // On POSIX, `\` is a literal char and won't equal a, which is the correct
    // signal that string concatenation is unsafe. We assert that AT LEAST the
    // canonical form matches itself; the implementation is forbidden from
    // accepting `\` segments on POSIX by relying solely on node:path.
    if (process.platform === "win32") {
      expect(c).toBe(a);
    } else {
      expect(c).not.toBe(a);
    }
  });
});

describe("runInit integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-init-int-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const expectedTopLevel = ["workflows", "skills", "runs", "config.json", "skill-lock.json"];
  const expectedSkillFiles = [
    join("skills", "code-change", "skill.yml"),
    join("skills", "code-change", "knowledge", "coding-guidelines.md"),
    join("skills", "code-change", "prompts", "implement.md"),
    join("skills", "code-change", "prompts", "review.md"),
    join("skills", "code-change", "scripts", "collect-diff.ts"),
    join("skills", "code-change", "checks", "report-schema.json"),
    join("skills", "code-change", "checks", "forbidden-paths.yml")
  ];
  const expectedWorkflowFile = join("workflows", "code-change.yml");

  it("runInit produces full .zigma-flow layout in empty dir (T-INIT-3 / UC-CMD-1)", async () => {
    const { result, error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();
    expect(result).toBeDefined();

    const dotZigma = join(tempDir, ".zigma-flow");
    const topLevel = await readdir(dotZigma);
    for (const name of expectedTopLevel) {
      expect(topLevel).toContain(name);
    }

    for (const rel of [expectedWorkflowFile, ...expectedSkillFiles]) {
      expect(await pathExists(join(dotZigma, rel))).toBe(true);
    }

    // Every file emitted in the summary must be flagged as `created`.
    const files = result?.files ?? [];
    expect(files.length).toBeGreaterThan(0);
    for (const entry of files) {
      expect(entry.status).toBe("created");
    }
  });

  it("runInit is idempotent and reports skipped on re-run (T-INIT-4 / UC-CMD-2)", async () => {
    const first = await safeRunInit(tempDir);
    expect(first.error).toBeUndefined();

    const dotZigma = join(tempDir, ".zigma-flow");
    const configPath = join(dotZigma, "config.json");
    const beforeBytes = await readFile(configPath, "utf-8");

    const second = await safeRunInit(tempDir);
    expect(second.error).toBeUndefined();
    expect(second.result).toBeDefined();

    const afterBytes = await readFile(configPath, "utf-8");
    expect(afterBytes).toBe(beforeBytes);

    const secondFiles = second.result?.files ?? [];
    expect(secondFiles.length).toBeGreaterThan(0);
    for (const entry of secondFiles) {
      expect(entry.status).toBe("skipped");
    }
  });

  it("runInit emits already-initialized hint when config.json exists (T-INIT-5 / UC-CMD-3)", async () => {
    const dotZigma = join(tempDir, ".zigma-flow");
    await createDirectories([dotZigma]).catch(() => {
      // The helper itself is part of the SUT; fall back to fs.mkdir behavior
      // by writing the file with a manual parent creation.
    });
    // Ensure .zigma-flow exists even if createDirectories stub throws.
    await rm(dotZigma, { recursive: true, force: true });
    await rm(join(tempDir, "_seed_"), { recursive: true, force: true }).catch(() => undefined);
    await writeFile(join(tempDir, "_seed_"), "", { flag: "w" });
    await rm(join(tempDir, "_seed_"));
    // mkdir via fs/promises directly to avoid SUT coupling for setup-only step.
    await (await import("node:fs/promises")).mkdir(dotZigma, { recursive: true });
    await writeFile(
      join(dotZigma, "config.json"),
      JSON.stringify({ tool_version: getPackageInfo().version, active_run: null }, null, 2)
    );

    const { result, error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();
    expect(result?.alreadyInitialized).toBe(true);
  });

  it("config.json contains tool_version and active_run placeholder (T-INIT-7)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const raw = await readFile(join(tempDir, ".zigma-flow", "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed["tool_version"]).toBe(getPackageInfo().version);
    expect("active_run" in parsed).toBe(true);
    expect(parsed["active_run"]).toBeNull();
  });

  it("skill-lock.json records zigma.code-change with path, version, hash (T-INIT-8)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const raw = await readFile(join(tempDir, ".zigma-flow", "skill-lock.json"), "utf-8");
    const parsed = JSON.parse(raw) as { skills?: Record<string, unknown> };

    expect(parsed.skills).toBeDefined();
    const entry = parsed.skills?.["zigma.code-change"] as
      | { resolved?: string; version?: string; hash?: string }
      | undefined;
    expect(entry).toBeDefined();
    expect(typeof entry?.resolved).toBe("string");
    expect(typeof entry?.version).toBe("string");
    expect(typeof entry?.hash).toBe("string");
    expect((entry?.hash ?? "").length).toBeGreaterThan(0);
  });

  it("code-change.yml contains skills, signals, agent/script/router job (T-INIT-9)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const yml = await readFile(
      join(tempDir, ".zigma-flow", "workflows", "code-change.yml"),
      "utf-8"
    );

    // Substring assertions (avoids depending on a YAML parser in P1).
    expect(yml).toMatch(/^skills:/m);
    expect(yml).toMatch(/^signals:/m);
    expect(yml).toMatch(/^jobs:/m);
    expect(yml).toMatch(/type:\s*agent/);
    expect(yml).toMatch(/type:\s*script/);
    expect(yml).toMatch(/type:\s*router/);
  });

  it("skill.yml declares knowledge, prompts, scripts, checks, functions, policies (T-INIT-10)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const yml = await readFile(
      join(tempDir, ".zigma-flow", "skills", "code-change", "skill.yml"),
      "utf-8"
    );

    expect(yml).toMatch(/^kind:\s*skill-pack/m);
    for (const section of ["knowledge:", "prompts:", "scripts:", "checks:", "functions:", "policies:"]) {
      expect(yml).toContain(section);
    }
  });

  it("prompt templates include report schema and stop instruction (T-INIT-11)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    for (const fileName of ["implement.md", "review.md"]) {
      const text = await readFile(
        join(tempDir, ".zigma-flow", "skills", "code-change", "prompts", fileName),
        "utf-8"
      );
      // Output report schema reference is required by arch §9.3 / PRD §11.
      expect(text.toLowerCase()).toMatch(/report/);
      expect(text.toLowerCase()).toMatch(/schema/);
      // "stop after completing" instruction prevents Agent from auto-continuing
      // beyond its step (PRD §11 stop-after-completing convention).
      expect(text.toLowerCase()).toContain("stop after completing");
    }
  });

  it("auxiliary template files exist (T-INIT-12)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const base = join(tempDir, ".zigma-flow", "skills", "code-change");
    const knowledge = await readFile(join(base, "knowledge", "coding-guidelines.md"), "utf-8");
    expect(knowledge.trim().length).toBeGreaterThan(0);

    const script = await readFile(join(base, "scripts", "collect-diff.ts"), "utf-8");
    expect(script.length).toBeGreaterThan(0);

    const schemaText = await readFile(join(base, "checks", "report-schema.json"), "utf-8");
    const schema = JSON.parse(schemaText) as Record<string, unknown>;
    // JSON Schema convention: must declare a type or $schema field.
    expect("type" in schema || "$schema" in schema).toBe(true);

    const forbidden = await readFile(join(base, "checks", "forbidden-paths.yml"), "utf-8");
    expect(forbidden.trim().length).toBeGreaterThan(0);
  });
});
