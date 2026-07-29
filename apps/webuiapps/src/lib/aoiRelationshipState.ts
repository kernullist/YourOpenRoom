// Aoi relationship state (R2.1): the durable record of "us" that survives a
// session boundary -- when we first met, how many sessions we have had, what
// the last one was about, and which threads are still open.
//
// Why this exists: every session currently opens with the same static
// first-meeting prologue and wipes the message history, so nothing Aoi knows
// about the relationship carries forward. Continuity is the largest single
// contributor to the felt bond, and it needs a store before a greeting can
// reference it.
//
// Rules (load-bearing):
// - EXPRESSION LAYER ONLY. This record never feeds a gate: not the
//   interruption governor, not promotion/readiness, not budgets, not approval
//   eligibility. It is display_only with mutationCount 0, like every other
//   observation record.
// - MEMORY HONESTY. Aoi may only reference a shared past that is actually
//   stored here. A corrupt or absent file yields null, and callers fall back
//   to saying nothing rather than inventing continuity.
// - Free text (session summary, thread titles) is redacted + stripped of
//   source instructions + hard-capped before it is persisted, because it
//   derives from conversation.
// - Bounded: capped thread and milestone lists, capped strings, single file.
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { normalizeAoiAutonomySessionPath, resolveAoiAutonomyPaths } from './aoiAutonomyStore';
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import { selectAoiRelationshipThreadToRaise as selectAoiRelationshipThreadToRaiseFromList } from './aoiRelationshipThreads';

const RELATIONSHIP_DIR = 'relationship';
const RELATIONSHIP_STATE_FILE = 'state.json';

const MAX_SESSION_SUMMARY_CHARS = 400;
const MAX_THREAD_TITLE_CHARS = 120;
const MAX_OPEN_THREADS = 5;
const MAX_MILESTONES = 20;
const MAX_MILESTONE_LABEL_CHARS = 120;
const MAX_MILESTONE_EVIDENCE_REFS = 6;

// Reopening the browser is not a new session. Without this floor a refresh
// would inflate the session count, and an inflated count would make every
// milestone Aoi mentions a lie.
export const DEFAULT_MIN_SESSION_GAP_MS = 30 * 60 * 1000;

export type AoiRelationshipMilestoneKind =
  | 'first_met'
  | 'session_count'
  | 'trust_promoted'
  | 'first_accepted_proposal'
  | 'arc_completed';

export interface AoiRelationshipMilestone {
  id: string;
  kind: AoiRelationshipMilestoneKind;
  label: string;
  occurredAt: number;
  evidenceRefs: string[];
}

export interface AoiRelationshipOpenThread {
  id: string;
  title: string;
  noticedAt: number;
  // When Aoi last asked about this thread. Enforces asked-once-per-thread so a
  // follow-up question cannot become nagging (R2.3).
  lastAskedAt?: number;
}

export interface AoiRelationshipState {
  version: 1;
  sessionPath: string;
  firstMetAt: number;
  sessionCount: number;
  lastSessionAt: number;
  lastSessionSummary: string;
  openThreads: AoiRelationshipOpenThread[];
  milestones: AoiRelationshipMilestone[];
  actionAuthority: 'display_only';
  mutationCount: 0;
  updatedAt: number;
}

function sanitizeRelationshipText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  const stripped = stripAoiSourceInstructions(redactAoiSensitiveContent(value));
  const collapsed = stripped
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Stable id for a thread so the asked-once marker survives a re-derived list
// (the same open thread reported twice must not be asked about twice).
export function deriveAoiRelationshipThreadId(title: string): string {
  const normalized = sanitizeRelationshipText(title, MAX_THREAD_TITLE_CHARS)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return normalized ? `thread:${normalized}` : '';
}

function normalizeOpenThreads(value: unknown, now: number): AoiRelationshipOpenThread[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const threads: AoiRelationshipOpenThread[] = [];
  for (const entry of value) {
    const raw = entry as Partial<AoiRelationshipOpenThread> | null;
    const title = sanitizeRelationshipText(raw?.title, MAX_THREAD_TITLE_CHARS);
    if (!title) {
      continue;
    }
    const id =
      typeof raw?.id === 'string' && raw.id ? raw.id : deriveAoiRelationshipThreadId(title);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    threads.push({
      id,
      title,
      noticedAt: normalizeTimestamp(raw?.noticedAt, now),
      ...(typeof raw?.lastAskedAt === 'number' && Number.isFinite(raw.lastAskedAt)
        ? { lastAskedAt: raw.lastAskedAt }
        : {}),
    });
    if (threads.length >= MAX_OPEN_THREADS) {
      break;
    }
  }
  return threads;
}

const MILESTONE_KINDS = new Set<AoiRelationshipMilestoneKind>([
  'first_met',
  'session_count',
  'trust_promoted',
  'first_accepted_proposal',
  'arc_completed',
]);

function normalizeMilestones(value: unknown, now: number): AoiRelationshipMilestone[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const milestones: AoiRelationshipMilestone[] = [];
  for (const entry of value) {
    const raw = entry as Partial<AoiRelationshipMilestone> | null;
    const kind = raw?.kind;
    if (!kind || !MILESTONE_KINDS.has(kind)) {
      continue;
    }
    const label = sanitizeRelationshipText(raw?.label, MAX_MILESTONE_LABEL_CHARS);
    if (!label) {
      continue;
    }
    const id = typeof raw?.id === 'string' && raw.id ? raw.id : `${kind}:${label}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    milestones.push({
      id,
      kind,
      label,
      occurredAt: normalizeTimestamp(raw?.occurredAt, now),
      evidenceRefs: Array.isArray(raw?.evidenceRefs)
        ? raw.evidenceRefs
            .filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0)
            .slice(0, MAX_MILESTONE_EVIDENCE_REFS)
        : [],
    });
  }
  // Oldest first, then keep the most recent when over the cap: the earliest
  // milestones (first meeting) matter most, so retain both ends by dropping
  // from the middle is overkill -- keep the newest window plus first_met.
  milestones.sort((left, right) => left.occurredAt - right.occurredAt);
  if (milestones.length <= MAX_MILESTONES) {
    return milestones;
  }
  const firstMet = milestones.filter((item) => item.kind === 'first_met').slice(0, 1);
  const rest = milestones
    .filter((item) => item.kind !== 'first_met')
    .slice(-(MAX_MILESTONES - firstMet.length));
  return [...firstMet, ...rest];
}

export function createAoiRelationshipState(sessionPath: string, now: number): AoiRelationshipState {
  return {
    version: 1,
    sessionPath,
    firstMetAt: now,
    sessionCount: 1,
    lastSessionAt: now,
    lastSessionSummary: '',
    openThreads: [],
    milestones: [
      {
        id: 'first_met',
        kind: 'first_met',
        label: 'We started working together.',
        occurredAt: now,
        evidenceRefs: [],
      },
    ],
    actionAuthority: 'display_only',
    mutationCount: 0,
    updatedAt: now,
  };
}

// Fail-closed normalization: anything that is not a recognizable record yields
// null so the caller falls back to "no shared history" instead of a partly
// invented one.
export function normalizeAoiRelationshipState(
  raw: unknown,
  sessionPath: string,
  now: number,
): AoiRelationshipState | null {
  const value = raw as Partial<AoiRelationshipState> | null;
  if (!value || value.version !== 1) {
    return null;
  }
  const firstMetAt = normalizeTimestamp(value.firstMetAt, 0);
  if (!firstMetAt) {
    return null;
  }
  const sessionCount =
    typeof value.sessionCount === 'number' && Number.isFinite(value.sessionCount)
      ? Math.max(1, Math.floor(value.sessionCount))
      : 1;
  return {
    version: 1,
    sessionPath,
    firstMetAt,
    sessionCount,
    lastSessionAt: normalizeTimestamp(value.lastSessionAt, firstMetAt),
    lastSessionSummary: sanitizeRelationshipText(
      value.lastSessionSummary,
      MAX_SESSION_SUMMARY_CHARS,
    ),
    openThreads: normalizeOpenThreads(value.openThreads, now),
    milestones: normalizeMilestones(value.milestones, now),
    actionAuthority: 'display_only',
    mutationCount: 0,
    updatedAt: normalizeTimestamp(value.updatedAt, firstMetAt),
  };
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveAoiRelationshipStatePath(sessionsDir: string, sessionPath: string): string {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const statePath = join(paths.root, RELATIONSHIP_DIR, RELATIONSHIP_STATE_FILE);
  if (!isPathInsideRoot(paths.root, statePath)) {
    throw new Error('Resolved Aoi relationship path escaped the autonomy root.');
  }
  return statePath;
}

export function loadAoiRelationshipState(
  sessionsDir: string,
  sessionPath: string,
  now: number,
): AoiRelationshipState | null {
  try {
    const statePath = resolveAoiRelationshipStatePath(sessionsDir, sessionPath);
    if (!fs.existsSync(statePath)) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as unknown;
    return normalizeAoiRelationshipState(raw, sessionPath, now);
  } catch {
    // Unreadable or malformed state means no shared history, never a guess.
    return null;
  }
}

export function saveAoiRelationshipState(
  sessionsDir: string,
  state: AoiRelationshipState,
): AoiRelationshipState {
  const statePath = resolveAoiRelationshipStatePath(sessionsDir, state.sessionPath);
  fs.mkdirSync(dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${state.updatedAt}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, statePath);
  return state;
}

export interface RecordAoiRelationshipSessionOpenOptions {
  minSessionGapMs?: number;
}

// Called when a session opens. First ever open creates the record (and the
// first-met milestone); a genuine return increments the session count; a
// refresh inside the gap floor only refreshes the timestamp.
export function recordAoiRelationshipSessionOpen(
  sessionsDir: string,
  sessionPath: string,
  now: number,
  options: RecordAoiRelationshipSessionOpenOptions = {},
): AoiRelationshipState {
  const existing = loadAoiRelationshipState(sessionsDir, sessionPath, now);
  if (!existing) {
    return saveAoiRelationshipState(sessionsDir, createAoiRelationshipState(sessionPath, now));
  }
  const minGapMs = options.minSessionGapMs ?? DEFAULT_MIN_SESSION_GAP_MS;
  const isNewSession = now - existing.lastSessionAt >= minGapMs;
  return saveAoiRelationshipState(sessionsDir, {
    ...existing,
    sessionCount: isNewSession ? existing.sessionCount + 1 : existing.sessionCount,
    lastSessionAt: now,
    updatedAt: now,
  });
}

export interface RecordAoiRelationshipSessionSummaryInput {
  summary?: string;
  openThreads?: Array<{ title: string; noticedAt?: number }>;
  now: number;
}

// Called when a session goes idle or closes: stores what it was about and
// which threads are still open, so the next open can pick them up. Threads
// already known keep their id and asked-once marker; threads that disappeared
// from the caller's list are pruned (they are no longer open).
export function recordAoiRelationshipSessionSummary(
  sessionsDir: string,
  sessionPath: string,
  input: RecordAoiRelationshipSessionSummaryInput,
): AoiRelationshipState | null {
  const existing = loadAoiRelationshipState(sessionsDir, sessionPath, input.now);
  if (!existing) {
    return null;
  }
  const summary = sanitizeRelationshipText(input.summary, MAX_SESSION_SUMMARY_CHARS);
  const previousById = new Map(existing.openThreads.map((thread) => [thread.id, thread]));
  const nextThreads = normalizeOpenThreads(
    (input.openThreads ?? []).map((thread) => {
      const id = deriveAoiRelationshipThreadId(thread.title);
      const previous = id ? previousById.get(id) : undefined;
      return {
        id,
        title: thread.title,
        noticedAt: previous?.noticedAt ?? thread.noticedAt ?? input.now,
        ...(previous?.lastAskedAt !== undefined ? { lastAskedAt: previous.lastAskedAt } : {}),
      };
    }),
    input.now,
  );
  return saveAoiRelationshipState(sessionsDir, {
    ...existing,
    // An empty summary does not erase what we already knew.
    lastSessionSummary: summary || existing.lastSessionSummary,
    openThreads: nextThreads,
    updatedAt: input.now,
  });
}

// Records that Aoi asked about a thread, so she does not ask again.
export function markAoiRelationshipThreadAsked(
  sessionsDir: string,
  sessionPath: string,
  threadId: string,
  now: number,
): AoiRelationshipState | null {
  const existing = loadAoiRelationshipState(sessionsDir, sessionPath, now);
  if (!existing) {
    return null;
  }
  if (!existing.openThreads.some((thread) => thread.id === threadId)) {
    return existing;
  }
  return saveAoiRelationshipState(sessionsDir, {
    ...existing,
    openThreads: existing.openThreads.map((thread) =>
      thread.id === threadId ? { ...thread, lastAskedAt: now } : thread,
    ),
    updatedAt: now,
  });
}

// State-shaped wrapper over the shared selector (which the client also uses).
export function selectAoiRelationshipThreadToRaise(
  state: AoiRelationshipState | null,
): AoiRelationshipOpenThread | null {
  return selectAoiRelationshipThreadToRaiseFromList(state?.openThreads);
}

export interface AoiRelationshipMilestoneInput {
  kind: AoiRelationshipMilestoneKind;
  label: string;
  occurredAt?: number;
  evidenceRefs?: string[];
  id?: string;
}

// Applies several derived milestones in one load/save and reports which were
// genuinely new. Callers need that distinction: only a just-crossed milestone is
// worth mentioning to the user, and re-derivation runs on every session open.
export function applyAoiRelationshipMilestones(
  sessionsDir: string,
  sessionPath: string,
  inputs: AoiRelationshipMilestoneInput[],
  now: number,
): { state: AoiRelationshipState | null; added: AoiRelationshipMilestone[] } {
  const existing = loadAoiRelationshipState(sessionsDir, sessionPath, now);
  if (!existing) {
    return { state: null, added: [] };
  }
  const known = new Set(existing.milestones.map((milestone) => milestone.id));
  const added: AoiRelationshipMilestone[] = [];
  for (const input of inputs) {
    const label = sanitizeRelationshipText(input.label, MAX_MILESTONE_LABEL_CHARS);
    if (!label) {
      continue;
    }
    const id = input.id ?? `${input.kind}:${label}`;
    if (known.has(id)) {
      continue;
    }
    known.add(id);
    added.push({
      id,
      kind: input.kind,
      label,
      occurredAt: input.occurredAt ?? now,
      evidenceRefs: input.evidenceRefs ?? [],
    });
  }
  if (added.length === 0) {
    return { state: existing, added: [] };
  }
  const milestones = normalizeMilestones([...existing.milestones, ...added], now);
  const state = saveAoiRelationshipState(sessionsDir, {
    ...existing,
    milestones,
    updatedAt: now,
  });
  // Report only those that survived normalization's cap.
  const retained = new Set(state.milestones.map((milestone) => milestone.id));
  return { state, added: added.filter((milestone) => retained.has(milestone.id)) };
}

// Appends a milestone unless one with the same id already exists, so a
// re-derived milestone (same trust promotion, same arc) is recorded once.
export function appendAoiRelationshipMilestone(
  sessionsDir: string,
  sessionPath: string,
  input: AoiRelationshipMilestoneInput,
  now: number,
): AoiRelationshipState | null {
  const existing = loadAoiRelationshipState(sessionsDir, sessionPath, now);
  if (!existing) {
    return null;
  }
  const label = sanitizeRelationshipText(input.label, MAX_MILESTONE_LABEL_CHARS);
  if (!label) {
    return existing;
  }
  const id = input.id ?? `${input.kind}:${label}`;
  if (existing.milestones.some((milestone) => milestone.id === id)) {
    return existing;
  }
  const milestones = normalizeMilestones(
    [
      ...existing.milestones,
      {
        id,
        kind: input.kind,
        label,
        occurredAt: input.occurredAt ?? now,
        evidenceRefs: input.evidenceRefs ?? [],
      },
    ],
    now,
  );
  return saveAoiRelationshipState(sessionsDir, { ...existing, milestones, updatedAt: now });
}
