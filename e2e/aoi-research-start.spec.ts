import { test, expect } from '@playwright/test';

// E2E for the Aoi Research "new run" composer: the run-creation form added to the
// Aoi Research app, which was previously a read-only library (list / report /
// cancel only). Apps mount as same-realm React components inside the app window,
// so the composer is reachable by data-testid without a frame locator.
//
// Deliberately PERSIST-FREE: it opens the app, asserts the request field + Start
// button render, and checks the disabled -> enabled -> disabled transition driven
// by the request text. It never clicks Start, so no research run is created and
// nothing hits Tavily or the session store -- matching the existing aoi-* e2e
// convention. The start call itself (POST /api/aoi-research/start, input
// normalization, and 409 / 429 / error mapping) is covered by the
// aoiResearchClient unit tests.
test.describe('Aoi Research – new run composer', () => {
  test('renders the composer in the app window and toggles Start on input', async ({ page }) => {
    await page.goto('/');

    // Open the Aoi Research app (appId 24) from the desktop.
    const icon = page.locator('[data-testid="app-icon-24"]');
    await expect(icon).toBeVisible();
    await icon.dblclick();

    const appWindow = page.locator('[data-testid="app-window-24"]');
    await expect(appWindow).toBeVisible({ timeout: 10000 });

    const composer = appWindow.locator('[data-testid="aoi-research-composer"]');
    await expect(composer).toBeVisible();

    const requestInput = appWindow.locator('[data-testid="aoi-research-new-request"]');
    const startBtn = appWindow.locator('[data-testid="aoi-research-start-btn"]');
    await expect(requestInput).toBeVisible();
    await expect(startBtn).toBeVisible();

    // Start is disabled with an empty request, enabled once text is entered,
    // and disabled again when cleared.
    await expect(startBtn).toBeDisabled();
    await requestInput.fill('Investigate kernel anti-tamper posture');
    await expect(startBtn).toBeEnabled();
    await requestInput.fill('');
    await expect(startBtn).toBeDisabled();

    // Close the window; nothing was started.
    await page.locator('[data-testid="window-close-24"]').click();
    await expect(appWindow).not.toBeVisible();
  });
});
