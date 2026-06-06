# Common Electron Pitfalls (and how Playwright surfaces them)

These are the failure modes that come up over and over. Each section names the symptom, explains the cause, and shows the Playwright probe that confirms it. Use this file as a reference when a debug session is heading toward an unfamiliar wall — chances are the issue is one of these.

## Table of contents
1. `sandbox: true` + preload using CommonJS `require`
2. `contextIsolation: false` defeats `contextBridge`
3. `ipcMain.handle` vs `ipcMain.on` vs `webContents.send` mismatches
4. Handler not registered when renderer fires
5. Path mismatches between dev and packaged builds
6. Renderer console silent in tests
7. Auto-opening DevTools interferes with tests
8. File system / state leaking between tests
9. Orphaned Electron processes after test exit
10. Native menus and tray icons can't be driven from the renderer
11. `app.whenReady()` race with `import` side effects
12. Network requests not visible to Playwright

---

## 1. `sandbox: true` + preload using CommonJS `require`

**Symptom**: Preload appears not to run; renderer reports `window.api` is undefined; main-process stderr shows an error from inside the preload referencing a Node module.

**Cause**: When `webPreferences.sandbox: true`, preload scripts run in a restricted V8 context. They cannot freely `require()` arbitrary Node modules — only a small whitelist (`electron`, `events`, `timers`, `url`, partial `process`). Build tools that emit CommonJS preload bundles with imports like `require('fs')` or `require('node:path')` fail at load time.

**Probe**:
```js
const config = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  const prefs = w.webContents.getWebPreferences?.() || {};
  return {
    sandbox: prefs.sandbox,
    contextIsolation: prefs.contextIsolation,
    nodeIntegration: prefs.nodeIntegration,
  };
});

// Capture stderr to see the preload's actual error
const stderrChunks = [];
app.process().stderr?.on('data', d => stderrChunks.push(d.toString()));
// ... wait for window load ...
console.log({ config, stderr: stderrChunks.join('') });
```

**Fixes**, in order of preference:
- **Best**: Restructure so preload only uses `electron` (`contextBridge`, `ipcRenderer`) — these *are* available under sandbox — and pushes any Node work to the main process behind IPC. This is the spirit of the sandbox model.
- **Better**: Bundle the preload as ESM. With `electron-vite`, configure the preload entry to emit `.mjs`:
  ```ts
  // electron.vite.config.ts
  export default defineConfig({
    preload: {
      build: {
        rollupOptions: {
          output: { format: 'es', entryFileNames: '[name].mjs' },
        },
      },
    },
  });
  ```
  Then reference the `.mjs` from your `BrowserWindow` config.
- **Last resort**: Set `sandbox: false` on the `BrowserWindow`. Accepts the security tradeoff; only use if you genuinely need full Node in preload and have audited what gets loaded.

## 2. `contextIsolation: false` defeats `contextBridge`

**Symptom**: `contextBridge.exposeInMainWorld(...)` runs without error but the API isn't on `window`, or it's there but methods throw "Cannot read property of undefined."

**Cause**: With `contextIsolation: false`, renderer and preload share a context, and `contextBridge` becomes unreliable or silently no-ops in some Electron versions. With `contextIsolation: true` (the default since Electron 12), the bridge works as documented.

**Probe**: see `debugging-recipes.md` §3.

**Fix**: Always use `contextIsolation: true`. If you need a legacy code path for some reason, assign directly: `window.api = { ... }` in the preload. Don't mix the two.

## 3. `ipcMain.handle` vs `ipcMain.on` vs `webContents.send` mismatches

**Symptom**: `ipcRenderer.invoke('foo', x)` hangs forever, or `ipcRenderer.send('foo', x)` silently does nothing, or `ipcRenderer.on('bar', ...)` never fires.

**Cause**: The IPC API pairs aren't interchangeable.

| Direction | Renderer side | Main side | Mode |
|---|---|---|---|
| Renderer → Main, awaits response | `ipcRenderer.invoke(channel, ...)` | `ipcMain.handle(channel, async (e, ...) => result)` | request/response |
| Renderer → Main, fire-and-forget | `ipcRenderer.send(channel, ...)` | `ipcMain.on(channel, (e, ...) => {})` | one-way |
| Main → Renderer | `webContents.send(channel, ...)` | `ipcRenderer.on(channel, (e, ...) => {})` | push |

**Fix**: Pick one mode per channel. `invoke`/`handle` is the modern default for request/response — prefer it for new code. Mixing modes (e.g., renderer sends with `send`, main responds with `handle`) silently fails.

## 4. Handler not registered when renderer fires

**Symptom**: First render after launch sometimes works, sometimes hangs. Test-mode often hangs because tests fire IPC immediately on load. After hot reload, all IPC breaks until restart.

**Cause**: `ipcMain.handle(...)` runs inside an async block (e.g., `app.whenReady().then(...)`) that resolves *after* the renderer's first `invoke` has already fired. The renderer's `invoke` sits on a queue waiting for a handler that arrives too late or never.

**Fix**: Register `ipcMain.handle` / `ipcMain.on` at module top level, before `app.whenReady()`. Side-effect imports are appropriate here:

```js
// main/index.ts
import { app } from 'electron';
import './ipc-handlers';   // <-- registers handlers synchronously on import
// ...
app.whenReady().then(createWindow);
```

```js
// main/ipc-handlers.ts
import { ipcMain } from 'electron';
ipcMain.handle('user:get', async () => ({ /* ... */ }));
ipcMain.handle('file:open', async (e, path) => { /* ... */ });
```

This guarantees handlers exist before any renderer can call them.

## 5. Path mismatches between dev and packaged builds

**Symptom**: Tests pass locally with `args: ['./out/main/index.js']`. The packaged build crashes with `ENOENT` for renderer assets, or main can't find a module.

**Cause**: Paths computed in main with `__dirname + '/../renderer/index.html'` work in the unpacked build output (`out/main/index.js` → `out/renderer/index.html`) but break in the packaged asar layout (`app.asar/main/index.js` → `app.asar/renderer/index.html`, but the asar root differs).

**Probe**:
```js
const paths = await app.evaluate(({ app }) => ({
  appPath: app.getAppPath(),
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  execPath: process.execPath,
}));
console.log(paths);
```

**Fix**: Use `app.getAppPath()` as the root for resolving renderer assets. It returns the right thing in both modes:

```js
import path from 'node:path';
const indexHtml = path.join(app.getAppPath(), 'renderer', 'index.html');
mainWindow.loadFile(indexHtml);
```

Validate both modes with the multi-environment pattern in `setup.md`.

## 6. Renderer console silent in tests

**Symptom**: You know the renderer is throwing but no output appears in the test log.

**Cause**: Playwright doesn't auto-pipe console events. Without explicit listeners, they're lost.

**Fix**: Always attach immediately after `firstWindow()`:
```js
window.on('console', msg => console.log(`[renderer:${msg.type()}]`, msg.text()));
window.on('pageerror', err => console.log('[renderer:error]', err.message, err.stack));
```

Same for main: `app.process().stdout?.on('data', d => process.stdout.write(d))`. The fixture in `assets/electron-fixture.ts` does this for you — that's why every test uses it.

## 7. Auto-opening DevTools interferes with tests

**Symptom**: In dev, `webContents.openDevTools()` causes a second window/panel to appear. In some Electron versions this confuses `firstWindow()` or `windows()` or causes layout-dependent assertions to fail.

**Fix**: Gate the call:
```js
if (!process.env.E2E) win.webContents.openDevTools();
```
Pass `E2E=1` in the launch env (the fixture in `assets/electron-fixture.ts` does this).

## 8. File system / state leaking between tests

**Symptom**: Test 2 inherits state from test 1 (recent files list, settings, cached login token). Tests pass when run alone, fail when run together. Flakes correlate with order.

**Cause**: Electron's default `userData` directory persists across runs. Settings, IndexedDB, localStorage, recent files all live there.

**Fix**: Per-test userData directory — see `e2e-testing.md` "Test isolation strategies."

## 9. Orphaned Electron processes after test exit

**Symptom**: `npx playwright test` finishes but `ps aux | grep electron` shows lingering processes. Eventually the system runs out of RAM during long test sessions or CI runs.

**Cause**: A test threw before reaching `app.close()`, and there was no `finally` or fixture cleanup to handle it. Or `app.close()` itself hung because the app has a "block close" handler.

**Fixes**:
- Use the fixture's `use()` cleanup phase — it runs even on test failure. The fixture pattern in `assets/electron-fixture.ts` is correct here.
- For ad-hoc scripts, use `try { ... } finally { await app.close(); }`.
- If `app.close()` hangs, your app probably calls `event.preventDefault()` in a `before-quit` or `close` handler. Either bypass it in E2E mode (gate on `process.env.E2E`), or call `app.exit(0)` instead of `close()` as a last resort.

## 10. Native menus and tray icons can't be driven from the renderer

**Symptom**: User wants to test "File > Open" or click a tray icon. `page.click(...)` can't find them.

**Cause**: Native OS menus and tray icons aren't part of the renderer DOM — they're rendered by the OS itself.

**Fix**: Trigger from main via `evaluate`. See `debugging-recipes.md` §7 for menu actions. For tray, you can call the click handler directly:
```js
await app.evaluate(() => {
  // Assumes you stored your tray instance somewhere globally accessible
  globalThis.__tray.emit('click');
});
```
For this to work, your app needs to expose the tray (or use a test-only flag that stashes it on `globalThis` when `E2E=1`).

## 11. `app.whenReady()` race with `import` side effects

**Symptom**: Intermittent "did-finish-load" timing weirdness, or an `app.whenReady` callback that runs before some module's top-level code.

**Cause**: ES module imports are async-ish in Electron's loader, and side-effecting code at module top-level (e.g., `protocol.registerSchemesAsPrivileged([...])`) must run before `app.whenReady()` resolves. If you import a side-effecting module too late, the protocol/scheme isn't registered when the renderer requests it.

**Fix**: Move all side-effects that must happen pre-ready into modules imported synchronously from your main entry. Use top-level imports, not dynamic `import()`. If you must `await import(...)`, do so before `app.whenReady()`:

```js
// main/index.ts
import { app, protocol } from 'electron';

// Must run before app.whenReady() — top-level imports do this synchronously.
import './register-protocols';

app.whenReady().then(() => createWindow());
```

## 12. Network requests not visible to Playwright

**Symptom**: User wants to assert on or mock an HTTP request the renderer makes. `page.route(...)` works partially or not at all.

**Cause**: `page.route` works for renderer-originated requests over `http`/`https`. Requests from the main process (e.g., `net.request` or `fetch` in main) don't go through Playwright's interception. Requests over `file://` aren't intercepted either.

**Fix**:
- Renderer requests over `http`/`https`: `page.route` works normally.
- Main-process requests: intercept on the main side via `session.defaultSession.webRequest.onBeforeRequest(...)` and inject a test-only handler that's gated on `process.env.E2E === '1'`.
- For HAR-based recording, use Playwright's `recordHar` launch option to capture renderer traffic.
