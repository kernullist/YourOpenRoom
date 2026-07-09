import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';

// Point the dev server at a throwaway ~/.openroom so e2e runs are fully isolated
// from the developer's real config, characters, mods, and per-session data
// (chat history, the YouTube state.json, autonomy state). The app seeds a default
// character/mod into an empty home, so it renders normally. Because this home is
// disposable, the destructive /api/openroom-reset used by agent-tools is safe to
// enable here (OPENROOM_ALLOW_RESET below).
const E2E_HOME_DIR = resolve(__dirname, 'e2e/.tmp-home');

// The suite runs on its own port so it NEVER reuses a developer's real dev
// server on 3000 (which serves the real home dir — its chat history and app
// state leak into specs and fail them). reuseExistingServer can then only ever
// match a previous Playwright-launched server here, which is always isolated.
const E2E_PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // The dev server transforms modules on demand and is CPU-bound, so it serializes
  // work anyway; letting Playwright spin up many workers just floods a cold server
  // with simultaneous cold page loads and causes load-timeout flakiness. Cap local
  // concurrency to a level the dev server can actually serve. CI stays at 1.
  workers: process.env.CI ? 1 : 2,
  reporter: 'html',
  // The dev server transforms modules on demand, so the first cold page load of
  // a large app is legitimately slow; give tests headroom beyond Playwright's
  // 30s default so a slow-but-correct load is not reported as a failure.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: 'on-first-retry',
    navigationTimeout: 45_000,
    actionTimeout: 20_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: `http://localhost:${E2E_PORT}`,
    // Reused locally for iteration speed. Only a previous Playwright-launched
    // server can be listening on E2E_PORT, and that one was started with the
    // isolation env below, so reuse never points tests at real user data.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      OPENROOM_DEV_PORT: String(E2E_PORT),
      OPENROOM_HOME: E2E_HOME_DIR,
      // Safe here because OPENROOM_HOME above is a disposable directory; the
      // reset can only wipe this throwaway home, never the developer's real one.
      OPENROOM_ALLOW_RESET: '1',
    },
  },
});
