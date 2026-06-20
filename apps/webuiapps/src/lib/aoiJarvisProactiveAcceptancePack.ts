import { DEFAULT_AOI_AUTONOMY_POLICY } from './aoiAutonomyPolicy';
import type {
  AoiAutonomyPolicy,
  AoiDeliberationRun,
  AoiFollowThroughEvent,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiKiraOutcomeEvent,
  AoiOpportunity,
  AoiProposal,
} from './aoiAutonomyTypes';
import { decideAoiActionLadder } from './aoiActionLadder';
import { buildAoiCuriosityCandidates } from './aoiCuriosityEngine';
import { buildAoiDeliberationRun } from './aoiDeliberationRun';
import {
  buildAoiFollowThroughLearningSummary,
  scoreAoiFollowThroughLearningForOpportunity,
} from './aoiFollowThroughLearning';
import { decideAoiInterruptionDelivery } from './aoiInterruptionGovernor';
import type {
  AoiJarvisAutonomyCapability,
  AoiJarvisAutonomyGovernorDecision,
} from './aoiJarvisAutonomyGovernor';
import type { AoiResearchRunSummary } from './aoiResearchTypes';

export type AoiJarvisProactiveAcceptanceDimension =
  | 'useful'
  | 'timely'
  | 'evidence_backed'
  | 'non_intrusive'
  | 'safe';

export type AoiJarvisProactiveAcceptancePrivacyState =
  | 'synthetic'
  | 'local_only'
  | 'metadata_only'
  | 'withheld';

export interface AoiJarvisProactiveAcceptanceMetric {
  version: 1;
  id: string;
  scenarioId: string;
  dimension: AoiJarvisProactiveAcceptanceDimension;
  passed: boolean;
  actualSummary: string;
  evidenceRefs: string[];
  mutationCount: number;
  privacyState: AoiJarvisProactiveAcceptancePrivacyState;
}

export interface AoiJarvisProactiveAcceptanceScenarioResult {
  version: 1;
  id: string;
  title: string;
  passed: boolean;
  failedReason?: string;
  actualSummary: string;
  evidenceRefs: string[];
  mutationCount: number;
  privacyState: AoiJarvisProactiveAcceptancePrivacyState;
  metrics: AoiJarvisProactiveAcceptanceMetric[];
}

export interface AoiJarvisProactiveAcceptanceScenario {
  version: 1;
  id: string;
  title: string;
  description: string;
  run: (input: AoiJarvisProactiveAcceptanceRunInput) => AoiJarvisProactiveAcceptanceScenarioResult;
}

export interface AoiJarvisProactiveAcceptanceReport {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  passed: boolean;
  scenarioCount: number;
  passedScenarioCount: number;
  failedScenarioCount: number;
  metricCount: number;
  passedMetricCount: number;
  failedMetricCount: number;
  score: number;
  scoreLabel: string;
  mutationCount: number;
  scenarios: AoiJarvisProactiveAcceptanceScenarioResult[];
  metrics: AoiJarvisProactiveAcceptanceMetric[];
  failedMetrics: AoiJarvisProactiveAcceptanceMetric[];
  evidenceRefs: string[];
  nextGoalCandidates: string[];
}

export interface AoiJarvisProactiveAcceptanceRunInput {
  sessionPath: string;
  now: number;
}

export interface AoiJarvisProactiveAcceptancePackOptions {
  sessionPath?: string;
  now?: number;
  scenarios?: readonly AoiJarvisProactiveAcceptanceScenario[];
}

export interface AoiJarvisProactiveAcceptanceFormatOptions {
  maxFailures?: number;
}

export const AOI_JARVIS_PROACTIVE_ACCEPTANCE_NOW = 1_800_000_000_000;
export const AOI_JARVIS_PROACTIVE_ACCEPTANCE_SESSION_PATH = 'aoi/default';

const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_RE_SOURCE_REF = 'public-source:reverse-engineering:synthetic-fresh';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function truncateText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function uniqueStrings(values: readonly (string | undefined | null)[], limit = 24): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = truncateText(value ?? '', 220);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function metric(params: {
  id: string;
  scenarioId: string;
  dimension: AoiJarvisProactiveAcceptanceDimension;
  passed: boolean;
  actualSummary: string;
  evidenceRefs?: string[];
  mutationCount?: number;
  privacyState?: AoiJarvisProactiveAcceptancePrivacyState;
}): AoiJarvisProactiveAcceptanceMetric {
  return {
    version: 1,
    id: params.id,
    scenarioId: params.scenarioId,
    dimension: params.dimension,
    passed: params.passed,
    actualSummary: truncateText(params.actualSummary),
    evidenceRefs: uniqueStrings(params.evidenceRefs ?? []),
    mutationCount: params.mutationCount ?? 0,
    privacyState: params.privacyState ?? 'synthetic',
  };
}

function scenarioResult(params: {
  id: string;
  title: string;
  actualSummary: string;
  metrics: AoiJarvisProactiveAcceptanceMetric[];
  privacyState?: AoiJarvisProactiveAcceptancePrivacyState;
}): AoiJarvisProactiveAcceptanceScenarioResult {
  const mutationCount = params.metrics.reduce((total, item) => total + item.mutationCount, 0);
  const failed = params.metrics.filter((item) => !item.passed);
  return {
    version: 1,
    id: params.id,
    title: params.title,
    passed: mutationCount === 0 && failed.length === 0,
    ...(failed.length > 0
      ? {
          failedReason: failed
            .map((item) => item.id)
            .slice(0, 4)
            .join(', '),
        }
      : {}),
    actualSummary: truncateText(params.actualSummary),
    evidenceRefs: uniqueStrings(params.metrics.flatMap((item) => item.evidenceRefs)),
    mutationCount,
    privacyState: params.privacyState ?? 'synthetic',
    metrics: params.metrics,
  };
}

function makePolicy(partial: Partial<AoiAutonomyPolicy> = {}): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    previewMode: true,
    level: 'L5',
    proactiveSuggestionsEnabled: true,
    confidenceFloor: 0.4,
    proactiveBriefing: {
      ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
      enabled: true,
      directChatHookOptIn: true,
    },
    ...partial,
  };
}

function makeGovernor(
  input: AoiJarvisProactiveAcceptanceRunInput,
  allowedCapabilities: readonly AoiJarvisAutonomyCapability[] = [
    'observe',
    'research',
    'proactive_brief',
    'direct_chat',
    'prepare_action',
  ],
): AoiJarvisAutonomyGovernorDecision {
  const allCapabilities: readonly AoiJarvisAutonomyCapability[] = [
    'observe',
    'mission_control',
    'research',
    'memory',
    'proactive_brief',
    'direct_chat',
    'voice',
    'prepare_action',
    'app_action',
    'command',
  ];
  return {
    version: 1,
    id: `jarvis-proactive-acceptance-governor-${input.now}`,
    sessionPath: input.sessionPath,
    generatedAt: input.now,
    overallMode: allowedCapabilities.includes('command') ? 'approval_execution' : 'direct_chat',
    modeRank: allowedCapabilities.includes('command') ? 5 : 3,
    modeLabel: 'Synthetic proactive acceptance governor',
    operatorSummary: 'Synthetic local-only governor fixture.',
    allowedAutonomyBands: allCapabilities.map((capability) => ({
      version: 1,
      capability,
      allowed: allowedCapabilities.includes(capability),
      requiredMode: capability === 'command' ? 'approval_execution' : 'direct_chat',
      reason: `${capability} synthetic gate`,
      evidenceRefs: [`governor:${capability}`],
    })),
    blockers: [],
    nextUpgradeAction: 'No live upgrade is performed by this fixture.',
    nextUpgradeEvidenceRefs: ['governor:synthetic'],
    whyNotJarvisYetLabels: [],
    evidenceRefs: ['governor:synthetic'],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function makeInterestTopic(input: AoiJarvisProactiveAcceptanceRunInput): AoiInterestTopic {
  return {
    version: 1,
    id: 'interest-re-synthetic',
    sessionPath: input.sessionPath,
    label: 'Reverse Engineering',
    normalizedLabel: 'reverse-engineering',
    aliases: ['RE', 'reverse engineering'],
    source: 'manual',
    memoryIds: ['memory-re-interest'],
    evidenceRefs: [PUBLIC_RE_SOURCE_REF, 'interest:synthetic-re'],
    confidence: 0.92,
    importance: 0.9,
    noveltyPreference: 0.82,
    currentInfoPreference: 0.92,
    muted: false,
    pinned: true,
    cooldownKey: 'interest:reverse-engineering',
    createdAt: input.now - DAY_MS,
    updatedAt: input.now - 60_000,
  };
}

function makeInterestProfile(input: AoiJarvisProactiveAcceptanceRunInput): AoiInterestProfile {
  return {
    version: 1,
    sessionPath: input.sessionPath,
    topics: [makeInterestTopic(input)],
    generatedAt: input.now,
    sourceMemoryCount: 1,
    warnings: [],
  };
}

function makeResearchRun(
  input: AoiJarvisProactiveAcceptanceRunInput,
  partial: Partial<AoiResearchRunSummary> = {},
): AoiResearchRunSummary {
  return {
    id: partial.id ?? 'research-re-public-fresh',
    sessionPath: partial.sessionPath ?? input.sessionPath,
    request: partial.request ?? 'Reverse engineering current trend check',
    title: partial.title ?? 'Reverse Engineering Synthetic Trend Check',
    mode: partial.mode ?? 'standard',
    language: partial.language ?? 'ko',
    recency: partial.recency ?? 'week',
    maxSources: partial.maxSources ?? 5,
    createdAt: partial.createdAt ?? input.now - 2 * 60 * 60 * 1000,
    updatedAt: partial.updatedAt ?? input.now - 30_000,
    completedAt: partial.completedAt ?? input.now - 30_000,
    status: partial.status ?? 'completed',
    phase: partial.phase ?? 'completed',
    statusMessage: partial.statusMessage ?? 'Synthetic fresh public sources accepted.',
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

function makeOpportunity(
  input: AoiJarvisProactiveAcceptanceRunInput,
  partial: Partial<AoiOpportunity> = {},
): AoiOpportunity {
  return {
    version: 1,
    id: partial.id ?? 'opp-proactive-re',
    sessionPath: input.sessionPath,
    sourceKind: partial.sourceKind ?? 'interest',
    title: partial.title ?? 'Fresh RE trend worth surfacing',
    curiosityQuestion:
      partial.curiosityQuestion ?? 'Is this reverse-engineering update useful now?',
    whyNow: partial.whyNow ?? 'A fresh public source aligns with a pinned RE interest.',
    evidenceNeed: partial.evidenceNeed ?? 'Need fresh public source and deliberation evidence.',
    suggestedNextAction:
      partial.suggestedNextAction ?? 'Brief this as a dashboard item before any action.',
    risk: partial.risk ?? 'low',
    confidence: partial.confidence ?? 0.9,
    urgency: partial.urgency ?? 0.86,
    novelty: partial.novelty ?? 0.78,
    deliveryRecommendation: partial.deliveryRecommendation ?? 'dashboard',
    status: partial.status ?? 'active',
    evidenceRefs: partial.evidenceRefs ?? [
      PUBLIC_RE_SOURCE_REF,
      'research:research-re-public-fresh',
    ],
    dedupeKey: partial.dedupeKey ?? 'interest:reverse-engineering',
    createdAt: partial.createdAt ?? input.now - 60_000,
    updatedAt: partial.updatedAt ?? input.now - 30_000,
    expiresAt: partial.expiresAt ?? input.now + DAY_MS,
    ...partial,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function makeDeliberationRun(
  input: AoiJarvisProactiveAcceptanceRunInput,
  opportunity: AoiOpportunity,
  partial: Partial<AoiDeliberationRun> = {},
): AoiDeliberationRun {
  return {
    version: 1,
    id: partial.id ?? `deliberation-${opportunity.id}`,
    sessionPath: input.sessionPath,
    opportunityId: opportunity.id,
    opportunityDedupeKey: opportunity.dedupeKey,
    opportunityTitle: opportunity.title,
    phase: partial.phase ?? 'ready',
    selectedAt: partial.selectedAt ?? input.now - 20_000,
    updatedAt: partial.updatedAt ?? input.now - 10_000,
    evidencePlan: partial.evidencePlan ?? [
      {
        version: 1,
        id: `evidence-${opportunity.id}`,
        kind: 'research',
        status: 'observed',
        sourceRef: 'research:research-re-public-fresh',
        label: 'Synthetic public research evidence',
        summary: 'Fresh public evidence supports a read-only proactive brief.',
        freshness: 'fresh',
        evidenceRefs: ['research:research-re-public-fresh', PUBLIC_RE_SOURCE_REF],
        cannotKnow: [],
        blockers: [],
        observedAt: input.now - 10_000,
        actionAuthority: 'display_only',
        mutationCount: 0,
      },
    ],
    finding: partial.finding ?? {
      version: 1,
      summary: 'Fresh public evidence is strong enough for a dashboard or direct-chat candidate.',
      sourceQuality: 'strong',
      freshness: 'fresh',
      confidence: 0.86,
      evidenceRefs: ['research:research-re-public-fresh', PUBLIC_RE_SOURCE_REF],
      blockers: [],
      cannotKnow: [],
      createdAt: input.now - 10_000,
    },
    opinion: partial.opinion ?? {
      version: 1,
      stance: 'ready_to_brief',
      summary: 'Aoi can brief this as read-only evidence.',
      reason: 'Fresh synthetic public source evidence exists.',
      evidenceRefs: ['research:research-re-public-fresh', PUBLIC_RE_SOURCE_REF],
      createdAt: input.now - 9_000,
    },
    safeNextAction:
      partial.safeNextAction ?? 'Brief this and keep stronger actions behind existing gates.',
    blockers: partial.blockers ?? [],
    evidenceRefs: partial.evidenceRefs ?? [
      'research:research-re-public-fresh',
      PUBLIC_RE_SOURCE_REF,
    ],
    artifactRefs: partial.artifactRefs ?? ['deliberation:synthetic'],
    phaseHistory: partial.phaseHistory ?? [],
    ...partial,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function makeProposal(
  input: AoiJarvisProactiveAcceptanceRunInput,
  opportunity: AoiOpportunity,
  kind: 'run_command',
  partial: Partial<AoiProposal> = {},
): AoiProposal {
  return {
    version: 1,
    id: partial.id ?? `proposal-${kind}-${opportunity.id}`,
    sessionPath: input.sessionPath,
    status: partial.status ?? 'active',
    title: partial.title ?? `${kind} for ${opportunity.title}`,
    body: partial.body ?? `Synthetic proposal for ${opportunity.dedupeKey}.`,
    reason: partial.reason ?? 'A matching proactive opportunity needs a gated next step.',
    trigger: partial.trigger ?? 'jarvis_proactive_acceptance',
    createdAt: partial.createdAt ?? input.now - 5_000,
    updatedAt: partial.updatedAt ?? input.now - 2_000,
    expiresAt: partial.expiresAt ?? input.now + DAY_MS,
    cooldownKey: partial.cooldownKey ?? opportunity.dedupeKey,
    confidence: partial.confidence ?? 0.82,
    evidenceRefs: partial.evidenceRefs ?? [
      `opportunity:${opportunity.id}`,
      ...opportunity.evidenceRefs,
    ],
    memoryIds: partial.memoryIds ?? [],
    artifactRefs: partial.artifactRefs ?? [`opportunity:${opportunity.id}`],
    riskSignals: partial.riskSignals ?? [],
    ...partial,
    risk: 'high',
    requiredAutonomyLevel: 'L5',
    requiresUserApproval: true,
    suggestedTools: [kind],
    acceptAction: {
      kind,
      params: {
        command:
          'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiJarvisProactiveAcceptancePack.test.ts',
        cwd: '.',
        purpose: 'Validate synthetic proactive acceptance fixtures.',
      },
    },
  };
}

function makeFollowThroughEvent(
  input: AoiJarvisProactiveAcceptanceRunInput,
  opportunity: AoiOpportunity,
  partial: Partial<AoiFollowThroughEvent>,
): AoiFollowThroughEvent {
  return {
    version: 1,
    id: partial.id ?? `follow-through-${opportunity.id}`,
    sessionPath: input.sessionPath,
    opportunityId: opportunity.id,
    sourceKind: opportunity.sourceKind,
    topicKey: opportunity.dedupeKey,
    sourceKey: opportunity.sourceKind,
    deliveryMode: opportunity.deliveryRecommendation,
    action: partial.action ?? 'accepted',
    feedbackCategory: partial.feedbackCategory ?? 'useful',
    result: partial.result ?? 'positive',
    timingLabel: partial.timingLabel ?? 'synthetic follow-through',
    evidenceRefs: partial.evidenceRefs ?? [`opportunity:${opportunity.id}`],
    createdAt: partial.createdAt ?? input.now - 30_000,
    ...partial,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function reInterestFreshPublicDashboardScenario(
  input: AoiJarvisProactiveAcceptanceRunInput,
): AoiJarvisProactiveAcceptanceScenarioResult {
  const scenarioId = 'proactive-re-interest-fresh-public-dashboard';
  const result = buildAoiCuriosityCandidates({
    sessionPath: input.sessionPath,
    now: input.now,
    interestProfile: makeInterestProfile(input),
    maxCandidates: 4,
  });
  const candidate = result.candidates.find((item) =>
    item.dedupeKey.includes('reverse-engineering'),
  );
  const metrics = [
    metric({
      id: 'opportunity.created_from_re_interest',
      scenarioId,
      dimension: 'useful',
      passed: candidate?.sourceKind === 'interest' && candidate.title.includes('Reverse'),
      actualSummary: candidate?.title ?? 'No RE interest opportunity was created.',
      evidenceRefs: candidate?.evidenceRefs ?? result.evidenceRefs,
    }),
    metric({
      id: 'opportunity.dashboard_first',
      scenarioId,
      dimension: 'non_intrusive',
      passed: candidate?.deliveryRecommendation === 'dashboard',
      actualSummary: `delivery=${candidate?.deliveryRecommendation ?? 'missing'}`,
      evidenceRefs: candidate?.evidenceRefs,
    }),
    metric({
      id: 'opportunity.uses_re_public_source',
      scenarioId,
      dimension: 'evidence_backed',
      passed:
        candidate?.evidenceRefs.includes(PUBLIC_RE_SOURCE_REF) === true &&
        candidate.evidenceRefs.every((ref) => !/notion|gmail|calendar/i.test(ref)),
      actualSummary: `refs=${candidate?.evidenceRefs.slice(0, 4).join(',') ?? 'none'}`,
      evidenceRefs: candidate?.evidenceRefs,
    }),
  ];
  return scenarioResult({
    id: scenarioId,
    title: 'RE interest with fresh public source creates dashboard opportunity',
    actualSummary: 'Curiosity engine turns the pinned RE topic into a dashboard-first opportunity.',
    metrics,
  });
}

function directChatOptInScenario(
  input: AoiJarvisProactiveAcceptanceRunInput,
): AoiJarvisProactiveAcceptanceScenarioResult {
  const scenarioId = 'proactive-direct-chat-opt-in-strong-source';
  const opportunity = makeOpportunity(input, {
    id: 'opp-direct-chat-re',
    deliveryRecommendation: 'direct_chat',
    urgency: 0.9,
    novelty: 0.82,
  });
  const run = makeDeliberationRun(input, opportunity);
  const allowed = decideAoiInterruptionDelivery({
    sessionPath: input.sessionPath,
    opportunity,
    deliberationRun: run,
    policy: makePolicy(),
    directChatOptIn: true,
    quietMode: false,
    notificationsEnabled: true,
    jarvisGovernor: makeGovernor(input),
    now: input.now,
  });
  const blocked = decideAoiInterruptionDelivery({
    sessionPath: input.sessionPath,
    opportunity,
    deliberationRun: run,
    policy: makePolicy(),
    directChatOptIn: false,
    quietMode: false,
    notificationsEnabled: true,
    jarvisGovernor: makeGovernor(input),
    now: input.now,
  });
  const metrics = [
    metric({
      id: 'direct_chat.allowed_with_opt_in',
      scenarioId,
      dimension: 'timely',
      passed: allowed.deliveryMode === 'direct_chat' && allowed.directChatAllowed,
      actualSummary: `allowed mode=${allowed.deliveryMode} blockers=${allowed.directChatBlockedReasons.join(',')}`,
      evidenceRefs: allowed.evidenceRefs,
      mutationCount: allowed.mutationCount,
    }),
    metric({
      id: 'direct_chat.blocked_without_opt_in',
      scenarioId,
      dimension: 'safe',
      passed:
        blocked.deliveryMode !== 'direct_chat' &&
        blocked.directChatBlockedReasons.includes('direct_chat_not_opted_in'),
      actualSummary: `blocked mode=${blocked.deliveryMode} blockers=${blocked.directChatBlockedReasons.join(',')}`,
      evidenceRefs: blocked.evidenceRefs,
      mutationCount: blocked.mutationCount,
    }),
  ];
  return scenarioResult({
    id: scenarioId,
    title: 'Direct chat requires opt-in and strong evidence',
    actualSummary: 'Strong evidence can reach direct chat only when the opt-in gate is present.',
    metrics,
  });
}

function quietModeScenario(
  input: AoiJarvisProactiveAcceptanceRunInput,
): AoiJarvisProactiveAcceptanceScenarioResult {
  const scenarioId = 'proactive-quiet-mode-hides-noncritical';
  const opportunity = makeOpportunity(input, {
    id: 'opp-quiet-mode-re',
    deliveryRecommendation: 'direct_chat',
    urgency: 0.74,
  });
  const decision = decideAoiInterruptionDelivery({
    sessionPath: input.sessionPath,
    opportunity,
    deliberationRun: makeDeliberationRun(input, opportunity),
    policy: makePolicy(),
    directChatOptIn: true,
    quietMode: true,
    notificationsEnabled: true,
    jarvisGovernor: makeGovernor(input),
    now: input.now,
  });
  const metrics = [
    metric({
      id: 'quiet_mode.hidden_noncritical',
      scenarioId,
      dimension: 'non_intrusive',
      passed:
        decision.deliveryMode === 'hidden' &&
        decision.directChatBlockedReasons.includes('quiet_mode'),
      actualSummary: `mode=${decision.deliveryMode} blockers=${decision.directChatBlockedReasons.join(',')}`,
      evidenceRefs: decision.evidenceRefs,
      mutationCount: decision.mutationCount,
    }),
  ];
  return scenarioResult({
    id: scenarioId,
    title: 'Quiet mode suppresses non-critical proactive item',
    actualSummary: 'Quiet mode hides the proactive item because it is not a critical blocker.',
    metrics,
  });
}

function staleSourceScenario(
  input: AoiJarvisProactiveAcceptanceRunInput,
): AoiJarvisProactiveAcceptanceScenarioResult {
  const scenarioId = 'proactive-stale-source-abstains';
  const opportunity = makeOpportunity(input, {
    id: 'opp-stale-source-re',
    evidenceRefs: ['research:research-re-stale'],
  });
  const run = buildAoiDeliberationRun({
    sessionPath: input.sessionPath,
    opportunity,
    now: input.now,
    researchRuns: [
      makeResearchRun(input, {
        id: 'research-re-stale',
        updatedAt: input.now - 35 * DAY_MS,
        completedAt: input.now - 35 * DAY_MS,
      }),
    ],
  });
  const decision = decideAoiInterruptionDelivery({
    sessionPath: input.sessionPath,
    opportunity,
    deliberationRun: run,
    policy: makePolicy(),
    directChatOptIn: true,
    quietMode: false,
    notificationsEnabled: true,
    jarvisGovernor: makeGovernor(input),
    now: input.now,
  });
  const cannotKnowText = [
    ...(run.finding?.cannotKnow ?? []),
    ...run.evidencePlan.flatMap((step) => step.cannotKnow),
  ].join(' ');
  const metrics = [
    metric({
      id: 'stale.deliberation_blocks',
      scenarioId,
      dimension: 'evidence_backed',
      passed:
        run.phase === 'blocked' &&
        run.finding?.freshness === 'stale' &&
        run.opinion?.stance === 'abstain' &&
        /stale/i.test(cannotKnowText) &&
        /refresh/i.test(run.safeNextAction),
      actualSummary: `phase=${run.phase} freshness=${run.finding?.freshness ?? 'missing'} stance=${run.opinion?.stance ?? 'none'} cannotKnow=${cannotKnowText || 'none'} safeNext=${run.safeNextAction}`,
      evidenceRefs: run.evidenceRefs,
      mutationCount: run.mutationCount,
    }),
    metric({
      id: 'stale.no_direct_chat',
      scenarioId,
      dimension: 'safe',
      passed:
        decision.deliveryMode === 'dashboard' &&
        decision.directChatBlockedReasons.includes('stale_source'),
      actualSummary: `mode=${decision.deliveryMode} blockers=${decision.directChatBlockedReasons.join(',')}`,
      evidenceRefs: decision.evidenceRefs,
      mutationCount: decision.mutationCount,
    }),
  ];
  return scenarioResult({
    id: scenarioId,
    title: 'Stale source forces abstain and dashboard-only delivery',
    actualSummary:
      'Deliberation marks stale evidence as cannot-rely-on-currently and blocks interruption.',
    metrics,
  });
}

function kiraValidationFailureScenario(
  input: AoiJarvisProactiveAcceptanceRunInput,
): AoiJarvisProactiveAcceptanceScenarioResult {
  const scenarioId = 'proactive-kira-validation-safe-recovery';
  const outcome: AoiKiraOutcomeEvent = {
    version: 1,
    id: 'kira-outcome-validation-failed',
    sessionPath: input.sessionPath,
    kind: 'kira_validation_failed',
    workId: 'kira-work-aoi-proactive',
    workRef: 'KIRA-REPLAY-001',
    workTitle: 'Aoi proactive acceptance implementation',
    projectName: 'YourOpenRoom',
    validationSummary: 'Synthetic validation failed in targeted fixture.',
    changedFilesSummary: 'apps/webuiapps/src/lib synthetic fixture changed.',
    evidenceRefs: ['kira-log:validation-failed', 'kira-review:synthetic'],
    validationPassed: false,
    integrated: false,
    reviewerNotes: ['Keep recovery read-only until a reviewed handoff exists.'],
    createdAt: input.now - 10_000,
    dedupeKey: 'kira-work-aoi-proactive',
  };
  const result = buildAoiCuriosityCandidates({
    sessionPath: input.sessionPath,
    now: input.now,
    kiraOutcomes: [outcome],
    maxCandidates: 4,
  });
  const candidate = result.candidates.find((item) => item.sourceKind === 'kira');
  const metrics = [
    metric({
      id: 'kira.failure_creates_recovery_opportunity',
      scenarioId,
      dimension: 'useful',
      passed:
        candidate?.title.includes('validation failure') === true &&
        candidate.risk === 'medium' &&
        candidate.suggestedNextAction.includes('read-only'),
      actualSummary: candidate?.title ?? 'No Kira recovery opportunity was created.',
      evidenceRefs: candidate?.evidenceRefs ?? result.evidenceRefs,
    }),
    metric({
      id: 'kira.recovery_is_non_mutating',
      scenarioId,
      dimension: 'safe',
      passed:
        candidate !== undefined && candidate.evidenceRefs.includes('kira-log:validation-failed'),
      actualSummary: candidate?.suggestedNextAction ?? 'Missing Kira candidate.',
      evidenceRefs: candidate?.evidenceRefs,
    }),
  ];
  return scenarioResult({
    id: scenarioId,
    title: 'Kira validation failure creates safe recovery opportunity',
    actualSummary: 'Curiosity engine turns Kira validation failure into a read-only recovery item.',
    metrics,
  });
}

function duplicateTrendScenario(
  input: AoiJarvisProactiveAcceptanceRunInput,
): AoiJarvisProactiveAcceptanceScenarioResult {
  const scenarioId = 'proactive-duplicate-trend-cooldown';
  const opportunity = makeOpportunity(input, {
    id: 'opp-duplicate-trend',
    sourceKind: 'app_state',
    dedupeKey: 'trend:reverse-engineering:synthetic',
    deliveryRecommendation: 'direct_chat',
    urgency: 0.88,
  });
  const decision = decideAoiInterruptionDelivery({
    sessionPath: input.sessionPath,
    opportunity,
    deliberationRun: makeDeliberationRun(input, opportunity),
    policy: makePolicy(),
    directChatOptIn: true,
    quietMode: false,
    notificationsEnabled: true,
    jarvisGovernor: makeGovernor(input),
    recentDeliveryKeys: [`interruption:${input.sessionPath}:${opportunity.dedupeKey}`],
    now: input.now,
  });
  const metrics = [
    metric({
      id: 'trend.duplicate_suppressed',
      scenarioId,
      dimension: 'non_intrusive',
      passed:
        decision.deliveryMode === 'dashboard' &&
        decision.directChatBlockedReasons.includes('duplicate_or_cooldown'),
      actualSummary: `mode=${decision.deliveryMode} blockers=${decision.directChatBlockedReasons.join(',')}`,
      evidenceRefs: decision.evidenceRefs,
      mutationCount: decision.mutationCount,
    }),
  ];
  return scenarioResult({
    id: scenarioId,
    title: 'Duplicate trend is suppressed by cooldown',
    actualSummary: 'A repeated trend is kept out of direct chat by duplicate/cooldown evidence.',
    metrics,
  });
}

function tooFrequentFeedbackScenario(
  input: AoiJarvisProactiveAcceptanceRunInput,
): AoiJarvisProactiveAcceptanceScenarioResult {
  const scenarioId = 'proactive-too-frequent-feedback-lowers-direct-chat';
  const opportunity = makeOpportunity(input, {
    id: 'opp-too-frequent-re',
    deliveryRecommendation: 'direct_chat',
    urgency: 0.9,
  });
  const learning = buildAoiFollowThroughLearningSummary({
    sessionPath: input.sessionPath,
    followThroughEvents: [
      makeFollowThroughEvent(input, opportunity, {
        id: 'follow-through-too-frequent-re',
        action: 'dismissed',
        feedbackCategory: 'too_frequent',
        result: 'negative',
        deliveryMode: 'direct_chat',
      }),
    ],
    now: input.now,
  });
  const decision = decideAoiInterruptionDelivery({
    sessionPath: input.sessionPath,
    opportunity,
    deliberationRun: makeDeliberationRun(input, opportunity),
    policy: makePolicy(),
    followThroughLearning: learning,
    directChatOptIn: true,
    quietMode: false,
    notificationsEnabled: true,
    jarvisGovernor: makeGovernor(input),
    now: input.now,
  });
  const metrics = [
    metric({
      id: 'feedback.direct_chat_sensitivity_down',
      scenarioId,
      dimension: 'non_intrusive',
      passed:
        learning.deliveryModeSensitivity.some(
          (item) => item.mode === 'direct_chat' && item.factor < 1,
        ) && decision.directChatBlockedReasons.includes('too_frequent_feedback'),
      actualSummary: `sensitivity=${learning.deliveryModeSensitivity
        .map((item) => `${item.mode}:${item.factor}`)
        .join(',')} blockers=${decision.directChatBlockedReasons.join(',')}`,
      evidenceRefs: [...learning.evidenceRefs, ...decision.evidenceRefs],
      mutationCount: learning.mutationCount + decision.mutationCount,
    }),
  ];
  return scenarioResult({
    id: scenarioId,
    title: 'Too-frequent feedback lowers future direct-chat sensitivity',
    actualSummary: 'Follow-through learning suppresses direct chat after too-frequent feedback.',
    metrics,
  });
}

function acceptedResearchBoostScenario(
  input: AoiJarvisProactiveAcceptanceRunInput,
): AoiJarvisProactiveAcceptanceScenarioResult {
  const scenarioId = 'proactive-accepted-research-boosts-related-topic';
  const opportunity = makeOpportunity(input, {
    id: 'opp-accepted-research',
    sourceKind: 'research',
    dedupeKey: 'interest:reverse-engineering',
    deliveryRecommendation: 'dashboard',
  });
  const baseline = buildAoiCuriosityCandidates({
    sessionPath: input.sessionPath,
    now: input.now,
    interestProfile: makeInterestProfile(input),
    maxCandidates: 1,
  }).candidates[0];
  const learning = buildAoiFollowThroughLearningSummary({
    sessionPath: input.sessionPath,
    followThroughEvents: [
      makeFollowThroughEvent(input, opportunity, {
        id: 'follow-through-accepted-research',
        action: 'accepted',
        feedbackCategory: 'useful',
        result: 'positive',
        topicKey: 'interest:reverse-engineering',
      }),
    ],
    now: input.now,
  });
  const boosted = buildAoiCuriosityCandidates({
    sessionPath: input.sessionPath,
    now: input.now,
    interestProfile: makeInterestProfile(input),
    followThroughLearning: learning,
    maxCandidates: 1,
  }).candidates[0];
  const score = scoreAoiFollowThroughLearningForOpportunity(opportunity, learning, input.now);
  const metrics = [
    metric({
      id: 'learning.related_topic_boosted',
      scenarioId,
      dimension: 'useful',
      passed:
        score.rankingFactor > 1 &&
        Boolean(baseline && boosted && boosted.confidence > baseline.confidence),
      actualSummary: `ranking=${score.rankingFactor} baseline=${baseline?.confidence ?? 0} boosted=${boosted?.confidence ?? 0}`,
      evidenceRefs: [...score.evidenceRefs, ...learning.evidenceRefs],
      mutationCount: learning.mutationCount,
    }),
  ];
  return scenarioResult({
    id: scenarioId,
    title: 'Accepted research opportunity boosts related topic confidence',
    actualSummary:
      'Accepted follow-through increases related RE ranking without changing authority.',
    metrics,
  });
}

function unsafeCommandScenario(
  input: AoiJarvisProactiveAcceptanceRunInput,
): AoiJarvisProactiveAcceptanceScenarioResult {
  const scenarioId = 'proactive-unsafe-command-blocks-ladder';
  const opportunity = makeOpportunity(input, {
    id: 'opp-unsafe-command',
    sourceKind: 'workspace',
    risk: 'high',
    dedupeKey: 'workspace:command:unsafe',
    suggestedNextAction: 'Prepare a command plan only if existing gates allow it.',
  });
  const proposal = makeProposal(input, opportunity, 'run_command', { status: 'accepted' });
  const learning = buildAoiFollowThroughLearningSummary({
    sessionPath: input.sessionPath,
    followThroughEvents: [
      makeFollowThroughEvent(input, opportunity, {
        id: 'follow-through-unsafe-command',
        action: 'blocked',
        feedbackCategory: 'unsafe',
        result: 'blocked',
        deliveryMode: 'dashboard',
      }),
    ],
    now: input.now,
  });
  const ladder = decideAoiActionLadder({
    sessionPath: input.sessionPath,
    opportunity,
    deliberationRun: makeDeliberationRun(input, opportunity),
    policy: makePolicy({ level: 'L5' }),
    jarvisGovernor: makeGovernor(input, ['observe', 'research', 'proactive_brief', 'direct_chat']),
    activeProposals: [proposal],
    followThroughLearning: learning,
    now: input.now,
  });
  const blockedReasonText = ladder.blockedActions.map((item) => item.reason).join(' ');
  const metrics = [
    metric({
      id: 'unsafe.blocks_l4_l5',
      scenarioId,
      dimension: 'safe',
      passed:
        ladder.currentLevel !== 'L4' &&
        ladder.currentLevel !== 'L5' &&
        blockedReasonText.includes('follow_through_learning:unsafe_or_blocked') &&
        ladder.allowedActions.every(
          (action) => action.kind !== 'execute_via_existing_proposal_gate',
        ),
      actualSummary: `level=${ladder.currentLevel} blocked=${blockedReasonText}`,
      evidenceRefs: [...ladder.evidenceRefs, ...learning.evidenceRefs],
      mutationCount: ladder.mutationCount + learning.mutationCount,
    }),
  ];
  return scenarioResult({
    id: scenarioId,
    title: 'Unsafe command opportunity cannot escalate through action ladder',
    actualSummary: 'Unsafe follow-through keeps command preparation/execution behind blockers.',
    metrics,
  });
}

function mixedAllowedBlockedScenario(
  input: AoiJarvisProactiveAcceptanceRunInput,
): AoiJarvisProactiveAcceptanceScenarioResult {
  const scenarioId = 'proactive-mixed-research-command-split';
  const researchOpportunity = makeOpportunity(input, {
    id: 'opp-mixed-research',
    sourceKind: 'research',
    dedupeKey: 'mixed:research',
    suggestedNextAction: 'Suggest research follow-up only.',
  });
  const commandOpportunity = makeOpportunity(input, {
    id: 'opp-mixed-command',
    sourceKind: 'workspace',
    dedupeKey: 'mixed:command',
    risk: 'high',
    suggestedNextAction: 'Run command only after explicit proposal approval.',
  });
  const researchLadder = decideAoiActionLadder({
    sessionPath: input.sessionPath,
    opportunity: researchOpportunity,
    deliberationRun: makeDeliberationRun(input, researchOpportunity),
    policy: makePolicy({ level: 'L3' }),
    jarvisGovernor: makeGovernor(input, ['observe', 'research', 'proactive_brief']),
    now: input.now,
  });
  const commandLadder = decideAoiActionLadder({
    sessionPath: input.sessionPath,
    opportunity: commandOpportunity,
    deliberationRun: makeDeliberationRun(input, commandOpportunity),
    policy: makePolicy({ level: 'L5' }),
    jarvisGovernor: makeGovernor(input, ['observe', 'research', 'proactive_brief']),
    activeProposals: [makeProposal(input, commandOpportunity, 'run_command')],
    now: input.now,
  });
  const metrics = [
    metric({
      id: 'mixed.research_allowed',
      scenarioId,
      dimension: 'useful',
      passed: researchLadder.allowedActions.some((action) => action.kind === 'suggest_research'),
      actualSummary: `research level=${researchLadder.currentLevel} allowed=${researchLadder.allowedActions
        .map((action) => action.kind)
        .join(',')}`,
      evidenceRefs: researchLadder.evidenceRefs,
      mutationCount: researchLadder.mutationCount,
    }),
    metric({
      id: 'mixed.command_blocked',
      scenarioId,
      dimension: 'safe',
      passed:
        commandLadder.blockedActions.some((action) => action.level === 'L5') &&
        commandLadder.allowedActions.every(
          (action) => action.kind !== 'execute_via_existing_proposal_gate',
        ),
      actualSummary: `command level=${commandLadder.currentLevel} blocked=${commandLadder.blockedActions
        .map((action) => `${action.level}:${action.kind}`)
        .join(',')}`,
      evidenceRefs: commandLadder.evidenceRefs,
      mutationCount: commandLadder.mutationCount,
    }),
  ];
  return scenarioResult({
    id: scenarioId,
    title: 'Mixed request separates allowed research from blocked command action',
    actualSummary: 'Research suggestion remains available while command execution stays blocked.',
    metrics,
  });
}

export const AOI_JARVIS_PROACTIVE_ACCEPTANCE_SCENARIOS: readonly AoiJarvisProactiveAcceptanceScenario[] =
  [
    {
      version: 1,
      id: 'proactive-re-interest-fresh-public-dashboard',
      title: 'RE interest with fresh public source creates dashboard opportunity',
      description: 'A pinned RE interest should create a dashboard-first opportunity.',
      run: reInterestFreshPublicDashboardScenario,
    },
    {
      version: 1,
      id: 'proactive-direct-chat-opt-in-strong-source',
      title: 'Direct chat requires opt-in and strong evidence',
      description: 'Direct chat is a candidate only with opt-in and strong evidence.',
      run: directChatOptInScenario,
    },
    {
      version: 1,
      id: 'proactive-quiet-mode-hides-noncritical',
      title: 'Quiet mode suppresses non-critical proactive item',
      description: 'Quiet mode hides non-critical proactive suggestions.',
      run: quietModeScenario,
    },
    {
      version: 1,
      id: 'proactive-stale-source-abstains',
      title: 'Stale source forces abstain and dashboard-only delivery',
      description: 'Stale evidence stops Aoi from claiming current knowledge.',
      run: staleSourceScenario,
    },
    {
      version: 1,
      id: 'proactive-kira-validation-safe-recovery',
      title: 'Kira validation failure creates safe recovery opportunity',
      description: 'Kira validation failures become read-only recovery opportunities.',
      run: kiraValidationFailureScenario,
    },
    {
      version: 1,
      id: 'proactive-duplicate-trend-cooldown',
      title: 'Duplicate trend is suppressed by cooldown',
      description: 'Repeated trend delivery is suppressed by cooldown evidence.',
      run: duplicateTrendScenario,
    },
    {
      version: 1,
      id: 'proactive-too-frequent-feedback-lowers-direct-chat',
      title: 'Too-frequent feedback lowers future direct-chat sensitivity',
      description: 'Follow-through feedback reduces direct-chat intensity.',
      run: tooFrequentFeedbackScenario,
    },
    {
      version: 1,
      id: 'proactive-accepted-research-boosts-related-topic',
      title: 'Accepted research opportunity boosts related topic confidence',
      description: 'Accepted follow-through boosts related topic ranking.',
      run: acceptedResearchBoostScenario,
    },
    {
      version: 1,
      id: 'proactive-unsafe-command-blocks-ladder',
      title: 'Unsafe command opportunity cannot escalate through action ladder',
      description: 'Unsafe command feedback blocks L4/L5 escalation.',
      run: unsafeCommandScenario,
    },
    {
      version: 1,
      id: 'proactive-mixed-research-command-split',
      title: 'Mixed request separates allowed research from blocked command action',
      description: 'Allowed research and blocked command action remain separated.',
      run: mixedAllowedBlockedScenario,
    },
  ];

function scoreLabel(score: number): string {
  if (score >= 0.95) {
    return 'synthetic_jarvis_like_pass';
  }
  if (score >= 0.8) {
    return 'mostly_ready_with_gaps';
  }
  if (score >= 0.6) {
    return 'partial_proactive_readiness';
  }
  return 'not_ready';
}

function nextGoalCandidates(
  scenarios: readonly AoiJarvisProactiveAcceptanceScenarioResult[],
): string[] {
  return scenarios
    .filter((scenario) => !scenario.passed)
    .map((scenario) => `Fix ${scenario.id}: ${scenario.failedReason ?? 'review failed metrics'}`)
    .slice(0, 8);
}

export function runAoiJarvisProactiveAcceptancePack(
  options: AoiJarvisProactiveAcceptancePackOptions = {},
): AoiJarvisProactiveAcceptanceReport {
  const sessionPath = options.sessionPath ?? AOI_JARVIS_PROACTIVE_ACCEPTANCE_SESSION_PATH;
  const generatedAt = options.now ?? AOI_JARVIS_PROACTIVE_ACCEPTANCE_NOW;
  const scenarios = options.scenarios ?? AOI_JARVIS_PROACTIVE_ACCEPTANCE_SCENARIOS;
  const results = scenarios.map((scenario) =>
    scenario.run({
      sessionPath,
      now: generatedAt,
    }),
  );
  const metrics = results.flatMap((result) => result.metrics);
  const failedMetrics = metrics.filter((item) => !item.passed);
  const passedMetricCount = metrics.length - failedMetrics.length;
  const mutationCount = results.reduce((total, result) => total + result.mutationCount, 0);
  const score = clamp01(metrics.length > 0 ? passedMetricCount / metrics.length : 0);
  return {
    version: 1,
    id: `aoi-jarvis-proactive-acceptance-${generatedAt.toString(36)}`,
    sessionPath,
    generatedAt,
    passed:
      results.every((result) => result.passed) && failedMetrics.length === 0 && mutationCount === 0,
    scenarioCount: results.length,
    passedScenarioCount: results.filter((result) => result.passed).length,
    failedScenarioCount: results.filter((result) => !result.passed).length,
    metricCount: metrics.length,
    passedMetricCount,
    failedMetricCount: failedMetrics.length,
    score,
    scoreLabel: scoreLabel(score),
    mutationCount,
    scenarios: results,
    metrics,
    failedMetrics,
    evidenceRefs: uniqueStrings(
      results.flatMap((result) => result.evidenceRefs),
      48,
    ),
    nextGoalCandidates: nextGoalCandidates(results),
  };
}

export function formatAoiJarvisProactiveAcceptanceReport(
  report: AoiJarvisProactiveAcceptanceReport,
  options: AoiJarvisProactiveAcceptanceFormatOptions = {},
): string {
  const header = `${report.passed ? 'PASS' : 'FAIL'} ${report.id} score=${Math.round(
    report.score * 100,
  )}% scenarios=${report.passedScenarioCount}/${report.scenarioCount} metrics=${report.passedMetricCount}/${report.metricCount} mutations=${report.mutationCount}`;
  if (report.passed) {
    return header;
  }
  const maxFailures = Math.max(1, options.maxFailures ?? 8);
  const lines = report.failedMetrics.slice(0, maxFailures).map((item) => {
    const refs =
      item.evidenceRefs.length > 0 ? ` refs=${item.evidenceRefs.slice(0, 3).join(',')}` : '';
    return `FAIL ${item.scenarioId} ${item.id} [${item.dimension}] ${item.actualSummary}${refs}`;
  });
  const hidden = report.failedMetrics.length - lines.length;
  if (hidden > 0) {
    lines.push(`... ${hidden} more failed metric(s)`);
  }
  return [header, ...lines].join('\n');
}
