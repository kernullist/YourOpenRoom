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
  | 'kira_automation';

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

export function buildAoiKiraAutomationMemoryCandidates(
  event: AoiKiraAutomationEvent,
): AoiMemoryCandidate[] {
  const title = truncateAoiMemoryContent(event.title || event.workId || 'Untitled Kira work');
  const projectName = truncateAoiMemoryContent(event.projectName || 'unknown project');
  const message = truncateAoiMemoryContent(event.message);
  const projectKey = normalizeAoiProjectKey(projectName);
  const baseTags = ['kira', 'automation'];
  const entities = [projectName, title].filter((item) => item.trim());

  if (event.type === 'completed') {
    return [
      {
        scope: 'project',
        type: 'action',
        content: `Kira completed project work "${title}" for ${projectName}.`,
        importance: 0.76,
        confidence: 0.82,
        projectKey,
        tags: [...baseTags, 'completed'],
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
