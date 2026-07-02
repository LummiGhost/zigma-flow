/**
 * Prompt Builder — renders a ContextBundle into a Markdown agent prompt
 * and writes it as an artifact.
 *
 * Reference: docs/phases/p5-context-prompt/workflows/wf-p5-prompt/
 * WF-P5-PROMPT Step 2.
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ArtifactSummary,
  ContextBundle,
  ExposedFunction,
  ExposedKnowledge,
  ExposedPrompt,
  ExposedTool,
  PermissionSet,
  SignalSpec,
} from "../context/index.js";
import { appendArtifactIndex } from "../artifact/artifactIndex.js";
import { artifactId } from "../artifact/artifactMetadata.js";
import type { Clock } from "../run/index.js";
import {
  artifactFileRelativePath,
  type ArtifactMetadata,
} from "../artifact/index.js";

import {
  runQualityGate,
  type QualityGateContext,
  type QualityGateIssue,
  type QualityGateResult,
} from "./qualityGate.js";

import { PromptBuildError } from "../utils/index.js";

export interface PromptHandoffIssue {
  code: string;
  message: string;
}

export interface PromptHandoffQualityResult {
  errors: PromptHandoffIssue[];
  warnings: PromptHandoffIssue[];
}

// Re-export quality gate types and function
export type { QualityGateContext, QualityGateIssue, QualityGateResult };
export { runQualityGate };

// ---------------------------------------------------------------------------
// Prompt Packet contract
// ---------------------------------------------------------------------------

export type PromptBlockType = "system" | "task" | "step" | "context" | "output";

export interface PromptBlock {
  id: string;
  type: PromptBlockType;
  title: string;
  source: string;
  priority: number;
  content: string;
}

export interface AgentSystemPrompt {
  block: PromptBlock;
  identity: string;
  invariants: string[];
  boundaries: string[];
}

export interface RunTaskPrompt {
  block: PromptBlock;
  source: "run.input" | "step.input" | "generated";
  task: string;
}

export interface WorkflowStepPrompt {
  block: PromptBlock;
  source: "step.prompt" | "job.id" | "step.id" | "generated-fallback";
  jobId: string;
  stepId: string;
  promptId?: string;
  promptPath?: string;
}

export type ContextBlockType =
  | "warning"
  | "artifact-summary"
  | "workspace-scan"
  | "knowledge-summary"
  | "capability-summary"
  | "upstream-output";

export type ContextFreshness = "current" | "prior" | "static";

export interface ContextBlock {
  id: string;
  type: ContextBlockType;
  source: string;
  priority: number;
  freshness: ContextFreshness;
  summary: string;
  artifactRef?: string;
  path?: string;
}

export interface OutputContract {
  block: PromptBlock;
  reportPath: string;
  runId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  reportSchema: {
    requiredTopLevelFields: ["outputs", "artifacts", "signals", "summary"];
  };
  requiredOutputs: string[];
  requiredArtifacts?: string[];
  allowedSignals: string[];
  // Issue #105: Full signal specs for the signal semantics table
  signalSpecs: SignalSpec[];
  artifactRules: string[];
  stopRequirement: string;
  // Step-specific output schemas (Issue #100)
  outputsSchema?: Record<string, { type: string }>;
  artifactPolicy?: { required?: string[]; forbidden?: string[] };
  signalPolicy?: { allowed?: string[]; required_evidence?: string[] };
}

export interface PromptPacket {
  metadata: {
    runId: string;
    jobId: string;
    stepId: string;
    attempt: number;
  };
  system: AgentSystemPrompt;
  task: RunTaskPrompt;
  step: WorkflowStepPrompt;
  context: ContextBlock[];
  output: OutputContract;
}

export interface PromptBackendCapabilities {
  supportsSystemPrompt?: boolean;
}

export interface RenderedPromptPacket {
  user: string;
  markdown: string;
  system?: string;
}

export type PromptPacketArtifactBlock = PromptBlockType | "manifest";

export interface PromptPacketArtifactRef {
  block: PromptPacketArtifactBlock;
  artifactRef: string;
  path: string;
  kind: string;
  contentType: string;
}

export interface PromptPacketArtifactRefs {
  system: PromptPacketArtifactRef;
  task: PromptPacketArtifactRef;
  step: PromptPacketArtifactRef;
  context: PromptPacketArtifactRef;
  output: PromptPacketArtifactRef;
  manifest: PromptPacketArtifactRef;
}

export interface PromptPacketArtifactManifest {
  schema_version: "prompt-packet-artifacts.v1";
  run_id: string;
  job_id: string;
  step_id: string;
  attempt: number;
  composed_preview: {
    artifact_ref: string;
    path: string;
  };
  backend_composition: {
    composition_order: readonly PromptBlockType[];
    system_prompt_block: "system";
    user_prompt_blocks: readonly Exclude<PromptBlockType, "system">[];
    heading_policy: string;
  };
  blocks: Array<{
    id: PromptBlockType;
    title: string;
    role: "system" | "user";
    source: string;
    priority: number;
    artifact_ref: string;
    path: string;
    content_type: "text/markdown";
  }>;
}

const MAX_CONTEXT_BLOCK_CHARS = 4_000;
const PROMPT_PACKET_BLOCK_ORDER: readonly PromptBlockType[] = [
  "system",
  "task",
  "step",
  "context",
  "output",
];

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

const TEMPLATE_PLACEHOLDERS: Record<TemplateName, readonly string[]> = {
  "system-prompt": ["identity", "invariantsLines", "boundariesLines", "allowedActionsMatrixSection", "instructionPrioritySection", "stopConditionsSection", "contextUsePolicySection", "verificationEvidenceSection"],
  "task-prompt": ["task"],
  "step-prompt": ["jobId", "stepId", "attempt", "promptSource", "promptId", "promptPath", "promptContent"],
  "step-prompt-fallback": ["jobId", "stepId", "attempt"],
  "output-contract": ["reportPath", "requiredOutputs", "requiredArtifacts", "allowedSignals", "stopRequirement"],
  "output-contract-lines": ["reportPath", "requiredOutputsLines", "requiredArtifactsLines", "allowedSignalsLines", "artifactRulesLines", "stopRequirement", "outputsSchemaSection", "artifactPolicySection", "signalPolicySection", "signalTableSection", "artifactReferenceSchemaSection"],
  "context-block": ["id", "type", "source", "priority", "freshness", "extraLines", "summary"],
  "permission-boundary": ["modePermissionLine", "contentReadLine", "commandsLine"],
  "allowed-actions-matrix": ["allowedActionsMatrixRows"],
  "instruction-priority": [],
  "stop-conditions": [],
  "context-use-policy": ["contextMandatorySection", "contextExternalSection", "contextEvidenceSection", "contextOptionalSection"],
  "verification-evidence": ["evidenceTableRows", "reviewClaimsNote"],
  "signal-table": ["signalTableRows"],
  "artifact-reference-schema": ["artifactPathExample", "evidenceRefExample", "stepArtifactDir"],
};

export function renderTemplate(template: string, vars: Record<string, string>, templateName: string): string {
  const allowedList = TEMPLATE_PLACEHOLDERS[templateName as TemplateName];
  if (!allowedList) {
    throw new Error(`Unknown template: ${templateName}`);
  }
  const allowed = new Set(allowedList);

  // Check for unknown placeholders in the template
  const placeholdersInTemplate = [...template.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]!);
  const unknownPlaceholders = placeholdersInTemplate.filter(p => !allowed.has(p));
  if (unknownPlaceholders.length > 0) {
    throw new Error(
      `Template "${templateName}" contains unknown placeholder(s): ${unknownPlaceholders.join(", ")}. ` +
      `Allowed: ${[...allowed].join(", ")}`
    );
  }

  // Check for missing required variables
  for (const p of placeholdersInTemplate) {
    if (!(p in vars)) {
      throw new Error(
        `Template "${templateName}" requires variable "${p}" but it was not provided. ` +
        `Provided: ${Object.keys(vars).join(", ")}`
      );
    }
  }

  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value !== undefined ? value : `{{${key}}}`;
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "templates");

const TEMPLATE_NAMES = [
  "system-prompt",
  "task-prompt",
  "step-prompt",
  "step-prompt-fallback",
  "output-contract",
  "output-contract-lines",
  "context-block",
  "permission-boundary",
  "allowed-actions-matrix",
  "instruction-priority",
  "stop-conditions",
  "context-use-policy",
  "verification-evidence",
  "signal-table",
  "artifact-reference-schema",
] as const;

type TemplateName = (typeof TEMPLATE_NAMES)[number];

function loadTemplates(): Record<TemplateName, string> {
  const templates = {} as Record<TemplateName, string>;
  for (const name of TEMPLATE_NAMES) {
    const filePath = join(TEMPLATES_DIR, `${name}.md`);
    try {
      templates[name] = readFileSync(filePath, "utf-8");
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && (err as Record<string, unknown>)["code"] === "ENOENT") {
        throw new Error(
          `Prompt template file is missing: ${name}.md\n` +
          `  Resolved path: ${filePath}\n` +
          `  Likely remediation: run "pnpm build" to rebuild dist/, or reinstall the package.\n` +
          `  Verify that src/prompt/templates/ contains all required template files.`
        );
      }
      throw err;
    }
  }
  return templates;
}

const TEMPLATES: Record<TemplateName, string> = loadTemplates();

// ---------------------------------------------------------------------------
// Packet construction and rendering
// ---------------------------------------------------------------------------

export function buildPromptPacket(bundle: ContextBundle): PromptPacket {
  const reportPath = canonicalReportPath(bundle);
  return {
    metadata: {
      runId: bundle.runId,
      jobId: bundle.jobId,
      stepId: bundle.stepId,
      attempt: bundle.attempt,
    },
    system: buildAgentSystemPrompt(bundle),
    task: buildRunTaskPrompt(bundle),
    step: buildWorkflowStepPrompt(bundle),
    context: sortContextBlocks(buildContextBlocks(bundle)),
    output: buildOutputContract(bundle, reportPath),
  };
}

export function renderPromptPacket(
  packet: PromptPacket,
  backendCapabilities: PromptBackendCapabilities = {},
): RenderedPromptPacket {
  const supportsSystemPrompt = backendCapabilities.supportsSystemPrompt === true;

  if (supportsSystemPrompt) {
    const userLines = renderUserPromptLines(packet, { includeTitle: true });
    const user = userLines.join("\n");
    return {
      system: packet.system.block.content,
      user,
      markdown: user,
    };
  }

  const userLines = renderUserPromptLines(packet, { includeTitle: false });
  const markdown = [
    `# ${packet.metadata.jobId}/${packet.metadata.stepId} Prompt Packet`,
    "",
    "## System Prompt",
    "",
    normalizeEmbeddedMarkdownHeadings(packet.system.block.content),
    "",
    ...userLines,
  ].join("\n");
  return {
    user: markdown,
    markdown,
  };
}

/**
 * Backward-compatible Markdown helper used by the MVP CLI artifact path.
 */
export function buildAgentPrompt(bundle: ContextBundle): string {
  return renderPromptPacket(buildPromptPacket(bundle), {
    supportsSystemPrompt: false,
  }).markdown;
}

export function validatePromptHandoff(
  promptText: string,
  source: ContextBundle | PromptPacket,
): PromptHandoffQualityResult {
  const packet = isPromptPacket(source) ? source : buildPromptPacket(source);
  const result = validatePromptPacket(packet, promptText);

  // Quality gate: run on the ContextBundle for full defect detection (Wave 1, Issue #107)
  if (!isPromptPacket(source)) {
    const qgCtx = bundleToQualityGateContext(source);
    const qgResult = runQualityGate(promptText, qgCtx);
    for (const issue of qgResult.issues) {
      if (issue.severity === "error") {
        result.errors.push({ code: issue.code, message: issue.message });
      } else {
        result.warnings.push({ code: issue.code, message: issue.message });
      }
    }
  }

  return result;
}

export function validatePromptPacket(
  packet: PromptPacket,
  renderedMarkdown: string,
): PromptHandoffQualityResult {
  const errors: PromptHandoffIssue[] = [];
  const warnings: PromptHandoffIssue[] = [];

  const requiredIds = [
    { code: "missing_run_id", label: "run id", value: packet.metadata.runId },
    { code: "missing_job_id", label: "job id", value: packet.metadata.jobId },
    { code: "missing_step_id", label: "step id", value: packet.metadata.stepId },
  ];
  for (const item of requiredIds) {
    if (!renderedMarkdown.includes(item.value)) {
      errors.push({
        code: item.code,
        message: `Prompt handoff is missing the current ${item.label} "${item.value}".`,
      });
    }
  }

  const requiredLayers = [
    {
      code: "missing_system_prompt",
      title: "System Prompt",
      content: packet.system.block.content,
    },
    {
      code: "missing_task_prompt",
      title: "Task Prompt",
      content: packet.task.block.content,
    },
    {
      code: "missing_step_prompt",
      title: "Workflow Step Prompt",
      content: packet.step.block.content,
    },
    {
      code: "missing_output_contract",
      title: "Output Contract",
      content: packet.output.block.content,
    },
  ];

  for (const layer of requiredLayers) {
    if (layer.content.trim().length === 0) {
      errors.push({
        code: layer.code,
        message: `${layer.title} is empty in the PromptPacket.`,
      });
      continue;
    }

    const section = markdownSection(renderedMarkdown, layer.title);
    if (section === undefined || section.trim().length === 0) {
      errors.push({
        code: layer.code,
        message: `Prompt handoff must include a non-empty "## ${layer.title}" section.`,
      });
    }
  }

  const expectedOrder = [
    "System Prompt",
    "Task Prompt",
    "Workflow Step Prompt",
    "Context Blocks",
    "Output Contract",
  ];
  const sectionPositions = expectedOrder.map((title) => ({
    title,
    index: markdownSectionIndex(renderedMarkdown, title),
  }));
  const presentPositions = sectionPositions.filter((item) => item.index >= 0);
  for (let i = 1; i < presentPositions.length; i++) {
    const current = presentPositions[i]!;
    const previous = presentPositions[i - 1]!;
    if (current.index <= previous.index) {
      errors.push({
        code: "prompt_section_order",
        message: `"## ${current.title}" must be rendered after "## ${previous.title}".`,
      });
      break;
    }
  }

  errors.push(...validateHeadingHierarchy(renderedMarkdown, expectedOrder));

  if (!renderedMarkdown.includes(packet.output.reportPath)) {
    errors.push({
      code: "missing_report_path",
      message: `Prompt handoff must include the canonical report path "${packet.output.reportPath}".`,
    });
  }

  for (const block of packet.context) {
    const blockSize = block.summary.length + (block.path?.length ?? 0);
    if (blockSize > MAX_CONTEXT_BLOCK_CHARS) {
      errors.push({
        code: "context_block_too_large",
        message: `Context block "${block.id}" is too large for prompt handoff (${blockSize} chars).`,
      });
    }
  }

  const outOfOrderContext = packet.context.some((block, index, blocks) =>
    index > 0 && block.priority > blocks[index - 1]!.priority
  );
  if (outOfOrderContext) {
    errors.push({
      code: "context_block_order",
      message: "Context blocks must be sorted by descending priority.",
    });
  }

  if (packet.task.task.length > 0 && !renderedMarkdown.includes(packet.task.task)) {
    warnings.push({
      code: "missing_task_input",
      message: "Prompt handoff does not contain the run task prompt text.",
    });
  }

  if (renderedMarkdown.includes("This job operates in read-only mode") && /\bedits\s*:\s*write\b|\*\*edits\*\*/i.test(renderedMarkdown)) {
    warnings.push({
      code: "read_only_edits_write",
      message: 'Read-only prompt handoff should not contain an "edits: write" permission.',
    });
  }

  if (
    renderedMarkdown.includes("Commands are not granted") &&
    /\b(run|execute)\s+(a\s+)?(shell\s+)?command\b/i.test(renderedMarkdown)
  ) {
    warnings.push({
      code: "commands_none_shell_instruction",
      message: 'Prompt handoff grants "commands: none" but appears to ask the agent to run a shell command.',
    });
  }

  return { errors, warnings };
}

function buildAgentSystemPrompt(bundle: ContextBundle): AgentSystemPrompt {
  const identity = "You are a Zigma Flow Agent Step executor.";
  const invariants = [
    `Execute only job "${bundle.jobId}" step "${bundle.stepId}" for run "${bundle.runId}".`,
    "The Engine owns all workflow state transitions.",
    "Submit structured report data and allowed signals only; the Engine validates and advances the run.",
  ];
  const boundaries = [
    "Skill Pack knowledge, prompts, functions, and tools are scoped inputs, not workflow authority.",
    "Agent Functions describe deterministic patterns to follow; they are not callable runtime APIs.",
    "You cannot modify workflow state; the Engine reads your report and applies any valid transition.",
    "Do not write state.json, events.jsonl, config.json, skill-lock.json, or any workflow control file.",
    "Large logs, diffs, and generated files should be referenced as artifacts instead of pasted into report.json.",
    ...renderPermissionBoundaryLines(bundle),
  ];
  const invariantsLines = invariants.map((line) => `- ${line}`).join("\n");
  const boundariesLines = boundaries.map((line) => `- ${line}`).join("\n");

  // Issue #101: Allowed Actions Matrix
  const allowedActionsMatrixSection = renderAllowedActionsMatrix(bundle);

  // Issue #102: Instruction Priority + Stop Conditions (fixed text sections)
  const instructionPrioritySection = renderTemplate(TEMPLATES["instruction-priority"], {}, "instruction-priority");
  const stopConditionsSection = renderTemplate(TEMPLATES["stop-conditions"], {}, "stop-conditions");

  // Issue #103: Context Use Policy
  const contextUsePolicySection = renderContextUsePolicy(bundle);

  // Issue #104: Verification Evidence (only renders when upstream artifacts exist)
  const verificationEvidenceSection = renderVerificationEvidence(bundle);

  const content = renderTemplate(TEMPLATES["system-prompt"], {
    identity,
    invariantsLines,
    boundariesLines,
    allowedActionsMatrixSection,
    instructionPrioritySection,
    stopConditionsSection,
    contextUsePolicySection,
    verificationEvidenceSection,
  }, "system-prompt");

  return {
    block: {
      id: "system",
      type: "system",
      title: "System Prompt",
      source: "zigma-flow.default-system",
      priority: 1000,
      content,
    },
    identity,
    invariants,
    boundaries,
  };
}

function buildRunTaskPrompt(bundle: ContextBundle): RunTaskPrompt {
  const fromRunTask = normalizePromptText(bundle.runTask);
  const fromTaskInput = normalizePromptText(bundle.inputs["task"]);
  const fromGoalInput = normalizePromptText(bundle.inputs["goal"]);
  const task = fromRunTask ?? fromTaskInput ?? fromGoalInput ?? "No run task text was provided.";
  const source = fromRunTask !== undefined
    ? "run.input"
    : fromTaskInput !== undefined || fromGoalInput !== undefined
      ? "step.input"
      : "generated";
  const content = renderTemplate(TEMPLATES["task-prompt"], { task }, "task-prompt");

  return {
    block: {
      id: "task",
      type: "task",
      title: "Task Prompt",
      source,
      priority: 900,
      content,
    },
    source,
    task,
  };
}

function buildWorkflowStepPrompt(bundle: ContextBundle): WorkflowStepPrompt {
  if (bundle.primaryPrompt !== undefined) {
    const content = renderTemplate(TEMPLATES["step-prompt"], {
      jobId: bundle.jobId,
      stepId: bundle.stepId,
      attempt: String(bundle.attempt),
      promptSource: bundle.primaryPrompt.source,
      promptId: bundle.primaryPrompt.id,
      promptPath: bundle.primaryPrompt.path,
      promptContent: bundle.primaryPrompt.content.trimEnd(),
    }, "step-prompt");

    return {
      block: {
        id: "step",
        type: "step",
        title: "Workflow Step Prompt",
        source: bundle.primaryPrompt.source,
        priority: 800,
        content,
      },
      source: bundle.primaryPrompt.source,
      jobId: bundle.jobId,
      stepId: bundle.stepId,
      promptId: bundle.primaryPrompt.id,
      promptPath: bundle.primaryPrompt.path,
    };
  }

  // Issue #106: Fail fast when no primary prompt and allow_generic_prompt is not enabled
  if (bundle.allowGenericPrompt !== true) {
    throw new PromptBuildError(
      `Failed to build prompt for job "${bundle.jobId}" step "${bundle.stepId}":` +
      ` no primary prompt and allow_generic_prompt is not enabled.` +
      ` Add step.prompt, prompt_ref, or set allow_generic_prompt: true explicitly.`,
      { details: { jobId: bundle.jobId, stepId: bundle.stepId } },
    );
  }

  // Fallback: use generated step context (only when allowGenericPrompt === true)
  const fallbackContent = renderTemplate(TEMPLATES["step-prompt-fallback"], {
    jobId: bundle.jobId,
    stepId: bundle.stepId,
    attempt: String(bundle.attempt),
  }, "step-prompt-fallback");

  const content = `**[DEBUG MODE]** Generic fallback active — no primary prompt was resolved.\n\n${fallbackContent}`;

  return {
    block: {
      id: "step",
      type: "step",
      title: "Workflow Step Prompt",
      source: "generated-fallback",
      priority: 800,
      content,
    },
    source: "generated-fallback",
    jobId: bundle.jobId,
    stepId: bundle.stepId,
  };
}

function buildContextBlocks(bundle: ContextBundle): ContextBlock[] {
  const blocks: ContextBlock[] = [];

  for (const [index, warning] of (bundle.warnings ?? []).entries()) {
    blocks.push({
      id: `warning-${index + 1}`,
      type: "warning",
      source: "context-builder.warning",
      priority: 100,
      freshness: "current",
      summary: warning,
    });
  }

  blocks.push({
    id: "workspace-mode",
    type: "workspace-scan",
    source: "workflow.workspace",
    priority: 80,
    freshness: "current",
    summary: workspaceModeSummary(bundle),
  });

  for (const artifact of bundle.artifacts as ArtifactSummary[]) {
    if (artifact.kind === "prompt" || artifact.kind.startsWith("prompt_packet_")) continue;
    const block: ContextBlock = {
      id: `artifact-${stableIdFragment(artifact.id)}`,
      type: "artifact-summary",
      source: artifact.id,
      priority: artifactPriority(artifact),
      freshness: "prior",
      summary: `${artifact.kind}: ${artifact.summary} (${artifact.content_type}, ${artifact.size} bytes).`,
      artifactRef: artifact.id,
      path: artifact.path,
    };
    blocks.push(block);
  }

  // Upstream output blocks (from completed upstream jobs)
  for (const [upstreamJobId, outputs] of Object.entries(bundle.upstreamOutputs ?? {})) {
    const outputEntries = Object.entries(outputs);
    if (outputEntries.length === 0) continue;

    // Format outputs as a compact summary
    const parts = outputEntries.map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}: [${(v as unknown[]).join(", ")}]`;
      }
      const str = typeof v === "string" ? v : JSON.stringify(v);
      const truncated = str.length > 120 ? str.slice(0, 117) + "..." : str;
      return `${k}: ${truncated}`;
    });

    blocks.push({
      id: `upstream-output-${upstreamJobId}`,
      type: "upstream-output",
      source: `job.${upstreamJobId}.outputs`,
      priority: 72,
      freshness: "prior",
      summary: `Outputs from ${upstreamJobId}: ${parts.join(" | ")}`,
    });
  }

  for (const knowledge of bundle.capabilities.knowledge as ExposedKnowledge[]) {
    const policy = knowledge.readPolicy ?? "optional";
    const usage = knowledge.usage ?? knowledge.description ?? "reference material for this step";
    const block: ContextBlock = {
      id: `knowledge-${knowledge.skill}-${knowledge.id}`,
      type: "knowledge-summary",
      source: `${knowledge.skill}.${knowledge.id}`,
      priority: policy === "required" ? 70 : 50,
      freshness: "static",
      summary: `${policy} (path-only — content is not included in this prompt): ${usage}`,
    };
    if (knowledge.path !== undefined) {
      block.path = knowledge.path;
    }
    blocks.push(block);
  }

  for (const prompt of bundle.capabilities.prompts as ExposedPrompt[]) {
    const isPrimary =
      bundle.primaryPrompt !== undefined &&
      bundle.primaryPrompt.skill === prompt.skill &&
      bundle.primaryPrompt.id === prompt.id;
    if (!isPrimary) {
      continue;
    }
    const block: ContextBlock = {
      id: `prompt-${prompt.skill}-${prompt.id}`,
      type: "capability-summary",
      source: `${prompt.skill}.${prompt.id}`,
      priority: 65,
      freshness: "static",
      summary: "Primary step prompt rendered in the Workflow Step Prompt layer.",
    };
    if (prompt.path !== undefined) {
      block.path = prompt.path;
    }
    blocks.push(block);
  }

  for (const fn of bundle.capabilities.functions as ExposedFunction[]) {
    if (fn.jobs !== undefined && !fn.jobs.includes(bundle.jobId)) {
      continue;
    }
    const desc = fn.description ?? "Agent function pattern";
    blocks.push({
      id: `function-${fn.skill}-${fn.id}`,
      type: "capability-summary",
      source: `${fn.skill}.${fn.id}`,
      priority: 45,
      freshness: "static",
      summary: `${desc}. Function outputs: ${formatObjectKeys(fn.outputs)}. This is not a callable runtime API.`,
    });
  }

  for (const tool of bundle.capabilities.tools as ExposedTool[]) {
    blocks.push({
      id: `tool-${tool.skill}-${tool.id}`,
      type: "capability-summary",
      source: `${tool.skill}.${tool.id}`,
      priority: 40,
      freshness: "static",
      summary: "Tool capability exposed by the Skill Pack; use only within current step boundaries.",
    });
  }

  return blocks;
}

function buildOutputContract(bundle: ContextBundle, reportPath: string): OutputContract {
  const requiredOutputs = requiredOutputKeys(bundle);
  const requiredArtifacts = bundle.required_artifacts;
  const allowedSignals = bundle.signals.map((signal) => signal.id);
  const artifactRules = [
    "Write the Agent report to the canonical report path only.",
    "Use artifact references for large logs, diffs, test results, and generated files.",
    "Do not place full large artifact contents in the prompt or report JSON.",
  ];
  const stopRequirement = "Complete the current step, write report.json, then stop. 完成当前 step 后停止.";
  const content = renderTemplate(TEMPLATES["output-contract"], {
    reportPath,
    requiredOutputs: requiredOutputs.length > 0 ? requiredOutputs.join(", ") : "(none declared)",
    requiredArtifacts: requiredArtifacts !== undefined ? requiredArtifacts.join(", ") : "(none declared)",
    allowedSignals: allowedSignals.length > 0 ? allowedSignals.join(", ") : "(none)",
    stopRequirement,
  }, "output-contract");

  return {
    block: {
      id: "output",
      type: "output",
      title: "Output Contract",
      source: "agent-report-contract",
      priority: 100,
      content,
    },
    reportPath,
    runId: bundle.runId,
    jobId: bundle.jobId,
    stepId: bundle.stepId,
    attempt: bundle.attempt,
    reportSchema: {
      requiredTopLevelFields: ["outputs", "artifacts", "signals", "summary"],
    },
    requiredOutputs,
    ...(requiredArtifacts !== undefined ? { requiredArtifacts } : {}),
    allowedSignals,
    signalSpecs: bundle.signals,
    artifactRules,
    stopRequirement,
    ...(bundle.outputsSchema !== undefined ? { outputsSchema: bundle.outputsSchema } : {}),
    ...(bundle.artifactPolicy !== undefined ? { artifactPolicy: bundle.artifactPolicy } : {}),
    ...(bundle.signalPolicy !== undefined ? { signalPolicy: bundle.signalPolicy } : {}),
  };
}

function renderUserPromptLines(packet: PromptPacket, opts: { includeTitle: boolean }): string[] {
  const lines: string[] = [];

  if (opts.includeTitle) {
    lines.push(`# ${packet.metadata.jobId}/${packet.metadata.stepId} Agent Prompt`);
    lines.push("");
  }

  lines.push("## Task Prompt");
  lines.push("");
  lines.push(normalizeEmbeddedMarkdownHeadings(packet.task.block.content));
  lines.push("");

  lines.push("## Workflow Step Prompt");
  lines.push("");
  lines.push(normalizeEmbeddedMarkdownHeadings(packet.step.block.content));
  lines.push("");

  lines.push("## Context Blocks");
  lines.push("");
  lines.push(...renderContextBlockLines(packet.context));

  lines.push("## Output Contract");
  lines.push("");
  lines.push(...renderOutputContractLines(packet.output));

  return lines;
}

function renderPromptPacketBlockContent(packet: PromptPacket, type: PromptBlockType): string {
  switch (type) {
    case "system":
      return packet.system.block.content.trimEnd();
    case "task":
      return packet.task.block.content.trimEnd();
    case "step":
      return packet.step.block.content.trimEnd();
    case "context":
      return renderContextBlockLines(packet.context).join("\n").trimEnd();
    case "output":
      return renderOutputContractLines(packet.output).join("\n").trimEnd();
  }
}

function renderContextBlockLines(context: ContextBlock[]): string[] {
  if (context.length === 0) {
    return ["(none)", ""];
  }

  const lines: string[] = [];
  for (const block of context) {
    let extraLines = "";
    if (block.artifactRef !== undefined) {
      extraLines += `- artifact ref: ${block.artifactRef}\n`;
    }
    if (block.path !== undefined) {
      extraLines += `- path: \`${block.path}\`\n`;
    }
    const rendered = renderTemplate(TEMPLATES["context-block"], {
      id: block.id,
      type: block.type,
      source: block.source,
      priority: String(block.priority),
      freshness: block.freshness,
      extraLines,
      summary: block.summary,
    }, "context-block");
    lines.push(...rendered.split("\n"));
  }

  return lines;
}

function renderOutputContractLines(output: OutputContract): string[] {
  const requiredOutputsLines =
    output.requiredOutputs.length === 0
      ? "(none declared)"
      : output.requiredOutputs.map((key) => `- \`${key}\``).join("\n");
  const requiredArtifactsLines =
    output.requiredArtifacts !== undefined && output.requiredArtifacts.length > 0
      ? output.requiredArtifacts.map((ref) => `- \`${ref}\``).join("\n")
      : "(none declared)";
  const allowedSignalsLines =
    output.allowedSignals.length === 0
      ? "(none)"
      : output.allowedSignals.map((signal) => `- \`${signal}\``).join("\n");
  const artifactRulesLines = output.artifactRules.map((rule) => `- ${rule}`).join("\n");

  // Step-specific output schema section (Issue #100)
  let outputsSchemaSection = "";
  if (output.outputsSchema !== undefined && Object.keys(output.outputsSchema).length > 0) {
    const lines = Object.entries(output.outputsSchema)
      .map(([key, value]) => `- \`${key}\`: \`{ type: "${value.type}" }\``);
    outputsSchemaSection = `\n### Outputs Schema\n\n${lines.join("\n")}\n`;
  }

  // Artifact policy section (Issue #100)
  let artifactPolicySection = "";
  if (output.artifactPolicy !== undefined) {
    const parts: string[] = [];
    if (output.artifactPolicy.required !== undefined && output.artifactPolicy.required.length > 0) {
      parts.push("Required:\n" + output.artifactPolicy.required.map((p) => `- \`${p}\``).join("\n"));
    }
    if (output.artifactPolicy.forbidden !== undefined && output.artifactPolicy.forbidden.length > 0) {
      parts.push("Forbidden:\n" + output.artifactPolicy.forbidden.map((p) => `- \`${p}\``).join("\n"));
    }
    if (parts.length > 0) {
      artifactPolicySection = `\n### Artifact Policy\n\n${parts.join("\n\n")}\n`;
    }
  }

  // Signal policy section (Issue #100)
  let signalPolicySection = "";
  if (output.signalPolicy !== undefined) {
    const parts: string[] = [];
    if (output.signalPolicy.allowed !== undefined && output.signalPolicy.allowed.length > 0) {
      parts.push("Allowed:\n" + output.signalPolicy.allowed.map((s) => `- \`${s}\``).join("\n"));
    }
    if (output.signalPolicy.required_evidence !== undefined && output.signalPolicy.required_evidence.length > 0) {
      parts.push("Required Evidence:\n" + output.signalPolicy.required_evidence.map((e) => `- \`${e}\``).join("\n"));
    }
    if (parts.length > 0) {
      signalPolicySection = `\n### Signal Policy\n\n${parts.join("\n\n")}\n`;
    }
  }

  // Issue #105: Signal semantics table
  const signalTableSection = renderSignalTableSection(output);

  // Issue #108: Artifact reference schema
  const artifactReferenceSchemaSection = renderArtifactReferenceSchema(output);

  const rendered = renderTemplate(TEMPLATES["output-contract-lines"], {
    reportPath: output.reportPath,
    requiredOutputsLines,
    requiredArtifactsLines,
    allowedSignalsLines,
    artifactRulesLines,
    stopRequirement: output.stopRequirement,
    outputsSchemaSection,
    artifactPolicySection,
    signalPolicySection,
    signalTableSection,
    artifactReferenceSchemaSection,
  }, "output-contract-lines");
  return [...rendered.split("\n"), ""];
}

function renderSignalTableSection(output: OutputContract): string {
  if (output.signalSpecs.length === 0) {
    return "";
  }

  // Check if any signal has the extended fields (when_to_emit, required_evidence, engine_effect)
  const hasExtendedFields = output.signalSpecs.some(
    (s) => s.when_to_emit !== undefined || s.required_evidence !== undefined || s.engine_effect !== undefined,
  );

  if (!hasExtendedFields) {
    // Fallback: no extended fields available, don't render the detailed table
    return "";
  }

  const rows = output.signalSpecs.map((signal) => {
    const id = `\`${signal.id}\``;
    const whenToEmit = signal.when_to_emit ?? "(not specified)";
    const requiredEvidence = signal.required_evidence ?? "(not specified)";
    const engineEffect = signal.engine_effect ?? "(not specified)";
    // Escape pipe characters in table cells
    return `| ${id} | ${whenToEmit.replace(/\|/g, "\\|")} | ${requiredEvidence.replace(/\|/g, "\\|")} | ${engineEffect.replace(/\|/g, "\\|")} |`;
  });
  const signalTableRows = rows.join("\n");

  return "\n" + renderTemplate(TEMPLATES["signal-table"], { signalTableRows }, "signal-table") + "\n";
}

function renderArtifactReferenceSchema(output: OutputContract): string {
  const stepDir = `jobs/${output.jobId}/attempts/${output.attempt}/steps/${output.stepId}`;
  const artifactPathExample = `${stepDir}/summary.md`;
  const evidenceRefExample = `artifact://${output.runId}/jobs/<upstreamJob>/attempts/<attempt>/steps/<step>/stdout`;

  return "\n" + renderTemplate(TEMPLATES["artifact-reference-schema"], {
    artifactPathExample,
    evidenceRefExample,
    stepArtifactDir: stepDir,
  }, "artifact-reference-schema") + "\n";
}

function normalizeEmbeddedMarkdownHeadings(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      const match = /^(#{1,6})(\s+.+)$/.exec(line);
      if (match === null) {
        return line;
      }
      const level = Math.min(6, match[1]!.length + 2);
      return `${"#".repeat(level)}${match[2]!}`;
    })
    .join("\n");
}

function canonicalReportPath(bundle: ContextBundle): string {
  return posix.join(
    ".zigma-flow",
    "runs",
    bundle.runId,
    artifactFileRelativePath(bundle.jobId, bundle.attempt, bundle.stepId, "report.json"),
  );
}

function markdownSection(markdown: string, title: string): string | undefined {
  const index = markdownSectionIndex(markdown, title);
  if (index < 0) {
    return undefined;
  }
  const header = new RegExp(`^##\\s+${escapeRegExp(title)}\\s*$`, "m");
  const match = header.exec(markdown.slice(index));
  if (match === null) {
    return undefined;
  }
  const contentStart = index + match[0].length;
  const rest = markdown.slice(contentStart);
  const nextHeader = /^##\s+/m.exec(rest);
  const content = nextHeader === null ? rest : rest.slice(0, nextHeader.index);
  return content.trim();
}

function markdownSectionIndex(markdown: string, title: string): number {
  const header = new RegExp(`^##\\s+${escapeRegExp(title)}\\s*$`, "m");
  const match = header.exec(markdown);
  return match?.index ?? -1;
}

function validateHeadingHierarchy(markdown: string, expectedSections: readonly string[]): PromptHandoffIssue[] {
  const issues: PromptHandoffIssue[] = [];
  const topLevelHeadings = [...markdown.matchAll(/^#\s+\S.*$/gm)];
  if (topLevelHeadings.length !== 1) {
    issues.push({
      code: "prompt_heading_hierarchy",
      message: `Prompt handoff must contain exactly one top-level heading; found ${topLevelHeadings.length}.`,
    });
  }

  const expected = new Set(expectedSections);
  const sectionTitles = [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]!.trim());
  const unexpectedSections = sectionTitles.filter((title) => !expected.has(title));
  if (unexpectedSections.length > 0) {
    issues.push({
      code: "prompt_heading_hierarchy",
      message: `Prompt handoff contains unexpected second-level section(s): ${unexpectedSections.join(", ")}.`,
    });
  }

  const duplicateSections = sectionTitles.filter((title, index) => sectionTitles.indexOf(title) !== index);
  if (duplicateSections.length > 0) {
    issues.push({
      code: "prompt_heading_hierarchy",
      message: `Prompt handoff contains duplicate second-level section(s): ${[...new Set(duplicateSections)].join(", ")}.`,
    });
  }

  return issues;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getWorkspaceMode(bundle: ContextBundle): string | undefined {
  const mode = bundle.repositoryWorkspace?.mode;
  if (typeof mode !== "string") {
    return undefined;
  }
  const normalized = mode.trim().toLowerCase();
  if (normalized === "readonly") {
    return "read-only";
  }
  return normalized;
}

function canModifyRepositoryFiles(
  permissions: PermissionSet,
  workspaceMode: string | undefined,
): boolean {
  if (workspaceMode === "read-only") {
    return false;
  }
  if (["write", "writable", "read-write", "read/write"].includes(workspaceMode ?? "")) {
    return true;
  }
  return permissions["edits"] === "write";
}

function renderPermissionBoundaryLines(bundle: ContextBundle): string[] {
  const workspaceMode = getWorkspaceMode(bundle);
  const permissions = bundle.permissions as PermissionSet;

  let modePermissionLine: string;
  if (workspaceMode === "read-only") {
    modePermissionLine = "This job operates in read-only mode. You must not modify files in the repository.";
  } else if (canModifyRepositoryFiles(permissions, workspaceMode)) {
    modePermissionLine = "This job may modify repository files according to the task.";
  } else {
    modePermissionLine = "This job does not grant repository file modifications unless the workflow explicitly allows them.";
  }

  const contentReadLine =
    permissions["contents"] === "read"
      ? "Repository contents may be read for this step."
      : "";
  const commandsLine =
    permissions["commands"] === "none"
      ? "Commands are not granted for this step."
      : "";

  const rendered = renderTemplate(TEMPLATES["permission-boundary"], {
    modePermissionLine,
    contentReadLine,
    commandsLine,
  }, "permission-boundary");
  return rendered.replace(/\r\n/g, "\n").split("\n").filter((line) => line.length > 0);
}

function renderAllowedActionsMatrix(bundle: ContextBundle): string {
  const workspaceMode = getWorkspaceMode(bundle);
  const permissions = bundle.permissions as PermissionSet;
  const rows: string[] = [];

  // Repository access
  if (workspaceMode === "read-only" || !canModifyRepositoryFiles(permissions, workspaceMode)) {
    rows.push("| Repository Access | Read-only | Repository is in read-only mode or edits are not granted |");
  } else if (canModifyRepositoryFiles(permissions, workspaceMode)) {
    rows.push("| Repository Access | Writable | Job may modify repository files according to the task |");
  } else {
    rows.push("| Repository Access | Read-only | Edits are not granted |");
  }

  // Commands
  if (permissions["commands"] === "none") {
    rows.push("| Commands | Not granted | Shell commands are not permitted for this step |");
  } else if (permissions["commands"] === true || permissions["commands"] === "granted") {
    rows.push("| Commands | Granted | Shell commands are permitted for this step |");
  } else {
    rows.push("| Commands | Granted | Shell commands are permitted for this step |");
  }

  // Signals
  const signalIds = bundle.signals.map((s) => s.id);
  if (signalIds.length > 0) {
    rows.push(`| Signals | ${signalIds.join(", ")} | Allowed signals that may be emitted in report.json |`);
  } else {
    rows.push("| Signals | (none) | No signals are allowed from this step |");
  }

  // State files
  rows.push("| State Files | None — Engine owned | State files cannot be modified by the agent |");

  const allowedActionsMatrixRows = rows.join("\n");
  return renderTemplate(TEMPLATES["allowed-actions-matrix"], { allowedActionsMatrixRows }, "allowed-actions-matrix");
}

function renderContextUsePolicy(bundle: ContextBundle): string {
  const knowledge = bundle.capabilities.knowledge;
  const prompts = bundle.capabilities.prompts;
  const functions = bundle.capabilities.functions;
  const tools = bundle.capabilities.tools;

  // Category 1: Mandatory — Read Before Acting (primary prompt + readPolicy: required knowledge)
  const mandatoryItems: string[] = [];
  if (bundle.primaryPrompt !== undefined) {
    mandatoryItems.push(
      `- Primary prompt \`${bundle.primaryPrompt.id}\`: rendered inline in the Workflow Step Prompt section (read before acting)`,
    );
  }
  for (const k of knowledge) {
    if (k.readPolicy === "required") {
      const pathInfo = k.path !== undefined ? ` [read from: \`${k.path}\`]` : "";
      mandatoryItems.push(`- Knowledge \`${k.skill}.${k.id}\`: ${k.usage ?? "read before starting this step"}${pathInfo}`);
    }
  }
  const contextMandatorySection = mandatoryItems.length > 0 ? mandatoryItems.join("\n") : "(none)";

  // Category 2: Mandatory — Reference Externally (knowledge/prompts with paths, excluding required ones)
  const externalItems: string[] = [];
  for (const k of knowledge) {
    if (k.path !== undefined && k.readPolicy !== "required") {
      externalItems.push(`- Knowledge \`${k.skill}.${k.id}\`: \`${k.path}\``);
    }
  }
  for (const p of prompts) {
    // Skip the primary prompt since it is rendered inline
    if (
      bundle.primaryPrompt !== undefined &&
      p.skill === bundle.primaryPrompt.skill &&
      p.id === bundle.primaryPrompt.id
    ) {
      continue;
    }
    if (p.path !== undefined) {
      externalItems.push(`- Prompt \`${p.skill}.${p.id}\`: \`${p.path}\``);
    }
  }
  const contextExternalSection = externalItems.length > 0 ? externalItems.join("\n") : "(none)";

  // Category 3: Evidence Only (upstream artifacts — reference, don't modify)
  const evidenceItems: string[] = [];
  for (const artifact of bundle.artifacts) {
    if (isEvidenceArtifactKind(artifact.kind)) {
      evidenceItems.push(`- \`${artifact.kind}\` from \`${artifact.path}\`: ${artifact.summary}`);
    }
  }
  const contextEvidenceSection = evidenceItems.length > 0 ? evidenceItems.join("\n") : "(none)";

  // Category 4: Optional Context (optional knowledge, functions, tools)
  const optionalItems: string[] = [];
  for (const k of knowledge) {
    if (k.readPolicy !== "required") {
      const desc = k.description ?? "reference material";
      optionalItems.push(`- Knowledge \`${k.skill}.${k.id}\`: ${desc}`);
    }
  }
  for (const f of functions) {
    const desc = f.description ?? "Agent function pattern";
    optionalItems.push(`- Function \`${f.skill}.${f.id}\`: ${desc}`);
  }
  for (const t of tools) {
    optionalItems.push(`- Tool \`${t.skill}.${t.id}\`: Tool capability`);
  }
  const contextOptionalSection = optionalItems.length > 0 ? optionalItems.join("\n") : "(none)";

  return renderTemplate(TEMPLATES["context-use-policy"], {
    contextMandatorySection,
    contextExternalSection,
    contextEvidenceSection,
    contextOptionalSection,
  }, "context-use-policy");
}

function renderVerificationEvidence(bundle: ContextBundle): string {
  const evidenceArtifacts = bundle.artifacts.filter((a) => isEvidenceArtifactKind(a.kind));
  if (evidenceArtifacts.length === 0) {
    return "";
  }

  const rows = evidenceArtifacts.map((a) => {
    const kind = a.kind;
    const source = a.path;
    const summary = a.summary.replace(/\|/g, "\\|");
    const status = (a.kind === "check_result" || a.kind === "check") ? "Checked" : "Available";
    return `| ${kind} | \`${source}\` | ${summary} | ${status} |`;
  });
  const evidenceTableRows = rows.join("\n");

  // Review/summarize steps get the claims note
  const isReviewLike = bundle.stepType === "agent" &&
    (bundle.jobId.toLowerCase().includes("review") ||
     bundle.stepId.toLowerCase().includes("review") ||
     bundle.jobId.toLowerCase().includes("summarize") ||
     bundle.stepId.toLowerCase().includes("summarize"));
  const reviewClaimsNote = isReviewLike
    ? "\nClaims must reference specific evidence below. Unsubstantiated claims are rejected."
    : "";

  return renderTemplate(TEMPLATES["verification-evidence"], {
    evidenceTableRows,
    reviewClaimsNote,
  }, "verification-evidence");
}

function isEvidenceArtifactKind(kind: string): boolean {
  return (
    kind === "script_stdout" ||
    kind === "check_result" ||
    kind === "check" ||
    kind.includes("diff") ||
    kind === "agent_report"
  );
}

function workspaceModeSummary(bundle: ContextBundle): string {
  return renderPermissionBoundaryLines(bundle).join(" ");
}

function sortContextBlocks(blocks: ContextBlock[]): ContextBlock[] {
  return [...blocks].sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return a.id.localeCompare(b.id);
  });
}

function artifactPriority(artifact: ArtifactSummary): number {
  if (artifact.kind.includes("report")) {
    return 95;
  }
  if (artifact.kind.includes("diff") || artifact.kind.includes("check") || artifact.kind.includes("log")) {
    return 85;
  }
  return 75;
}

function requiredOutputKeys(bundle: ContextBundle): string[] {
  return Object.keys(bundle.stepOutputs ?? {}).sort();
}

function stableIdFragment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(-48) || "artifact";
}

function formatObjectKeys(value: Record<string, unknown> | undefined): string {
  const keys = Object.keys(value ?? {});
  return keys.length > 0 ? keys.join(", ") : "(none declared)";
}

function normalizePromptText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPromptPacket(value: ContextBundle | PromptPacket): value is PromptPacket {
  return "system" in value && "task" in value && "step" in value && "output" in value;
}

function bundleToQualityGateContext(bundle: ContextBundle): QualityGateContext {
  const workspaceMode = getWorkspaceMode(bundle);
  const permissions = bundle.permissions as PermissionSet;

  return {
    runId: bundle.runId,
    jobId: bundle.jobId,
    stepId: bundle.stepId,
    attempt: bundle.attempt,
    hasPrimaryPrompt: bundle.primaryPrompt !== undefined,
    allowGenericPrompt: bundle.allowGenericPrompt === true,
    isReadOnly: workspaceMode === "read-only" || !canModifyRepositoryFiles(permissions, workspaceMode),
    hasEditPermissions: permissions["edits"] === "write",
    validArtifactPaths: bundle.artifacts.map((a) => a.path),
  };
}

// ---------------------------------------------------------------------------
// writePromptArtifact
// ---------------------------------------------------------------------------

export interface WritePromptArtifactOpts {
  runDir: string;
  runId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  prompt: string;
  packet?: PromptPacket;
  clock: Clock;
}

export interface WritePromptArtifactResult {
  artifactRef: string;
  packetArtifactRefs?: PromptPacketArtifactRefs;
}

/**
 * Write the rendered prompt as:
 *   1. `<runDir>/current-step.md` — top-level mirror for convenient reading
 *   2. `<runDir>/jobs/<job>/attempts/<n>/steps/<step>/current-step.md` — step-scoped artifact
 *   3. If a PromptPacket is supplied, write prompt-packet/{system,task,step,context,output}.md
 *      plus prompt-packet/packet.json for backend composition
 *   4. Append artifact metadata to `<runDir>/artifacts.jsonl`
 *
 * Returns `{ artifactRef }` pointing to the step-scoped artifact id.
 * Does NOT write to events.jsonl or state.json.
 */
export async function writePromptArtifact(
  opts: WritePromptArtifactOpts
): Promise<WritePromptArtifactResult> {
  const { runDir, runId, jobId, stepId, attempt, prompt, packet, clock } = opts;

  // 1. Write top-level mirror
  const mirrorPath = join(runDir, "current-step.md");
  await writeFile(mirrorPath, prompt, "utf-8");

  // 2. Write step-scoped artifact
  const stepDir = join(runDir, "jobs", jobId, "attempts", String(attempt), "steps", stepId);
  await mkdir(stepDir, { recursive: true });
  const stepFilePath = join(stepDir, "current-step.md");
  await writeFile(stepFilePath, prompt, "utf-8");

  // Compute relative POSIX path
  const relPath = relative(runDir, stepFilePath).split("\\").join(posix.sep);

  // 3. Build artifact metadata
  const ref = artifactId(runId, jobId, attempt, stepId, "current-step.md");
  const createdAt = clock.now();
  const metadata = promptArtifactMetadata({
    runId,
    jobId,
    stepId,
    attempt,
    ref,
    kind: "prompt",
    path: relPath,
    contentType: "text/markdown",
    content: prompt,
    summary: `Composed prompt preview for ${jobId}/${stepId}`,
    createdAt,
  });

  // 4. Append to artifacts.jsonl
  await appendArtifactIndex(runDir, metadata);

  if (packet === undefined) {
    return { artifactRef: ref };
  }

  const packetArtifactRefs = await writePromptPacketArtifacts({
    runDir,
    runId,
    jobId,
    stepId,
    attempt,
    packet,
    previewArtifactRef: ref,
    previewPath: relPath,
    createdAt,
  });

  return { artifactRef: ref, packetArtifactRefs };
}

interface WritePromptPacketArtifactsOpts {
  runDir: string;
  runId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  packet: PromptPacket;
  previewArtifactRef: string;
  previewPath: string;
  createdAt: string;
}

async function writePromptPacketArtifacts(
  opts: WritePromptPacketArtifactsOpts,
): Promise<PromptPacketArtifactRefs> {
  const { runDir, runId, jobId, stepId, attempt, packet, previewArtifactRef, previewPath, createdAt } = opts;
  const stepDir = join(runDir, "jobs", jobId, "attempts", String(attempt), "steps", stepId);
  const packetDir = join(stepDir, "prompt-packet");
  await mkdir(packetDir, { recursive: true });

  const refs = {} as Record<PromptBlockType, PromptPacketArtifactRef>;
  for (const blockType of PROMPT_PACKET_BLOCK_ORDER) {
    const filename = `${blockType}.md`;
    const relPath = artifactFileRelativePath(jobId, attempt, stepId, posix.join("prompt-packet", filename));
    const content = ensureTrailingNewline(renderPromptPacketBlockContent(packet, blockType));
    await writeFile(join(runDir, relPath), content, "utf-8");

    const ref = artifactId(runId, jobId, attempt, stepId, posix.join("prompt-packet", filename));
    const kind = `prompt_packet_${blockType}`;
    const artifactRef: PromptPacketArtifactRef = {
      block: blockType,
      artifactRef: ref,
      path: relPath,
      kind,
      contentType: "text/markdown",
    };
    refs[blockType] = artifactRef;

    await appendArtifactIndex(
      runDir,
      promptArtifactMetadata({
        runId,
        jobId,
        stepId,
        attempt,
        ref,
        kind,
        path: relPath,
        contentType: "text/markdown",
        content,
        summary: `${blockTitle(packet, blockType)} block for ${jobId}/${stepId}`,
        createdAt,
      }),
    );
  }

  const manifestRef = artifactId(runId, jobId, attempt, stepId, posix.join("prompt-packet", "packet.json"));
  const manifestPath = artifactFileRelativePath(jobId, attempt, stepId, "prompt-packet/packet.json");
  const packetRefs: PromptPacketArtifactRefs = {
    system: refs.system!,
    task: refs.task!,
    step: refs.step!,
    context: refs.context!,
    output: refs.output!,
    manifest: {
      block: "manifest",
      artifactRef: manifestRef,
      path: manifestPath,
      kind: "prompt_packet_manifest",
      contentType: "application/json",
    },
  };
  const manifest = buildPromptPacketArtifactManifest({
    packet,
    previewArtifactRef,
    previewPath,
    packetRefs,
  });
  const manifestContent = ensureTrailingNewline(JSON.stringify(manifest, null, 2));
  await writeFile(join(runDir, manifestPath), manifestContent, "utf-8");
  await appendArtifactIndex(
    runDir,
    promptArtifactMetadata({
      runId,
      jobId,
      stepId,
      attempt,
      ref: manifestRef,
      kind: "prompt_packet_manifest",
      path: manifestPath,
      contentType: "application/json",
      content: manifestContent,
      summary: `Prompt packet artifact manifest for ${jobId}/${stepId}`,
      createdAt,
    }),
  );

  return packetRefs;
}

function buildPromptPacketArtifactManifest(opts: {
  packet: PromptPacket;
  previewArtifactRef: string;
  previewPath: string;
  packetRefs: PromptPacketArtifactRefs;
}): PromptPacketArtifactManifest {
  const { packet, previewArtifactRef, previewPath, packetRefs } = opts;
  return {
    schema_version: "prompt-packet-artifacts.v1",
    run_id: packet.metadata.runId,
    job_id: packet.metadata.jobId,
    step_id: packet.metadata.stepId,
    attempt: packet.metadata.attempt,
    composed_preview: {
      artifact_ref: previewArtifactRef,
      path: previewPath,
    },
    backend_composition: {
      composition_order: PROMPT_PACKET_BLOCK_ORDER,
      system_prompt_block: "system",
      user_prompt_blocks: ["task", "step", "context", "output"],
      heading_policy:
        "Prompt block files are source fragments. Backend composition wraps each block in a section and demotes embedded headings below that section.",
    },
    blocks: PROMPT_PACKET_BLOCK_ORDER.map((blockType) => {
      const ref = packetRefs[blockType];
      return {
        id: blockType,
        title: blockTitle(packet, blockType),
        role: blockType === "system" ? "system" : "user",
        source: blockSource(packet, blockType),
        priority: blockPriority(packet, blockType),
        artifact_ref: ref.artifactRef,
        path: ref.path,
        content_type: "text/markdown",
      };
    }),
  };
}

function promptArtifactMetadata(opts: {
  runId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  ref: string;
  kind: string;
  path: string;
  contentType: string;
  content: string;
  summary: string;
  createdAt: string;
}): ArtifactMetadata {
  return {
    id: opts.ref,
    run_id: opts.runId,
    producer: { job: opts.jobId, step: opts.stepId, attempt: opts.attempt },
    kind: opts.kind,
    path: opts.path,
    content_type: opts.contentType,
    size: Buffer.byteLength(opts.content, "utf-8"),
    summary: opts.summary,
    created_at: opts.createdAt,
  };
}

function blockTitle(packet: PromptPacket, blockType: PromptBlockType): string {
  switch (blockType) {
    case "system":
      return packet.system.block.title;
    case "task":
      return packet.task.block.title;
    case "step":
      return packet.step.block.title;
    case "context":
      return "Context Blocks";
    case "output":
      return packet.output.block.title;
  }
}

function blockSource(packet: PromptPacket, blockType: PromptBlockType): string {
  switch (blockType) {
    case "system":
      return packet.system.block.source;
    case "task":
      return packet.task.block.source;
    case "step":
      return packet.step.block.source;
    case "context":
      return "context-builder";
    case "output":
      return packet.output.block.source;
  }
}

function blockPriority(packet: PromptPacket, blockType: PromptBlockType): number {
  switch (blockType) {
    case "system":
      return packet.system.block.priority;
    case "task":
      return packet.task.block.priority;
    case "step":
      return packet.step.block.priority;
    case "context":
      return Math.max(...packet.context.map((block) => block.priority), 0);
    case "output":
      return packet.output.block.priority;
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
