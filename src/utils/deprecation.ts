/**
 * Shared deprecation utility for CLI commands.
 *
 * Prints a consistently formatted deprecation warning to stderr when
 * ZIGMA_SUPPRESS_DEPRECATION is not set.
 *
 * Reference: docs/prd.md §17 (CLI commands).
 */

function deprecationEnabled(): boolean {
  const val = process.env["ZIGMA_SUPPRESS_DEPRECATION"];
  return val !== "1" && val !== "true";
}

/**
 * Issue a deprecation warning for a deprecated CLI command.
 *
 * Format: `[DEPRECATED] <command> is deprecated. Use <alternative>. This will be removed in v1.0.`
 *
 * Printed to stderr via console.warn. Suppressed when `ZIGMA_SUPPRESS_DEPRECATION=1` or `true`.
 *
 * The environment variable is read on every call to support dynamic toggling in tests.
 */
export function deprecationWarn(command: string, alternative: string): void {
  if (!deprecationEnabled()) return;
  console.warn(
    `[DEPRECATED] 'zigma-flow ${command}' is deprecated. Use '${alternative}' instead. This will be removed in v1.0.`,
  );
}
