import type { AoiDaemonHealthSnapshot } from './aoiDaemonHealth';

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

export function normalizeAoiDaemonHealthSnapshot(value: unknown): AoiDaemonHealthSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status !== 'ok' ||
    !isFiniteNonNegative(record.uptimeMs) ||
    typeof record.loopRunning !== 'boolean' ||
    typeof record.cognitionActive !== 'boolean' ||
    !isFiniteNonNegative(record.cyclesCompleted) ||
    !isFiniteNonNegative(record.errorsTotal)
  ) {
    return null;
  }
  if (record.lastCycle !== null) {
    if (
      !record.lastCycle ||
      typeof record.lastCycle !== 'object' ||
      Array.isArray(record.lastCycle)
    ) {
      return null;
    }
    const cycle = record.lastCycle as Record<string, unknown>;
    if (
      !isFiniteNonNegative(cycle.startedAt) ||
      !isFiniteNonNegative(cycle.durationMs) ||
      !isFiniteNonNegative(cycle.sessionsConsidered) ||
      !isFiniteNonNegative(cycle.sessionsRun) ||
      !isFiniteNonNegative(cycle.sessionsSkipped) ||
      !isFiniteNonNegative(cycle.errorCount)
    ) {
      return null;
    }
  }
  if (record.lastError !== null) {
    if (
      !record.lastError ||
      typeof record.lastError !== 'object' ||
      Array.isArray(record.lastError)
    ) {
      return null;
    }
    const error = record.lastError as Record<string, unknown>;
    if (!isFiniteNonNegative(error.at) || typeof error.message !== 'string') {
      return null;
    }
  }
  return record as unknown as AoiDaemonHealthSnapshot;
}

export async function loadAoiDaemonHealthSnapshot(
  urlValue: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AoiDaemonHealthSnapshot | null> {
  if (!urlValue) {
    return null;
  }
  const url = new URL(urlValue);
  if (!isLoopbackHostname(url.hostname) || url.pathname !== '/healthz') {
    throw new Error('Daemon health URL must target loopback /healthz.');
  }
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      return null;
    }
    return normalizeAoiDaemonHealthSnapshot((await response.json()) as unknown);
  } catch {
    return null;
  }
}
