/**
 * Engine — orchestrates run creation.
 *
 * Reference: docs/mvp-contracts.md §2.3, §2.4 (RC-R01..R12)
 * WF-P3-RUN Step 2.
 */

import { dirname } from "node:path";

import { computeReadyJobs } from "../dag/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import type { Clock, RunState } from "../run/index.js";
import { WorkflowError } from "../utils/index.js";
import {
  JsonlEventWriter,
  LocalRunIdGenerator,
  LocalStateStore,
  SystemClock,
  createRunDirectory,
  snapshotSkillLock,
  writeActiveRun,
  writeRunYaml,
} from "../run/index.js";
import { nextEventId as formatEventId } from "../events/index.js";

export interface CreateRunInputs {
  workflowPath: string;
  task: string;
  runsDir: string;
  skillLockPath: string;
  clock?: Clock; // injectable for tests; defaults to SystemClock
}

export interface CreateRunResult {
  runId: string;
}

export async function createRun(inputs: CreateRunInputs): Promise<CreateRunResult> {
  const clock: Clock = inputs.clock ?? new SystemClock();
  const idGenerator = new LocalRunIdGenerator(clock);
  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // RC-R01: Generate runId
  const runId = await idGenerator.nextRunId(inputs.runsDir);

  // RC-R02: Create run directory
  const runDir = await createRunDirectory(runId, inputs.runsDir);

  // Load workflow (prerequisite for RC-R03..R06)
  const wf = await loadWorkflowFile(inputs.workflowPath);

  // RC-R12: Snapshot skill-lock into run directory
  await snapshotSkillLock(runDir, inputs.skillLockPath);

  // RC-R03: Write run.yml
  const createdAt = clock.now();
  await writeRunYaml(runDir, {
    task: inputs.task,
    workflow: {
      name: wf.name,
      path: inputs.workflowPath,
    },
    created_at: createdAt,
    skill_lock_snapshot: "skill-lock.snapshot.json",
  });

  // RC-R04/R05/R06: Compute initial job states (ready / waiting / inactive)
  const readySet = new Set(computeReadyJobs(wf.jobs, new Set(), new Set()));

  const jobs: Record<string, import("../run/index.js").JobState> = {};
  for (const [jobId, jobDef] of Object.entries(wf.jobs)) {
    if (jobDef.activation !== undefined) {
      // activation: optional (or any activation value) → inactive
      const js: import("../run/index.js").JobState = { status: "inactive" };
      js.activation = jobDef.activation;
      jobs[jobId] = js;
    } else if (readySet.has(jobId)) {
      jobs[jobId] = { status: "ready" };
    } else {
      jobs[jobId] = { status: "waiting" };
    }
  }

  // RC-R09/R10: Event counter — sequential evt-NNN ids
  let eventCounter = 1;
  function nextEventId(): string {
    return formatEventId(eventCounter++);
  }

  // RC-R09: Append run_created event (evt-001)
  await eventWriter.appendEvent(runDir, {
    id: nextEventId(),
    type: "run_created",
    run_id: runId,
    timestamp: clock.now(),
    producer: "engine",
    job: null,
    step: null,
    attempt: null,
    payload: { workflow: wf.name, task: inputs.task },
  });

  // RC-R10: Append one job_ready event per initial ready job
  // Use Object.keys(wf.jobs) order filtered to those in the ready set
  for (const jobId of Object.keys(wf.jobs)) {
    if (readySet.has(jobId)) {
      await eventWriter.appendEvent(runDir, {
        id: nextEventId(),
        type: "job_ready",
        run_id: runId,
        timestamp: clock.now(),
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: { job_id: jobId },
      });
    }
  }

  // RC-R08/R11: Read confirmed tail event id — MUST be non-null after appending run_created
  const lastEventId = await eventWriter.readLastEventId(runDir);
  if (lastEventId === null) {
    throw new WorkflowError("events.jsonl is empty after appending run_created — write failure", {
      details: { runDir },
    });
  }

  // RC-R11: Build RunState with the confirmed last event id, then atomic write
  const state: RunState = {
    run_id: runId,
    workflow: wf.name,
    task: inputs.task,
    created_at: createdAt,
    last_event_id: lastEventId,
    jobs,
  };

  // RC-R07/R11: Atomically write state.json via StateStore (Engine is sole writer)
  await stateStore.writeSnapshot(runDir, state);

  // WF-P5-PROMPT: Write active_run pointer to config.json.
  // runsDir = <project>/.zigma-flow/runs → zigmaflowDir = <project>
  const zigmaflowDir = dirname(dirname(inputs.runsDir));
  try {
    await writeActiveRun(zigmaflowDir, runId);
  } catch {
    // active_run update is best-effort — config.json may not exist in
    // all test setups (e.g. older integration tests). Do not fail createRun.
  }

  return { runId };
}
