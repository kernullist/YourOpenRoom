import { describe, expect, it } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import { runAoiAttentionBroker } from '../aoiAttentionBroker';
import { buildAoiFollowThroughLearningSummary } from '../aoiFollowThroughLearning';
import type { AoiResearchRunSummary } from '../aoiResearchTypes';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;

function makeResearchRun(partial: Partial<AoiResearchRunSummary> = {}): AoiResearchRunSummary {
  return {
    id: partial.id ?? 'research-attention-001',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    request: partial.request ?? 'Check RE trend',
    title: partial.title ?? 'RE trend research',
    mode: partial.mode ?? 'standard',
    language: partial.language ?? 'ko',
    recency: partial.recency ?? 'week',
    maxSources: partial.maxSources ?? 5,
    createdAt: partial.createdAt ?? NOW - 10_000,
    updatedAt: partial.updatedAt ?? NOW - 1_000,
    completedAt: partial.completedAt ?? NOW - 1_000,
    status: partial.status ?? 'completed',
    phase: partial.phase ?? 'completed',
    statusMessage: partial.statusMessage ?? 'Completed',
    sourceCounts: partial.sourceCounts ?? {
      planned: 5,
      candidates: 4,
      accepted: 3,
      failed: 0,
    },
    artifactAvailability: partial.artifactAvailability ?? {
      manifest: true,
      report: true,
      sources: true,
      evidence: true,
    },
    claimCount: partial.claimCount ?? 3,
    warningCount: partial.warningCount ?? 0,
    verificationWarningCount: partial.verificationWarningCount ?? 0,
    ...partial,
  };
}

describe('Aoi Attention Broker follow-through suppression', () => {
  it('suppresses similar actionable attention after negative follow-through', () => {
    const researchRun = makeResearchRun();
    const baseline = runAoiAttentionBroker({
      sessionPath: SESSION_PATH,
      now: NOW,
      policy: DEFAULT_AOI_AUTONOMY_POLICY,
      researchRuns: [researchRun],
      memories: [],
      activeProposals: [],
      recentDecisions: [],
      activeGoals: [],
    });
    const followThroughLearning = buildAoiFollowThroughLearningSummary({
      sessionPath: SESSION_PATH,
      followThroughEvents: [
        {
          version: 1,
          id: 'follow-through-attention-too-much',
          sessionPath: SESSION_PATH,
          opportunityId: 'attention:research_completed:research:research-attention-001',
          sourceKind: 'research',
          topicKey: 'attention:research_completed:research:research-attention-001',
          sourceKey: 'research',
          deliveryMode: 'dashboard',
          action: 'dismissed',
          feedbackCategory: 'too_much',
          result: 'negative',
          timingLabel: 'attention was too much',
          evidenceRefs: ['test:attention-follow-through'],
          createdAt: NOW - 1_000,
          actionAuthority: 'display_only',
          mutationCount: 0,
        },
      ],
      now: NOW,
    });
    const suppressed = runAoiAttentionBroker({
      sessionPath: SESSION_PATH,
      now: NOW,
      policy: DEFAULT_AOI_AUTONOMY_POLICY,
      researchRuns: [researchRun],
      memories: [],
      activeProposals: [],
      recentDecisions: [],
      activeGoals: [],
      followThroughLearning,
    });

    expect(baseline.proposals).toHaveLength(1);
    expect(suppressed.proposals).toHaveLength(0);
    expect(suppressed.decisions[0]?.kind).not.toBe('create_proposal');
  });
});
