import { pathToFileURL } from "node:url";

import { getPackageInfo } from "./utils/index.js";

export async function main(argv: string[] = process.argv): Promise<void> {
  const [, , ...args] = argv;
  const packageInfo = getPackageInfo();

  if (args.includes("--version") || args.includes("-V")) {
    console.log(packageInfo.version);
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        `${packageInfo.name} ${packageInfo.version}`,
        "",
        "Usage:",
        "  zigma-flow [--help] [--version]",
        "",
        "P1.1 provides the TypeScript CLI skeleton. Full commands are implemented in later Project items."
      ].join("\n")
    );
  }
}

const entryPointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;

if (entryPointUrl === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
