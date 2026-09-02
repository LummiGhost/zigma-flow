import { describe, expect, it } from "vitest";

import {
  waitForSubprocess,
  type OwnedSubprocess,
} from "../../src/process/lifecycle.js";

describe("owned child-process lifecycle", () => {
  it("coalesces overlapping abort and timeout into one termination", async () => {
    let resolveChild!: (value: string) => void;
    const childPromise = new Promise<string>((resolve) => {
      resolveChild = resolve;
    });
    let killCount = 0;
    const child: OwnedSubprocess<string> = {
      then: childPromise.then.bind(childPromise),
      kill: () => {
        killCount += 1;
        setTimeout(() => resolveChild("reaped"), 20);
        return true;
      },
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);

    const settled = await waitForSubprocess(child, {
      signal: controller.signal,
      timeoutMs: 10,
    });

    expect(settled.result).toBe("reaped");
    expect(settled.cancelled).toBe(true);
    expect(settled.timedOut).toBe(true);
    expect(killCount).toBe(1);
  });
});
