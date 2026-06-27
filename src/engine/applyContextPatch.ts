/**
 * applyContextPatch — Engine entry point for applying context patches from
 * Agent reports.
 *
 * Processes context_patches from an Agent report in a batch-atomic fashion:
 * validates ALL patches before writing ANY changes. If any patch fails
 * validation, no writes occur (atomic rollback).
 *
 * Supported patch kinds:
 *   - variable_set: set a workflow variable value
 *   - variable_delete: remove a workflow variable
 *   - context_block_set: replace a context block's content (new version)
 *   - context_block_append: append to a context block's content (new version)
 *   - context_block_delete: remove a context block
 *
 * WF-P13-VARIABLES (AD-P13-010, AD-P13-011).
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { loadWorkflowFile } from "../workflow/index.js";
import type { WorkflowDefinition } from "../workflow/index.js";
import type { Clock, RunState } from "../run/index.js";
import { JsonlEventWriter, LocalStateStore } from "../run/index.js";
import { nextSequentialEventId } from "../events/index.js";
import { writeContextBlockArtifact } from "../artifact/index.js";
import { StateError, ValidationError } from "../utils/index.js";
import { appendArtifactIndex } from "../artifact/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextPatchKind =
  | "variable_set"
  | "variable_delete"
  | "context_block_set"
  | "context_block_append"
  | "context_block_delete";

export interface ContextPatch {
  kind: ContextPatchKind;
  name?: string;
  value?: unknown;
}

export interface ApplyContextPatchOpts {
  runDir: string;
  runId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  patches: ContextPatch[];
  clock: Clock;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Field names that must never be used as variable names. */
const RESERVED_FIELDS = new Set([
  "status",
  "last_event_id",
  "jobs",
  "signals",
  "run_id",
  "workflow",
  "task",
  "created_at",
  "step_visits",
]);

// ---------------------------------------------------------------------------
// Internal: parse run.yml to get the workflow file path
// ---------------------------------------------------------------------------

interface RunYmlShape {
  workflow?: { path?: string };
}

async function readWorkflowPathFromRunYml(runDir: string): Promise<string> {
  const runYmlPath = join(runDir, "run.yml");
  let raw: string;
  try {
    raw = await readFile(runYmlPath, "utf-8");
  } catch (e: unknown) {
    throw new StateError(`Cannot read run.yml in: ${runDir}`, { cause: e });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e: unknown) {
    throw new StateError(`run.yml contains invalid YAML in: ${runDir}`, { cause: e });
  }

  const shape = parsed as RunYmlShape;
  const wfPath = shape?.workflow?.path;
  if (typeof wfPath !== "string" || wfPath.length === 0) {
    throw new StateError(`run.yml is missing workflow.path in: ${runDir}`);
  }
  return wfPath;
}

// ---------------------------------------------------------------------------
// Wildcard matching helper
// ---------------------------------------------------------------------------

/**
 * Check if a writer reference matches the given jobId.stepId pattern.
 * Supports the <job>.* wildcard.
 */
function writerMatches(ref: string, jobId: string, stepId: string): boolean {
  // Exact match: "plan.draft"
  if (ref === `${jobId}.${stepId}`) return true;
  // Wildcard: "plan.*"
  if (ref === `${jobId}.*`) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Type validation helpers
// ---------------------------------------------------------------------------

function validateType(
  varName: string,
  declaredType: string,
  value: unknown
): void {
  let valid = false;
  switch (declaredType) {
    case "string":
      valid = typeof value === "string";
      break;
    case "number":
      valid = typeof value === "number";
      break;
    case "boolean":
      valid = typeof value === "boolean";
      break;
    case "array":
      valid = Array.isArray(value);
      break;
    case "object":
      valid = typeof value === "object" && value !== null && !Array.isArray(value);
      break;
    default:
      valid = true; // unknown type: pass through
  }
  if (!valid) {
    throw new ValidationError(
      `Variable "${varName}" expects type "${declaredType}" but got value of type "${typeof value}"`,
      { details: { variable: varName, expectedType: declaredType, actualType: typeof value } }
    );
  }
}

// ---------------------------------------------------------------------------
// applyContextPatch
// ---------------------------------------------------------------------------

export async function applyContextPatch(opts: ApplyContextPatchOpts): Promise<void> {
  const { runDir, runId, jobId, stepId, attempt, clock } = opts;
  let patches: ContextPatch[];

  // Normalize patches — empty/undefined → no-op
  if (!Array.isArray(opts.patches) || opts.patches.length === 0) {
    return;
  }
  patches = opts.patches;

  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // ── 1. Read state snapshot ─────────────────────────────────────────────

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  // Cast to mutable for in-memory patch application
  const mutableState: RunState = JSON.parse(JSON.stringify(state)) as RunState;

  // ── 2. Load workflow & find step definition ────────────────────────────

  const workflowPath = await readWorkflowPathFromRunYml(runDir);
  const wf: WorkflowDefinition = await loadWorkflowFile(workflowPath);

  const jobDef = wf.jobs[jobId];
  if (jobDef === undefined) {
    throw new StateError(`Job "${jobId}" not found in workflow for run ${runId}`);
  }

  const stepDef = jobDef.steps.find((s) => s.id === stepId);
  if (stepDef === undefined) {
    throw new StateError(`Step "${stepId}" not found in job "${jobId}" for run ${runId}`);
  }

  const permissions = stepDef.permissions;

  // ── 3. Pre-validate ALL patches (no writes on failure) ─────────────────

  // 3a. Check context_edit gate
  if (permissions?.context_edit === "none") {
    throw new ValidationError(
      `Step "${stepId}" in job "${jobId}" has context_edit: "none" — all context patches rejected`,
      { details: { jobId, stepId, context_edit: "none" } }
    );
  }

  for (const patch of patches) {
    switch (patch.kind) {
      case "variable_set":
      case "variable_delete": {
        const varName = patch.name;
        if (varName === undefined || varName.length === 0) {
          throw new ValidationError(
            `Patch ${patch.kind} requires a non-empty "name" field`,
            { details: { patch } }
          );
        }

        // Reserved field check
        if (RESERVED_FIELDS.has(varName)) {
          throw new ValidationError(
            `Variable name "${varName}" is a reserved field and cannot be modified via context patches`,
            { details: { variable: varName, reservedFields: [...RESERVED_FIELDS] } }
          );
        }

        // Variable must be declared in workflow
        if (!wf.variables || !Object.prototype.hasOwnProperty.call(wf.variables, varName)) {
          throw new ValidationError(
            `Variable "${varName}" is not declared in workflow "${wf.name}"`,
            { details: { variable: varName, workflow: wf.name } }
          );
        }

        const varDef = wf.variables[varName]!;

        // Step must have write permission for this variable
        const varWritePerms = permissions?.variables?.write ?? [];
        if (!varWritePerms.includes(varName)) {
          throw new ValidationError(
            `Step "${stepId}" in job "${jobId}" does not have variables.write permission for "${varName}"`,
            { details: { jobId, stepId, variable: varName } }
          );
        }

        // Step must be in allowed_writers
        const isAllowedWriter = varDef.allowed_writers.some((ref) =>
          writerMatches(ref, jobId, stepId)
        );
        if (!isAllowedWriter) {
          throw new ValidationError(
            `Step "${jobId}.${stepId}" is not in allowed_writers for variable "${varName}"`,
            { details: { jobId, stepId, variable: varName, allowed_writers: varDef.allowed_writers } }
          );
        }

        // For variable_set: type and enum validation
        if (patch.kind === "variable_set") {
          validateType(varName, varDef.type, patch.value);

          // Enum validation
          if (varDef.enum && varDef.enum.length > 0 && typeof patch.value === "string") {
            if (!varDef.enum.includes(patch.value)) {
              throw new ValidationError(
                `Value "${String(patch.value)}" is not in enum for variable "${varName}": [${varDef.enum.join(", ")}]`,
                { details: { variable: varName, value: patch.value, enum: varDef.enum } }
              );
            }
          }
        }
        break;
      }

      case "context_block_set":
      case "context_block_append":
      case "context_block_delete": {
        const blockId = patch.name;
        if (blockId === undefined || blockId.length === 0) {
          throw new ValidationError(
            `Patch ${patch.kind} requires a non-empty "name" field`,
            { details: { patch } }
          );
        }

        // Context block must be declared in workflow
        if (
          !wf.context_blocks ||
          !Object.prototype.hasOwnProperty.call(wf.context_blocks, blockId)
        ) {
          throw new ValidationError(
            `Context block "${blockId}" is not declared in workflow "${wf.name}"`,
            { details: { block: blockId, workflow: wf.name } }
          );
        }

        const blockDef = wf.context_blocks[blockId]!;

        // Step must have context_blocks.write permission for this block
        const cbWritePerms = permissions?.context_blocks?.write ?? [];
        if (!cbWritePerms.includes(blockId)) {
          throw new ValidationError(
            `Step "${stepId}" in job "${jobId}" does not have context_blocks.write permission for "${blockId}"`,
            { details: { jobId, stepId, block: blockId } }
          );
        }

        // Step must be in allowed_writers
        const isAllowedWriter = blockDef.allowed_writers.some((ref) =>
          writerMatches(ref, jobId, stepId)
        );
        if (!isAllowedWriter) {
          throw new ValidationError(
            `Step "${jobId}.${stepId}" is not in allowed_writers for context block "${blockId}"`,
            { details: { jobId, stepId, block: blockId, allowed_writers: blockDef.allowed_writers } }
          );
        }
        break;
      }

      default: {
        // Exhaustive check — catch any unknown patch kind
        const kind: string = (patch as unknown as Record<string, unknown>)["kind"] as string ?? "unknown";
        throw new ValidationError(
          `Unknown context patch kind: "${kind}"`,
          { details: { patchKind: kind } }
        );
      }
    }
  }

  // ── 4. All patches validated — apply in-memory ─────────────────────────

  // Ensure state.variables and state.context_blocks exist
  if (mutableState.variables === undefined) {
    mutableState.variables = {};
  }
  if (mutableState.context_blocks === undefined) {
    mutableState.context_blocks = {};
  }

  // Collect event payloads for batch write
  const eventPayloads: Array<{
    type: string;
    payload: Record<string, unknown>;
  }> = [];

  for (const patch of patches) {
    switch (patch.kind) {
      case "variable_set": {
        mutableState.variables![patch.name!] = patch.value;
        eventPayloads.push({
          type: "variable_set",
          payload: {
            variable: patch.name,
            value: patch.value,
            producer: `${jobId}.${stepId}`,
          },
        });
        break;
      }

      case "variable_delete": {
        delete mutableState.variables![patch.name!];
        eventPayloads.push({
          type: "variable_deleted",
          payload: {
            variable: patch.name,
            producer: `${jobId}.${stepId}`,
          },
        });
        break;
      }

      case "context_block_set":
      case "context_block_append": {
        const blockId = patch.name!;
        const existing = mutableState.context_blocks![blockId];
        const nextVersion = (existing?.current_version ?? 0) + 1;

        // Determine content for append
        let contentToWrite = "";
        if (patch.kind === "context_block_append" && existing?.current_artifact) {
          // Read existing content and append
          const existingPath = join(runDir, existing.current_artifact);
          try {
            contentToWrite = await readFile(existingPath, "utf-8");
          } catch {
            contentToWrite = "";
          }
          contentToWrite += String(patch.value ?? "");
        } else {
          contentToWrite = String(patch.value ?? "");
        }

        // Write artifact
        const artifactMeta = await writeContextBlockArtifact({
          runDir,
          runId,
          blockId,
          version: nextVersion,
          content: contentToWrite,
          job: jobId,
          step: stepId,
          attempt,
          clock,
        });

        // Register in artifact index
        await appendArtifactIndex(runDir, artifactMeta);

        // Update state
        mutableState.context_blocks![blockId] = {
          current_version: nextVersion,
          current_artifact: artifactMeta.path,
        };

        const eventPayload: Record<string, unknown> = {
          block: blockId,
          version: nextVersion,
          artifact_ref: artifactMeta.path,
          producer: `${jobId}.${stepId}`,
        };
        if (patch.kind === "context_block_append") {
          eventPayload.operation = "append";
        }

        eventPayloads.push({
          type: "context_block_updated",
          payload: eventPayload,
        });
        break;
      }

      case "context_block_delete": {
        const blockId = patch.name!;
        delete mutableState.context_blocks![blockId];
        eventPayloads.push({
          type: "context_block_deleted",
          payload: {
            block: blockId,
            producer: `${jobId}.${stepId}`,
          },
        });
        break;
      }
    }
  }


  // ── 5. Append events (event-first pattern) ──────────────────────────────

  let currentState: RunState = { ...mutableState };

  for (const evt of eventPayloads) {
    const eventId = await nextSequentialEventId(runDir, eventWriter);
    await eventWriter.appendEvent(runDir, {
      id: eventId,
      run_id: runId,
      type: evt.type as any,
      timestamp: clock.now(),
      producer: "engine",
      job: jobId,
      step: stepId,
      attempt,
      payload: evt.payload as any,
    });
    currentState = {
      ...currentState,
      last_event_id: eventId,
    };
  }

  // ── 6. Write state snapshot (with last event id from last event) ──────

  await stateStore.writeSnapshot(runDir, currentState);
}
