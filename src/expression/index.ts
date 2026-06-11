/**
 * Minimum expression resolver for Zigma Flow workflow templates.
 *
 * Supports substitution of:
 *   - ${{ inputs.<key> }}  — from ctx.inputs[key]
 *   - ${{ run.id }}        — from ctx.run.id
 *   - ${{ run.workflow }}  — from ctx.run.workflow
 *
 * Unknown patterns (e.g. ${{ jobs.x.outputs.y }}) pass through unchanged.
 *
 * Reference: docs/phases/p5-context-prompt/workflows/wf-p5-context/01-cases-and-tests.md
 * WF-P5-CONTEXT Step 2.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExpressionContext {
  inputs: Record<string, string>;
  run: { id: string; workflow: string };
  retry?: { inputs: Record<string, string> };
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

    // Unknown pattern — pass through unchanged.
    return fullMatch;
  });
}
