import { test, expect } from '@playwright/test';

// E2E for SA4.4: the Aoi Current Situation panel in the Advanced tab.
//
// Deliberately PERSIST-FREE (the aoi-* e2e convention): it opens the settings
// modal and asserts the display-only panel renders against the real backend
// (a fresh session serves situation:null -> the honest empty state). The full
// fusion pipeline is covered by the unit/integration suites; this confirms the
// operator surface is wired into the real modal.
test.describe('Chat settings – Aoi current situation panel', () => {
  test('renders the display-only situation panel in the Advanced tab', async ({ page }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();
    await modal.getByTestId('advanced-section-operator').click();

    const panel = modal.locator('[data-testid="aoi-situation-panel"]');
    await expect(panel).toBeVisible({ timeout: 15000 });
    await expect(panel.getByText('Aoi Current Situation', { exact: true })).toBeVisible();
    await expect(panel).toContainText(/display-only/i);
    // Against a fresh session the honest empty state (or a fused brief, if a
    // wakeup already ran on a reused e2e home) must render -- never an error.
    await expect(panel.locator('[data-testid="aoi-situation-panel-body"]')).toBeVisible({
      timeout: 15000,
    });
    // SA5.2: the grounding scorecard line renders from the real backend.
    await expect(panel.locator('[data-testid="aoi-cognition-readiness-line"]')).toContainText(
      /Cognition readiness: (ungrounded|sensing|inferring|grounded|live_grounded)/,
      { timeout: 15000 },
    );

    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});
