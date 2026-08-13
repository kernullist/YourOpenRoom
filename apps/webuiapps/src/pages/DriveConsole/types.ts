import type { PlanDraft } from './planDraft';

export const DRIVE_CONSOLE_VIEWS = ['plan', 'run', 'audit'] as const;
export type DriveConsoleViewId = (typeof DRIVE_CONSOLE_VIEWS)[number];

export function isDriveConsoleViewId(value: unknown): value is DriveConsoleViewId {
  return typeof value === 'string' && (DRIVE_CONSOLE_VIEWS as readonly string[]).includes(value);
}

/**
 * How a host-bridge call came back.
 *
 * `unconfigured` is separated from `error` because a 401 here means the bridge
 * token file has never been created -- the feature is off, not broken. Telling
 * someone their setup is failing when they simply have not set it up sends them
 * debugging a non-problem.
 *
 * `denied` (403) is separated too: it means the request was well-formed and the
 * approval is simply missing, which is the system working as designed.
 */
export type BridgeState<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: T; fetchedAt: number }
  | { kind: 'empty'; reason: string; fetchedAt: number }
  | { kind: 'unconfigured'; fetchedAt: number }
  | { kind: 'denied'; message: string; fetchedAt: number }
  | { kind: 'error'; message: string; fetchedAt: number };

/**
 * Classify a thrown host-bridge error.
 *
 * The client throws plain Errors carrying the server's message, so the status
 * has to be recovered from the text. Matching on the code words the bridge
 * actually emits keeps a real failure from being dressed up as "not configured".
 */
export function classifyBridgeError<T>(error: unknown, fetchedAt: number): BridgeState<T> {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid_token|unauthorized|\b401\b/i.test(message)) {
    return { kind: 'unconfigured', fetchedAt };
  }
  if (/\b403\b|not_approved|approval|forbidden/i.test(message)) {
    return { kind: 'denied', message, fetchedAt };
  }
  return { kind: 'error', message, fetchedAt };
}

export interface DriveConsoleState {
  version: 1;
  activeView: DriveConsoleViewId;
  sessionPath: string;
  targetUrl: string;
  draft: PlanDraft;
  selectedStepIndex: number | null;
}

export const DEFAULT_DRIVE_CONSOLE_STATE: DriveConsoleState = {
  version: 1,
  activeView: 'plan',
  sessionPath: '',
  targetUrl: '',
  draft: { goal: '', steps: [] },
  selectedStepIndex: null,
};

/** Field-by-field merge so a partial write cannot wipe an in-progress plan. */
export function mergeDriveConsoleState(
  current: DriveConsoleState,
  incoming: unknown,
): DriveConsoleState {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return current;
  }
  const raw = incoming as Record<string, unknown>;
  const next: DriveConsoleState = { ...current };

  if (isDriveConsoleViewId(raw.activeView)) {
    next.activeView = raw.activeView;
  }
  if (typeof raw.sessionPath === 'string') {
    next.sessionPath = raw.sessionPath.trim();
  }
  if (typeof raw.targetUrl === 'string') {
    next.targetUrl = raw.targetUrl.trim();
  }
  if (raw.draft && typeof raw.draft === 'object' && !Array.isArray(raw.draft)) {
    const draft = raw.draft as Record<string, unknown>;
    next.draft = {
      goal: typeof draft.goal === 'string' ? draft.goal : current.draft.goal,
      steps: Array.isArray(draft.steps) ? (draft.steps as PlanDraft['steps']) : current.draft.steps,
    };
  }
  if (typeof raw.selectedStepIndex === 'number' && Number.isFinite(raw.selectedStepIndex)) {
    next.selectedStepIndex = Math.trunc(raw.selectedStepIndex);
  } else if (raw.selectedStepIndex === null) {
    next.selectedStepIndex = null;
  }
  return next;
}
