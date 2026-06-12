import {
  containsAoiSensitiveContent,
  redactAoiSensitiveContent,
  truncateAoiMemoryContent,
  type AoiMemoryCandidate,
  type AoiMemoryEntry,
} from './aoiMemoryShared';
import type { AoiProposalDecision, AoiProposalFeedbackCategory } from './aoiAutonomyTypes';

export type AoiPreferenceEvidenceKind =
  | 'stable_user_preference'
  | 'project_convention'
  | 'temporary_instruction'
  | 'one_off_correction'
  | 'proposal_negative_feedback'
  | 'safety_policy';

export type AoiPreferenceConflictWinner =
  | 'safety_policy'
  | 'project_convention'
  | 'fresh_instruction'
  | 'durable_preference';

export type AoiPreferenceDemotionReason =
  | 'user_rejected'
  | 'project_convention_conflict'
  | 'stale_evidence'
  | 'safety_policy_conflict'
  | 'expired_temporary';

export interface AoiPreferenceEvidence {
  version: 1;
  id: string;
  kind: AoiPreferenceEvidenceKind;
  text: string;
  normalizedKey: string;
  scope: 'user' | 'project' | 'session';
  projectKey?: string;
  confidence: number;
  sourceRefs: string[];
  createdAt: number;
  expiresAt?: number;
  explicitSave: boolean;
  feedbackCategory?: AoiProposalFeedbackCategory;
  safetyLocked: boolean;
}

export interface AoiPreferenceMemory {
  version: 1;
  id: string;
  text: string;
  normalizedKey: string;
  confidence: number;
  sourceRefs: string[];
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'demoted' | 'archived';
  permanent: boolean;
}

export interface AoiProjectConvention {
  version: 1;
  id: string;
  projectKey: string;
  text: string;
  normalizedKey: string;
  confidence: number;
  sourceRefs: string[];
  updatedAt: number;
}

export interface AoiTemporaryInstruction {
  version: 1;
  id: string;
  text: string;
  normalizedKey: string;
  confidence: number;
  sourceRefs: string[];
  createdAt: number;
  expiresAt: number;
}

export interface AoiPreferenceConflict {
  version: 1;
  normalizedKey: string;
  winner: AoiPreferenceConflictWinner;
  winningRef: string;
  losingRefs: string[];
  explanation: string;
  evidenceRefs: string[];
}

export interface AoiPreferenceDemotion {
  version: 1;
  memoryId: string;
  reason: AoiPreferenceDemotionReason;
  confidenceBefore: number;
  confidenceAfter: number;
  evidenceRefs: string[];
  createdAt: number;
}

export interface AoiSafetyPreferenceRule {
  id: string;
  normalizedKey: string;
  text: string;
  evidenceRefs?: string[];
}

export interface AoiResolvedPreference {
  ref: string;
  kind: AoiPreferenceConflictWinner;
  normalizedKey: string;
  text: string;
  confidence: number;
  sourceRefs: string[];
}

export interface AoiPreferenceResolution {
  version: 1;
  active: AoiResolvedPreference[];
  conflicts: AoiPreferenceConflict[];
  demotions: AoiPreferenceDemotion[];
  promptBlock: string;
}

const DEFAULT_TEMPORARY_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_EVIDENCE_MS = 180 * 24 * 60 * 60 * 1000;
const PROMOTION_MIN_CONSISTENT_EVIDENCE = 2;
const MAX_PREFERENCE_PROMPT_CHARS = 720;

const NEGATIVE_FEEDBACK = new Set<AoiProposalFeedbackCategory>([
  'not_useful',
  'wrong_memory',
  'wrong_evidence',
  'stale',
  'too_frequent',
  'too_much',
  'wrong_timing',
  'unsafe',
]);

function clampScore(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeProjectKey(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_')
    .slice(0, 96);
}

function sanitizePreferenceText(value: string): string {
  return truncateAoiMemoryContent(redactAoiSensitiveContent(value));
}

function stableId(prefix: string, text: string, now: number): string {
  let hash = 0x811c9dc5;
  const input = `${prefix}:${text}:${now}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-${now.toString(36)}-${hash.toString(16).padStart(8, '0')}`;
}

function normalizeKey(value: string): string {
  const text = normalizeWhitespace(value).toLowerCase();
  const explicit = text.match(/\b(?:pref|preference|convention|rule):([a-z0-9._-]{2,64})\b/i);
  if (explicit?.[1]) {
    return explicit[1].toLowerCase();
  }
  if (/korean|english|language|한국어|영어|언어/.test(text)) {
    return 'response.language';
  }
  if (/tone|style|말투|문체|답변\s*스타일/.test(text)) {
    return 'response.tone';
  }
  if (/commit|커밋|git/.test(text)) {
    return 'workflow.git';
  }
  if (/test|validation|검증|테스트|build/.test(text)) {
    return 'workflow.validation';
  }
  if (/kira|review|리뷰/.test(text)) {
    return 'workflow.kira_review';
  }
  if (/safety|policy|approval|승인|정책|보안/.test(text)) {
    return 'policy.safety';
  }
  const tokens = text
    .replace(/[^a-z0-9가-힣._ -]/gi, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .slice(0, 6);
  return tokens.length > 0 ? tokens.join('.') : 'preference.general';
}

function keyFromMemory(memory: AoiMemoryEntry): string {
  const taggedKey =
    memory.tags.find((tag) => /^(?:pref|preference|convention|rule):/i.test(tag)) ??
    memory.entities.find((entity) => /^(?:pref|preference|convention|rule):/i.test(entity));
  return normalizeKey(taggedKey ?? memory.content);
}

function sourceRefsFromMemory(memory: AoiMemoryEntry): string[] {
  return [
    `memory:${memory.id}`,
    ...memory.sourceEpisodeIds.map((id) => `episode:${id}`),
    ...(memory.projectKey ? [`project:${memory.projectKey}`] : []),
  ].slice(0, 12);
}

function hasTag(memory: AoiMemoryEntry, tag: string): boolean {
  return memory.tags.includes(tag);
}

function isPreferenceMemory(memory: AoiMemoryEntry): boolean {
  return (
    memory.type === 'preference' ||
    memory.type === 'procedure' ||
    hasTag(memory, 'preference') ||
    hasTag(memory, 'instruction') ||
    hasTag(memory, 'project-convention') ||
    hasTag(memory, 'temporary-instruction')
  );
}

function isDemoted(memory: AoiMemoryEntry): boolean {
  return memory.status !== 'active' || hasTag(memory, 'demoted') || hasTag(memory, 'wrong');
}

function oneLine(value: string, maxLength: number): string {
  const text = sanitizePreferenceText(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function classifyByText(text: string, feedbackCategory?: AoiProposalFeedbackCategory) {
  const lower = text.toLowerCase();
  if (feedbackCategory && NEGATIVE_FEEDBACK.has(feedbackCategory)) {
    return feedbackCategory === 'unsafe' ? 'safety_policy' : 'proposal_negative_feedback';
  }
  if (
    /\b(?:bypass|ignore|disable|skip)\s+(?:safety|policy|approval|validation|guardrail)\b/i.test(
      text,
    ) ||
    /(?:승인|정책|검증|보안).*(?:무시|우회|끄|생략)/u.test(text)
  ) {
    return 'safety_policy';
  }
  if (
    /\b(?:for now|temporarily|just this time|this session|today only|for this answer)\b/i.test(
      text,
    ) ||
    /(?:이번만|지금은|임시로|이번\s*세션|오늘만|이번\s*답변)/u.test(text)
  ) {
    return 'temporary_instruction';
  }
  if (
    /\b(?:in this project|for this repo|project convention|repo convention)\b/i.test(text) ||
    /(?:이\s*프로젝트|이\s*레포|프로젝트\s*규칙|컨벤션)/u.test(text)
  ) {
    return 'project_convention';
  }
  if (
    /\b(?:wrong|not that|correction|actually|instead)\b/i.test(text) ||
    /(?:아니|틀렸|그게\s*아니|정정|이번엔)/u.test(text)
  ) {
    return 'one_off_correction';
  }
  if (
    /\b(?:always|never|prefer|by default|from now on|remember|save this)\b/i.test(text) ||
    /(?:항상|절대|선호|기본적으로|앞으로|기억해|저장해)/u.test(text)
  ) {
    return 'stable_user_preference';
  }
  if (/\b(?:prefer|like|dislike)\b/i.test(lower) || /(?:좋아|싫어|선호)/u.test(text)) {
    return 'stable_user_preference';
  }
  return 'one_off_correction';
}

export function classifyAoiPreferenceEvidence(params: {
  text: string;
  sourceRef: string;
  now?: number;
  projectKey?: string;
  explicitSave?: boolean;
  feedbackCategory?: AoiProposalFeedbackCategory;
  confidence?: number;
}): AoiPreferenceEvidence {
  const now = params.now ?? Date.now();
  const text = sanitizePreferenceText(params.text);
  const kind = classifyByText(text, params.feedbackCategory);
  const scope =
    kind === 'project_convention' || params.projectKey
      ? 'project'
      : kind === 'temporary_instruction'
        ? 'session'
        : 'user';
  return {
    version: 1,
    id: stableId('aoi-pref-evidence', `${params.sourceRef}:${text}`, now),
    kind,
    text,
    normalizedKey: normalizeKey(text),
    scope,
    ...(params.projectKey ? { projectKey: params.projectKey } : {}),
    confidence: clampScore(
      params.confidence ??
        (params.explicitSave ? 0.88 : kind === 'one_off_correction' ? 0.42 : 0.7),
      0.7,
    ),
    sourceRefs: [params.sourceRef],
    createdAt: now,
    ...(kind === 'temporary_instruction' ? { expiresAt: now + DEFAULT_TEMPORARY_TTL_MS } : {}),
    explicitSave: params.explicitSave === true,
    ...(params.feedbackCategory ? { feedbackCategory: params.feedbackCategory } : {}),
    safetyLocked: kind === 'safety_policy',
  };
}

export function buildAoiPreferenceMemoryCandidates(params: {
  evidence: AoiPreferenceEvidence[];
  now?: number;
  minConsistentEvidence?: number;
}): AoiMemoryCandidate[] {
  const now = params.now ?? Date.now();
  const minConsistentEvidence = params.minConsistentEvidence ?? PROMOTION_MIN_CONSISTENT_EVIDENCE;
  const groups = new Map<string, AoiPreferenceEvidence[]>();

  for (const item of params.evidence) {
    if (containsAoiSensitiveContent(item.text)) {
      continue;
    }
    if (
      item.kind === 'one_off_correction' ||
      item.kind === 'proposal_negative_feedback' ||
      item.kind === 'safety_policy'
    ) {
      continue;
    }
    const groupKey = `${item.scope}:${item.projectKey ?? ''}:${item.normalizedKey}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), item]);
  }

  const candidates: AoiMemoryCandidate[] = [];
  for (const items of groups.values()) {
    const explicit = items.some((item) => item.explicitSave);
    if (!explicit && items.length < minConsistentEvidence) {
      continue;
    }
    const latest = items.slice().sort((left, right) => right.createdAt - left.createdAt)[0];
    const confidence = clampScore(
      Math.max(...items.map((item) => item.confidence)) + (items.length - 1) * 0.06,
      latest.confidence,
    );
    if (latest.kind === 'temporary_instruction') {
      candidates.push({
        scope: 'session',
        type: 'preference',
        content: latest.text,
        confidence,
        importance: explicit ? 0.72 : 0.58,
        expiresAt: latest.expiresAt ?? now + DEFAULT_TEMPORARY_TTL_MS,
        tags: ['preference', 'temporary-instruction', `pref:${latest.normalizedKey}`],
        entities: [latest.normalizedKey, ...items.flatMap((item) => item.sourceRefs)],
      });
      continue;
    }
    candidates.push({
      scope: latest.kind === 'project_convention' ? 'project' : 'user',
      type: 'preference',
      content: latest.text,
      confidence,
      importance: explicit ? 0.86 : 0.74,
      ...(latest.projectKey ? { projectKey: latest.projectKey } : {}),
      permanent: explicit,
      tags: [
        'preference',
        latest.kind === 'project_convention' ? 'project-convention' : 'durable-preference',
        explicit ? 'explicit-save' : 'repeated-evidence',
        `pref:${latest.normalizedKey}`,
      ],
      entities: [latest.normalizedKey, ...items.flatMap((item) => item.sourceRefs)].slice(0, 10),
    });
  }

  return candidates;
}

export function getAoiPreferenceDemotions(params: {
  memories: AoiMemoryEntry[];
  decisions?: AoiProposalDecision[];
  projectKey?: string;
  now?: number;
}): AoiPreferenceDemotion[] {
  const now = params.now ?? Date.now();
  const demotions: AoiPreferenceDemotion[] = [];
  const activeProjectKey = normalizeProjectKey(params.projectKey);
  const projectKeys = new Set(
    params.memories
      .filter(
        (memory) =>
          memory.scope === 'project' &&
          memory.status === 'active' &&
          (!activeProjectKey || normalizeProjectKey(memory.projectKey) === activeProjectKey),
      )
      .map((memory) => keyFromMemory(memory)),
  );

  for (const memory of params.memories) {
    if (!isPreferenceMemory(memory) || isDemoted(memory)) {
      continue;
    }
    const key = keyFromMemory(memory);
    const evidenceRefs = sourceRefsFromMemory(memory);
    const negativeDecision = params.decisions?.find(
      (decision) =>
        (decision.feedbackCategory === 'wrong_memory' ||
          decision.feedbackCategory === 'stale' ||
          decision.feedbackCategory === 'not_useful') &&
        [
          ...(decision.memoryIds ?? []),
          ...(decision.evidenceRefs ?? []).map((ref) =>
            ref.startsWith('memory:') ? ref.slice('memory:'.length) : ref,
          ),
        ].includes(memory.id),
    );
    if (negativeDecision) {
      demotions.push({
        version: 1,
        memoryId: memory.id,
        reason: negativeDecision.feedbackCategory === 'stale' ? 'stale_evidence' : 'user_rejected',
        confidenceBefore: memory.confidence,
        confidenceAfter: Math.min(0.3, memory.confidence),
        evidenceRefs: [`decision:${negativeDecision.id}`, ...evidenceRefs].slice(0, 12),
        createdAt: now,
      });
      continue;
    }
    if (memory.scope === 'user' && projectKeys.has(key)) {
      demotions.push({
        version: 1,
        memoryId: memory.id,
        reason: 'project_convention_conflict',
        confidenceBefore: memory.confidence,
        confidenceAfter: Math.min(0.42, memory.confidence),
        evidenceRefs,
        createdAt: now,
      });
      continue;
    }
    if (
      !memory.permanent &&
      now - memory.updatedAt > STALE_EVIDENCE_MS &&
      memory.confidence < 0.65
    ) {
      demotions.push({
        version: 1,
        memoryId: memory.id,
        reason: 'stale_evidence',
        confidenceBefore: memory.confidence,
        confidenceAfter: Math.min(0.35, memory.confidence),
        evidenceRefs,
        createdAt: now,
      });
    }
  }

  return demotions;
}

function toUserPreference(memory: AoiMemoryEntry): AoiPreferenceMemory | null {
  if (!isPreferenceMemory(memory)) {
    return null;
  }
  return {
    version: 1,
    id: memory.id,
    text: memory.content,
    normalizedKey: keyFromMemory(memory),
    confidence: memory.confidence,
    sourceRefs: sourceRefsFromMemory(memory),
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    status: isDemoted(memory) ? (memory.status === 'archived' ? 'archived' : 'demoted') : 'active',
    permanent: memory.permanent === true,
  };
}

function toProjectConvention(memory: AoiMemoryEntry): AoiProjectConvention | null {
  if (
    !isPreferenceMemory(memory) ||
    memory.status !== 'active' ||
    (!memory.projectKey && memory.scope !== 'project')
  ) {
    return null;
  }
  return {
    version: 1,
    id: memory.id,
    projectKey: memory.projectKey ?? 'project',
    text: memory.content,
    normalizedKey: keyFromMemory(memory),
    confidence: memory.confidence,
    sourceRefs: sourceRefsFromMemory(memory),
    updatedAt: memory.updatedAt,
  };
}

function toTemporaryInstruction(
  memory: AoiMemoryEntry,
  now: number,
): AoiTemporaryInstruction | null {
  if (
    !isPreferenceMemory(memory) ||
    memory.status !== 'active' ||
    (memory.scope !== 'session' && !hasTag(memory, 'temporary-instruction'))
  ) {
    return null;
  }
  const expiresAt = memory.expiresAt ?? memory.updatedAt + DEFAULT_TEMPORARY_TTL_MS;
  if (expiresAt <= now) {
    return null;
  }
  return {
    version: 1,
    id: memory.id,
    text: memory.content,
    normalizedKey: keyFromMemory(memory),
    confidence: memory.confidence,
    sourceRefs: sourceRefsFromMemory(memory),
    createdAt: memory.createdAt,
    expiresAt,
  };
}

function addWinner(params: {
  winners: Map<string, AoiResolvedPreference>;
  conflicts: AoiPreferenceConflict[];
  candidate: AoiResolvedPreference;
  precedence: number;
  precedenceByKey: Map<string, number>;
  reason: string;
}) {
  const previous = params.winners.get(params.candidate.normalizedKey);
  const previousPrecedence = params.precedenceByKey.get(params.candidate.normalizedKey) ?? -1;
  if (!previous || params.precedence > previousPrecedence) {
    if (previous) {
      params.conflicts.push({
        version: 1,
        normalizedKey: params.candidate.normalizedKey,
        winner: params.candidate.kind,
        winningRef: params.candidate.ref,
        losingRefs: [previous.ref],
        explanation: params.reason,
        evidenceRefs: [...params.candidate.sourceRefs, ...previous.sourceRefs].slice(0, 12),
      });
    }
    params.winners.set(params.candidate.normalizedKey, params.candidate);
    params.precedenceByKey.set(params.candidate.normalizedKey, params.precedence);
    return;
  }
  if (previous.ref !== params.candidate.ref) {
    params.conflicts.push({
      version: 1,
      normalizedKey: params.candidate.normalizedKey,
      winner: previous.kind,
      winningRef: previous.ref,
      losingRefs: [params.candidate.ref],
      explanation: params.reason,
      evidenceRefs: [...previous.sourceRefs, ...params.candidate.sourceRefs].slice(0, 12),
    });
  }
}

export function resolveAoiPreferenceContext(params: {
  memories: AoiMemoryEntry[];
  projectKey?: string;
  temporaryInstructions?: AoiTemporaryInstruction[];
  safetyRules?: AoiSafetyPreferenceRule[];
  decisions?: AoiProposalDecision[];
  now?: number;
  maxPromptChars?: number;
}): AoiPreferenceResolution {
  const now = params.now ?? Date.now();
  const activeProjectKey = normalizeProjectKey(params.projectKey);
  const demotions = getAoiPreferenceDemotions({
    memories: params.memories,
    decisions: params.decisions,
    projectKey: params.projectKey,
    now,
  });
  const demotedIds = new Set(
    demotions
      .filter((demotion) => demotion.reason !== 'project_convention_conflict')
      .map((demotion) => demotion.memoryId),
  );
  const winners = new Map<string, AoiResolvedPreference>();
  const precedenceByKey = new Map<string, number>();
  const conflicts: AoiPreferenceConflict[] = [];
  const activeMemories = params.memories.filter((memory) => !demotedIds.has(memory.id));

  for (const memory of activeMemories) {
    const preference = toUserPreference(memory);
    if (!preference || preference.status !== 'active') {
      continue;
    }
    if (
      memory.scope === 'project' ||
      memory.scope === 'session' ||
      Boolean(memory.projectKey) ||
      hasTag(memory, 'project-convention') ||
      hasTag(memory, 'temporary-instruction')
    ) {
      continue;
    }
    addWinner({
      winners,
      conflicts,
      precedenceByKey,
      precedence: 10,
      reason: 'Durable preference is lower priority than project, fresh, and safety rules.',
      candidate: {
        ref: `memory:${preference.id}`,
        kind: 'durable_preference',
        normalizedKey: preference.normalizedKey,
        text: preference.text,
        confidence: preference.confidence,
        sourceRefs: preference.sourceRefs,
      },
    });
  }

  for (const instruction of [
    ...activeMemories
      .map((memory) => toTemporaryInstruction(memory, now))
      .filter((item): item is AoiTemporaryInstruction => Boolean(item)),
    ...(params.temporaryInstructions ?? []),
  ]) {
    addWinner({
      winners,
      conflicts,
      precedenceByKey,
      precedence: 20,
      reason: 'Fresh session instruction overrides older durable preference in this session.',
      candidate: {
        ref: `temporary:${instruction.id}`,
        kind: 'fresh_instruction',
        normalizedKey: instruction.normalizedKey,
        text: instruction.text,
        confidence: instruction.confidence,
        sourceRefs: instruction.sourceRefs,
      },
    });
  }

  for (const convention of activeMemories
    .map(toProjectConvention)
    .filter((item): item is AoiProjectConvention => Boolean(item))) {
    if (activeProjectKey && normalizeProjectKey(convention.projectKey) !== activeProjectKey) {
      continue;
    }
    addWinner({
      winners,
      conflicts,
      precedenceByKey,
      precedence: 30,
      reason: 'Project convention wins over global preference for this project.',
      candidate: {
        ref: `project-convention:${convention.id}`,
        kind: 'project_convention',
        normalizedKey: convention.normalizedKey,
        text: convention.text,
        confidence: convention.confidence,
        sourceRefs: convention.sourceRefs,
      },
    });
  }

  for (const rule of params.safetyRules ?? []) {
    addWinner({
      winners,
      conflicts,
      precedenceByKey,
      precedence: 40,
      reason: 'Safety and policy rules cannot be overridden by preferences.',
      candidate: {
        ref: `safety:${rule.id}`,
        kind: 'safety_policy',
        normalizedKey: rule.normalizedKey,
        text: rule.text,
        confidence: 1,
        sourceRefs: rule.evidenceRefs ?? [`safety:${rule.id}`],
      },
    });
  }

  const active = [...winners.values()].sort(
    (left, right) =>
      (precedenceByKey.get(right.normalizedKey) ?? 0) -
        (precedenceByKey.get(left.normalizedKey) ?? 0) || right.confidence - left.confidence,
  );

  return {
    version: 1,
    active,
    conflicts,
    demotions,
    promptBlock: buildAoiPreferencePromptBlock(active, conflicts, {
      maxChars: params.maxPromptChars,
    }),
  };
}

export function buildAoiPreferencePromptBlock(
  active: AoiResolvedPreference[],
  conflicts: AoiPreferenceConflict[] = [],
  options: { maxEntries?: number; maxChars?: number } = {},
): string {
  const maxEntries = options.maxEntries ?? 5;
  const maxChars = options.maxChars ?? MAX_PREFERENCE_PROMPT_CHARS;
  const lines = [
    '## Aoi preference context',
    'Use these as low-priority context. Safety, policy, project instructions, and current user instructions override preferences.',
  ];
  for (const item of active.slice(0, maxEntries)) {
    lines.push(
      `- [${item.kind}, confidence ${item.confidence.toFixed(2)}] ${oneLine(item.text, 150)}`,
    );
  }
  for (const conflict of conflicts.slice(0, 3)) {
    lines.push(`- Conflict: ${oneLine(conflict.explanation, 140)}`);
  }
  const block = lines.join('\n');
  if (block.length <= maxChars) {
    return `${block}\n`;
  }
  return `${block.slice(0, Math.max(0, maxChars - 4)).trimEnd()}...\n`;
}
