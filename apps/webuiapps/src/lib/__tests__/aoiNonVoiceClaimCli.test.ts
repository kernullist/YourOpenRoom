import { describe, expect, it, vi } from 'vitest';

import {
  AOI_NON_VOICE_CLAIM_EXIT_NOT_READY,
  AOI_NON_VOICE_CLAIM_EXIT_READY,
  AOI_NON_VOICE_CLAIM_EXIT_RUN_ERROR,
  resolveAoiNonVoiceClaimCliOptions,
  runAoiNonVoiceClaimCli,
  type AoiNonVoiceClaimCliDeps,
} from '../aoiNonVoiceClaimCli';

interface FakeReport {
  claimEligible: boolean;
  score: number;
}

function makeDeps(overrides: Partial<AoiNonVoiceClaimCliDeps<FakeReport>> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: AoiNonVoiceClaimCliDeps<FakeReport> = {
    argv: [
      '--sessions-dir',
      '/sessions',
      '--session-path',
      'aoi/live',
      '--evidence-class',
      'live_field',
      '--config-file',
      '/config.json',
      '--workspace-root',
      '/workspace',
      '--daemon-health-url',
      'http://127.0.0.1:7333/healthz',
    ],
    env: {},
    runScorecard: async () => ({ claimEligible: true, score: 91 }),
    formatReport: (report) => `score=${report.score}`,
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
    ...overrides,
  };
  return { deps, logs, errors };
}

describe('Aoi non-voice claim CLI', () => {
  it('resolves explicit options and optional daemon health URL', () => {
    expect(
      resolveAoiNonVoiceClaimCliOptions(
        [
          '--sessions-dir=/sessions',
          '--session-path=aoi/live',
          '--evidence-class=live_field',
          '--config-file=/config.json',
          '--workspace-root=/workspace',
          '--daemon-health-url=http://127.0.0.1:7333/healthz',
        ],
        {},
      ),
    ).toEqual({
      sessionsDir: '/sessions',
      sessionPath: 'aoi/live',
      evidenceClass: 'live_field',
      configFile: '/config.json',
      workspaceRoot: '/workspace',
      daemonHealthUrl: 'http://127.0.0.1:7333/healthz',
    });
  });

  it('uses environment options but rejects an unknown evidence class', () => {
    expect(
      resolveAoiNonVoiceClaimCliOptions([], {
        AOI_SESSIONS_DIR: '/sessions',
        AOI_NON_VOICE_SESSION_PATH: 'aoi/live',
        AOI_FIELD_EVIDENCE_CLASS: 'controlled_real',
        AOI_CONFIG_FILE: '/config.json',
        AOI_WORKSPACE_ROOT: '/workspace',
      }),
    ).toMatchObject({ evidenceClass: 'controlled_real', daemonHealthUrl: '' });
    expect(
      resolveAoiNonVoiceClaimCliOptions([], {
        AOI_SESSIONS_DIR: '/sessions',
        AOI_NON_VOICE_SESSION_PATH: 'aoi/live',
        AOI_FIELD_EVIDENCE_CLASS: 'almost_live',
        AOI_CONFIG_FILE: '/config.json',
        AOI_WORKSPACE_ROOT: '/workspace',
      }),
    ).toBeNull();
  });

  it('returns ready only for a claim-eligible score above 90', async () => {
    const runScorecard = vi.fn(async () => ({ claimEligible: true, score: 91 }));
    const { deps, logs } = makeDeps({ runScorecard });
    expect(await runAoiNonVoiceClaimCli(deps)).toBe(AOI_NON_VOICE_CLAIM_EXIT_READY);
    expect(runScorecard).toHaveBeenCalledWith({
      sessionsDir: '/sessions',
      sessionPath: 'aoi/live',
      evidenceClass: 'live_field',
      configFile: '/config.json',
      workspaceRoot: '/workspace',
      daemonHealthUrl: 'http://127.0.0.1:7333/healthz',
    });
    expect(logs).toContain('score=91');
  });

  it('returns not-ready for a capped score or failed hard gate', async () => {
    for (const report of [
      { claimEligible: true, score: 90 },
      { claimEligible: false, score: 100 },
    ]) {
      const { deps, errors } = makeDeps({ runScorecard: async () => report });
      expect(await runAoiNonVoiceClaimCli(deps)).toBe(AOI_NON_VOICE_CLAIM_EXIT_NOT_READY);
      expect(errors.some((message) => message.includes('NOT READY'))).toBe(true);
    }
  });

  it('returns run-error before loading when required provenance is absent', async () => {
    const runScorecard = vi.fn(async () => ({ claimEligible: true, score: 100 }));
    const { deps } = makeDeps({ argv: [], env: {}, runScorecard });
    expect(await runAoiNonVoiceClaimCli(deps)).toBe(AOI_NON_VOICE_CLAIM_EXIT_RUN_ERROR);
    expect(runScorecard).not.toHaveBeenCalled();
  });

  it('returns run-error when scorecard assembly throws', async () => {
    const { deps, errors } = makeDeps({
      runScorecard: async () => {
        throw new Error('loader failed');
      },
    });
    expect(await runAoiNonVoiceClaimCli(deps)).toBe(AOI_NON_VOICE_CLAIM_EXIT_RUN_ERROR);
    expect(errors.some((message) => message.includes('scorecard failed'))).toBe(true);
  });
});
