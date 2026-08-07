// Visibility for the LLM memory distiller.
//
// The distiller is a best-effort side channel: on timeout or provider error it
// falls back to the regex heuristics and the turn proceeds normally. That is
// the right behavior, but it made a persistently broken distiller INVISIBLE --
// capture quietly degraded to keyword rules for weeks with only a console
// warning. This records the outcome of recent attempts so the settings panel
// can show whether capture is actually working.
//
// Diagnostics only: no memory content is stored, just outcomes and timings.

export type AoiDistillerOutcome = 'ok' | 'empty' | 'timeout' | 'error';

export interface AoiDistillerAttempt {
  outcome: AoiDistillerOutcome;
  at: number;
  durationMs: number;
  attempts: number;
  candidateCount: number;
  // Provider/model that ran it, so a bad model choice is identifiable.
  provider?: string;
  model?: string;
  // Short failure reason; never the transcript.
  reason?: string;
}

export interface AoiDistillerHealth {
  total: number;
  okCount: number;
  emptyCount: number;
  timeoutCount: number;
  errorCount: number;
  successRate: number;
  lastOutcome: AoiDistillerOutcome | null;
  lastAt: number | null;
  lastReason: string | null;
  medianDurationMs: number;
}

const STORAGE_KEY = 'aoi-distiller-health-v1';
const MAX_ATTEMPTS = 20;
const MAX_REASON_CHARS = 160;

let cache: AoiDistillerAttempt[] | null = null;

function isAttempt(value: unknown): value is AoiDistillerAttempt {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Partial<AoiDistillerAttempt>;
  return (
    (item.outcome === 'ok' ||
      item.outcome === 'empty' ||
      item.outcome === 'timeout' ||
      item.outcome === 'error') &&
    typeof item.at === 'number' &&
    Number.isFinite(item.at)
  );
}

export function loadAoiDistillerAttempts(): AoiDistillerAttempt[] {
  if (cache) {
    return cache;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    cache = Array.isArray(parsed) ? parsed.filter(isAttempt).slice(0, MAX_ATTEMPTS) : [];
  } catch {
    cache = [];
  }
  return cache;
}

// Newest first, capped. Never throws: a diagnostic must not break capture.
export function recordAoiDistillerAttempt(attempt: AoiDistillerAttempt): void {
  const trimmed: AoiDistillerAttempt = {
    ...attempt,
    ...(attempt.reason ? { reason: attempt.reason.slice(0, MAX_REASON_CHARS) } : {}),
  };
  const next = [trimmed, ...loadAoiDistillerAttempts()].slice(0, MAX_ATTEMPTS);
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best-effort persistence; the in-memory cache still serves this session.
  }
}

export function clearAoiDistillerAttempts(): void {
  cache = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

// 'empty' counts as a success: returning no memories is a legitimate distiller
// answer for a turn that carried nothing durable, not a failure.
export function summarizeAoiDistillerHealth(
  attempts: AoiDistillerAttempt[] = loadAoiDistillerAttempts(),
): AoiDistillerHealth {
  const okCount = attempts.filter((item) => item.outcome === 'ok').length;
  const emptyCount = attempts.filter((item) => item.outcome === 'empty').length;
  const timeoutCount = attempts.filter((item) => item.outcome === 'timeout').length;
  const errorCount = attempts.filter((item) => item.outcome === 'error').length;
  const total = attempts.length;
  const newest = attempts[0] ?? null;

  return {
    total,
    okCount,
    emptyCount,
    timeoutCount,
    errorCount,
    successRate: total === 0 ? 0 : (okCount + emptyCount) / total,
    lastOutcome: newest?.outcome ?? null,
    lastAt: newest?.at ?? null,
    lastReason: newest?.reason ?? null,
    medianDurationMs: median(
      attempts
        .map((item) => item.durationMs)
        .filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0),
    ),
  };
}

export function describeAoiDistillerHealth(health: AoiDistillerHealth): string {
  if (health.total === 0) {
    return 'No memory distillation attempts recorded yet.';
  }
  const percent = Math.round(health.successRate * 100);
  const failures = health.timeoutCount + health.errorCount;
  const base = `${health.okCount + health.emptyCount}/${health.total} recent turns distilled (${percent}%), median ${health.medianDurationMs}ms`;
  if (failures === 0) {
    return base;
  }
  return `${base} — ${health.timeoutCount} timeout(s), ${health.errorCount} error(s)`;
}
