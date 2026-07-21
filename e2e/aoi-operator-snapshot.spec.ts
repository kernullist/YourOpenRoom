import { test, expect } from '@playwright/test';

// E2E for the Aoi Operator Snapshot panel (P5.3): the previously-dark unified operator
// model, now built from real stores server-side and surfaced read-only in chat settings.
// There is no RTL-in-browser coverage otherwise, so this confirms the panel is wired into
// the real chat-settings Advanced tab and renders in a browser.
//
// Read-only by construction: the panel only issues a GET for the display_only snapshot on
// mount; it never writes. This spec asserts the card renders (title + display-only hint)
// without depending on any seeded session data. The fetch/parse logic is covered by the
// aoiOperatorSnapshotPanelModel unit tests and the render branches by the
// AoiOperatorSnapshotPanel component tests.
test.describe('Chat settings – Aoi Operator Snapshot panel', () => {
  test('is wired into the Advanced tab and renders the display-only operator surface', async ({
    page,
  }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    // The operator-snapshot panel lives in the Advanced tab, next to Aoi Replay Promotion.
    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();
    await modal.getByTestId('advanced-section-operator').click();

    const panel = modal.locator('[data-testid="aoi-operator-snapshot-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Aoi Operator Snapshot', { exact: true })).toBeVisible();
    // The card always renders its display-only marker regardless of snapshot contents.
    await expect(panel).toContainText(/display-only/i);

    // Close without acting; the panel never writes anything anyway.
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});
