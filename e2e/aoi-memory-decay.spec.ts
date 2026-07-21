import { test, expect } from '@playwright/test';

// E2E for the Aoi Memory Decay operator panel (P4.1): preview archive candidates ->
// approve-to-archive (content-addressed) -> restore, wired into chat settings.
//
// Deliberately PERSIST-FREE: it only opens the panel and asserts it renders. It never
// clicks Archive, so POST /memory/decay-apply never fires and no memory is archived --
// matching the existing e2e convention of not mutating server-side state. The
// preview/apply/restore parse + body logic is covered by the aoiMemoryDecayPanelModel unit
// tests, the interaction by the AoiMemoryDecayPanel component tests, and the server
// fingerprint gate by the aoiDaemonServer decay-route tests.
test.describe('Chat settings – Aoi Memory Decay panel', () => {
  test('is wired into the Advanced tab and renders the decay operator surface', async ({
    page,
  }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    // The decay panel lives in the Advanced tab, next to the other Aoi operator panels.
    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();
    await modal.getByTestId('advanced-section-memory').click();

    const panel = modal.locator('[data-testid="aoi-memory-decay-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Aoi Memory Decay', { exact: true })).toBeVisible();
    // The card always renders its soft-delete / operator-approved marker.
    await expect(panel).toContainText(/soft-delete, operator-approved/i);

    // Close without acting; nothing is archived.
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});
