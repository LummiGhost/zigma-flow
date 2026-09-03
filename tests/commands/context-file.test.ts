/** CallerContextV1 schema tests for the Core-to-Flow context-file boundary. */

import { describe, expect, it } from "vitest";

import {
  CALLER_CONTEXT_CONTRACT_VERSION,
  validateCallerContext,
} from "../../src/caller-context.js";

const VALID_CONTEXT_V1 = {
  contractVersion: CALLER_CONTEXT_CONTRACT_VERSION,
  actor: { type: "service", id: "zigma-core", displayName: "Zigma Core" },
  capabilities: ["task:start", "workflow:invoke"],
  constraints: {
    repositoryIds: ["repo-1"],
    workflowRefs: ["code-change"],
    toolNames: ["git", "npm"],
    branchPatterns: ["zigma/*"],
    maxRunDurationMs: 3_600_000,
  },
  source: { kind: "api", metadata: { requestId: "request-1" } },
  taskId: "task-1",
  flowRunId: "flow-run-1",
  projectId: "project-1",
  permissionSnapshotId: "snapshot-1",
  integrityHash: "sha256:abc123",
};

describe("validateCallerContext (CallerContextV1)", () => {
  it("accepts and preserves the canonical Core-to-Flow v1 envelope", () => {
    const result = validateCallerContext(VALID_CONTEXT_V1);

    expect(result).toEqual(VALID_CONTEXT_V1);
  });

  it("accepts all documented optional correlation and workspace fields", () => {
    const result = validateCallerContext({
      ...VALID_CONTEXT_V1,
      operationId: "flow:start:1",
      callbackCorrelationId: "command-1",
      coreCallbackUrl: "http://127.0.0.1:4736/v1",
      baseRef: "main",
      repository: {
        id: "repo-1",
        provider: "github",
        url: "https://example.test/owner/repo.git",
        defaultRef: "main",
        writable: true,
        metadata: {},
      },
      workspacePolicy: {
        provider: "zigma-workspace-cli",
        mode: "writable",
        branchTemplate: "zigma/{taskId}",
        cleanup: "manual",
        snapshotOnTerminal: true,
      },
    });

    expect(result.operationId).toBe("flow:start:1");
    expect(result.repository?.provider).toBe("github");
    expect(result.workspacePolicy?.mode).toBe("writable");
  });

  it("rejects unversioned legacy user/project context files", () => {
    expect(() => validateCallerContext({
      user: { id: "u1", name: "Alice", email: "alice@example.test" },
      actor: { type: "user", id: "u1" },
      source: { system: "zigma-host", version: "1.0.0" },
      permissions: ["workflow:invoke"],
      project: { id: "project-1", scope: "local" },
    })).toThrow("contractVersion must be 1");
  });

  it("rejects an unsupported future contract version", () => {
    expect(() => validateCallerContext({ ...VALID_CONTEXT_V1, contractVersion: 2 }))
      .toThrow("contractVersion must be 1");
  });

  it.each([
    "actor",
    "capabilities",
    "constraints",
    "source",
    "taskId",
    "flowRunId",
    "projectId",
    "permissionSnapshotId",
    "integrityHash",
  ])("fails closed when required field %s is missing", (field) => {
    const withoutField: Record<string, unknown> = { ...VALID_CONTEXT_V1 };
    delete withoutField[field];
    expect(() => validateCallerContext(withoutField)).toThrow("required");
  });

  it("rejects malformed constraints instead of filtering or defaulting them", () => {
    expect(() => validateCallerContext({
      ...VALID_CONTEXT_V1,
      constraints: { ...VALID_CONTEXT_V1.constraints, toolNames: ["git", 42] },
    })).toThrow("toolNames");
  });

  it("rejects null snapshot evidence", () => {
    expect(() => validateCallerContext({ ...VALID_CONTEXT_V1, permissionSnapshotId: null }))
      .toThrow("permissionSnapshotId");
    expect(() => validateCallerContext({ ...VALID_CONTEXT_V1, integrityHash: null }))
      .toThrow("integrityHash");
  });
});
