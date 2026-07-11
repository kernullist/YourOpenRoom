import { test, expect } from '@playwright/test';

// E2E for P1.1 (client half): a real UI juncture emits an AoiOutcomeSignalRecord.
// Opening a proposal's evidence panel is a weak interest signal, so the client
// POSTs { outcomeKind: 'proposal_opened', sourceProposalId } to the outcomes
// route. The signal-building + dedup logic is covered by aoiOutcomeSignalJunctures
// unit tests; this asserts the WIRING: an expand click fires exactly that POST.
//
// The proposals list is stubbed so exactly one active proposal renders in the
// Advanced tab (the throwaway e2e home has none). Every other autonomy fetch hits
// the real isolated server, so the dashboard still assembles normally.
const PROPOSAL_ID = 'e2e-proposal-open-1';

function proposalFixture(now: number) {
  return {
    version: 1,
    id: PROPOSAL_ID,
    sessionPath: 'aoi/default',
    status: 'active',
    title: 'E2E: stabilize the flaky retry path',
    body: 'Investigate repeated retries and propose a fix.',
    reason: 'Repeated retries observed in recent runs.',
    trigger: 'test_signal',
    createdAt: now - 1000,
    updatedAt: now - 1000,
    cooldownKey: 'e2e-open-topic',
    confidence: 0.7,
    risk: 'low',
    requiredAutonomyLevel: 'L3',
    requiresUserApproval: false,
    suggestedTools: [],
    evidenceRefs: [],
    memoryIds: [],
    artifactRefs: [],
    riskSignals: [],
  };
}

test.describe('Chat settings – Aoi proposal outcome signal (P1.1)', () => {
  test('records proposal_opened when a proposal evidence panel is expanded', async ({ page }) => {
    // Stub only the proposals list; one active proposal renders in Advanced.
    await page.route('**/api/aoi-autonomy/proposals**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionPath: 'aoi/default',
          active: [proposalFixture(Date.now())],
          archived: [],
        }),
      });
    });

    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    // Opening Advanced runs refreshAoiAutonomy -> the proposals fetch -> our stub.
    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();

    const expandBtn = modal.locator(`[data-testid="aoi-proposal-expand-${PROPOSAL_ID}"]`);
    await expect(expandBtn).toBeVisible({ timeout: 20000 });

    // Expanding must POST a proposal_opened outcome signal for this proposal.
    const outcomePost = page.waitForRequest(
      (req) => req.url().includes('/api/aoi-autonomy/outcomes') && req.method() === 'POST',
      { timeout: 20000 },
    );
    await expandBtn.click();
    const request = await outcomePost;
    const body = JSON.parse(request.postData() ?? '{}') as {
      outcomeKind?: string;
      sourceProposalId?: string;
    };
    expect(body.outcomeKind).toBe('proposal_opened');
    expect(body.sourceProposalId).toBe(PROPOSAL_ID);

    // A second expand/collapse of the same proposal must NOT re-report (dedup).
    let secondPost = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/aoi-autonomy/outcomes') && req.method() === 'POST') {
        secondPost = true;
      }
    });
    await expandBtn.click(); // collapse
    await expandBtn.click(); // expand again
    await page.waitForTimeout(500);
    expect(secondPost).toBe(false);

    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});
