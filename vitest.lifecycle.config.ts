import { mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

// The lifecycle gate must include its real two-CLI acceptance file; ordinary
// unit runs intentionally do not require prebuilt dist output.
export default mergeConfig(base, {
  test: { include: ["tests/**/*.test.ts", "tests/**/*.lifecycle.ts"] },
});
