/**
 * Init module — filesystem helpers and runInit orchestrator.
 *
 * Reference: docs/prd.md FR-001, §16 (data dir design).
 * Module boundaries: must NOT import engine, workflow, skill-pack, dag, context,
 * prompt, script, check, artifact, run, events, workspace, git, or expression.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getPackageInfo } from "../utils/index.js";
import {
  codeChangeWorkflowYml,
  codeChangeFastWorkflowYml,
  codeMapMd,
  architectureDesignMd,
  codingGuidelinesMd,
  collectDiffTs,
  commonFailurePatternsMd,
  configJsonTemplate,
  forbiddenPathsYml,
  implementMd,
  intakeMd,
  planMd,
  reportSchemaJson,
  reviewMd,
  skillLockJsonTemplate,
  skillYml,
  summarizeMd,
  workflowGuideMd
} from "./templates.js";

import { detectEnvironment } from "./detect.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WriteFileResult {
  readonly path: string;
  readonly status: "created" | "updated" | "skipped";
}

export interface CreateDirectoryResult {
  readonly path: string;
  readonly status: "created" | "skipped";
}

export interface RunInitOptions {
  readonly cwd: string;
}

export interface RunInitSummary {
  readonly alreadyInitialized: boolean;
  readonly directories: ReadonlyArray<CreateDirectoryResult>;
  readonly files: ReadonlyArray<WriteFileResult>;
}

// ---------------------------------------------------------------------------
// createDirectories
// ---------------------------------------------------------------------------

/**
 * For each path: check existence first, then mkdir if needed.
 * Returns "created" if the directory was newly created, "skipped" if it
 * already existed.
 */
export async function createDirectories(
  paths: ReadonlyArray<string>
): Promise<ReadonlyArray<CreateDirectoryResult>> {
  const results: CreateDirectoryResult[] = [];

  for (const dirPath of paths) {
    const preExisted = await directoryExists(dirPath);

    if (preExisted) {
      results.push({ path: dirPath, status: "skipped" });
    } else {
      await mkdir(dirPath, { recursive: true });
      results.push({ path: dirPath, status: "created" });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// writeFileIfMissing
// ---------------------------------------------------------------------------

export async function writeFileIfMissing(
  path: string,
  contents: string
): Promise<WriteFileResult> {
  try {
    await stat(path);
    // stat succeeded → file exists → skip
    return { path, status: "skipped" };
  } catch {
    // stat threw → file does not exist → create it
    await writeFile(path, contents, "utf-8");
    return { path, status: "created" };
  }
}

// ---------------------------------------------------------------------------
// runInit
// ---------------------------------------------------------------------------

export async function runInit(options: RunInitOptions): Promise<RunInitSummary> {
  const dotZigma = join(options.cwd, ".zigma-flow");
  const configJsonPath = join(dotZigma, "config.json");

  // Check if already initialized (config.json already present)
  let alreadyInitialized = false;
  try {
    await stat(configJsonPath);
    alreadyInitialized = true;
  } catch {
    // not initialized yet
  }

  // Directories to create
  const dirPaths = [
    dotZigma,
    join(dotZigma, "workflows"),
    join(dotZigma, "skills"),
    join(dotZigma, "skills", "code-change"),
    join(dotZigma, "skills", "code-change", "knowledge"),
    join(dotZigma, "skills", "code-change", "prompts"),
    join(dotZigma, "skills", "code-change", "scripts"),
    join(dotZigma, "skills", "code-change", "checks"),
    join(dotZigma, "runs")
  ];

  const directories = await createDirectories(dirPaths);

  // Detect project environment for tailored template generation
  const detection = await detectEnvironment(options.cwd);

  // Generate template content
  const version = getPackageInfo().version;
  const skillYmlContent = skillYml();

  // Files to write (in order)
  const fileEntries: Array<[string, string]> = [
    [configJsonPath, configJsonTemplate(version)],
    [join(dotZigma, "skill-lock.json"), skillLockJsonTemplate(skillYmlContent)],
    [join(dotZigma, "workflows", "code-change.yml"), codeChangeWorkflowYml(detection)],
    [join(dotZigma, "workflows", "code-change-fast.yml"), codeChangeFastWorkflowYml()],
    [join(dotZigma, "skills", "code-change", "skill.yml"), skillYmlContent],
    [
      join(dotZigma, "skills", "code-change", "knowledge", "coding-guidelines.md"),
      codingGuidelinesMd()
    ],
    [
      join(dotZigma, "skills", "code-change", "knowledge", "workflow-guide.md"),
      workflowGuideMd()
    ],
    [
      join(dotZigma, "skills", "code-change", "knowledge", "common-failure-patterns.md"),
      commonFailurePatternsMd()
    ],
    [join(dotZigma, "skills", "code-change", "prompts", "intake.md"), intakeMd()],
    [join(dotZigma, "skills", "code-change", "prompts", "code-map.md"), codeMapMd()],
    [join(dotZigma, "skills", "code-change", "prompts", "plan.md"), planMd()],
    [
      join(dotZigma, "skills", "code-change", "prompts", "architecture-design.md"),
      architectureDesignMd()
    ],
    [join(dotZigma, "skills", "code-change", "prompts", "implement.md"), implementMd()],
    [join(dotZigma, "skills", "code-change", "prompts", "review.md"), reviewMd()],
    [join(dotZigma, "skills", "code-change", "prompts", "summarize.md"), summarizeMd()],
    [join(dotZigma, "skills", "code-change", "scripts", "collect-diff.ts"), collectDiffTs()],
    [
      join(dotZigma, "skills", "code-change", "checks", "report-schema.json"),
      reportSchemaJson()
    ],
    [
      join(dotZigma, "skills", "code-change", "checks", "forbidden-paths.yml"),
      forbiddenPathsYml()
    ]
  ];

  const files: WriteFileResult[] = [];
  for (const [filePath, content] of fileEntries) {
    const result = await writeFileIfMissing(filePath, content);
    files.push(result);
  }
  files.push(await ensureZigmaFlowGitignore(options.cwd));

  return {
    alreadyInitialized,
    directories,
    files
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

const zigmaFlowGitignoreComment = "# Zigma Flow runtime state (do not commit)";
const zigmaFlowGitignoreEntries = [".zigma-flow/runs/", ".zigma-flow/config.json"] as const;

async function ensureZigmaFlowGitignore(cwd: string): Promise<WriteFileResult> {
  const gitignorePath = join(cwd, ".gitignore");
  const defaultBlock = [
    zigmaFlowGitignoreComment,
    ...zigmaFlowGitignoreEntries
  ].join("\n") + "\n";

  let existing: string;
  try {
    existing = await readFile(gitignorePath, "utf-8");
  } catch (error: unknown) {
    if (isNodeErrnoException(error) && error.code === "ENOENT") {
      await writeFile(gitignorePath, defaultBlock, "utf-8");
      return { path: gitignorePath, status: "created" };
    }
    throw error;
  }

  const existingLines = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const missingEntries = zigmaFlowGitignoreEntries.filter(
    (entry) => !existingLines.includes(entry)
  );

  if (missingEntries.length === 0) {
    return { path: gitignorePath, status: "skipped" };
  }

  const appendLines = existingLines.includes(zigmaFlowGitignoreComment)
    ? missingEntries
    : [zigmaFlowGitignoreComment, ...missingEntries];
  const base = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  const separator = base.length === 0 || base.endsWith("\n\n") ? "" : "\n";
  await writeFile(gitignorePath, `${base}${separator}${appendLines.join("\n")}\n`, "utf-8");
  return { path: gitignorePath, status: "updated" };
}

function isNodeErrnoException(error: unknown): error is { readonly code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
