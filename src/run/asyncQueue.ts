/**
 * AsyncQueue — in-process FIFO serial execution queue.
 *
 * Enqueues functions for serial execution. Only one function runs at a time.
 * If a function rejects, the error propagates to the caller but does NOT
 * block subsequent queued functions from executing.
 *
 * Reference:
 *   - docs/phases/p14-concurrent-execution/02-development-plan.md AD-P14-003
 *   - docs/phases/p14-concurrent-execution/workflows/wf-p14-locks/01-cases-and-tests.md
 */

export class AsyncQueue {
  /** Promise chain tail — each run() call appends to this chain. */
  private _tail: Promise<unknown> = Promise.resolve();

  /**
   * Enqueue a function for serial execution.
   * Returns a Promise that resolves with fn's result once it's fn's turn.
   * If fn rejects, the returned Promise rejects; subsequent queued tasks
   * still execute (the error is swallowed from the internal chain).
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain the new task after the previous tail.
    const result = this._tail.then(() => fn());

    // If the task rejects, swallow the error on the internal chain so that
    // subsequent tasks are not blocked.
    this._tail = result.then(
      () => {},
      () => {}
    );

    return result;
  }
}
