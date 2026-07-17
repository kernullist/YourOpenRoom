import { expect, test } from '@playwright/test';

const AXES = [
  ['runtime_reliability', 'Runtime reliability', 10],
  ['situation_grounding', 'Situation grounding', 15],
  ['memory_personalization', 'Memory and personalization', 15],
  ['cognition_goal_continuity', 'Cognition and goal continuity', 15],
  ['action_validation_recovery', 'Action validation and recovery', 20],
  ['proactive_usefulness', 'Proactive usefulness', 10],
  ['outcome_learning_calibration', 'Outcome learning and calibration', 10],
  ['operator_field_truth', 'Operator field truth', 5],
] as const;
const GATE_IDS = [
  'gate.safety_integrity',
  'gate.canonical_session',
  'gate.live_evidence_class',
  'gate.real_closed_loop',
  'gate.rollback_recovery',
  'gate.cognition_grounding',
  'gate.manifest_integrity',
  'gate.broad_validation',
  'gate.axis_minimum_evidence',
] as const;

test.describe('Chat settings - Aoi non-voice claim console', () => {
  test('renders canonical provenance and switches evidence class in the real Advanced tab', async ({
    page,
  }) => {
    const requestedUrls: string[] = [];
    await page.route('**/api/aoi-autonomy/operator/non-voice-scorecard**', async (route) => {
      const url = new URL(route.request().url());
      const sessionPath = url.searchParams.get('sessionPath') ?? '';
      const evidenceClass = url.searchParams.get('evidenceClass') ?? 'live_field';
      requestedUrls.push(url.toString());
      const axisScores =
        evidenceClass === 'live_field'
          ? [9, 13, 13, 13, 18, 9, 5, 4]
          : evidenceClass === 'controlled_real'
            ? [5, 8, 8, 8, 10, 5, 5, 3]
            : [4, 6, 6, 6, 8, 4, 4, 2];
      const score = axisScores.reduce((total, value) => total + value, 0);
      const scoreCap = evidenceClass === 'synthetic' ? 59 : 89;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          sessionPath,
          evidenceClass,
          scorecard: {
            version: 1,
            id: `e2e-${evidenceClass}`,
            sessionPath,
            generatedAt: 1_800_000_000_000,
            lastValidatedAt: 1_799_999_000_000,
            evidenceClass,
            manifestFingerprint: 'c'.repeat(64),
            voiceExcluded: true,
            rawScore: score,
            score,
            scoreCap,
            level: score >= 75 ? 'field_capable' : score >= 50 ? 'developing' : 'baseline',
            claimEligible: false,
            axes: AXES.map(([id, label, weight], index) => ({
              version: 1,
              id,
              label,
              weight,
              rawScore: axisScores[index],
              score: axisScores[index],
              minimumEvidenceMet: true,
              sampleCount: 5,
              evidenceRefs: [`e2e:${id}`],
              blockers: [],
              nextEvidenceAction: `Collect ${id} evidence.`,
            })),
            hardGates: GATE_IDS.map((id) => ({
              version: 1,
              id,
              label: id.replace(/^gate\./, '').replace(/_/g, ' '),
              passed: id !== 'gate.broad_validation',
              reason: id === 'gate.broad_validation' ? 'validation stale' : 'passed',
              evidenceRefs: [],
            })),
            failedHardGateIds: ['gate.broad_validation'],
            recommendations: ['Run the current broad validation suite.'],
            evidenceRefs: ['e2e:manifest'],
            actionAuthority: 'display_only',
            mutationCount: 0,
          },
        }),
      });
    });

    await page.goto('/');
    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Advanced', exact: true }).click();

    const panel = modal.locator('[data-testid="aoi-non-voice-scorecard-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Aoi Non-Voice Claim Console', { exact: true })).toBeVisible();
    await expect(panel.locator('[data-testid="aoi-non-voice-claim-verdict"]')).toHaveText(
      'NOT CLAIM READY',
    );
    await expect(panel.getByLabel('Canonical score 84 out of 100')).toBeVisible();
    await expect(panel).toContainText('Manifest SHA-256');
    await expect(panel).toContainText('c'.repeat(64));
    await expect(panel).toContainText('Run the current broad validation suite.');
    await expect(panel.getByLabel('Runtime reliability')).toHaveAttribute('aria-valuenow', '9');

    const evidenceClass = panel.getByLabel('Evidence class');
    await evidenceClass.selectOption('controlled_real');
    await expect(
      panel.locator('[data-testid="aoi-non-voice-evidence-class-banner"]'),
    ).toContainText('CONTROLLED REAL');
    await expect(panel).toContainText('cannot substitute for a live-field claim');
    await expect(panel.getByLabel('Canonical score 52 out of 100')).toBeVisible();
    await expect(evidenceClass).toHaveValue('controlled_real');
    expect(requestedUrls.some((url) => url.includes('evidenceClass=live_field'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('evidenceClass=controlled_real'))).toBe(true);

    await panel.getByRole('button', { name: 'Refresh non-voice scorecard' }).focus();
    await expect(panel.getByRole('button', { name: 'Refresh non-voice scorecard' })).toBeFocused();
  });
});
