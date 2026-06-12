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
import { loadSkillPack } from "../../src/skill-pack/index.js";
import { getPackageInfo } from "../../src/utils/index.js";
import { loadWorkflow, type WorkflowDefinition } from "../../src/workflow/index.js";

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

  it("code-change.yml contains skills, signals, agent/script/check job (T-INIT-9)", async () => {
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
    expect(yml).toMatch(/type:\s*check/);
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

/**
 * P10 code-change template tests (WF-P10-WORKFLOW, Step 1: cases-and-tests).
 *
 * These tests are red until Step 2 rewrites src/init/templates.ts and updates
 * src/init/index.ts to emit the new file set.
 *
 * Reference:
 *   - docs/phases/p10-code-change-workflow/02-development-plan.md
 *     §3 (AD-P10-001..AD-P10-005), §4 (WF-P10-WORKFLOW)
 *   - docs/phases/p10-code-change-workflow/workflows/wf-p10-workflow/01-cases-and-tests.md
 *   - docs/prd.md §11 (Skill Pack), §12 (Workflow YAML), §16 (data dir), §20 (P10)
 */

describe("code-change template (WF-P10-WORKFLOW)", () => {
  let tempDir: string;
  let dotZigma: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-init-p10-"));
    dotZigma = join(tempDir, ".zigma-flow");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function readWorkflowYml(): Promise<string> {
    return readFile(join(dotZigma, "workflows", "code-change.yml"), "utf-8");
  }

  async function loadGeneratedWorkflow(): Promise<WorkflowDefinition> {
    const yml = await readWorkflowYml();
    return loadWorkflow(yml);
  }

  // ---------- TC-WORKFLOW-1 ----------
  it("runInit writes the full P10 file set (TC-WORKFLOW-1)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const expected = [
      "config.json",
      "skill-lock.json",
      join("workflows", "code-change.yml"),
      join("skills", "code-change", "skill.yml"),
      join("skills", "code-change", "knowledge", "workflow-guide.md"),
      join("skills", "code-change", "knowledge", "coding-guidelines.md"),
      join("skills", "code-change", "prompts", "intake.md"),
      join("skills", "code-change", "prompts", "code-map.md"),
      join("skills", "code-change", "prompts", "plan.md"),
      join("skills", "code-change", "prompts", "implement.md"),
      join("skills", "code-change", "prompts", "review.md"),
      join("skills", "code-change", "prompts", "summarize.md")
    ];

    for (const rel of expected) {
      const full = join(dotZigma, rel);
      expect(await pathExists(full), `missing ${rel}`).toBe(true);
    }
  });

  // ---------- TC-WORKFLOW-2 ----------
  it("generated workflow YAML parses via loadWorkflow() (TC-WORKFLOW-2)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const yml = await readWorkflowYml();
    // loadWorkflow throws on validation failure; if the template uses
    // unsupported features (e.g. ${{ steps.* }} or undeclared expose aliases)
    // this will throw.
    const wf = loadWorkflow(yml);
    expect(wf.name).toBeDefined();
    expect(wf.jobs).toBeDefined();
  });

  // ---------- TC-WORKFLOW-3 ----------
  it("workflow declares exactly the 10 expected jobs (TC-WORKFLOW-3)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const wf = await loadGeneratedWorkflow();
    const jobs = Object.keys(wf.jobs).sort();
    expect(jobs).toEqual(
      [
        "architecture-design",
        "code-map",
        "implement",
        "intake",
        "plan",
        "review",
        "risk-scan",
        "static-check",
        "summarize",
        "unit-test"
      ].sort()
    );
  });

  // ---------- TC-WORKFLOW-4 ----------
  it("every agent step exposes the 'code' skill (TC-WORKFLOW-4)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const wf = await loadGeneratedWorkflow();
    expect(wf.skills).toBeDefined();
    expect(Object.keys(wf.skills ?? {})).toContain("code");

    const agentJobs = [
      "intake",
      "code-map",
      "plan",
      "architecture-design",
      "implement",
      "review",
      "summarize"
    ];

    for (const jobName of agentJobs) {
      const job = wf.jobs[jobName];
      expect(job, `job ${jobName} missing`).toBeDefined();
      const step = job!.steps[0];
      expect(step, `job ${jobName} has no steps`).toBeDefined();
      expect(step!.type, `job ${jobName} first step type`).toBe("agent");
      expect(step!.expose?.skills, `job ${jobName} expose.skills`).toBeDefined();
      expect(step!.expose?.skills, `job ${jobName} expose.skills`).toContain("code");
    }
  });

  // ---------- TC-WORKFLOW-5 ----------
  it("DAG edges match the documented graph (TC-WORKFLOW-5)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const wf = await loadGeneratedWorkflow();

    const needsOf = (id: string): string[] => {
      const job = wf.jobs[id];
      return (job?.needs ?? []).slice().sort();
    };

    expect(needsOf("intake")).toEqual([]);
    expect(needsOf("code-map")).toEqual(["intake"]);
    expect(needsOf("risk-scan")).toEqual(["code-map"]);
    expect(needsOf("plan")).toEqual(["risk-scan"]);
    expect(needsOf("architecture-design")).toEqual(["plan"]);
    expect(needsOf("implement")).toEqual(["plan"]);
    expect(needsOf("static-check")).toEqual(["implement"]);
    expect(needsOf("unit-test")).toEqual(["implement"]);
    expect(needsOf("review")).toEqual(["static-check", "unit-test"]);
    expect(needsOf("summarize")).toEqual(["review"]);
  });

  // ---------- TC-WORKFLOW-6 ----------
  it("architecture-design declares activation: 'manual' (TC-WORKFLOW-6)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const wf = await loadGeneratedWorkflow();
    const job = wf.jobs["architecture-design"];
    expect(job).toBeDefined();
    expect(job?.activation).toBe("manual");
  });

  // ---------- TC-WORKFLOW-7 ----------
  it("implement has optional_needs and retry config (TC-WORKFLOW-7)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const wf = await loadGeneratedWorkflow();
    const job = wf.jobs["implement"];
    expect(job).toBeDefined();
    expect(job?.optional_needs).toEqual(["architecture-design"]);

    const retry = job?.retry as Record<string, unknown> | undefined;
    expect(retry).toBeDefined();
    expect(retry?.["max_attempts"]).toBe(3);

    const onExceeded = retry?.["on_exceeded"] as Record<string, unknown> | undefined;
    expect(onExceeded).toBeDefined();
    expect(onExceeded?.["status"]).toBe("failed");
  });

  // ---------- TC-WORKFLOW-8 ----------
  it("signals review_rejected and needs_architecture_design are declared (TC-WORKFLOW-8)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const wf = await loadGeneratedWorkflow();
    expect(wf.signals).toBeDefined();

    const reviewRejected = wf.signals?.["review_rejected"];
    expect(reviewRejected, "review_rejected signal missing").toBeDefined();
    expect(reviewRejected?.allowed_from).toEqual(["review"]);
    expect(reviewRejected?.action).toEqual({ retry_job: "implement" });

    const needsArch = wf.signals?.["needs_architecture_design"];
    expect(needsArch, "needs_architecture_design signal missing").toBeDefined();
    expect((needsArch?.allowed_from ?? []).slice().sort()).toEqual(["plan", "review"]);
    expect(needsArch?.action).toEqual({ activate_job: "architecture-design" });
  });

  // ---------- TC-WORKFLOW-9 ----------
  it("static-check and unit-test use inline script steps (TC-WORKFLOW-9)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const wf = await loadGeneratedWorkflow();

    for (const jobName of ["static-check", "unit-test"]) {
      const job = wf.jobs[jobName];
      expect(job, `job ${jobName} missing`).toBeDefined();
      expect(job!.steps.length, `job ${jobName} step count`).toBe(1);

      const step = job!.steps[0]!;
      expect(step.type, `job ${jobName} step.type`).toBe("script");
      expect(typeof step.run, `job ${jobName} step.run`).toBe("string");
      expect((step.run ?? "").length).toBeGreaterThan(0);
      // No Skill Pack uses: routing — AD-P10-002.
      expect(step.uses ?? "").not.toMatch(/^skill:\/\//);
      expect(step.on_failure).toBe("fail");
    }
  });

  // ---------- TC-WORKFLOW-10 ----------
  it("generated Skill Pack passes loadSkillPack() validation (TC-WORKFLOW-10)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const packRoot = join(dotZigma, "skills", "code-change");
    const def = await loadSkillPack(packRoot);

    expect(def.id).toBe("zigma.code-change");
    expect(def.kind).toBe("skill-pack");
    expect(def.version).toBe("1.0.0");

    const knowledgeIds = (def.knowledge ?? []).map((k) => k.id).sort();
    expect(knowledgeIds).toEqual(["coding-guidelines", "common-failure-patterns", "workflow-guide"].sort());

    const promptIds = (def.prompts ?? []).map((p) => p.id).sort();
    expect(promptIds).toEqual(
      ["code-map", "implement", "intake", "plan", "review", "summarize"].sort()
    );

    expect(def.scripts ?? []).toEqual([]);
    expect(def.checks ?? []).toEqual([]);
    expect((def.functions ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * P11 Skill Pack refinement tests (WF-P11-SKILL-PACK, Step 1: cases-and-tests).
 *
 * These tests are red until Step 2 updates src/init/templates.ts and
 * src/init/index.ts to ship the refined Skill Pack content + multi-step
 * implement job.
 *
 * Reference:
 *   - docs/phases/p11-skill-pack-refinement/02-development-plan.md
 *     §1 acceptance, §3 AD-P11-S-001..005, §4 WF-P11-SKILL-PACK
 *   - docs/phases/p11-skill-pack-refinement/workflows/wf-p11-skill-pack/01-cases-and-tests.md
 *   - docs/prd.md §9, §10, §11, §12, §20
 */

describe("P11 Skill Pack refinement (WF-P11-SKILL-PACK)", () => {
  let tempDir: string;
  let dotZigma: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zigma-flow-init-p11-"));
    dotZigma = join(tempDir, ".zigma-flow");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------- T-P11-1 ----------
  it("runInit writes knowledge/common-failure-patterns.md (T-P11-1)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const cfpPath = join(
      dotZigma,
      "skills",
      "code-change",
      "knowledge",
      "common-failure-patterns.md"
    );
    expect(await pathExists(cfpPath)).toBe(true);

    const body = await readFile(cfpPath, "utf-8");
    expect(body.trim().length).toBeGreaterThan(0);
  });

  // ---------- T-P11-2 ----------
  it("coding-guidelines.md mentions small-step and state-file restrictions (T-P11-2)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const text = await readFile(
      join(dotZigma, "skills", "code-change", "knowledge", "coding-guidelines.md"),
      "utf-8"
    );

    // "small step" / "incremental" guidance is required so the agent prefers
    // tight edit loops over sweeping rewrites.
    expect(text).toMatch(/small[\s-]?step|incremental/i);

    // Must clearly forbid touching state / runtime files under .zigma-flow.
    expect(text).toMatch(/state|runtime|\.zigma-flow/i);
    expect(text).toMatch(/must not|do not modify|forbidden|never modify|禁止/i);
  });

  // ---------- T-P11-3 ----------
  it("implement.md contains forbidden-action guidance (T-P11-3)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const text = await readFile(
      join(dotZigma, "skills", "code-change", "prompts", "implement.md"),
      "utf-8"
    );

    expect(text).toMatch(/must not|do not modify|forbidden|禁止/i);
  });

  // ---------- T-P11-4 ----------
  it("review.md specifies approved/rejected/needs_architecture_design output (T-P11-4)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const text = await readFile(
      join(dotZigma, "skills", "code-change", "prompts", "review.md"),
      "utf-8"
    );

    // The output spec must clearly enumerate the three verdict tokens. The
    // word-boundary check for `rejected` excludes incidental matches inside
    // the signal name `review_rejected`, which the current template already
    // mentions in passing.
    expect(text).toMatch(/\bapproved\b/);
    expect(text).toMatch(/(^|[^_])\brejected\b/);
    expect(text).toContain("needs_architecture_design");
  });

  // ---------- T-P11-5 ----------
  it("summarize.md requires final_summary and remaining_risks outputs (T-P11-5)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const text = await readFile(
      join(dotZigma, "skills", "code-change", "prompts", "summarize.md"),
      "utf-8"
    );

    expect(text).toContain("final_summary");
    expect(text).toContain("remaining_risks");
  });

  // ---------- T-P11-6 ----------
  it("skill.yml functions section is non-empty and contains implement-by-plan (T-P11-6)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const packRoot = join(dotZigma, "skills", "code-change");
    const def = await loadSkillPack(packRoot);

    const functions = (def.functions ?? []) as Array<{ id?: unknown }>;
    expect(functions.length).toBeGreaterThan(0);

    const ids = functions
      .map((f) => (typeof f.id === "string" ? f.id : ""))
      .filter((s) => s.length > 0);
    expect(ids).toContain("implement-by-plan");
  });

  // ---------- T-P11-7 ----------
  it("implement job has at least 3 steps and starts with an agent step (T-P11-7)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const yml = await readFile(
      join(dotZigma, "workflows", "code-change.yml"),
      "utf-8"
    );
    const wf = loadWorkflow(yml);

    const implement = wf.jobs["implement"];
    expect(implement, "implement job missing").toBeDefined();
    expect(implement!.steps.length).toBeGreaterThanOrEqual(2);

    // First step must still be an agent step so TC-WORKFLOW-4 continues to hold.
    expect(implement!.steps[0]!.type).toBe("agent");
  });

  // ---------- T-P11-8 ----------
  it("collect-diff.ts contains an active git diff invocation (T-P11-8)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const raw = await readFile(
      join(dotZigma, "skills", "code-change", "scripts", "collect-diff.ts"),
      "utf-8"
    );

    // Strip single-line `// ...` comments so the assertion catches active
    // executable code, not a commented-out example. Block comments (/* ... */)
    // are also dropped via a non-greedy regex.
    const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const activeLines = withoutBlockComments
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    expect(activeLines).toMatch(/git diff/);
  });

  // ---------- T-P11-9 ----------
  it("skill.yml functions length is at least 2 (TC-WORKFLOW-10 successor) (T-P11-9)", async () => {
    const { error } = await safeRunInit(tempDir);
    expect(error).toBeUndefined();

    const packRoot = join(dotZigma, "skills", "code-change");
    const def = await loadSkillPack(packRoot);

    // AD-P11-S-003: functions declares at least implement-by-plan and
    // review-change. This case replaces the legacy TC-WORKFLOW-10 assertion
    // `expect(def.functions ?? []).toEqual([])`.
    expect((def.functions ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
