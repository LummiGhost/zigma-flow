/**
 * A trivial "hello world" module used as an example target for zigma-flow's
 * code-change workflow.
 *
 * This file is intentionally minimal so the workflow can demonstrate a
 * complete code-change lifecycle: intake, code-map, plan, implement,
 * static-check, unit-test, review, and summarize.
 */

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

// Allow running directly: `node dist/index.js`
const args = process.argv.slice(2);
const target = args[0] ?? "World";
console.log(greet(target));
