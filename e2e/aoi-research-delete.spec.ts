import { test, expect } from '@playwright/test';

// E2E for the Aoi Research delete control: the Trash button + two-step inline
// confirm added to the report header so an operator can remove a run from the
// library. The run list is mocked so the test is deterministic and does not
// depend on (or mutate) the real session store; it never confirms the delete,
// so no /delete call is made. The delete call itself (client + backend helper,
// incl. active-run refusal and path guards) is covered by the aoiResearchClient
// and aoiResearchPlugin unit tests.
test.describe('Aoi Research – delete control', () => {
  test('shows the delete button and toggles the inline confirm without deleting', async ({
    page,
  }) => {
    const run = {
      id: 'aoi-research-e2e-del',
      sessionPath: 'aoi/default',
      request: 'E2E deletable run',
      title: 'E2E deletable run',
      mode: 'standard',
      language: 'match-user',
      recency: 'any',
      maxSources: 12,
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
      status: 'completed',
      phase: 'completed',
      statusMessage: 'completed',
      sourceCounts: { planned: 12, candidates: 6, accepted: 4, failed: 0 },
      claimCount: 10,
      warningCount: 0,
      verificationWarningCount: 0,
    };

    await page.route('**/api/aoi-research/list**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          sessionPath: 'aoi/default',
          runs: [run],
          maxConcurrentRuns: 3,
        }),
      });
    });
    await page.route('**/api/aoi-research/artifact**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          runId: run.id,
          artifact: 'report',
          contentType: 'text/markdown',
          content: '# E2E report',
        }),
      });
    });

    await page.goto('/');
    const icon = page.locator('[data-testid="app-icon-24"]');
    await icon.dblclick();
    const appWindow = page.locator('[data-testid="app-window-24"]');
    await expect(appWindow).toBeVisible({ timeout: 10000 });

    // The mocked completed run auto-selects, so its report header (and delete
    // button) render.
    const deleteBtn = appWindow.locator('[data-testid="aoi-research-delete-btn"]');
    await expect(deleteBtn).toBeVisible();

    // Clicking delete reveals the inline confirm; the raw delete button hides.
    await deleteBtn.click();
    const confirm = appWindow.locator('[data-testid="aoi-research-delete-confirm"]');
    await expect(confirm).toBeVisible();
    await expect(appWindow.locator('[data-testid="aoi-research-delete-yes"]')).toBeVisible();
    await expect(deleteBtn).toHaveCount(0);

    // Cancelling the confirm restores the delete button and deletes nothing.
    await appWindow.locator('[data-testid="aoi-research-delete-no"]').click();
    await expect(confirm).toHaveCount(0);
    await expect(deleteBtn).toBeVisible();
  });
});
