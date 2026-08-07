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

// 'empty' means the model answered in the requested shape and found nothing
// durable -- a correct answer. 'malformed' means it did not answer in that
// shape at all, which is a failure that used to be indistinguishable from
// 'empty' and therefore reported as healthy.
export type AoiDistillerOutcome = 'ok' | 'empty' | 'malformed' | 'timeout' | 'error';

const OUTCOMES: readonly AoiDistillerOutcome[] = ['ok', 'empty', 'malformed', 'timeout', 'error'];

export interface AoiDistillerAttempt {
  outcome: AoiDistillerOutcome;
  at: number;
  // Wall time across ALL attempts for this turn, retries included.
  totalDurationMs: number;
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
  malformedCount: number;
  timeoutCount: number;
  errorCount: number;
  successRate: number;
  lastOutcome: AoiDistillerOutcome | null;
  lastAt: number | null;
  lastReason: string | null;
  medianTotalDurationMs: number;
}

const STORAGE_KEY = 'aoi-distiller-health-v1';
const MAX_ATTEMPTS = 20;
const MAX_REASON_CHARS = 160;

let cache: AoiDistillerAttempt[] | null = null;

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Sanitize rather than merely type-check: persisted values are attacker- or
// corruption-reachable, and an oversized `reason` that survives the read gets
// re-serialized on the next write until setItem starts throwing quota errors
// forever.
function sanitizeAttempt(value: unknown): AoiDistillerAttempt | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = value as Partial<AoiDistillerAttempt>;
  if (!OUTCOMES.includes(item.outcome as AoiDistillerOutcome)) {
    return null;
  }
  if (typeof item.at !== 'number' || !Number.isFinite(item.at)) {
    return null;
  }
  return {
    outcome: item.outcome as AoiDistillerOutcome,
    at: item.at,
    totalDurationMs: Math.max(0, asFiniteNumber(item.totalDurationMs, 0)),
    attempts: Math.max(0, asFiniteNumber(item.attempts, 0)),
    candidateCount: Math.max(0, asFiniteNumber(item.candidateCount, 0)),
    ...(typeof item.provider === 'string' ? { provider: item.provider.slice(0, 40) } : {}),
    ...(typeof item.model === 'string' ? { model: item.model.slice(0, 80) } : {}),
    ...(typeof item.reason === 'string' ? { reason: item.reason.slice(0, MAX_REASON_CHARS) } : {}),
  };
}

export function loadAoiDistillerAttempts(): AoiDistillerAttempt[] {
  // `cache` is an ARRAY, so a truthiness check treated the empty-but-loaded
  // state and the never-loaded state as the same thing and skipped the read.
  if (cache !== null) {
    return cache;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    cache = Array.isArray(parsed)
      ? parsed
          .map(sanitizeAttempt)
          .filter((item): item is AoiDistillerAttempt => item !== null)
          // Newest first is an invariant the summary relies on; a hand-edited
          // or reordered file must not flip lastOutcome.
          .sort((a, b) => b.at - a.at)
          .slice(0, MAX_ATTEMPTS)
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

// Test seam: drop the in-memory cache so the next load re-reads storage.
export function resetAoiDistillerHealthCache(): void {
  cache = null;
}

// Newest first, capped. Never throws: a diagnostic must not break capture.
export function recordAoiDistillerAttempt(attempt: AoiDistillerAttempt): void {
  const trimmed = sanitizeAttempt(attempt);
  if (!trimmed) {
    return;
  }
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
// answer for a turn that carried nothing durable. 'malformed' does NOT -- it is
// the shape a broken model produces, and counting it as success is what made a
// dead distiller read as 100% healthy.
export function summarizeAoiDistillerHealth(
  attempts: AoiDistillerAttempt[] = loadAoiDistillerAttempts(),
): AoiDistillerHealth {
  const countOf = (outcome: AoiDistillerOutcome): number =>
    attempts.filter((item) => item.outcome === outcome).length;
  const okCount = countOf('ok');
  const emptyCount = countOf('empty');
  const total = attempts.length;
  const newest = attempts[0] ?? null;

  return {
    total,
    okCount,
    emptyCount,
    malformedCount: countOf('malformed'),
    timeoutCount: countOf('timeout'),
    errorCount: countOf('error'),
    successRate: total === 0 ? 0 : (okCount + emptyCount) / total,
    lastOutcome: newest?.outcome ?? null,
    lastAt: newest?.at ?? null,
    lastReason: newest?.reason ?? null,
    medianTotalDurationMs: median(
      attempts
        .map((item) => item.totalDurationMs)
        .filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0),
    ),
  };
}

export function describeAoiDistillerHealth(health: AoiDistillerHealth): string {
  if (health.total === 0) {
    return 'No memory distillation attempts recorded yet.';
  }
  const percent = Math.round(health.successRate * 100);
  const base = `${health.okCount + health.emptyCount}/${health.total} recent turns distilled (${percent}%), median ${health.medianTotalDurationMs}ms`;
  const failures: string[] = [];
  if (health.timeoutCount > 0) {
    failures.push(`${health.timeoutCount} timeout(s)`);
  }
  if (health.malformedCount > 0) {
    failures.push(`${health.malformedCount} malformed response(s)`);
  }
  if (health.errorCount > 0) {
    failures.push(`${health.errorCount} error(s)`);
  }
  return failures.length === 0 ? base : `${base} — ${failures.join(', ')}`;
}
