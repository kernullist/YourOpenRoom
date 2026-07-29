import { test, expect } from '@playwright/test';

// E2E for R4.2: the Aoi Shared History panel in the Advanced tab.
//
// Persist-free (the aoi-* e2e convention): it opens the settings modal and
// asserts the display-only panel renders against the real backend. A fresh
// session has no retrospective yet, so the honest empty state is the expected
// render; the composition and parsing are covered by the unit suites. This
// confirms the surface is wired into the real modal and that an absent shared
// history reads as absent rather than as an error or an implied past.
test.describe('Chat settings – Aoi shared history panel', () => {
  test('renders the display-only shared history panel in the Advanced tab', async ({ page }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();
    await modal.getByTestId('advanced-section-operator').click();

    const panel = modal.locator('[data-testid="aoi-relationship-history-panel"]');
    await expect(panel).toBeVisible({ timeout: 15000 });
    await expect(panel.getByText('Aoi Shared History', { exact: true })).toBeVisible();
    await expect(panel).toContainText(/display-only/i);

    // The body renders either the honest empty state or real stored history if a
    // previous run on this reused e2e home produced one -- never an error.
    const body = panel.locator('[data-testid="aoi-relationship-history-body"]');
    await expect(body).toBeVisible({ timeout: 15000 });
    await expect(body).toContainText(/milestones/);

    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});
