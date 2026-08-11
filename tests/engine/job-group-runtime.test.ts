import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { advanceJob, createRun } from "../../src/engine/index.js";
import type { Clock, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";

const FIXED_ISO = "2026-08-11T00:00:00.000Z";

class FakeClock implements Clock {
  now(): string {
    return FIXED_ISO;
  }
}

const WORKFLOW = `name: repeat-runtime
version: "1.0"
inputs:
  phase:
    type: string
    required: true
job_groups:
  retry:
    repeat:
      max_iterations: 2
      until: "\${{ jobs.review.outputs.verdict }} == 'accepted'"
jobs:
  review:
    group: retry
    steps:
      - id: review
        type: agent
        prompt: Review.
        allow_generic_prompt: true
        outputs:
          verdict: {}
  downstream:
    needs: [review]
    steps:
      - id: finish
        type: script
        run: echo done
`;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createFixture(): Promise<{
  runDir: string;
  runId: string;
  stateStore: LocalStateStore;
}> {
  const root = join(tmpdir(), `zigma-repeat-runtime-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const workflowPath = join(root, "workflow.yml");
  const runsDir = join(root, "runs");
  const skillLockPath = join(root, "skill-lock.json");
  await mkdir(runsDir, { recursive: true });
  await writeFile(workflowPath, WORKFLOW, "utf8");
  await writeFile(skillLockPath, "{}", "utf8");
  const { runId } = await createRun({
    workflowPath,
    task: "repeat contract",
    inputs: { phase: "P4" },
    runsDir,
    skillLockPath,
    clock: new FakeClock(),
  });
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return {
    runDir: join(runsDir, runId),
    runId,
    stateStore: new LocalStateStore(),
  };
}

async function completeReview(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  verdict: "accepted" | "rejected",
): Promise<RunState> {
  const state = (await fixture.stateStore.readSnapshot(fixture.runDir))!;
  state.jobs.review = {
    ...state.jobs.review!,
    status: "running",
    current_step: "review",
    outputs: { verdict },
  };
  await fixture.stateStore.writeSnapshot(fixture.runDir, state);
  await advanceJob({
    runDir: fixture.runDir,
    runId: fixture.runId,
    jobId: "review",
    clock: new FakeClock(),
  });
  return (await fixture.stateStore.readSnapshot(fixture.runDir))!;
}

describe("job-group runtime repeat", () => {
  it("persists run inputs and releases downstream only after until passes", async () => {
    const fixture = await createFixture();
    let state = await completeReview(fixture, "rejected");

    expect(state.inputs).toEqual({ task: "repeat contract", phase: "P4" });
    expect(state.jobs.review).toMatchObject({ status: "ready", attempt: 2 });
    expect(state.jobs.downstream?.status).toBe("waiting");
    expect(state.job_groups?.retry?.status).toBe("iterating");

    const events = (await readFile(join(fixture.runDir, "events.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; job: string | null; attempt: number | null; payload: { job_id?: string } });
    const readyIndexes = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === "job_ready" && event.payload.job_id === "review")
      .map(({ index }) => index);
    const secondAttemptIndex = events.findIndex(
      (event) => event.type === "attempt_started" && event.job === "review" && event.attempt === 2,
    );
    expect(readyIndexes).toHaveLength(2);
    expect(readyIndexes.at(-1)).toBeLessThan(secondAttemptIndex);

    state = await completeReview(fixture, "accepted");
    expect(state.job_groups?.retry?.status).toBe("completed");
    expect(state.jobs.downstream?.status).toBe("ready");
  });

  it("fails the run and keeps downstream waiting when until never passes", async () => {
    const fixture = await createFixture();
    await completeReview(fixture, "rejected");
    const state = await completeReview(fixture, "rejected");

    expect(state.status).toBe("failed");
    expect(state.job_groups?.retry?.status).toBe("failed");
    expect(state.jobs.review?.status).toBe("failed");
    expect(state.jobs.downstream?.status).toBe("waiting");
    expect(await readFile(join(fixture.runDir, "events.jsonl"), "utf8")).toContain(
      '"type":"run_failed"',
    );
  });
});
