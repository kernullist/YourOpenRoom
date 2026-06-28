import { test, expect } from '@playwright/test';

// E2E for the Aoi Replay Promotion operator panel (the operator-review -> persisted
// -promotion surface that unlocks trusted_operator). There is no RTL in this repo, so
// this is the only coverage of the panel wired into the real chat-settings modal and
// rendering in a browser.
//
// Deliberately PERSIST-FREE: it only opens the panel and asserts it renders. It never
// clicks Promote / Defer / Reject, so POST /review-decision never fires and nothing is
// written to the real session store -- matching the existing e2e convention of not
// mutating server-side state. The fetch/parse/decision-body logic is covered by the
// aoiReplayPromotionPanelModel unit tests, and the persist round-trip by the
// aoiOperatorPromotionReviewServer unit tests.
test.describe('Chat settings – Aoi Replay Promotion panel', () => {
  test('is wired into the Advanced tab and renders the operator review surface', async ({
    page,
  }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    // The replay-promotion panel lives in the Advanced tab, next to Aoi Autonomy.
    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();

    const panel = modal.locator('[data-testid="aoi-replay-promotion-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Aoi Replay Promotion', { exact: true })).toBeVisible();
    // The panel always renders its purpose copy; this confirms the operator surface is
    // present without depending on any seeded candidate data.
    await expect(panel).toContainText(/unlocks trusted_operator/i);

    // Close without acting; nothing is written.
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});
