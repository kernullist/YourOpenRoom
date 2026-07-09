import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';

// Point the dev server at a throwaway ~/.openroom so e2e runs are fully isolated
// from the developer's real config, characters, mods, and per-session data
// (chat history, the YouTube state.json, autonomy state). The app seeds a default
// character/mod into an empty home, so it renders normally. Because this home is
// disposable, the destructive /api/openroom-reset used by agent-tools is safe to
// enable here (OPENROOM_ALLOW_RESET below) — and it only affects the server
// Playwright launches, never a reused real dev server (see reuseExistingServer).
const E2E_HOME_DIR = resolve(__dirname, 'e2e/.tmp-home');

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
    baseURL: 'http://localhost:3000',
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
    url: 'http://localhost:3000',
    // Reused locally for iteration speed: when a dev server is already running
    // the session-isolation env below is NOT applied to it, so a fully isolated
    // run needs no pre-existing server (always the case in CI).
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      OPENROOM_HOME: E2E_HOME_DIR,
      // Safe here because OPENROOM_HOME above is a disposable directory; the
      // reset can only wipe this throwaway home, never the developer's real one.
      OPENROOM_ALLOW_RESET: '1',
    },
  },
});
