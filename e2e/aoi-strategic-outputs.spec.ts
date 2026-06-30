import { test, expect } from '@playwright/test';

// E2E for the Aoi strategic-outputs surface: the read-only Advanced-tab section
// that shows the autonomy tick's continuity brief + bounded goal work-order
// previews (P1a UI). There is no RTL in this repo, so this is the only coverage
// of the section wired into the real chat-settings modal and rendering in a
// browser.
//
// Deliberately PERSIST-FREE: it only opens the panel and asserts it renders. The
// brief / work-order previews only exist on a fresh tickResult, and the section
// always renders its title regardless, so this never runs a tick and never writes
// to the session store -- matching the existing e2e convention. The display-model
// shaping (brief panel + work-order previews, sanitize / dedupe / cap) is covered
// by the aoiAutonomyUiStrategicOutputs unit tests. The assertion targets the
// always-rendered title rather than the data-dependent empty-state copy, so it
// holds whether or not a tick has populated the section in the dev session.
test.describe('Chat settings – Aoi strategic outputs panel', () => {
  test('is wired into the Advanced tab and renders the read-only strategic outputs surface', async ({
    page,
  }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    // The strategic-outputs section lives in the Advanced tab, next to Aoi Autonomy.
    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();

    const panel = modal.locator('[data-testid="aoi-strategic-outputs"]');
    await expect(panel).toBeVisible();
    // The title is always rendered (outside the brief / work-order conditionals),
    // so this confirms the read-only surface is wired in without depending on any
    // seeded tick output.
    await expect(panel.getByText('Strategic outputs (last check)', { exact: true })).toBeVisible();

    // Close without acting; nothing is written.
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});
