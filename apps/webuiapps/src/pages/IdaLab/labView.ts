// Pure view helpers for IDA Lab. Kept out of the component so the labels an
// operator makes decisions from ("read-only", "analyzing", "capability off") are
// unit-testable without rendering.
import type {
  IdaSqlBrowseEntry,
  IdaSqlHealthView,
  IdaSqlSessionView,
  IdaSqlStandingGrantView,
} from '@/lib/idaSqlTypes';

export type LabStatusTone = 'ok' | 'warn' | 'error' | 'idle';

export interface LabStatus {
  tone: LabStatusTone;
  text: string;
  /** The one thing to do next, when there is one. */
  action: string;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '-';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * One line describing whether this machine can analyze anything right now.
 * Order matters: panic outranks a missing capability, which outranks a missing
 * path, because that is the order the operator has to fix them in.
 */
export function describeHealth(health: IdaSqlHealthView | null): LabStatus {
  if (!health) {
    return { tone: 'idle', text: 'Not loaded', action: '' };
  }
  if (health.globalPanic) {
    return {
      tone: 'error',
      text: 'Host bridge panic is engaged',
      action: 'Clear panic in Settings > Advanced > Host PC.',
    };
  }
  if (!health.analysisCapabilityEnabled) {
    return {
      tone: 'error',
      text: 'IDA analysis capability is off',
      action: 'Enable "IDA Lab: analyze binaries" in Settings > Advanced > Host PC.',
    };
  }
  if (!health.config.idasqlExePath) {
    return {
      tone: 'warn',
      text: 'idasql path is not set',
      action: 'Set it in this app under Setup.',
    };
  }
  if (!health.idasqlPresent) {
    return {
      tone: 'warn',
      text: 'idasql was not found at the configured path',
      action: 'Download the idasql release and put it next to the IDA binary.',
    };
  }
  if (health.config.binaryRoots.length === 0) {
    return {
      tone: 'warn',
      text: 'No binary roots registered',
      action: 'Add a folder under Setup: nothing can be analyzed outside a root.',
    };
  }
  if (!health.idalibPresent) {
    return {
      tone: 'warn',
      text: 'idalib was not found next to IDA',
      action: 'Headless mode needs idalib; use GUI mode or point at an IDA build that has it.',
    };
  }
  return {
    tone: 'ok',
    text: health.idasqlVersion ? `Ready (${health.idasqlVersion})` : 'Ready',
    action: '',
  };
}

export function sessionStateLabel(session: IdaSqlSessionView): string {
  if (session.state === 'starting') {
    return session.mode === 'headless' ? 'analyzing' : 'attaching';
  }
  if (session.state === 'failed') {
    return session.failureReason ? `failed (${session.failureReason})` : 'failed';
  }
  return session.state;
}

export function isSessionQueryable(session: IdaSqlSessionView | null): boolean {
  return Boolean(session && session.state === 'ready');
}

export interface LabProgress {
  /** How long the analysis has been running, already formatted. */
  elapsed: string;
  /** What the database weighs on disk right now, or '' before the first sample. */
  size: string;
  /** Growth since the previous sample, or '' when there is nothing to compare. */
  delta: string;
  /** Plain-language state, for the operator who is watching and wondering. */
  detail: string;
  /** True while the analysis is visibly doing work. */
  working: boolean;
}

// The server's readiness poll backs off to 2s between samples; allow that plus
// a margin for the round trip before a reading counts as old news.
const SAMPLE_FRESH_MS = 3500;

export function formatElapsed(ms: number): string {
  // Math.max(0, NaN) is NaN, so an unvalidated duration rendered as "NaNs".
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Describe a running analysis using only what can actually be observed.
 *
 * There is deliberately no percentage. Measured against a real install: idasql
 * prints one `Opening: ...` line and then says nothing until it finishes, and
 * it has no verbosity flag. Time and the database growing on disk are the whole
 * of the evidence, and neither yields a fraction of a total nothing reports.
 * Showing an invented bar would tell the operator something we do not know.
 */
export function describeProgress(session: IdaSqlSessionView, now: number): LabProgress | null {
  if (session.state !== 'starting') {
    return null;
  }
  const elapsed = formatElapsed(now - session.startedAt);
  const progress = session.progress;
  // A sample of zero bytes is not a measurement of the database, it is the
  // moment before IDA has written one. Rendering it as a size produced a bare
  // "-" that read as broken; it belongs in the same branch as "no sample yet".
  //
  // The finiteness check is not decoration. The client casts the /sessions body
  // straight to its view type without validation, so a NaN or a string reaching
  // here would pass a bare `<= 0` test and render "-" and "NaNs ago" to the
  // operator. Requiring a real number states what this branch actually needs.
  if (
    !progress ||
    !Number.isFinite(progress.databaseBytes) ||
    !Number.isFinite(progress.sampledAt) ||
    progress.sampleCount === 0 ||
    progress.databaseBytes <= 0
  ) {
    return {
      elapsed,
      size: '',
      delta: '',
      // Only a headless session is ever 'starting': attachGui either finds the
      // server inside IDA and returns a session already 'ready', or returns no
      // session at all. A branch here for a starting GUI session would be text
      // nobody can reach.
      detail:
        'IDA is loading the binary. It reports nothing until analysis finishes, so this is timed, not measured.',
      working: true,
    };
  }
  const size = formatBytes(progress.databaseBytes);
  // The server samples inside its readiness poll, which backs off to 2s; the UI
  // asks more often than that. Without checking the reading's age the same
  // sample rendered repeatedly, delta and all -- so a sampler that had stopped
  // still showed "+2.8 MB, growing" against a size that had not moved. Claiming
  // growth from a reading we already showed is the exact dishonesty this panel
  // exists to avoid.
  const ageMs = Math.max(0, now - progress.sampledAt);
  const fresh = ageMs <= SAMPLE_FRESH_MS;
  const grew = progress.deltaBytes > 0;
  if (!fresh) {
    return {
      elapsed,
      size,
      delta: '',
      detail: `Last reading ${formatElapsed(ageMs)} ago; nothing newer has been measured yet. IDA reports no percentage, so the database on disk is the only signal.`,
      working: false,
    };
  }
  return {
    elapsed,
    size,
    delta: grew ? `+${formatBytes(progress.deltaBytes)}` : '',
    detail: grew
      ? 'The IDA database is growing on disk, so analysis is doing work. There is no percentage: IDA does not report one.'
      : 'The database has not grown since the last check. Large binaries spend long stretches inside one phase, so this is normal; it only matters if it stays flat for many minutes.',
    working: grew,
  };
}

export interface LabBreadcrumb {
  label: string;
  path: string;
}

/**
 * Breadcrumbs from the containing root down to the current folder. Segments
 * above the root are never offered: they are not browsable, so showing them as
 * links would advertise a click that gets refused.
 */
export function buildBreadcrumbs(
  currentPath: string,
  roots: readonly { id: string; path: string; label: string }[],
): LabBreadcrumb[] {
  if (!currentPath) {
    return [];
  }
  const lowered = currentPath.toLowerCase().replace(/[\\/]+$/, '');
  const root = roots
    .filter((entry) => lowered.startsWith(entry.path.toLowerCase().replace(/[\\/]+$/, '')))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (!root) {
    return [{ label: currentPath, path: currentPath }];
  }
  const rootPath = root.path.replace(/[\\/]+$/, '');
  const crumbs: LabBreadcrumb[] = [{ label: root.label, path: rootPath }];
  const rest = currentPath.slice(rootPath.length).replace(/^[\\/]+/, '');
  if (!rest) {
    return crumbs;
  }
  const separator = currentPath.includes('\\') ? '\\' : '/';
  let walk = rootPath;
  for (const segment of rest.split(/[\\/]+/)) {
    if (!segment) {
      continue;
    }
    walk = `${walk}${separator}${segment}`;
    crumbs.push({ label: segment, path: walk });
  }
  return crumbs;
}

export function sortBrowseEntries(entries: readonly IdaSqlBrowseEntry[]): IdaSqlBrowseEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1;
    }
    if (left.analyzable !== right.analyzable) {
      return left.analyzable ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export function grantRemainingLabel(grant: IdaSqlStandingGrantView, now: number): string {
  const remainingMs = grant.expiresAt - now;
  if (remainingMs <= 0) {
    return 'expired';
  }
  const minutes = Math.round(remainingMs / 60000);
  const budget = `${grant.maxSessions - grant.usedSessions}/${grant.maxSessions} left`;
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m, ${budget}`
    : `${minutes}m, ${budget}`;
}

/**
 * Map a thrown client error to what the operator should read. The server sends
 * codes, not prose, and the codes are the diagnosis.
 */
export function explainLabError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // The write codes are checked BEFORE the generic capability code: both are
  // capability refusals, but a write needs two switches, and the generic hint
  // sends the operator to only one of them.
  if (/write_not_enabled_in_settings|write_capability_disabled/.test(message)) {
    return `${message} - writes need both the Setup toggle and the os_ida_write capability.`;
  }
  if (/capability_disabled|host_bridge_panic/.test(message)) {
    return `${message} - enable it in Settings > Advanced > Host PC.`;
  }
  if (/path_outside_roots|no_binary_roots/.test(message)) {
    return `${message} - add the folder to the binary roots under Setup.`;
  }
  if (/session_is_read_only/.test(message)) {
    return `${message} - start a write session for this binary first.`;
  }
  if (/gui_server_requires_token/.test(message)) {
    return `${message} - a server answered on that port but wants a token. Attach with the token you gave IDA's idasql server.`;
  }
  if (/gui_server_unrecognized/.test(message)) {
    return `${message} - something is listening on that port but it did not identify itself as idasql, so no SQL was sent to it. Check that \`.http start\` really bound that port in IDA, or that nothing else on this machine took it.`;
  }
  if (/no_gui_server_found/.test(message)) {
    return `${message} - run \`.http start\` in the idasql CLI inside IDA, then retry.`;
  }
  return message;
}
