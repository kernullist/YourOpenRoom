import type {
  AoiActionCalibration,
  AoiAutonomyRisk,
  AoiCalibrationDimension,
  AoiCalibrationDirection,
  AoiCalibrationEvidence,
  AoiContextSourceFeedback,
  AoiInterruptionPolicy,
  AoiNotificationLane,
  AoiOperatorTimelineEvent,
  AoiOperatorVoiceEventCategory,
  AoiProposal,
  AoiProposalDecision,
  AoiProposalFeedbackCategory,
  AoiSourceCalibration,
  AoiTriggerCalibration,
  AoiTrustCalibrationProfile,
  AoiTrustCalibrationReset,
} from './aoiAutonomyTypes';

const MAX_EVIDENCE_REFS = 12;
const MAX_RECENT_CHANGES = 24;
const POSITIVE_DELTA = 0.04;
const DISMISS_DELTA = -0.06;
const TOO_MUCH_DELTA = -0.28;
const WRONG_SOURCE_DELTA = -0.3;
const WRONG_EVIDENCE_DELTA = -0.18;
const UNSAFE_STRICTNESS_DELTA = 0.22;

export interface AoiTrustCalibrationBuildInput {
  sessionPath: string;
  proposals?: AoiProposal[];
  decisions?: AoiProposalDecision[];
  contextFeedback?: AoiContextSourceFeedback[];
  timelineEvents?: AoiOperatorTimelineEvent[];
  replayFailures?: Array<{ key: string; evidenceRefs?: string[] }>;
  resets?: AoiTrustCalibrationReset[];
  now?: number;
}

export interface AoiTrustCalibrationApplication {
  rankingAdjustment: number;
  interruptionAdjustment: number;
  sourceSelectionPenalty: number;
  requiresAskFirst: boolean;
  suppress: boolean;
  requiredEvidenceBoost: number;
  approvalStrictnessBoost: number;
  reasons: string[];
  evidenceRefs: string[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeSessionPath(value: string): string | null {
  const normalized = normalizeWhitespace(value)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (
    !normalized ||
    normalized.includes('..') ||
    normalized.startsWith('.') ||
    normalized.length > 220
  ) {
    return null;
  }
  return normalized;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function fixed(value: number): number {
  return Number(value.toFixed(3));
}

function dedupeRefs(refs: Array<string | undefined>, maxItems = MAX_EVIDENCE_REFS): string[] {
  const seen = new Set<string>();
  for (const ref of refs) {
    const normalized = normalizeWhitespace(ref ?? '').slice(0, 240);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function calibrationEvidenceId(params: {
  dimension: AoiCalibrationDimension;
  key: string;
  reason: string;
  createdAt: number;
}): string {
  const raw = `${params.dimension}:${params.key}:${params.reason}:${params.createdAt}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `aoi-calibration-${hash.toString(16).padStart(8, '0')}`.slice(0, 127);
}

function getDefaultAoiInterruptionPolicy(): AoiInterruptionPolicy {
  return {
    version: 1,
    defaultThreshold: 0.62,
    askFirstThreshold: 0.52,
    suppressThreshold: 0.24,
    minInterruptionGapMs: 10 * 60 * 1000,
    positiveLearningCap: 0.12,
    negativeLearningCap: -0.42,
  };
}

function actionKindFromDecision(decision: AoiProposalDecision): string {
  return decision.actionKind || decision.suggestedTools?.[0] || 'unknown';
}

function triggerKindFromDecision(decision: AoiProposalDecision): string {
  if (decision.proposalTrigger) {
    return decision.proposalTrigger;
  }
  const separator = decision.cooldownKey.indexOf(':');
  return separator > 0 ? decision.cooldownKey.slice(0, separator) : decision.cooldownKey;
}

function sourceKindFromRef(ref: string): string | null {
  if (ref.startsWith('research:')) {
    return 'research_runs';
  }
  if (ref.startsWith('workspace:')) {
    return ref.includes('validation') || ref.includes('build')
      ? 'workspace_build'
      : 'workspace_git';
  }
  if (ref.startsWith('browser:') || ref.includes('browser-context')) {
    return 'browser_context';
  }
  if (ref.startsWith('memory:') || ref.startsWith('kira:')) {
    return 'kira_board';
  }
  if (ref.includes('calendar')) {
    return 'calendar_metadata';
  }
  if (ref.includes('gmail')) {
    return 'gmail_metadata';
  }
  if (ref.includes('notes')) {
    return 'notes_metadata';
  }
  return null;
}

function sourceKindFromSourceId(sourceId: string): string {
  return sourceId.replace(/-/g, '_') || 'unknown';
}

function sourceKindsFromDecision(decision: AoiProposalDecision): string[] {
  const kinds = new Set<string>();
  for (const ref of decision.evidenceRefs ?? []) {
    const kind = sourceKindFromRef(ref);
    if (kind) {
      kinds.add(kind);
    }
  }
  return [...kinds];
}

function riskFromDecision(
  decision: AoiProposalDecision,
  proposalsById: Map<string, AoiProposal>,
): AoiAutonomyRisk {
  return decision.proposalRisk ?? proposalsById.get(decision.proposalId)?.risk ?? 'low';
}

function addEvidence(
  evidence: AoiCalibrationEvidence[],
  params: {
    dimension: AoiCalibrationDimension;
    key: string;
    direction: AoiCalibrationDirection;
    delta: number;
    reason: string;
    createdAt: number;
    evidenceRefs: string[];
    feedbackCategory?: AoiProposalFeedbackCategory;
    replayBlocked?: boolean;
  },
): void {
  const key = normalizeWhitespace(params.key).slice(0, 120);
  if (!key) {
    return;
  }
  evidence.push({
    version: 1,
    id: calibrationEvidenceId({
      dimension: params.dimension,
      key,
      reason: params.reason,
      createdAt: params.createdAt,
    }),
    dimension: params.dimension,
    key,
    direction: params.direction,
    delta: fixed(params.delta),
    reason: normalizeWhitespace(params.reason).slice(0, 180),
    createdAt: params.createdAt,
    evidenceRefs: dedupeRefs(params.evidenceRefs),
    ...(params.feedbackCategory ? { feedbackCategory: params.feedbackCategory } : {}),
    ...(params.replayBlocked ? { replayBlocked: true } : {}),
  });
}

function resetApplies(reset: AoiTrustCalibrationReset, evidence: AoiCalibrationEvidence): boolean {
  return reset.dimension === evidence.dimension && reset.key === evidence.key;
}

function applyResets(
  evidence: AoiCalibrationEvidence[],
  resets: AoiTrustCalibrationReset[] | undefined,
): AoiCalibrationEvidence[] {
  if (!resets || resets.length === 0) {
    return evidence;
  }
  return evidence.filter(
    (item) => !resets.some((reset) => resetApplies(reset, item) && item.createdAt <= reset.resetAt),
  );
}

function replayFailureBlocks(
  key: string,
  replayFailures: AoiTrustCalibrationBuildInput['replayFailures'],
): boolean {
  return (replayFailures ?? []).some((failure) => failure.key === key);
}

function evidenceFromDecisions(
  params: Required<Pick<AoiTrustCalibrationBuildInput, 'decisions' | 'now'>> & {
    proposalsById: Map<string, AoiProposal>;
    replayFailures?: AoiTrustCalibrationBuildInput['replayFailures'];
  },
): AoiCalibrationEvidence[] {
  const evidence: AoiCalibrationEvidence[] = [];
  for (const decision of params.decisions) {
    const triggerKind = triggerKindFromDecision(decision);
    const actionKind = actionKindFromDecision(decision);
    const risk = riskFromDecision(decision, params.proposalsById);
    const evidenceRefs = dedupeRefs([
      `decision:${decision.id}`,
      `proposal:${decision.proposalId}`,
      decision.cooldownKey,
      ...(decision.evidenceRefs ?? []),
    ]);
    const sourceKinds = sourceKindsFromDecision(decision);
    const accepted = decision.action === 'accept' || decision.feedbackCategory === 'useful';
    const negative = decision.action === 'dismiss' || decision.action === 'snooze';
    const replayBlocked =
      accepted &&
      (replayFailureBlocks(`trigger:${triggerKind}`, params.replayFailures) ||
        replayFailureBlocks(`action:${actionKind}`, params.replayFailures));

    if (accepted) {
      addEvidence(evidence, {
        dimension: 'trigger_kind',
        key: triggerKind,
        direction: replayBlocked ? 'negative' : 'positive',
        delta: replayBlocked ? 0 : POSITIVE_DELTA,
        reason: replayBlocked
          ? 'Replay failure blocked positive trigger promotion.'
          : 'Accepted proposal raised usefulness slowly.',
        createdAt: decision.createdAt,
        evidenceRefs,
        feedbackCategory: decision.feedbackCategory,
        replayBlocked,
      });
      addEvidence(evidence, {
        dimension: 'action_kind',
        key: actionKind,
        direction: replayBlocked ? 'negative' : 'positive',
        delta: replayBlocked ? 0 : POSITIVE_DELTA,
        reason: replayBlocked
          ? 'Replay failure blocked positive action promotion.'
          : 'Accepted action raised future visibility slowly.',
        createdAt: decision.createdAt,
        evidenceRefs,
        feedbackCategory: decision.feedbackCategory,
        replayBlocked,
      });
    }

    if (negative) {
      const strongTiming =
        decision.feedbackCategory === 'too_much' ||
        decision.feedbackCategory === 'too_frequent' ||
        decision.feedbackCategory === 'wrong_timing';
      addEvidence(evidence, {
        dimension: 'trigger_kind',
        key: triggerKind,
        direction: 'negative',
        delta: strongTiming ? TOO_MUCH_DELTA : DISMISS_DELTA,
        reason: strongTiming
          ? 'Timing feedback lowered interruption threshold for similar triggers.'
          : 'Dismissed proposal lowered usefulness mildly.',
        createdAt: decision.createdAt,
        evidenceRefs,
        feedbackCategory: decision.feedbackCategory,
      });
    }

    if (decision.feedbackCategory) {
      addEvidence(evidence, {
        dimension: 'feedback_category',
        key: decision.feedbackCategory,
        direction: decision.feedbackCategory === 'useful' ? 'positive' : 'negative',
        delta:
          decision.feedbackCategory === 'useful'
            ? POSITIVE_DELTA
            : decision.feedbackCategory === 'too_much'
              ? TOO_MUCH_DELTA
              : DISMISS_DELTA,
        reason: `Feedback category ${decision.feedbackCategory} changed calibration.`,
        createdAt: decision.createdAt,
        evidenceRefs,
        feedbackCategory: decision.feedbackCategory,
      });
    }

    if (decision.feedbackCategory === 'unsafe') {
      addEvidence(evidence, {
        dimension: 'trigger_kind',
        key: triggerKind,
        direction: 'safety',
        delta: UNSAFE_STRICTNESS_DELTA,
        reason: 'Unsafe feedback increased evidence and approval strictness.',
        createdAt: decision.createdAt,
        evidenceRefs,
        feedbackCategory: decision.feedbackCategory,
      });
      addEvidence(evidence, {
        dimension: 'action_kind',
        key: actionKind,
        direction: 'safety',
        delta: UNSAFE_STRICTNESS_DELTA,
        reason: 'Unsafe feedback kept matching action approval-gated.',
        createdAt: decision.createdAt,
        evidenceRefs,
        feedbackCategory: decision.feedbackCategory,
      });
    }

    if (
      decision.feedbackCategory === 'wrong_source' ||
      decision.feedbackCategory === 'wrong_evidence'
    ) {
      for (const sourceKind of sourceKinds) {
        addEvidence(evidence, {
          dimension: 'source_kind',
          key: sourceKind,
          direction: 'negative',
          delta:
            decision.feedbackCategory === 'wrong_source'
              ? WRONG_SOURCE_DELTA
              : WRONG_EVIDENCE_DELTA,
          reason:
            decision.feedbackCategory === 'wrong_source'
              ? 'Wrong-source feedback penalized source selection.'
              : 'Wrong-evidence feedback penalized matching source evidence.',
          createdAt: decision.createdAt,
          evidenceRefs,
          feedbackCategory: decision.feedbackCategory,
        });
      }
    }

    addEvidence(evidence, {
      dimension: 'risk_level',
      key: risk,
      direction: accepted ? 'positive' : negative ? 'negative' : 'safety',
      delta: accepted ? POSITIVE_DELTA : negative ? DISMISS_DELTA : 0,
      reason: `Risk level ${risk} observed in proposal decision.`,
      createdAt: decision.createdAt,
      evidenceRefs,
      feedbackCategory: decision.feedbackCategory,
    });
  }
  return evidence;
}

function evidenceFromContextFeedback(
  feedback: AoiContextSourceFeedback[] | undefined,
): AoiCalibrationEvidence[] {
  const evidence: AoiCalibrationEvidence[] = [];
  for (const item of feedback ?? []) {
    const sourceKind = sourceKindFromSourceId(item.sourceId);
    const wrongSource =
      item.feedbackCategory === 'wrong_source' || item.feedbackCategory === 'wrong_evidence';
    addEvidence(evidence, {
      dimension: 'source_kind',
      key: sourceKind,
      direction: wrongSource ? 'negative' : 'negative',
      delta: wrongSource ? WRONG_SOURCE_DELTA : DISMISS_DELTA,
      reason: wrongSource
        ? 'Context feedback penalized source selection.'
        : `Context feedback ${item.feedbackCategory} reduced source priority.`,
      createdAt: item.createdAt,
      evidenceRefs: dedupeRefs([
        `context-feedback:${item.id}`,
        `environment-source:${item.sourceId}`,
        ...(item.evidenceRefs ?? []),
      ]),
      feedbackCategory: item.feedbackCategory,
    });
  }
  return evidence;
}

function metadataString(event: AoiOperatorTimelineEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function evidenceFromTimeline(
  timelineEvents: AoiOperatorTimelineEvent[] | undefined,
): AoiCalibrationEvidence[] {
  const evidence: AoiCalibrationEvidence[] = [];
  const visibleInterruptions = (timelineEvents ?? [])
    .filter((event) => event.visibility === 'operator_visible')
    .sort((left, right) => left.createdAt - right.createdAt);
  for (const event of timelineEvents ?? []) {
    if (event.kind === 'digest_item_hidden' || event.kind === 'digest_item_surfaced') {
      const lane = metadataString(event, 'lane') as AoiNotificationLane | undefined;
      if (lane) {
        addEvidence(evidence, {
          dimension: 'notification_lane',
          key: lane,
          direction: event.kind === 'digest_item_hidden' ? 'negative' : 'positive',
          delta: event.kind === 'digest_item_hidden' ? DISMISS_DELTA : POSITIVE_DELTA / 2,
          reason:
            event.kind === 'digest_item_hidden'
              ? 'Digest lane was hidden by policy or quiet feedback.'
              : 'Digest lane surfaced to the operator.',
          createdAt: event.createdAt,
          evidenceRefs: event.evidenceRefs,
        });
      }
    }
    if (event.kind === 'operator_voice_decision') {
      const category = event.sourceKind as AoiOperatorVoiceEventCategory | undefined;
      if (category) {
        const spoken = event.status === 'spoken';
        addEvidence(evidence, {
          dimension: 'voice_category',
          key: category,
          direction: spoken ? 'positive' : 'negative',
          delta: spoken ? POSITIVE_DELTA / 2 : DISMISS_DELTA,
          reason: spoken
            ? 'Voice category passed interruption policy.'
            : `Voice category stayed silent: ${event.status ?? 'unknown'}.`,
          createdAt: event.createdAt,
          evidenceRefs: event.evidenceRefs,
        });
      }
    }
  }
  for (let index = 1; index < visibleInterruptions.length; index += 1) {
    const gapMs = visibleInterruptions[index].createdAt - visibleInterruptions[index - 1].createdAt;
    if (gapMs >= 0 && gapMs < getDefaultAoiInterruptionPolicy().minInterruptionGapMs) {
      addEvidence(evidence, {
        dimension: 'interruption_gap',
        key: 'too_close',
        direction: 'negative',
        delta: -0.12,
        reason: 'Operator-visible interruptions happened close together.',
        createdAt: visibleInterruptions[index].createdAt,
        evidenceRefs: visibleInterruptions[index].evidenceRefs,
      });
    }
  }
  return evidence;
}

function summarizeByDimension(
  evidence: AoiCalibrationEvidence[],
  dimension: AoiCalibrationDimension,
): Map<string, AoiCalibrationEvidence[]> {
  const buckets = new Map<string, AoiCalibrationEvidence[]>();
  for (const item of evidence) {
    if (item.dimension !== dimension) {
      continue;
    }
    buckets.set(item.key, [...(buckets.get(item.key) ?? []), item]);
  }
  return buckets;
}

function sumDelta(items: AoiCalibrationEvidence[], min: number, max: number): number {
  return fixed(
    clamp(
      items.reduce((total, item) => total + item.delta, 0),
      min,
      max,
    ),
  );
}

function newestAt(items: AoiCalibrationEvidence[]): number | undefined {
  const newest = Math.max(...items.map((item) => item.createdAt));
  return Number.isFinite(newest) ? newest : undefined;
}

function evidenceRefsFromItems(items: AoiCalibrationEvidence[]): string[] {
  return dedupeRefs(items.flatMap((item) => item.evidenceRefs));
}

function buildTriggerCalibrations(
  evidence: AoiCalibrationEvidence[],
  policy: AoiInterruptionPolicy,
): AoiTriggerCalibration[] {
  return [...summarizeByDimension(evidence, 'trigger_kind').entries()]
    .map(([triggerKind, items]) => {
      const safetyItems = items.filter((item) => item.direction === 'safety');
      const usefulnessScore = sumDelta(
        items.filter((item) => item.direction !== 'safety'),
        policy.negativeLearningCap,
        policy.positiveLearningCap,
      );
      const safetyScore = sumDelta(safetyItems, 0, 0.5);
      return {
        version: 1 as const,
        triggerKind,
        usefulnessScore,
        interruptionScore: fixed(clamp(usefulnessScore - safetyScore, -0.55, 0.16)),
        requiredEvidenceBoost: safetyScore,
        approvalStrictnessBoost: safetyScore,
        evidenceCount: items.length,
        lastUpdatedAt: newestAt(items),
        evidenceRefs: evidenceRefsFromItems(items),
      };
    })
    .sort(
      (left, right) =>
        Math.abs(right.interruptionScore) - Math.abs(left.interruptionScore) ||
        right.evidenceCount - left.evidenceCount ||
        left.triggerKind.localeCompare(right.triggerKind),
    )
    .slice(0, 24);
}

function buildSourceCalibrations(evidence: AoiCalibrationEvidence[]): AoiSourceCalibration[] {
  return [...summarizeByDimension(evidence, 'source_kind').entries()]
    .map(([sourceKind, items]) => {
      const usefulnessScore = sumDelta(items, -0.5, 0.12);
      const negativeFeedbackCount = items.filter((item) => item.direction === 'negative').length;
      return {
        version: 1 as const,
        sourceKind,
        usefulnessScore,
        selectionPenalty: fixed(clamp(-Math.min(0, usefulnessScore), 0, 0.5)),
        evidenceCount: items.length,
        negativeFeedbackCount,
        lastUpdatedAt: newestAt(items),
        evidenceRefs: evidenceRefsFromItems(items),
      };
    })
    .sort(
      (left, right) =>
        right.selectionPenalty - left.selectionPenalty ||
        right.negativeFeedbackCount - left.negativeFeedbackCount ||
        left.sourceKind.localeCompare(right.sourceKind),
    )
    .slice(0, 24);
}

function buildActionCalibrations(
  evidence: AoiCalibrationEvidence[],
  policy: AoiInterruptionPolicy,
): AoiActionCalibration[] {
  return [...summarizeByDimension(evidence, 'action_kind').entries()]
    .map(([actionKind, items]) => {
      const safetyItems = items.filter((item) => item.direction === 'safety');
      return {
        version: 1 as const,
        actionKind,
        usefulnessScore: sumDelta(
          items.filter((item) => item.direction !== 'safety'),
          policy.negativeLearningCap,
          policy.positiveLearningCap,
        ),
        approvalStrictnessBoost: sumDelta(safetyItems, 0, 0.5),
        evidenceCount: items.length,
        unsafeFeedbackCount: safetyItems.length,
        lastUpdatedAt: newestAt(items),
        evidenceRefs: evidenceRefsFromItems(items),
      };
    })
    .sort(
      (left, right) =>
        right.approvalStrictnessBoost - left.approvalStrictnessBoost ||
        Math.abs(right.usefulnessScore) - Math.abs(left.usefulnessScore) ||
        left.actionKind.localeCompare(right.actionKind),
    )
    .slice(0, 24);
}

function buildRecordCalibration<T extends string>(
  evidence: AoiCalibrationEvidence[],
  dimension: AoiCalibrationDimension,
  min: number,
  max: number,
): Partial<Record<T, number>> {
  const result: Partial<Record<T, number>> = {};
  for (const [key, items] of summarizeByDimension(evidence, dimension).entries()) {
    result[key as T] = sumDelta(items, min, max);
  }
  return result;
}

export function buildAoiTrustCalibrationProfile(
  input: AoiTrustCalibrationBuildInput,
): AoiTrustCalibrationProfile {
  const sessionPath = normalizeSessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const policy = getDefaultAoiInterruptionPolicy();
  const now = input.now ?? Date.now();
  const proposalsById = new Map((input.proposals ?? []).map((proposal) => [proposal.id, proposal]));
  const evidence = applyResets(
    [
      ...evidenceFromDecisions({
        decisions: input.decisions ?? [],
        proposalsById,
        replayFailures: input.replayFailures,
        now,
      }),
      ...evidenceFromContextFeedback(input.contextFeedback),
      ...evidenceFromTimeline(input.timelineEvents),
    ].sort((left, right) => right.createdAt - left.createdAt),
    input.resets,
  );
  const triggerCalibrations = buildTriggerCalibrations(evidence, policy);
  const sourceCalibrations = buildSourceCalibrations(evidence);
  const actionCalibrations = buildActionCalibrations(evidence, policy);
  const negativeEvidence = evidence
    .filter((item) => item.direction === 'negative' && item.delta < 0)
    .sort(
      (left, right) =>
        Math.abs(right.delta) - Math.abs(left.delta) || right.createdAt - left.createdAt,
    );

  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    interruptionPolicy: policy,
    triggerCalibrations,
    sourceCalibrations,
    actionCalibrations,
    riskCalibration: {
      low: buildRecordCalibration<AoiAutonomyRisk>(evidence, 'risk_level', -0.24, 0.08).low ?? 0,
      medium:
        buildRecordCalibration<AoiAutonomyRisk>(evidence, 'risk_level', -0.24, 0.08).medium ?? 0,
      high: buildRecordCalibration<AoiAutonomyRisk>(evidence, 'risk_level', -0.24, 0.08).high ?? 0,
    },
    laneCalibration: buildRecordCalibration<AoiNotificationLane>(
      evidence,
      'notification_lane',
      -0.32,
      0.08,
    ),
    voiceCalibration: buildRecordCalibration<AoiOperatorVoiceEventCategory>(
      evidence,
      'voice_category',
      -0.32,
      0.08,
    ),
    feedbackCalibration: buildRecordCalibration<AoiProposalFeedbackCategory>(
      evidence,
      'feedback_category',
      -0.42,
      0.12,
    ),
    topSuppressedCategories: negativeEvidence.slice(0, 8),
    negativeSources: sourceCalibrations.filter((source) => source.selectionPenalty > 0).slice(0, 8),
    recentChanges: evidence.slice(0, MAX_RECENT_CHANGES),
    resetCategories: input.resets ?? [],
  };
}

export function applyAoiTrustCalibration(params: {
  profile?: AoiTrustCalibrationProfile | null;
  triggerKind?: string;
  sourceKind?: string;
  actionKind?: string;
  risk?: AoiAutonomyRisk;
  notificationLane?: AoiNotificationLane;
  voiceCategory?: AoiOperatorVoiceEventCategory;
  score?: number;
}): AoiTrustCalibrationApplication {
  const profile = params.profile;
  const reasons: string[] = [];
  const evidenceRefs: string[] = [];
  let rankingAdjustment = 0;
  let interruptionAdjustment = 0;
  let sourceSelectionPenalty = 0;
  let requiredEvidenceBoost = 0;
  let approvalStrictnessBoost = 0;

  const trigger = profile?.triggerCalibrations.find(
    (item) => item.triggerKind === params.triggerKind,
  );
  if (trigger) {
    rankingAdjustment += trigger.usefulnessScore;
    interruptionAdjustment += trigger.interruptionScore;
    requiredEvidenceBoost += trigger.requiredEvidenceBoost;
    approvalStrictnessBoost += trigger.approvalStrictnessBoost;
    evidenceRefs.push(...trigger.evidenceRefs);
    reasons.push(`trigger:${trigger.triggerKind}:${trigger.interruptionScore}`);
  }

  const source = profile?.sourceCalibrations.find((item) => item.sourceKind === params.sourceKind);
  if (source) {
    rankingAdjustment += source.usefulnessScore;
    sourceSelectionPenalty += source.selectionPenalty;
    evidenceRefs.push(...source.evidenceRefs);
    reasons.push(`source:${source.sourceKind}:-${source.selectionPenalty}`);
  }

  const action = profile?.actionCalibrations.find((item) => item.actionKind === params.actionKind);
  if (action) {
    rankingAdjustment += action.usefulnessScore;
    approvalStrictnessBoost += action.approvalStrictnessBoost;
    evidenceRefs.push(...action.evidenceRefs);
    reasons.push(`action:${action.actionKind}:${action.usefulnessScore}`);
  }

  if (profile && params.risk) {
    rankingAdjustment += profile.riskCalibration[params.risk] ?? 0;
  }
  if (profile && params.notificationLane) {
    interruptionAdjustment += profile.laneCalibration[params.notificationLane] ?? 0;
  }
  if (profile && params.voiceCategory) {
    interruptionAdjustment += profile.voiceCalibration[params.voiceCategory] ?? 0;
  }

  rankingAdjustment = fixed(clamp(rankingAdjustment, -0.42, 0.12));
  interruptionAdjustment = fixed(clamp(interruptionAdjustment, -0.42, 0.12));
  sourceSelectionPenalty = fixed(clamp(sourceSelectionPenalty, 0, 0.5));
  const adjustedScore = fixed(
    (params.score ?? profile?.interruptionPolicy.defaultThreshold ?? 0) + interruptionAdjustment,
  );
  const strongNegativeInterruption =
    interruptionAdjustment <= -0.28 || sourceSelectionPenalty >= 0.3;
  const suppress =
    Boolean(profile) &&
    (adjustedScore < (profile?.interruptionPolicy.suppressThreshold ?? 0.24) ||
      (strongNegativeInterruption &&
        adjustedScore < (profile?.interruptionPolicy.askFirstThreshold ?? 0.52)));
  const requiresAskFirst =
    Boolean(profile) &&
    adjustedScore < (profile?.interruptionPolicy.askFirstThreshold ?? 0.52) &&
    !suppress;

  return {
    rankingAdjustment,
    interruptionAdjustment,
    sourceSelectionPenalty,
    requiresAskFirst,
    suppress,
    requiredEvidenceBoost: fixed(clamp(requiredEvidenceBoost, 0, 0.5)),
    approvalStrictnessBoost: fixed(clamp(approvalStrictnessBoost, 0, 0.5)),
    reasons,
    evidenceRefs: dedupeRefs(evidenceRefs),
  };
}
