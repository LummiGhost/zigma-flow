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

import { discoverSkillPacks, loadSkillPack, resolveSkillLock, SkillLockSchema } from "../skill-pack/index.js";
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
  jobs?: string[];
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
  // Issue #105: Signal Semantics Table — extended fields for structured signal table
  when_to_emit?: string;
  required_evidence?: string;
  engine_effect?: string;
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
  runTask?: string;
  capabilities: ExposedCapabilities;
  primaryPrompt?: PrimaryPrompt;
  warnings?: string[];
  inputs: Record<string, string>;
  stepOutputs?: Record<string, unknown>;
  required_artifacts?: string[];
  artifacts: ArtifactSummary[];
  upstreamOutputs?: Record<string, Record<string, unknown>>;  // completed job id → outputs
  signals: SignalSpec[];
  permissions: PermissionSet;
  repositoryWorkspace?: RepositoryWorkspacePermissions;
  // WF-P13-VARIABLES
  variables?: Record<string, unknown>;
  contextBlocks?: Array<{ id: string; version: number; content: string; writable: boolean }>;
  // Step-specific output schemas (Issue #100)
  outputsSchema?: Record<string, { type: string }>;
  artifactPolicy?: { required?: string[]; forbidden?: string[] };
  signalPolicy?: { allowed?: string[]; required_evidence?: string[] };
  // Issue #106: Allow generic prompt fallback when no primary prompt is found
  allowGenericPrompt?: boolean;
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
 * Detect whether a step.prompt value is an inline template (vs. a Skill
 * Pack prompt reference ID).
 *
 * Heuristic:
 *   - If `prompt` contains newlines -> inline template.
 *   - If `prompt` contains `${{ }}` pattern -> inline template.
 *   - Otherwise -> treated as Skill Pack prompt reference ID.
 */
export function isInlinePrompt(prompt: string | undefined): boolean {
  if (prompt === undefined || prompt.trim().length === 0) return false;
  if (prompt.includes("\n")) return true;
  return /\$\{\{/.test(prompt);
}

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

  if (
    typeof stepPrompt === "string" &&
    stepPrompt.trim().length > 0 &&
    !isInlinePrompt(stepPrompt)
  ) {
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

      // Resolve pack root and load pack.
      // Try skill-lock first (deprecated), then fall back to direct discovery.
      let packRoot: string;
      try {
        packRoot = await resolveSkillLock(zigmaflowDir, skillId);
      } catch {
        // skill-lock.json may not exist (v0.6 deprecation). Fall back to
        // searching across all configured skill paths.
        const result = await discoverSkillPacks(zigmaflowDir);
        const found = result.skills.find((s) => s.skillId === skillId);
        if (!found) {
          throw new WorkflowError(
            `Skill "${skillId}" not found: skill-lock.json is missing or deprecated, ` +
              `and the skill was not discovered in any search path ` +
              `(${result.searchPaths.map((p) => p.source).join(", ")}).`,
            { details: { skillId, alias } },
          );
        }
        packRoot = found.packRoot;
      }
      const pack = await loadSkillPack(packRoot);

      // Get version from skill-lock (deprecated) or fall back to pack's own version
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

      // Primary prompt matching — skip for inline prompts
      if (!isInlinePrompt(step.prompt as string | undefined) && primaryPrompt === undefined) {
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
          if (
            Array.isArray(fObj["jobs"]) &&
            (fObj["jobs"] as unknown[]).every((j) => typeof j === "string")
          ) {
            fn.jobs = fObj["jobs"] as string[];
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

    // Inline prompt resolution — after packs loaded for capabilities + conflict detection
    if (isInlinePrompt(step.prompt as string | undefined)) {
      // Conflict detection: check if inline text matches any Skill Pack prompt id
      if (typeof step.prompt === "string") {
        const trimmedPrompt = step.prompt.trim();
        for (const ep of exposedPrompts) {
          if (promptIdMatches(ep.skill, ep.id, trimmedPrompt)) {
            throw new WorkflowError(
              `Inline prompt conflicts with Skill Pack prompt "${ep.id}" in pack "${ep.skill}".`,
              { details: { prompt: step.prompt, skill: ep.skill, promptId: ep.id } }
            );
          }
        }
      }

      // Resolve expressions and construct PrimaryPrompt
      const resolvedContent = resolveExpression(
        step.prompt as string,
        {
          inputs: { task: state.task },
          run: { id: state.run_id, workflow: state.workflow },
        },
      );
      primaryPrompt = {
        skill: exposedSkills.length > 0 ? exposedSkills[0]!.alias : "",
        id: "(inline)",
        path: "(inline template)",
        content: resolvedContent,
        source: "step.prompt",
      };
    }

    // Warnings — only for non-inline prompts
    if (!isInlinePrompt(step.prompt as string | undefined)) {
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
    }
  } else if (step.type === "agent") {
    if (isInlinePrompt(step.prompt as string | undefined)) {
      // Inline prompt without expose.skills — no packs to load
      const resolvedContent = resolveExpression(
        step.prompt as string,
        {
          inputs: { task: state.task },
          run: { id: state.run_id, workflow: state.workflow },
        },
      );
      primaryPrompt = {
        skill: "",
        id: "(inline)",
        path: "(inline template)",
        content: resolvedContent,
        source: "step.prompt",
      };
    } else {
      warnings.push(
        `No primary prompt resolved for job "${jobId}" step "${stepId}" because the agent step exposes no skills. ` +
        `Falling back to generated step context.`
      );
    }
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
  // 4b. Collect upstream job outputs (for evidence bundle)
  // -----------------------------------------------------------------------

  const upstreamOutputs: Record<string, Record<string, unknown>> = {};
  for (const [jid, jstate] of Object.entries(state.jobs)) {
    if (jid === jobId) continue;
    if (jstate.status !== "completed") continue;
    if (jstate.outputs === undefined || Object.keys(jstate.outputs).length === 0) continue;
    upstreamOutputs[jid] = jstate.outputs;
  }

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
  if (typeof jobDef.workspace === "object" && jobDef.workspace !== null && typeof jobDef.workspace["mode"] === "string") {
    repositoryWorkspace.mode = jobDef.workspace["mode"];
  }

  // -----------------------------------------------------------------------
  // 7. Variables injection (WF-P13-VARIABLES)
  // -----------------------------------------------------------------------

  let bundleVariables: Record<string, unknown> | undefined;
  if (
    workflowDef.variables !== undefined &&
    step.permissions?.variables?.read !== undefined &&
    step.permissions.variables.read.length > 0
  ) {
    const stateVars = state.variables ?? {};
    bundleVariables = {};
    for (const varName of step.permissions.variables.read) {
      if (Object.prototype.hasOwnProperty.call(stateVars, varName)) {
        bundleVariables[varName] = stateVars[varName];
      }
    }
    // Only include if we have matching variables
    if (Object.keys(bundleVariables).length === 0) {
      bundleVariables = undefined;
    }
  }

  // -----------------------------------------------------------------------
  // 8. Context blocks injection (WF-P13-VARIABLES)
  // -----------------------------------------------------------------------

  let bundleContextBlocks:
    | Array<{ id: string; version: number; content: string; writable: boolean }>
    | undefined;

  if (
    workflowDef.context_blocks !== undefined &&
    step.permissions?.context_blocks?.read !== undefined &&
    step.permissions.context_blocks.read.length > 0
  ) {
    const stateBlocks = state.context_blocks ?? {};
    const writeSet = new Set(step.permissions.context_blocks.write ?? []);
    bundleContextBlocks = [];

    for (const blockId of step.permissions.context_blocks.read) {
      const blockState = stateBlocks[blockId];
      if (blockState === undefined) continue;

      // Read the current version artifact content from disk
      let content = "";
      if (blockState.current_artifact) {
        const artifactPath = join(runDir, blockState.current_artifact);
        try {
          content = await readFile(artifactPath, "utf-8");
        } catch {
          // If artifact file doesn't exist, use empty content
          content = "";
        }
      }

      const writable = writeSet.has(blockId);
      bundleContextBlocks.push({
        id: blockId,
        version: blockState.current_version,
        content,
        writable,
      });
    }

    if (bundleContextBlocks.length === 0) {
      bundleContextBlocks = undefined;
    }
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
    runTask: state.task,
    capabilities,
    ...(primaryPrompt !== undefined ? { primaryPrompt } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    inputs: resolvedInputs,
    ...(step.outputs !== undefined ? { stepOutputs: step.outputs } : {}),
    ...(step.outputs_schema !== undefined ? { outputsSchema: step.outputs_schema } : {}),
    ...(step.artifact_policy !== undefined ? { artifactPolicy: step.artifact_policy } : {}),
    ...(step.signal_policy !== undefined ? { signalPolicy: step.signal_policy } : {}),
    ...(step.required_artifacts !== undefined ? { required_artifacts: step.required_artifacts } : {}),
    artifacts,
    ...(Object.keys(upstreamOutputs).length > 0 ? { upstreamOutputs } : {}),
    signals,
    permissions,
    repositoryWorkspace,
    ...(bundleVariables !== undefined ? { variables: bundleVariables } : {}),
    ...(bundleContextBlocks !== undefined ? { contextBlocks: bundleContextBlocks } : {}),
    // Issue #106: Pass allow_generic_prompt from step definition
    ...(step.allow_generic_prompt !== undefined ? { allowGenericPrompt: step.allow_generic_prompt } : {}),
  };
}
