import { test, expect, type Page } from '@playwright/test';

const DRIVE_CONSOLE_APP_ID = 28;

// E2E for Drive Console. The behavior worth proving in a browser is that the
// plan is judged AS IT IS TYPED -- a blocked step has to be visible while the
// plan can still be changed, not only once execute fails.

async function openDriveConsole(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId(`app-icon-${DRIVE_CONSOLE_APP_ID}`).dblclick();
  await expect(page.getByTestId(`app-window-${DRIVE_CONSOLE_APP_ID}`)).toBeVisible();
  await page.getByTestId(`window-maximize-${DRIVE_CONSOLE_APP_ID}`).click();
  await expect(page.getByTestId('drive-console')).toBeVisible({ timeout: 30_000 });
}

/**
 * Open the plan view explicitly.
 *
 * The console persists activeView in state.json, which the suite shares across
 * tests in one isolated home. Assuming the app opens on 'plan' makes every test
 * depend on which one ran last.
 */
async function openPlanView(page: Page): Promise<void> {
  await page.getByTestId('drive-console-rail-plan').click();
  await expect(page.getByTestId('drive-console-add-step')).toBeVisible();
}

/**
 * Start every test from an empty plan.
 *
 * The draft persists in state.json and the suite shares one isolated home across
 * parallel workers, so leftover steps otherwise leak between tests. This clears
 * through the real remove control rather than adding a test-only affordance to
 * the app.
 */
async function resetPlan(page: Page): Promise<void> {
  await openPlanView(page);
  const steps = page.locator('[data-testid^="drive-console-step-select-"]');
  for (let guard = 0; guard < 30; guard += 1) {
    const count = await steps.count();
    if (count === 0) {
      break;
    }
    await page.getByLabel(`${count}번 단계 삭제`).click();
    await expect(steps).toHaveCount(count - 1);
  }
  await expect(steps).toHaveCount(0);
}

/**
 * Append a step and return ITS index.
 *
 * The draft persists in state.json and is shared across the suite, so steps
 * accumulate. Assuming index 0 makes every test depend on run order.
 */
async function addStep(page: Page): Promise<number> {
  const steps = page.locator('[data-testid^="drive-console-step-select-"]');
  const before = await steps.count();
  await page.getByTestId('drive-console-add-step').click();
  await expect(steps).toHaveCount(before + 1);
  return before;
}

test.describe('Drive Console', () => {
  test('switches between every section', async ({ page }) => {
    await openDriveConsole(page);

    const app = page.getByTestId('drive-console');
    for (const view of ['run', 'audit', 'plan']) {
      await app.getByTestId(`drive-console-rail-${view}`).click();
      await expect(app.getByTestId(`drive-console-rail-${view}`)).toHaveAttribute(
        'data-active',
        'true',
      );
    }
  });

  test('classifies a read step and an acting step differently as they are typed', async ({
    page,
  }) => {
    await openDriveConsole(page);
    const app = page.getByTestId('drive-console');
    await resetPlan(page);

    const readIndex = await addStep(page);
    await app.getByTestId(`drive-console-step-url-${readIndex}`).fill('https://example.com');
    // navigate is read-only.
    await expect(app.getByTestId(`drive-console-step-${readIndex}`)).toHaveAttribute(
      'data-category',
      'read',
    );

    const actIndex = await addStep(page);
    await app.getByLabel(`${actIndex + 1}번 동작`).selectOption('click');
    await app.getByTestId(`drive-console-step-selector-${actIndex}`).fill('#next');
    await expect(app.getByTestId(`drive-console-step-${actIndex}`)).toHaveAttribute(
      'data-category',
      'act',
    );

    // The summary line is the verdict the operator reads before touching anything.
    await expect(app.getByTestId('drive-console-summary')).toContainText('승인 필요');
  });

  test('blocks a password step while the plan can still be changed', async ({ page }) => {
    // The load-bearing behavior: this must be visible at authoring time, not
    // only when execute fails.
    await openDriveConsole(page);
    const app = page.getByTestId('drive-console');
    await resetPlan(page);

    const index = await addStep(page);
    await app.getByLabel(`${index + 1}번 동작`).selectOption('type');
    await app.getByTestId(`drive-console-step-selector-${index}`).fill('input[type=password]');

    await expect(app.getByTestId(`drive-console-step-${index}`)).toHaveAttribute(
      'data-category',
      'forbidden',
    );
    await expect(app.getByTestId(`drive-console-forbidden-${index}`)).toContainText('민감');
    // And the plan as a whole is refused, with a reason.
    await expect(app.getByTestId('drive-console-reject')).toBeVisible();
  });

  test('asks for a step before offering to run anything', async ({ page }) => {
    await openDriveConsole(page);
    const app = page.getByTestId('drive-console');
    // An empty plan means nothing can be selected, so 'no step' is genuine.
    await resetPlan(page);

    await app.getByTestId('drive-console-rail-run').click();

    await expect(app.getByTestId('drive-console-no-step')).toBeVisible();
  });

  test('shows the approval handoff rather than approving for the operator', async ({ page }) => {
    await openDriveConsole(page);
    const app = page.getByTestId('drive-console');
    await resetPlan(page);

    const index = await addStep(page);
    await app.getByTestId(`drive-console-step-select-${index}`).click();
    await app.getByTestId('drive-console-rail-run').click();

    await expect(app.getByTestId('drive-console-preview')).toBeVisible();
    await expect(app.getByTestId('drive-console-execute')).toBeVisible();
    // The approval lives in another surface, and the console says so plainly.
    await expect(app).toContainText('이 콘솔은 대신 승인하지 않습니다');
  });

  test('reports an unconfigured bridge as setup, not as a failure', async ({ page }) => {
    await page.route('**/api/aoi-host/browser-drive/audit**', (route) =>
      route.fulfill({
        status: 401,
        json: { ok: false, error: 'unauthorized', code: 'invalid_token' },
      }),
    );

    await openDriveConsole(page);
    const app = page.getByTestId('drive-console');
    await app.getByTestId('drive-console-rail-audit').click();

    const notice = app.getByTestId('drive-console-unconfigured');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText('고장이 아니라');
    await expect(app.getByTestId('drive-console-error')).toHaveCount(0);
  });
});
