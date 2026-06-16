/**
 * Prompt Builder — renders a ContextBundle into a Markdown agent prompt
 * and writes it as an artifact.
 *
 * Reference: docs/phases/p5-context-prompt/workflows/wf-p5-prompt/
 * WF-P5-PROMPT Step 2.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { posix, relative } from "node:path";

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

export interface PromptHandoffIssue {
  code: string;
  message: string;
}

export interface PromptHandoffQualityResult {
  errors: PromptHandoffIssue[];
  warnings: PromptHandoffIssue[];
}

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
  reportSchema: {
    requiredTopLevelFields: ["outputs", "artifacts", "signals", "summary"];
  };
  requiredOutputs: string[];
  allowedSignals: string[];
  artifactRules: string[];
  stopRequirement: string;
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
  return validatePromptPacket(packet, promptText);
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
    "You cannot modify workflow state directly.",
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
  const content = [
    identity,
    "",
    "Global invariants:",
    ...invariants.map((line) => `- ${line}`),
    "",
    "Capability and permission boundaries:",
    ...boundaries.map((line) => `- ${line}`),
  ].join("\n");

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
  const content = [
    "Overall run task:",
    "",
    task,
    "",
    "This task prompt is stable for the run. Do not let the step prompt replace or dilute the overall task.",
  ].join("\n");

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
    const content = [
      `Current workflow scope: job "${bundle.jobId}", step "${bundle.stepId}", attempt ${bundle.attempt}.`,
      `Primary prompt source: ${bundle.primaryPrompt.source} -> ${bundle.primaryPrompt.id}.`,
      `Primary prompt path: ${bundle.primaryPrompt.path}.`,
      "",
      bundle.primaryPrompt.content.trimEnd(),
    ].join("\n");

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

  const content = [
    `Current workflow scope: job "${bundle.jobId}", step "${bundle.stepId}", attempt ${bundle.attempt}.`,
    "",
    "No primary Skill Pack prompt was resolved for this step. Use the task prompt, context blocks, and output contract to complete only the current step.",
  ].join("\n");

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

  for (const knowledge of bundle.capabilities.knowledge as ExposedKnowledge[]) {
    const policy = knowledge.readPolicy ?? "optional";
    const usage = knowledge.usage ?? knowledge.description ?? "reference material for this step";
    const block: ContextBlock = {
      id: `knowledge-${knowledge.skill}-${knowledge.id}`,
      type: "knowledge-summary",
      source: `${knowledge.skill}.${knowledge.id}`,
      priority: policy === "required" ? 70 : 50,
      freshness: "static",
      summary: `${policy}: ${usage}`,
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
    const block: ContextBlock = {
      id: `prompt-${prompt.skill}-${prompt.id}`,
      type: "capability-summary",
      source: `${prompt.skill}.${prompt.id}`,
      priority: isPrimary ? 65 : 35,
      freshness: "static",
      summary: isPrimary
        ? "Primary step prompt rendered in the Workflow Step Prompt layer."
        : "Reference prompt only; do not switch tasks unless the current step asks for it.",
    };
    if (prompt.path !== undefined) {
      block.path = prompt.path;
    }
    blocks.push(block);
  }

  for (const fn of bundle.capabilities.functions as ExposedFunction[]) {
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
  const allowedSignals = bundle.signals.map((signal) => signal.id);
  const artifactRules = [
    "Write the Agent report to the canonical report path only.",
    "Use artifact references for large logs, diffs, test results, and generated files.",
    "Do not place full large artifact contents in the prompt or report JSON.",
  ];
  const stopRequirement = "Complete the current step, write report.json, then stop. 完成当前 step 后停止.";
  const content = [
    `Canonical report path: ${reportPath}`,
    `Required output keys: ${requiredOutputs.length > 0 ? requiredOutputs.join(", ") : "(none declared)"}`,
    `Allowed signals: ${allowedSignals.length > 0 ? allowedSignals.join(", ") : "(none)"}`,
    stopRequirement,
  ].join("\n");

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
    reportSchema: {
      requiredTopLevelFields: ["outputs", "artifacts", "signals", "summary"],
    },
    requiredOutputs,
    allowedSignals,
    artifactRules,
    stopRequirement,
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
  const lines: string[] = [];
  if (context.length === 0) {
    lines.push("(none)");
    lines.push("");
    return lines;
  }

  for (const block of context) {
    lines.push(`### ${block.id}`);
    lines.push("");
    lines.push(`- type: ${block.type}`);
    lines.push(`- source: ${block.source}`);
    lines.push(`- priority: ${block.priority}`);
    lines.push(`- freshness: ${block.freshness}`);
    if (block.artifactRef !== undefined) {
      lines.push(`- artifact ref: ${block.artifactRef}`);
    }
    if (block.path !== undefined) {
      lines.push(`- path: \`${block.path}\``);
    }
    lines.push(`- summary: ${block.summary}`);
    lines.push("");
  }

  return lines;
}

function renderOutputContractLines(output: OutputContract): string[] {
  const lines: string[] = [];
  lines.push("Write your report to:");
  lines.push("");
  lines.push(`  \`${output.reportPath}\``);
  lines.push("");
  lines.push("This is the canonical step artifact path. Writing to any other location will cause the Engine to reject the report.");
  lines.push("This is a runtime artifact file. Writing it does not modify workflow state or repository code; the Engine reads it and owns all state transitions.");
  lines.push("");

  lines.push("### Required Outputs");
  lines.push("");
  if (output.requiredOutputs.length === 0) {
    lines.push("(none declared)");
  } else {
    for (const key of output.requiredOutputs) {
      lines.push(`- \`${key}\``);
    }
  }
  lines.push("");

  lines.push("### Allowed Signals");
  lines.push("");
  if (output.allowedSignals.length === 0) {
    lines.push("(none)");
  } else {
    for (const signal of output.allowedSignals) {
      lines.push(`- \`${signal}\``);
    }
  }
  lines.push("");

  lines.push("### Artifact Rules");
  lines.push("");
  for (const rule of output.artifactRules) {
    lines.push(`- ${rule}`);
  }
  lines.push("");

  lines.push("### Report Schema");
  lines.push("");
  lines.push("The file must be valid JSON with exactly these required top-level fields:");
  lines.push("");
  lines.push("```json");
  lines.push("{");
  lines.push(`  "outputs": {},`);
  lines.push(`  "artifacts": [],`);
  lines.push(`  "signals": [],`);
  lines.push(`  "summary": ""`);
  lines.push("}");
  lines.push("```");
  lines.push("");
  lines.push("- `\"outputs\"`: current step output values.");
  lines.push("- `\"artifacts\"`: artifact references for large outputs.");
  lines.push("- `\"signals\"`: structured workflow-change requests from the allowed list above.");
  lines.push("- `\"summary\"`: short execution summary.");
  lines.push("");
  lines.push(output.stopRequirement);
  lines.push("");
  return lines;
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
  const lines: string[] = [];
  const workspaceMode = getWorkspaceMode(bundle);
  const permissions = bundle.permissions as PermissionSet;

  if (workspaceMode === "read-only") {
    lines.push("This job operates in read-only mode. You must not modify files in the repository.");
  } else if (canModifyRepositoryFiles(permissions, workspaceMode)) {
    lines.push("This job may modify repository files according to the task.");
  } else {
    lines.push("This job does not grant repository file modifications unless the workflow explicitly allows them.");
  }

  if (permissions["contents"] === "read") {
    lines.push("Repository contents may be read for this step.");
  }
  if (permissions["commands"] === "none") {
    lines.push("Commands are not granted for this step.");
  }

  lines.push("Writing report.json to the canonical runtime artifact path is allowed and required.");
  return lines;
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
  const keys = new Set<string>();
  for (const key of Object.keys(bundle.stepOutputs ?? {})) {
    keys.add(key);
  }
  for (const fn of bundle.capabilities.functions as ExposedFunction[]) {
    for (const key of Object.keys(fn.outputs ?? {})) {
      keys.add(key);
    }
  }
  return [...keys].sort();
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
