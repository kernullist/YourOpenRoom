import { test, expect } from '@playwright/test';

// E2E for the P2/B3-1 c3 client-mediated app-operation dispatch bridge. The bridge has
// no UI of its own: it runs inside refreshAoiAutonomy, which the Advanced tab triggers,
// and polls the pending app-operation dispatches the autonomy loop queued (GET
// /api/aoi-autonomy/app-operation-dispatch), re-checks each approval, dispatches to the
// loaded app, and reports the result back.
//
// Deliberately PERSIST-FREE: the feature is OFF by default, so no dispatches are queued
// and the poll returns an empty list -- nothing is written. This asserts the WIRING is
// live (opening Advanced fires the read-only poll and the route answers 200 with a
// pending array) and that the bridge does not break the dashboard. The live round-trip
// (re-check -> dispatch -> report) and every decision branch are covered by the
// aoiAppOperationDispatchBridge unit tests; the route round-trip by the daemon tests.
test.describe('Chat settings – Aoi app-operation dispatch bridge', () => {
  test('polls pending app-operation dispatches when the Advanced tab refreshes autonomy', async ({
    page,
  }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    // Opening Advanced runs refreshAoiAutonomy -> the client dispatch bridge -> a GET poll
    // of the pending dispatches. Wait for that read-only poll to confirm the wiring fires.
    const dispatchPoll = page.waitForResponse(
      (response) => response.url().includes('/api/aoi-autonomy/app-operation-dispatch'),
      { timeout: 20000 },
    );
    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();

    const response = await dispatchPoll;
    expect(response.request().method()).toBe('GET');
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { ok?: boolean; pending?: unknown };
    expect(body.ok).toBe(true);
    // OFF by default -> the loop queued nothing, so the poll returns an empty list.
    expect(Array.isArray(body.pending)).toBe(true);

    // The Advanced surface still renders after the bridge ran (wiring did not break it).
    await expect(modal.locator('[data-testid="aoi-strategic-outputs"]')).toBeVisible();

    // Close without acting; nothing is written.
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});
