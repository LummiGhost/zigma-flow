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

/** @stability stable — "continue", "fail", "block" literal actions */
const RouterActionLiteralSchema = z.enum(["continue", "fail", "block"]);

const RouterActionObjectSchema = z.union([
  /** @stability stable */
  z.object({ retry_job: z.string(), retry_with: z.record(z.string(), z.string()).optional() }),
  /** @stability stable */
  z.object({ activate_job: z.string() }),
  /** @stability stable */
  z.object({ goto_job: z.string() }),
  /** @stability stable */
  z.object({ status: z.enum(["blocked", "failed"]) }),
  /** @stability experimental — may change in any minor version release without deprecation */
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
  /** @stability stable */
  severity: z.string().optional(),
  /** @stability stable */
  priority: z.number().optional(),
  /** @stability stable */
  allowed_from: z.array(z.string()).optional(),
  /** @stability stable */
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
  /** @stability stable */
  id: z.string(),
  /**
   * @stability stable — `agent`, `script`, `check`, `router`, `human`
   * @stability reserved — `workflow` (recognised but not executed by the current runtime)
   */
  type: z.enum(["agent", "script", "check", "router", "workflow", "human"]),
  /** @stability stable */
  uses: z.string().optional(),
  /** @stability stable */
  prompt: z.string().optional(),
  /** @stability stable */
  expose: z
    .object({
      /** @stability stable */
      skills: z.array(z.string()).optional(),
      /** @stability stable */
      knowledge: z.array(z.string()).optional(),
    })
    .passthrough()
    .optional(),
  /** @stability stable */
  with: z.record(z.string(), z.unknown()).optional(),
  /** @stability stable */
  outputs: z.record(z.string(), z.unknown()).optional(),
  /** @stability stable */
  switch: z.string().optional(),
  /** @stability stable */
  cases: z.record(z.string(), RouterActionSchema).optional(),
  // Script step fields (D2 — WF-P6-SCRIPT)
  /** @stability stable */
  run: z.string().optional(),
  /** @stability stable */
  shell: z.string().optional(),
  /** @stability stable */
  timeout: z.string().optional(),
  /** @stability stable */
  cwd: z.string().optional(),
  /** @stability stable */
  env: z.record(z.string(), z.string()).optional(),
  /** @stability stable */
  on_failure: RouterActionSchema.optional(),
  // Check step fields (D2 — WF-P7-CHECK)
  /** @stability stable */
  on_pass: RouterActionSchema.optional(),
  /** @stability stable */
  on_fail: RouterActionSchema.optional(),
  // Artifact policy
  /** @stability experimental — may change in any minor version release without deprecation — not yet in published language spec */
  required_artifacts: z.array(z.string()).optional(),
  // Step Structured Return Status (WF-P13-RETURNS)
  /** @stability experimental — may change in any minor version release without deprecation */
  returns: z.object({
    status: z.object({
      /** @stability experimental — may change in any minor version release without deprecation */
      values: z.array(z.string()).min(1),
      /** @stability experimental — may change in any minor version release without deprecation */
      required: z.boolean().optional(),
    }),
  }).optional(),
  /** @stability experimental — may change in any minor version release without deprecation */
  on_return: z.record(z.string(), RouterActionSchema).optional(),
  // Flow control (WF-P13-FLOW)
  /** @stability experimental — may change in any minor version release without deprecation */
  if: z.string().min(1).optional(),
  /** @stability experimental — may change in any minor version release without deprecation */
  max_visits: z.number().int().positive().optional(),
  // Permissions (WF-P13-VARIABLES)
  /**
   * @stability stable — top-level permissions (contents, edits, commands, workflow_state)
   * @stability experimental — may change in any minor version release without deprecation — sub-fields: variables, context_edit, context_blocks
   */
  permissions: z.object({
    /** @stability stable */
    contents: z.string().optional(),
    /** @stability stable */
    edits: z.string().optional(),
    /** @stability stable */
    commands: z.string().optional(),
    /** @stability stable */
    workflow_state: z.string().optional(),
    /** @stability experimental — may change in any minor version release without deprecation */
    variables: z.object({
      /** @stability experimental — may change in any minor version release without deprecation */
      read: z.array(z.string()).optional(),
      /** @stability experimental — may change in any minor version release without deprecation */
      write: z.array(z.string()).optional(),
    }).optional(),
    /** @stability experimental — may change in any minor version release without deprecation */
    context_edit: z.enum(["none", "read", "write"]).optional(),
    /** @stability experimental — may change in any minor version release without deprecation */
    context_blocks: z.object({
      /** @stability experimental — may change in any minor version release without deprecation */
      read: z.array(z.string()).optional(),
      /** @stability experimental — may change in any minor version release without deprecation */
      write: z.array(z.string()).optional(),
    }).optional(),
  }).passthrough().optional(),
  // Human step fields (WF-P15-SCHEMA)
  /** @stability experimental — may change in any minor version release without deprecation */
  approvers: z.array(z.string()).optional(),
  /** @stability experimental — may change in any minor version release without deprecation */
  instructions: z.string().optional(),
  /**
   * @stability experimental — may change in any minor version release without deprecation
   *
   * DSL field reserved for future runtime enforcement (v0.3+). At v0.2.2 the
   * engine does NOT enforce the timeout; this entry only ensures the field
   * passes schema validation and is available for audit/display purposes.
   * AD-P15-002 (AD-out-of-scope for runtime enforcement until v0.3).
   */
  timeout_minutes: z.number().int().positive().optional(),
  // Step-specific output schemas (Issue #100)
  /** @stability experimental — may change in any minor version release without deprecation — not yet in published language spec */
  outputs_schema: z.record(z.string(), z.object({
    type: z.string(),
    values: z.array(z.string()).optional(),
    on_value: z.record(z.string(), RouterActionSchema).optional(),
  })).optional(),
  // Output-based routing (Issue #172)
  /** @stability experimental — may change in any minor version release without deprecation — not yet in published language spec */
  on_output: z.record(z.string(), z.record(z.string(), RouterActionSchema)).optional(),
  /** @stability experimental — may change in any minor version release without deprecation — not yet in published language spec */
  artifact_policy: z.object({
    /** @stability experimental — may change in any minor version release without deprecation */
    required: z.array(z.string()).optional(),
    /** @stability experimental — may change in any minor version release without deprecation */
    forbidden: z.array(z.string()).optional(),
  }).optional(),
  /** @stability experimental — may change in any minor version release without deprecation — not yet in published language spec */
  signal_policy: z.object({
    /** @stability experimental — may change in any minor version release without deprecation */
    allowed: z.array(z.string()).optional(),
    /** @stability experimental — may change in any minor version release without deprecation */
    required_evidence: z.array(z.string()).optional(),
  }).optional(),
  // Issue #106: Allow generic prompt fallback when no primary prompt is found
  /** @stability experimental — may change in any minor version release without deprecation — not yet in published language spec */
  allow_generic_prompt: z.boolean().optional(),
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
  // Human step fields (WF-P15-SCHEMA)
  approvers?: string[];
  instructions?: string;
  /** DSL-reserved field. Runtime enforcement deferred to v0.3+. */
  timeout_minutes?: number;
  // Step-specific output schemas (Issue #100)
  outputs_schema?: Record<string, { type: string; values?: string[]; on_value?: Record<string, RouterAction> }>;
  // Output-based routing (Issue #172)
  on_output?: Record<string, Record<string, RouterAction>>;
  artifact_policy?: { required?: string[]; forbidden?: string[] };
  signal_policy?: { allowed?: string[]; required_evidence?: string[] };
  // Issue #106: Allow generic prompt fallback when no primary prompt is found
  allow_generic_prompt?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Job schema
// ---------------------------------------------------------------------------

/**
 * Job workspace: a string path (may contain `${{ }}` expressions) or an
 * object with optional `directory` (working directory path) and optional
 * `mode` ("read-only" | "writable") plus arbitrary extension keys.
 *
 * ## Forms (any one of the following)
 *
 * ### 1. String form (simple path)
 * ```yaml
 * workspace: /absolute/path
 * workspace: ${{ jobs.create.outputs.dir }}/subdir
 * ```
 *
 * ### 2. Object form with directory
 * ```yaml
 * workspace:
 *   directory: /absolute/path
 * ```
 *
 * ### 3. Object form with mode only (no working directory)
 * ```yaml
 * workspace:
 *   mode: read-only
 * ```
 *
 * ## Precedence
 *
 * - Job-level `workspace.directory` (or string-form `workspace`) sets the
 *   default working directory for **script, check, and router** steps within
 *   the job. Agent steps run in their own subprocess and are **not** affected.
 * - Step-level `cwd` on script steps takes precedence over the job-level
 *   workspace directory.
 * - For check steps, `with.cwd` takes precedence over the job-level workspace
 *   directory, which in turn takes precedence over `runDir` for path resolution.
 * - If no workspace is configured, steps default to the project root.
 *
 * ## Expression support
 *
 * Both the string form and `directory` field accept `${{ }}` expressions.
 * These are resolved at job execution time against the current run state
 * (job outputs, variables). Only simple path references are permitted;
 * arithmetic and function expressions are rejected at schema validation time.
 *
 * @stability experimental — `directory` and string-form workspace may change
 *   in any minor version release without deprecation.
 */
const JobWorkspaceSchema = z.union([
  z.string(),
  z.object({
    /** @stability stable */
    mode: z.enum(["read-only", "writable"]).optional(),
    /** @stability experimental */
    directory: z.string().optional(),
  }).catchall(z.unknown()),
]);

const JobSchema = z.object({
  /** @stability stable */
  steps: z.array(StepBaseSchema),
  /** @stability stable — mode field; @stability experimental — directory field and string form */
  workspace: JobWorkspaceSchema.optional(),
  /** @stability stable */
  needs: z.array(z.string()).optional(),
  /** @stability stable */
  optional_needs: z.array(z.string()).optional(),
  /** @stability stable */
  activation: z.string().optional(),
  /** @stability stable */
  retry: z.record(z.string(), z.unknown()).optional(),
  /** @stability stable */
  permissions: z.record(z.string(), z.unknown()).optional(),
});

export interface JobDefinition {
  steps: StepDefinition[];
  /** Working directory path (string, may contain expressions) or config object with optional directory + mode. */
  workspace?: string | { mode?: string; directory?: string; [key: string]: unknown };
  needs?: string[];
  optional_needs?: string[];
  activation?: string;
  retry?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// TraverseDefinition schema (WF-P16-TRAVERSE, Issue #179)
// ---------------------------------------------------------------------------

const TraverseTargetSchema = z.object({
  /** @stability experimental — may change in any minor version release without deprecation */
  job: z.string(),
});

const TraverseItemContextSchema = z.object({
  /** @stability experimental — may change in any minor version release without deprecation */
  key: z.string(),
  /** @stability experimental — may change in any minor version release without deprecation */
  index_key: z.string().optional(),
});

const TraverseSchema = z.object({
  /** @stability experimental — may change in any minor version release without deprecation */
  input: z.string(),
  /** @stability experimental — may change in any minor version release without deprecation */
  concurrency: z.number().int().min(1).max(10).optional(),
  /** @stability experimental — may change in any minor version release without deprecation */
  on_item_failure: z.enum(["fail_all", "continue", "collect"]).optional(),
  /** @stability experimental — may change in any minor version release without deprecation */
  target: TraverseTargetSchema,
  /** @stability experimental — may change in any minor version release without deprecation */
  item_context: TraverseItemContextSchema,
  /** @stability experimental — may change in any minor version release without deprecation */
  outputs: z.record(z.string(), z.string()).optional(),
});

export interface TraverseDefinition {
  input: string;
  concurrency?: number;
  on_item_failure?: "fail_all" | "continue" | "collect";
  target: {
    job: string;
  };
  item_context: {
    key: string;
    index_key?: string;
  };
  outputs?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// WorkflowDefinition schema
// ---------------------------------------------------------------------------

const WorkflowSchema = z.object({
  /** @stability stable */
  name: z.string(),
  /** @stability stable */
  version: z.string(),
  /** @stability stable */
  on: z.record(z.string(), z.unknown()).optional(),
  /** @stability stable */
  skills: z.record(z.string(), z.unknown()).optional(),
  /** @stability stable */
  permissions: z.record(z.string(), z.unknown()).optional(),
  /** @stability stable */
  signals: z.record(z.string(), SignalDeclarationSchema).optional(),
  /** @stability experimental — may change in any minor version release without deprecation */
  variables: z.record(z.string(), z.object({
    /** @stability experimental — may change in any minor version release without deprecation */
    type: z.enum(["string", "number", "boolean", "array", "object"]),
    /** @stability experimental — may change in any minor version release without deprecation */
    initial: z.unknown().optional(),
    /** @stability experimental — may change in any minor version release without deprecation */
    enum: z.array(z.string()).optional(),
    /** @stability experimental — may change in any minor version release without deprecation */
    allowed_writers: z.array(z.string()),
  })).optional(),
  /** @stability experimental — may change in any minor version release without deprecation */
  context_blocks: z.record(z.string(), z.object({
    /** @stability experimental — may change in any minor version release without deprecation */
    initial_artifact: z.string().nullable().optional(),
    /** @stability experimental — may change in any minor version release without deprecation */
    allowed_writers: z.array(z.string()),
  })).optional(),
  /** @stability stable */
  jobs: z.record(z.string(), JobSchema),
  /** @stability experimental — may change in any minor version release without deprecation */
  traverse: z.record(z.string(), TraverseSchema).optional(),
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
  traverse?: Record<string, TraverseDefinition>;
}

// ---------------------------------------------------------------------------
// Expression validation (§6.4 — forbidden constructs: arithmetic, function calls,
// array/object literals, ternary, template literals, depth > 3)
// ---------------------------------------------------------------------------

const EXPR_RE = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;

/**
 * Scan a single string for `${{ }}` expressions and reject forbidden patterns.
 */
function checkForbiddenExpressions(value: string, fieldPath: string): void {
  let match: RegExpExecArray | null;
  // Reset regex state (global flag carries lastIndex between calls).
  EXPR_RE.lastIndex = 0;
  while ((match = EXPR_RE.exec(value)) !== null) {
    const inner = match[1]!.trim();
    if (inner.length === 0) continue;

    // Arithmetic operators: +, *, / anywhere; - only when used as operator
    // (with surrounding whitespace or adjacent to a digit), not inside
    // hyphenated identifiers like `code-map`.
    if (/[+*/%]/.test(inner) || /(?:\s-\s|-\d|\d-)/.test(inner)) {
      throw new ValidationError(
        `Arithmetic expressions are not supported: ${inner}`,
        { details: { field: fieldPath, expression: inner } },
      );
    }

    // Function call syntax: identifier followed by (
    if (/\b\w+\s*\(/.test(inner)) {
      throw new ValidationError(
        `Function calls are not supported: ${inner}`,
        { details: { field: fieldPath, expression: inner } },
      );
    }

    // Array/object literals: [ or { in expression
    if (/[\[\{]/.test(inner)) {
      throw new ValidationError(
        `Array/object literals are not supported: ${inner}`,
        { details: { field: fieldPath, expression: inner } },
      );
    }

    // Ternary operator: ? followed by a word character
    if (/\?\s*\w/.test(inner)) {
      throw new ValidationError(
        `Ternary expressions are not supported: ${inner}`,
        { details: { field: fieldPath, expression: inner } },
      );
    }

    // Template literals: backtick or ${ interpolation
    if (/`|\$\{/.test(inner)) {
      throw new ValidationError(
        `Template literals are not supported: ${inner}`,
        { details: { field: fieldPath, expression: inner } },
      );
    }

    // Property chain depth: at most 3 dots (4 parts).
    // "jobs.foo.outputs.bar" = 4 parts = depth 3 → OK.
    // "inputs.a.b.c.d" = 5 parts = depth 4 → rejected.
    const parts = inner.split(".");
    if (parts.length > 4) {
      throw new ValidationError(
        `Expression depth exceeds limit of 3: ${inner}`,
        { details: { field: fieldPath, expression: inner, depth: parts.length - 1 } },
      );
    }
  }
}

/**
 * Recursively scan `step.with` values for forbidden expressions.
 */
function scanWithValues(
  value: unknown,
  path: string,
): void {
  if (typeof value === "string") {
    checkForbiddenExpressions(value, path);
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanWithValues(value[i], `${path}[${i}]`);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      scanWithValues(val, `${path}.${key}`);
    }
  }
}

/**
 * Scan all expression-eligible fields in the workflow for forbidden
 * constructs (§6.4): arithmetic, function calls, depth > 3.
 */
function validateExpressions(workflow: WorkflowDefinition): void {
  // Workflow input defaults (on.manual.inputs.<name>.default)
  const onManual = workflow.on as { manual?: { inputs?: Record<string, { default?: unknown }> } } | undefined;
  if (onManual?.manual?.inputs) {
    for (const [inputName, inputDef] of Object.entries(onManual.manual.inputs)) {
      if (inputDef.default !== undefined) {
        scanWithValues(
          inputDef.default,
          `on.manual.inputs.${inputName}.default`,
        );
      }
    }
  }

  // Job workspace paths (Issue #178)
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    const ws = job.workspace;
    if (ws !== undefined) {
      if (typeof ws === "string") {
        checkForbiddenExpressions(ws, `jobs.${jobName}.workspace`);
      } else if (typeof ws === "object" && typeof ws.directory === "string") {
        checkForbiddenExpressions(ws.directory, `jobs.${jobName}.workspace.directory`);
      }
    }
  }

  // Job steps
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) {
      const base = `jobs.${jobName}.steps.${step.id}`;

      if (step.with) {
        scanWithValues(step.with, `${base}.with`);
      }
      if (step.run) {
        checkForbiddenExpressions(step.run, `${base}.run`);
      }
      if (step.if) {
        checkForbiddenExpressions(step.if, `${base}.if`);
      }
      if (step.env) {
        for (const [envKey, envVal] of Object.entries(step.env)) {
          checkForbiddenExpressions(envVal, `${base}.env.${envKey}`);
        }
      }
    }
  }
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

  // 5b. Deprecation warnings (v0.6 — mutable context)
  if (
    !process.env.ZIGMA_SUPPRESS_DEPRECATION &&
    wf.variables &&
    Object.keys(wf.variables).length > 0
  ) {
    console.warn(
      "[DEPRECATED] Workflow variables are deprecated, use job outputs and artifacts instead. This will be removed in v1.0.",
    );
  }
  if (
    !process.env.ZIGMA_SUPPRESS_DEPRECATION &&
    wf.context_blocks &&
    Object.keys(wf.context_blocks).length > 0
  ) {
    console.warn(
      "[DEPRECATED] Context blocks are deprecated, use artifacts for large data and job outputs for structured data. This will be removed in v1.0.",
    );
  }

  // 5c. Deprecation warnings (v0.6 — schema cleanup, Issue #212)

  const suppress = Boolean(process.env.ZIGMA_SUPPRESS_DEPRECATION);

  // 5c.i. Reserved step type: "workflow"
  for (const [jobName, job] of Object.entries(wf.jobs)) {
    for (const step of job.steps) {
      if (step.type === "workflow" && !suppress) {
        console.warn(
          "[DEPRECATED] type: workflow is reserved for future use. It has no runtime behavior and will be removed from the schema in v1.0. Use type: agent, script, check, router, or human instead.",
        );
      }
    }
  }

  // 5c.ii. workspace.branch (unimplemented)
  for (const [jobName, job] of Object.entries(wf.jobs)) {
    const ws = job.workspace;
    if (ws !== undefined && typeof ws === "object" && ws !== null && "branch" in (ws as Record<string, unknown>)) {
      if (!suppress) {
        console.warn(
          "[DEPRECATED] workspace.branch is not implemented and will be removed in v1.0.",
        );
      }
    }
  }

  // 5c.iii. workspace.mode — deprecated at Job level
  for (const [jobName, job] of Object.entries(wf.jobs)) {
    const ws = job.workspace;
    if (ws !== undefined && typeof ws === "object" && ws !== null && typeof (ws as Record<string, unknown>)["mode"] === "string") {
      if (!suppress) {
        console.warn(
          "[DEPRECATED] workspace.mode is deprecated. Use invocation-level execution strategy instead. This will be removed in v1.0.",
        );
      }
    }
  }

  // 5c.iv. Job-level permissions
  for (const [jobName, job] of Object.entries(wf.jobs)) {
    if (job.permissions !== undefined && Object.keys(job.permissions).length > 0) {
      if (!suppress) {
        console.warn(
          "[DEPRECATED] Job-level permissions are deprecated. Use Workflow-level defaults with Step-level overrides. Per-step permissions tighten (restrict), never escalate. This will be removed in v1.0.",
        );
      }
    }
  }

  // 5c.v. Step-level permission sub-fields: variables, context_edit, context_blocks
  for (const [jobName, job] of Object.entries(wf.jobs)) {
    for (const step of job.steps) {
      const perms = step.permissions;
      if (perms === undefined) continue;

      if (perms.variables !== undefined && !suppress) {
        console.warn(
          "[DEPRECATED] Step permission field 'variables' is deprecated (see #206). Use Step-level outputs for structured data and artifacts for large data. This will be removed in v1.0.",
        );
      }
      if (perms.context_edit !== undefined && !suppress) {
        console.warn(
          "[DEPRECATED] Step permission field 'context_edit' is deprecated (see #206). Use Step-level outputs for structured data and artifacts for large data. This will be removed in v1.0.",
        );
      }
      if (perms.context_blocks !== undefined && !suppress) {
        console.warn(
          "[DEPRECATED] Step permission field 'context_blocks' is deprecated (see #206). Use artifacts for large data and job outputs for structured data. This will be removed in v1.0.",
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // FIELDS REMOVED/CHANGED IN v0.6 (Issue #212):
  //
  // - type: workflow (reserved) → DEPRECATED — warns; no runtime behavior
  // - workspace.branch → DEPRECATED — unimplemented; never had runtime effect
  // - workspace.mode → DEPRECATED — use invocation-level execution strategy
  // - Job-level permissions → DEPRECATED — use workflow-level defaults with
  //   step-level overrides (step can only restrict, never escalate)
  // - permissions.variables, permissions.context_edit, permissions.context_blocks
  //   → DEPRECATED — covered by #206 (mutable context removal)
  // - capture.stdout / capture.stderr → no-op — these fields never existed in
  //   the Step schema; agent-level capture is handled internally
  // - --task CLI flag → DEPRECATED — use --input task='...' instead
  //   (src/cli.ts maps --task to inputs.task internally)
  // - active_run → DEPRECATED — see #205; use --latest flag
  //
  // All deprecated features continue to parse and function normally in v0.6.
  // They will be removed in v1.0.
  // -------------------------------------------------------------------------

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

  // 6d. on_output keys must reference declared output keys (Issue #172)
  for (const [jobName, job] of Object.entries(wf.jobs)) {
    for (const step of job.steps) {
      if (step.on_output) {
        const declaredOutputs = new Set(Object.keys(step.outputs ?? {}));
        for (const key of Object.keys(step.on_output)) {
          if (!declaredOutputs.has(key)) {
            throw new ValidationError(
              `on_output key "${key}" is not a declared output for step "${step.id}" in job "${jobName}"`,
              { details: { job: jobName, step: step.id, key } }
            );
          }
        }
      }
    }
  }

  // 6e. Validate goto_step targets exist in same job (WF-P13-FLOW)
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

  // 8b. Traverse validation (WF-P16-TRAVERSE, Issue #179)
  if (wf.traverse) {
    for (const [traverseId, tDef] of Object.entries(wf.traverse)) {
      // 8b.i. input must be a valid ${{ }} expression
      const inputExpr = tDef.input.trim();
      if (!inputExpr.startsWith("${{") || !inputExpr.endsWith("}}")) {
        throw new ValidationError(
          `traverse "${traverseId}" input must be a \$\{\{ \}\} expression, got: "${tDef.input}"`,
          { details: { traverseId, input: tDef.input } }
        );
      }
      // Validate expression content
      checkForbiddenExpressions(tDef.input, `traverse.${traverseId}.input`);

      // 8b.ii. target.job must reference an existing job
      if (!wf.jobs[tDef.target.job]) {
        throw new ValidationError(
          `traverse "${traverseId}" target.job "${tDef.target.job}" does not reference an existing job`,
          { details: { traverseId, targetJob: tDef.target.job } }
        );
      }

      // 8b.iii. item_context.key must be a valid variable name
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tDef.item_context.key)) {
        throw new ValidationError(
          `traverse "${traverseId}" item_context.key "${tDef.item_context.key}" is not a valid variable name`,
          { details: { traverseId, key: tDef.item_context.key } }
        );
      }

      // 8b.iv. item_context.index_key must be a valid variable name if present
      if (tDef.item_context.index_key && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tDef.item_context.index_key)) {
        throw new ValidationError(
          `traverse "${traverseId}" item_context.index_key "${tDef.item_context.index_key}" is not a valid variable name`,
          { details: { traverseId, indexKey: tDef.item_context.index_key } }
        );
      }

      // 8b.v. outputs: validate any expression in output expressions
      if (tDef.outputs) {
        for (const [outputKey, outputExpr] of Object.entries(tDef.outputs)) {
          checkForbiddenExpressions(outputExpr, `traverse.${traverseId}.outputs.${outputKey}`);
        }
      }

      // 8b.vi. traverse id must not conflict with a job id
      if (wf.jobs[traverseId]) {
        throw new ValidationError(
          `traverse id "${traverseId}" conflicts with an existing job id`,
          { details: { traverseId } }
        );
      }
    }
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

  // 10. Expression validation (§6.4 — forbidden constructs)
  validateExpressions(wf);

  // 11. Human step field validation (WF-P15-SCHEMA, AD-P15-002)
  for (const [jobName, job] of Object.entries(wf.jobs)) {
    for (const step of job.steps) {
      if (step.type !== "human") continue;

      if (step.prompt === undefined || step.prompt.trim().length === 0) {
        throw new ValidationError(
          `Human step "${step.id}" in job "${jobName}" requires a non-empty "prompt" field`,
          { details: { job: jobName, step: step.id, missingField: "prompt" } }
        );
      }

      if (step.expose !== undefined) {
        throw new ValidationError(
          `Human step "${step.id}" in job "${jobName}" must not declare "expose"`,
          { details: { job: jobName, step: step.id, forbiddenField: "expose" } }
        );
      }

      if (step.uses !== undefined) {
        throw new ValidationError(
          `Human step "${step.id}" in job "${jobName}" must not declare "uses"`,
          { details: { job: jobName, step: step.id, forbiddenField: "uses" } }
        );
      }

      if (step.run !== undefined) {
        throw new ValidationError(
          `Human step "${step.id}" in job "${jobName}" must not declare "run"`,
          { details: { job: jobName, step: step.id, forbiddenField: "run" } }
        );
      }

      if (step.approvers !== undefined && !Array.isArray(step.approvers)) {
        throw new ValidationError(
          `Human step "${step.id}" in job "${jobName}" has non-array "approvers"`,
          { details: { job: jobName, step: step.id, field: "approvers" } }
        );
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
