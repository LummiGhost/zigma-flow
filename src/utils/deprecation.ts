/**
 * Shared deprecation utility.
 *
 * Prints consistently formatted deprecation warnings to stderr via console.warn.
 * Supports the `ZIGMA_SUPPRESS_DEPRECATION` environment variable — when set to
 * "1" or "true", all deprecation warnings are silently suppressed.
 *
 * Format (with alternative): `[DEPRECATED] <message>. Use <alternative>. This will be removed in v1.0.`
 * Format (without alternative): prints message as-is (for pre-formatted warnings).
 */

function deprecationEnabled(): boolean {
  const val = process.env["ZIGMA_SUPPRESS_DEPRECATION"];
  return val !== "1" && val !== "true";
}

/**
 * Emit a deprecation warning to stderr if not suppressed.
 *
 * @param message   - Description of the deprecated feature/field/command.
 * @param alternative - The recommended replacement. When provided, the message
 *                      is formatted as `[DEPRECATED] <message>. Use <alternative>. ...`
 *                      When omitted, the message is printed as-is (for pre-formatted warnings).
 * @param removalVersion - The version when the feature will be removed (default "v1.0").
 */
export function deprecationWarn(
  message: string,
  alternative?: string,
  removalVersion: string = "v1.0",
): void {
  if (!deprecationEnabled()) return;

  if (alternative) {
    console.warn(`[DEPRECATED] ${message}. Use ${alternative}. This will be removed in ${removalVersion}.`);
  } else {
    console.warn(message);
  }
}
