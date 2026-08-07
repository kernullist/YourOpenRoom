import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAoiDistillerAttempts,
  describeAoiDistillerHealth,
  loadAoiDistillerAttempts,
  recordAoiDistillerAttempt,
  resetAoiDistillerHealthCache,
  summarizeAoiDistillerHealth,
  type AoiDistillerAttempt,
} from '../aoiMemoryDistillerHealth';

const NOW = 1_700_000_000_000;
const STORAGE_KEY = 'aoi-distiller-health-v1';

function attempt(overrides: Partial<AoiDistillerAttempt> = {}): AoiDistillerAttempt {
  return {
    outcome: 'ok',
    at: NOW,
    totalDurationMs: 1200,
    attempts: 1,
    candidateCount: 2,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  clearAoiDistillerAttempts();
});

describe('recordAoiDistillerAttempt', () => {
  it('stores newest first and caps the ring buffer at 20', () => {
    for (let i = 0; i < 25; i += 1) {
      recordAoiDistillerAttempt(attempt({ at: NOW + i, candidateCount: i }));
    }
    const stored = loadAoiDistillerAttempts();
    expect(stored).toHaveLength(20);
    expect(stored[0].candidateCount).toBe(24);
  });

  it('truncates the failure reason and never stores transcript text', () => {
    recordAoiDistillerAttempt(attempt({ outcome: 'error', reason: 'x'.repeat(500) }));
    expect(loadAoiDistillerAttempts()[0].reason).toHaveLength(160);
  });

  it('survives a reload through localStorage', () => {
    recordAoiDistillerAttempt(attempt({ outcome: 'timeout' }));
    // Drop only the in-memory cache: this is what a page reload looks like.
    resetAoiDistillerHealthCache();
    expect(loadAoiDistillerAttempts()[0].outcome).toBe('timeout');
  });

  it('ignores malformed persisted entries on the real read path', () => {
    // Must exercise the parse: an empty in-memory cache used to short-circuit
    // the read, so this assertion passed without ever calling JSON.parse.
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ junk: true }, 42, null]));
    resetAoiDistillerHealthCache();
    expect(loadAoiDistillerAttempts()).toEqual([]);
    expect(summarizeAoiDistillerHealth().total).toBe(0);
  });

  it('truncates a hostile oversized reason on READ, not just on write', () => {
    // A giant reason that survives the read gets re-serialized on the next
    // write until setItem throws quota errors forever.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ ...attempt({ outcome: 'error' }), reason: 'x'.repeat(50_000) }]),
    );
    resetAoiDistillerHealthCache();
    expect(loadAoiDistillerAttempts()[0].reason).toHaveLength(160);
  });

  it('re-sorts persisted entries newest-first so lastOutcome is right', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        attempt({ outcome: 'ok', at: NOW - 5000 }),
        attempt({ outcome: 'timeout', at: NOW }),
      ]),
    );
    resetAoiDistillerHealthCache();
    expect(summarizeAoiDistillerHealth().lastOutcome).toBe('timeout');
  });

  it('coerces junk numeric fields instead of trusting them', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ outcome: 'ok', at: NOW, totalDurationMs: 'nope', attempts: -3 }]),
    );
    resetAoiDistillerHealthCache();
    const [stored] = loadAoiDistillerAttempts();
    expect(stored.totalDurationMs).toBe(0);
    expect(stored.attempts).toBe(0);
  });
});

describe('summarizeAoiDistillerHealth', () => {
  it('counts an empty result as a success, not a failure', () => {
    const health = summarizeAoiDistillerHealth([
      attempt({ outcome: 'ok' }),
      attempt({ outcome: 'empty', candidateCount: 0 }),
    ]);
    // A turn with nothing durable in it is a correct distiller answer.
    expect(health.successRate).toBe(1);
    expect(health.emptyCount).toBe(1);
  });

  it('separates timeouts from other errors and reports the median duration', () => {
    const health = summarizeAoiDistillerHealth([
      attempt({ outcome: 'timeout', totalDurationMs: 20_000 }),
      attempt({ outcome: 'error', totalDurationMs: 400 }),
      attempt({ outcome: 'ok', totalDurationMs: 1000 }),
    ]);

    expect(health.timeoutCount).toBe(1);
    expect(health.errorCount).toBe(1);
    expect(health.successRate).toBeCloseTo(1 / 3, 5);
    expect(health.medianTotalDurationMs).toBe(1000);
    expect(health.lastOutcome).toBe('timeout');
  });

  it('counts a malformed response as a FAILURE, not an empty turn', () => {
    // The whole point of the module: a model emitting prose instead of JSON
    // produced zero candidates and used to score identically to a turn that
    // genuinely carried nothing durable -- reporting a dead distiller as 100%.
    const health = summarizeAoiDistillerHealth([
      attempt({ outcome: 'malformed', candidateCount: 0 }),
      attempt({ outcome: 'malformed', candidateCount: 0 }),
    ]);

    expect(health.malformedCount).toBe(2);
    expect(health.successRate).toBe(0);
    expect(describeAoiDistillerHealth(health)).toContain('2 malformed response(s)');
  });

  it('reports an empty history without dividing by zero', () => {
    const health = summarizeAoiDistillerHealth([]);
    expect(health).toMatchObject({ total: 0, successRate: 0, lastOutcome: null });
    expect(describeAoiDistillerHealth(health)).toContain('No memory distillation attempts');
  });
});

describe('describeAoiDistillerHealth', () => {
  it('names the failure counts when capture is degrading', () => {
    const text = describeAoiDistillerHealth(
      summarizeAoiDistillerHealth([
        attempt({ outcome: 'ok', totalDurationMs: 900 }),
        attempt({ outcome: 'timeout', totalDurationMs: 20_000 }),
      ]),
    );
    expect(text).toContain('1/2 recent turns distilled (50%)');
    expect(text).toContain('1 timeout(s)');
  });

  it('stays quiet about failures when there are none', () => {
    const text = describeAoiDistillerHealth(
      summarizeAoiDistillerHealth([attempt(), attempt({ outcome: 'empty' })]),
    );
    expect(text).toContain('2/2 recent turns distilled (100%)');
    expect(text).not.toContain('timeout');
  });
});
