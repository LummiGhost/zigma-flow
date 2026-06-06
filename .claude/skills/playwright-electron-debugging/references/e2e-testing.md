# E2E Testing with @playwright/test

For permanent regression tests, use the `@playwright/test` runner. It provides fixtures, parallelism control, retries, HTML reports with traces/videos/screenshots, and a comfortable assertion API. Ad-hoc `.mjs` debug scripts are great for exploration; persistent suites should use the runner.

## Project layout

```
project/
├── e2e/
│   ├── fixtures.ts          # Electron app fixture (start from assets/electron-fixture.ts)
│   ├── pages/                # Page object models (optional but tidy)
│   │   └── main-window.ts
│   └── tests/
│       ├── login.spec.ts
│       ├── file-open.spec.ts
│       └── ipc-contract.spec.ts
├── playwright.config.ts
└── package.json
```

## `playwright.config.ts`

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/tests',
  timeout: 30_000,
  fullyParallel: false,         // start serial; bump up only after tests are confirmed isolated
  workers: 1,                   // each worker launches its own Electron app — costly
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
```

Note: don't use `projects` for browsers (Chromium/Firefox/WebKit). Electron is its own runtime — those are irrelevant. `projects` is useful for running the same suite against dev vs packaged builds:

```ts
projects: [
  { name: 'dev',     use: { /* default */ } },
  { name: 'packaged', use: {}, metadata: { TEST_PACKAGED: '1' } },
],
```

…with the fixture reading `process.env.TEST_PACKAGED` to switch launch options.

## Fixture pattern

The base fixture lives in `assets/electron-fixture.ts` — copy it to `e2e/fixtures.ts` and adjust the `args` path for your project.

The fixture provides:
- **`electronApp`**: launched ElectronApplication, with main-process stdout/stderr piped through and a per-test `userData` directory.
- **`mainWindow`**: the first BrowserWindow, with `console` and `pageerror` listeners attached and `domcontentloaded` already awaited.

A test using the fixture:

```ts
import { test, expect } from './fixtures';

test('login flow opens dashboard', async ({ mainWindow }) => {
  await mainWindow.fill('[data-testid="username"]', 'alice');
  await mainWindow.fill('[data-testid="password"]', 'secret');
  await mainWindow.click('[data-testid="submit"]');
  await expect(mainWindow.locator('[data-testid="dashboard"]')).toBeVisible();
});

test('main process registers expected IPC handlers', async ({ electronApp }) => {
  const handlers = await electronApp.evaluate(({ ipcMain }) =>
    Array.from(ipcMain._invokeHandlers?.keys?.() ?? [])
  );
  expect(handlers).toEqual(expect.arrayContaining(['user:get', 'file:open', 'settings:read']));
});
```

The two-fixture split (`electronApp` + `mainWindow`) means tests that only need the renderer don't pay the cost of looking up windows, and tests that need main-process access don't have to dig through the page handle to get it.

## Test isolation strategies

Electron apps usually have persistent state (userData, settings, cached login, window positions). Without isolation, tests pollute each other and order-dependent flakes appear.

### Strategy 1: Per-test userData directory (recommended)

Pass a unique temp dir via env var, and have your main process honor it.

In the fixture:
```ts
electronApp: async ({}, use, testInfo) => {
  const userDataDir = path.join(os.tmpdir(), `e2e-${testInfo.testId}-${Date.now()}`);
  const app = await electron.launch({
    args: [/* ... */],
    env: { ...process.env, USER_DATA_DIR: userDataDir, E2E: '1' },
  });
  await use(app);
  await app.close().catch(() => {});
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
},
```

In your main process:
```js
import { app } from 'electron';
if (process.env.USER_DATA_DIR) {
  app.setPath('userData', process.env.USER_DATA_DIR);
}
```

This is the most reliable approach. Each test starts from a true blank slate. The only cost is the few hundred ms it takes to launch a fresh app per test.

### Strategy 2: Reset state via test-only IPC channel

If launch is too slow, expose a `'__test:reset-state'` IPC channel gated by `process.env.E2E === '1'`:

```js
// main, only in E2E mode
if (process.env.E2E === '1') {
  ipcMain.handle('__test:reset-state', async () => {
    // clear settings, cache, db, etc.
  });
}
```

Call from the test:
```ts
test.beforeEach(async ({ electronApp }) => {
  await electronApp.evaluate(async ({ webContents }) => {
    await webContents.getAllWebContents()[0].executeJavaScript(
      `window.api.__resetState()`
    );
  });
});
```

Faster than relaunching, but easier to get wrong (state you forget to reset leaks across tests). Use only after you know what state matters.

## Asserting against main-process state

`expect.poll` waits for an async condition to hold:

```ts
await expect.poll(async () =>
  electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
).toBe(2);
```

`expect(...).toPass()` retries an assertion block:
```ts
await expect(async () => {
  const url = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().at(-1)?.webContents.getURL()
  );
  expect(url).toContain('/dashboard');
}).toPass({ timeout: 5_000 });
```

Use these instead of arbitrary `waitForTimeout(N)` calls — flake-free and self-documenting.

## Mocking native dialogs

`dialog.showOpenDialog` blocks the test until a user clicks. Replace it:

```ts
test.beforeEach(async ({ electronApp }) => {
  await electronApp.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: ['/tmp/test-file.txt'],
    });
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: '/tmp/output.txt',
    });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
});
```

This replaces the dialog functions inside the live main process for the duration of the test. The replacement doesn't persist — each test gets a fresh main process if you're using per-test userData dirs.

## Page object models (optional)

For larger suites, encapsulate selectors:

```ts
// e2e/pages/main-window.ts
import type { Page } from '@playwright/test';

export class MainWindow {
  constructor(private readonly page: Page) {}

  get usernameInput() { return this.page.locator('[data-testid="username"]'); }
  get passwordInput() { return this.page.locator('[data-testid="password"]'); }
  get submitButton()  { return this.page.locator('[data-testid="submit"]'); }
  get dashboard()     { return this.page.locator('[data-testid="dashboard"]'); }

  async login(user: string, pass: string) {
    await this.usernameInput.fill(user);
    await this.passwordInput.fill(pass);
    await this.submitButton.click();
  }
}
```

Tests:
```ts
import { MainWindow } from '../pages/main-window';

test('login flow', async ({ mainWindow }) => {
  const ui = new MainWindow(mainWindow);
  await ui.login('alice', 'secret');
  await expect(ui.dashboard).toBeVisible();
});
```

POMs add value when selectors are reused across many tests or when they're complex. For a 3-test suite, inline locators are fine.

## Promoting a debug script to a test

Take a working `debug.mjs` and:

1. Convert to `.spec.ts`. Replace ESM imports with the fixture import.
2. Wrap the body in `test('describes the bug', async ({ mainWindow, electronApp }) => { ... })`.
3. Replace `console.log({ ... })` inspections with `expect(...).toBe(...)` (or `.toMatchObject`, `.toContain`, etc.).
4. Remove the manual `electron.launch` / `app.close` — the fixture handles them.
5. Move to `e2e/tests/`. Run `npx playwright test`.

The script that proved the bug exists now proves it doesn't return.

## CI

```yaml
# .github/workflows/e2e.yml
name: e2e
on: [push, pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run build           # produce out/main/index.js etc.
      - run: sudo apt-get install -y xvfb
      - run: xvfb-run -a npx playwright test
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 14
```

The HTML report (with traces, screenshots, videos) is the most useful failure artifact. Always upload it on failure — it makes "works on my machine" debates very short.
