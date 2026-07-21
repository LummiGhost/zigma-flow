/**
 * Caller context validation tests (ISSUE #254).
 *
 * Covers:
 *   - Valid minimal payload accepted
 *   - Valid full payload with all optional fields accepted
 *   - Null / non-object rejected
 *   - Missing required fields rejected
 *   - Wrong types on optional fields rejected
 *   - Invalid callbackConfig.type rejected
 */

import { describe, expect, it } from "vitest";

import { validateCallerContext } from "../../src/caller-context.js";

const VALID_MINIMAL = {
  user: { id: "u1", name: "Alice", email: "alice@example.com" },
  actor: { type: "user" as const, id: "u1" },
  source: { system: "zigma-host", version: "1.0.0" },
  permissions: ["read", "write"],
  project: { id: "proj-1", scope: "default" },
};

const VALID_FULL = {
  ...VALID_MINIMAL,
  coreTaskId: "task-42",
  flowRunId: "flow-run-1",
  permissionSnapshotId: "snap-1",
  permissionSnapshotHash: "abcdef1234567890",
  repository: "owner/repo",
  branch: "main",
  workflow: "ci-build",
  tool: "lint",
  callbackConfig: { type: "webhook" as const, uri: "https://example.com/hooks" },
};

describe("validateCallerContext", () => {
  // ── Valid inputs ───────────────────────────────────────────────────────

  it("accepts a valid minimal payload", () => {
    const result = validateCallerContext(VALID_MINIMAL);
    expect(result.user.id).toBe("u1");
    expect(result.user.name).toBe("Alice");
    expect(result.user.email).toBe("alice@example.com");
    expect(result.actor.type).toBe("user");
    expect(result.actor.id).toBe("u1");
    expect(result.source.system).toBe("zigma-host");
    expect(result.source.version).toBe("1.0.0");
    expect(result.permissions).toEqual(["read", "write"]);
    expect(result.project.id).toBe("proj-1");
    expect(result.project.scope).toBe("default");
  });

  it("accepts a full payload with all optional fields", () => {
    const result = validateCallerContext(VALID_FULL);
    expect(result.coreTaskId).toBe("task-42");
    expect(result.flowRunId).toBe("flow-run-1");
    expect(result.permissionSnapshotId).toBe("snap-1");
    expect(result.permissionSnapshotHash).toBe("abcdef1234567890");
    expect(result.repository).toBe("owner/repo");
    expect(result.branch).toBe("main");
    expect(result.workflow).toBe("ci-build");
    expect(result.tool).toBe("lint");
    expect(result.callbackConfig).toEqual({ type: "webhook", uri: "https://example.com/hooks" });
  });

  it("defaults source.version to '0.0.0' when missing", () => {
    const withoutVersion = { ...VALID_MINIMAL, source: { system: "test" } };
    const result = validateCallerContext(withoutVersion);
    expect(result.source.version).toBe("0.0.0");
  });

  it("defaults project.scope to 'default' when missing", () => {
    const withoutScope = { ...VALID_MINIMAL, project: { id: "p1" } };
    const result = validateCallerContext(withoutScope);
    expect(result.project.scope).toBe("default");
  });

  it("filters non-string permissions", () => {
    const mixed = { ...VALID_MINIMAL, permissions: ["read", 42, "write", null] };
    const result = validateCallerContext(mixed);
    expect(result.permissions).toEqual(["read", "write"]);
  });

  it("accepts actor type 'system'", () => {
    const systemActor = { ...VALID_MINIMAL, actor: { type: "system" as const, id: "sys-1" } };
    const result = validateCallerContext(systemActor);
    expect(result.actor.type).toBe("system");
  });

  it("accepts actor type 'service'", () => {
    const serviceActor = { ...VALID_MINIMAL, actor: { type: "service" as const, id: "svc-1" } };
    const result = validateCallerContext(serviceActor);
    expect(result.actor.type).toBe("service");
  });

  it("accepts callbackConfig type 'none' without uri", () => {
    const withNone = { ...VALID_MINIMAL, callbackConfig: { type: "none" as const } };
    const result = validateCallerContext(withNone);
    expect(result.callbackConfig).toEqual({ type: "none" });
  });

  // ── Rejections — top-level ─────────────────────────────────────────────

  it("rejects null", () => {
    expect(() => validateCallerContext(null)).toThrow("must be a JSON object");
  });

  it("rejects a string primitive", () => {
    expect(() => validateCallerContext("not an object")).toThrow("must be a JSON object");
  });

  it("rejects an array", () => {
    expect(() => validateCallerContext([1, 2, 3])).toThrow("must be a JSON object");
  });

  // ── Rejections — missing required fields ───────────────────────────────

  it("rejects missing user", () => {
    const { user: _, ...rest } = VALID_MINIMAL;
    expect(() => validateCallerContext(rest)).toThrow("must have a 'user' object");
  });

  it("rejects user that is not an object", () => {
    expect(() => validateCallerContext({ ...VALID_MINIMAL, user: "alice" }))
      .toThrow("must have a 'user' object");
  });

  it("rejects missing user.id", () => {
    expect(() => validateCallerContext({ ...VALID_MINIMAL, user: { name: "x", email: "x@y.com" } }))
      .toThrow("'user.id' is required");
  });

  it("rejects missing user.name", () => {
    expect(() => validateCallerContext({ ...VALID_MINIMAL, user: { id: "u1", email: "x@y.com" } }))
      .toThrow("'user.name' is required");
  });

  it("rejects missing user.email", () => {
    expect(() => validateCallerContext({ ...VALID_MINIMAL, user: { id: "u1", name: "x" } }))
      .toThrow("'user.email' is required");
  });

  it("rejects missing actor", () => {
    const { actor: _, ...rest } = VALID_MINIMAL;
    expect(() => validateCallerContext(rest)).toThrow("must have an 'actor' object");
  });

  it("rejects invalid actor.type", () => {
    expect(() =>
      validateCallerContext({ ...VALID_MINIMAL, actor: { type: "bot", id: "b1" } }),
    ).toThrow("'actor.type' must be");
  });

  it("rejects missing actor.id", () => {
    expect(() =>
      validateCallerContext({ ...VALID_MINIMAL, actor: { type: "user" } }),
    ).toThrow("'actor.id' is required");
  });

  it("rejects missing source", () => {
    const { source: _, ...rest } = VALID_MINIMAL;
    expect(() => validateCallerContext(rest)).toThrow("must have a 'source' object");
  });

  it("rejects missing source.system", () => {
    expect(() =>
      validateCallerContext({ ...VALID_MINIMAL, source: { version: "1.0" } }),
    ).toThrow("'source.system' is required");
  });

  it("rejects missing project", () => {
    const { project: _, ...rest } = VALID_MINIMAL;
    expect(() => validateCallerContext(rest)).toThrow("must have a 'project' object");
  });

  // ── Rejections — optional field type validation ────────────────────────

  it("rejects coreTaskId that is not a string", () => {
    expect(() => validateCallerContext({ ...VALID_MINIMAL, coreTaskId: 123 }))
      .toThrow("'coreTaskId' must be a string");
  });

  it("rejects flowRunId that is not a string", () => {
    expect(() => validateCallerContext({ ...VALID_MINIMAL, flowRunId: true }))
      .toThrow("'flowRunId' must be a string");
  });

  it("rejects permissionSnapshotHash that is not a string", () => {
    expect(() => validateCallerContext({ ...VALID_MINIMAL, permissionSnapshotHash: 555 }))
      .toThrow("'permissionSnapshotHash' must be a string");
  });

  it("rejects repository that is not a string", () => {
    expect(() => validateCallerContext({ ...VALID_MINIMAL, repository: 42 }))
      .toThrow("'repository' must be a string");
  });

  it("rejects branch that is not a string", () => {
    expect(() => validateCallerContext({ ...VALID_MINIMAL, branch: [] }))
      .toThrow("'branch' must be a string");
  });

  it("rejects callbackConfig that is not an object", () => {
    expect(() => validateCallerContext({ ...VALID_MINIMAL, callbackConfig: "webhook" }))
      .toThrow("'callbackConfig' must be an object");
  });

  it("rejects invalid callbackConfig.type", () => {
    expect(() =>
      validateCallerContext({ ...VALID_MINIMAL, callbackConfig: { type: "slack" } }),
    ).toThrow("callbackConfig.type must be");
  });
});
