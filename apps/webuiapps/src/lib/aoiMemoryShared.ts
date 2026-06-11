const MAX_MEMORY_CONTENT_CHARS = 360;

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

export function truncateAoiMemoryContent(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= MAX_MEMORY_CONTENT_CHARS) return normalized;
  return normalized.slice(0, MAX_MEMORY_CONTENT_CHARS - 1).trimEnd() + '...';
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
    const tags = [...baseTags, 'completed'];
    if (typeof context?.reviewApproved === 'boolean') {
      tags.push('reviewed');
      if (context.reviewApproved) {
        tags.push('review-approved');
      }
    }
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
        type: 'action',
        content: buildCompletedKiraMemoryContent(title, projectName, context),
        importance: 0.76,
        confidence: 0.82,
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
