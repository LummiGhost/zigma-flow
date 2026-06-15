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
import { artifactFileRelativePath } from "../artifact/index.js";

// ---------------------------------------------------------------------------
// buildAgentPrompt
// ---------------------------------------------------------------------------

/**
 * Render a ContextBundle into a Markdown agent prompt.
 *
 * Sections rendered (in order):
 *   # <job>/<step> Agent Prompt
 *   ## Responsibility (当前职责)
 *   ## Inputs (当前输入)
 *   ## Step Instructions
 *   ## Exposed Capabilities
 *     ### Knowledge
 *     ### Prompts
 *     ### Functions
 *     ### Tools
 *   ## Available Workflow Signals
 *   ## Permissions and Forbidden Actions
 *     ### Repository Workspace Permissions
 *     ### Runtime Artifact Permissions
 *   ## Output
 */
export function buildAgentPrompt(bundle: ContextBundle): string {
  const lines: string[] = [];
  const reportPath = posix.join(
    ".zigma-flow",
    "runs",
    bundle.runId,
    artifactFileRelativePath(bundle.jobId, bundle.attempt, bundle.stepId, "report.json")
  );

  // H1 — step header
  lines.push(`# ${bundle.jobId}/${bundle.stepId} Agent Prompt`);
  lines.push("");

  // ## Responsibility
  lines.push("## Responsibility");
  lines.push("");
  lines.push(
    `You are acting as the \`${bundle.stepId}\` agent step of job \`${bundle.jobId}\` in run \`${bundle.runId}\`. ` +
    `Complete this step and then stop. 完成当前 step 后停止.`
  );
  lines.push("");
  lines.push(
    `You **cannot modify workflow state** directly. ` +
    `All state transitions are owned by the Engine. ` +
    `Do not attempt to write to state.json, events.jsonl, or any workflow control file.`
  );
  lines.push("");

  // ## Inputs (当前输入)
  lines.push("## Inputs (当前输入)");
  lines.push("");
  const inputEntries = Object.entries(bundle.inputs);
  if (inputEntries.length === 0) {
    lines.push("(none)");
  } else {
    for (const [key, value] of inputEntries) {
      lines.push(`- **${key}**: ${value}`);
    }
  }
  lines.push("");

  // ## Step Instructions
  lines.push("## Step Instructions");
  lines.push("");
  if (bundle.warnings !== undefined) {
    for (const warning of bundle.warnings) {
      lines.push(`> Warning: ${warning}`);
    }
    lines.push("");
  }
  if (bundle.primaryPrompt !== undefined) {
    lines.push(bundle.primaryPrompt.content.trimEnd());
  } else {
    lines.push("No primary prompt was resolved. Use the generated inputs and exposed capabilities below as fallback context.");
  }
  lines.push("");

  // ## Exposed Capabilities
  lines.push("## Exposed Capabilities");
  lines.push("");

  // ### Knowledge
  lines.push("### Knowledge");
  lines.push("");
  if (bundle.capabilities.knowledge.length === 0) {
    lines.push("(none)");
  } else {
    for (const k of bundle.capabilities.knowledge as ExposedKnowledge[]) {
      const desc = k.description !== undefined ? ` — ${k.description}` : "";
      lines.push(`- \`${k.id}\`${desc} (skill: ${k.skill})`);
    }
  }
  lines.push("");

  // ### Prompts
  lines.push("### Prompts");
  lines.push("");
  if (bundle.capabilities.prompts.length === 0) {
    lines.push("(none)");
  } else {
    for (const p of bundle.capabilities.prompts as ExposedPrompt[]) {
      lines.push(`- \`${p.id}\` (skill: ${p.skill})`);
    }
  }
  lines.push("");

  // ### Functions
  lines.push("### Functions");
  lines.push("");
  if (bundle.capabilities.functions.length === 0) {
    lines.push("(none)");
  } else {
    for (const f of bundle.capabilities.functions as ExposedFunction[]) {
      const desc = f.description !== undefined ? ` — ${f.description}` : "";
      lines.push(`- \`${f.id}\`${desc} (skill: ${f.skill})`);
      if (f.inputs !== undefined) {
        lines.push(`  - inputs: ${JSON.stringify(f.inputs)}`);
      }
      if (f.outputs !== undefined) {
        lines.push(`  - outputs: ${JSON.stringify(f.outputs)}`);
      }
    }
  }
  lines.push("");

  // ### Tools
  lines.push("### Tools");
  lines.push("");
  if (bundle.capabilities.tools.length === 0) {
    lines.push("(none)");
  } else {
    for (const t of bundle.capabilities.tools as ExposedTool[]) {
      lines.push(`- \`${t.id}\` (skill: ${t.skill})`);
    }
  }
  lines.push("");

  // ## Artifacts (if any)
  if (bundle.artifacts.length > 0) {
    lines.push("## Prior Artifacts");
    lines.push("");
    for (const a of bundle.artifacts as ArtifactSummary[]) {
      lines.push(`- \`${a.id}\` (${a.kind}) — ${a.summary}`);
    }
    lines.push("");
  }

  // ## Available Workflow Signals
  lines.push("## Available Workflow Signals");
  lines.push("");
  if (bundle.signals.length === 0) {
    lines.push("(none)");
  } else {
    for (const s of bundle.signals as SignalSpec[]) {
      const desc = s.description !== undefined ? ` — ${s.description}` : "";
      lines.push(`- \`${s.id}\`${desc}`);
    }
  }
  lines.push("");

  // ## Permissions and Forbidden Actions
  lines.push("## Permissions and Forbidden Actions");
  lines.push("");
  const permissions = bundle.permissions as PermissionSet;

  lines.push("### Repository Workspace Permissions");
  lines.push("");
  const workspaceMode = getWorkspaceMode(bundle);
  if (workspaceMode === "read-only") {
    lines.push(
      "- This job operates in read-only mode. You must not modify files in the repository."
    );
  } else if (canModifyRepositoryFiles(permissions, workspaceMode)) {
    lines.push("- This job may modify repository files according to the task.");
  } else {
    lines.push(
      "- This job does not grant repository file modifications unless the workflow explicitly allows them."
    );
  }
  if (permissions["contents"] === "read") {
    lines.push("- Repository contents may be read for this step.");
  }
  lines.push("");

  lines.push("### Runtime Artifact Permissions");
  lines.push("");
  lines.push("- Canonical report path: `report.json` in the step artifacts directory.");
  lines.push(
    "- You must write `report.json` to the canonical path above. This is a runtime artifact, not a repository file modification."
  );
  lines.push(
    "- Writing the step report is part of the step contract and is always allowed, regardless of repository workspace write permission."
  );
  lines.push("");

  lines.push("**Forbidden**: You cannot modify workflow state.");
  lines.push("");

  // ## Output
  lines.push("## Output");
  lines.push("");
  lines.push("Write your report to:");
  lines.push("");
  lines.push(`  \`${reportPath}\``);
  lines.push("");
  lines.push(
    `This is the canonical step artifact path. Writing to any other location ` +
    `will cause the engine to reject the report.`
  );
  lines.push("");
  lines.push(
    `This is a runtime artifact file. Writing it does not modify workflow state ` +
    `or repository code; the Engine reads it and owns all state transitions.`
  );
  lines.push("");
  lines.push(
    `Include your result, any outputs, and evidence of completion in \`report.json\`.`
  );
  lines.push("");
  lines.push("完成当前 step 后停止 — stop after completing this step.");
  lines.push("");

  // ## Report Schema
  lines.push("## Report Schema");
  lines.push("");
  lines.push(
    `完成当前步骤后，将结果写入约定路径的 \`report.json\`（路径见上方 "Output"）。`
  );
  lines.push("");
  lines.push("文件必须是合法 JSON，包含以下顶层字段：");
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
  lines.push("字段说明：");
  lines.push(`- \`"outputs"\`：当前步骤的输出值，键名见上方 "Functions" 中的 outputs 字段。`);
  lines.push(`- \`"artifacts"\`：本步骤生成的大型输出（日志、diff、构建产物），以路径引用方式提供。`);
  lines.push(`- \`"signals"\`：对工作流流程变化的结构化请求（见上方 "Available Workflow Signals"）。`);
  lines.push(`- \`"summary"\`：本步骤的简短执行摘要。`);
  lines.push("");

  return lines.join("\n");
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
  clock: Clock;
}

export interface WritePromptArtifactResult {
  artifactRef: string;
}

/**
 * Write the rendered prompt as:
 *   1. `<runDir>/current-step.md` — top-level mirror for convenient reading
 *   2. `<runDir>/jobs/<job>/attempts/<n>/steps/<step>/current-step.md` — step-scoped artifact
 *   3. Append artifact metadata to `<runDir>/artifacts.jsonl`
 *
 * Returns `{ artifactRef }` pointing to the step-scoped artifact id.
 * Does NOT write to events.jsonl or state.json.
 */
export async function writePromptArtifact(
  opts: WritePromptArtifactOpts
): Promise<WritePromptArtifactResult> {
  const { runDir, runId, jobId, stepId, attempt, prompt, clock } = opts;

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
  const size = Buffer.byteLength(prompt, "utf-8");
  const ref = artifactId(runId, jobId, attempt, stepId, "current-step.md");
  const createdAt = clock.now();

  const metadata = {
    id: ref,
    run_id: runId,
    producer: { job: jobId, step: stepId, attempt },
    kind: "prompt",
    path: relPath,
    content_type: "text/markdown",
    size,
    summary: `Agent prompt for ${jobId}/${stepId}`,
    created_at: createdAt,
  };

  // 4. Append to artifacts.jsonl
  await appendArtifactIndex(runDir, metadata);

  return { artifactRef: ref };
}
