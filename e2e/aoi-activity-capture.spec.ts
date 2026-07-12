import { test, expect, type Page } from '@playwright/test';

// E2E for SA1.3: metadata-only live-activity capture.
//
// Proves the impacted flow end-to-end in the real app:
// 1. The 'Live app activity stream' source renders in the Advanced tab's
//    Environment sources list (the consent surface for the new source).
// 2. While the source is dark (default), opening an app captures NOTHING.
// 3. After the operator enables the source, opening an app fires exactly the
//    metadata-only POST /api/aoi-autonomy/activity/event (kind app_opened +
//    app slug; no params/content fields).
// The POST is intercepted (fulfilled with a stub) so no activity is persisted;
// the source consent itself is reset via the row's Clear button at the end so
// reruns against a reused e2e server start from the default-dark state.

const SOURCE_LABEL = 'Live app activity stream';

async function openAdvancedTab(page: Page) {
  await page.locator('[data-testid="settings-btn"]').click();
  const modal = page.locator('[data-testid="settings-modal"]');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: 'Advanced', exact: true }).click();
  return modal;
}

test.describe('Aoi live-activity capture (SA1.3)', () => {
  test('captures app_opened metadata only after explicit source consent', async ({ page }) => {
    const captured: Array<Record<string, unknown>> = [];
    await page.route('**/api/aoi-autonomy/activity/event', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      captured.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, sessionPath: body.sessionPath, event: null }),
      });
    });

    await page.goto('/');

    // --- Consent surface renders for the new source (default Disabled).
    const modal = await openAdvancedTab(page);
    const sourceRow = modal
      .locator('[class*="aoiAutonomyProposalItem"]')
      .filter({ hasText: SOURCE_LABEL });
    await expect(sourceRow).toBeVisible({ timeout: 15000 });
    const toggle = sourceRow.getByRole('button', { name: /^(Enabled|Disabled)$/ });
    await expect(toggle).toBeVisible();

    // Normalize leftover state from a reused e2e home: clear back to default.
    if ((await toggle.textContent())?.trim() === 'Enabled') {
      await sourceRow.getByRole('button', { name: 'Clear', exact: true }).click();
      await expect(toggle).toHaveText('Disabled');
    }

    // --- Dark by default: opening an app must capture nothing.
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
    await page.locator('[data-testid="app-icon-2"]').dblclick();
    // Give any (incorrect) capture a moment to fire before asserting silence.
    await page.waitForTimeout(800);
    expect(captured).toHaveLength(0);

    // --- Operator consents: enable the source from the panel.
    const modal2 = await openAdvancedTab(page);
    const sourceRow2 = modal2
      .locator('[class*="aoiAutonomyProposalItem"]')
      .filter({ hasText: SOURCE_LABEL });
    const toggle2 = sourceRow2.getByRole('button', { name: /^(Enabled|Disabled)$/ });
    await expect(toggle2).toHaveText('Disabled', { timeout: 15000 });
    await toggle2.click();
    await expect(toggle2).toHaveText('Enabled', { timeout: 15000 });
    await modal2.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal2).not.toBeVisible();

    // --- Live capture: opening an app now records app_opened metadata.
    await page.locator('[data-testid="app-icon-3"]').dblclick();
    await expect.poll(() => captured.length, { timeout: 10000 }).toBeGreaterThan(0);
    const openedEvent = captured.find((body) => body.kind === 'app_opened');
    expect(openedEvent).toBeDefined();
    expect(typeof openedEvent?.appId).toBe('string');
    expect((openedEvent?.appId as string).length).toBeGreaterThan(0);
    // Metadata only: the capture payload never carries params or content.
    expect(openedEvent).not.toHaveProperty('params');
    expect(openedEvent).not.toHaveProperty('content');

    // --- Reset consent to the default-dark state for rerun hygiene.
    const modal3 = await openAdvancedTab(page);
    const sourceRow3 = modal3
      .locator('[class*="aoiAutonomyProposalItem"]')
      .filter({ hasText: SOURCE_LABEL });
    await sourceRow3.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(sourceRow3.getByRole('button', { name: /^(Enabled|Disabled)$/ })).toHaveText(
      'Disabled',
      { timeout: 15000 },
    );
    await modal3.locator('button', { hasText: 'Cancel' }).click();
  });
});
