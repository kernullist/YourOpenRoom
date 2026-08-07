import { normalizeAoiDaemonHealthSnapshot } from './aoiDaemonHealthClient';
import type { AoiDaemonHealthSnapshot } from './aoiDaemonHealth';

// Pure model for the autonomy runtime status card: route, response parsing, and
// the honest one-line description. Kept out of the component so the "never
// claim running when we do not know" rule is unit-testable.
//
// Why this exists: the daemon's /healthz has always carried the truth
// (loopRunning, cognitionActive, cycles, errors) and nothing user-facing read
// it. The Autonomy panel showed policy toggles that report a state even when no
// loop is running at all, which is the same "built but inert" trap as the
// memory backbone -- except here the UI actively looked healthy.

export const AOI_DAEMON_HEALTH_ROUTE = '/api/aoi-daemon/health';

export type AoiAutonomyRuntimeStatus =
  // The daemon answered and its health snapshot parsed.
  | 'running'
  // Connection refused: the daemon process is simply not up. Actionable.
  | 'not_running'
  // Timeout / socket error / bad payload: we genuinely do not know.
  | 'unreachable'
  // The probe route itself could not be reached (dev server gone, offline build).
  | 'probe_failed';

export interface AoiAutonomyRuntimeView {
  status: AoiAutonomyRuntimeStatus;
  port: number | null;
  snapshot: AoiDaemonHealthSnapshot | null;
}

function asPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

/**
 * Parse the probe response.
 *
 * A malformed snapshot downgrades 'running' to 'unreachable': a daemon that
 * answers with something we cannot validate is not proof that the loop is up,
 * and rendering it as healthy would be exactly the lie this card exists to fix.
 */
export function parseAoiAutonomyRuntimeResponse(raw: unknown): AoiAutonomyRuntimeView {
  if (!raw || typeof raw !== 'object') {
    return { status: 'probe_failed', port: null, snapshot: null };
  }
  const body = raw as Record<string, unknown>;
  const port = asPort(body.port);

  if (body.status === 'not_running') {
    return { status: 'not_running', port, snapshot: null };
  }
  if (body.status === 'running') {
    const snapshot = normalizeAoiDaemonHealthSnapshot(body.snapshot);
    return snapshot
      ? { status: 'running', port, snapshot }
      : { status: 'unreachable', port, snapshot: null };
  }
  if (body.status === 'unreachable') {
    return { status: 'unreachable', port, snapshot: null };
  }
  return { status: 'probe_failed', port, snapshot: null };
}

export function formatAoiRuntimeUptime(uptimeMs: number): string {
  const totalMinutes = Math.floor(uptimeMs / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) {
    return `${hours}h ${totalMinutes % 60}m`;
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The headline sentence.
 *
 * `cognitionActive` (loop running AND the last cycle processed at least one
 * enabled session) is the honest "is Aoi actually thinking" signal -- a running
 * loop whose every session is disabled is idling, and saying otherwise would
 * send the operator hunting for a bug that is really just a policy toggle.
 */
export function describeAoiAutonomyRuntime(view: AoiAutonomyRuntimeView): string {
  switch (view.status) {
    case 'running': {
      const snapshot = view.snapshot;
      if (!snapshot) {
        return 'Daemon reachable, but its health could not be read.';
      }
      const uptime = formatAoiRuntimeUptime(snapshot.uptimeMs);
      if (!snapshot.loopRunning) {
        return `Daemon up ${uptime}, but the background loop is NOT running — nothing below runs on its own.`;
      }
      if (!snapshot.cognitionActive) {
        return `Loop running (up ${uptime}, ${snapshot.cyclesCompleted} cycles) but idle — no session has autonomy enabled.`;
      }
      return `Thinking — loop running ${uptime}, ${snapshot.cyclesCompleted} cycles completed.`;
    }
    case 'not_running':
      return 'The Aoi daemon is not running, so NOTHING below takes effect. Start it with Start-App.ps1 -Aoi.';
    case 'unreachable':
      return `Could not reach the Aoi daemon${view.port ? ` on port ${view.port}` : ''} — status unknown.`;
    default:
      return 'Runtime status unavailable (the probe endpoint did not respond).';
  }
}

// Whether the policy controls below are actually backed by a live loop. Used to
// warn instead of letting the toggles imply an effect they do not have.
export function isAoiAutonomyRuntimeLive(view: AoiAutonomyRuntimeView): boolean {
  return view.status === 'running' && view.snapshot?.loopRunning === true;
}
