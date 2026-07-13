/**
 * Traverse engine integration tests (WF-P16-TRAVERSE, Issue #179).
 *
 * Covers:
 *   - Empty list traversal
 *   - Single item traversal
 *   - Multiple items sequential (concurrency: 1)
 *   - Item failure with fail_all policy
 *   - Item failure with continue policy
 *   - resolveTraverseInput parsing
 *   - parseVirtualJobId
 *   - getTraverseInputJob
 *   - Event log verification for traverse events
 *   - Concurrency limit enforcement
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

import { loadWorkflow, loadWorkflowFile } from "../../src/workflow/index.js";
import {
  resolveTraverseInput,
  parseVirtualJobId,
  getTraverseInputJob,
  checkAndExecuteTraverses,
} from "../../src/engine/traverse.js";
import {
  JsonlEventWriter,
  LocalStateStore,
  SystemClock,
  createRunDirectory,
} from "../../src/run/index.js";
import type { RunState, TraverseState } from "../../src/run/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zigma-traverse-test-"));
  return dir;
}

function cleanupTestDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

interface TestEvent {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
}

async function readAllEvents(runDir: string): Promise<TestEvent[]> {
  try {
    const text = await readFile(join(runDir, "events.jsonl"), "utf-8");
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const clock = new SystemClock();

function makeBaseState(props?: Partial<RunState>): RunState {
  return {
    run_id: "test-run",
    workflow: "test-wf",
    task: "test task",
    created_at: clock.now(),
    last_event_id: "evt-001",
    jobs: {},
    ...props,
  };
}

// ---------------------------------------------------------------------------
// resolveTraverseInput
// ---------------------------------------------------------------------------

describe("resolveTraverseInput", () => {
  it("returns null when input job output is not present", () => {
    const state = makeBaseState({
      jobs: {
        discover: { status: "running" },
      },
    });
    const result = resolveTraverseInput("${{ jobs.discover.outputs.items }}", state);
    expect(result).toBeNull();
  });

  it("resolves array from job outputs (JSON)", () => {
    const state = makeBaseState({
      jobs: {
        discover: {
          status: "completed",
          outputs: { items: '["a", "b", "c"]' },
        },
      },
    });
    const result = resolveTraverseInput("${{ jobs.discover.outputs.items }}", state);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("resolves single value from job outputs", () => {
    const state = makeBaseState({
      jobs: {
        discover: {
          status: "completed",
          outputs: { items: "single-value" },
        },
      },
    });
    const result = resolveTraverseInput("${{ jobs.discover.outputs.items }}", state);
    expect(result).toEqual(["single-value"]);
  });

  it("returns empty array for empty string output", () => {
    const state = makeBaseState({
      jobs: {
        discover: {
          status: "completed",
          outputs: { items: "" },
        },
      },
    });
    const result = resolveTraverseInput("${{ jobs.discover.outputs.items }}", state);
    expect(result).toEqual([]);
  });

  it("resolves numeric arrays", () => {
    const state = makeBaseState({
      jobs: {
        discover: {
          status: "completed",
          outputs: { items: "[1, 2, 3, 4, 5]" },
        },
      },
    });
    const result = resolveTraverseInput("${{ jobs.discover.outputs.items }}", state);
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it("resolves nested arrays", () => {
    const state = makeBaseState({
      jobs: {
        discover: {
          status: "completed",
          outputs: { items: '[{"name":"a"},{"name":"b"}]' },
        },
      },
    });
    const result = resolveTraverseInput("${{ jobs.discover.outputs.items }}", state);
    expect(result).toEqual([{ name: "a" }, { name: "b" }]);
  });
});

// ---------------------------------------------------------------------------
// parseVirtualJobId
// ---------------------------------------------------------------------------

describe("parseVirtualJobId", () => {
  it("parses a valid virtual job ID", () => {
    const result = parseVirtualJobId("__traverse/my-traverse/item-5");
    expect(result).toEqual({ traverseId: "my-traverse", itemIndex: 5 });
  });

  it("parses item-0", () => {
    const result = parseVirtualJobId("__traverse/process-items/item-0");
    expect(result).toEqual({ traverseId: "process-items", itemIndex: 0 });
  });

  it("parses multi-digit item index", () => {
    const result = parseVirtualJobId("__traverse/t/item-42");
    expect(result).toEqual({ traverseId: "t", itemIndex: 42 });
  });

  it("returns null for non-virtual job ID", () => {
    const result = parseVirtualJobId("discover");
    expect(result).toBeNull();
  });

  it("returns null for malformed virtual job ID", () => {
    const result = parseVirtualJobId("__traverse/nope");
    expect(result).toBeNull();
  });

  it("returns null for regular job ID with similar prefix", () => {
    const result = parseVirtualJobId("__traverse_but_not");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const result = parseVirtualJobId("");
    expect(result).toBeNull();
  });

  it("handles traverse ID containing special characters", () => {
    const result = parseVirtualJobId("__traverse/discover-items_v2/item-10");
    expect(result).toEqual({ traverseId: "discover-items_v2", itemIndex: 10 });
  });
});

// ---------------------------------------------------------------------------
// getTraverseInputJob
// ---------------------------------------------------------------------------

describe("getTraverseInputJob", () => {
  it("extracts job name from ${{ jobs.X.outputs.Y }} expression", () => {
    const result = getTraverseInputJob("${{ jobs.discover.outputs.items }}");
    expect(result).toBe("discover");
  });

  it("returns null for expressions without job references", () => {
    const result = getTraverseInputJob("${{ variables.foo }}");
    expect(result).toBeNull();
  });

  it("handles whitespace in expression", () => {
    const result = getTraverseInputJob("${{   jobs.discover.outputs.items   }}");
    expect(result).toBe("discover");
  });
});

// ---------------------------------------------------------------------------
// checkAndExecuteTraverses — integration tests
// ---------------------------------------------------------------------------

describe("checkAndExecuteTraverses", () => {
  it("completes immediately with empty list", async () => {
    const dir = makeTestDir();
    try {
      // Setup run directory structure
      const runsDir = join(dir, "runs");
      const runDir = await createRunDirectory("test-run", runsDir);

      // Write events.jsonl with an initial event
      const eventWriter = new JsonlEventWriter();
      await eventWriter.appendEvent(runDir, {
        id: "evt-001",
        run_id: "test-run",
        type: "run_created",
        timestamp: clock.now(),
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: { workflow: "test-wf", task: "test" },
      });

      // Create initial state with the upstream job having empty items
      const stateStore = new LocalStateStore();
      const state: RunState = {
        run_id: "test-run",
        workflow: "test-wf",
        task: "test",
        created_at: clock.now(),
        last_event_id: "evt-001",
        jobs: {
          discover: {
            status: "completed",
            outputs: { items: "[]" },
          },
          "process-item": {
            status: "ready",
          },
        },
      };
      await stateStore.writeSnapshot(runDir, state);

      const wf = loadWorkflow([
        'name: test-wf',
        'version: "1.0"',
        'jobs:',
        '  discover:',
        "    steps:",
        '      - id: s1',
        "        type: script",
        "        run: echo items",
        "        outputs:",
        "          items: string",
        '  process-item:',
        "    steps:",
        '      - id: p1',
        "        type: script",
        "        run: echo process",
        'traverse:',
        '  process-items:',
        '    input: "${{ jobs.discover.outputs.items }}"',
        '    target:',
        '      job: process-item',
        '    item_context:',
        '      key: item',
      ].join("\n"));

      const result = await checkAndExecuteTraverses({
        runDir,
        runId: "test-run",
        wf,
        state,
        clock,
        eventWriter,
        stateStore,
      });

      expect(result.worked).toBe(true);

      // Check the traverse state
      const finalState = await stateStore.readSnapshot(runDir);
      expect(finalState!.traverses).toBeDefined();
      const traverseState = finalState!.traverses!["process-items"]!;
      expect(traverseState.status).toBe("completed");
      expect(traverseState.completed_count).toBe(0);
      expect(traverseState.failed_count).toBe(0);
      expect(traverseState.item_results).toHaveLength(0);

      // Verify events
      const events = await readAllEvents(runDir);
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("traverse_started");
      expect(eventTypes).toContain("traverse_completed");
    } finally {
      cleanupTestDir(dir);
    }
  });

  it("starts items for a non-empty list", async () => {
    const dir = makeTestDir();
    try {
      const runsDir = join(dir, "runs");
      const runDir = await createRunDirectory("test-run", runsDir);

      const eventWriter = new JsonlEventWriter();
      await eventWriter.appendEvent(runDir, {
        id: "evt-001",
        run_id: "test-run",
        type: "run_created",
        timestamp: clock.now(),
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: { workflow: "test-wf", task: "test" },
      });

      const stateStore = new LocalStateStore();
      const state: RunState = {
        run_id: "test-run",
        workflow: "test-wf",
        task: "test",
        created_at: clock.now(),
        last_event_id: "evt-001",
        jobs: {
          discover: {
            status: "completed",
            outputs: { items: '["item-a", "item-b", "item-c"]' },
          },
          "process-item": {
            status: "ready",
          },
        },
      };
      await stateStore.writeSnapshot(runDir, state);

      const wf = loadWorkflow([
        'name: test-wf',
        'version: "1.0"',
        'jobs:',
        '  discover:',
        "    steps:",
        '      - id: s1',
        "        type: script",
        "        run: echo items",
        "        outputs:",
        "          items: string",
        '  process-item:',
        "    steps:",
        '      - id: p1',
        "        type: script",
        "        run: echo process",
        'traverse:',
        '  process-items:',
        '    input: "${{ jobs.discover.outputs.items }}"',
        '    target:',
        '      job: process-item',
        '    item_context:',
        '      key: item',
      ].join("\n"));

      const result = await checkAndExecuteTraverses({
        runDir,
        runId: "test-run",
        wf,
        state,
        clock,
        eventWriter,
        stateStore,
      });

      expect(result.worked).toBe(true);

      // Check traverse state — should have started 1 item (concurrency=1)
      const updatedState = await stateStore.readSnapshot(runDir);
      const traverseState = updatedState!.traverses!["process-items"]!;
      expect(traverseState.status).toBe("running");
      expect(traverseState.active_count).toBe(1);
      expect(traverseState.items).toHaveLength(3);

      // Check virtual job created
      const virtualJobId = "__traverse/process-items/item-0";
      const virtualJob = updatedState!.jobs[virtualJobId];
      expect(virtualJob).toBeDefined();
      expect(virtualJob!.status).toBe("ready");

      // Verify events
      const events = await readAllEvents(runDir);
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("traverse_started");
      expect(eventTypes).toContain("traverse_item_started");
      expect(eventTypes).toContain("job_ready");

      const startedEvent = events.find((e) => e.type === "traverse_started") as
        | { payload: { item_count: number } }
        | undefined;
      expect(startedEvent!.payload.item_count).toBe(3);
    } finally {
      cleanupTestDir(dir);
    }
  });

  it("starts multiple items with concurrency > 1", async () => {
    const dir = makeTestDir();
    try {
      const runsDir = join(dir, "runs");
      const runDir = await createRunDirectory("test-run", runsDir);

      const eventWriter = new JsonlEventWriter();
      await eventWriter.appendEvent(runDir, {
        id: "evt-001",
        run_id: "test-run",
        type: "run_created",
        timestamp: clock.now(),
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: { workflow: "test-wf", task: "test" },
      });

      const stateStore = new LocalStateStore();
      const state: RunState = {
        run_id: "test-run",
        workflow: "test-wf",
        task: "test",
        created_at: clock.now(),
        last_event_id: "evt-001",
        jobs: {
          discover: {
            status: "completed",
            outputs: { items: '["a", "b", "c"]' },
          },
          "process-item": {
            status: "ready",
          },
        },
      };
      await stateStore.writeSnapshot(runDir, state);

      const wf = loadWorkflow([
        'name: test-wf',
        'version: "1.0"',
        'jobs:',
        '  discover:',
        "    steps:",
        '      - id: s1',
        "        type: script",
        "        run: echo items",
        "        outputs:",
        "          items: string",
        '  process-item:',
        "    steps:",
        '      - id: p1',
        "        type: script",
        "        run: echo process",
        'traverse:',
        '  process-items:',
        '    input: "${{ jobs.discover.outputs.items }}"',
        '    concurrency: 3',
        '    target:',
        '      job: process-item',
        '    item_context:',
        '      key: item',
      ].join("\n"));

      const result = await checkAndExecuteTraverses({
        runDir,
        runId: "test-run",
        wf,
        state,
        clock,
        eventWriter,
        stateStore,
      });

      expect(result.worked).toBe(true);

      // Should have started all 3 items with concurrency=3
      const updatedState = await stateStore.readSnapshot(runDir);
      const traverseState = updatedState!.traverses!["process-items"]!;
      expect(traverseState.active_count).toBe(3);
      expect(updatedState!.jobs["__traverse/process-items/item-0"]).toBeDefined();
      expect(updatedState!.jobs["__traverse/process-items/item-1"]).toBeDefined();
      expect(updatedState!.jobs["__traverse/process-items/item-2"]).toBeDefined();
    } finally {
      cleanupTestDir(dir);
    }
  });

  it("handles item failure with fail_all policy", async () => {
    const dir = makeTestDir();
    try {
      const runsDir = join(dir, "runs");
      const runDir = await createRunDirectory("test-run", runsDir);

      const eventWriter = new JsonlEventWriter();
      await eventWriter.appendEvent(runDir, {
        id: "evt-001",
        run_id: "test-run",
        type: "run_created",
        timestamp: clock.now(),
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: { workflow: "test-wf", task: "test" },
      });

      const stateStore = new LocalStateStore();

      const wf = loadWorkflow([
        'name: test-wf',
        'version: "1.0"',
        'jobs:',
        '  discover:',
        "    steps:",
        '      - id: s1',
        "        type: script",
        "        run: echo items",
        "        outputs:",
        "          items: string",
        '  process-item:',
        "    steps:",
        '      - id: p1',
        "        type: script",
        "        run: echo process",
        'traverse:',
        '  process-items:',
        '    input: "${{ jobs.discover.outputs.items }}"',
        '    on_item_failure: fail_all',
        '    target:',
        '      job: process-item',
        '    item_context:',
        '      key: item',
      ].join("\n"));

      // State with traverse running and item-0 already failed
      const state: RunState = {
        run_id: "test-run",
        workflow: "test-wf",
        task: "test",
        created_at: clock.now(),
        last_event_id: "evt-001",
        jobs: {
          discover: {
            status: "completed",
            outputs: { items: '["a", "b", "c"]' },
          },
          "process-item": {
            status: "ready",
          },
          "__traverse/process-items/item-0": {
            status: "failed",
          },
        },
        traverses: {
          "process-items": {
            status: "running",
            input_expression: "${{ jobs.discover.outputs.items }}",
            items: ["a", "b", "c"],
            item_key: "item",
            on_item_failure: "fail_all",
            concurrency: 1,
            target_job: "process-item",
            completed_count: 0,
            failed_count: 0,
            active_count: 1,
            item_results: [],
          },
        },
      };
      await stateStore.writeSnapshot(runDir, state);

      const result = await checkAndExecuteTraverses({
        runDir,
        runId: "test-run",
        wf,
        state,
        clock,
        eventWriter,
        stateStore,
      });

      expect(result.worked).toBe(true);

      const finalState = await stateStore.readSnapshot(runDir);
      const traverseState = finalState!.traverses!["process-items"]!;
      expect(traverseState.status).toBe("failed");
      expect(traverseState.failed_count).toBe(1);

      const events = await readAllEvents(runDir);
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("traverse_item_failed");
    } finally {
      cleanupTestDir(dir);
    }
  });

  it("handles item failure with continue policy", async () => {
    const dir = makeTestDir();
    try {
      const runsDir = join(dir, "runs");
      const runDir = await createRunDirectory("test-run", runsDir);

      const eventWriter = new JsonlEventWriter();
      await eventWriter.appendEvent(runDir, {
        id: "evt-001",
        run_id: "test-run",
        type: "run_created",
        timestamp: clock.now(),
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: { workflow: "test-wf", task: "test" },
      });

      const stateStore = new LocalStateStore();

      const wf = loadWorkflow([
        'name: test-wf',
        'version: "1.0"',
        'jobs:',
        '  discover:',
        "    steps:",
        '      - id: s1',
        "        type: script",
        "        run: echo items",
        "        outputs:",
        "          items: string",
        '  process-item:',
        "    steps:",
        '      - id: p1',
        "        type: script",
        "        run: echo process",
        'traverse:',
        '  process-items:',
        '    input: "${{ jobs.discover.outputs.items }}"',
        '    on_item_failure: continue',
        '    concurrency: 3',
        '    target:',
        '      job: process-item',
        '    item_context:',
        '      key: item',
      ].join("\n"));

      // Item 0 failed but traverse should continue with remaining items
      const state: RunState = {
        run_id: "test-run",
        workflow: "test-wf",
        task: "test",
        created_at: clock.now(),
        last_event_id: "evt-001",
        jobs: {
          discover: {
            status: "completed",
            outputs: { items: '["a", "b", "c"]' },
          },
          "process-item": {
            status: "ready",
          },
          "__traverse/process-items/item-0": {
            status: "failed",
          },
          "__traverse/process-items/item-1": {
            status: "completed",
            outputs: { item: "b" },
          },
          "__traverse/process-items/item-2": {
            status: "completed",
            outputs: { item: "c" },
          },
        },
        traverses: {
          "process-items": {
            status: "running",
            input_expression: "${{ jobs.discover.outputs.items }}",
            items: ["a", "b", "c"],
            item_key: "item",
            on_item_failure: "continue",
            concurrency: 3,
            target_job: "process-item",
            completed_count: 0,
            failed_count: 0,
            active_count: 3,
            item_results: [],
          },
        },
      };
      await stateStore.writeSnapshot(runDir, state);

      const result = await checkAndExecuteTraverses({
        runDir,
        runId: "test-run",
        wf,
        state,
        clock,
        eventWriter,
        stateStore,
      });

      expect(result.worked).toBe(true);

      const finalState = await stateStore.readSnapshot(runDir);
      const traverseState = finalState!.traverses!["process-items"]!;
      // With continue policy, the traverse completes despite one failure
      expect(traverseState.status).toBe("completed");
      expect(traverseState.completed_count).toBe(2);
      expect(traverseState.failed_count).toBe(1);

      const events = await readAllEvents(runDir);
      const eventTypes = events.map((e) => e.type);
      const failedItems = eventTypes.filter((t) => t === "traverse_item_failed");
      const completedItems = eventTypes.filter((t) => t === "traverse_item_completed");
      expect(failedItems.length).toBeGreaterThanOrEqual(1);
      expect(completedItems.length).toBeGreaterThanOrEqual(2);
    } finally {
      cleanupTestDir(dir);
    }
  });

  it("handles collect policy same as continue for completion", async () => {
    const dir = makeTestDir();
    try {
      const runsDir = join(dir, "runs");
      const runDir = await createRunDirectory("test-run", runsDir);

      const eventWriter = new JsonlEventWriter();
      await eventWriter.appendEvent(runDir, {
        id: "evt-001",
        run_id: "test-run",
        type: "run_created",
        timestamp: clock.now(),
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: { workflow: "test-wf", task: "test" },
      });

      const stateStore = new LocalStateStore();

      const wf = loadWorkflow([
        'name: test-wf',
        'version: "1.0"',
        'jobs:',
        '  discover:',
        "    steps:",
        '      - id: s1',
        "        type: script",
        "        run: echo items",
        "        outputs:",
        "          items: string",
        '  process-item:',
        "    steps:",
        '      - id: p1',
        "        type: script",
        "        run: echo process",
        'traverse:',
        '  process-items:',
        '    input: "${{ jobs.discover.outputs.items }}"',
        '    on_item_failure: collect',
        '    concurrency: 2',
        '    target:',
        '      job: process-item',
        '    item_context:',
        '      key: item',
      ].join("\n"));

      // All items done (one failed)
      const state: RunState = {
        run_id: "test-run",
        workflow: "test-wf",
        task: "test",
        created_at: clock.now(),
        last_event_id: "evt-001",
        jobs: {
          discover: {
            status: "completed",
            outputs: { items: '["a", "b"]' },
          },
          "process-item": {
            status: "ready",
          },
          "__traverse/process-items/item-0": {
            status: "completed",
            outputs: { item: "a" },
          },
          "__traverse/process-items/item-1": {
            status: "failed",
          },
        },
        traverses: {
          "process-items": {
            status: "running",
            input_expression: "${{ jobs.discover.outputs.items }}",
            items: ["a", "b"],
            item_key: "item",
            on_item_failure: "collect",
            concurrency: 2,
            target_job: "process-item",
            completed_count: 0,
            failed_count: 0,
            active_count: 2,
            item_results: [],
          },
        },
      };
      await stateStore.writeSnapshot(runDir, state);

      const result = await checkAndExecuteTraverses({
        runDir,
        runId: "test-run",
        wf,
        state,
        clock,
        eventWriter,
        stateStore,
      });

      expect(result.worked).toBe(true);

      const finalState = await stateStore.readSnapshot(runDir);
      const traverseState = finalState!.traverses!["process-items"]!;
      expect(traverseState.status).toBe("completed");
      expect(traverseState.completed_count).toBe(1);
      expect(traverseState.failed_count).toBe(1);
      expect(traverseState.item_results).toHaveLength(2);

      // Verify aggregated outputs
      expect(traverseState.aggregated_outputs).toBeDefined();
      const outputs = traverseState.aggregated_outputs!;
      expect(outputs["results"]).toBeDefined();
      const results = outputs["results"] as Array<{ status: string }>;
      const succeededResults = results.filter((r) => r.status === "completed");
      const failedResults = results.filter((r) => r.status === "failed");
      expect(succeededResults).toHaveLength(1);
      expect(failedResults).toHaveLength(1);
    } finally {
      cleanupTestDir(dir);
    }
  });

  it("skips traverse when upstream job is not yet completed", async () => {
    const dir = makeTestDir();
    try {
      const runsDir = join(dir, "runs");
      const runDir = await createRunDirectory("test-run", runsDir);

      const eventWriter = new JsonlEventWriter();
      await eventWriter.appendEvent(runDir, {
        id: "evt-001",
        run_id: "test-run",
        type: "run_created",
        timestamp: clock.now(),
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: { workflow: "test-wf", task: "test" },
      });

      const stateStore = new LocalStateStore();
      const state: RunState = {
        run_id: "test-run",
        workflow: "test-wf",
        task: "test",
        created_at: clock.now(),
        last_event_id: "evt-001",
        jobs: {
          discover: {
            status: "running", // Still running, no outputs
          },
          "process-item": {
            status: "ready",
          },
        },
      };
      await stateStore.writeSnapshot(runDir, state);

      const wf = loadWorkflow([
        'name: test-wf',
        'version: "1.0"',
        'jobs:',
        '  discover:',
        "    steps:",
        '      - id: s1',
        "        type: script",
        "        run: echo items",
        "        outputs:",
        "          items: string",
        '  process-item:',
        "    steps:",
        '      - id: p1',
        "        type: script",
        "        run: echo process",
        'traverse:',
        '  process-items:',
        '    input: "${{ jobs.discover.outputs.items }}"',
        '    target:',
        '      job: process-item',
        '    item_context:',
        '      key: item',
      ].join("\n"));

      const result = await checkAndExecuteTraverses({
        runDir,
        runId: "test-run",
        wf,
        state,
        clock,
        eventWriter,
        stateStore,
      });

      expect(result.worked).toBe(false);
      const finalState = await stateStore.readSnapshot(runDir);
      expect(finalState!.traverses).toBeUndefined();
    } finally {
      cleanupTestDir(dir);
    }
  });

  it("does nothing when workflow has no traverse definitions", async () => {
    const dir = makeTestDir();
    try {
      const runsDir = join(dir, "runs");
      const runDir = await createRunDirectory("test-run", runsDir);

      const stateStore = new LocalStateStore();
      const state = makeBaseState();
      await stateStore.writeSnapshot(runDir, state);

      const wf = loadWorkflow([
        'name: test-wf',
        'version: "1.0"',
        'jobs:',
        '  job1:',
        "    steps:",
        '      - id: s1',
        "        type: script",
        "        run: echo hello",
      ].join("\n"));

      const result = await checkAndExecuteTraverses({
        runDir,
        runId: "test-run",
        wf,
        state,
        clock,
      });

      expect(result.worked).toBe(false);
    } finally {
      cleanupTestDir(dir);
    }
  });

  it("skips already completed traverse", async () => {
    const dir = makeTestDir();
    try {
      const runsDir = join(dir, "runs");
      const runDir = await createRunDirectory("test-run", runsDir);

      const eventWriter = new JsonlEventWriter();
      await eventWriter.appendEvent(runDir, {
        id: "evt-001",
        run_id: "test-run",
        type: "run_created",
        timestamp: clock.now(),
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: { workflow: "test-wf", task: "test" },
      });

      const stateStore = new LocalStateStore();
      const state: RunState = {
        run_id: "test-run",
        workflow: "test-wf",
        task: "test",
        created_at: clock.now(),
        last_event_id: "evt-001",
        jobs: {
          discover: {
            status: "completed",
            outputs: { items: '["a"]' },
          },
          "process-item": {
            status: "ready",
          },
        },
        traverses: {
          "process-items": {
            status: "completed", // Already completed
            input_expression: "${{ jobs.discover.outputs.items }}",
            items: ["a"],
            item_key: "item",
            on_item_failure: "fail_all",
            concurrency: 1,
            target_job: "process-item",
            completed_count: 1,
            failed_count: 0,
            active_count: 0,
            item_results: [{
              index: 0,
              key: "a",
              status: "completed" as const,
              outputs: { item: "a" },
            }],
          },
        },
      };
      await stateStore.writeSnapshot(runDir, state);

      const wf = loadWorkflow([
        'name: test-wf',
        'version: "1.0"',
        'jobs:',
        '  discover:',
        "    steps:",
        '      - id: s1',
        "        type: script",
        "        run: echo items",
        "        outputs:",
        "          items: string",
        '  process-item:',
        "    steps:",
        '      - id: p1',
        "        type: script",
        "        run: echo process",
        'traverse:',
        '  process-items:',
        '    input: "${{ jobs.discover.outputs.items }}"',
        '    target:',
        '      job: process-item',
        '    item_context:',
        '      key: item',
      ].join("\n"));

      const result = await checkAndExecuteTraverses({
        runDir,
        runId: "test-run",
        wf,
        state,
        clock,
        eventWriter,
        stateStore,
      });

      // No work should be done since traverse is already completed
      expect(result.worked).toBe(false);
    } finally {
      cleanupTestDir(dir);
    }
  });
});
