/**
 * Minimum expression resolver for Zigma Flow workflow templates.
 *
 * Supports substitution of:
 *   - ${{ inputs.<key> }}  — from ctx.inputs[key]
 *   - ${{ run.id }}        — from ctx.run.id
 *   - ${{ run.workflow }}  — from ctx.run.workflow
 *   - ${{ retry.inputs.<key> }} — from ctx.retry?.inputs[key]
 *   - ${{ variables.<name> }}  — from ctx.variables?[name]
 *   - ${{ jobs.<id>.outputs.<key> }} — from ctx.jobs?[id].outputs?[key]
 *   - ${{ steps.<id>.outputs.<key> }} — from ctx.steps?[id].outputs?[key]
 *
 * Unknown patterns are left unchanged.
 *
 * Also exports `evaluateCondition` for boolean condition evaluation.
 *
 * Reference: docs/phases/p5-context-prompt/workflows/wf-p5-context/01-cases-and-tests.md
 * WF-P5-CONTEXT Step 2; WF-P13-VARIABLES Step 2.
 */

import { ValidationError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExpressionContext {
  inputs: Record<string, string>;
  run: { id: string; workflow: string };
  retry?: { inputs: Record<string, string> };
  variables?: Record<string, unknown>;
  jobs?: Record<string, { outputs?: Record<string, unknown> }>;
  steps?: Record<string, { outputs?: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------
// resolveExpression
// ---------------------------------------------------------------------------

/**
 * Replace all `${{ ... }}` template tokens in the given template string
 * using the provided context.
 *
 * - Whitespace inside `${{ ... }}` is trimmed before pattern matching.
 * - Unknown patterns are left unchanged (no throw).
 * - Missing input keys are left as-is (no substitution).
 */
export function resolveExpression(template: string, ctx: ExpressionContext): string {
  if (template.length === 0) return "";

  // Match ${{ ... }} tokens, tolerating leading/trailing whitespace inside
  // the braces. Capture group 1 is the trimmed inner expression.
  const TOKEN_RE = /\$\{\{\s*([^}]*?)\s*\}\}/g;

  return template.replace(TOKEN_RE, (fullMatch, inner: string) => {
    const expr = inner.trim();

    // ${{ run.id }}
    if (expr === "run.id") {
      return ctx.run.id;
    }

    // ${{ run.workflow }}
    if (expr === "run.workflow") {
      return ctx.run.workflow;
    }

    // ${{ inputs.<key> }}
    if (expr.startsWith("inputs.")) {
      const key = expr.slice("inputs.".length);
      if (key.length > 0 && Object.prototype.hasOwnProperty.call(ctx.inputs, key)) {
        return ctx.inputs[key]!;
      }
      // Key missing from ctx.inputs — leave literal.
      return fullMatch;
    }

    // ${{ retry.inputs.<key> }}
    if (expr.startsWith("retry.inputs.")) {
      const key = expr.slice("retry.inputs.".length);
      if (
        key.length > 0 &&
        ctx.retry !== undefined &&
        Object.prototype.hasOwnProperty.call(ctx.retry.inputs, key)
      ) {
        return ctx.retry.inputs[key]!;
      }
      return fullMatch;
    }

    // ${{ variables.<name> }}  (WF-P13-VARIABLES)
    // Also handles ${{ variables.<name> <rest> }} patterns where additional
    // expression content follows the variable name (e.g. ${{ variables.x == 'ready' }}).
    if (expr.startsWith("variables.")) {
      const afterVar = expr.slice("variables.".length);
      // Split on whitespace to extract variable name and any remaining expression
      const parts = afterVar.split(/\s+/);
      const varName = parts[0]!;
      const rest = parts.slice(1).join(" ");
      if (
        varName.length > 0 &&
        ctx.variables !== undefined &&
        Object.prototype.hasOwnProperty.call(ctx.variables, varName)
      ) {
        const val = ctx.variables[varName];
        const resolved = val !== undefined ? String(val) : fullMatch;
        return rest.length > 0 ? `${resolved} ${rest}` : resolved;
      }
      return fullMatch;
    }

    // ${{ jobs.<id>.outputs.<key> }}  (WF-P13-VARIABLES, TD-P9-001)
    if (expr.startsWith("jobs.")) {
      const afterJobs = expr.slice("jobs.".length);
      const parts = afterJobs.split(".");
      // Expected: <id>.outputs.<key>
      if (parts.length >= 3 && parts[1] === "outputs") {
        const jobId = parts[0]!; // non-null: length >= 3 guarantees parts[0] exists
        const key = parts.slice(2).join(".");
        if (
          ctx.jobs !== undefined &&
          Object.prototype.hasOwnProperty.call(ctx.jobs, jobId) &&
          ctx.jobs[jobId]?.outputs !== undefined &&
          Object.prototype.hasOwnProperty.call(ctx.jobs[jobId]!.outputs, key)
        ) {
          const val = ctx.jobs[jobId]!.outputs![key];
          return val !== undefined ? String(val) : fullMatch;
        }
      }
      return fullMatch;
    }

    // ${{ steps.<id>.outputs.<key> }}  (WF-P13-VARIABLES, TD-P9-002)
    if (expr.startsWith("steps.")) {
      const afterSteps = expr.slice("steps.".length);
      const parts = afterSteps.split(".");
      // Expected: <id>.outputs.<key>
      if (parts.length >= 3 && parts[1] === "outputs") {
        const stepId = parts[0]!; // non-null: length >= 3 guarantees parts[0] exists
        const key = parts.slice(2).join(".");
        if (
          ctx.steps !== undefined &&
          Object.prototype.hasOwnProperty.call(ctx.steps, stepId) &&
          ctx.steps[stepId]?.outputs !== undefined &&
          Object.prototype.hasOwnProperty.call(ctx.steps[stepId]!.outputs, key)
        ) {
          const val = ctx.steps[stepId]!.outputs![key];
          return val !== undefined ? String(val) : fullMatch;
        }
      }
      return fullMatch;
    }

    // Unknown pattern — pass through unchanged.
    return fullMatch;
  });
}

// ---------------------------------------------------------------------------
// evaluateCondition
// ---------------------------------------------------------------------------

/**
 * Evaluate a boolean condition expression with variable substitution.
 *
 * Steps:
 *   1. Resolve all `${{ }}` tokens in the expression using resolveExpression.
 *   2. Evaluate the resulting string as a boolean expression.
 *
 * Supported operators (in precedence order, lowest to highest):
 *   - `||` logical OR
 *   - `&&` logical AND
 *   - `==` equality, `!=` inequality
 *   - `!` logical NOT (prefix)
 *   - Parentheses for grouping: `(`, `)`
 *
 * String literals in single quotes: `'value'`
 * Bare identifiers are looked up in ctx.variables.
 * Numbers (integers) are supported.
 * Boolean literals: `true`, `false`.
 *
 * Truthy: non-empty string that is not "false", "0", "null", or "undefined".
 *
 * Throws ValidationError for empty expressions or invalid syntax.
 * No eval() or new Function() is used.
 */
export function evaluateCondition(expr: string, ctx: ExpressionContext): boolean {
  // First resolve all template tokens in the expression
  const resolved = resolveExpression(expr, ctx);

  // FR-EXPR-VAR-010: reject bare non-boolean expressions (single ident or number without operators)
  const trimmed = resolved.trim();
  if ((/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(trimmed) && !["true", "false"].includes(trimmed)) || /^\d+$/.test(trimmed)) {
    throw new ValidationError(
      `Expression "${trimmed}" is not a boolean condition — use comparison operators (==, !=, &&, ||, !)`,
      { details: { expression: expr, resolved: trimmed } }
    );
  }

  // Tokenize and parse
  const tokens = tokenize(resolved);
  if (tokens.length === 0) {
    throw new ValidationError("Empty condition expression", {
      details: { expression: expr },
    });
  }

  const parser = new Parser(tokens, ctx);
  const result = parser.parseExpression();

  if (parser.hasMore()) {
    throw new ValidationError("Unexpected tokens in condition expression", {
      details: { expression: expr, remaining: tokens.slice(parser.pos).map(t => t.value) },
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType = "paren" | "op" | "ident" | "string" | "number" | "boolean" | "end";

interface Token {
  type: TokenType;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i]!)) {
      i++;
      continue;
    }

    // Parentheses
    if (input[i] === "(" || input[i] === ")") {
      tokens.push({ type: "paren" as const, value: input[i]! });
      i++;
      continue;
    }

    // String literals in single quotes
    if (input[i] === "'") {
      let j = i + 1;
      let str = "";
      while (j < input.length && input[j] !== "'") {
        str += input[j];
        j++;
      }
      if (j >= input.length) {
        throw new ValidationError("Unterminated string literal in condition expression", {
          details: { expression: input },
        });
      }
      tokens.push({ type: "string" as const, value: str });
      i = j + 1; // skip closing quote
      continue;
    }

    // Multi-char operators: ==, !=, &&, ||
    if (input[i] === "=" && input[i + 1] === "=") {
      tokens.push({ type: "op" as const, value: "==" });
      i += 2;
      continue;
    }
    if (input[i] === "!" && input[i + 1] === "=") {
      tokens.push({ type: "op" as const, value: "!=" });
      i += 2;
      continue;
    }
    if (input[i] === "&" && input[i + 1] === "&") {
      tokens.push({ type: "op" as const, value: "&&" });
      i += 2;
      continue;
    }
    if (input[i] === "|" && input[i + 1] === "|") {
      tokens.push({ type: "op" as const, value: "||" });
      i += 2;
      continue;
    }

    // Single-char operators: !
    if (input[i] === "!") {
      tokens.push({ type: "op" as const, value: "!" });
      i++;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(input[i]!)) {
      let num = "";
      while (i < input.length && /[0-9]/.test(input[i]!)) {
        num += input[i];
        i++;
      }
      tokens.push({ type: "number" as const, value: num });
      continue;
    }

    // Identifiers and boolean literals
    if (/[a-zA-Z_]/.test(input[i]!)) {
      let ident = "";
      while (i < input.length && /[a-zA-Z_0-9]/.test(input[i]!)) {
        ident += input[i];
        i++;
      }
      if (ident === "true" || ident === "false") {
        tokens.push({ type: "boolean" as const, value: ident });
      } else {
        tokens.push({ type: "ident" as const, value: ident });
      }
      continue;
    }

    // Unknown character
    throw new ValidationError(
      `Unexpected character "${input[i]}" in condition expression`,
      { details: { expression: input, position: i } }
    );
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Recursive-descent parser for boolean expressions
// ---------------------------------------------------------------------------
//
// Grammar (precedence climbing):
//   expression    → or-expression
//   or-expression  → and-expression ("||" and-expression)*
//   and-expression → not-expression ("&&" not-expression)*
//   not-expression → "!" not-expression | comparison
//   comparison     → primary ("==" primary | "!=" primary)?
//   primary        → "(" expression ")" | string | number | boolean | ident
//
// Truthy: non-empty, non-"false", non-"0", non-"null", non-"undefined" string.
// Numbers are truthy if non-zero.

class Parser {
  tokens: Token[];
  pos: number;
  ctx: ExpressionContext;

  constructor(tokens: Token[], ctx: ExpressionContext) {
    this.tokens = tokens;
    this.pos = 0;
    this.ctx = ctx;
  }

  hasMore(): boolean {
    return this.pos < this.tokens.length;
  }

  peek(): Token | null {
    return this.pos < this.tokens.length ? this.tokens[this.pos]! : null;
  }

  consume(type?: TokenType): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) {
      throw new ValidationError("Unexpected end of condition expression", {});
    }
    if (type !== undefined && token.type !== type) {
      throw new ValidationError(
        `Expected ${type} but got ${token.type} ("${token.value}") in condition expression`,
        {}
      );
    }
    this.pos++;
    return token;
  }

  parseExpression(): boolean {
    return this.parseOr();
  }

  parseOr(): boolean {
    let left = this.parseAnd();
    while (this.peek()?.type === "op" && this.peek()!.value === "||") {
      this.consume();
      const right = this.parseAnd();
      left = left || right;
    }
    return left;
  }

  parseAnd(): boolean {
    let left = this.parseNot();
    while (this.peek()?.type === "op" && this.peek()!.value === "&&") {
      this.consume();
      const right = this.parseNot();
      left = left && right;
    }
    return left;
  }

  parseNot(): boolean {
    if (this.peek()?.type === "op" && this.peek()!.value === "!") {
      this.consume();
      const inner = this.parseNot();
      return !inner;
    }
    return this.parseComparison();
  }

  parseComparison(): boolean {
    const left = this.parsePrimary();

    const op = this.peek();
    if (op?.type === "op" && (op.value === "==" || op.value === "!=")) {
      this.consume();
      const right = this.parsePrimary();
      const leftVal = resolveValue(left, this.ctx);
      const rightVal = resolveValue(right, this.ctx);
      // Compare as strings
      if (op.value === "==") {
        return String(leftVal) === String(rightVal);
      } else {
        return String(leftVal) !== String(rightVal);
      }
    }

    // Bare value (not a comparison) — must coerce to boolean via truthiness
    return isTruthy(resolveValue(left, this.ctx));
  }

  parsePrimary(): Token {
    const tok = this.peek();
    if (tok === null) {
      throw new ValidationError("Unexpected end of expression", {});
    }

    if (tok.type === "paren" && tok.value === "(") {
      this.consume(); // consume (
      const result = this.parseExpression();
      this.consume("paren"); // consume )
      // Return a synthetic boolean token with the result
      return { type: "boolean", value: result ? "true" : "false" };
    }

    if (tok.type === "string" || tok.type === "number" || tok.type === "boolean" || tok.type === "ident") {
      this.consume();
      return tok;
    }

    throw new ValidationError(
      `Unexpected token "${tok.value}" in condition expression`,
      {}
    );
  }
}

// Resolve a token to its actual value (look up identifiers in variables context).
function resolveValue(
  token: Token,
  ctx?: ExpressionContext
): unknown {
  switch (token.type) {
    case "string":
      return token.value;
    case "number":
      return parseInt(token.value, 10);
    case "boolean":
      return token.value === "true";
    case "ident":
      // Look up identifier in ctx.variables first.
      // This allows bare identifiers like `plan_status` to resolve to their
      // variable values without requiring ${{ }} template syntax.
      if (
        ctx?.variables !== undefined &&
        Object.prototype.hasOwnProperty.call(ctx.variables, token.value)
      ) {
        return ctx.variables[token.value];
      }
      // Fall back to token value as string if not found in variables.
      return token.value;
    default:
      return token.value;
  }
}

function isTruthy(val: unknown): boolean {
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") {
    return val.length > 0 && val !== "false" && val !== "0" && val !== "null" && val !== "undefined";
  }
  return val !== null && val !== undefined;
}
