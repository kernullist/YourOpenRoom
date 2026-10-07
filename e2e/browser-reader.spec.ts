import { test, expect } from '@playwright/test';

const BROWSER_APP_ID = 17;

// The reader's fetch effect used to depend on a callback that changed after every
// successful load (it closed over `history`, which the load itself updated), so a
// page was fetched -- and its history entry rewritten -- in a loop for as long as
// the window stayed open.
test('a page is fetched once, not in a loop', async ({ page }) => {
  // Unique per run: the suite shares one persisted home, and a URL restored from
  // a previous run would otherwise be counted too.
  const target = `https://reader-loop.example/article-${Date.now()}`;
  let readerFetches = 0;

  await page.route('**/api/browser-reader?**', async (route) => {
    const requested = new URL(route.request().url()).searchParams.get('url') ?? '';
    if (requested !== target) {
      await route.continue();
      return;
    }
    if (['fetch', 'xhr'].includes(route.request().resourceType())) {
      readerFetches += 1;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'X-Final-Url': target },
      body: '<html><head><title>Loop Test</title></head><body><article><h1>Loop Test</h1><p>One fetch is enough.</p></article></body></html>',
    });
  });

  await page.goto('/');
  await page.getByTestId(`app-icon-${BROWSER_APP_ID}`).dblclick();
  await expect(page.getByTestId(`app-window-${BROWSER_APP_ID}`)).toBeVisible();

  const address = page.getByTestId('browser-address-input');
  await expect(address).toBeVisible({ timeout: 30_000 });
  await address.fill(target);
  await address.press('Enter');

  await expect.poll(() => readerFetches, { timeout: 15_000 }).toBeGreaterThan(0);
  // The loop re-fetched every few hundred milliseconds; give it room to show.
  await page.waitForTimeout(2_500);
  expect(readerFetches).toBe(1);
});
