/**
 * Step 1 (Cases and Tests) interface stubs for the MVP error taxonomy.
 *
 * Reference: docs/mvp-contracts.md §7. Concrete `details` / `suggestion` / `exitCode`
 * behavior is implemented in Step 2; runtime instantiation here is intentionally
 * minimal so test files can compile.
 */

export type ZigmaFlowErrorKind =
  | "UserInputError"
  | "ValidationError"
  | "WorkflowError"
  | "SkillPackError"
  | "StateError"
  | "FilesystemError"
  | "ScriptError"
  | "CheckError"
  | "PermissionError"
  | "ArtifactError"
  | "ConfigError";

export interface ZigmaFlowErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly suggestion?: string;
  readonly cause?: unknown;
}

export class ZigmaFlowError extends Error {
  public readonly kind: ZigmaFlowErrorKind;
  public readonly details: Record<string, unknown> | undefined;
  public readonly suggestion: string | undefined;
  public readonly exitCode: number;

  public constructor(
    kind: ZigmaFlowErrorKind,
    message: string,
    exitCode: number,
    options: ZigmaFlowErrorOptions = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.details = options.details;
    this.suggestion = options.suggestion;
    this.exitCode = exitCode;
    this.name = kind;
  }
}

export class UserInputError extends ZigmaFlowError {
  public constructor(message: string, options: ZigmaFlowErrorOptions = {}) {
    super("UserInputError", message, 2, options);
  }
}

export class ValidationError extends ZigmaFlowError {
  public constructor(message: string, options: ZigmaFlowErrorOptions = {}) {
    super("ValidationError", message, 3, options);
  }
}

export class ConfigError extends ZigmaFlowError {
  public constructor(message: string, options: ZigmaFlowErrorOptions = {}) {
    super("ConfigError", message, 4, options);
  }
}

export class FilesystemError extends ZigmaFlowError {
  public constructor(message: string, options: ZigmaFlowErrorOptions = {}) {
    super("FilesystemError", message, 5, options);
  }
}

export class SkillPackError extends ZigmaFlowError {
  public constructor(message: string, options: ZigmaFlowErrorOptions = {}) {
    super("SkillPackError", message, 3, options);
  }
}

export class WorkflowError extends ZigmaFlowError {
  public constructor(message: string, options: ZigmaFlowErrorOptions = {}) {
    super("WorkflowError", message, 3, options);
  }
}

export class ArtifactError extends ZigmaFlowError {
  public constructor(message: string, options: ZigmaFlowErrorOptions = {}) {
    super("ArtifactError", message, 1, options);
  }
}

export class StateError extends ZigmaFlowError {
  public constructor(message: string, options: ZigmaFlowErrorOptions = {}) {
    super("StateError", message, 1, options);
  }
}
