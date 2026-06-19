import {
  decideAoiProactiveBriefDelivery,
  type AoiProactiveBriefDeliveryContext,
  type AoiProactiveBriefDeliveryDecision,
} from './aoiProactiveBriefPolicy';
import type {
  AoiAutonomyPolicy,
  AoiInterestProfile,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefCooldownState,
  AoiProactiveBriefFeedback,
} from './aoiAutonomyTypes';

const MAX_CARD_COUNT = 5;

export type AoiProactiveBriefUiAction =
  | 'useful'
  | 'not_useful'
  | 'show_more'
  | 'show_less'
  | 'wrong_topic'
  | 'wrong_timing'
  | 'too_frequent'
  | 'stale'
  | 'unsafe'
  | 'mute_topic'
  | 'pin_topic'
  | 'archive_brief'
  | 'open_sources'
  | 'expand_summary';

export interface AoiProactiveBriefSourceDisplay {
  title: string;
  host: string;
  url: string;
  publishedAtLabel: string;
  retrievedAtLabel: string;
  snippet: string;
}

export interface AoiProactiveBriefFeedbackActionDisplay {
  action: AoiProactiveBriefUiAction;
  label: string;
  title: string;
  tone: 'positive' | 'neutral' | 'negative';
}

export interface AoiProactiveBriefCardModel {
  id: string;
  topicId: string;
  status: AoiProactiveBriefCandidate['status'];
  title: string;
  hook: string;
  whyForOperator: string;
  noveltyReason: string;
  summary: string;
  sourceCountLabel: string;
  sourceHostLabel: string;
  freshnessLabel: string;
  cannotKnowLabels: string[];
  evidenceRefs: string[];
  memoryRefs: string[];
  sources: AoiProactiveBriefSourceDisplay[];
  feedbackActions: AoiProactiveBriefFeedbackActionDisplay[];
  delivery: AoiProactiveBriefDeliveryDecision;
  directChatHook: string;
  expandedSummaryLabel: string;
}

export interface AoiProactiveBriefPanelModel {
  visible: boolean;
  statusLabel: string;
  hiddenLabel: string;
  cards: AoiProactiveBriefCardModel[];
  inlineCard?: AoiProactiveBriefCardModel;
  chatHook?: string;
  evidenceRefs: string[];
}

export interface BuildAoiProactiveBriefPanelModelInput {
  candidates: AoiProactiveBriefCandidate[];
  policy?: AoiAutonomyPolicy | null;
  profile?: AoiInterestProfile | null;
  feedback?: AoiProactiveBriefFeedback[];
  cooldownState?: AoiProactiveBriefCooldownState | null;
  context?: AoiProactiveBriefDeliveryContext;
  includeHidden?: boolean;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return 'undated';
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return 'undated';
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return 'unknown';
  }
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ');
}

function uniqueLabels(values: Array<string | undefined>, maxItems: number): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const label = truncateText(value ?? '', 220);
    if (label) {
      seen.add(label);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function freshnessLabel(candidate: AoiProactiveBriefCandidate): string {
  const searched = `searched ${formatTimestamp(candidate.freshness.searchedAt)}`;
  const newest = candidate.freshness.newestSourceAt
    ? `newest ${formatDate(candidate.freshness.newestSourceAt)}`
    : 'newest unknown';
  const cannotKnow =
    candidate.freshness.cannotKnow.length > 0
      ? `${candidate.freshness.cannotKnow.length} cannot-know note${
          candidate.freshness.cannotKnow.length === 1 ? '' : 's'
        }`
      : 'freshness evidence attached';
  return `${searched}; ${newest}; ${cannotKnow}`;
}

function buildSources(candidate: AoiProactiveBriefCandidate): AoiProactiveBriefSourceDisplay[] {
  return candidate.sources.slice(0, 6).map((source) => ({
    title: truncateText(source.title, 140),
    host: truncateText(source.host, 80),
    url: source.url,
    publishedAtLabel: formatDate(source.publishedAt),
    retrievedAtLabel: formatTimestamp(source.retrievedAt),
    snippet: truncateText(source.snippet, 240),
  }));
}

function buildFeedbackActions(
  candidate: AoiProactiveBriefCandidate,
): AoiProactiveBriefFeedbackActionDisplay[] {
  const archived = candidate.status === 'archived' || candidate.status === 'expired';
  return [
    {
      action: 'useful',
      label: 'Useful',
      title: 'Tell Aoi this topic and timing were useful.',
      tone: 'positive',
    },
    {
      action: 'show_less',
      label: 'Less',
      title: 'Reduce this topic and add cooldown.',
      tone: 'negative',
    },
    {
      action: 'wrong_timing',
      label: 'Timing',
      title: 'Mark the timing as wrong for future delivery.',
      tone: 'negative',
    },
    {
      action: 'mute_topic',
      label: 'Mute',
      title: 'Mute this topic for future proactive briefs.',
      tone: 'negative',
    },
    {
      action: 'open_sources',
      label: 'Sources',
      title: 'Expand the source list without opening external URLs.',
      tone: 'neutral',
    },
    {
      action: archived ? 'expand_summary' : 'archive_brief',
      label: archived ? 'Details' : 'Archive',
      title: archived ? 'Expand the summary and evidence.' : 'Archive this brief.',
      tone: archived ? 'neutral' : 'negative',
    },
  ];
}

function buildCard(params: {
  candidate: AoiProactiveBriefCandidate;
  decision: AoiProactiveBriefDeliveryDecision;
}): AoiProactiveBriefCardModel {
  const candidate = params.candidate;
  const sourceHosts = uniqueLabels(
    candidate.sources.map((source) => source.host),
    4,
  );
  const evidenceRefs = uniqueLabels(
    [...candidate.evidenceRefs, ...candidate.sources.map((source) => `source:${source.host}`)],
    12,
  );
  const memoryRefs = uniqueLabels(
    candidate.memoryIds.map((id) => `memory:${id}`),
    8,
  );
  return {
    id: candidate.id,
    topicId: candidate.topicId,
    status: candidate.status,
    title: truncateText(candidate.title, 140),
    hook: truncateText(candidate.hook, 180),
    whyForOperator: truncateText(candidate.whyForOperator, 240),
    noveltyReason: truncateText(candidate.noveltyReason, 220),
    summary: truncateText(candidate.summary, 320),
    sourceCountLabel: `${candidate.sources.length} source${
      candidate.sources.length === 1 ? '' : 's'
    }`,
    sourceHostLabel: sourceHosts.length > 0 ? sourceHosts.join(', ') : 'no public sources',
    freshnessLabel: freshnessLabel(candidate),
    cannotKnowLabels: candidate.freshness.cannotKnow.map((item) => truncateText(item, 260)),
    evidenceRefs,
    memoryRefs,
    sources: buildSources(candidate),
    feedbackActions: buildFeedbackActions(candidate),
    delivery: params.decision,
    directChatHook: params.decision.chatHook.text,
    expandedSummaryLabel: truncateText(
      `${candidate.summary} ${candidate.whyForOperator} ${candidate.noveltyReason}`,
      700,
    ),
  };
}

export function buildAoiProactiveBriefPanelModel(
  input: BuildAoiProactiveBriefPanelModelInput,
): AoiProactiveBriefPanelModel {
  const context = input.context ?? {};
  const decisions = input.candidates.map((candidate) => ({
    candidate,
    decision: decideAoiProactiveBriefDelivery({
      candidate,
      policy: input.policy,
      profile: input.profile,
      feedback: input.feedback,
      cooldownState: input.cooldownState,
      context,
    }),
  }));
  const cards = decisions
    .filter((item) => input.includeHidden || item.decision.compactCardVisible)
    .sort(
      (left, right) =>
        Number(right.decision.inlineCardVisible) - Number(left.decision.inlineCardVisible) ||
        right.decision.deliveryScore - left.decision.deliveryScore ||
        right.candidate.updatedAt - left.candidate.updatedAt,
    )
    .slice(0, MAX_CARD_COUNT)
    .map(buildCard);
  const hiddenCount = decisions.filter((item) => !item.decision.compactCardVisible).length;
  const inlineCard = cards.find((card) => card.delivery.inlineCardVisible);
  const chatHook = cards.find((card) => card.delivery.chatHook.allowed)?.directChatHook;
  const evidenceRefs = uniqueLabels(
    cards.flatMap((card) => card.evidenceRefs),
    16,
  );

  return {
    visible: cards.length > 0,
    statusLabel:
      cards.length > 0
        ? `${cards.length} proactive interest brief${cards.length === 1 ? '' : 's'}`
        : 'No proactive interest briefs',
    hiddenLabel:
      hiddenCount > 0
        ? `${hiddenCount} candidate${hiddenCount === 1 ? '' : 's'} hidden by policy`
        : '',
    cards,
    ...(inlineCard ? { inlineCard } : {}),
    ...(chatHook ? { chatHook } : {}),
    evidenceRefs,
  };
}
