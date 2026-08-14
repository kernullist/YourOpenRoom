import { isSignalCategory, type SignalCategory } from '@/lib/signalDeskShared';

export const SIGNAL_DESK_VIEWS = ['inbox', 'brief', 'sources'] as const;
export type SignalDeskViewId = (typeof SIGNAL_DESK_VIEWS)[number];

export function isSignalDeskViewId(value: unknown): value is SignalDeskViewId {
  return typeof value === 'string' && (SIGNAL_DESK_VIEWS as readonly string[]).includes(value);
}

export type CategoryFilter = 'all' | SignalCategory;

export function isCategoryFilter(value: unknown): value is CategoryFilter {
  return value === 'all' || isSignalCategory(value);
}

/**
 * How a local-route call came back (MissionControl/DriveConsole contract).
 *
 * `unconfigured` is separated from `error` because a 404 / non-JSON body here
 * means the dev-server plugin is not mounted — the feature is off, not broken.
 * `denied` is reserved for the research handoff's 409 duplicate answer, which
 * is the system working, not failing. `empty` means the call worked and there
 * is genuinely nothing.
 */
export type PanelState<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: T; fetchedAt: number }
  | { kind: 'empty'; reason: string; fetchedAt: number }
  | { kind: 'unconfigured'; fetchedAt: number }
  | { kind: 'denied'; message: string; fetchedAt: number }
  | { kind: 'error'; message: string; fetchedAt: number };

export const SEEN_IDS_CAP = 300;

export interface SignalDeskState {
  version: 1;
  activeView: SignalDeskViewId;
  category: CategoryFilter;
  sessionPath: string;
  seenIds: string[];
}

export const DEFAULT_SIGNAL_DESK_STATE: SignalDeskState = {
  version: 1,
  activeView: 'inbox',
  category: 'all',
  sessionPath: '',
  seenIds: [],
};

/** Field-by-field merge so a partial or malformed write cannot wipe state. */
export function mergeSignalDeskState(current: SignalDeskState, incoming: unknown): SignalDeskState {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return current;
  }
  const raw = incoming as Record<string, unknown>;
  const next: SignalDeskState = { ...current };

  if (isSignalDeskViewId(raw.activeView)) {
    next.activeView = raw.activeView;
  }
  if (isCategoryFilter(raw.category)) {
    next.category = raw.category;
  }
  if (typeof raw.sessionPath === 'string') {
    next.sessionPath = raw.sessionPath.trim();
  }
  if (Array.isArray(raw.seenIds)) {
    const seen = raw.seenIds.filter((id): id is string => typeof id === 'string');
    next.seenIds = seen.slice(Math.max(0, seen.length - SEEN_IDS_CAP));
  }
  return next;
}

/** Research handoff progress, keyed to the signal it was started for. */
export type ResearchPhase =
  | { kind: 'idle' }
  | { kind: 'starting'; itemId: string }
  | { kind: 'started'; itemId: string; message: string }
  | { kind: 'denied'; itemId: string; message: string }
  | { kind: 'error'; itemId: string; message: string };

/**
 * A 409/duplicate answer from the research start route means an equivalent run
 * is already active — the guard working, not a failure. Everything else is a
 * real error.
 */
export function classifyResearchFailure(itemId: string, error: unknown): ResearchPhase {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b409\b|duplicate|already/i.test(message)) {
    return {
      kind: 'denied',
      itemId,
      message: `이미 진행 중인 동일 리서치가 있습니다 — ${message}`,
    };
  }
  return { kind: 'error', itemId, message };
}
