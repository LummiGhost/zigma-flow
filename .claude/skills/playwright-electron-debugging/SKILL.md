---
name: playwright-electron-debugging
description: Use Playwright's `_electron` API to debug and test Electron desktop applications — diagnosing crashes, white screens, preload script failures, contextBridge/IPC issues, sandbox compatibility problems, and writing end-to-end automation tests. Trigger this skill whenever the user mentions debugging or testing an Electron app; reports an Electron-related issue (preload, contextBridge, ipcRenderer/ipcMain, BrowserWindow, sandbox, white screen, blank window, app won't launch); wants to inspect main-process or renderer-process state programmatically; or works with electron-vite, electron-forge, or electron-builder. Use even when "Playwright" isn't named — `_electron` is the standard approach for these tasks across the Electron ecosystem.
---

# Playwright for Electron Debugging & Testing

## Why Playwright is the right tool for Electron

Electron apps run two processes — main and one renderer per window — that talk via IPC. Most non-trivial bugs live in the seam between them: a preload script doesn't expose what the renderer expects, an `ipcMain` handler isn't registered when the renderer fires, a sandbox setting silently breaks `require()`, the renderer paints a white screen because main never sent the data it was waiting for.

Playwright's `_electron` API is uniquely suited to this because it gives you simultaneous programmatic handles to **both** processes:

- `ElectronApplication.evaluate(fn)` runs `fn` inside the **main** process — full access to `app`, `BrowserWindow`, `ipcMain`, `Menu`, `dialog`, every Node module the app loaded.
- `Page.evaluate(fn)` runs `fn` inside the **renderer** — full access to `window`, the DOM, anything exposed via `contextBridge`.

This dual visibility means a single short script can reproduce a bug, inspect state on both sides of IPC, and verify the fix. And once the fix lands, the same script becomes a regression test — debugging artifact and test artifact are the same thing.

## When to use this skill

Reach for this skill whenever the user is:
- Debugging an Electron app that crashes, won't open, or shows a white/blank window
- Investigating why `contextBridge.exposeInMainWorld(...)` isn't visible in the renderer
- Tracking down IPC mismatches (`ipcRenderer.invoke` hangs, `ipcMain.handle` never fires)
- Diagnosing failures after toggling `sandbox`, `contextIsolation`, or upgrading Electron
- Writing E2E tests that exercise real user flows (login, file open, multi-window)
- Capturing repro evidence for a bug report (screenshots, console logs, traces)
- Validating behavior parity between dev (`electron-vite build`) and packaged builds

Use this skill even when the user doesn't say "Playwright" — `_electron` is the recommended approach for these tasks.

## The mental model — internalize before writing any script

| Handle | Runs in | What you can touch |
|---|---|---|
| `electronApp.evaluate(fn)` | **main process** | `app`, `BrowserWindow`, `ipcMain`, `Menu`, `dialog`, `session`, fs, any required module |
| `electronApp.process()` | host (Playwright side) | The child process — `.stdout/.stderr` for capturing main-process console output |
| `page.evaluate(fn)` | **renderer process** | `window`, `document`, anything on `window.*` (e.g. APIs from `contextBridge`) |
| `page.locator(...)`, `page.click(...)` | renderer (DOM) | Drive the UI like a user |

`evaluate()` is the heart of debugging. Its return value is **serialized** — return primitives, arrays, or plain objects, not handles to non-serializable things like `BrowserWindow` itself. If you need to look at a window, return `{ id: w.id, title: w.title, url: w.webContents.getURL() }`, not `w`.

## Quick start

Install:
```bash
npm install -D playwright @playwright/test
# pnpm add -D playwright @playwright/test  # if pnpm
```

Both packages are needed if you want the test runner. For ad-hoc debug scripts, `playwright` alone works. There is no `npx playwright install` step for Electron — Playwright launches whatever `electron` your `package.json` resolves.

Minimal debug script (`debug.mjs`):
```js
import { _electron as electron } from 'playwright';

const app = await electron.launch({
  args: ['.'],                                        // or path to built main entry, e.g. './out/main/index.js'
  env: { ...process.env, NODE_ENV: 'development' },
});

// Capture main-process stdout/stderr — otherwise main-side console.log and uncaught
// exceptions are invisible. Wire this BEFORE doing anything else.
app.process().stdout?.on('data', d => process.stdout.write(`[main] ${d}`));
app.process().stderr?.on('data', d => process.stderr.write(`[main:err] ${d}`));

const window = await app.firstWindow();

// Same idea for the renderer.
window.on('console', msg => console.log(`[renderer:${msg.type()}]`, msg.text()));
window.on('pageerror', err => console.log('[renderer:error]', err.message));

await window.waitForLoadState('domcontentloaded');

// Now: poke around. These two evaluate() calls are the workhorse pattern.
const fromMain = await app.evaluate(({ app, BrowserWindow }) => ({
  appPath: app.getAppPath(),
  windowCount: BrowserWindow.getAllWindows().length,
}));

const fromRenderer = await window.evaluate(() => ({
  url: location.href,
  customWindowKeys: Object.keys(window).filter(k => !['document', 'location'].includes(k)),
}));

console.log({ fromMain, fromRenderer });

await app.close();
```

Run with `node debug.mjs`. This is the foundation of every debug session — start here, add probes specific to the bug.

## Decision tree

Pick the reference that matches the situation. Don't load all four unless the user is asking about everything at once — progressive disclosure keeps the working context clean.

- **Diagnosing a specific bug** (white screen, crash on launch, preload not loading, IPC hangs, multi-window confusion) → `references/debugging-recipes.md`
- **Writing E2E tests with the test runner** (fixtures, isolation, dialog mocking, CI) → `references/e2e-testing.md`
- **Preload, sandbox, contextBridge, IPC issues** (pitfalls at the seams between processes) → `references/common-issues.md`
- **Launch configuration** (electron-vite, electron-forge, packaged builds, multi-environment) → `references/setup.md`

## The debug loop — follow this every time

When the user brings a bug, apply this loop. Don't skip steps; the discipline is the value.

1. **Reproduce** — write a minimal Playwright script that triggers the bug (a `.mjs` file is fine for now). The smaller, the better. Don't build a full test harness yet.
2. **Inspect** — add `evaluate()` calls in both processes to capture state at the moment things go wrong. Print, don't assert, until the picture is clear.
3. **Hypothesize and fix** — based on what `evaluate()` returned, propose a fix in the source code.
4. **Verify** — rerun the script. The same `evaluate()` calls now confirm the fix.
5. **Promote** — convert print statements to `expect(...)` assertions, move the file under `e2e/tests/`, wire it to the fixture in `assets/electron-fixture.ts`. The bug is now permanently guarded.

The debug script you write in step 1 is the regression test you commit in step 5. Always offer step 5 even when the user only asks for steps 1–4 — it's a free win.

## Output format expectations

When producing a debug script:

- **Use `.mjs`** for ad-hoc debug scripts so you can `import { _electron }` without TypeScript or bundler config getting in the way.
- **Use `.spec.ts`** with `@playwright/test` when the goal is a permanent test in the suite.
- **Wire log listeners before reproducing the bug.** Always attach `console` and `pageerror` on the window immediately after `firstWindow()` resolves — silent rendering errors are the #1 cause of unsolved Electron bugs. Always pipe `app.process().stdout/stderr` for the main process.
- **Comment each `evaluate()` call** with what state it's checking and what answer would mean what. Future readers (and future-you) need to know why the probe is there.
- **Always close the app** (`await app.close()`) — orphaned Electron processes accumulate fast in failed runs. In tests, let the fixture handle this; in scripts, use `try { ... } finally { await app.close(); }`.

Skeleton to follow for debug scripts:

```js
import { _electron as electron } from 'playwright';

const app = await electron.launch({ args: ['.'] });

// 1. Wire up logging FIRST
app.process().stdout?.on('data', d => process.stdout.write(`[main] ${d}`));
app.process().stderr?.on('data', d => process.stderr.write(`[main:err] ${d}`));

try {
  // 2. Get window, wire its logging too
  const window = await app.firstWindow();
  window.on('console', msg => console.log(`[renderer:${msg.type()}]`, msg.text()));
  window.on('pageerror', err => console.log('[renderer:error]', err.message));
  await window.waitForLoadState('domcontentloaded');

  // 3. Reproduce the bug (user actions, navigation, etc.)
  // ...

  // 4. Inspect both sides
  const mainState = await app.evaluate(({ BrowserWindow }) => ({
    // ...whatever's relevant to the bug
  }));
  const rendererState = await window.evaluate(() => ({
    // ...
  }));
  console.log({ mainState, rendererState });

} finally {
  // 5. Cleanup
  await app.close();
}
```

## Common pitfalls — quick reference

- **Forgetting to wait for `firstWindow()`.** It resolves only after the first `BrowserWindow` is created — i.e. after `app.whenReady()` and your window-creation code runs. If your app creates the window async (splash screens, login, deferred init), `await` this before `evaluate`-ing renderer state.
- **Not piping main-process stdout.** Main-process `console.log` and uncaught exceptions are invisible by default. Always wire `app.process().stdout/stderr` before doing anything else. This single habit catches more bugs than any other.
- **Sandboxed preload using CommonJS `require`.** When `sandbox: true`, preload scripts can't `require()` arbitrary node modules. Symptoms look like "preload didn't run" but the cause is that it threw. See `references/common-issues.md` §1.
- **Path mismatches between dev and packaged.** `args: ['.']` works only if `package.json#main` points at the right file for the run mode. For electron-vite, point at `./out/main/index.js` after a build. See `references/setup.md`.
- **Treating `evaluate()` return as live handles.** It isn't — return values are serialized. Return data shapes, not references.
- **Headless mode confusion.** Playwright's `headless` flag is **ignored** for Electron. Windows always appear unless suppressed by the OS or Xvfb. On Linux CI, use `xvfb-run`.
- **Not closing the app on test failure.** Use a `finally` block in scripts, or rely on the fixture's `use()` cleanup phase (it runs even when tests throw). The fixture in `assets/electron-fixture.ts` handles this correctly.

A more thorough list lives in `references/common-issues.md`.

## Reusable fixture

`assets/electron-fixture.ts` is a copy-pasteable Playwright fixture that handles launch, log piping, per-test userData isolation, and cleanup with sensible defaults. When the user is starting a new test suite, drop it into their `e2e/` (or `tests/`) directory and import `test` from it.
