import { cp } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  outDir: "dist",
  banner: {
    js: "#!/usr/bin/env node"
  },
  onSuccess: async () => {
    await cp(
      join("src", "prompt", "templates"),
      join("dist", "prompt", "templates"),
      { recursive: true },
    );
  },
});
