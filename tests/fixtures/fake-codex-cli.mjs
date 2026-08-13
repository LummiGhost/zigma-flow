import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const reportFlag = args.indexOf("--output-last-message");
const schemaFlag = args.indexOf("--output-schema");
const prompt = await new Promise((resolve) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => resolve(value));
});

if (reportFlag < 0) {
  console.error("missing --output-last-message");
  process.exit(2);
}
if (schemaFlag < 0) {
  console.error("missing --output-schema");
  process.exit(2);
}

const report = {
  outputs: {
    prompt_received: prompt.includes("fixture prompt"),
  },
  artifacts: [],
  signals: [],
  summary: "fake codex completed",
};

await writeFile(args[reportFlag + 1], JSON.stringify(report), "utf8");
process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "fixture" })}\n`);
