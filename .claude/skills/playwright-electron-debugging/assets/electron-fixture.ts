/**
 * Reusable Playwright fixture for Electron apps.
 *
 * Provides:
 *  - `electronApp`: launched ElectronApplication, with main-process stdout/stderr piped
 *    to the test runner so crashes and console.logs from main are visible
 *  - `mainWindow`: the first BrowserWindow as a Playwright Page, with `console` and
 *    `pageerror` listeners attached and `domcontentloaded` already awaited
 *  - Per-test userData directory under os.tmpdir(), cleaned up automatically — gives
 *    each test a true blank slate (settings, localStorage, IndexedDB, recent files all empty)
 *
 * Setup:
 *   1. Copy this file to your project, e.g. `e2e/fixtures.ts`
 *   2. Adjust `MAIN_ENTRY` if your build output isn't at ./out/main/index.js
 *      (electron-vite default — change to ./dist/main/index.js for electron-forge,
 *       or wherever your bundler emits the main script)
 *   3. In your main process, honor the USER_DATA_DIR env var:
 *
 *        // main/index.ts
 *        import { app } from 'electron';
 *        if (process.env.USER_DATA_DIR) app.setPath('userData', process.env.USER_DATA_DIR);
 *
 *   4. In tests: `import { test, expect } from './fixtures'`
 *
 * The fixture is split into two parts (`electronApp` + `mainWindow`) so tests can request
 * just what they need. A test that only inspects main-process state can take `electronApp`
 * alone and skip the renderer setup; a UI-only test can take `mainWindow` and let the
 * fixture chain handle the app.
 */

import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

// Adjust this if your build output is elsewhere.
const MAIN_ENTRY = path.join(process.cwd(), 'out', 'main', 'index.js');

type Fixtures = {
  electronApp: ElectronApplication;
  mainWindow: Page;
};

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use, testInfo) => {
    const userDataDir = path.join(
      os.tmpdir(),
      `e2e-${testInfo.testId}-${Date.now()}`
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        E2E: '1',                  // gate dev-only behavior (devtools, logs) in your main code
        USER_DATA_DIR: userDataDir, // your main process should pass this to app.setPath('userData', ...)
      },
      timeout: 30_000,
    });

    // Pipe main-process output. Without this, main's console.log and uncaught
    // exceptions are completely invisible — debugging Electron without these is
    // a nightmare. Wire them as the very first thing.
    app.process().stdout?.on('data', d => process.stdout.write(`[main] ${d}`));
    app.process().stderr?.on('data', d => process.stderr.write(`[main:err] ${d}`));

    await use(app);

    // Cleanup runs even if the test failed (Playwright fixtures guarantee this).
    await app.close().catch(() => { /* app may already be closed */ });
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => { /* dir may not exist */ });
  },

  mainWindow: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();

    // Surface renderer-side issues. Filter out 'log'/'info'/'debug' to reduce noise;
    // adjust if you want to see all renderer console output.
    window.on('console', msg => {
      if (['error', 'warning'].includes(msg.type())) {
        console.log(`[renderer:${msg.type()}]`, msg.text());
      }
    });
    window.on('pageerror', err => {
      console.log('[renderer:error]', err.message);
      if (err.stack) console.log(err.stack);
    });

    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },
});

export { expect } from '@playwright/test';
