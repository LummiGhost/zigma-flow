# Zigma Flow Error Code Reference

**Version:** 0.4.0
**Status:** Stable (exit codes frozen as of v0.4.0; will not change in minor or patch releases)

## Overview

Zigma Flow uses typed error classes (subclasses of `ZigmaFlowError`) to signal failure conditions. Every error class has a **stable exit code** that scripts and automation can rely on. Exit codes follow semantic versioning: they may be added in minor releases but never changed or removed in patch or minor releases.

## Error Code Taxonomy

### Input and Configuration (2-5)

| Exit Code | Error Class         | Kind              | Description                                                              |
|-----------|---------------------|-------------------|--------------------------------------------------------------------------|
| 2         | `UserInputError`    | `UserInputError`  | Invalid or missing user input (wrong flags, ambiguous options, etc.)     |
| 4         | `ConfigError`       | `ConfigError`      | Missing or invalid configuration (`config.json`, active run, etc.)      |
| 5         | `FilesystemError`   | `FilesystemError`  | File I/O failure (read, write, directory not found, permission denied)   |

### Definition and Validation (10-14)

| Exit Code | Error Class         | Kind                | Description                                                              |
|-----------|---------------------|---------------------|--------------------------------------------------------------------------|
| 10        | `ValidationError`   | `ValidationError`   | Schema or data validation failure (YAML, JSON, report, condition)        |
| 11        | `WorkflowError`     | `WorkflowError`     | Workflow definition error (duplicate IDs, invalid step, missing job)     |
| 12        | `SkillPackError`    | `SkillPackError`    | Skill pack definition or resolution error                                |
| 13        | `PromptBuildError`  | `PromptBuildError`  | Prompt generation or quality gate failure                                |
| 14        | `PermissionError`   | `PermissionError`   | Permission denied (file access, variable write, context block write)     |

### Runtime Execution (20-23)

| Exit Code | Error Class         | Kind              | Description                                                              |
|-----------|---------------------|-------------------|--------------------------------------------------------------------------|
| 20        | `StateError`        | `StateError`      | Runtime state violation (missing state, wrong job status, invalid state) |
| 21        | `ScriptError`       | `ScriptError`     | Script step execution failure (non-zero exit, timeout, signal)           |
| 22        | `CheckError`        | `CheckError`      | Check step execution failure                                             |
| 23        | `RouterError`       | `RouterError`     | Router execution failure (unrecognized action, no matching case)         |

### Output and Artifacts (30)

| Exit Code | Error Class         | Kind              | Description                                                              |
|-----------|---------------------|-------------------|--------------------------------------------------------------------------|
| 30        | `ArtifactError`     | `ArtifactError`   | Artifact resolution or access failure (missing path, invalid reference)  |

## Exit Code Stability Guarantee

- Exit codes **will not change** between minor or patch versions (semver).
- New error classes with new exit codes **may** be added in minor releases.
- Exit codes are **never removed**; deprecated classes retain their code.
- The exit code `1` is reserved for unhandled exceptions and non-ZigmaFlowError failures.

## Error Output Format

When a `ZigmaFlowError` is caught by the CLI entry point, it is printed to stderr in the following structured format:

```
Error [<Kind>]: <message>
  Exit code: <N>
  ...context lines (runId, jobId, stepId, artifactPath -- only when available)...
  Suggestion: <actionable suggestion with CLI command>
```

### Example

```
Error [ConfigError]: No active run found.
  Exit code: 4
  Suggestion: Run `zigma-flow run <workflow> --task <task>` to create a new run.
```

### Example with full context

```
Error [ScriptError]: Script step failed with exit code 2.
  Exit code: 21
  Run: run-20260709-abc123
  Job:  static-check
  Step: typecheck
  Suggestion: Review the script output above. Fix errors and re-run with `zigma-flow step --job static-check`.
```

## Context Fields

When available, the error output includes:

| Field       | Detail Key     | Description                                  |
|-------------|----------------|----------------------------------------------|
| `Run`       | `runId`        | The workflow run identifier                  |
| `Job`       | `jobId`        | The job identifier within the run            |
| `Step`      | `stepId`       | The step identifier within the job           |
| `Artifact`  | `artifactPath` | The artifact file path                       |
| `Suggestion`| `suggestion`   | Actionable remediation (often a CLI command) |

These fields are only printed when the throwing code provides them in the `details` option.
