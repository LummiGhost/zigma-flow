/**
 * Workflow loader — parses and validates YAML workflow definitions.
 *
 * Reference: docs/prd.md FR-002, §12 (workflow schema).
 * WF-P2-VALIDATE Step 2; DAG integration added in WF-P3-DAG Step 2.
 */

import { readFile } from "node:fs/promises";

import { parseDocument } from "yaml";
import { z } from "zod";

import { detectCycles, validateNeedsReferences } from "../dag/index.js";
import { FilesystemError, ValidationError, WorkflowError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// RouterAction schema
// ---------------------------------------------------------------------------

const RouterActionLiteralSchema = z.enum(["continue", "fail", "block"]);

const RouterActionObjectSchema = z.union([
  z.object({ retry_job: z.string(), retry_with: z.record(z.string(), z.string()).optional() }),
  z.object({ activate_job: z.string() }),
  z.object({ goto_job: z.string() }),
  z.object({ status: z.enum(["blocked", "failed"]) }),
  z.object({ goto_step: z.string(), goto_with: z.record(z.string(), z.string()).optional() }),
]);

const RouterActionSchema = z.union([RouterActionLiteralSchema, RouterActionObjectSchema]);

export type RouterAction =
  | "continue"
  | "fail"
  | "block"
  | { retry_job: string; retry_with?: Record<string, string> }
  | { activate_job: string }
  | { goto_job: string }
  | { status: "blocked" | "failed" }
  | { goto_step: string; goto_with?: Record<string, string> };

// ---------------------------------------------------------------------------
// SignalDeclaration schema (WF-P9-ACCEPT)
// ---------------------------------------------------------------------------

const SignalDeclarationSchema = z.object({
  severity: z.string().optional(),
  priority: z.number().optional(),
  allowed_from: z.array(z.string()).optional(),
  action: RouterActionSchema.optional(),
}).passthrough();

export interface SignalDeclaration {
  severity?: string;
  priority?: number;
  allowed_from?: string[];
  action?: RouterAction;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Step schemas
// ---------------------------------------------------------------------------

const StepBaseSchema = z.object({
  id: z.string(),
  type: z.enum(["agent", "script", "check", "router", "workflow", "human"]),
  uses: z.string().optional(),
  prompt: z.string().optional(),
  expose: z
    .object({
      skills: z.array(z.string()).optional(),
      knowledge: z.array(z.string()).optional(),
    })
    .passthrough()
    .optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
  switch: z.string().optional(),
  cases: z.record(z.string(), RouterActionSchema).optional(),
  // Script step fields (D2 — WF-P6-SCRIPT)
  run: z.string().optional(),
  shell: z.string().optional(),
  timeout: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  on_failure: RouterActionSchema.optional(),
  // Check step fields (D2 — WF-P7-CHECK)
  on_pass: RouterActionSchema.optional(),
  on_fail: RouterActionSchema.optional(),
  // Artifact policy
  required_artifacts: z.array(z.string()).optional(),
  // Step Structured Return Status (WF-P13-RETURNS)
  returns: z.object({
    status: z.object({
      values: z.array(z.string()).min(1),
      required: z.boolean().optional(),
    }),
  }).optional(),
  on_return: z.record(z.string(), RouterActionSchema).optional(),
  // Flow control (WF-P13-FLOW)
  if: z.string().min(1).optional(),
  max_visits: z.number().int().positive().optional(),
  // Permissions (WF-P13-VARIABLES)
  permissions: z.object({
    contents: z.string().optional(),
    edits: z.string().optional(),
    commands: z.string().optional(),
    workflow_state: z.string().optional(),
    variables: z.object({
      read: z.array(z.string()).optional(),
      write: z.array(z.string()).optional(),
    }).optional(),
    context_edit: z.enum(["none", "read", "write"]).optional(),
    context_blocks: z.object({
      read: z.array(z.string()).optional(),
      write: z.array(z.string()).optional(),
    }).optional(),
  }).passthrough().optional(),
});

export interface StepDefinition {
  id: string;
  type: "agent" | "script" | "check" | "router" | "workflow" | "human";
  uses?: string;
  prompt?: string;
  expose?: { skills?: string[]; knowledge?: string[]; [key: string]: unknown };
  with?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  switch?: string;
  cases?: Record<string, RouterAction>;
  // Script step fields (D2 — WF-P6-SCRIPT)
  run?: string;
  shell?: string;
  timeout?: string;
  cwd?: string;
  env?: Record<string, string>;
  on_failure?: RouterAction;
  // Check step fields (D2 — WF-P7-CHECK)
  on_pass?: RouterAction;
  on_fail?: RouterAction;
  // Artifact policy (D2 — WF-P12-QUALITY)
  required_artifacts?: string[];
  // Step Structured Return Status (WF-P13-RETURNS)
  returns?: { status: { values: string[]; required?: boolean } };
  on_return?: Record<string, RouterAction>;
  // Flow control (WF-P13-FLOW)
  if?: string;
  max_visits?: number;
  // Permissions (WF-P13-VARIABLES)
  permissions?: {
    contents?: string;
    edits?: string;
    commands?: string;
    workflow_state?: string;
    variables?: { read?: string[]; write?: string[] };
    context_edit?: "none" | "read" | "write";
    context_blocks?: { read?: string[]; write?: string[] };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Job schema
// ---------------------------------------------------------------------------

const JobSchema = z.object({
  steps: z.array(StepBaseSchema),
  workspace: z.record(z.string(), z.unknown()).optional(),
  needs: z.array(z.string()).optional(),
  optional_needs: z.array(z.string()).optional(),
  activation: z.string().optional(),
  retry: z.record(z.string(), z.unknown()).optional(),
  permissions: z.record(z.string(), z.unknown()).optional(),
});

export interface JobDefinition {
  steps: StepDefinition[];
  workspace?: Record<string, unknown>;
  needs?: string[];
  optional_needs?: string[];
  activation?: string;
  retry?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// WorkflowDefinition schema
// ---------------------------------------------------------------------------

const WorkflowSchema = z.object({
  name: z.string(),
  version: z.string(),
  on: z.record(z.string(), z.unknown()).optional(),
  skills: z.record(z.string(), z.unknown()).optional(),
  permissions: z.record(z.string(), z.unknown()).optional(),
  signals: z.record(z.string(), SignalDeclarationSchema).optional(),
  variables: z.record(z.string(), z.object({
    type: z.enum(["string", "number", "boolean", "array", "object"]),
    initial: z.unknown().optional(),
    enum: z.array(z.string()).optional(),
    allowed_writers: z.array(z.string()),
  })).optional(),
  context_blocks: z.record(z.string(), z.object({
    initial_artifact: z.string().nullable().optional(),
    allowed_writers: z.array(z.string()),
  })).optional(),
  jobs: z.record(z.string(), JobSchema),
});

export interface WorkflowDefinition {
  name: string;
  version: string;
  on?: Record<string, unknown>;
  skills?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  signals?: Record<string, SignalDeclaration>;
  variables?: Record<string, {
    type: "string" | "number" | "boolean" | "array" | "object";
    initial?: unknown;
    enum?: string[];
    allowed_writers: string[];
  }>;
  context_blocks?: Record<string, {
    initial_artifact?: string | null;
    allowed_writers: string[];
  }>;
  jobs: Record<string, JobDefinition>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatZodErrors(issues: z.ZodIssue[]): Record<string, unknown> {
  const paths: string[] = issues.map((issue) => issue.path.join("."));
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.join(".") || "root";
    fields[key] = issue.message;
  }
  return { fields, paths };
}

// ---------------------------------------------------------------------------
// loadWorkflow — synchronous
// ---------------------------------------------------------------------------

export function loadWorkflow(yamlText: string): WorkflowDefinition {
  // 1. Parse YAML, catching syntax errors
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(yamlText, { strict: false });
  } catch (e) {
    throw new ValidationError(`YAML parse error: ${String(e)}`, {
      details: { error: String(e) },
      cause: e,
    });
  }

  // 2. Check YAML errors (syntax errors including duplicate keys)
  if (doc.errors.length > 0) {
    const firstError = doc.errors[0]!;
    const msg = firstError.message;

    // Detect duplicate key errors and extract the key name from the message.
    // yaml library emits "Map keys must be unique" for duplicate keys.
    if (msg.includes("Map keys must be unique") || msg.toLowerCase().includes("duplicate")) {
      // The error message contains context lines with the duplicate key.
      // Parse lines to find the key name (e.g., "  intake:" -> "intake").
      const lines = msg.split("\n");
      let dupKey = "unknown";
      for (const line of lines) {
        const trimmed = line.trimStart();
        const keyMatch = /^([\w][\w.-]*):\s*/.exec(trimmed);
        if (keyMatch && keyMatch[1] !== undefined) {
          dupKey = keyMatch[1];
          break;
        }
      }
      throw new WorkflowError(`Duplicate job id: ${dupKey}`, {
        details: { duplicateKey: dupKey },
      });
    }

    throw new ValidationError(`YAML syntax error: ${msg}`, {
      details: { yamlErrors: doc.errors.map((e) => e.message) },
    });
  }

  // 3. Check warnings for duplicate keys (non-strict mode emits warnings)
  const dupWarning = doc.warnings.find(
    (w) => w.message.includes("Duplicate key") || w.message.includes("duplicate")
  );
  if (dupWarning) {
    const match = /Duplicate key: (.+)/.exec(dupWarning.message);
    const dupKey = match?.[1] ?? "unknown";
    throw new WorkflowError(`Duplicate job id: ${dupKey}`, {
      details: { duplicateKey: dupKey },
    });
  }

  // 4. Convert to JS object
  const raw: unknown = doc.toJS();

  // 5. Zod schema validation
  const result = WorkflowSchema.safeParse(raw);
  if (!result.success) {
    const details = formatZodErrors(result.error.issues);
    const firstPath = result.error.issues[0]?.path.join(".") ?? "unknown";
    throw new ValidationError(`Workflow validation failed at: ${firstPath}`, {
      details,
    });
  }

  const wf = result.data as WorkflowDefinition;

  // 6. Semantic checks

  // 6a. Duplicate step ids within each job
  for (const [jobName, job] of Object.entries(wf.jobs)) {
    const seenStepIds = new Set<string>();
    for (const step of job.steps) {
      if (seenStepIds.has(step.id)) {
        throw new WorkflowError(
          `Duplicate step id "${step.id}" in job "${jobName}"`,
          {
            details: { job: jobName, duplicateStepId: step.id },
          }
        );
      }
      seenStepIds.add(step.id);
    }
  }

  // 6b. Agent expose.skills must reference declared skill aliases
  const declaredSkills = new Set(Object.keys(wf.skills ?? {}));
  for (const [jobName, job] of Object.entries(wf.jobs)) {
    for (const step of job.steps) {
      if (step.type === "agent" && step.expose?.skills) {
        for (const skillRef of step.expose.skills) {
          if (!declaredSkills.has(skillRef)) {
            throw new ValidationError(
              `Step "${step.id}" in job "${jobName}" exposes undeclared skill alias "${skillRef}"`,
              {
                details: {
                  job: jobName,
                  step: step.id,
                  undeclaredSkill: skillRef,
                },
              }
            );
          }
        }
      }
    }
  }

  // 6c. on_return keys must be a subset of returns.status.values
  for (const [jobName, job] of Object.entries(wf.jobs)) {
    for (const step of job.steps) {
      if (step.returns && step.on_return) {
        const validValues = new Set(step.returns.status.values);
        for (const key of Object.keys(step.on_return)) {
          if (!validValues.has(key)) {
            throw new ValidationError(
              `on_return key "${key}" is not in returns.status.values for step "${step.id}" in job "${jobName}"`,
              { details: { job: jobName, step: step.id, key, values: step.returns.status.values } }
            );
          }
        }
      }
    }
  }

  // 6d. Validate goto_step targets exist in same job (WF-P13-FLOW)
  for (const [jobName, job] of Object.entries(wf.jobs)) {
    const stepIds = new Set(job.steps.map(s => s.id));
    for (const step of job.steps) {
      if (step.type === "router" && step.cases) {
        for (const [caseName, action] of Object.entries(step.cases)) {
          if (typeof action === "object" && action !== null && "goto_step" in action) {
            const target = action.goto_step;
            if (!stepIds.has(target)) {
              throw new WorkflowError(
                `goto_step target "${target}" in router "${step.id}" (case "${caseName}") not found in job "${jobName}"`,
                { details: { job: jobName, step: step.id, case: caseName, target } }
              );
            }
          }
        }
      }
    }
  }

  // 7. DAG: needs/optional_needs reference validation (RC-07, TD-P2-001)
  const needsResult = validateNeedsReferences(wf.jobs);
  if (!needsResult.valid) {
    throw new WorkflowError(
      `Workflow has ${needsResult.errors.length} unresolved job reference(s): ${needsResult.errors.join("; ")}`,
      { details: { errors: needsResult.errors } }
    );
  }

  // 8. DAG: cycle detection (RC-08, TD-P2-001)
  const cycles = detectCycles(wf.jobs);
  if (cycles !== null) {
    const path = cycles[0]?.join(" -> ") ?? "unknown";
    throw new WorkflowError(
      `Workflow DAG contains a cycle: ${path}`,
      { details: { cycles } }
    );
  }

  // 9. WF-P13-VARIABLES: Validate allowed_writers reference real steps
  // Build a set of valid <job>.<step> references from the workflow definition
  const validStepRefs = new Set<string>();
  const validJobWildcards = new Set<string>();
  for (const [jobName, job] of Object.entries(wf.jobs)) {
    validJobWildcards.add(`${jobName}.*`);
    for (const step of job.steps) {
      validStepRefs.add(`${jobName}.${step.id}`);
    }
  }

  function validateAllowedWriters(
    source: string,
    key: string,
    allowedWriters: string[]
  ): void {
    for (const ref of allowedWriters) {
      if (validStepRefs.has(ref)) continue;
      if (validJobWildcards.has(ref)) continue;
      throw new WorkflowError(
        `allowed_writers entry "${ref}" in ${source} "${key}" does not reference a real step (<job>.<step> or <job>.*)`,
        { details: { source, key, invalidRef: ref } }
      );
    }
  }

  if (wf.variables) {
    for (const [varName, varDef] of Object.entries(wf.variables)) {
      if (varDef.allowed_writers && varDef.allowed_writers.length > 0) {
        validateAllowedWriters("variable", varName, varDef.allowed_writers);
      }
    }
  }

  if (wf.context_blocks) {
    for (const [blockName, blockDef] of Object.entries(wf.context_blocks)) {
      if (blockDef.allowed_writers && blockDef.allowed_writers.length > 0) {
        validateAllowedWriters("context_block", blockName, blockDef.allowed_writers);
      }
    }
  }

  return wf;
}

// ---------------------------------------------------------------------------
// loadWorkflowFile — async file reader
// ---------------------------------------------------------------------------

export async function loadWorkflowFile(filePath: string): Promise<WorkflowDefinition> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch (e) {
    throw new FilesystemError(`Cannot read workflow file: ${filePath}`, {
      cause: e,
    });
  }
  return loadWorkflow(text);
}
