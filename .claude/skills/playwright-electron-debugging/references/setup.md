# Setup & Launch Configuration

The boring-but-critical part: getting `_electron.launch()` to actually start the app. Most "Playwright doesn't work" reports come down to a wrong `args` path or a packaged-vs-dev mismatch.

## Installation

```bash
npm install -D playwright @playwright/test
# or: pnpm add -D playwright @playwright/test
```

- `playwright` provides the `_electron` API. Sufficient for ad-hoc debug scripts.
- `@playwright/test` provides the test runner, fixtures, assertions, and HTML reports. Add when you're ready for a persistent suite.

There is **no** `npx playwright install` step for Electron. Playwright launches whatever `electron` your `package.json` resolves — that's why your project's existing `electron` dependency is what gets driven.

## TypeScript notes

For `.spec.ts`, ensure `tsconfig.json` has:
```json
{
  "compilerOptions": {
    "esModuleInterop": true,
    "moduleResolution": "node",   // or "bundler" for newer setups
    "target": "ES2022"
  }
}
```

Playwright ships its own types — no extra `@types/...` packages needed.

## `electron.launch()` options reference

```ts
const app = await electron.launch({
  args: ['./out/main/index.js'],     // path to main entry, or '.' to use package.json#main
  cwd: process.cwd(),                 // working directory
  env: { ...process.env, NODE_ENV: 'test' },
  timeout: 30_000,                    // launch timeout in ms
  recordVideo: { dir: './videos' },   // optional: record renderer video
  recordHar:   { path: './har.zip' }, // optional: record network HAR
  tracesDir:   './traces',            // where traces go when context.tracing is used
  // executablePath: '/path/to/Electron',  // override only for packaged builds
});
```

The `args` array is forwarded to Electron unchanged. The first element is typically the main script path; the rest are CLI flags Electron or your app reads (`--enable-logging`, `--remote-debugging-port=9222`, custom flags).

## Project-layout cheat sheet

### Vanilla Electron (`electron .`)

```jsonc
// package.json
{
  "main": "src/main.js"
}
```

```ts
const app = await electron.launch({ args: ['.'] });
```

### electron-vite

`electron-vite`'s dev server isn't directly supported by `_electron.launch` because the dev pipeline expects a parent process to coordinate watch + reload. Two practical patterns:

**Pattern A — Test against the build output** (recommended for E2E):
```bash
# In CI or before running tests
npm run build       # runs `electron-vite build`, produces ./out/{main,preload,renderer}
```
```ts
import path from 'node:path';
const app = await electron.launch({
  args: [path.join(process.cwd(), 'out', 'main', 'index.js')],
});
```

After `electron-vite build`, the layout is:
```
out/
├── main/index.js          # main entry — point Playwright here
├── preload/index.js       # main loads this; Playwright doesn't reference it directly
└── renderer/index.html    # main's BrowserWindow loads this
```

**Pattern B — Watch-mode debugging** (faster iteration):
Run `electron-vite build --watch` in one terminal; run your Playwright script in another. The build output regenerates on save and the next launch picks it up.

### electron-forge

In dev (`electron-forge start` style projects), Forge respects `package.json#main`, so `args: ['.']` works. For testing the packaged build:
```ts
const app = await electron.launch({
  executablePath: 'out/MyApp-darwin-x64/MyApp.app/Contents/MacOS/MyApp',
  // omit args[0] — packaged apps embed the main script
});
```

### electron-builder packaged build

```ts
const app = await electron.launch({
  // macOS:   dist/mac/MyApp.app/Contents/MacOS/MyApp
  // Windows: dist/win-unpacked/MyApp.exe
  // Linux:   dist/linux-unpacked/myapp
  executablePath: process.env.PACKAGED_BIN!,
});
```

Don't pass `args[0]` — the entry script is embedded in the asar archive.

## CI configuration

Linux CI runners need a virtual display because Electron always opens windows (Playwright's `headless` flag is ignored for Electron):

```yaml
# .github/workflows/e2e.yml — Ubuntu runners
- run: sudo apt-get install -y xvfb
- run: xvfb-run -a npx playwright test
```

macOS and Windows runners don't need Xvfb. macOS runners may need `actions/setup-node` with a recent version and additional permissions for the Electron app to launch (no special config usually needed).

Locally on macOS/Windows/Linux desktop, no extra setup — Electron windows appear normally during the run.

## Multi-environment pattern (dev vs packaged)

Switch launch config via env var so the same suite validates both builds:

```ts
const isPacked = process.env.TEST_PACKAGED === '1';
const launchOptions = isPacked
  ? { executablePath: process.env.PACKAGED_PATH! }
  : { args: [path.join(process.cwd(), 'out', 'main', 'index.js')] };

const app = await electron.launch(launchOptions);
```

Run modes:
```bash
npm test                                                      # dev build
TEST_PACKAGED=1 PACKAGED_PATH=./dist/mac/MyApp.app/... npm test   # packaged
```

This catches a whole class of bugs — asar path resolution, missing native modules, code signing — that only surface in the packaged build.

## Debugging the launch itself

If `electron.launch()` hangs or rejects, capture stderr from the child process to see what Electron is complaining about:

```js
const app = await electron.launch({ args: ['.'], timeout: 60_000 }).catch(err => {
  console.error('launch failed:', err);
  throw err;
});

// Or wire stderr before firstWindow if launch succeeds but firstWindow times out:
app.process().stderr?.on('data', d => process.stderr.write(`[main:err] ${d}`));

try {
  await app.firstWindow({ timeout: 10_000 });
} catch (err) {
  console.error('firstWindow timed out — check stderr above');
  throw err;
}
```

Common launch failures:
- **Wrong `args[0]`** — Electron exits with "App threw an error during load" and a stack trace pointing at a missing file. Fix the path.
- **Native module mismatch** — "The module was compiled against a different Node.js version." Run `npm rebuild` or `electron-rebuild`.
- **Missing display on Linux CI** — `electron: cannot connect to X server`. Use `xvfb-run`.
