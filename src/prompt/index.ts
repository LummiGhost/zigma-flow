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
 *   ## Exposed Capabilities
 *     ### Knowledge
 *     ### Prompts
 *     ### Functions
 *     ### Tools
 *   ## Available Workflow Signals
 *   ## Permissions and Forbidden Actions
 *   ## Output
 */
export function buildAgentPrompt(bundle: ContextBundle): string {
  const lines: string[] = [];

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
  const permEntries = Object.entries(permissions);
  if (permEntries.length === 0) {
    lines.push("(none specified — default deny)");
  } else {
    for (const [key, value] of permEntries) {
      lines.push(`- **${key}**: ${String(value)}`);
    }
  }
  lines.push("");
  lines.push("**Forbidden**: You cannot modify workflow state.");
  lines.push("");

  // ## Output
  lines.push("## Output");
  lines.push("");
  lines.push(
    `When your task is complete, write your report to \`report.json\` in the ` +
    `step artifacts directory. Include your result, any outputs, and evidence of completion.`
  );
  lines.push("");
  lines.push("完成当前 step 后停止 — stop after completing this step.");
  lines.push("");

  return lines.join("\n");
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
