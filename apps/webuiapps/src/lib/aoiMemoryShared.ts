const MAX_MEMORY_CONTENT_CHARS = 360;
const REDACTED_SECRET = '[redacted_secret]';

export type AoiMemoryScope = 'user' | 'agent' | 'session' | 'project';
export type AoiMemoryType =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'event'
  | 'procedure'
  | 'action'
  | 'emotion';
export type AoiMemoryStatus = 'active' | 'superseded' | 'archived';
export type AoiMemoryEpisodeSource =
  | 'chat_turn'
  | 'direct_action'
  | 'manual_memory'
  | 'kira_automation'
  | 'research_run';

// Coarse origin category for the unified memory ledger (P4-d): the three streams
// the roadmap unifies -- conversation ('chat'), Kira automation ('automation'),
// and research runs ('research'). This maps the finer 5-way episode source onto
// the queryable ledger dimension (chat_turn/direct_action/manual_memory -> chat).
export type AoiMemorySourceCategory = 'chat' | 'automation' | 'research';

export interface AoiMemoryEntry {
  version: 2;
  id: string;
  scope: AoiMemoryScope;
  type: AoiMemoryType;
  status: AoiMemoryStatus;
  content: string;
  normalizedContent: string;
  importance: number;
  confidence: number;
  hits: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
  expiresAt?: number;
  permanent?: boolean;
  sourceEpisodeIds: string[];
  supersedes?: string[];
  sessionPath?: string;
  projectKey?: string;
  tags: string[];
  entities: string[];
  // Optional semantic embedding of `content` for vector recall. Best-effort:
  // absent when no embedding provider ran, in which case scoring stays lexical.
  embedding?: number[];
  // The embedding model id that produced `embedding`. Recall fuses the semantic
  // score only when this matches the query's embedding model (model-change safety).
  embeddingModel?: string;
}

export interface AoiMemoryEpisode {
  version: 1;
  id: string;
  sessionPath: string;
  source: AoiMemoryEpisodeSource;
  userMessage: string;
  assistantMessage: string;
  toolCalls: string[];
  createdAt: number;
  outcome?: string;
}

export interface AoiMemoryCandidate {
  scope?: AoiMemoryScope;
  type: AoiMemoryType;
  content: string;
  importance?: number;
  confidence?: number;
  projectKey?: string;
  tags?: string[];
  entities?: string[];
  expiresAt?: number;
  permanent?: boolean;
}

export interface AoiKiraAutomationEvent {
  id: string;
  workId: string;
  title: string;
  projectName: string;
  message: string;
  createdAt: number;
  type: 'started' | 'resumed' | 'completed' | 'needs_attention' | 'steered' | 'interrupted';
}

export interface AoiKiraAutomationMemoryContext {
  attemptNo?: number;
  attemptStatus?: string;
  changedFiles?: string[];
  validationPassedCount?: number;
  validationFailedCount?: number;
  integrationStatus?: string;
  commitHash?: string;
  pullRequestUrl?: string;
  connectorStatuses?: string[];
  reviewApproved?: boolean;
  reviewSummary?: string;
  reviewFindingCount?: number;
  missingValidationCount?: number;
  reviewEvidenceFiles?: string[];
  residualRiskCount?: number;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function containsAoiSensitiveContent(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i.test(value) ||
    /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_=-]{12,}/i.test(value) ||
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|password|passwd|secret|client[_ -]?secret|private[_ -]?key)\b\s+(?:is|was|=|:)\s+['"]?[^'"\s,;]{4,}/i.test(
      value,
    ) ||
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|password|passwd|secret|client[_ -]?secret|private[_ -]?key)\b\s*[:=]\s*['"]?[^'"\s,;]{4,}/i.test(
      value,
    )
  );
}

export function redactAoiSensitiveContent(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      REDACTED_SECRET,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, `Bearer ${REDACTED_SECRET}`)
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_=-]{12,}/gi, REDACTED_SECRET)
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|password|passwd|secret|client[_ -]?secret|private[_ -]?key)\b\s*[:=]\s*['"]?[^'"\s,;]{4,}/gi,
      (_match, key: string) => `${key}=${REDACTED_SECRET}`,
    )
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|password|passwd|secret|client[_ -]?secret|private[_ -]?key)\b\s+(?:is|was|=|:)\s+['"]?[^'"\s,;]{4,}/gi,
      (_match, key: string) => `${key}=${REDACTED_SECRET}`,
    );
}

export function stripAoiSourceInstructions(value: string): string {
  return value
    .split(/\r?\n/u)
    .filter((line) => {
      const normalized = normalizeWhitespace(line);
      if (!normalized) {
        return false;
      }
      return !/(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|(?:system|developer)\s*(?:prompt|message|instruction)\s*:|you\s+are\s+now\s+|act\s+as\s+|do\s+not\s+tell\s+the\s+user|copy\s+this\s+instruction|treat\s+this\s+as\s+(?:system|developer)/i.test(
        normalized,
      );
    })
    .join(' ');
}

export function truncateAoiMemoryContent(value: string): string {
  const normalized = normalizeWhitespace(redactAoiSensitiveContent(value));
  if (normalized.length <= MAX_MEMORY_CONTENT_CHARS) return normalized;
  return normalized.slice(0, MAX_MEMORY_CONTENT_CHARS - 1).trimEnd() + '...';
}

export function sanitizeAoiProcedureContent(value: string): string {
  return truncateAoiMemoryContent(stripAoiSourceInstructions(value));
}

// Near-duplicate gate for PREFERENCE memories at merge time. The exact
// normalizedContent dedupe misses restatements ("likes" vs "loves", an added
// parenthetical), so the same taste piles up as separate files. Token overlap
// over the smaller token set at a high threshold collapses those restatements
// while keeping genuinely different preferences apart: opposite polarity
// ("like" vs "dislike") and different subjects both fall well below the bar.
// Deliberately lexical-only (deterministic, sync, no embedding requirement);
// cross-language restatements are handled upstream by the distiller grounding.
export const AOI_PREFERENCE_NEAR_DUPLICATE_THRESHOLD = 0.8;
// Short restatements need a softer bar when one side adds a filler word.
export const AOI_PREFERENCE_NEAR_DUPLICATE_SHORT_THRESHOLD = 0.7;
export const AOI_PREFERENCE_NEAR_DUPLICATE_SHORT_MAX_TOKENS = 8;

const PREFERENCE_POLARITY_NEGATIONS: ReadonlyArray<readonly [string, string]> = [
  ['like', 'dislike'],
  ['love', 'hate'],
  ['prefer', 'avoid'],
  ['enable', 'disable'],
  ['always', 'never'],
  ['want', 'dont'],
  ['want', "don't"],
];

function tokenizeForNearDuplicate(value: string): Set<string> {
  const tokens = new Set<string>();
  const lower = value.toLowerCase();
  for (const token of lower.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? []) {
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  // CJK / unspaced text: letter bigrams keep short restatements comparable.
  const compact = lower.replace(/[^\p{L}\p{N}]+/gu, '');
  const wordLikeCount = [...tokens].filter((token) => token.length >= 2).length;
  if (compact.length >= 4 && wordLikeCount <= 4) {
    for (let index = 0; index < compact.length - 1; index += 1) {
      tokens.add(compact.slice(index, index + 2));
    }
  }
  return tokens;
}

function extractPrefKeys(tags: readonly string[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const tag of tags ?? []) {
    const match = /^pref:([a-z0-9._-]{2,64})$/i.exec(tag.trim());
    if (match) {
      keys.add(match[1].toLowerCase());
    }
  }
  return keys;
}

function hasOppositePreferencePolarity(left: string, right: string): boolean {
  const leftLower = left.toLowerCase();
  const rightLower = right.toLowerCase();
  for (const [positive, negative] of PREFERENCE_POLARITY_NEGATIONS) {
    const leftPos = leftLower.includes(positive);
    const leftNeg = leftLower.includes(negative);
    const rightPos = rightLower.includes(positive);
    const rightNeg = rightLower.includes(negative);
    if ((leftPos && rightNeg) || (leftNeg && rightPos)) {
      return true;
    }
  }
  return false;
}

export function isAoiPreferenceNearDuplicateContent(
  left: string,
  right: string,
  options?: { leftTags?: readonly string[]; rightTags?: readonly string[] },
): boolean {
  // Same pref: key always merges, even when wording diverges.
  const leftKeys = extractPrefKeys(options?.leftTags);
  const rightKeys = extractPrefKeys(options?.rightTags);
  for (const key of leftKeys) {
    if (rightKeys.has(key)) {
      return true;
    }
  }

  if (hasOppositePreferencePolarity(left, right)) {
    return false;
  }

  const leftTokens = tokenizeForNearDuplicate(left);
  const rightTokens = tokenizeForNearDuplicate(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return false;
  }
  let matches = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      matches += 1;
    }
  }
  const minSize = Math.max(1, Math.min(leftTokens.size, rightTokens.size));
  const score = matches / minSize;
  const shortPair =
    leftTokens.size <= AOI_PREFERENCE_NEAR_DUPLICATE_SHORT_MAX_TOKENS &&
    rightTokens.size <= AOI_PREFERENCE_NEAR_DUPLICATE_SHORT_MAX_TOKENS;
  const threshold = shortPair
    ? AOI_PREFERENCE_NEAR_DUPLICATE_SHORT_THRESHOLD
    : AOI_PREFERENCE_NEAR_DUPLICATE_THRESHOLD;
  if (score >= threshold) {
    return true;
  }
  // Containment: one restatement fully includes the other content tokens.
  if (matches === minSize && minSize >= 3) {
    return true;
  }

  // Compact letter/digit character overlap for short unspaced restatements
  // (common in Korean preference phrases without spaces).
  const leftCompact = left.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const rightCompact = right.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (leftCompact.length >= 4 && rightCompact.length >= 4) {
    const leftChars = new Set([...leftCompact]);
    const rightChars = new Set([...rightCompact]);
    let charMatches = 0;
    leftChars.forEach((ch) => {
      if (rightChars.has(ch)) {
        charMatches += 1;
      }
    });
    const charMin = Math.max(1, Math.min(leftChars.size, rightChars.size));
    if (charMatches / charMin >= 0.85 && Math.abs(leftCompact.length - rightCompact.length) <= 4) {
      return true;
    }
  }
  return false;
}

export function sanitizeAoiStoragePart(value: string): string {
  return (
    normalizeWhitespace(value)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 96) || 'item'
  );
}

export function normalizeAoiSessionPathForStorage(value: string): string {
  const parts = normalizeWhitespace(value)
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, '_'))
    .filter((part) => part && part !== '.' && part !== '..');
  return parts.length > 0 ? parts.join('/') : 'default';
}

export function normalizeAoiProjectKey(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return sanitizeAoiStoragePart(value.trim().toLowerCase());
}

export function makeAoiKiraAutomationEpisodeId(eventId: string): string {
  return `aoi_kira_${sanitizeAoiStoragePart(eventId)}`;
}

export function makeAoiResearchRunEpisodeId(runId: string): string {
  return `aoi_research_${sanitizeAoiStoragePart(runId)}`;
}

// Derive the coarse origin category(ies) of a memory from its episode ids + tags,
// centralising the prefix/tag heuristic that was previously inlined (e.g. the
// browser's isExternalAutomationMemory). A memory can carry episodes from several
// sources (reinforcement / consolidation), so this returns the SET of categories
// present (membership semantics -- matches the existing `.some` checks). Structurally
// typed so both the server and browser AoiMemoryEntry shapes work. The 'automation'
// predicate reproduces isExternalAutomationMemory EXACTLY (tag 'automation' OR the
// aoi_kira_ id prefix) so callers can switch to it byte-identically. 'chat' is the
// default bucket for generic (aoi_ep_ / other) episodes and the fallback so every
// memory carries at least one category.
export function deriveAoiMemorySources(memory: {
  sourceEpisodeIds: string[];
  tags: string[];
}): AoiMemorySourceCategory[] {
  const episodeIds = memory.sourceEpisodeIds ?? [];
  const tags = memory.tags ?? [];
  const categories = new Set<AoiMemorySourceCategory>();
  if (tags.includes('automation') || episodeIds.some((id) => id.startsWith('aoi_kira_'))) {
    categories.add('automation');
  }
  if (tags.includes('research') || episodeIds.some((id) => id.startsWith('aoi_research_'))) {
    categories.add('research');
  }
  const hasGenericEpisode = episodeIds.some(
    (id) => !id.startsWith('aoi_kira_') && !id.startsWith('aoi_research_'),
  );
  if (hasGenericEpisode || categories.size === 0) {
    categories.add('chat');
  }
  return [...categories];
}

function formatAoiCount(label: string, value: number | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${label}=${Math.max(0, Math.round(value))}`;
}

function sanitizeContextText(value: string | undefined, maxChars: number): string | null {
  if (!value?.trim()) return null;
  const normalized = normalizeWhitespace(value).slice(0, maxChars);
  return normalized || null;
}

function sanitizeContextList(values: string[] | undefined, maxItems: number): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = sanitizeContextText(value, 96);
    if (!item) continue;
    seen.add(item);
    if (seen.size >= maxItems) break;
  }
  return [...seen];
}

function buildCompletedKiraMemoryContent(
  title: string,
  projectName: string,
  context: AoiKiraAutomationMemoryContext | undefined,
): string {
  const details: string[] = [];

  if (typeof context?.attemptNo === 'number' && Number.isFinite(context.attemptNo)) {
    const attemptStatus = sanitizeContextText(context.attemptStatus, 32);
    details.push(
      `attempt ${Math.max(0, Math.round(context.attemptNo))}${attemptStatus ? ` ${attemptStatus}` : ''}`,
    );
  }

  const integrationStatus = sanitizeContextText(context?.integrationStatus, 32);
  if (integrationStatus) {
    const commitHash = sanitizeContextText(context?.commitHash, 40);
    const commitSuffix = commitHash ? ` ${commitHash.slice(0, 12)}` : '';
    details.push(`integration ${integrationStatus}${commitSuffix}`);
  }

  const validationCounts = [
    formatAoiCount('passed', context?.validationPassedCount),
    formatAoiCount('failed', context?.validationFailedCount),
  ].filter((item): item is string => Boolean(item));
  if (validationCounts.length > 0) {
    details.push(`validation ${validationCounts.join(' ')}`);
  }

  if (typeof context?.reviewApproved === 'boolean') {
    const reviewCounts = [
      formatAoiCount('findings', context.reviewFindingCount),
      formatAoiCount('missingValidation', context.missingValidationCount),
      formatAoiCount('residualRisk', context.residualRiskCount),
    ].filter((item): item is string => Boolean(item));
    const evidenceFiles = sanitizeContextList(context.reviewEvidenceFiles, 3);
    const reviewParts = [
      context.reviewApproved ? 'approved' : 'not approved',
      ...reviewCounts,
      evidenceFiles.length > 0 ? `evidence ${evidenceFiles.join(', ')}` : null,
    ].filter((item): item is string => Boolean(item));
    details.push(`review ${reviewParts.join(' ')}`);
  }

  const changedFiles = sanitizeContextList(context?.changedFiles, 4);
  if (changedFiles.length > 0) {
    details.push(`files ${changedFiles.join(', ')}`);
  }

  const connectorStatuses = sanitizeContextList(context?.connectorStatuses, 3);
  if (connectorStatuses.length > 0) {
    details.push(`connectors ${connectorStatuses.join(', ')}`);
  }

  if (context?.pullRequestUrl) {
    details.push('PR linked');
  }

  const reviewSummary = sanitizeContextText(context?.reviewSummary, 96);
  if (reviewSummary) {
    details.push(`review summary: ${reviewSummary}`);
  }

  const suffix = details.length > 0 ? ` ${details.join('; ')}.` : '';
  return truncateAoiMemoryContent(
    `Kira completed project work "${title}" for ${projectName}.${suffix}`,
  );
}

export function buildAoiKiraAutomationMemoryCandidates(
  event: AoiKiraAutomationEvent,
  context?: AoiKiraAutomationMemoryContext,
): AoiMemoryCandidate[] {
  const title = truncateAoiMemoryContent(event.title || event.workId || 'Untitled Kira work');
  const projectName = truncateAoiMemoryContent(event.projectName || 'unknown project');
  const message = truncateAoiMemoryContent(event.message);
  const projectKey = normalizeAoiProjectKey(projectName);
  const baseTags = ['kira', 'automation'];
  const entities = [
    projectName,
    title,
    ...sanitizeContextList(context?.changedFiles, 4),
    ...sanitizeContextList(context?.reviewEvidenceFiles, 4),
  ].filter((item) => item.trim());

  if (event.type === 'completed') {
    if (context?.reviewApproved !== true) {
      return [];
    }
    const validationFailed = (context.validationFailedCount ?? 0) > 0;
    const tags = [...baseTags, 'completed'];
    tags.push('reviewed', 'review-approved');
    if (
      typeof context?.validationPassedCount === 'number' ||
      typeof context?.validationFailedCount === 'number'
    ) {
      tags.push('validation');
    }
    if ((context?.validationFailedCount ?? 0) > 0) {
      tags.push('validation-failed');
    }
    const integrationStatus = sanitizeContextText(context?.integrationStatus, 32);
    if (integrationStatus) {
      if (integrationStatus === 'committed') {
        tags.push('committed');
      } else if (integrationStatus === 'integrated') {
        tags.push('integrated');
      } else if (integrationStatus === 'failed') {
        tags.push('integration-failed');
      } else {
        tags.push('integration');
      }
    }
    if (context?.pullRequestUrl) {
      tags.push('pull-request');
    }

    return [
      {
        scope: 'project',
        type: validationFailed ? 'event' : 'action',
        content: buildCompletedKiraMemoryContent(title, projectName, context),
        importance: validationFailed ? 0.68 : 0.76,
        confidence: validationFailed ? 0.72 : 0.82,
        projectKey,
        tags,
        entities,
      },
    ];
  }

  if (event.type === 'needs_attention') {
    return [
      {
        scope: 'project',
        type: 'event',
        content: `Kira needs attention on project work "${title}" for ${projectName}: ${message}`,
        importance: 0.68,
        confidence: 0.66,
        projectKey,
        tags: [...baseTags, 'needs-attention'],
        entities,
      },
    ];
  }

  if (event.type === 'interrupted') {
    return [
      {
        scope: 'project',
        type: 'event',
        content: `Kira work "${title}" for ${projectName} was interrupted before completion.`,
        importance: 0.56,
        confidence: 0.62,
        projectKey,
        tags: [...baseTags, 'interrupted'],
        entities,
      },
    ];
  }

  return [];
}
