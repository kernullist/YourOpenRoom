// Persistence for the context behind a nudge card's follow-up chips.
//
// Same contract as aoiPendingOffers, and it was missing the same way. The
// proactive trend card and the agenda card come back from the server-side
// transcript after a reload, chips and all, while the context that gives each
// chip its meaning lived only in an in-memory Map. A tap then reached the model
// as bare prose: the chip still sent something, it just no longer said WHICH
// trend or WHICH proposal it was about, so the answer was about nothing in
// particular.
//
// Unlike a music pick or a news headline, these cannot be rebuilt from the
// transcript -- the card body is a summary Aoi wrote, not the snapshot behind
// it -- so this is the only line of defence, and it covers a reload of the same
// browser profile and origin.
//
// Written whenever a card registers its chips, cleared when a message consumes
// or invalidates them, hydrated once on mount. Best-effort throughout: a
// failure to persist costs the context, never the message.

import {
  parseAoiAgendaChatFollowUpContext,
  type AoiAgendaChatFollowUpContext,
} from './aoiAutonomyUi';
import {
  parseAoiProactiveTrendFollowUpContext,
  type AoiProactiveTrendFollowUpContext,
} from './aoiProactiveTrendFollowUp';

const TREND_FOLLOW_UP_STORAGE_KEY = 'aoi-trend-follow-up-contexts-v1';
const AGENDA_FOLLOW_UP_STORAGE_KEY = 'aoi-agenda-follow-up-contexts-v1';

// Mirrors the in-memory cap the ChatPanel maps already enforced.
export const MAX_FOLLOW_UP_CONTEXTS = 24;

// A follow-up context describes a card as Aoi posted it, and it stops being
// answerable once the user moves on -- which the caller enforces by clearing on
// any unrelated message. So this age is a storage bound, not a freshness rule:
// it stops entries left behind by a tab that closed mid-turn from resurfacing
// days later against a card nobody is looking at any more.
export const FOLLOW_UP_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;

// Contexts are stamped with the session they belong to. One localStorage key
// serves every session, and switching sessions reloads a different transcript
// with different cards -- restoring the previous session's contexts into it
// would attach the wrong trend to a chip that looks identical.
function readList(key: string, sessionPath: string): unknown[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as { sessionPath?: unknown; contexts?: unknown } | null;
    if (!parsed || typeof parsed !== 'object' || parsed.sessionPath !== sessionPath) {
      return [];
    }
    return Array.isArray(parsed.contexts) ? parsed.contexts : [];
  } catch {
    // Malformed storage or privacy mode; treat as no stored context.
    return [];
  }
}

function writeList(key: string, sessionPath: string, values: readonly unknown[]): void {
  try {
    if (values.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        sessionPath,
        contexts: values.slice(-MAX_FOLLOW_UP_CONTEXTS),
      }),
    );
  } catch {
    // Best-effort persistence; ignore quota / privacy-mode failures.
  }
}

// Newest last, matching Map insertion order, so the caller can rebuild the Map
// by inserting in order and keep the same eviction behaviour.
function withinTtl<T extends { createdAt: number }>(contexts: T[], now: number): T[] {
  return contexts.filter((context) => now - context.createdAt <= FOLLOW_UP_CONTEXT_TTL_MS);
}

export function loadTrendFollowUpContexts(
  sessionPath: string,
  now: number = Date.now(),
): AoiProactiveTrendFollowUpContext[] {
  const parsed = readList(TREND_FOLLOW_UP_STORAGE_KEY, sessionPath)
    .map(parseAoiProactiveTrendFollowUpContext)
    .filter((context): context is AoiProactiveTrendFollowUpContext => context !== null);
  return withinTtl(parsed, now).slice(-MAX_FOLLOW_UP_CONTEXTS);
}

export function saveTrendFollowUpContexts(
  sessionPath: string,
  contexts: readonly AoiProactiveTrendFollowUpContext[],
): void {
  writeList(TREND_FOLLOW_UP_STORAGE_KEY, sessionPath, contexts);
}

export function loadAgendaFollowUpContexts(
  sessionPath: string,
  now: number = Date.now(),
): AoiAgendaChatFollowUpContext[] {
  const parsed = readList(AGENDA_FOLLOW_UP_STORAGE_KEY, sessionPath)
    .map(parseAoiAgendaChatFollowUpContext)
    .filter((context): context is AoiAgendaChatFollowUpContext => context !== null);
  return withinTtl(parsed, now).slice(-MAX_FOLLOW_UP_CONTEXTS);
}

export function saveAgendaFollowUpContexts(
  sessionPath: string,
  contexts: readonly AoiAgendaChatFollowUpContext[],
): void {
  writeList(AGENDA_FOLLOW_UP_STORAGE_KEY, sessionPath, contexts);
}
