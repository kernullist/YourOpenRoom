import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AoiFieldEvidenceClass } from '@/lib/aoiFieldEvidenceManifest';
import type {
  AoiNonVoiceJarvisAxisId,
  AoiNonVoiceJarvisScorecard,
} from '@/lib/aoiNonVoiceJarvisScorecard';

import { AoiNonVoiceScorecardPanel } from './AoiNonVoiceScorecardPanel';

const SESSION_PATH = 'aoi/session-a';
const AXES: Array<[AoiNonVoiceJarvisAxisId, string, number]> = [
  ['runtime_reliability', 'Runtime reliability', 10],
  ['situation_grounding', 'Situation grounding', 15],
  ['memory_personalization', 'Memory and personalization', 15],
  ['cognition_goal_continuity', 'Cognition and goal continuity', 15],
  ['action_validation_recovery', 'Action validation and recovery', 20],
  ['proactive_usefulness', 'Proactive usefulness', 10],
  ['outcome_learning_calibration', 'Outcome learning and calibration', 10],
  ['operator_field_truth', 'Operator field truth', 5],
];
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
];

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function makeScorecard(
  params: {
    sessionPath?: string;
    evidenceClass?: AoiFieldEvidenceClass;
    ready?: boolean;
    impossibleBlockedScore?: boolean;
  } = {},
): AoiNonVoiceJarvisScorecard {
  const sessionPath = params.sessionPath ?? SESSION_PATH;
  const evidenceClass = params.evidenceClass ?? 'live_field';
  const ready = params.ready === true;
  const impossibleBlockedScore = params.impossibleBlockedScore === true;
  const axisScores = ready
    ? [10, 14, 14, 14, 19, 9, 9, 5]
    : evidenceClass === 'live_field'
      ? [9, 13, 13, 13, 18, 9, 5, 4]
      : evidenceClass === 'controlled_real'
        ? [5, 8, 8, 8, 10, 5, 5, 3]
        : [4, 6, 6, 6, 8, 4, 4, 2];
  const rawScore = axisScores.reduce((total, value) => total + value, 0);
  const score = impossibleBlockedScore ? 95 : rawScore;
  const failed = !ready;
  return {
    version: 1,
    id: `scorecard-${sessionPath}-${evidenceClass}`,
    sessionPath,
    generatedAt: 1_800_000_000_000,
    lastValidatedAt: 1_799_999_000_000,
    evidenceClass,
    manifestFingerprint: 'b'.repeat(64),
    voiceExcluded: true,
    rawScore: impossibleBlockedScore ? 95 : rawScore,
    score,
    scoreCap: ready || impossibleBlockedScore ? 100 : evidenceClass === 'synthetic' ? 59 : 89,
    level: ready
      ? 'claim_ready'
      : rawScore >= 75
        ? 'field_capable'
        : rawScore >= 50
          ? 'developing'
          : 'baseline',
    claimEligible: ready,
    axes: AXES.map(([id, label, weight], index) => ({
      version: 1,
      id,
      label,
      weight,
      rawScore: axisScores[index],
      score: axisScores[index],
      minimumEvidenceMet: true,
      sampleCount: 5,
      evidenceRefs: [`evidence:${id}`],
      blockers: [],
      nextEvidenceAction: `Collect ${id} evidence.`,
    })),
    hardGates: GATE_IDS.map((id) => ({
      version: 1,
      id,
      label: id.replace(/^gate\./, '').replace(/_/g, ' '),
      passed: !failed || id !== 'gate.broad_validation',
      reason: failed && id === 'gate.broad_validation' ? 'validation stale' : 'passed',
      evidenceRefs: [],
    })),
    failedHardGateIds: failed ? ['gate.broad_validation'] : [],
    recommendations: failed ? ['Run the current broad validation suite.'] : [],
    evidenceRefs: ['manifest:field'],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function response(scorecard = makeScorecard()) {
  return {
    ok: true,
    sessionPath: scorecard.sessionPath,
    evidenceClass: scorecard.evidenceClass,
    scorecard,
  };
}

describe('AoiNonVoiceScorecardPanel', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders canonical provenance, axes, gates, validation time, and next evidence action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(response())),
    );
    render(<AoiNonVoiceScorecardPanel sessionPath={SESSION_PATH} />);

    await waitFor(() => expect(screen.getByTestId('aoi-non-voice-scorecard-body')).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith(
      '/api/aoi-autonomy/operator/non-voice-scorecard?sessionPath=aoi%2Fsession-a&evidenceClass=live_field',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(screen.getByText(`Requested session`)).toBeTruthy();
    expect(screen.getAllByText(SESSION_PATH)).toHaveLength(2);
    expect(screen.getByText('NOT CLAIM READY')).toBeTruthy();
    expect(screen.getByLabelText('Canonical score 84 out of 100')).toBeTruthy();
    expect(screen.getByText('Hard gates').parentElement?.textContent).toContain('8/9 passed');
    expect(screen.getByText('Run the current broad validation suite.')).toBeTruthy();
    expect(screen.getByText(/Last validated/)).toBeTruthy();
    expect(screen.getByText('b'.repeat(64))).toBeTruthy();
  });

  it('switches evidence classes, clears the old claim, and labels controlled-real plainly', async () => {
    let resolveControlled: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).includes('controlled_real')) {
          return new Promise<Response>((resolve) => {
            resolveControlled = resolve;
          });
        }
        return Promise.resolve(jsonResponse(response()));
      }),
    );
    render(<AoiNonVoiceScorecardPanel sessionPath={SESSION_PATH} />);
    await waitFor(() =>
      expect(screen.getByLabelText('Canonical score 84 out of 100')).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText('Evidence class'), {
      target: { value: 'controlled_real' },
    });
    expect(screen.queryByTestId('aoi-non-voice-scorecard-body')).toBeNull();
    expect(screen.getByTestId('aoi-non-voice-evidence-class-banner').textContent).toContain(
      'CONTROLLED REAL',
    );
    expect(screen.getByTestId('aoi-non-voice-evidence-class-banner').textContent).toContain(
      'cannot substitute for a live-field claim',
    );

    resolveControlled?.(
      jsonResponse(response(makeScorecard({ evidenceClass: 'controlled_real' }))),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Canonical score 52 out of 100')).toBeTruthy(),
    );
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringContaining('evidenceClass=controlled_real'),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('never renders an impossible 90+ score when the claim gate is blocked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(response(makeScorecard({ impossibleBlockedScore: true })))),
    );
    render(<AoiNonVoiceScorecardPanel sessionPath={SESSION_PATH} />);

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('No readiness claim is shown'),
    );
    expect(screen.queryByText('95')).toBeNull();
    expect(screen.queryByText('90+ CLAIM READY')).toBeNull();
    expect(screen.queryByTestId('aoi-non-voice-scorecard-body')).toBeNull();
  });

  it('renders 90+ only for a canonical eligible live-field response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(response(makeScorecard({ ready: true })))),
    );
    render(<AoiNonVoiceScorecardPanel sessionPath={SESSION_PATH} />);

    await waitFor(() => expect(screen.getByText('90+ CLAIM READY')).toBeTruthy());
    expect(screen.getByLabelText('Canonical score 94 out of 100')).toBeTruthy();
    expect(screen.getByText('Hard gates').parentElement?.textContent).toContain('9/9 passed');
  });

  it('never renders the prior session while the replacement request is pending', async () => {
    let resolveSessionB: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).includes('session-b')) {
          return new Promise<Response>((resolve) => {
            resolveSessionB = resolve;
          });
        }
        return Promise.resolve(jsonResponse(response()));
      }),
    );
    const { rerender } = render(<AoiNonVoiceScorecardPanel sessionPath={SESSION_PATH} />);
    await waitFor(() =>
      expect(screen.getByLabelText('Canonical score 84 out of 100')).toBeTruthy(),
    );

    rerender(<AoiNonVoiceScorecardPanel sessionPath="aoi/session-b" />);
    expect(screen.queryByTestId('aoi-non-voice-scorecard-body')).toBeNull();
    resolveSessionB?.(jsonResponse(response(makeScorecard({ sessionPath: 'aoi/session-b' }))));
    await waitFor(() => expect(screen.getAllByText('aoi/session-b')).toHaveLength(2));
    expect(screen.queryByText(SESSION_PATH)).toBeNull();
  });

  it('exposes an actionable error and supports an accessible refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, false))
      .mockResolvedValueOnce(jsonResponse(response()));
    vi.stubGlobal('fetch', fetchMock);
    render(<AoiNonVoiceScorecardPanel sessionPath={SESSION_PATH} />);

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Verify the daemon'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh non-voice scorecard' }));
    await waitFor(() => expect(screen.getByTestId('aoi-non-voice-scorecard-body')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
