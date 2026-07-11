import { loadAoiActiveGoals } from './aoiAutonomyGoals';
import { loadAoiMissionState } from './aoiAutonomyMission';
import {
  loadAoiActiveProposals,
  loadAoiFollowThroughLearningSummary,
  loadAoiProposalDecisions,
  normalizeAoiAutonomySessionPath,
  upsertAoiOpportunity,
  type AoiOpportunityUpsertInput,
  type AoiOpportunityUpsertResult,
} from './aoiAutonomyStore';
import type {
  AoiAutonomyRisk,
  AoiGoal,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiKiraOutcomeEvent,
  AoiMissionState,
  AoiOpportunityDeliveryRecommendation,
  AoiOpportunitySourceKind,
  AoiFollowThroughLearningSummary,
  AoiProactiveTrendAdvisorState,
  AoiProposal,
  AoiProposalDecision,
  AoiProposalFeedbackCategory,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';
import { scoreAoiFollowThroughLearningForKey } from './aoiFollowThroughLearning';
import { selectRelevantAoiMemoriesByEmbedding } from './aoiMemoryEmbedding';
import { loadActiveAoiMemoriesViaIndex } from './aoiMemoryIndex';
import {
  redactAoiSensitiveContent,
  stripAoiSourceInstructions,
  type AoiMemoryEntry,
} from './aoiMemoryShared';
import { loadAoiInterestProfile } from './aoiProactiveBriefStore';
import { listAoiResearchRunSummaries } from './aoiResearchPlugin';
import type { AoiResearchRunSummary } from './aoiResearchTypes';
import { loadAoiWorkspaceSnapshot } from './aoiWorkspaceSignals';

const CURIOUS_GENERATED_BY_REF = 'generated_by:curiosity_engine';
const CURIOUS_VERSION_REF = 'curiosity_engine:v1';
const CURIOUS_DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CURIOUS_STALE_RESEARCH_MS = 21 * 24 * 60 * 60 * 1000;
const CURIOUS_STALE_TOPIC_MS = 14 * 24 * 60 * 60 * 1000;
const CURIOUS_STALE_PROPOSAL_MS = 3 * 24 * 60 * 60 * 1000;
const CURIOUS_MAX_EVIDENCE_REFS = 16;

const PRIVATE_MEMORY_TAGS = new Set([
  'private',
  'private-sensitive',
  'sensitive',
  'secret',
  'credential',
  'credentials',
  'api-key',
  'access-token',
  'token',
]);

const NEGATIVE_FEEDBACK = new Set<AoiProposalFeedbackCategory>([
  'not_useful',
  'wrong_memory',
  'wrong_evidence',
  'wrong_source',
  'stale',
  'too_frequent',
  'too_much',
  'wrong_timing',
  'unsafe',
  'already_done',
]);

const STRONG_NEGATIVE_FEEDBACK = new Set<AoiProposalFeedbackCategory>([
  'too_frequent',
  'too_much',
  'unsafe',
  'already_done',
]);

export type AoiCuriositySignalKind =
  | 'interest'
  | 'memory'
  | 'research'
  | 'kira'
  | 'workspace'
  | 'agenda'
  | 'app_state';

export interface AoiCuriosityCandidateRank {
  interestAlignment: number;
  novelty: number;
  staleness: number;
  actionability: number;
  sourceQuality: number;
  riskAdjustment: number;
  feedbackFactor: number;
  score: number;
}

export interface AoiCuriosityOpportunityCandidate {
  version: 1;
  sessionPath: string;
  signalKind: AoiCuriositySignalKind;
  sourceKind: AoiOpportunitySourceKind;
  title: string;
  curiosityQuestion: string;
  whyNow: string;
  evidenceNeed: string;
  suggestedNextAction: string;
  risk: AoiAutonomyRisk;
  confidence: number;
  urgency: number;
  novelty: number;
  deliveryRecommendation: AoiOpportunityDeliveryRecommendation;
  evidenceRefs: string[];
  dedupeKey: string;
  cooldownKey: string;
  cannotKnow: string[];
  sourceRefs: string[];
  rank: AoiCuriosityCandidateRank;
  createdAt: number;
  expiresAt: number;
}

export interface AoiCuriositySuppressedCandidate {
  dedupeKey: string;
  title: string;
  reason: 'duplicate' | 'active_proposal' | 'cooldown';
  keptTitle?: string;
  evidenceRefs: string[];
}

export interface AoiCuriosityEngineInput {
  sessionPath: string;
  now?: number;
  memories?: readonly AoiMemoryEntry[];
  // Optional focus query (the mission focus, falling back to the latest user
  // message) used to rank dormant high-importance memories before they are
  // surfaced as curiosity opportunities. Absent/empty -> load-order selection
  // (unchanged). `focusQueryEmbedding` adds the semantic signal when present.
  focusQuery?: string;
  focusQueryEmbedding?: number[] | null;
  focusQueryEmbeddingModel?: string | null;
  interestProfile?: AoiInterestProfile | null;
  researchRuns?: readonly AoiResearchRunSummary[];
  workspaceSnapshot?: AoiWorkspaceSnapshot | null;
  activeProposals?: readonly AoiProposal[];
  recentDecisions?: readonly AoiProposalDecision[];
  activeGoals?: readonly AoiGoal[];
  mission?: AoiMissionState | null;
  kiraOutcomes?: readonly AoiKiraOutcomeEvent[];
  proactiveTrendAdvisor?: AoiProactiveTrendAdvisorState | null;
  followThroughLearning?: AoiFollowThroughLearningSummary | null;
  maxCandidates?: number;
}

export interface AoiCuriosityEngineResult {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  candidates: AoiCuriosityOpportunityCandidate[];
  suppressed: AoiCuriositySuppressedCandidate[];
  evidenceRefs: string[];
}

export interface AoiCuriosityRunForSessionInput extends AoiCuriosityEngineInput {
  sessionsDir: string;
}

export interface AoiCuriosityRunForSessionResult extends AoiCuriosityEngineResult {
  upserted: AoiOpportunityUpsertResult[];
  createdCount: number;
  updatedCount: number;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function sanitizeText(value: string | undefined, maxChars: number): string {
  const normalized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value ?? ''))
      .replace(/(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g, '[redacted-path]')
      .replace(/\b\/(?:Users|home|var|tmp|mnt)\/[^\s'"`<>|]+/gi, '[redacted-path]')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]'),
  );
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1).trimEnd()}...`;
}

function normalizeKey(value: string): string {
  return (
    normalizeWhitespace(value)
      .toLowerCase()
      .replace(/[^a-z0-9가-힣._:-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'item'
  );
}

function uniqueStrings(values: readonly (string | undefined | null)[], limit: number): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = sanitizeText(value ?? '', 180);
    if (!normalized) {
      continue;
    }
    seen.add(normalized);
    if (seen.size >= limit) {
      break;
    }
  }
  return [...seen];
}

function ageRatio(now: number, timestamp: number | undefined, staleAfterMs: number): number {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return 1;
  }
  return clamp01((now - timestamp) / staleAfterMs);
}

function riskAdjustment(risk: AoiAutonomyRisk): number {
  if (risk === 'high') {
    return 0.25;
  }
  if (risk === 'medium') {
    return 0.65;
  }
  return 1;
}

function sourceKindForSignal(signalKind: AoiCuriositySignalKind): AoiOpportunitySourceKind {
  if (signalKind === 'memory') {
    return 'memory';
  }
  if (signalKind === 'interest') {
    return 'interest';
  }
  if (signalKind === 'research') {
    return 'research';
  }
  if (signalKind === 'kira') {
    return 'kira';
  }
  if (signalKind === 'workspace') {
    return 'workspace';
  }
  if (signalKind === 'app_state') {
    return 'app_state';
  }
  return 'agenda';
}

function memoryIsPrivateGated(memory: AoiMemoryEntry): boolean {
  return memory.tags.some((tag) => PRIVATE_MEMORY_TAGS.has(tag.toLowerCase()));
}

function privateMemoryIds(memories: readonly AoiMemoryEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const memory of memories) {
    if (memoryIsPrivateGated(memory)) {
      ids.add(memory.id);
    }
  }
  return ids;
}

function topicUsesPrivateSource(topic: AoiInterestTopic, privateIds: Set<string>): boolean {
  return (
    topic.memoryIds.some((id) => privateIds.has(id)) ||
    topic.evidenceRefs.some((ref) => /(?:private|sensitive|secret|credential)/i.test(ref))
  );
}

function feedbackFactor(
  cooldownKey: string,
  recentDecisions: readonly AoiProposalDecision[],
  now: number,
  followThroughLearning?: AoiFollowThroughLearningSummary | null,
): { factor: number; suppressed: boolean; refs: string[] } {
  let factor = 1;
  let suppressed = false;
  const refs: string[] = [];
  const normalizedCooldown = normalizeKey(cooldownKey);
  for (const decision of recentDecisions.slice(0, 40)) {
    const age = now - decision.createdAt;
    if (age > 30 * 24 * 60 * 60 * 1000) {
      continue;
    }
    const decisionKey = normalizeKey(decision.cooldownKey || decision.proposalTrigger || '');
    const related =
      decisionKey === normalizedCooldown ||
      normalizedCooldown.includes(decisionKey) ||
      decisionKey.includes(normalizedCooldown);
    if (!related) {
      continue;
    }
    refs.push(`decision:${decision.id}`);
    if (decision.action === 'accept' || decision.feedbackCategory === 'useful') {
      factor = Math.max(factor, 1.12);
      continue;
    }
    if (decision.feedbackCategory && STRONG_NEGATIVE_FEEDBACK.has(decision.feedbackCategory)) {
      factor = Math.min(factor, 0.35);
      suppressed = true;
      continue;
    }
    if (
      decision.action === 'dismiss' ||
      decision.action === 'block' ||
      (decision.feedbackCategory && NEGATIVE_FEEDBACK.has(decision.feedbackCategory))
    ) {
      factor = Math.min(factor, 0.62);
    }
  }
  const learning = scoreAoiFollowThroughLearningForKey(cooldownKey, followThroughLearning, now);
  factor = Math.max(0.1, Math.min(1.25, factor * learning.rankingFactor));
  suppressed ||= learning.suppressed;
  refs.push(...learning.evidenceRefs);
  return { factor, suppressed, refs: uniqueStrings(refs, 4) };
}

function scoreRank(params: {
  interestAlignment: number;
  novelty: number;
  staleness: number;
  actionability: number;
  sourceQuality: number;
  risk: AoiAutonomyRisk;
  feedbackFactor: number;
}): AoiCuriosityCandidateRank {
  const base =
    clamp01(params.interestAlignment) * 0.24 +
    clamp01(params.novelty) * 0.18 +
    clamp01(params.staleness) * 0.18 +
    clamp01(params.actionability) * 0.18 +
    clamp01(params.sourceQuality) * 0.14 +
    riskAdjustment(params.risk) * 0.08;
  const factor = Math.max(0.1, Math.min(1.25, params.feedbackFactor));
  return {
    interestAlignment: clamp01(params.interestAlignment),
    novelty: clamp01(params.novelty),
    staleness: clamp01(params.staleness),
    actionability: clamp01(params.actionability),
    sourceQuality: clamp01(params.sourceQuality),
    riskAdjustment: riskAdjustment(params.risk),
    feedbackFactor: factor,
    score: clamp01(base * factor),
  };
}

function makeCandidate(params: {
  sessionPath: string;
  now: number;
  signalKind: AoiCuriositySignalKind;
  title: string;
  curiosityQuestion: string;
  whyNow: string;
  evidenceNeed: string;
  suggestedNextAction: string;
  risk: AoiAutonomyRisk;
  urgency: number;
  novelty: number;
  deliveryRecommendation?: AoiOpportunityDeliveryRecommendation;
  dedupeKey: string;
  cooldownKey: string;
  evidenceRefs: readonly string[];
  sourceRefs?: readonly string[];
  cannotKnow?: readonly string[];
  rank: Omit<AoiCuriosityCandidateRank, 'score' | 'riskAdjustment' | 'feedbackFactor'>;
  feedback: { factor: number; refs: string[] };
}): AoiCuriosityOpportunityCandidate {
  const cannotKnow = uniqueStrings(params.cannotKnow ?? [], 6);
  const evidenceRefs = uniqueStrings(
    [
      CURIOUS_GENERATED_BY_REF,
      CURIOUS_VERSION_REF,
      `curiosity:signal:${params.signalKind}`,
      ...params.evidenceRefs,
      ...cannotKnow.map((item) => `cannot_know:${normalizeKey(item)}`),
      ...params.feedback.refs,
    ],
    CURIOUS_MAX_EVIDENCE_REFS,
  );
  const rank = scoreRank({
    ...params.rank,
    risk: params.risk,
    feedbackFactor: params.feedback.factor,
  });
  return {
    version: 1,
    sessionPath: params.sessionPath,
    signalKind: params.signalKind,
    sourceKind: sourceKindForSignal(params.signalKind),
    title: sanitizeText(params.title, 160),
    curiosityQuestion: sanitizeText(params.curiosityQuestion, 240),
    whyNow: sanitizeText(params.whyNow, 300),
    evidenceNeed: sanitizeText(params.evidenceNeed, 300),
    suggestedNextAction: sanitizeText(params.suggestedNextAction, 260),
    risk: params.risk,
    confidence: rank.score,
    urgency: clamp01(params.urgency),
    novelty: clamp01(params.novelty),
    deliveryRecommendation: params.deliveryRecommendation ?? 'dashboard',
    evidenceRefs,
    dedupeKey: `curiosity:${params.dedupeKey}`,
    cooldownKey: params.cooldownKey,
    cannotKnow,
    sourceRefs: uniqueStrings(params.sourceRefs ?? params.evidenceRefs, 12),
    rank,
    createdAt: params.now,
    expiresAt: params.now + CURIOUS_DEFAULT_TTL_MS,
  };
}

function buildInterestCandidates(input: {
  sessionPath: string;
  now: number;
  profile?: AoiInterestProfile | null;
  memories: readonly AoiMemoryEntry[];
  recentDecisions: readonly AoiProposalDecision[];
  followThroughLearning?: AoiFollowThroughLearningSummary | null;
}): AoiCuriosityOpportunityCandidate[] {
  const profile = input.profile;
  if (!profile || profile.topics.length === 0) {
    return [];
  }
  const privateIds = privateMemoryIds(input.memories);
  const topics = [...profile.topics]
    .filter((topic) => !topic.muted && topic.confidence >= 0.35)
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        right.importance - left.importance ||
        right.currentInfoPreference - left.currentInfoPreference ||
        right.confidence - left.confidence,
    )
    .slice(0, 6);

  return topics.map((topic) => {
    const label = sanitizeText(topic.label, 80) || 'this interest';
    const privateGated = topicUsesPrivateSource(topic, privateIds);
    const cannotKnow = privateGated
      ? ['private source body withheld; use metadata only until explicitly allowed']
      : [];
    const cooldownKey = topic.cooldownKey || `interest:${topic.normalizedLabel || topic.id}`;
    const feedback = feedbackFactor(
      cooldownKey,
      input.recentDecisions,
      input.now,
      input.followThroughLearning,
    );
    return makeCandidate({
      sessionPath: input.sessionPath,
      now: input.now,
      signalKind: 'interest',
      title: `Watch ${label} for useful changes`,
      curiosityQuestion: `Is there a fresh ${label} change that would affect current work?`,
      whyNow: topic.pinned
        ? `${label} is pinned in the interest profile and current-info preference is ${Math.round(
            topic.currentInfoPreference * 100,
          )}%.`
        : `${label} is a high-confidence interest from Aoi memory and preference signals.`,
      evidenceNeed: privateGated
        ? 'Need public, explicitly allowed, or fresh research evidence; private memory bodies are withheld.'
        : 'Need fresh public sources, a recent Aoi Research artifact, or workspace evidence before taking action.',
      suggestedNextAction:
        'Keep this as a dashboard opportunity and prepare an evidence plan before starting research or Kira work.',
      risk: 'low',
      urgency: 0.3 + topic.currentInfoPreference * 0.35 + (topic.pinned ? 0.15 : 0),
      novelty: topic.noveltyPreference,
      dedupeKey: `interest:${normalizeKey(topic.normalizedLabel || topic.label)}`,
      cooldownKey,
      evidenceRefs: [
        `interest_topic:${topic.id}`,
        ...topic.memoryIds.map((id) => `memory:${id}`),
        ...topic.evidenceRefs,
      ],
      sourceRefs: [`interest_topic:${topic.id}`, ...topic.memoryIds.map((id) => `memory:${id}`)],
      cannotKnow,
      rank: {
        interestAlignment: (topic.confidence + topic.importance) / 2,
        novelty: topic.noveltyPreference,
        staleness: Math.max(
          topic.currentInfoPreference,
          ageRatio(input.now, topic.updatedAt || profile.generatedAt, CURIOUS_STALE_TOPIC_MS),
        ),
        actionability: privateGated ? 0.45 : 0.7,
        sourceQuality: privateGated ? 0.45 : 0.74,
      },
      feedback,
    });
  });
}

function buildMemoryCandidates(input: {
  sessionPath: string;
  now: number;
  memories: readonly AoiMemoryEntry[];
  recentDecisions: readonly AoiProposalDecision[];
  followThroughLearning?: AoiFollowThroughLearningSummary | null;
  focusQuery?: string;
  focusQueryEmbedding?: number[] | null;
  focusQueryEmbeddingModel?: string | null;
}): AoiCuriosityOpportunityCandidate[] {
  const candidates: AoiCuriosityOpportunityCandidate[] = [];
  const focusQuery = (input.focusQuery ?? '').trim();
  // With a focus query, rank the eligible (active, high-importance) memories by
  // fused lexical+semantic relevance so the most focus-relevant dormant memories
  // surface as opportunities -- a semantic paraphrase can now be recalled. With
  // no focus query, keep the prior load-order pre-filter exactly.
  const pool = focusQuery
    ? selectRelevantAoiMemoriesByEmbedding(
        input.memories.filter((memory) => memory.status === 'active' && memory.importance >= 0.7),
        focusQuery,
        {
          queryEmbedding: input.focusQueryEmbedding ?? null,
          queryEmbeddingModel: input.focusQueryEmbeddingModel ?? null,
          limit: 16,
        },
      )
    : input.memories.slice(0, 16);
  for (const memory of pool) {
    if (memory.status !== 'active' || memory.importance < 0.7) {
      continue;
    }
    const privateGated = memoryIsPrivateGated(memory);
    const metadataLabel = privateGated
      ? memory.tags.find((tag) => !PRIVATE_MEMORY_TAGS.has(tag.toLowerCase())) || memory.type
      : memory.entities[0] ||
        memory.tags.find((tag) => !PRIVATE_MEMORY_TAGS.has(tag.toLowerCase())) ||
        memory.type;
    const signalLabel = sanitizeText(metadataLabel, 80);
    if (!signalLabel) {
      continue;
    }
    const cooldownKey = `memory:${normalizeKey(signalLabel)}`;
    const feedback = feedbackFactor(
      cooldownKey,
      input.recentDecisions,
      input.now,
      input.followThroughLearning,
    );
    candidates.push(
      makeCandidate({
        sessionPath: input.sessionPath,
        now: input.now,
        signalKind: 'memory',
        title: privateGated
          ? `Clarify private-gated memory signal for ${signalLabel}`
          : `Revisit remembered signal for ${signalLabel}`,
        curiosityQuestion: privateGated
          ? `Is there non-private evidence that should update the ${signalLabel} memory signal?`
          : `Does the remembered ${signalLabel} signal still imply a useful next step?`,
        whyNow: `A high-importance active memory has not been converted into a current opportunity.`,
        evidenceNeed: privateGated
          ? 'Need metadata-only confirmation or explicit permission; private memory body is withheld.'
          : 'Need current workspace, research, or user-visible evidence before changing any plan.',
        suggestedNextAction:
          'Keep this visible as a read-only reminder and ask for evidence before turning it into a proposal.',
        risk: privateGated ? 'medium' : 'low',
        urgency: memory.importance * 0.45,
        novelty: memory.confidence,
        dedupeKey: `memory:${normalizeKey(signalLabel)}`,
        cooldownKey,
        evidenceRefs: [`memory:${memory.id}`, ...memory.tags.map((tag) => `memory_tag:${tag}`)],
        sourceRefs: [`memory:${memory.id}`],
        cannotKnow: privateGated
          ? ['private memory body withheld; only tags, ids, and metadata were used']
          : [],
        rank: {
          interestAlignment: memory.importance,
          novelty: memory.confidence,
          staleness: ageRatio(input.now, memory.updatedAt, CURIOUS_STALE_TOPIC_MS),
          actionability: privateGated ? 0.35 : 0.55,
          sourceQuality: privateGated ? 0.35 : 0.65,
        },
        feedback,
      }),
    );
    if (candidates.length >= 3) {
      break;
    }
  }
  return candidates;
}

function researchArtifactMissing(run: AoiResearchRunSummary): string[] {
  const availability = run.artifactAvailability;
  if (!availability) {
    return ['research artifact availability unknown'];
  }
  const missing: string[] = [];
  if (!availability.report) {
    missing.push('research report artifact missing');
  }
  if (!availability.sources) {
    missing.push('research source artifact missing');
  }
  if (!availability.evidence) {
    missing.push('research evidence artifact missing');
  }
  return missing;
}

function buildResearchCandidates(input: {
  sessionPath: string;
  now: number;
  runs: readonly AoiResearchRunSummary[];
  recentDecisions: readonly AoiProposalDecision[];
  followThroughLearning?: AoiFollowThroughLearningSummary | null;
}): AoiCuriosityOpportunityCandidate[] {
  return input.runs
    .filter((run) => run.sessionPath === input.sessionPath)
    .filter((run) => run.status === 'completed' || run.status === 'failed')
    .map((run) => {
      const referenceTime = run.completedAt || run.updatedAt || run.createdAt;
      const stale = input.now - referenceTime > CURIOUS_STALE_RESEARCH_MS;
      const missing = researchArtifactMissing(run);
      const weakSources = run.sourceCounts.accepted < 2 || run.warningCount > 0;
      if (!stale && missing.length === 0 && !weakSources && run.status !== 'failed') {
        return null;
      }
      const titleText = sanitizeText(run.title || run.request, 110) || 'research run';
      const cannotKnow = [
        ...(stale ? ['research result may be stale and needs freshness verification'] : []),
        ...missing,
        ...(run.status === 'failed'
          ? ['research run failed before producing complete evidence']
          : []),
      ];
      const cooldownKey = `research:${normalizeKey(run.request || run.id)}`;
      const feedback = feedbackFactor(
        cooldownKey,
        input.recentDecisions,
        input.now,
        input.followThroughLearning,
      );
      return makeCandidate({
        sessionPath: input.sessionPath,
        now: input.now,
        signalKind: 'research',
        title: `Refresh evidence for ${titleText}`,
        curiosityQuestion: `Is the previous research on "${titleText}" still accurate enough to rely on?`,
        whyNow: stale
          ? `The latest research artifact is older than ${Math.round(
              CURIOUS_STALE_RESEARCH_MS / (24 * 60 * 60 * 1000),
            )} days.`
          : `The research run has incomplete artifacts, warnings, or weak accepted-source coverage.`,
        evidenceNeed:
          cannotKnow.length > 0
            ? `Need fresh verification because ${cannotKnow.join('; ')}.`
            : 'Need a current cited source or verified local artifact before converting this into action.',
        suggestedNextAction:
          'Keep this as a follow-up candidate; do not start a new research run until the user approves.',
        risk: run.status === 'failed' ? 'medium' : 'low',
        urgency: stale ? 0.62 : 0.48,
        novelty: stale ? 0.7 : 0.55,
        dedupeKey: `research:${normalizeKey(run.request || run.title || run.id)}`,
        cooldownKey,
        evidenceRefs: [
          `research:${run.id}`,
          `research_status:${run.status}`,
          ...(run.artifactAvailability?.report ? [`research:${run.id}/report`] : []),
        ],
        sourceRefs: [`research:${run.id}`],
        cannotKnow,
        rank: {
          interestAlignment: 0.62,
          novelty: stale ? 0.7 : 0.5,
          staleness: stale ? 1 : 0.58,
          actionability: 0.68,
          sourceQuality: clamp01(run.sourceCounts.accepted / Math.max(2, run.maxSources)),
        },
        feedback,
      });
    })
    .filter((candidate): candidate is AoiCuriosityOpportunityCandidate => candidate !== null);
}

function buildKiraCandidates(input: {
  sessionPath: string;
  now: number;
  outcomes: readonly AoiKiraOutcomeEvent[];
  recentDecisions: readonly AoiProposalDecision[];
  followThroughLearning?: AoiFollowThroughLearningSummary | null;
}): AoiCuriosityOpportunityCandidate[] {
  return input.outcomes
    .filter((outcome) => outcome.sessionPath === input.sessionPath)
    .filter(
      (outcome) =>
        outcome.kind === 'kira_validation_failed' ||
        outcome.kind === 'kira_review_rejected' ||
        outcome.kind === 'kira_work_blocked' ||
        outcome.validationPassed === false,
    )
    .map((outcome) => {
      const workTitle = sanitizeText(outcome.workTitle || outcome.workRef, 100) || 'Kira work';
      const cooldownKey = `kira:${normalizeKey(outcome.workId || outcome.dedupeKey)}`;
      const feedback = feedbackFactor(
        cooldownKey,
        input.recentDecisions,
        input.now,
        input.followThroughLearning,
      );
      return makeCandidate({
        sessionPath: input.sessionPath,
        now: input.now,
        signalKind: 'kira',
        title: `Review Kira validation failure for ${workTitle}`,
        curiosityQuestion: `What safe recovery path should Aoi prepare for "${workTitle}"?`,
        whyNow: `Kira outcome ${outcome.kind} reports validationPassed=${String(
          outcome.validationPassed,
        )}.`,
        evidenceNeed:
          outcome.validationSummary ||
          'Need validation logs, review notes, and changed-file summary before preparing recovery.',
        suggestedNextAction:
          'Summarize the failure and keep recovery read-only until a user-approved proposal or Kira handoff exists.',
        risk: 'medium',
        urgency: 0.8,
        novelty: 0.66,
        deliveryRecommendation: 'inline_card',
        dedupeKey: `kira:${normalizeKey(outcome.workId || outcome.dedupeKey)}`,
        cooldownKey,
        evidenceRefs: [
          `kira_outcome:${outcome.id}`,
          `kira_work:${outcome.workId}`,
          ...outcome.evidenceRefs,
          ...outcome.reviewerNotes.map((_, index) => `kira_reviewer_note:${outcome.id}:${index}`),
        ],
        sourceRefs: [`kira_outcome:${outcome.id}`, `kira_work:${outcome.workId}`],
        cannotKnow:
          outcome.evidenceRefs.length === 0 ? ['missing Kira validation evidence refs'] : [],
        rank: {
          interestAlignment: 0.72,
          novelty: 0.66,
          staleness: 0.85,
          actionability: 0.78,
          sourceQuality: outcome.evidenceRefs.length > 0 ? 0.8 : 0.45,
        },
        feedback,
      });
    });
}

function buildWorkspaceCandidates(input: {
  sessionPath: string;
  now: number;
  snapshot?: AoiWorkspaceSnapshot | null;
  recentDecisions: readonly AoiProposalDecision[];
  followThroughLearning?: AoiFollowThroughLearningSummary | null;
}): AoiCuriosityOpportunityCandidate[] {
  const snapshot = input.snapshot;
  if (!snapshot) {
    return [];
  }
  const candidates: AoiCuriosityOpportunityCandidate[] = [];
  const validationNeedsAttention =
    snapshot.validation.result === 'failed' ||
    snapshot.validation.freshness === 'stale' ||
    snapshot.validation.freshness === 'failed' ||
    snapshot.freshness === 'stale' ||
    snapshot.freshness === 'failed';
  if (validationNeedsAttention) {
    const cooldownKey = 'workspace:validation';
    const feedback = feedbackFactor(
      cooldownKey,
      input.recentDecisions,
      input.now,
      input.followThroughLearning,
    );
    candidates.push(
      makeCandidate({
        sessionPath: input.sessionPath,
        now: input.now,
        signalKind: 'workspace',
        title: 'Check stale or failed workspace validation',
        curiosityQuestion: 'Is the current workspace validation signal safe enough to rely on?',
        whyNow: `Workspace validation is ${snapshot.validation.result}/${snapshot.validation.freshness}.`,
        evidenceNeed:
          snapshot.validation.staleReason ||
          'Need a fresh validation command result before proposing project changes.',
        suggestedNextAction:
          'Keep this as a dashboard warning and ask for validation evidence before any mutation.',
        risk: snapshot.validation.result === 'failed' ? 'medium' : 'low',
        urgency: snapshot.validation.result === 'failed' ? 0.75 : 0.52,
        novelty: 0.52,
        dedupeKey: 'workspace:validation',
        cooldownKey,
        evidenceRefs: [
          `workspace_snapshot:${snapshot.collectedAt}`,
          ...snapshot.validation.evidenceRefs,
          ...snapshot.evidenceRefs,
        ],
        sourceRefs: [`workspace_snapshot:${snapshot.collectedAt}`],
        cannotKnow:
          snapshot.validation.freshness === 'stale'
            ? ['workspace validation is stale and cannot prove current correctness']
            : [],
        rank: {
          interestAlignment: 0.58,
          novelty: 0.52,
          staleness: snapshot.validation.result === 'failed' ? 0.9 : 0.75,
          actionability: 0.72,
          sourceQuality: snapshot.validation.evidenceRefs.length > 0 ? 0.72 : 0.45,
        },
        feedback,
      }),
    );
  }
  if (snapshot.git?.isDirty && snapshot.git.changedFileCount > 0) {
    const cooldownKey = 'workspace:dirty-git';
    const feedback = feedbackFactor(
      cooldownKey,
      input.recentDecisions,
      input.now,
      input.followThroughLearning,
    );
    candidates.push(
      makeCandidate({
        sessionPath: input.sessionPath,
        now: input.now,
        signalKind: 'workspace',
        title: 'Review uncommitted workspace changes',
        curiosityQuestion:
          'Do uncommitted files imply a follow-up, validation, or commit checkpoint?',
        whyNow: `Git reports ${snapshot.git.changedFileCount} changed file(s) on ${snapshot.git.branchName}.`,
        evidenceNeed:
          'Need a user-visible diff summary and validation status before recommending action.',
        suggestedNextAction:
          'Keep this as a non-mutating reminder; do not stage, commit, or run commands from curiosity alone.',
        risk: 'low',
        urgency: Math.min(0.75, 0.35 + snapshot.git.changedFileCount * 0.05),
        novelty: 0.45,
        dedupeKey: 'workspace:dirty-git',
        cooldownKey,
        evidenceRefs: [`workspace_git:${snapshot.collectedAt}`, ...snapshot.evidenceRefs],
        sourceRefs: [`workspace_snapshot:${snapshot.collectedAt}`],
        rank: {
          interestAlignment: 0.5,
          novelty: 0.45,
          staleness: 0.56,
          actionability: 0.66,
          sourceQuality: 0.7,
        },
        feedback,
      }),
    );
  }
  return candidates;
}

function buildAgendaCandidates(input: {
  sessionPath: string;
  now: number;
  activeGoals: readonly AoiGoal[];
  mission?: AoiMissionState | null;
  activeProposals: readonly AoiProposal[];
  recentDecisions: readonly AoiProposalDecision[];
  followThroughLearning?: AoiFollowThroughLearningSummary | null;
}): AoiCuriosityOpportunityCandidate[] {
  const candidates: AoiCuriosityOpportunityCandidate[] = [];
  for (const goal of input.activeGoals.filter((item) => item.status === 'blocked').slice(0, 2)) {
    const cooldownKey = `goal:${goal.id}`;
    const feedback = feedbackFactor(
      cooldownKey,
      input.recentDecisions,
      input.now,
      input.followThroughLearning,
    );
    candidates.push(
      makeCandidate({
        sessionPath: input.sessionPath,
        now: input.now,
        signalKind: 'agenda',
        title: `Unblock goal: ${goal.title}`,
        curiosityQuestion: 'What evidence or user decision would unblock this active goal?',
        whyNow: `The goal is blocked and still present in Aoi active goals.`,
        evidenceNeed: 'Need the blocker, latest plan-step evidence, and user approval boundary.',
        suggestedNextAction:
          'Show the blocker in the dashboard and ask for the smallest missing decision before acting.',
        risk: goal.risk,
        urgency: 0.7,
        novelty: 0.5,
        dedupeKey: `goal:${goal.id}`,
        cooldownKey,
        evidenceRefs: [`goal:${goal.id}`, ...goal.sourceRefs, ...goal.plan.sourceRefs],
        sourceRefs: [`goal:${goal.id}`],
        rank: {
          interestAlignment: goal.confidence,
          novelty: 0.5,
          staleness: ageRatio(input.now, goal.updatedAt, CURIOUS_STALE_PROPOSAL_MS),
          actionability: 0.72,
          sourceQuality: goal.sourceRefs.length > 0 ? 0.72 : 0.46,
        },
        feedback,
      }),
    );
  }

  const mission = input.mission;
  if (mission && (mission.status === 'blocked' || mission.waitingOn !== 'none')) {
    const cooldownKey = `mission:${mission.status}:${mission.waitingOn}`;
    const feedback = feedbackFactor(
      cooldownKey,
      input.recentDecisions,
      input.now,
      input.followThroughLearning,
    );
    candidates.push(
      makeCandidate({
        sessionPath: input.sessionPath,
        now: input.now,
        signalKind: 'agenda',
        title: `Resolve current mission state: ${mission.status}`,
        curiosityQuestion: 'What should Aoi keep tracking while the mission is waiting or blocked?',
        whyNow: mission.blockedReason || mission.nextRecommendedAction.reason,
        evidenceNeed:
          'Need latest mission refs, active goal state, and user decision before escalating.',
        suggestedNextAction:
          'Keep this as a dashboard opportunity and surface the next recommended action only.',
        risk: 'low',
        urgency: mission.status === 'blocked' ? 0.72 : 0.52,
        novelty: 0.45,
        dedupeKey: cooldownKey,
        cooldownKey,
        evidenceRefs: [
          `mission:${mission.status}`,
          ...mission.evidenceRefs,
          ...Object.values(mission.sourceRefs).map((ref) => `mission_ref:${ref}`),
        ],
        sourceRefs: [`mission:${mission.status}`],
        rank: {
          interestAlignment: 0.55,
          novelty: 0.45,
          staleness: ageRatio(input.now, mission.updatedAt, CURIOUS_STALE_PROPOSAL_MS),
          actionability: 0.62,
          sourceQuality: mission.evidenceRefs.length > 0 ? 0.7 : 0.42,
        },
        feedback,
      }),
    );
  }

  for (const proposal of input.activeProposals.slice(0, 4)) {
    if (input.now - proposal.updatedAt < CURIOUS_STALE_PROPOSAL_MS) {
      continue;
    }
    const cooldownKey = `proposal:${proposal.id}`;
    const feedback = feedbackFactor(
      cooldownKey,
      input.recentDecisions,
      input.now,
      input.followThroughLearning,
    );
    candidates.push(
      makeCandidate({
        sessionPath: input.sessionPath,
        now: input.now,
        signalKind: 'agenda',
        title: `Follow up stale proposal: ${proposal.title}`,
        curiosityQuestion: 'Should Aoi keep, snooze, or archive this stale proposal?',
        whyNow: 'An active proposal has not changed for several days.',
        evidenceNeed: 'Need the last user decision and current relevance before interrupting.',
        suggestedNextAction:
          'Keep it dashboard-only and ask for operator feedback if it still matters.',
        risk: proposal.risk,
        urgency: 0.42,
        novelty: 0.35,
        dedupeKey: `proposal:${proposal.id}`,
        cooldownKey,
        evidenceRefs: [`proposal:${proposal.id}`, ...proposal.evidenceRefs],
        sourceRefs: [`proposal:${proposal.id}`],
        rank: {
          interestAlignment: proposal.confidence,
          novelty: 0.35,
          staleness: ageRatio(input.now, proposal.updatedAt, CURIOUS_STALE_PROPOSAL_MS),
          actionability: 0.58,
          sourceQuality: proposal.evidenceRefs.length > 0 ? 0.7 : 0.4,
        },
        feedback,
      }),
    );
  }
  return candidates;
}

function buildAppStateCandidates(input: {
  sessionPath: string;
  now: number;
  advisor?: AoiProactiveTrendAdvisorState | null;
  recentDecisions: readonly AoiProposalDecision[];
  followThroughLearning?: AoiFollowThroughLearningSummary | null;
}): AoiCuriosityOpportunityCandidate[] {
  const advisor = input.advisor;
  if (!advisor) {
    return [];
  }
  const reasons = [
    ...advisor.deliveryControlBlockedReasons,
    ...advisor.readiness.directChatBlockedReasons,
  ];
  const hasBlockedDelivery = reasons.length > 0 || advisor.readiness.status === 'blocked';
  const hasPreparedCard = Boolean(advisor.inlineCard || advisor.directChatCard);
  if (!hasBlockedDelivery && !hasPreparedCard) {
    return [];
  }
  const card = advisor.inlineCard || advisor.directChatCard;
  const cooldownKey = `app_state:trend-advisor:${normalizeKey(card?.topicLabel || 'delivery')}`;
  const feedback = feedbackFactor(
    cooldownKey,
    input.recentDecisions,
    input.now,
    input.followThroughLearning,
  );
  return [
    makeCandidate({
      sessionPath: input.sessionPath,
      now: input.now,
      signalKind: 'app_state',
      title: card
        ? `Review held proactive trend card: ${card.title}`
        : 'Review proactive trend delivery controls',
      curiosityQuestion:
        'Is Aoi holding a useful proactive trend because delivery controls blocked it?',
      whyNow:
        reasons[0] ||
        advisor.readiness.summary ||
        'The proactive trend advisor has a prepared card or blocked delivery state.',
      evidenceNeed:
        'Need source quality, freshness, interest drift, and interruption budget evidence before direct chat.',
      suggestedNextAction:
        'Keep this in the dashboard; do not escalate delivery until the interruption governor allows it.',
      risk: 'low',
      urgency: hasPreparedCard ? 0.58 : 0.4,
      novelty: card ? 0.62 : 0.38,
      dedupeKey: cooldownKey,
      cooldownKey,
      evidenceRefs: [
        `trend_advisor:${advisor.generatedAt}`,
        ...advisor.evidenceRefs,
        ...advisor.readiness.evidenceRefs,
        ...(card?.evidenceRefs ?? []),
      ],
      sourceRefs: [`trend_advisor:${advisor.generatedAt}`],
      cannotKnow:
        advisor.readiness.status === 'not_configured'
          ? ['trend advisor is not configured for fresh source gathering']
          : [],
      rank: {
        interestAlignment: 0.58,
        novelty: card ? 0.62 : 0.38,
        staleness: advisor.readiness.status === 'blocked' ? 0.75 : 0.46,
        actionability: 0.5,
        sourceQuality: card ? 0.7 : 0.48,
      },
      feedback,
    }),
  ];
}

function suppressByActiveProposal(
  candidates: AoiCuriosityOpportunityCandidate[],
  activeProposals: readonly AoiProposal[],
): {
  candidates: AoiCuriosityOpportunityCandidate[];
  suppressed: AoiCuriositySuppressedCandidate[];
} {
  const suppressed: AoiCuriositySuppressedCandidate[] = [];
  const kept: AoiCuriosityOpportunityCandidate[] = [];
  for (const candidate of candidates) {
    const candidateKey = normalizeKey(
      `${candidate.title} ${candidate.curiosityQuestion} ${candidate.cooldownKey}`,
    );
    const related = activeProposals.find((proposal) => {
      const proposalKey = normalizeKey(
        `${proposal.title} ${proposal.trigger} ${proposal.cooldownKey}`,
      );
      return (
        proposal.cooldownKey === candidate.cooldownKey ||
        candidateKey.includes(proposalKey) ||
        proposalKey.includes(candidateKey)
      );
    });
    if (related) {
      suppressed.push({
        dedupeKey: candidate.dedupeKey,
        title: candidate.title,
        reason: 'active_proposal',
        keptTitle: related.title,
        evidenceRefs: uniqueStrings([...candidate.evidenceRefs, `proposal:${related.id}`], 8),
      });
      continue;
    }
    kept.push(candidate);
  }
  return { candidates: kept, suppressed };
}

function dedupeCandidates(candidates: readonly AoiCuriosityOpportunityCandidate[]): {
  candidates: AoiCuriosityOpportunityCandidate[];
  suppressed: AoiCuriositySuppressedCandidate[];
} {
  const byKey = new Map<string, AoiCuriosityOpportunityCandidate>();
  const suppressed: AoiCuriositySuppressedCandidate[] = [];
  for (const candidate of candidates) {
    const existing = byKey.get(candidate.dedupeKey);
    if (!existing) {
      byKey.set(candidate.dedupeKey, candidate);
      continue;
    }
    const keep = candidate.rank.score > existing.rank.score ? candidate : existing;
    const drop = keep === candidate ? existing : candidate;
    byKey.set(candidate.dedupeKey, keep);
    suppressed.push({
      dedupeKey: drop.dedupeKey,
      title: drop.title,
      reason: 'duplicate',
      keptTitle: keep.title,
      evidenceRefs: drop.evidenceRefs,
    });
  }
  return { candidates: [...byKey.values()], suppressed };
}

export function buildAoiCuriosityCandidates(
  input: AoiCuriosityEngineInput,
): AoiCuriosityEngineResult {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? Date.now();
  const memories = input.memories ?? [];
  const recentDecisions = input.recentDecisions ?? [];
  const candidates = [
    ...buildInterestCandidates({
      sessionPath,
      now,
      profile: input.interestProfile,
      memories,
      recentDecisions,
      followThroughLearning: input.followThroughLearning,
    }),
    ...buildMemoryCandidates({
      sessionPath,
      now,
      memories,
      recentDecisions,
      followThroughLearning: input.followThroughLearning,
      ...(input.focusQuery ? { focusQuery: input.focusQuery } : {}),
      focusQueryEmbedding: input.focusQueryEmbedding ?? null,
      focusQueryEmbeddingModel: input.focusQueryEmbeddingModel ?? null,
    }),
    ...buildResearchCandidates({
      sessionPath,
      now,
      runs: input.researchRuns ?? [],
      recentDecisions,
      followThroughLearning: input.followThroughLearning,
    }),
    ...buildKiraCandidates({
      sessionPath,
      now,
      outcomes: input.kiraOutcomes ?? [],
      recentDecisions,
      followThroughLearning: input.followThroughLearning,
    }),
    ...buildWorkspaceCandidates({
      sessionPath,
      now,
      snapshot: input.workspaceSnapshot,
      recentDecisions,
      followThroughLearning: input.followThroughLearning,
    }),
    ...buildAgendaCandidates({
      sessionPath,
      now,
      activeGoals: input.activeGoals ?? [],
      mission: input.mission,
      activeProposals: input.activeProposals ?? [],
      recentDecisions,
      followThroughLearning: input.followThroughLearning,
    }),
    ...buildAppStateCandidates({
      sessionPath,
      now,
      advisor: input.proactiveTrendAdvisor,
      recentDecisions,
      followThroughLearning: input.followThroughLearning,
    }),
  ];
  const deduped = dedupeCandidates(candidates);
  const withoutActiveProposal = suppressByActiveProposal(
    deduped.candidates,
    input.activeProposals ?? [],
  );
  const maxCandidates = Math.max(1, Math.min(12, Math.trunc(input.maxCandidates ?? 6)));
  const ranked = withoutActiveProposal.candidates
    .sort(
      (left, right) =>
        right.rank.score - left.rank.score ||
        right.urgency - left.urgency ||
        left.dedupeKey.localeCompare(right.dedupeKey),
    )
    .slice(0, maxCandidates);
  const evidenceRefs = uniqueStrings(
    [
      CURIOUS_GENERATED_BY_REF,
      CURIOUS_VERSION_REF,
      ...ranked.flatMap((candidate) => candidate.evidenceRefs),
      ...deduped.suppressed.flatMap((candidate) => candidate.evidenceRefs),
      ...withoutActiveProposal.suppressed.flatMap((candidate) => candidate.evidenceRefs),
    ],
    CURIOUS_MAX_EVIDENCE_REFS,
  );
  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    candidates: ranked,
    suppressed: [...deduped.suppressed, ...withoutActiveProposal.suppressed],
    evidenceRefs,
  };
}

export function toAoiOpportunityUpsertInput(
  candidate: AoiCuriosityOpportunityCandidate,
): AoiOpportunityUpsertInput {
  return {
    sourceKind: candidate.sourceKind,
    title: candidate.title,
    curiosityQuestion: candidate.curiosityQuestion,
    whyNow: candidate.whyNow,
    evidenceNeed: candidate.evidenceNeed,
    suggestedNextAction: candidate.suggestedNextAction,
    risk: candidate.risk,
    confidence: candidate.confidence,
    urgency: candidate.urgency,
    novelty: candidate.novelty,
    deliveryRecommendation: candidate.deliveryRecommendation,
    status: 'active',
    evidenceRefs: candidate.evidenceRefs,
    dedupeKey: candidate.dedupeKey,
    createdAt: candidate.createdAt,
    expiresAt: candidate.expiresAt,
  };
}

export function runAoiCuriosityEngineForSession(
  input: AoiCuriosityRunForSessionInput,
): AoiCuriosityRunForSessionResult {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? Date.now();
  const memories =
    input.memories ??
    loadActiveAoiMemoriesViaIndex(input.sessionsDir).filter(
      (memory) =>
        memory.status === 'active' && (!memory.sessionPath || memory.sessionPath === sessionPath),
    );
  const profile =
    input.interestProfile === undefined
      ? loadAoiInterestProfile(input.sessionsDir, sessionPath, now)
      : input.interestProfile;
  const researchRuns =
    input.researchRuns ?? listAoiResearchRunSummaries(input.sessionsDir, sessionPath);
  const activeProposals =
    input.activeProposals ?? loadAoiActiveProposals(input.sessionsDir, sessionPath);
  const recentDecisions =
    input.recentDecisions ?? loadAoiProposalDecisions(input.sessionsDir, sessionPath);
  const activeGoals = input.activeGoals ?? loadAoiActiveGoals(input.sessionsDir, sessionPath);
  const mission =
    input.mission === undefined
      ? loadAoiMissionState(input.sessionsDir, sessionPath)
      : input.mission;
  const workspaceSnapshot =
    input.workspaceSnapshot === undefined
      ? loadAoiWorkspaceSnapshot(input.sessionsDir, sessionPath, now)
      : input.workspaceSnapshot;
  const followThroughLearning =
    input.followThroughLearning === undefined
      ? loadAoiFollowThroughLearningSummary(input.sessionsDir, sessionPath, now)
      : input.followThroughLearning;
  const result = buildAoiCuriosityCandidates({
    sessionPath,
    now,
    memories,
    ...(input.focusQuery ? { focusQuery: input.focusQuery } : {}),
    focusQueryEmbedding: input.focusQueryEmbedding ?? null,
    focusQueryEmbeddingModel: input.focusQueryEmbeddingModel ?? null,
    interestProfile: profile,
    researchRuns,
    workspaceSnapshot,
    activeProposals,
    recentDecisions,
    activeGoals,
    mission,
    kiraOutcomes: input.kiraOutcomes,
    proactiveTrendAdvisor: input.proactiveTrendAdvisor,
    followThroughLearning,
    maxCandidates: input.maxCandidates,
  });
  const upserted = result.candidates.map((candidate) =>
    upsertAoiOpportunity(
      input.sessionsDir,
      sessionPath,
      toAoiOpportunityUpsertInput(candidate),
      now,
    ),
  );
  return {
    ...result,
    upserted,
    createdCount: upserted.filter((item) => item.created).length,
    updatedCount: upserted.filter((item) => !item.created).length,
  };
}
