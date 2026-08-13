import { test, expect, type Page } from '@playwright/test';

const HOST_SENTINEL_APP_ID = 29;

// E2E for Host Sentinel. The behaviors worth proving in a browser are the honest
// ones: a photograph that says how old it is, an unconfigured bridge that reads
// as setup rather than failure, and a kill path that hands the approval off.

async function openHostSentinel(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId(`app-icon-${HOST_SENTINEL_APP_ID}`).dblclick();
  await expect(page.getByTestId(`app-window-${HOST_SENTINEL_APP_ID}`)).toBeVisible();
  await page.getByTestId(`window-maximize-${HOST_SENTINEL_APP_ID}`).click();
  await expect(page.getByTestId('host-sentinel')).toBeVisible({ timeout: 30_000 });
}

const LISTING = {
  ok: true,
  listing: {
    version: 1,
    sampledAt: Date.now(),
    records: [
      { pid: 4242, imageName: 'chrome.exe', memKb: 500_000 },
      { pid: 77, imageName: 'node.exe', memKb: 120_000 },
    ],
    summary: {
      version: 1,
      sampledAt: Date.now(),
      totalCount: 2,
      distinctImageCount: 2,
      topImages: [{ imageName: 'chrome.exe', count: 1 }],
    },
  },
};

async function withProcesses(page: Page): Promise<void> {
  await page.route('**/api/aoi-host/processes**', (route) => route.fulfill({ json: LISTING }));
  await page.route('**/api/aoi-host/status**', (route) =>
    route.fulfill({
      json: {
        ok: true,
        tokenConfigured: true,
        killSwitch: { globalPanic: false, enabledCapabilities: [], updatedAt: Date.now() },
      },
    }),
  );
}

/**
 * Point at a session and start from a clean filter.
 *
 * query and sessionPath persist in state.json, which the suite shares, so a
 * filter left behind by another test would hide the rows this one needs.
 */
async function setSession(page: Page): Promise<void> {
  await page.getByTestId('host-sentinel-filter').fill('');
  await page.getByTestId('host-sentinel-session').fill('aoi/space_adventure');
}

test.describe('Host Sentinel', () => {
  test('asks for a session before sampling anything', async ({ page }) => {
    await openHostSentinel(page);

    // Only meaningful when the field starts empty.
    await page.getByTestId('host-sentinel-session').fill('');
    await expect(page.getByTestId('host-sentinel-need-session')).toBeVisible();
  });

  test('shows the process sample together with how old it is', async ({ page }) => {
    await withProcesses(page);
    await openHostSentinel(page);
    await setSession(page);

    const app = page.getByTestId('host-sentinel');
    await expect(app.getByTestId('host-sentinel-table')).toBeVisible({ timeout: 15_000 });
    await expect(app.getByTestId('host-sentinel-row-4242')).toContainText('chrome.exe');
    // The age is never omitted: a kill carries a pid and pids get reused.
    await expect(app.getByTestId('host-sentinel-sample-age')).toBeVisible();
  });

  test('filters by image name and by pid', async ({ page }) => {
    await withProcesses(page);
    await openHostSentinel(page);
    await setSession(page);
    await expect(page.getByTestId('host-sentinel-table')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('host-sentinel-filter').fill('node');
    await expect(page.getByTestId('host-sentinel-row-77')).toBeVisible();
    await expect(page.getByTestId('host-sentinel-row-4242')).toHaveCount(0);

    await page.getByTestId('host-sentinel-filter').fill('4242');
    await expect(page.getByTestId('host-sentinel-row-4242')).toBeVisible();
  });

  test('hands the approval off instead of taking it', async ({ page }) => {
    await withProcesses(page);
    await openHostSentinel(page);
    await setSession(page);
    await expect(page.getByTestId('host-sentinel-table')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('host-sentinel-row-77').click();

    const panel = page.getByTestId('host-sentinel-kill');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('host-sentinel-kill-preview')).toBeVisible();
    await expect(panel.getByTestId('host-sentinel-kill-execute')).toBeVisible();
    await expect(panel).toContainText('되돌릴 수 없습니다');
    // And it is honest that the allowlist is not a boundary.
    await expect(panel).toContainText('보안 경계가');
  });

  test('states a panic stop before offering any control', async ({ page }) => {
    await page.route('**/api/aoi-host/processes**', (route) => route.fulfill({ json: LISTING }));
    await page.route('**/api/aoi-host/status**', (route) =>
      route.fulfill({
        json: {
          ok: true,
          tokenConfigured: true,
          killSwitch: { globalPanic: true, enabledCapabilities: [], updatedAt: Date.now() },
        },
      }),
    );

    await openHostSentinel(page);
    await setSession(page);

    await expect(page.getByTestId('host-sentinel-panic')).toBeVisible({ timeout: 15_000 });
  });

  test('reports an unconfigured bridge as setup, not as a failure', async ({ page }) => {
    await page.route('**/api/aoi-host/processes**', (route) =>
      route.fulfill({
        status: 401,
        json: { ok: false, error: 'unauthorized', code: 'invalid_token' },
      }),
    );

    await openHostSentinel(page);
    await setSession(page);

    const notice = page.getByTestId('host-sentinel-unconfigured');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText('고장이 아니라');
    await expect(page.getByTestId('host-sentinel-error')).toHaveCount(0);
  });
});
