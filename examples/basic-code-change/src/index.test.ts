/**
 * Unit test for the greet function.
 * Uses Node's built-in test runner (node --test).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { greet } from "./index.js";

void describe("greet", () => {
  void it("returns a greeting for a given name", () => {
    assert.equal(greet("Alice"), "Hello, Alice!");
  });

  void it("defaults the name to World", () => {
    assert.equal(greet(), "Hello, World!");
  });
});
