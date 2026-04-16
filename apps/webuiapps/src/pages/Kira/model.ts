export type KiraTaskStatus = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done';
export type KiraTaskKind = 'work';

export interface WorkTask {
  id: string;
  type: 'work';
  projectName: string;
  title: string;
  description: string;
  status: KiraTaskStatus;
  assignee: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskComment {
  id: string;
  taskId: string;
  taskType: 'work';
  author: string;
  body: string;
  createdAt: number;
}

export interface KiraViewState {
  selectedTaskId: string | null;
  activeProjectName: string | null;
  previewMode: boolean;
}

export const STATUS_ORDER: KiraTaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'blocked'];

export const DEFAULT_VIEW_STATE: KiraViewState = {
  selectedTaskId: null,
  activeProjectName: null,
  previewMode: false,
};

function isStatus(value: unknown): value is KiraTaskStatus {
  return typeof value === 'string' && STATUS_ORDER.includes(value as KiraTaskStatus);
}

function parseRecord<T>(raw: unknown): T | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    return JSON.parse(raw) as T;
  }
  return raw as T;
}

export function normalizeWorkTask(raw: unknown): WorkTask | null {
  const parsed = parseRecord<Partial<WorkTask>>(raw);
  if (!parsed?.id) return null;

  const now = Date.now();

  return {
    id: parsed.id,
    type: 'work',
    projectName: parsed.projectName?.trim() || '',
    title: parsed.title?.trim() || 'Untitled work',
    description: parsed.description ?? '',
    status: isStatus(parsed.status) ? parsed.status : 'todo',
    assignee: parsed.assignee ?? '',
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : now,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : now,
  };
}

export function normalizeTaskComment(raw: unknown): TaskComment | null {
  const parsed = parseRecord<Partial<TaskComment>>(raw);
  if (!parsed?.id || !parsed.taskId || !parsed.body) return null;

  return {
    id: parsed.id,
    taskId: parsed.taskId,
    taskType: 'work',
    author: parsed.author?.trim() || 'Operator',
    body: parsed.body.trim(),
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
  };
}

export function getWorkFilePath(workId: string): string {
  return `/works/${workId}.json`;
}

export function getCommentFilePath(commentId: string): string {
  return `/comments/${commentId}.json`;
}

export function sortByUpdatedAtDesc<T extends { updatedAt: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function sortByCreatedAtAsc<T extends { createdAt: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.createdAt - b.createdAt);
}

export function sortByCreatedAtDesc<T extends { createdAt: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}

export function buildExcerpt(text: string, maxLength = 140): string {
  const plain = text
    .replace(/[#>*`~_\-\[\]\(\)!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!plain) return '';
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}...` : plain;
}

export function matchesProjectName(
  taskProjectName: string | null | undefined,
  activeProjectName: string | null,
): boolean {
  if (!activeProjectName) return true;
  return !taskProjectName || taskProjectName === activeProjectName;
}

export function groupWorksByStatus(works: WorkTask[]): Record<KiraTaskStatus, WorkTask[]> {
  return STATUS_ORDER.reduce(
    (acc, status) => {
      acc[status] = works.filter((work) => work.status === status);
      return acc;
    },
    {
      todo: [] as WorkTask[],
      in_progress: [] as WorkTask[],
      in_review: [] as WorkTask[],
      blocked: [] as WorkTask[],
      done: [] as WorkTask[],
    },
  );
}

export function formatTimestamp(timestamp: number, language: string): string {
  const locale = language.startsWith('zh') ? 'zh-CN' : 'en-US';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}
