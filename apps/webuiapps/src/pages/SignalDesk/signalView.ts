import {
  SIGNAL_CATEGORIES,
  type SignalBriefDoc,
  type SignalItem,
  type SignalSourceOutcome,
} from '@/lib/signalDeskShared';
import { SEEN_IDS_CAP, type CategoryFilter } from './types';

// Pure view helpers for the desk. No I/O, no react — everything here is
// covered directly by vitest.

export const CATEGORY_FILTERS: CategoryFilter[] = ['all', ...SIGNAL_CATEGORIES];

export const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: '전체',
  vuln: '취약점',
  msrc: 'MSRC',
  research: '리서치',
  paper: '논문',
  release: '릴리스',
  ai: 'AI 모델',
  harness: '하네스',
};

export function filterSignals(items: SignalItem[], category: CategoryFilter): SignalItem[] {
  if (category === 'all') {
    return items;
  }
  return items.filter((item) => item.category === category);
}

export function markSeen(seenIds: string[], id: string, cap = SEEN_IDS_CAP): string[] {
  if (seenIds.includes(id)) {
    return seenIds;
  }
  const next = [...seenIds, id];
  if (next.length > cap) {
    return next.slice(next.length - cap);
  }
  return next;
}

/** An unparseable timestamp reads as unknown, never as "just now". */
export function formatRelativeTime(nowMs: number, iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return '시각 불명';
  }
  const diff = nowMs - parsed;
  if (diff < 60_000) {
    return '방금';
  }
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) {
    return `${minutes}분 전`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}시간 전`;
  }
  const days = Math.floor(hours / 24);
  if (days <= 30) {
    return `${days}일 전`;
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

/** "Live" data that is ten minutes old should say so. */
export function formatCacheAge(
  nowMs: number,
  fetchedAt: number,
  cache: 'fresh' | 'cached',
): string {
  const age = formatRelativeTime(nowMs, new Date(fetchedAt).toISOString());
  return cache === 'cached' ? `수집 ${age} · 캐시` : `수집 ${age}`;
}

export interface OutcomeSummary {
  total: number;
  okCount: number;
  failedNames: string[];
}

export function summarizeOutcomes(sources: SignalSourceOutcome[]): OutcomeSummary {
  const failedNames = sources.filter((source) => !source.ok).map((source) => source.name);
  return {
    total: sources.length,
    okCount: sources.length - failedNames.length,
    failedNames,
  };
}

/** The research request carries everything AoiResearch needs to run alone. */
export function composeResearchRequest(item: SignalItem): string {
  const lines = [`Deep dive: ${item.title}`, `원문: ${item.url}`];
  if (item.cveIds.length > 0) {
    lines.push(`CVE: ${item.cveIds.join(', ')}`);
  }
  if (item.summary) {
    lines.push(`요약: ${item.summary}`);
  }
  lines.push(
    '요청: 실제 악용 정황, 영향 범위, 근본 원인, 탐지·대응 관점(Windows 커널/안티치트 엔지니어 시각)을 정리해줘.',
  );
  return lines.join('\n');
}

export function briefFilePath(date: string): string {
  return `/briefs/${date}.json`;
}

export function isBriefFileName(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.json$/.test(name);
}

export function briefNameToDate(name: string): string {
  return name.replace(/\.json$/, '');
}

/**
 * Defensive parse for a saved brief. readFile content may be a string or an
 * already-parsed object depending on the storage backend; anything that does
 * not carry the required fields comes back null (rendered as a format error,
 * not as an empty brief).
 */
export function parseBriefDoc(raw: unknown): SignalBriefDoc | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return null;
  }
  if (typeof record.date !== 'string' || typeof record.headline !== 'string') {
    return null;
  }
  if (!Array.isArray(record.sections) || !Array.isArray(record.caveats)) {
    return null;
  }
  return record as unknown as SignalBriefDoc;
}
