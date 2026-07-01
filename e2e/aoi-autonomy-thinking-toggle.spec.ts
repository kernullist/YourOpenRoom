import { test, expect } from '@playwright/test';

// E2E for the Aoi autonomy "Thinking (network)" toggle: the Advanced-tab control
// that flips policy.allowNetwork (the per-session master switch for network-backed
// reasoning -- LLM / goal synthesis / proactive scout / semantic recall) so the
// operator turns Aoi's thinking on/off from the settings UI instead of env.
//
// Deliberately PERSIST-FREE: it only opens the panel and asserts the toggle renders
// with its On/Off label; it never clicks it, so nothing is written to the session
// store -- matching the existing aoi-* e2e convention. The update path
// (onUpdateAoiAutonomyPolicy -> POST /policy -> saveAoiAutonomyPolicy -> normalize of
// policy.allowNetwork) and the runner's effective-network derivation are covered by
// the unit tests; this only confirms the control is wired into the real settings modal.
test.describe('Chat settings – Aoi autonomy thinking toggle', () => {
  test('renders the Thinking (network) toggle in the Advanced tab', async ({ page }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();

    // The label + the toggle button both live in the autonomy controls block.
    await expect(modal.getByText('Thinking (network)', { exact: true })).toBeVisible();
    const toggle = modal.locator('[data-testid="aoi-autonomy-thinking-toggle"]');
    await expect(toggle).toBeVisible();
    // The button reflects policy.allowNetwork as On/Off (default off in a fresh session).
    await expect(toggle).toHaveText(/^(On|Off)$/);

    // Close without acting; nothing is written.
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});
