import { describe, expect, it } from "vitest";

import { getPackageInfo } from "../../src/utils/index.js";

describe("package info", () => {
  it("exposes the package name and version used by the CLI skeleton", () => {
    expect(getPackageInfo()).toEqual({
      name: "zigma-flow",
      version: "0.1.0"
    });
  });
});
