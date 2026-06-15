import * as fs from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';
import type {
  AoiPersonalSignalMetadataSummary,
  AoiPersonalSignalSourceKind,
  AoiSignalFreshness,
} from './aoiAutonomyTypes';

const MAX_JSON_FILES_PER_SOURCE = 120;
const MAX_RECENT_TITLES = 4;
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

interface CalendarEventMetadata {
  id?: string;
  title?: string;
  startAt?: string;
  remindBeforeMinutes?: number;
  completed?: boolean;
  updatedAt?: number;
  lastReminderSentAt?: number;
}

interface CachedEmailMetadata {
  id?: string;
  folder?: string;
  isRead?: boolean;
  labelIds?: string[];
  timestamp?: number;
}

interface GmailStoredConfig {
  clientId?: string;
  refreshToken?: string;
  lastSyncAt?: number;
  historyId?: string;
}

interface GmailConfigFile {
  gmail?: GmailStoredConfig;
}

interface NoteMetadata {
  id?: string;
  title?: string;
  tags?: string[];
  pinned?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

interface AoiPersonalSignalConnectorInput {
  sessionsDir: string;
  sessionPath: string;
  configFile?: string;
  now?: number;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function appDataDir(
  sessionsDir: string,
  sessionPath: string,
  appName: 'calendar' | 'email' | 'notes',
): string | null {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    return null;
  }
  const dataDir = resolve(sessionsDir, normalizedSessionPath, 'apps', appName, 'data');
  if (!isPathInsideRoot(sessionsDir, dataDir)) {
    throw new Error('Resolved personal signal path escaped the sessions directory.');
  }
  return dataDir;
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function listJsonFiles<T>(directory: string): T[] {
  try {
    if (!fs.existsSync(directory)) {
      return [];
    }
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .slice(0, MAX_JSON_FILES_PER_SOURCE)
      .map((entry) => readJson<T>(join(directory, entry.name)))
      .filter((item): item is T => item !== null);
  } catch {
    return [];
  }
}

function normalizeText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 96) : fallback;
}

function getFreshness(updatedAt: number, now: number): AoiSignalFreshness {
  if (!updatedAt || updatedAt <= 0) {
    return 'unknown';
  }
  const age = now - updatedAt;
  if (age <= FRESH_MS) {
    return 'fresh';
  }
  if (age <= STALE_MS) {
    return 'unknown';
  }
  return 'stale';
}

function maxTimestamp(values: Array<number | undefined>, fallback: number): number {
  const latest = values
    .filter((value): value is number => typeof value === 'number' && value > 0)
    .sort((left, right) => right - left)[0];
  return latest ?? fallback;
}

function formatTimestamp(value: number | undefined): string {
  if (!value || value <= 0) {
    return 'never';
  }
  return new Date(value).toISOString();
}

function formatReminder(minutes: number | undefined): string {
  if (typeof minutes !== 'number' || minutes <= 0) {
    return 'no reminder';
  }
  if (minutes >= 1440) {
    return `reminder ${Math.round(minutes / 1440)}d`;
  }
  if (minutes >= 60) {
    return `reminder ${Math.round(minutes / 60)}h`;
  }
  return `reminder ${minutes}m`;
}

function makeEvidenceRefs(
  kind: AoiPersonalSignalSourceKind,
  sourceId: string,
  refs: string[],
): string[] {
  return [`personal-signal:${kind}`, `environment-source:${sourceId}`, ...refs].filter(
    (value, index, all) => value && all.indexOf(value) === index,
  );
}

function summarizeCalendarMetadata(
  input: AoiPersonalSignalConnectorInput,
): AoiPersonalSignalMetadataSummary | null {
  const sourceId = 'calendar-metadata';
  const dataDir = appDataDir(input.sessionsDir, input.sessionPath, 'calendar');
  if (!dataDir) {
    return null;
  }
  const now = input.now ?? Date.now();
  const events = listJsonFiles<CalendarEventMetadata>(join(dataDir, 'events'))
    .map((event) => ({
      id: normalizeText(event.id, 'unknown-event'),
      title: normalizeText(event.title, 'Untitled event'),
      startAt: normalizeText(event.startAt),
      remindBeforeMinutes:
        typeof event.remindBeforeMinutes === 'number' ? event.remindBeforeMinutes : undefined,
      completed: event.completed === true,
      updatedAt:
        typeof event.updatedAt === 'number'
          ? event.updatedAt
          : typeof event.lastReminderSentAt === 'number'
            ? event.lastReminderSentAt
            : undefined,
    }))
    .filter((event) => event.title && event.startAt);
  if (events.length === 0 && !fs.existsSync(join(dataDir, 'events'))) {
    return null;
  }
  const upcoming = events
    .filter((event) => {
      const startMs = new Date(event.startAt).getTime();
      return !event.completed && Number.isFinite(startMs) && startMs >= now;
    })
    .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime())
    .slice(0, MAX_RECENT_TITLES);
  const upcomingLabels = upcoming.map(
    (event) =>
      `${event.title} at ${new Date(event.startAt).toISOString()} (${formatReminder(event.remindBeforeMinutes)})`,
  );
  const updatedAt = maxTimestamp(
    [
      ...events.map((event) => event.updatedAt),
      ...upcoming.map((event) => new Date(event.startAt).getTime()),
    ],
    now,
  );
  const summary =
    upcomingLabels.length > 0
      ? `Calendar metadata: ${upcoming.length} upcoming of ${events.length}; ${upcomingLabels.join('; ')}.`
      : `Calendar metadata: 0 upcoming of ${events.length}; no event descriptions or notes read.`;

  return {
    version: 1,
    sourceId,
    kind: 'calendar_metadata',
    label: 'Calendar metadata',
    displayName: 'Calendar',
    summary,
    relevanceText: `${summary} calendar meeting event reminder schedule 일정 캘린더 회의 미팅`,
    evidenceRefs: makeEvidenceRefs(
      'calendar_metadata',
      sourceId,
      upcoming.map((event) => `calendar-event:${event.id}`),
    ),
    scoreReasons: ['calendar title, time, and reminder metadata only'],
    updatedAt,
    freshness: getFreshness(updatedAt, now),
    confidence: events.length > 0 ? 0.76 : 0.52,
    redactionState: 'redacted',
  };
}

function summarizeGmailMetadata(
  input: AoiPersonalSignalConnectorInput,
): AoiPersonalSignalMetadataSummary | null {
  const sourceId = 'gmail-metadata';
  const dataDir = appDataDir(input.sessionsDir, input.sessionPath, 'email');
  if (!dataDir) {
    return null;
  }
  const now = input.now ?? Date.now();
  const gmailConfig = input.configFile
    ? (readJson<GmailConfigFile>(resolve(input.configFile))?.gmail ?? {})
    : {};
  const emails = listJsonFiles<CachedEmailMetadata>(join(dataDir, 'emails'));
  if (!gmailConfig.clientId && emails.length === 0 && !fs.existsSync(dataDir)) {
    return null;
  }
  const configured = Boolean(gmailConfig.clientId);
  const connected = Boolean(gmailConfig.clientId && gmailConfig.refreshToken);
  const unreadCount = emails.filter((email) => email.isRead === false).length;
  const folderCounts = new Map<string, number>();
  const labelCounts = new Map<string, number>();
  for (const email of emails) {
    const folder = normalizeText(email.folder, 'unknown');
    folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
    for (const labelId of email.labelIds ?? []) {
      const label = normalizeText(labelId);
      if (label) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }
    }
  }
  const folderLabel = [...folderCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([folder, count]) => `${folder}:${count}`)
    .join(', ');
  const labelLabel = [...labelCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([label, count]) => `${label}:${count}`)
    .join(', ');
  const updatedAt = maxTimestamp(
    [gmailConfig.lastSyncAt, ...emails.map((email) => email.timestamp)],
    now,
  );
  const summary = [
    `Gmail metadata: configured=${configured}`,
    `connected=${connected}`,
    `lastSync=${formatTimestamp(gmailConfig.lastSyncAt)}`,
    `cached=${emails.length}`,
    `unread=${unreadCount}`,
    folderLabel ? `folders=${folderLabel}` : 'folders=none',
    labelLabel ? `labels=${labelLabel}` : 'labels=none',
  ].join('; ');

  return {
    version: 1,
    sourceId,
    kind: 'gmail_metadata',
    label: 'Gmail metadata',
    displayName: 'Gmail',
    summary,
    relevanceText: `${summary} gmail email mail inbox unread label 메일 이메일 받은편지`,
    evidenceRefs: makeEvidenceRefs('gmail_metadata', sourceId, ['gmail-cache:counts']),
    scoreReasons: ['gmail connection, sync, unread, folder, and label counts only'],
    updatedAt,
    freshness: getFreshness(updatedAt, now),
    confidence: configured || emails.length > 0 ? 0.72 : 0.46,
    redactionState: 'redacted',
  };
}

function summarizeNotesMetadata(
  input: AoiPersonalSignalConnectorInput,
): AoiPersonalSignalMetadataSummary | null {
  const sourceId = 'notes-metadata';
  const dataDir = appDataDir(input.sessionsDir, input.sessionPath, 'notes');
  if (!dataDir) {
    return null;
  }
  const now = input.now ?? Date.now();
  const notes = listJsonFiles<NoteMetadata>(join(dataDir, 'notes'))
    .map((note) => ({
      id: normalizeText(note.id, 'unknown-note'),
      title: normalizeText(note.title, 'Untitled note'),
      tags: Array.isArray(note.tags)
        ? note.tags.map((tag) => normalizeText(tag)).filter(Boolean)
        : [],
      pinned: note.pinned === true,
      updatedAt:
        typeof note.updatedAt === 'number'
          ? note.updatedAt
          : typeof note.createdAt === 'number'
            ? note.createdAt
            : undefined,
    }))
    .filter((note) => note.id);
  if (notes.length === 0 && !fs.existsSync(join(dataDir, 'notes'))) {
    return null;
  }
  const recent = [...notes]
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, MAX_RECENT_TITLES);
  const tags = [...new Set(recent.flatMap((note) => note.tags))].slice(0, 8);
  const pinnedCount = notes.filter((note) => note.pinned).length;
  const updatedAt = maxTimestamp(
    notes.map((note) => note.updatedAt),
    now,
  );
  const recentLabel =
    recent.length > 0
      ? recent.map((note) => `${note.title}${note.pinned ? ' pinned' : ''}`).join('; ')
      : 'none';
  const summary = [
    `Notes metadata: count=${notes.length}`,
    `pinned=${pinnedCount}`,
    `recentTitles=${recentLabel}`,
    `tags=${tags.length > 0 ? tags.join(', ') : 'none'}`,
  ].join('; ');

  return {
    version: 1,
    sourceId,
    kind: 'notes_metadata',
    label: 'Notes metadata',
    displayName: 'Notes',
    summary,
    relevanceText: `${summary} notes note memo tag pinned 메모 노트 태그 기록`,
    evidenceRefs: makeEvidenceRefs(
      'notes_metadata',
      sourceId,
      recent.map((note) => `note:${note.id}`),
    ),
    scoreReasons: ['note count, recent titles, tags, and pinned state only'],
    updatedAt,
    freshness: getFreshness(updatedAt, now),
    confidence: notes.length > 0 ? 0.74 : 0.5,
    redactionState: 'redacted',
  };
}

export function loadAoiPersonalSignalMetadataSummaries(
  input: AoiPersonalSignalConnectorInput,
): AoiPersonalSignalMetadataSummary[] {
  return [
    summarizeCalendarMetadata(input),
    summarizeGmailMetadata(input),
    summarizeNotesMetadata(input),
  ].filter((summary): summary is AoiPersonalSignalMetadataSummary => summary !== null);
}
