import { test, expect } from '@playwright/test';

// E2E for the Aoi "Field-shadow capture" toggle (P5.4): the Advanced-tab control that
// flips policy.fieldShadowCaptureEnabled, so the operator can enable the trust on-ramp's
// readiness-denominator capture from settings instead of an env var.
//
// Deliberately PERSIST-FREE: it only opens the panel and asserts the toggle renders with
// its On/Off label; it never clicks it, so nothing is written to the session store --
// matching the existing aoi-* e2e convention. The update path (onUpdateAoiAutonomyPolicy
// -> POST /policy -> normalize of fieldShadowCaptureEnabled) and the scheduler capture gate
// are covered by the unit tests; this confirms the control is wired into the real modal.
test.describe('Chat settings – Aoi field-shadow capture toggle', () => {
  test('renders the Field-shadow capture toggle in the Advanced tab', async ({ page }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();

    // Individual toggles now sit under a collapsed "Advanced" details section (the
    // Autonomy mode preset is the primary control); expand it to reach them.
    await modal.getByText('Advanced (individual toggles)', { exact: true }).click();

    await expect(modal.getByText('Field-shadow capture', { exact: true })).toBeVisible();
    const toggle = modal.locator('[data-testid="aoi-field-shadow-capture-toggle"]');
    await expect(toggle).toBeVisible();
    // The button reflects policy.fieldShadowCaptureEnabled as On/Off (a fresh session
    // now seeds the full autonomy mode, so this reads On).
    await expect(toggle).toHaveText(/^(On|Off)$/);

    // Close without acting; nothing is written.
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});
