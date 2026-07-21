import { test, expect } from '@playwright/test';

// E2E for the Aoi Trust On-ramp readiness accrual panel (P5.4): surfaces the previously
// invisible readiness accrual (sample count -> directChatReady) so the trust ladder is
// observable. Read-only (a GET on mount); asserts the panel renders in the real Advanced
// tab. The fetch/parse is covered by aoiReadinessAccrualPanelModel unit tests, the render
// branches by the AoiReadinessAccrualPanel component tests, and the server assembly by the
// aoiDaemonServer readiness-accrual route test.
test.describe('Chat settings – Aoi Trust On-ramp panel', () => {
  test('is wired into the Advanced tab and renders the readiness accrual surface', async ({
    page,
  }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();
    await modal.getByTestId('advanced-section-operator').click();

    const panel = modal.locator('[data-testid="aoi-readiness-accrual-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Aoi Trust On-ramp', { exact: true })).toBeVisible();
    await expect(panel).toContainText(/readiness accrual/i);

    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});
