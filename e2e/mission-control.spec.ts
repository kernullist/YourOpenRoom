import { test, expect, type Page } from '@playwright/test';

const MISSION_CONTROL_APP_ID = 26;

// E2E for Mission Control, the operator console over the autonomy runtime.
//
// The behaviors worth proving in a real browser are the honesty rules, because
// they are exactly what a unit test on a pure function cannot show: that a dead
// daemon produces a loud, actionable banner instead of a plausible-looking
// dashboard, and that a session-less install reads as "nothing to observe yet"
// rather than as a wall of errors.
//
// The e2e suite runs against an isolated OPENROOM_HOME on port 3100, so the
// autonomy store is genuinely empty here -- which makes the empty/unknown paths
// the DEFAULT case rather than something that has to be simulated.

async function openMissionControl(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId(`app-icon-${MISSION_CONTROL_APP_ID}`).dblclick();
  await expect(page.getByTestId(`app-window-${MISSION_CONTROL_APP_ID}`)).toBeVisible();
  await page.getByTestId(`window-maximize-${MISSION_CONTROL_APP_ID}`).click();
  // The lazy app chunk can take a while on a cold dev-server transform.
  await expect(page.getByTestId('mission-control')).toBeVisible({ timeout: 30_000 });
}

test.describe('Mission Control – operator console', () => {
  test('opens, renders the status strip, and switches sections', async ({ page }) => {
    await openMissionControl(page);

    const app = page.getByTestId('mission-control');

    // The strip is the one element promised at every width. It must be present
    // before anything else is trusted.
    await expect(app.getByRole('button', { name: '지금 갱신' })).toBeVisible();

    for (const section of ['queue', 'timeline', 'flight', 'metrics', 'runtime']) {
      await app.getByTestId(`mission-control-rail-${section}`).click();
      await expect(app.getByTestId(`mission-control-rail-${section}`)).toHaveAttribute(
        'data-active',
        'true',
      );
    }
  });

  test('reports a session-less install as a normal state, not an error', async ({ page }) => {
    // The empty list is pinned rather than relied upon: other specs in this
    // suite initialize an autonomy store in the shared isolated home, so the
    // real route legitimately returns a session by the time this runs. What is
    // being tested is the console's handling of "no sessions", not the fixture.
    await page.route('**/api/aoi-autonomy/sessions', (route) =>
      route.fulfill({ json: { ok: true, sessions: [] } }),
    );

    await openMissionControl(page);

    const notice = page.getByTestId('mission-control-no-sessions');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText('관측할 세션이 없습니다');
    // A fresh install must not be told something is broken.
    await expect(notice).toContainText('aoi-autonomy/policy.json');
    // And it must not be dressed up as a failure.
    await expect(notice).not.toContainText('HTTP');
  });

  test('picks up a real session from the live store when one exists', async ({ page, request }) => {
    const response = await request.get('/api/aoi-autonomy/sessions');
    const body = (await response.json()) as { sessions: Array<{ sessionPath: string }> };
    test.skip(body.sessions.length === 0, 'no autonomy store initialized in this run');

    await openMissionControl(page);

    // The console defaults to the newest session with no operator input, so the
    // real path appears in the strip's session control.
    await expect(page.getByTestId('mission-control')).toContainText(body.sessions[0].sessionPath, {
      timeout: 15_000,
    });
    await expect(page.getByTestId('mission-control-no-sessions')).toHaveCount(0);
  });

  test('serves the bootstrap session route without a sessionPath', async ({ request }) => {
    // Every other autonomy route 400s without a sessionPath. This one has to
    // answer cold or the console can never address any of them.
    const response = await request.get('/api/aoi-autonomy/sessions');

    expect(response.status()).toBe(200);
    const body = (await response.json()) as { ok: boolean; sessions: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  test('shows a loud, actionable banner when the daemon is not running', async ({ page }) => {
    // The e2e dev server runs no Aoi daemon, so the probe genuinely reports
    // not_running -- no mocking required for the honest path. Pinning the
    // response only removes the timing flake of a probe that is still in flight.
    await page.route('**/api/aoi-daemon/health', (route) =>
      route.fulfill({ json: { status: 'not_running', port: 7333 } }),
    );

    await openMissionControl(page);

    const banner = page.getByTestId('mission-control-daemon-dead');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('Start-App.ps1 -Aoi');

    // The strip agrees with the banner rather than showing a soothing default.
    await expect(page.getByTestId('mission-control')).toContainText('NOT RUNNING');
  });

  test('never renders an unvalidatable daemon snapshot as healthy', async ({ page }) => {
    // A daemon that answers with something we cannot parse is not proof the loop
    // is up. This is the single most important lie the console must not tell.
    await page.route('**/api/aoi-daemon/health', (route) =>
      route.fulfill({ json: { status: 'running', port: 7333, snapshot: { nonsense: true } } }),
    );

    await openMissionControl(page);

    const app = page.getByTestId('mission-control');
    await expect(app).toContainText('UNREACHABLE', { timeout: 15_000 });
    await expect(app).not.toContainText('NOT RUNNING');
    await expect(page.getByTestId('mission-control-daemon-dead')).toHaveCount(0);
  });

  test('distinguishes a failed read from an empty one', async ({ page }) => {
    await page.route('**/api/aoi-autonomy/sessions', (route) =>
      route.fulfill({
        json: { ok: true, sessions: [{ sessionPath: 'aoi/e2e', updatedAt: 1 }] },
      }),
    );
    await page.route('**/api/aoi-autonomy/proposals**', (route) =>
      route.fulfill({
        status: 500,
        json: { error: 'proposal store unreadable', code: 'io_error' },
      }),
    );

    await openMissionControl(page);

    const app = page.getByTestId('mission-control');
    await app.getByTestId('mission-control-rail-queue').click();

    // The failure is reported verbatim, with its HTTP status -- not silently
    // flattened into "활성 제안이 없습니다".
    await expect(app).toContainText('proposal store unreadable', { timeout: 15_000 });
    await expect(app).toContainText('HTTP 500');
    await expect(app).not.toContainText('활성 제안이 없습니다');
  });

  test('lets an operator open a proposal and see the decision controls', async ({ page }) => {
    // Unique per run: the console persists selectedProposalId in state.json, so a
    // fixed id would be restored from a previous run and the click below would
    // TOGGLE the inspector shut instead of opening it.
    const proposalId = `proposal-e2e-${Date.now()}`;

    await page.route('**/api/aoi-autonomy/sessions', (route) =>
      route.fulfill({ json: { ok: true, sessions: [{ sessionPath: 'aoi/e2e', updatedAt: 1 }] } }),
    );
    await page.route('**/api/aoi-autonomy/proposals**', (route) =>
      route.fulfill({
        json: {
          ok: true,
          sessionPath: 'aoi/e2e',
          active: [
            {
              version: 1,
              id: proposalId,
              sessionPath: 'aoi/e2e',
              status: 'active',
              title: 'Re-read the kernel research report',
              body: 'A previous research run likely answers the current question.',
              reason: 'The current topic matches a completed research memory.',
              trigger: 'research_followup',
              createdAt: Date.now() - 60_000,
              updatedAt: Date.now() - 60_000,
              cooldownKey: 'research:kernel',
              confidence: 0.82,
              risk: 'low',
              requiredAutonomyLevel: 'L2',
              requiresUserApproval: true,
              suggestedTools: ['read_research_artifact'],
              evidenceRefs: ['memory:aoi-memory-001'],
              memoryIds: [],
              artifactRefs: [],
              riskSignals: [],
            },
          ],
          archived: [],
        },
      }),
    );

    await openMissionControl(page);

    const app = page.getByTestId('mission-control');
    await app.getByTestId('mission-control-rail-queue').click();

    const list = app.getByTestId('mission-control-proposal-list');
    await expect(list).toBeVisible({ timeout: 15_000 });
    await expect(list).toContainText('Re-read the kernel research report');

    // The rail badge reflects the pending count.
    await expect(app.getByTestId('mission-control-rail-queue')).toContainText('1');

    await list.getByRole('button').first().click();

    const inspector = app.getByTestId('mission-control-proposal-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText('The current topic matches a completed research memory.');
    await expect(inspector).toContainText('APPROVAL REQUIRED');
    // The decision controls exist and belong to the operator.
    await expect(app.getByTestId('mission-control-proposal-accept')).toBeVisible();
  });
});
