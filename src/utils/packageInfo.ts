import { createRequire } from "node:module";

export interface PackageInfo {
  name: "zigma-flow";
  version: string;
}

const require = createRequire(import.meta.url);

/**
 * Resolve the package metadata at runtime rather than relying only on the
 * build-time version define. This keeps a previously built dist/cli.js from
 * reporting a stale version after the package metadata has changed.
 *
 * The two paths cover both source execution (src/utils/packageInfo.ts) and
 * bundled execution (dist/cli.js). The environment value remains a fallback
 * for embedders that do not ship package.json alongside the runtime.
 */
function readPackageVersion(): string | undefined {
  for (const packagePath of ["../package.json", "../../package.json"]) {
    try {
      const packageJson = require(packagePath) as { version?: unknown };
      if (typeof packageJson.version === "string" && packageJson.version.trim() !== "") {
        return packageJson.version;
      }
    } catch {
      // Try the source/bundled alternative before falling back to the build
      // environment value below.
    }
  }
  return undefined;
}

export function getPackageInfo(): PackageInfo {
  return {
    name: "zigma-flow",
    version: readPackageVersion() ?? process.env.ZIGMA_FLOW_VERSION ?? "0.0.0",
  };
}
