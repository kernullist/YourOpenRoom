import type { AoiAutonomyRuntimeView } from '@/lib/aoiAutonomyRuntimePanelModel';
import type { AoiClosedLoopMetricsReport } from '@/lib/aoiClosedLoopMetrics';
import type {
  AoiOperatorFlightRecord,
  AoiOperatorFlightRecorderSummary,
} from '@/lib/aoiOperatorFlightRecorder';
import type { AoiUnifiedOperatorSnapshotSummary } from '@/lib/aoiUnifiedOperatorModel';
import type {
  AoiAutonomySchedulerState,
  AoiAutonomyStatus,
  AoiOperatorTimelineEvent,
  AoiProposal,
} from '@/lib/aoiAutonomyTypes';

// Every type above is imported TYPE-ONLY on purpose. The modules behind them
// reach for node:fs / node:crypto on the server side; a value import would only
// break `pnpm build` (typecheck and vitest both still pass), which is the exact
// failure mode that is easiest to ship by accident. The four modules this app
// imports as VALUES -- aoiAutonomyRuntimePanelModel, aoiDaemonHealthClient,
// aoiOperatorSnapshotPanelModel, aoiClosedLoopMetrics -- were checked to be free
// of node-only dependencies before being wired in.

export const MISSION_CONTROL_VIEWS = ['runtime', 'queue', 'timeline', 'flight', 'metrics'] as const;

export type MissionControlViewId = (typeof MISSION_CONTROL_VIEWS)[number];

export function isMissionControlViewId(value: unknown): value is MissionControlViewId {
  return typeof value === 'string' && (MISSION_CONTROL_VIEWS as readonly string[]).includes(value);
}

/**
 * The one type that carries this app's whole reason for existing.
 *
 * `ready` and `empty` are separate because "the loop produced nothing" and "we
 * could not read the loop" must never render the same way -- an operator who
 * cannot tell those apart is worse off than one with no console at all. `error`
 * keeps the HTTP status and the server's own `code` so the panel can say WHY
 * instead of shrugging.
 *
 * There is no `stale` member: staleness is derived from `fetchedAt` so a slow or
 * failing refresh never erases the last known-good data. Blanking the screen on
 * a transient failure tells the operator less than showing aged data with a
 * warning does.
 */
export type PanelState<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: T; fetchedAt: number }
  | { kind: 'empty'; reason: string; fetchedAt: number }
  | { kind: 'error'; message: string; code?: string; status?: number; fetchedAt: number };

export interface SessionChoice {
  sessionPath: string;
  updatedAt: number;
}

export interface TimelinePayload {
  events: AoiOperatorTimelineEvent[];
}

export interface FlightPayload {
  records: AoiOperatorFlightRecord[];
  summary: AoiOperatorFlightRecorderSummary | null;
}

export interface RuntimePayload {
  runtime: AoiAutonomyRuntimeView;
}

export interface MissionControlPanels {
  sessions: PanelState<SessionChoice[]>;
  runtime: PanelState<RuntimePayload>;
  status: PanelState<AoiAutonomyStatus>;
  snapshot: PanelState<AoiUnifiedOperatorSnapshotSummary>;
  scheduler: PanelState<AoiAutonomySchedulerState>;
  proposals: PanelState<AoiProposal[]>;
  timeline: PanelState<TimelinePayload>;
  flight: PanelState<FlightPayload>;
  metrics: PanelState<AoiClosedLoopMetricsReport>;
}

export type MissionControlPanelKey = keyof MissionControlPanels;

export const MISSION_CONTROL_REFRESH_INTERVALS = [5000, 10000, 30000] as const;

export interface MissionControlState {
  version: 1;
  activeView: MissionControlViewId;
  // null means "follow the newest session" rather than a pinned choice, so a
  // fresh install does not have to guess a session path that does not exist yet.
  sessionPath: string | null;
  autoRefresh: boolean;
  refreshIntervalMs: number;
  timelineKindFilter: string | null;
  selectedProposalId: string | null;
}

export const DEFAULT_MISSION_CONTROL_STATE: MissionControlState = {
  version: 1,
  activeView: 'runtime',
  sessionPath: null,
  autoRefresh: true,
  refreshIntervalMs: 10000,
  timelineKindFilter: null,
  selectedProposalId: null,
};

/**
 * Merge a persisted (or agent-written) state over the current one.
 *
 * Field-by-field and defensive: a state.json missing a key must leave that key
 * alone instead of resetting it to the default. SYNC_STATE runs this on payloads
 * Aoi wrote, and a partial write silently clobbering the operator's session
 * selection would be a real bug.
 */
export function mergeMissionControlState(
  current: MissionControlState,
  incoming: unknown,
): MissionControlState {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return current;
  }
  const raw = incoming as Record<string, unknown>;
  const next: MissionControlState = { ...current };

  if (isMissionControlViewId(raw.activeView)) {
    next.activeView = raw.activeView;
  }
  if (typeof raw.sessionPath === 'string' && raw.sessionPath.trim()) {
    next.sessionPath = raw.sessionPath.trim();
  } else if (raw.sessionPath === null) {
    next.sessionPath = null;
  }
  if (typeof raw.autoRefresh === 'boolean') {
    next.autoRefresh = raw.autoRefresh;
  }
  if (
    typeof raw.refreshIntervalMs === 'number' &&
    (MISSION_CONTROL_REFRESH_INTERVALS as readonly number[]).includes(raw.refreshIntervalMs)
  ) {
    next.refreshIntervalMs = raw.refreshIntervalMs;
  }
  if (typeof raw.timelineKindFilter === 'string' && raw.timelineKindFilter.trim()) {
    next.timelineKindFilter = raw.timelineKindFilter.trim();
  } else if (raw.timelineKindFilter === null) {
    next.timelineKindFilter = null;
  }
  if (typeof raw.selectedProposalId === 'string' && raw.selectedProposalId.trim()) {
    next.selectedProposalId = raw.selectedProposalId.trim();
  } else if (raw.selectedProposalId === null) {
    next.selectedProposalId = null;
  }
  return next;
}

// Which panels a given view actually needs. Polling every panel on every tick
// would hammer the same disk the daemon is trying to work on for data nobody is
// looking at; the status strip panels are refreshed separately and always.
export const VIEW_PANELS: Record<MissionControlViewId, MissionControlPanelKey[]> = {
  runtime: ['snapshot', 'scheduler'],
  queue: ['proposals'],
  timeline: ['timeline'],
  flight: ['flight'],
  metrics: ['metrics'],
};

// Refreshed regardless of the active view: the strip is the one thing this app
// promises to always be telling the truth about.
export const STRIP_PANELS: MissionControlPanelKey[] = ['runtime', 'status'];
