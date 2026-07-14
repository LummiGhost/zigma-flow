/**
 * Deprecation warning utility.
 *
 * Prints consistent-format deprecation warnings to stderr (via console.warn).
 * Supports the `ZIGMA_SUPPRESS_DEPRECATION` environment variable — when set to
 * any non-empty value, all deprecation warnings are silently suppressed.
 *
 * Format: `[DEPRECATED] <message>. Use <alternative>. This will be removed in v1.0.`
 */

const SUPPRESS_KEY = "ZIGMA_SUPPRESS_DEPRECATION";

/**
 * Emit a deprecation warning to stderr if not suppressed.
 *
 * @param message   - Description of the deprecated feature/field/command.
 * @param alternative - The recommended replacement (omitted when empty).
 * @param removalVersion - The version when the feature will be removed (default "v1.0").
 */
export function deprecationWarn(
  message: string,
  alternative?: string,
  removalVersion: string = "v1.0",
): void {
  if (process.env[SUPPRESS_KEY]) return;

  if (alternative) {
    console.warn(`[DEPRECATED] ${message}. Use ${alternative}. This will be removed in ${removalVersion}.`);
  } else {
    console.warn(message);
  }
}
