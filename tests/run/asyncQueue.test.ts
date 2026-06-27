/**
 * AsyncQueue unit tests — WF-P14-LOCKS Step 1 (Cases and Tests).
 *
 * Tests the AsyncQueue class in isolation (no filesystem needed):
 *   - FIFO execution order
 *   - Serial execution (mutual exclusion)
 *   - Error propagation with continuation
 *   - Return value passthrough
 *
 * Reference:
 *   - docs/phases/p14-concurrent-execution/02-development-plan.md AD-P14-003
 *   - docs/phases/p14-concurrent-execution/workflows/wf-p14-locks/01-cases-and-tests.md
 *
 * Red-phase note:
 *   - This test imports AsyncQueue from src/run/asyncQueue.js, which does NOT
 *     exist yet. The import will fail until Step 2 creates the module.
 */

import { describe, expect, it } from "vitest";

import { AsyncQueue } from "../../src/run/asyncQueue.js";

// ---------------------------------------------------------------------------
// UC-QUEUE-FIFO — sequential task ordering
// ---------------------------------------------------------------------------

describe("AsyncQueue FIFO ordering (UC-QUEUE-FIFO)", () => {
  it("executes 3 tasks in FIFO call order and passes results through (T-QUEUE-FIFO-1)", async () => {
    const queue = new AsyncQueue();
    const order: number[] = [];

    const results = await Promise.all([
      queue.run(async () => {
        order.push(1);
        return 10;
      }),
      queue.run(async () => {
        order.push(2);
        return 20;
      }),
      queue.run(async () => {
        order.push(3);
        return 30;
      }),
    ]);

    // Execution order must be [1, 2, 3]
    expect(order).toEqual([1, 2, 3]);
    // Results must pass through in order
    expect(results).toEqual([10, 20, 30]);
  });
});

// ---------------------------------------------------------------------------
// UC-QUEUE-SERIAL — mutual exclusion under concurrent submission
// ---------------------------------------------------------------------------

describe("AsyncQueue serial execution (UC-QUEUE-SERIAL)", () => {
  it("never exceeds 1 concurrent execution with 5 concurrent queue.run() calls (T-QUEUE-SERIAL-1)", async () => {
    const queue = new AsyncQueue();
    let active = 0;
    let maxActive = 0;
    const executionOrder: number[] = [];
    const TASK_COUNT = 5;

    const tasks = Array.from({ length: TASK_COUNT }, (_, i) =>
      queue.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        executionOrder.push(i);
        // Yield to the microtask queue so other queued tasks get a chance
        // to attempt execution (which they must NOT, due to serialization).
        await Promise.resolve();
        active--;
        return i;
      })
    );

    const results = await Promise.all(tasks);

    // Only one task active at any time
    expect(maxActive).toBe(1);
    // FIFO order preserved
    expect(executionOrder).toEqual([0, 1, 2, 3, 4]);
    // Results correct
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// UC-QUEUE-ERROR — error propagation with continuation
// ---------------------------------------------------------------------------

describe("AsyncQueue error propagation (UC-QUEUE-ERROR)", () => {
  it("propagates error and continues executing subsequent tasks (T-QUEUE-ERROR-1)", async () => {
    const queue = new AsyncQueue();
    const executed: number[] = [];

    const t1 = queue.run(async () => {
      executed.push(1);
      return "ok-1";
    });
    const t2 = queue.run(async () => {
      executed.push(2);
      throw new Error("task-2-error");
    });
    const t3 = queue.run(async () => {
      executed.push(3);
      return "ok-3";
    });

    // Task 1 resolves
    await expect(t1).resolves.toBe("ok-1");
    // Task 2 rejects with the same error
    await expect(t2).rejects.toThrow("task-2-error");
    // Task 3 still executes after the error
    await expect(t3).resolves.toBe("ok-3");

    // All three tasks attempted execution
    expect(executed).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// UC-QUEUE-RESULT — return value passthrough
// ---------------------------------------------------------------------------

describe("AsyncQueue result passthrough (UC-QUEUE-RESULT)", () => {
  it("passes return value through unchanged (T-QUEUE-RESULT-1)", async () => {
    const queue = new AsyncQueue();

    const result = await queue.run(async () => ({
      key: "value",
      num: 42,
      nested: { flag: true },
    }));

    expect(result).toEqual({ key: "value", num: 42, nested: { flag: true } });
  });
});
