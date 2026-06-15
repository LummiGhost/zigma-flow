/**
 * Context Builder — assembles a ContextBundle for the current agent step.
 *
 * Consumes: Workflow Definition, Skill Pack, Run Runtime, Artifact (read-only).
 * Does NOT mutate run state or write any file.
 *
 * Reference: docs/phases/p5-context-prompt/workflows/wf-p5-context/01-cases-and-tests.md
 * WF-P5-CONTEXT Step 2.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadSkillPack, resolveSkillLock, SkillLockSchema } from "../skill-pack/index.js";
import { FilesystemError, WorkflowError } from "../utils/index.js";
import { resolveExpression } from "../expression/index.js";
import type { WorkflowDefinition } from "../workflow/index.js";
import type { RunState } from "../run/index.js";
import type { ArtifactMetadata } from "../artifact/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StepKind =
  | "agent"
  | "script"
  | "check"
  | "router"
  | "workflow"
  | "human";

export interface ExposedSkillRef {
  alias: string;    // workflow-level skill alias (e.g. "code")
  skillId: string;  // resolved skill pack id (e.g. "zigma.code-change")
  version: string;  // from skill-lock.json entry
}

export interface ExposedKnowledge {
  skill: string;    // workflow-level alias
  id: string;
  path?: string;
  description?: string;
  readPolicy?: "required" | "optional";
  usage?: string;
}

export interface ExposedPrompt {
  skill: string;
  id: string;
  path?: string;
}

export interface PrimaryPrompt {
  skill: string;
  id: string;
  path: string;
  content: string;
  source: "step.prompt" | "job.id" | "step.id";
}

export interface ExposedFunction {
  skill: string;
  id: string;
  description?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

export interface ExposedTool {
  skill: string;
  id: string;
}

export interface ExposedCapabilities {
  skills: ExposedSkillRef[];
  knowledge: ExposedKnowledge[];
  prompts: ExposedPrompt[];
  functions: ExposedFunction[];
  tools: ExposedTool[];
}

export interface ArtifactSummary {
  id: string;
  kind: string;
  path: string;
  summary: string;
  size: number;
  content_type: string;
}

export interface SignalSpec {
  id: string;
  description?: string;
  allowed_from: string[];
  schema?: Record<string, unknown>;
  [key: string]: unknown;
}

export type PermissionSet = Record<string, unknown>;

export interface RepositoryWorkspacePermissions {
  mode?: string;
}

export interface ContextBundle {
  runId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  stepType: StepKind;
  capabilities: ExposedCapabilities;
  primaryPrompt?: PrimaryPrompt;
  warnings?: string[];
  inputs: Record<string, string>;
  artifacts: ArtifactSummary[];
  signals: SignalSpec[];
  permissions: PermissionSet;
  repositoryWorkspace?: RepositoryWorkspacePermissions;
}

export interface BuildContextOpts {
  runDir: string;             // .zigma-flow/runs/<run-id>
  zigmaflowDir: string;       // project root (parent of .zigma-flow/)
  workflowDef: WorkflowDefinition;
  state: RunState;
  jobId: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the skill id from a workflow `skills` map value.
 * Values may be:
 *   - a bare string — the skill id itself
 *   - an object with `id` field
 *   - an object with `uses` field like "skill://zigma.code-change@1"
 * Throws WorkflowError for unrecognised shapes.
 */
function extractSkillId(alias: string, value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;

    if (typeof obj["id"] === "string") {
      return obj["id"];
    }

    if (typeof obj["uses"] === "string") {
      // "skill://zigma.code-change@1" → "zigma.code-change"
      let uses = obj["uses"];
      if (uses.startsWith("skill://")) {
        uses = uses.slice("skill://".length);
      }
      // Strip optional @<version> suffix
      const atIdx = uses.indexOf("@");
      if (atIdx !== -1) {
        uses = uses.slice(0, atIdx);
      }
      return uses;
    }

    if (typeof obj["source"] === "string") {
      return obj["source"];
    }
  }
  throw new WorkflowError(
    `Cannot determine skill id for alias "${alias}": unrecognised value shape`,
    { details: { alias, value } }
  );
}

/**
 * Read the skill-lock.json and return the version for a given skillId.
 * Falls back to the pack's own version field if no lock entry is found.
 */
async function readSkillLockVersion(
  zigmaflowDir: string,
  skillId: string
): Promise<string | undefined> {
  const lockPath = join(zigmaflowDir, ".zigma-flow", "skill-lock.json");
  try {
    const raw = await readFile(lockPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const result = SkillLockSchema.safeParse(parsed);
    if (result.success) {
      return result.data.skills[skillId]?.version;
    }
  } catch {
    // If lock can't be read, fall through to undefined
  }
  return undefined;
}

/**
 * Read <runDir>/artifacts.jsonl and project each line to ArtifactSummary.
 * Returns [] if the file is missing or empty.
 */
async function readArtifactSummaries(runDir: string): Promise<ArtifactSummary[]> {
  const artifactsPath = join(runDir, "artifacts.jsonl");
  let content: string;
  try {
    content = await readFile(artifactsPath, "utf-8");
  } catch (e: unknown) {
    if (isEnoent(e)) {
      return [];
    }
    throw e;
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const summaries: ArtifactSummary[] = [];

  for (const line of lines) {
    let meta: ArtifactMetadata;
    try {
      meta = JSON.parse(line) as ArtifactMetadata;
    } catch (e: unknown) {
      throw new FilesystemError(
        `artifacts.jsonl contains unparseable line: ${(e as Error).message}`,
        { cause: e }
      );
    }
    summaries.push({
      id: meta.id,
      kind: meta.kind,
      path: meta.path,
      summary: meta.summary,
      size: meta.size,
      content_type: meta.content_type,
    });
  }

  return summaries;
}

function isEnoent(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as Record<string, unknown>)["code"] === "ENOENT"
  );
}

interface PromptCandidate {
  id: string;
  source: PrimaryPrompt["source"];
}

function primaryPromptCandidates(jobId: string, stepId: string, stepPrompt: unknown): PromptCandidate[] {
  const candidates: PromptCandidate[] = [];
  const seen = new Set<string>();

  if (typeof stepPrompt === "string" && stepPrompt.trim().length > 0) {
    const id = stepPrompt.trim();
    candidates.push({ id, source: "step.prompt" });
    seen.add(id);
  }

  for (const candidate of [
    { id: jobId, source: "job.id" as const },
    { id: stepId, source: "step.id" as const },
  ]) {
    if (!seen.has(candidate.id)) {
      candidates.push(candidate);
      seen.add(candidate.id);
    }
  }

  return candidates;
}

function promptIdMatches(alias: string, promptId: string, candidate: string): boolean {
  return (
    promptId === candidate ||
    `${alias}.${promptId}` === candidate ||
    `${alias}/${promptId}` === candidate
  );
}

function knowledgeReadGuidance(id: string, description?: string): Pick<ExposedKnowledge, "readPolicy" | "usage"> {
  switch (id) {
    case "coding-guidelines":
      return {
        readPolicy: "required",
        usage: "read before starting this step",
      };
    case "workflow-guide":
      return {
        readPolicy: "required",
        usage: "report schema and workflow DAG reference",
      };
    case "common-failure-patterns":
      return {
        readPolicy: "optional",
        usage: "consult if unsure about approach, failure handling, or retry behavior",
      };
    default:
      return {
        readPolicy: "optional",
        usage: description ?? "reference material for this step",
      };
  }
}

// ---------------------------------------------------------------------------
// buildContext
// ---------------------------------------------------------------------------

/**
 * Assemble a ContextBundle for the current agent step of the given job.
 * This function is purely read-only — it does not write any file.
 */
export async function buildContext(opts: BuildContextOpts): Promise<ContextBundle> {
  const { runDir, zigmaflowDir, workflowDef, state, jobId } = opts;

  // -----------------------------------------------------------------------
  // 1. Step selection
  // -----------------------------------------------------------------------

  const jobDef = workflowDef.jobs[jobId];
  if (jobDef === undefined) {
    throw new WorkflowError(
      `Job "${jobId}" is not defined in the workflow`,
      { details: { jobId } }
    );
  }

  // Get job state — may be absent (edge case: state has no entry for jobId)
  const jobState = state.jobs[jobId];

  // Determine current step id
  let stepId: string;
  if (jobState?.current_step !== undefined) {
    stepId = jobState.current_step;
  } else {
    const firstStep = jobDef.steps[0];
    if (firstStep === undefined) {
      throw new WorkflowError(
        `Job "${jobId}" has no steps defined`,
        { details: { jobId } }
      );
    }
    stepId = firstStep.id;
  }

  // Find the step definition
  const step = jobDef.steps.find((s) => s.id === stepId);
  if (step === undefined) {
    throw new WorkflowError(
      `Step "${stepId}" not found in job "${jobId}"`,
      { details: { jobId, stepId } }
    );
  }

  // -----------------------------------------------------------------------
  // 2. Capability exposure (agent steps with expose.skills only)
  // -----------------------------------------------------------------------

  const emptyCapabilities: ExposedCapabilities = {
    skills: [],
    knowledge: [],
    prompts: [],
    functions: [],
    tools: [],
  };

  let capabilities: ExposedCapabilities = emptyCapabilities;
  let primaryPrompt: PrimaryPrompt | undefined;
  const warnings: string[] = [];

  if (step.type === "agent" && step.expose?.skills !== undefined && step.expose.skills.length > 0) {
    const exposedSkills: ExposedSkillRef[] = [];
    const exposedKnowledge: ExposedKnowledge[] = [];
    const exposedPrompts: ExposedPrompt[] = [];
    const exposedFunctions: ExposedFunction[] = [];
    const exposedTools: ExposedTool[] = [];

    for (const alias of step.expose.skills) {
      // Lookup the skill alias in workflowDef.skills
      const skillsMap = workflowDef.skills ?? {};
      if (!Object.prototype.hasOwnProperty.call(skillsMap, alias)) {
        throw new WorkflowError(
          `Expose alias "${alias}" is not declared in workflow skills`,
          { details: { alias, declaredSkills: Object.keys(skillsMap) } }
        );
      }

      const skillValue = skillsMap[alias];
      const skillId = extractSkillId(alias, skillValue);

      // Resolve pack root and load pack
      const packRoot = await resolveSkillLock(zigmaflowDir, skillId);
      const pack = await loadSkillPack(packRoot);

      // Get version from skill-lock
      const version = (await readSkillLockVersion(zigmaflowDir, skillId)) ?? pack.version;

      exposedSkills.push({ alias, skillId, version });

      // Collect knowledge entries
      for (const k of pack.knowledge ?? []) {
        const kEntry: ExposedKnowledge = {
          skill: alias,
          id: k.id,
          path: k.path,
          ...knowledgeReadGuidance(k.id, k.description),
        };
        if (k.description !== undefined) {
          kEntry.description = k.description;
        }
        exposedKnowledge.push(kEntry);
      }

      // Collect prompt entries
      for (const p of pack.prompts ?? []) {
        exposedPrompts.push({
          skill: alias,
          id: p.id,
          path: p.path,
        });
      }

      if (primaryPrompt === undefined) {
        for (const candidate of primaryPromptCandidates(jobId, stepId, step.prompt)) {
          const promptExport = (pack.prompts ?? []).find((p) =>
            promptIdMatches(alias, p.id, candidate.id)
          );
          if (promptExport === undefined) {
            continue;
          }

          const content = await readFile(join(packRoot, promptExport.path), "utf-8");
          primaryPrompt = {
            skill: alias,
            id: promptExport.id,
            path: promptExport.path,
            content,
            source: candidate.source,
          };
          break;
        }
      }

      // Collect function entries (defensively project from unknown[])
      for (const f of pack.functions ?? []) {
        if (typeof f === "object" && f !== null && typeof (f as Record<string, unknown>)["id"] === "string") {
          const fObj = f as Record<string, unknown>;
          const fn: ExposedFunction = {
            skill: alias,
            id: fObj["id"] as string,
          };
          if (typeof fObj["description"] === "string") {
            fn.description = fObj["description"];
          }
          if (typeof fObj["inputs"] === "object" && fObj["inputs"] !== null) {
            fn.inputs = fObj["inputs"] as Record<string, unknown>;
          }
          if (typeof fObj["outputs"] === "object" && fObj["outputs"] !== null) {
            fn.outputs = fObj["outputs"] as Record<string, unknown>;
          }
          exposedFunctions.push(fn);
        }
      }

      // Tools (not defined in MVP skill packs — collect defensively if present)
      // The skill pack definition does not have a `tools` field in the schema,
      // so we check dynamically for forward compatibility.
      const packAny = pack as unknown as Record<string, unknown>;
      if (Array.isArray(packAny["tools"])) {
        for (const t of packAny["tools"] as unknown[]) {
          if (typeof t === "object" && t !== null && typeof (t as Record<string, unknown>)["id"] === "string") {
            exposedTools.push({
              skill: alias,
              id: (t as Record<string, unknown>)["id"] as string,
            });
          }
        }
      }
    }

    capabilities = {
      skills: exposedSkills,
      knowledge: exposedKnowledge,
      prompts: exposedPrompts,
      functions: exposedFunctions,
      tools: exposedTools,
    };

    if (primaryPrompt === undefined) {
      const candidates = primaryPromptCandidates(jobId, stepId, step.prompt).map((c) => c.id);
      warnings.push(
        `No primary prompt resolved for job "${jobId}" step "${stepId}". ` +
        `Tried prompt ids: ${candidates.join(", ")}. Falling back to generated step context.`
      );
    } else if (
      typeof step.prompt === "string" &&
      step.prompt.trim().length > 0 &&
      !promptIdMatches(primaryPrompt.skill, primaryPrompt.id, step.prompt.trim())
    ) {
      warnings.push(
        `Declared primary prompt "${step.prompt.trim()}" was not found in exposed Skill Pack prompts; ` +
        `fell back to ${primaryPrompt.source} prompt "${primaryPrompt.id}".`
      );
    }
  } else if (step.type === "agent") {
    warnings.push(
      `No primary prompt resolved for job "${jobId}" step "${stepId}" because the agent step exposes no skills. ` +
      `Falling back to generated step context.`
    );
  }

  // -----------------------------------------------------------------------
  // 3. Input resolution
  // -----------------------------------------------------------------------

  const exprCtx = {
    inputs: { task: state.task },
    run: { id: state.run_id, workflow: state.workflow },
  };

  const resolvedInputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(step.with ?? {})) {
    if (typeof value === "string") {
      resolvedInputs[key] = resolveExpression(value, exprCtx);
    }
    // Non-string values are excluded (MVP scope: inputs is Record<string, string>)
  }

  // -----------------------------------------------------------------------
  // 4. Artifact summaries
  // -----------------------------------------------------------------------

  const artifacts = await readArtifactSummaries(runDir);

  // -----------------------------------------------------------------------
  // 5. Signal filtering
  // -----------------------------------------------------------------------

  const signals: SignalSpec[] = [];
  if (workflowDef.signals !== undefined) {
    for (const [signalId, signalValue] of Object.entries(workflowDef.signals)) {
      if (
        typeof signalValue !== "object" ||
        signalValue === null
      ) {
        continue;
      }
      const signalObj = signalValue as Record<string, unknown>;

      // Must have allowed_from: string[]
      if (!Array.isArray(signalObj["allowed_from"])) {
        continue;
      }
      const allowedFrom = signalObj["allowed_from"] as unknown[];
      if (!allowedFrom.every((v) => typeof v === "string")) {
        continue;
      }

      const allowedFromStrings = allowedFrom as string[];
      if (!allowedFromStrings.includes(jobId)) {
        continue;
      }

      // Build SignalSpec
      const spec: SignalSpec = {
        ...signalObj,
        id: signalId,
        allowed_from: allowedFromStrings,
      };
      if (typeof signalObj["description"] === "string") {
        spec.description = signalObj["description"];
      }
      if (typeof signalObj["schema"] === "object" && signalObj["schema"] !== null) {
        spec.schema = signalObj["schema"] as Record<string, unknown>;
      }

      signals.push(spec);
    }
  }

  // -----------------------------------------------------------------------
  // 6. Permission merging
  // -----------------------------------------------------------------------

  const permissions: PermissionSet = {
    ...(workflowDef.permissions ?? {}),
    ...(jobDef.permissions ?? {}),
  };

  const repositoryWorkspace: RepositoryWorkspacePermissions = {};
  if (typeof jobDef.workspace?.["mode"] === "string") {
    repositoryWorkspace.mode = jobDef.workspace["mode"];
  }

  // -----------------------------------------------------------------------
  // Assemble and return bundle
  // -----------------------------------------------------------------------

  return {
    runId: state.run_id,
    jobId,
    stepId,
    attempt: jobState?.attempt ?? 1,
    stepType: step.type as StepKind,
    capabilities,
    ...(primaryPrompt !== undefined ? { primaryPrompt } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    inputs: resolvedInputs,
    artifacts,
    signals,
    permissions,
    repositoryWorkspace,
  };
}
