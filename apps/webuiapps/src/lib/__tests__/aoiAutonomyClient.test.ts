import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import {
  fetchAoiAutonomyDashboard,
  runAoiAutonomyManualTick,
  runAoiAutonomyManualWakeup,
  updateAoiEnvironmentSource,
} from '../aoiAutonomyClient';
import type { AoiAutonomyEvaluationResult } from '../aoiAutonomyEvaluation';
import type { AoiAutonomyStatus } from '../aoiAutonomyTypes';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function makeStatus(): AoiAutonomyStatus {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    policy: {
      ...DEFAULT_AOI_AUTONOMY_POLICY,
      enabled: true,
      level: 'L3',
      updatedAt: 1000,
    },
    activeProposalCount: 1,
    archivedProposalCount: 0,
    acceptedProposalCount: 0,
    snoozedProposalCount: 0,
    blockedProposalCount: 0,
    observationCount: 3,
    reflectionCount: 1,
    decisionCount: 2,
    lastTickAt: 1000,
    nextAllowedTickAt: 2000,
    lastTickReason: 'manual',
    activeTick: false,
    recentObservationCount: 1,
    proposalsCreatedInLastTick: 1,
    activeGoalCount: 1,
    currentGoalTitle: 'Finish Aoi dashboard',
    nextGoalStepTitle: 'Review blocked gates',
    updatedAt: 1000,
  };
}

function makeEvaluation(): AoiAutonomyEvaluationResult {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    generatedAt: 1000,
    metrics: {
      totalProposals: 1,
      totalDecisions: 2,
      proposalAcceptanceRate: 0.5,
      proposalDismissRate: 0.25,
      dismissRateByCategory: [],
      duplicateCooldownViolationCount: 0,
      evidenceCoverage: 1,
      staleMemoryReuseCount: 0,
      blockedHighRiskProposalCount: 0,
      acceptedExecutionSuccessRate: 1,
      goalContinuationUsefulness: null,
    },
    calibration: {
      noisyProposalTypes: [],
      wrongMemoryRefs: [],
      blockedActionKinds: [],
      staleMemoryRefs: [],
      highRiskProposalCount: 0,
      highRiskProposalRate: 0,
      highRiskBlockedCount: 0,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Aoi autonomy client dashboard', () => {
  it('fetches status, proposals, goals, and evaluation for the compact dashboard', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith('/api/aoi-autonomy/status?')) {
        return jsonResponse({ status: makeStatus() });
      }
      if (url.startsWith('/api/aoi-autonomy/proposals?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          active: [{ id: 'aoi-proposal-client-test' }],
          archived: [],
        });
      }
      if (url.startsWith('/api/aoi-autonomy/goals?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          active: [{ id: 'aoi-goal-client-test' }],
          archived: [],
          progress: [],
        });
      }
      if (url.startsWith('/api/aoi-autonomy/mission?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          mission: null,
        });
      }
      if (url.startsWith('/api/aoi-autonomy/sources?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          registry: {
            version: 1,
            sessionPath: 'aoi/default',
            updatedAt: 1000,
            sources: [],
          },
        });
      }
      if (url.startsWith('/api/aoi-autonomy/workspace?')) {
        return jsonResponse({
          ok: true,
          sessionPath: 'aoi/default',
          snapshot: null,
        });
      }
      if (url.startsWith('/api/aoi-autonomy/context?')) {
        return jsonResponse({
          ok: true,
          sessionPath: 'aoi/default',
          context: null,
        });
      }
      if (url.startsWith('/api/aoi-autonomy/evaluation?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          evaluation: makeEvaluation(),
        });
      }
      if (url.startsWith('/api/aoi-autonomy/timeline?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          events: [],
          summary: {
            version: 1,
            sessionPath: 'aoi/default',
            newestMeaningfulEvents: [],
            lastExportRedactionCount: 0,
            totalEventCount: 0,
            exportedTraceCount: 0,
          },
        });
      }
      if (url.startsWith('/api/aoi-autonomy/scheduler?')) {
        return jsonResponse({
          sessionPath: 'aoi/default',
          state: {
            version: 1,
            sessionPath: 'aoi/default',
            updatedAt: 1000,
            wakeupCount: 0,
            sourceSchedules: [],
            recentWakeups: [],
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await fetchAoiAutonomyDashboard('aoi/default');
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));

    expect(snapshot.status.policy.level).toBe('L3');
    expect(snapshot.proposals.active).toHaveLength(1);
    expect(snapshot.goals.active).toHaveLength(1);
    expect(snapshot.evaluation.metrics.evidenceCoverage).toBe(1);
    expect(snapshot.timeline.totalEventCount).toBe(0);
    expect(snapshot.scheduler.wakeupCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(calledUrls).toEqual(
      expect.arrayContaining([
        '/api/aoi-autonomy/status?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/proposals?sessionPath=aoi%2Fdefault&includeArchived=true',
        '/api/aoi-autonomy/goals?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/mission?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/sources?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/workspace?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/context?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/evaluation?sessionPath=aoi%2Fdefault',
        '/api/aoi-autonomy/timeline?sessionPath=aoi%2Fdefault&limit=20',
        '/api/aoi-autonomy/scheduler?sessionPath=aoi%2Fdefault',
      ]),
    );
  });

  it('preserves explicit clear markers when updating environment sources', async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(String(input)).toBe('/api/aoi-autonomy/sources');
      expect(init?.method).toBe('POST');
      return jsonResponse({
        ok: true,
        sessionPath: 'aoi/default',
        registry: {
          version: 1,
          sessionPath: 'aoi/default',
          updatedAt: 2000,
          sources: [],
        },
        status: makeStatus(),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await updateAoiEnvironmentSource('aoi/default', {
      sourceId: 'notes-metadata',
      patch: {
        enabled: false,
        consentReason: undefined,
        lastObservedAt: undefined,
        lastReviewedAt: undefined,
      },
    });

    expect(requestBody).toMatchObject({
      sessionPath: 'aoi/default',
      sourceId: 'notes-metadata',
      patch: {
        enabled: false,
        consentReason: null,
        lastObservedAt: null,
        lastReviewedAt: null,
      },
    });
  });

  it('posts a bounded manual tick when the user runs check now', async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(String(input)).toBe('/api/aoi-autonomy/tick');
      expect(init?.method).toBe('POST');
      return jsonResponse({
        ok: true,
        sessionPath: 'aoi/default',
        status: makeStatus(),
        proposals: [],
        blockedProposals: [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAoiAutonomyManualTick({
      sessionPath: 'aoi/default',
      latestUserMessage: 'check this session',
      reason: 'manual',
      maxRuntimeMs: 5000,
    });

    expect(result.status.sessionPath).toBe('aoi/default');
    expect(requestBody).toMatchObject({
      sessionPath: 'aoi/default',
      latestUserMessage: 'check this session',
      reason: 'manual',
      maxRuntimeMs: 5000,
    });
  });

  it('posts a bounded manual wakeup through the scheduler endpoint', async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(String(input)).toBe('/api/aoi-autonomy/wakeup');
      expect(init?.method).toBe('POST');
      return jsonResponse({
        ok: true,
        sessionPath: 'aoi/default',
        record: {
          id: 'aoi-wakeup-client-test',
          completedAt: 2000,
        },
        state: {
          version: 1,
          sessionPath: 'aoi/default',
          updatedAt: 2000,
          wakeupCount: 1,
          sourceSchedules: [],
          recentWakeups: [],
        },
        status: makeStatus(),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAoiAutonomyManualWakeup({
      sessionPath: 'aoi/default',
      latestUserMessage: 'check this session',
      sourceIds: ['app-state'],
      quietMode: true,
    });

    expect(result.sessionPath).toBe('aoi/default');
    expect(requestBody).toMatchObject({
      sessionPath: 'aoi/default',
      latestUserMessage: 'check this session',
      sourceIds: ['app-state'],
      reason: 'manual_refresh',
      quietMode: true,
    });
    expect(requestBody.budget).toMatchObject({
      maxSchedulerRuntimeMs: 15000,
      maxBackgroundTickRuntimeMs: 12000,
      maxSourceCount: 3,
      maxGeneratedProposalCount: 2,
      wakeupCooldownMs: 0,
    });
  });

  it('returns failed wakeup records instead of treating them as HTTP failures', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: false,
        sessionPath: 'aoi/default',
        record: {
          id: 'aoi-wakeup-failed-client-test',
          status: 'failed',
          completedAt: 2000,
        },
        state: {
          version: 1,
          sessionPath: 'aoi/default',
          updatedAt: 2000,
          wakeupCount: 1,
          sourceSchedules: [],
          recentWakeups: [],
        },
        status: makeStatus(),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAoiAutonomyManualWakeup({
      sessionPath: 'aoi/default',
    });

    expect(result.ok).toBe(false);
    expect(result.record.status).toBe('failed');
  });
});
