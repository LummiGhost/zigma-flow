import { readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

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
      join("dist", "templates"),
      { recursive: true },
    );
  },
  esbuildOptions: (options) => {
    options.define = {
      ...options.define,
      "process.env.ZIGMA_FLOW_VERSION": JSON.stringify(pkg.version),
    };
  },
});
