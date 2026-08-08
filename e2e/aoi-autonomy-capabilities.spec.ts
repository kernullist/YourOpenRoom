import { test, expect } from '@playwright/test';

// E2E for the Autonomy Capabilities panel: the Advanced-tab surface that moved
// the capability gates out of environment variables and into settings.
//
// Unlike the persist-free aoi-* specs, this one DOES save: the whole point of
// the change is that a toggle here reaches config.json and outranks the env
// fallback, and a render-only assertion would pass just as happily against a
// panel wired to nothing. The suite runs against a throwaway OPENROOM_HOME, so
// the write lands in a scratch config.json, and the capability starts (and is
// left) off.
test.describe('Chat settings – Aoi autonomy capabilities', () => {
  test('toggles a capability and reports that settings, not env, decided it', async ({ page }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();

    const panel = modal.locator('[data-testid="aoi-autonomy-capability-panel"]');
    await expect(panel).toBeVisible();

    const toggle = panel.locator('[data-testid="aoi-capability-goal-synthesis-toggle"]');
    await expect(toggle).toHaveText('Disabled');
    // Nothing is set anywhere, so the resolver reports the built-in default.
    await expect(panel.getByText('(default)').first()).toBeVisible();

    await toggle.click();
    // The server round-trip replaces the optimistic flip and relabels the source.
    await expect(toggle).toHaveText('Enabled');
    await expect(panel.getByText('(set here)').first()).toBeVisible();

    // Put it back, so the suite leaves the capability off.
    await toggle.click();
    await expect(toggle).toHaveText('Disabled');
  });

  test('shows the environment-only gates as read-only status', async ({ page }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();

    const envOnly = modal.locator('[data-testid="aoi-capability-env-only"]');
    await expect(envOnly).toBeVisible();

    // Trust escalation stays with whoever runs the deployment: it is reported,
    // never offered as a control.
    const promotion = envOnly.locator(
      '[data-testid="aoi-capability-env-gate-AOI_AUTONOMY_AUTO_PROMOTE"]',
    );
    await expect(promotion).toBeVisible();
    await expect(promotion).toContainText(/^(On|Off) —/);
    await expect(envOnly.locator('button')).toHaveCount(0);
  });
});
