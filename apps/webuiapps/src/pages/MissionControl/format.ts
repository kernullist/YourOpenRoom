import type { PanelState } from './types';

// Pure formatting helpers. Kept out of the components so the honesty rules --
// null is not zero, unknown is not healthy, stale is not fresh -- are unit
// tested without a DOM.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '-';
  }
  if (ms < MINUTE_MS) {
    return `${Math.floor(ms / 1000)}s`;
  }
  const totalMinutes = Math.floor(ms / MINUTE_MS);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) {
    return `${hours}h ${totalMinutes % 60}m`;
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatTimestamp(value: number | undefined | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '-';
  }
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function formatRelativeTime(value: number | undefined | null, now: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '-';
  }
  const delta = now - value;
  if (delta < 0) {
    return 'in ' + formatDuration(-delta);
  }
  if (delta < 5000) {
    return 'just now';
  }
  if (delta >= DAY_MS * 30) {
    return formatTimestamp(value);
  }
  return `${formatDuration(delta)} ago`;
}

/**
 * Ratio formatting for closed-loop metrics.
 *
 * `null` from buildAoiClosedLoopMetrics means the denominator was below
 * minSample -- no signal. Rendering that as "0%" would invent a failing score
 * out of missing data and is the single most damaging lie this console could
 * tell, so it gets its own string and its own visual treatment upstream.
 */
export function formatRatio(
  value: number | null | undefined,
  sampleSize: number,
  minSample: number,
): string {
  if (value === null || value === undefined) {
    return `표본 부족 (${sampleSize}/${minSample})`;
  }
  if (!Number.isFinite(value)) {
    return '-';
  }
  return `${(value * 100).toFixed(1)}%`;
}

export function isRatioUnavailable(value: number | null | undefined): boolean {
  return value === null || value === undefined || !Number.isFinite(value);
}

export type PanelTone = 'ok' | 'warn' | 'danger' | 'unknown' | 'info';

/**
 * Map a runtime status to a tone.
 *
 * `unreachable` and `probe_failed` deliberately do NOT get a healthy tone: we do
 * not know the loop is up, and colouring uncertainty green is what the runtime
 * card exists to prevent. `not_running` is danger because it is both certain and
 * actionable.
 */
export function runtimeStatusTone(status: string): PanelTone {
  switch (status) {
    case 'running':
      return 'ok';
    case 'not_running':
      return 'danger';
    case 'unreachable':
    case 'probe_failed':
      return 'unknown';
    default:
      return 'unknown';
  }
}

export function runtimeStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      return 'RUNNING';
    case 'not_running':
      return 'NOT RUNNING';
    case 'unreachable':
      return 'UNREACHABLE';
    case 'probe_failed':
      return 'PROBE FAILED';
    default:
      return 'UNKNOWN';
  }
}

const RISK_TONES: Record<string, PanelTone> = {
  low: 'ok',
  medium: 'warn',
  high: 'danger',
  critical: 'danger',
};

export function riskTone(risk: string | undefined): PanelTone {
  if (!risk) {
    return 'unknown';
  }
  return RISK_TONES[risk] ?? 'unknown';
}

const TIMELINE_KIND_TONES: Record<string, PanelTone> = {
  proposal_created: 'info',
  proposal_accepted: 'ok',
  proposal_executed: 'ok',
  proposal_blocked: 'warn',
  proposal_dismissed: 'unknown',
  proposal_snoozed: 'unknown',
  proposal_failed: 'danger',
  outcome_signal_recorded: 'info',
  feedback_recorded: 'info',
  approved_command_recorded: 'warn',
  approved_command_previewed: 'info',
  source_suppressed: 'warn',
  wakeup_recorded: 'info',
};

export function timelineKindTone(kind: string): PanelTone {
  return TIMELINE_KIND_TONES[kind] ?? 'unknown';
}

export function timelineKindLabel(kind: string): string {
  return kind.replace(/_/g, ' ');
}

/**
 * Whether a panel's last successful read is old enough to warn about.
 *
 * Only `ready` and `empty` carry a meaningful age -- an `error` panel is already
 * shouting, and stacking a staleness warning on top adds noise, not information.
 */
export function isPanelStale(
  state: PanelState<unknown>,
  now: number,
  intervalMs: number,
  multiplier = 3,
): boolean {
  if (state.kind !== 'ready' && state.kind !== 'empty') {
    return false;
  }
  const threshold = Math.max(intervalMs, 1000) * multiplier;
  return now - state.fetchedAt > threshold;
}

export function panelFetchedAt(state: PanelState<unknown>): number | null {
  if (state.kind === 'idle' || state.kind === 'loading') {
    return null;
  }
  return state.fetchedAt;
}

/**
 * Turn an identifier into a readable label.
 *
 * Handles both conventions that show up in these payloads: timeline kinds and
 * decision lanes are snake_case, while the flight-recorder hard-fail counters
 * are camelCase object keys. A snake_case-only replace silently no-ops on the
 * latter and leaves "staleCurrentClaimCount" on screen.
 */
export function humanizeKey(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
