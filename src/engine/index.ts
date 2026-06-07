/**
 * Engine — orchestrates run creation.
 *
 * Reference: docs/mvp-contracts.md §2.3, §2.4 (RC-R01..R12)
 * WF-P3-RUN Step 2.
 */

import { computeReadyJobs } from "../dag/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import type { Clock, RunState } from "../run/index.js";
import {
  JsonlEventWriter,
  LocalRunIdGenerator,
  LocalStateStore,
  SystemClock,
  createRunDirectory,
  snapshotSkillLock,
  writeRunYaml,
} from "../run/index.js";

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

  // RC-R03: Load workflow
  const wf = await loadWorkflowFile(inputs.workflowPath);

  // RC-R04: Snapshot skill-lock
  await snapshotSkillLock(runDir, inputs.skillLockPath);

  // RC-R05: Write run.yml
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

  // RC-R06: Compute initial job states
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

  // RC-R07: Event counter
  let eventCounter = 1;
  function nextEventId(): string {
    return `evt-${String(eventCounter++).padStart(3, "0")}`;
  }

  // RC-R08: Append run_created event (evt-001)
  await eventWriter.appendEvent(runDir, {
    id: nextEventId(),
    type: "run_created",
    run_id: runId,
    timestamp: clock.now(),
    payload: { workflow: wf.name, task: inputs.task },
  });

  // RC-R09: Append one job_ready event per initial ready job
  // Use Object.keys(wf.jobs) order filtered to those in the ready set
  for (const jobId of Object.keys(wf.jobs)) {
    if (readySet.has(jobId)) {
      await eventWriter.appendEvent(runDir, {
        id: nextEventId(),
        type: "job_ready",
        run_id: runId,
        timestamp: clock.now(),
        payload: { job_id: jobId },
      });
    }
  }

  // RC-R10: Read last event id from event log
  const lastEventId = await eventWriter.readLastEventId(runDir);

  // RC-R11: Build RunState
  const state: RunState = {
    run_id: runId,
    workflow: wf.name,
    task: inputs.task,
    created_at: createdAt,
    last_event_id: lastEventId ?? "evt-001",
    jobs,
  };

  // RC-R12: Atomically write state.json
  await stateStore.writeSnapshot(runDir, state);

  return { runId };
}
