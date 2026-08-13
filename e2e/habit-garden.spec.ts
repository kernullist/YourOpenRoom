import { test, expect, type Page } from '@playwright/test';

const HABIT_GARDEN_APP_ID = 27;

// E2E for Habit Garden. The behaviors worth proving in a real browser are the
// ones that make or break a habit app: the check-in is genuinely one click, it
// undoes itself, the plant reacts in the same interaction, and a lapse never
// erases what was built.
//
// Habit state persists server-side in the suite's isolated OPENROOM_HOME, so
// every habit created here carries a per-run unique name.

async function openHabitGarden(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId(`app-icon-${HABIT_GARDEN_APP_ID}`).dblclick();
  await expect(page.getByTestId(`app-window-${HABIT_GARDEN_APP_ID}`)).toBeVisible();
  await page.getByTestId(`window-maximize-${HABIT_GARDEN_APP_ID}`).click();
  // The lazy app chunk can take a while on a cold dev-server transform.
  await expect(page.getByTestId('habit-garden')).toBeVisible({ timeout: 30_000 });
}

async function createHabit(page: Page, name: string): Promise<void> {
  await page.getByTestId('habit-garden-add').click();
  await expect(page.getByTestId('habit-garden-editor')).toBeVisible();
  await page.getByTestId('habit-garden-editor-name').fill(name);
  await page.getByTestId('habit-garden-editor-submit').click();
  await expect(page.getByTestId('habit-garden-editor')).toHaveCount(0);
  await expect(page.getByTestId('habit-garden-grid')).toContainText(name, { timeout: 15_000 });
}

test.describe('Habit Garden', () => {
  test('opens and shows the weather strip', async ({ page }) => {
    await openHabitGarden(page);

    const app = page.getByTestId('habit-garden');
    await expect(app.getByTestId('habit-garden-add')).toBeVisible();
    // The strip always says something about the weather, including that it is
    // too early to say.
    await expect(app.getByTestId('habit-garden-adherence')).toBeVisible();
  });

  test('creates a habit, checks it in with one click, and undoes it', async ({ page }) => {
    const name = `E2E 습관 ${Date.now()}`;
    await openHabitGarden(page);
    await createHabit(page, name);

    const app = page.getByTestId('habit-garden');
    // Scoped to buttons inside the bar: a prefix match on the testid would also
    // pick up the bar element itself, which shares the prefix.
    const chip = app.getByTestId('habit-garden-checkin-bar').locator('button', { hasText: name });

    // Not yet done.
    await expect(chip).toHaveAttribute('aria-pressed', 'false');

    // One click. No confirmation dialog appears.
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

    // The plant reacts in the same interaction: a check-in makes it a sprout.
    const plant = app.locator('[data-testid^="habit-garden-plant-"]', { hasText: name });
    await expect(plant).toHaveAttribute('data-stage', 'sprout');
    await expect(plant).toHaveAttribute('data-vitality', 'thriving');

    // The same click undoes it -- which is what makes "no confirmation" safe.
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });
    await expect(plant).toHaveAttribute('data-stage', 'seed');
  });

  test('opens a habit detail with its streak numbers', async ({ page }) => {
    const name = `E2E 상세 ${Date.now()}`;
    await openHabitGarden(page);
    await createHabit(page, name);

    const app = page.getByTestId('habit-garden');
    await app.locator('[data-testid^="habit-garden-plant-"]', { hasText: name }).click();

    const detail = app.getByTestId('habit-garden-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(name);
    await expect(detail).toContainText('현재');
    await expect(detail).toContainText('최장');
    await expect(app.getByTestId('habit-garden-heatmap')).toBeVisible();
  });

  test('requires a confirmation step before deleting, unlike check-in', async ({ page }) => {
    const name = `E2E 삭제 ${Date.now()}`;
    await openHabitGarden(page);
    await createHabit(page, name);

    const app = page.getByTestId('habit-garden');
    await app.locator('[data-testid^="habit-garden-plant-"]', { hasText: name }).click();
    await app.getByTestId('habit-garden-delete').click();

    // Deletion takes the history with it and cannot be undone, so it earns the
    // confirmation that a check-in deliberately does not get.
    await expect(app.getByTestId('habit-garden-delete-confirm')).toBeVisible();
    await app.getByTestId('habit-garden-delete-confirm-yes').click();

    await expect(app.getByTestId('habit-garden-grid')).not.toContainText(name, {
      timeout: 15_000,
    });
  });

  test('keeps the room-reflection switch off by default', async ({ page }) => {
    await openHabitGarden(page);

    const app = page.getByTestId('habit-garden');
    await app.getByTestId('habit-garden-settings-open').click();

    const settings = app.getByTestId('habit-garden-settings');
    await expect(settings).toBeVisible();
    // Opt-in: missing a habit must never silently repaint the desktop.
    await expect(app.getByTestId('habit-garden-toggle-room')).not.toBeChecked();
    // And the panel says plainly that the agent cannot flip either switch.
    await expect(settings).toContainText('Agent가 켜거나 끌 수 없습니다');
  });

  test('offers onboarding suggestions rather than statistics on an empty garden', async ({
    page,
  }) => {
    // Pinned empty: earlier tests in this file leave habits behind in the shared
    // isolated home, so the fixture is controlled rather than assumed.
    await page.route('**/api/session-data**', async (route) => {
      const url = route.request().url();
      if (url.includes('habitgarden') && url.includes('action=list')) {
        await route.fulfill({ json: { files: [] } });
        return;
      }
      await route.continue();
    });

    await openHabitGarden(page);

    const empty = page.getByTestId('habit-garden-empty');
    await expect(empty).toBeVisible({ timeout: 15_000 });
    await expect(empty).toContainText('아직 심은 것이 없어요');
    // No 0% scoreboard on the first screen.
    await expect(empty).not.toContainText('0%');
  });
});
