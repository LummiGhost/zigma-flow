import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPackageInfo } from "../../src/utils/index.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

describe("package info", () => {
  let originalVersion: string | undefined;

  beforeEach(() => {
    originalVersion = process.env.ZIGMA_FLOW_VERSION;
    process.env.ZIGMA_FLOW_VERSION = pkg.version;
  });

  afterEach(() => {
    if (originalVersion === undefined) {
      delete process.env.ZIGMA_FLOW_VERSION;
    } else {
      process.env.ZIGMA_FLOW_VERSION = originalVersion;
    }
  });

  it("exposes the package name and version used by the CLI skeleton", () => {
    expect(getPackageInfo()).toEqual({
      name: "zigma-flow",
      version: pkg.version,
    });
  });

  it("prefers current package metadata over a stale build-time value", () => {
    const previous = process.env.ZIGMA_FLOW_VERSION;
    try {
      process.env.ZIGMA_FLOW_VERSION = "0.0.0-stale-build-value";
      expect(getPackageInfo().version).toBe(pkg.version);
    } finally {
      if (previous === undefined) {
        delete process.env.ZIGMA_FLOW_VERSION;
      } else {
        process.env.ZIGMA_FLOW_VERSION = previous;
      }
    }
  });
});
