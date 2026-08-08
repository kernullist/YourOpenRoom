import { test, expect } from '@playwright/test';

// E2E for the Aoi "Agentic reflection" toggle. The policy field existed and was
// normalized and honored, but had no control of its own: the only way to change
// it was to pick a different autonomy mode, which moves five other switches with
// it. This is the missing control.
//
// This one CLICKS. A render-only assertion here would be tautological -- the
// label is a two-valued ternary, so it stays green even if the handler were
// copy-pasted from the Field-shadow toggle above and left writing the wrong
// policy field. Toggling and asserting that THIS row flipped while its neighbour
// did not is the only thing that catches that. The suite runs against a
// throwaway OPENROOM_HOME, and the spec restores the original value.
test.describe('Chat settings – Aoi agentic reflection toggle', () => {
  test('toggles agentic reflection without touching its neighbour', async ({ page }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();
    await modal.getByText('Advanced (individual toggles)', { exact: true }).click();

    await expect(modal.getByText('Agentic reflection', { exact: true })).toBeVisible();
    const toggle = modal.locator('[data-testid="aoi-agentic-reflection-toggle"]');
    const neighbour = modal.locator('[data-testid="aoi-field-shadow-capture-toggle"]');
    await expect(toggle).toHaveText(/^(On|Off)$/);

    const before = (await toggle.textContent())?.trim() ?? '';
    const neighbourBefore = (await neighbour.textContent())?.trim() ?? '';
    const flipped = before === 'On' ? 'Off' : 'On';

    await toggle.click();
    await expect(toggle).toHaveText(flipped);
    // The row next to it must be untouched: a handler writing the wrong policy
    // field would move this one instead.
    await expect(neighbour).toHaveText(neighbourBefore);

    // Restore.
    await toggle.click();
    await expect(toggle).toHaveText(before);
  });
});
