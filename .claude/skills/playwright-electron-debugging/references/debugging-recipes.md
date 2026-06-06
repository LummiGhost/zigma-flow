# Debugging Recipes

Each recipe is a runnable pattern for a specific failure mode. Adapt the script to the user's situation, then run it. The goal is always to capture concrete evidence — what the main process saw, what the renderer saw — instead of guessing.

All recipes assume the boilerplate from `SKILL.md`'s "Quick start" (launch + log piping + `firstWindow`) has been applied. The snippets below show only the diagnostic logic.

## Table of contents
1. White / blank window
2. App crashes or exits immediately on launch
3. Preload API not visible in renderer
4. IPC handler never fires (`invoke` hangs)
5. Multiple windows — which is which?
6. Hot reload / dev-server-only renderer
7. Native menu actions
8. Capture a full repro for a bug report (trace + screenshots)
9. Inspecting persistent state (`userData`, `localStorage`)

---

## 1. White / blank window

The renderer is loading but nothing's visible. Could be: HTML failed to load, JS error before render, CSS hiding everything, missing data dependency, CSP blocking scripts.

```js
const errors = [];
window.on('pageerror', err => errors.push({ kind: 'pageerror', message: err.message, stack: err.stack }));
window.on('console', msg => {
  if (['error', 'warning'].includes(msg.type())) {
    errors.push({ kind: msg.type(), text: msg.text() });
  }
});

// Don't strictly require networkidle — some apps never reach it (websockets, polling).
await window.waitForLoadState('domcontentloaded');
await window.waitForTimeout(500);  // give post-mount async work a moment

const diagnostic = await window.evaluate(() => ({
  url: location.href,
  title: document.title,
  readyState: document.readyState,
  bodyHTML: document.body?.innerHTML?.slice(0, 500),
  rootMountChildren: document.getElementById('app')?.children.length ?? null,  // adapt to your mount selector
  scripts: Array.from(document.scripts).map(s => s.src || '<inline>'),
  styles: Array.from(document.styleSheets).map(s => s.href || '<inline>'),
}));

await window.screenshot({ path: 'white-screen.png', fullPage: true });
console.log({ errors, diagnostic });
```

Interpreting results:
- `errors` empty + `bodyHTML` empty → main loaded the wrong file. Check `BrowserWindow.loadURL` / `loadFile` target. Probe from main: `await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())`.
- `errors` includes `'require is not defined'` or `'Cannot use import statement outside a module'` → preload/renderer module-format mismatch. See `common-issues.md` §1.
- `errors` includes CSP violations → `Content-Security-Policy` blocking your scripts. Check the `<meta http-equiv="Content-Security-Policy">` in your HTML or the `session.webRequest.onHeadersReceived` handler.
- `bodyHTML` populated but visually empty → CSS issue. Inspect the screenshot. Common cause: framework root element has `height: 0` because flex/grid parent isn't sized.
- `scripts` lists files but `pageerror` shows 404 → renderer is loading from `file://` and your build paths assume `/`. Either use hash routing or fix the base URL.

## 2. App crashes or exits immediately on launch

`firstWindow()` times out, or the process exits before any window appears.

```js
const stdoutChunks = [];
const stderrChunks = [];
app.process().stdout?.on('data', d => stdoutChunks.push(d.toString()));
app.process().stderr?.on('data', d => stderrChunks.push(d.toString()));

let exitCode = null;
app.process().on('exit', code => { exitCode = code; });

try {
  await app.firstWindow({ timeout: 10_000 });
  console.log('Window appeared OK');
} catch (err) {
  console.log('firstWindow failed:', err.message);
  console.log('exit code:', exitCode);
  console.log('--- stdout ---\n' + stdoutChunks.join(''));
  console.log('--- stderr ---\n' + stderrChunks.join(''));
}
```

The captured stderr almost always names the actual problem — uncaught exception in main, missing native module, syntax error, missing file. `firstWindow` timing out without stderr usually means main is alive but never called `new BrowserWindow(...)` — check your `app.whenReady()` chain for unawaited promises or thrown errors that get swallowed.

## 3. Preload API not visible in renderer

User wired up `contextBridge.exposeInMainWorld('api', { ... })` but `window.api` is undefined in the renderer.

```js
// 1. From renderer: what custom keys are on window?
const customKeys = await window.evaluate(() => {
  const builtIns = new Set(['document', 'location', 'navigator', 'history', 'screen', 'console', 'localStorage', 'sessionStorage']);
  return Object.keys(window).filter(k => !builtIns.has(k) && !k.startsWith('webkit'));
});
console.log('Custom window keys:', customKeys);

// 2. From main: what does the BrowserWindow think the preload is?
const preloadInfo = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  const prefs = w.webContents.getWebPreferences?.() ?? {};
  return {
    sessionPreloads: w.webContents.session.getPreloads(),
    sandbox: prefs.sandbox,
    contextIsolation: prefs.contextIsolation,
    nodeIntegration: prefs.nodeIntegration,
    webSecurity: prefs.webSecurity,
  };
});
console.log('Main config:', preloadInfo);
```

Diagnoses:
- `customKeys` empty + `sessionPreloads` empty → `webPreferences.preload` is missing from `BrowserWindow` config. Add it.
- `sessionPreloads` set but `customKeys` empty → preload threw before reaching `exposeInMainWorld`. Check the `pageerror` listener output, or wrap the preload body in `try/catch` and `console.error` from inside it.
- `contextIsolation: false` → `contextBridge` is unreliable in this mode. Either set `contextIsolation: true` (recommended), or assign directly: `window.api = { ... }` in the preload (legacy pattern).
- `sandbox: true` and preload uses `require('fs')` or similar arbitrary modules → sandbox restricts that. See `common-issues.md` §1.

## 4. IPC handler never fires (`invoke` hangs)

Renderer calls `ipcRenderer.invoke('foo', payload)` and the promise never resolves.

```js
// What channels does main know about?
const registered = await app.evaluate(({ ipcMain }) => {
  // ipcMain doesn't expose a public API for this, but the underlying EventEmitter does.
  // Useful for diagnosis even though it's a private detail.
  return {
    handlers: Array.from(ipcMain._invokeHandlers?.keys?.() ?? []),
    listeners: Object.keys(ipcMain._events ?? {}),
  };
});
console.log('ipcMain knows:', registered);

// Trigger from renderer with a timeout so we don't actually hang forever
const result = await window.evaluate(async () => {
  try {
    const value = await Promise.race([
      window.api.foo({ x: 1 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 3s')), 3000)),
    ]);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
console.log('Renderer roundtrip:', result);
```

Common causes:
- **Channel name typo.** `'getUserData'` vs `'get-user-data'`. Reading `registered.handlers` next to the renderer call site usually makes the typo obvious.
- **Wrong API pair.** `invoke` ↔ `handle` (request/response). `send` ↔ `on` (fire-and-forget). They aren't interchangeable — see `common-issues.md` §3.
- **Handler registered too late.** Renderer fires on initial load; `ipcMain.handle` is called inside `app.whenReady().then(...)` after window creation. Move handler registration to module top-level.
- **Handler throws.** `invoke` rejects with the error message. Read the `result.error`.

## 5. Multiple windows — which is which?

Apps with splash screens, login dialogs, or detached panels confuse `firstWindow()` (it returns the first emitted, not "the main one").

```js
// Listen for new windows as they appear
app.on('window', win => {
  console.log('New window:', win.url());
});

// Inspect all current windows
const allWindows = app.windows();
const summary = await Promise.all(allWindows.map(async w => ({
  url: w.url(),
  title: await w.title(),
})));
console.log('Windows:', summary);

// Pick a specific window
const mainWindow = app.windows().find(w => w.url().includes('/main')) ?? app.windows()[0];
const settingsWindow = app.windows().find(w => w.url().includes('/settings'));
```

Tip: in apps with a splash window, `firstWindow()` returns the splash. Wait for the real window with `app.waitForEvent('window', { predicate: w => w.url().includes('/main') })`.

## 6. Hot reload / dev-server-only renderer

If the renderer loads from a Vite dev server (`http://localhost:5173`) rather than a built `file://` path, the dev server must be running before you launch. Two approaches:

**A. Test only the build output** (simplest, recommended for CI):
- Run `electron-vite build` first.
- Launch with `args: ['./out/main/index.js']`.
- Main reads from `file://` paths into `out/renderer/`.

**B. Test against the dev server** (faster iteration locally):
- Start `electron-vite dev` in one terminal.
- Run Playwright in another.
- Main loads `http://localhost:5173` based on `process.env.ELECTRON_RENDERER_URL` (set by electron-vite).
- Brittle in CI; use only for local debugging.

## 7. Native menu actions

Native OS menu items aren't in the renderer DOM. `page.click(...)` cannot reach them. Trigger from main:

```js
await app.evaluate(({ Menu }) => {
  const menu = Menu.getApplicationMenu();
  if (!menu) throw new Error('No application menu set');

  // Find by label — adapt to your menu structure
  const fileMenu = menu.items.find(i => i.label === 'File');
  if (!fileMenu?.submenu) throw new Error('File menu not found');
  const openItem = fileMenu.submenu.items.find(i => i.label === 'Open...');
  if (!openItem) throw new Error('Open... item not found');

  openItem.click();
});

// Then assert on the resulting renderer state
await window.locator('[data-testid="open-dialog"]').waitFor({ state: 'visible' });
```

If the menu opens a native file dialog, mock it first (see `e2e-testing.md` "Mocking native dialogs").

## 8. Capture a full repro for a bug report

When handing a bug to another developer or filing upstream, a Playwright trace beats prose.

```js
const context = await app.context();   // BrowserContext shared by all renderers
await context.tracing.start({
  screenshots: true,
  snapshots: true,
  sources: true,                        // include source files in the trace
});

try {
  // ... reproduce the bug ...
} finally {
  await context.tracing.stop({ path: 'bug-trace.zip' });
}
```

Open with `npx playwright show-trace bug-trace.zip`. The viewer is a time-travel debugger: every action, network event, console message, and DOM snapshot is browsable. Attach the zip to the bug report.

For one-off evidence, simpler tools work too:
```js
await window.screenshot({ path: 'state.png', fullPage: true });
const html = await window.content();    // full HTML serialization
const errors = await window.evaluate(() => window.__capturedErrors ?? []);
```

## 9. Inspecting persistent state (userData, localStorage)

Bugs sometimes depend on cached state. Capture it:

```js
// userData directory and what's in it (from main)
const stateInfo = await app.evaluate(async ({ app: electronApp }) => {
  const fs = require('fs/promises');
  const path = require('path');
  const dir = electronApp.getPath('userData');
  const files = await fs.readdir(dir);
  return { dir, files };
});

// localStorage / sessionStorage (from renderer)
const storage = await window.evaluate(() => ({
  localStorage: Object.fromEntries(Object.entries(localStorage)),
  sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
}));

console.log({ stateInfo, storage });
```

To reproduce a bug from scratch, start with a clean `userData` dir — see `e2e-testing.md` "Test isolation strategies."
