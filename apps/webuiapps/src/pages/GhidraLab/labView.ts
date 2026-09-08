// Pure view logic for Ghidra Lab.
//
// Everything here is a function of data with no React and no fetch, so the parts
// most likely to mislead an operator -- what a session is waiting on, what a
// failed preflight means, how far a sweep has got -- can be tested directly.
import type {
  GhidraLabBrowseEntry,
  GhidraLabHealthView,
  GhidraLabPreflightCheck,
  GhidraLabSessionView,
  GhidraReportRunView,
  GhidraSweepStageView,
} from '@/lib/ghidraLabTypes';

export type LabStatusTone = 'ok' | 'warn' | 'error' | 'idle';

export interface LabStatus {
  tone: LabStatusTone;
  label: string;
  detail: string;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0s';
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * One line for the header.
 *
 * The distinction that matters: a lab that is merely unconfigured is idle, but a
 * lab whose configured JDK is the wrong version is an ERROR -- it looks set up
 * and will hang if used, which is the failure this whole feature is shaped
 * around.
 */
export function describeHealth(health: GhidraLabHealthView | null): LabStatus {
  if (!health) {
    return { tone: 'idle', label: 'Not loaded', detail: '' };
  }
  if (health.globalPanic) {
    return { tone: 'error', label: 'Panic', detail: 'Global panic is on; nothing will start.' };
  }
  if (!health.analysisCapabilityEnabled) {
    return {
      tone: 'warn',
      label: 'Capability off',
      detail: 'os_ghidra_analysis is disabled, so sessions cannot be started.',
    };
  }
  const failing = health.checks.filter((check) => !check.ok && check.required);
  if (failing.length > 0) {
    const configured = failing.filter((check) => check.found !== 'not set');
    if (configured.length > 0) {
      // Something is set but wrong -- name it, because "not configured" would
      // send the operator looking in the wrong place.
      return {
        tone: 'error',
        label: `${configured[0].label}: ${configured[0].found}`,
        detail: configured[0].remedy,
      };
    }
    return {
      tone: 'idle',
      label: 'Setup needed',
      detail: `${failing.length} required path${failing.length === 1 ? '' : 's'} not set.`,
    };
  }
  if (!health.availableModes.includes('headless')) {
    return {
      tone: 'warn',
      label: 'Batch only',
      detail: 'pyghidra-mcp is not available, so follow-up questions are not possible yet.',
    };
  }
  return {
    tone: 'ok',
    label: health.ghidraVersion ? `Ghidra ${health.ghidraVersion}` : 'Ready',
    detail: health.jdkVersion || '',
  };
}

export function preflightTone(check: GhidraLabPreflightCheck): LabStatusTone {
  if (check.ok) {
    return 'ok';
  }
  if (!check.required) {
    return 'idle';
  }
  return check.found === 'not set' ? 'warn' : 'error';
}

export function sessionStateLabel(session: GhidraLabSessionView): string {
  switch (session.state) {
    case 'starting':
      return 'Starting';
    case 'ready':
      return 'Ready';
    case 'failed':
      return 'Failed';
    default:
      return 'Stopped';
  }
}

export function isSessionQueryable(session: GhidraLabSessionView | null): boolean {
  return Boolean(session && session.state === 'ready');
}

export interface LabProgress {
  headline: string;
  detail: string;
}

/**
 * What a starting session is actually waiting on.
 *
 * There is no percentage, because Ghidra reports analysis as done or not-done
 * and never as a fraction. What there IS is the phase, and it is worth showing:
 * "the engine is not answering yet" points at the install, while "still
 * analyzing" points at the binary. Telling the operator the wrong one costs them
 * the whole analysis timeout.
 */
export function describeProgress(session: GhidraLabSessionView, now: number): LabProgress | null {
  if (session.state !== 'starting') {
    return null;
  }
  const elapsed = formatElapsed(Math.max(0, now - session.startedAt));
  const progress = session.progress;
  if (!progress) {
    return { headline: `Starting (${elapsed})`, detail: 'Waiting for the engine to come up.' };
  }
  if (progress.phase === 'jvm') {
    return {
      headline: `Booting the JVM (${elapsed})`,
      detail:
        'Ghidra has not answered yet. If this does not clear, the Ghidra folder or the JDK path is wrong.',
    };
  }
  const growth =
    progress.deltaBytes > 0
      ? `project grew ${formatBytes(progress.deltaBytes)} since the last check`
      : 'no measurable growth this tick';
  return {
    headline: `Analyzing (${elapsed})`,
    detail: `Engine is up; Ghidra is still analyzing. Project is ${formatBytes(progress.projectBytes)}, ${growth}.`,
  };
}

export function runStateLabel(run: GhidraReportRunView): string {
  switch (run.state) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Sweeping';
    case 'drafting':
      return 'Writing report';
    case 'verifying':
      return 'Verifying';
    case 'done':
      return 'Done';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Failed';
  }
}

export interface RunProgressSummary {
  done: number;
  total: number;
  current: string;
  failed: string[];
}

/** Stage counts for the run row. Skipped stages count as finished, not pending:
 *  a skipped capa stage is a decision, not work still to do. */
export function summarizeRunStages(stages: readonly GhidraSweepStageView[]): RunProgressSummary {
  const total = stages.length;
  let done = 0;
  let current = '';
  const failed: string[] = [];
  for (const stage of stages) {
    if (stage.state === 'done' || stage.state === 'skipped') {
      done += 1;
    }
    if (stage.state === 'failed') {
      done += 1;
      failed.push(stage.stage);
    }
    if (stage.state === 'running' && !current) {
      current = stage.stage;
    }
  }
  return { done, total, current, failed };
}

export function isRunActive(run: GhidraReportRunView): boolean {
  return (
    run.state === 'queued' ||
    run.state === 'running' ||
    run.state === 'drafting' ||
    run.state === 'verifying'
  );
}

export function sortBrowseEntries(
  entries: readonly GhidraLabBrowseEntry[],
): GhidraLabBrowseEntry[] {
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

export interface LabBreadcrumb {
  label: string;
  path: string;
}

export function buildBreadcrumbs(
  path: string,
  roots: readonly { id: string; path: string; label: string }[],
): LabBreadcrumb[] {
  if (!path) {
    return [];
  }
  const root = roots.find((entry) => path.toLowerCase().startsWith(entry.path.toLowerCase()));
  if (!root) {
    return [{ label: path, path }];
  }
  const crumbs: LabBreadcrumb[] = [{ label: root.label || root.id, path: root.path }];
  const rest = path.slice(root.path.length).replace(/^[\\/]+/, '');
  if (!rest) {
    return crumbs;
  }
  let cursor = root.path;
  const separator = root.path.includes('\\') ? '\\' : '/';
  for (const segment of rest.split(/[\\/]+/)) {
    if (!segment) {
      continue;
    }
    cursor = `${cursor}${cursor.endsWith(separator) ? '' : separator}${segment}`;
    crumbs.push({ label: segment, path: cursor });
  }
  return crumbs;
}

/**
 * Turn an API error into something an operator can act on.
 *
 * The route's error codes are the explanation; this maps the ones whose bare
 * code would not be self-explanatory in a UI.
 */
export function explainLabError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (!message) {
    return 'Something failed with no error text.';
  }
  if (message.includes('preflight_jdk')) {
    return 'The configured JDK is not usable by Ghidra. Check the JDK row in Setup.';
  }
  if (message.includes('preflight_ghidra')) {
    return 'The Ghidra folder is not a Ghidra install. Check the Ghidra row in Setup.';
  }
  if (message.includes('preflight_projects')) {
    return 'The project folder cannot be written. Check the Project folder row in Setup.';
  }
  if (message.includes('preflight_roots') || message.includes('no_binary_roots')) {
    return 'No usable binary root. Add a folder in Setup before analyzing anything.';
  }
  if (message.includes('headless_mode_unavailable')) {
    return 'Headless mode needs a working pyghidra-mcp. Use Bootstrap in Setup, or fix the Python row.';
  }
  if (message.includes('path_outside_roots')) {
    return 'That path is outside every registered root, so it cannot be analyzed.';
  }
  if (message.includes('session_already_open')) {
    return 'A session for that binary is already open. Reuse it instead of starting another.';
  }
  if (message.includes('too_many_sessions')) {
    return 'Too many sessions are open. Each one is a JVM; stop one first.';
  }
  if (message.includes('not_authenticated')) {
    return 'The local host-bridge token was rejected. Restart the dev server.';
  }
  if (message.includes('capability_disabled') || message.includes('os_ghidra_analysis')) {
    return 'The os_ghidra_analysis capability is off. Enable it in Settings before analyzing.';
  }
  return message;
}
