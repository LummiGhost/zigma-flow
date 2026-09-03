import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";

import { getPackageInfo } from "../../src/utils/index.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

describe("package info", () => {
  beforeEach(() => {
    process.env.ZIGMA_FLOW_VERSION = pkg.version;
  });

  it("exposes the package name and version used by the CLI skeleton", () => {
    expect(getPackageInfo()).toEqual({
      name: "zigma-flow",
      version: pkg.version,
    });
  });

  it("prefers current package metadata over a stale build-time value", () => {
    process.env.ZIGMA_FLOW_VERSION = "0.0.0-stale-build-value";
    expect(getPackageInfo().version).toBe(pkg.version);
  });
});
