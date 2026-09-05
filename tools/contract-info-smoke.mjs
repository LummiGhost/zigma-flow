import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, "dist", "cli.js");
if (!existsSync(cliPath)) {
  throw new Error(`Built CLI not found: ${cliPath}. Run pnpm build first.`);
}

const tempDir = mkdtempSync(join(tmpdir(), "zigma-flow-contract-info-blackbox-"));
try {
  const before = readdirSync(tempDir);
  const stdout = execFileSync(process.execPath, [cliPath, "contract-info", "--json"], {
    cwd: tempDir,
    encoding: "utf8",
    env: { ...process.env, ZIGMA_FLOW_VERSION: "0.0.0-stale-build-value" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed.split(/\r?\n/).length !== 1) {
    throw new Error(`contract-info must emit exactly one JSON line, got: ${JSON.stringify(stdout)}`);
  }
  const envelope = JSON.parse(stdout);
  const packageJson = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(join(repoRoot, "package.json"), "utf8")));
  if (envelope.contractVersion !== 1 || envelope.provider !== "zigma-flow") {
    throw new Error(`Unexpected contract-info envelope: ${stdout}`);
  }
  if (envelope.packageVersion !== packageJson.version) {
    throw new Error(`packageVersion ${envelope.packageVersion} does not match package.json ${packageJson.version}`);
  }
  for (const capability of ["caller-context-v1", "invoke-json-v1", "context-freeze-v1", "run-inspect-v1"]) {
    if (!envelope.capabilities.includes(capability)) {
      throw new Error(`Missing advertised capability: ${capability}`);
    }
  }
  if (JSON.stringify(readdirSync(tempDir)) !== JSON.stringify(before)) {
    throw new Error("contract-info created files in the caller working directory");
  }

  let unknownFailed = false;
  try {
    execFileSync(process.execPath, [cliPath, "contract-info", "--unknown"], {
      cwd: tempDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    unknownFailed = true;
  }
  if (!unknownFailed) throw new Error("unknown contract-info option unexpectedly succeeded");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("contract-info black-box smoke passed");
