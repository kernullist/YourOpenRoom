import { test, expect } from '@playwright/test';

// E2E for the Aoi preference-poll dashboard (Advanced tab): the operator-facing
// panel that shows the tastes/interests Aoi has learned and lets the user set or
// clear any answer (the same localStorage + memory stores the chat loop writes).
//
// Unlike the persist-free aoi-* smoke specs, this drives the PRIMARY user path --
// set an answer, then clear it -- and asserts the option's pressed state, the
// per-row Clear control, and the global answered tally all move and then reset.
// Selectors are language-independent (aria-pressed + structural), so the spec holds
// under any resolveNudgeLang() default. Playwright gives each test a fresh browser
// context (empty localStorage) and the set/clear nets back to the starting tally,
// so nothing leaks into the isolated e2e home or a sibling spec.
test.describe('Chat settings – Aoi preference dashboard', () => {
  test('sets and clears a learned preference from the dashboard', async ({ page }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();
    await modal.getByTestId('advanced-section-memory').click();

    const dashboard = modal.locator('[data-testid="aoi-preference-dashboard"]');
    await expect(dashboard).toBeVisible();
    // Header chrome is wired: the answered-summary subtitle and the "have Aoi write
    // new questions" control both render (the generate control is asserted present
    // but never clicked -- it triggers a network-backed bank expansion).
    await expect(dashboard.locator('[data-testid="aoi-preference-summary"]')).toBeVisible();
    await expect(dashboard.locator('[data-testid="aoi-preference-generate"]')).toBeVisible();

    // The answered tally = the count of pressed option buttons across the whole bank.
    const pressed = dashboard.locator('button[aria-pressed="true"]');
    const answeredBefore = await pressed.count();

    // Drive the first question row: it must expose selectable option buttons.
    const firstQuestion = dashboard.locator('[data-testid^="aoi-preference-q-"]').first();
    await expect(firstQuestion).toBeVisible();
    const firstOption = firstQuestion.locator('button[aria-pressed]').first();
    await expect(firstOption).toHaveAttribute('aria-pressed', 'false');
    // Before an answer exists, the row shows no Clear control (Clear = the only
    // non-option button in the row; option buttons all carry aria-pressed).
    const clearButton = firstQuestion.locator('button:not([aria-pressed])');
    await expect(clearButton).toHaveCount(0);

    await firstOption.click();

    // Setting an answer: the option becomes pressed, a Clear control appears in the
    // row, and the global answered tally goes up by exactly one.
    await expect(firstOption).toHaveAttribute('aria-pressed', 'true');
    await expect(clearButton).toHaveCount(1);
    await expect.poll(() => pressed.count()).toBe(answeredBefore + 1);

    // Clearing it: the option un-presses, the Clear control disappears, and the
    // tally returns to where it started -- the full set -> clear round trip.
    await clearButton.click();
    await expect(firstOption).toHaveAttribute('aria-pressed', 'false');
    await expect(clearButton).toHaveCount(0);
    await expect.poll(() => pressed.count()).toBe(answeredBefore);

    // Close without leaving the modal open for a sibling spec.
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});
