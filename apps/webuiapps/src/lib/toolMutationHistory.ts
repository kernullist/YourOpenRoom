import { getSessionPath } from './sessionPath';

export interface FileMutationRecord {
  id: string;
  kind: 'file';
  tool_name: 'file_write' | 'file_patch' | 'file_delete' | 'undo_last_action';
  file_path: string;
  before_content: string | null;
  after_content: string | null;
  created_at: number;
}

export type MutationRecord = FileMutationRecord;

const MAX_HISTORY_ITEMS = 30;

function getHistoryKey(sessionPath: string): string {
  return `openroom-tool-history:${sessionPath || 'global'}`;
}

function loadHistory(sessionPath: string): MutationRecord[] {
  try {
    const raw = localStorage.getItem(getHistoryKey(sessionPath));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MutationRecord[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(sessionPath: string, history: MutationRecord[]): void {
  try {
    localStorage.setItem(getHistoryKey(sessionPath), JSON.stringify(history.slice(-MAX_HISTORY_ITEMS)));
  } catch {
    // ignore persistence failures
  }
}

export function recordFileMutation(data: Omit<FileMutationRecord, 'id' | 'kind' | 'created_at'>): void {
  const sessionPath = getSessionPath();
  const history = loadHistory(sessionPath);
  history.push({
    id: `mutation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'file',
    created_at: Date.now(),
    ...data,
  });
  saveHistory(sessionPath, history);
}

export function popLastMutation(): MutationRecord | null {
  const sessionPath = getSessionPath();
  const history = loadHistory(sessionPath);
  const last = history.pop() ?? null;
  saveHistory(sessionPath, history);
  return last;
}

export function listRecentMutations(): MutationRecord[] {
  return [...loadHistory(getSessionPath())].reverse();
}

export function clearMutationHistory(): void {
  try {
    localStorage.removeItem(getHistoryKey(getSessionPath()));
  } catch {
    // ignore
  }
}
