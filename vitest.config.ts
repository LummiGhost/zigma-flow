import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Bound simultaneous CLI/Git processes on Windows; retain per-test parallelism assertions.
    ...(process.platform === "win32" ? { maxWorkers: 4, testTimeout: 15000 } : {}),
    include: ["tests/**/*.test.ts"]
  }
});
