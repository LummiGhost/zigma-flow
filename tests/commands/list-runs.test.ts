/**
 * `list-runs` CLI command tests for WF-CLI-COMMANDS
 * (Step 1 — Cases and Tests).
 *
 * Exercises the new CLI handler that powers `zigma-flow list-runs`.
 * It scans `.zigma-flow/runs/*` and prints one row per run with
 * run_id, workflow, status, and created_at — sorted by created_at
 * descending. Corrupted runs are marked `[unreadable]`.
 *
 * Covers:
 *   - T-LISTRUN-1: multiple runs are listed in created_at desc order
 *                  with full metadata.
 *   - T-LISTRUN-2: empty / missing runs directory → prints
 *                  "No runs found." and does not throw.
 *   - T-LISTRUN-3: corrupted run shows as [unreadable]; other runs
 *                  render normally; command does not crash.
 *   - T-LISTRUN-4: per-run status field is rendered.
 *
 * Reference:
 *   - docs/phases/p9p10-cli-admin-commands/workflows/wf-cli-commands/01-cases-and-tests.md
 *   - docs/prd.md §17
 *
 * Red-phase note: `src/commands/list-runs.ts` does not yet exist;
 * tests will fail to compile until Step 2 ships the module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { listRunsAction } from "../../src/commands/list-runs.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  dotZigma: string;
  runsDir: string;
}

async function makeSandbox(opts: { createRunsDir?: boolean } = {}): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-listruns-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");

  await mkdir(dotZigma, { recursive: true });
  if (opts.createRunsDir !== false) {
    await mkdir(runsDir, { recursive: true });
  }

  return { projectRoot, zigmaflowDir: projectRoot, dotZigma, runsDir };
}

/**
 * Seed a run directory with `run.yml` (YAML) and `state.json` (JSON).
 * The two files together are what `list-runs` parses for each row.
 */
async function seedRun(
  runsDir: string,
  runId: string,
  meta: {
    workflowName: string;
    task: string;
    createdAt: string;
    status?: string;
  }
): Promise<void> {
  const runDir = join(runsDir, runId);
  await mkdir(runDir, { recursive: true });

  const runYml = [
    `task: ${JSON.stringify(meta.task)}`,
    `workflow:`,
    `  name: ${meta.workflowName}`,
    `  path: ./${meta.workflowName}.yml`,
    `created_at: ${meta.createdAt}`,
    `skill_lock_snapshot: skill-lock.snapshot.json`,
  ].join("\n");
  await writeFile(join(runDir, "run.yml"), runYml, "utf-8");

  const state: Record<string, unknown> = {
    run_id: runId,
    workflow: meta.workflowName,
    task: meta.task,
    created_at: meta.createdAt,
    last_event_id: "evt-001",
    jobs: {},
  };
  if (meta.status !== undefined) state["status"] = meta.status;
  await writeFile(join(runDir, "state.json"), JSON.stringify(state), "utf-8");
}

/**
 * Seed a corrupted run: `state.json` contains invalid JSON; `run.yml`
 * is still readable. `list-runs` must mark the row [unreadable] and
 * continue processing remaining runs.
 */
async function seedCorruptRun(runsDir: string, runId: string): Promise<void> {
  const runDir = join(runsDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "run.yml"),
    "task: garbage\nworkflow:\n  name: x\n",
    "utf-8"
  );
  await writeFile(join(runDir, "state.json"), "{ not valid json", "utf-8");
}

// ---------------------------------------------------------------------------
// T-LISTRUN-1: multiple runs listed in created_at desc order
// ---------------------------------------------------------------------------

describe("listRunsAction — multiple runs (T-LISTRUN-1)", () => {
  let sandbox: Sandbox;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "lists all runs with run_id, workflow, status, created_at; sorted desc by created_at (T-LISTRUN-1, UC-LISTRUN-1, FP-LISTRUN-2/3)",
    async () => {
      await seedRun(sandbox.runsDir, "20260610-0001", {
        workflowName: "code-change",
        task: "old task",
        createdAt: "2026-06-10T08:00:00.000Z",
        status: "completed",
      });
      await seedRun(sandbox.runsDir, "20260612-0002", {
        workflowName: "code-change",
        task: "newest task",
        createdAt: "2026-06-12T12:00:00.000Z",
        status: "running",
      });
      await seedRun(sandbox.runsDir, "20260612-0001", {
        workflowName: "code-change",
        task: "middle task",
        createdAt: "2026-06-12T08:00:00.000Z",
        status: "cancelled",
      });

      await listRunsAction({ zigmaflowDir: sandbox.zigmaflowDir });

      const printed = logSpy.mock.calls
        .map((c: unknown[]) => String(c[0] ?? ""))
        .join("\n");

      // All three run ids appear.
      expect(printed).toContain("20260610-0001");
      expect(printed).toContain("20260612-0001");
      expect(printed).toContain("20260612-0002");

      // Workflow and statuses present.
      expect(printed).toContain("code-change");
      expect(printed).toContain("running");
      expect(printed).toContain("completed");
      expect(printed).toContain("cancelled");

      // Sort order: newest (20260612-0002) appears before the older
      // ones in the printed output.
      const idxNewest = printed.indexOf("20260612-0002");
      const idxMiddle = printed.indexOf("20260612-0001");
      const idxOldest = printed.indexOf("20260610-0001");
      expect(idxNewest).toBeLessThan(idxMiddle);
      expect(idxMiddle).toBeLessThan(idxOldest);
    }
  );
});

// ---------------------------------------------------------------------------
// T-LISTRUN-2: empty / missing runs directory
// ---------------------------------------------------------------------------

describe("listRunsAction — empty or missing runs directory (T-LISTRUN-2)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it(
    "prints 'No runs found.' when runs directory is empty (T-LISTRUN-2a, UC-LISTRUN-2, FP-LISTRUN-1)",
    async () => {
      const sandbox = await makeSandbox(); // creates an empty runs/ dir
      try {
        await listRunsAction({ zigmaflowDir: sandbox.zigmaflowDir });
        const printed = logSpy.mock.calls
          .map((c: unknown[]) => String(c[0] ?? ""))
          .join("\n");
        expect(printed).toContain("No runs found.");
      } finally {
        await rm(sandbox.projectRoot, { recursive: true, force: true });
      }
    }
  );

  it(
    "prints 'No runs found.' when runs directory does not exist (T-LISTRUN-2b, UC-LISTRUN-2, FP-LISTRUN-1)",
    async () => {
      const sandbox = await makeSandbox({ createRunsDir: false });
      try {
        await listRunsAction({ zigmaflowDir: sandbox.zigmaflowDir });
        const printed = logSpy.mock.calls
          .map((c: unknown[]) => String(c[0] ?? ""))
          .join("\n");
        expect(printed).toContain("No runs found.");
      } finally {
        await rm(sandbox.projectRoot, { recursive: true, force: true });
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-LISTRUN-3: corrupted run shows as [unreadable]; others render
// ---------------------------------------------------------------------------

describe("listRunsAction — corrupted run does not crash (T-LISTRUN-3)", () => {
  let sandbox: Sandbox;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "marks corrupted run as [unreadable]; continues to render other runs (T-LISTRUN-3, UC-LISTRUN-3, FP-LISTRUN-4)",
    async () => {
      await seedCorruptRun(sandbox.runsDir, "20260611-0001");
      await seedRun(sandbox.runsDir, "20260612-0001", {
        workflowName: "code-change",
        task: "good task",
        createdAt: "2026-06-12T08:00:00.000Z",
        status: "completed",
      });

      // Must NOT throw.
      await listRunsAction({ zigmaflowDir: sandbox.zigmaflowDir });

      const printed = logSpy.mock.calls
        .map((c: unknown[]) => String(c[0] ?? ""))
        .join("\n");

      // Corrupted run row marked as [unreadable] (run id still shown).
      expect(printed).toContain("20260611-0001");
      expect(printed).toContain("[unreadable]");

      // Good run row still rendered with workflow + status.
      expect(printed).toContain("20260612-0001");
      expect(printed).toContain("code-change");
      expect(printed).toContain("completed");
    }
  );
});

// ---------------------------------------------------------------------------
// T-LISTRUN-4: per-run status renders for each run
// ---------------------------------------------------------------------------

describe("listRunsAction — per-run status display (T-LISTRUN-4)", () => {
  let sandbox: Sandbox;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "renders each run's status (running / completed / cancelled) (T-LISTRUN-4, UC-LISTRUN-4, FP-LISTRUN-2)",
    async () => {
      await seedRun(sandbox.runsDir, "20260612-0001", {
        workflowName: "code-change",
        task: "t1",
        createdAt: "2026-06-12T08:00:00.000Z",
        status: "running",
      });
      await seedRun(sandbox.runsDir, "20260612-0002", {
        workflowName: "code-change",
        task: "t2",
        createdAt: "2026-06-12T09:00:00.000Z",
        status: "completed",
      });
      await seedRun(sandbox.runsDir, "20260612-0003", {
        workflowName: "code-change",
        task: "t3",
        createdAt: "2026-06-12T10:00:00.000Z",
        status: "cancelled",
      });

      await listRunsAction({ zigmaflowDir: sandbox.zigmaflowDir });

      const printed = logSpy.mock.calls
        .map((c: unknown[]) => String(c[0] ?? ""))
        .join("\n");

      expect(printed).toContain("running");
      expect(printed).toContain("completed");
      expect(printed).toContain("cancelled");
    }
  );
});
