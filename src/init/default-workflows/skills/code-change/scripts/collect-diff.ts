import { execSync } from "node:child_process";

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

const diff = run("git diff HEAD");
const changedFilesRaw = run("git diff --name-only HEAD");
const changed_files = changedFilesRaw ? changedFilesRaw.split("\n").filter(Boolean) : [];

process.stdout.write(
  JSON.stringify({ changed_files, diff }, null, 2) + "\n"
);
