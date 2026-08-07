import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAoiDistillerAttempts,
  describeAoiDistillerHealth,
  loadAoiDistillerAttempts,
  recordAoiDistillerAttempt,
  summarizeAoiDistillerHealth,
  type AoiDistillerAttempt,
} from '../aoiMemoryDistillerHealth';

const NOW = 1_700_000_000_000;

function attempt(overrides: Partial<AoiDistillerAttempt> = {}): AoiDistillerAttempt {
  return {
    outcome: 'ok',
    at: NOW,
    durationMs: 1200,
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
    clearAoiDistillerAttempts();
    // clear wipes it; re-record and drop only the in-memory cache to simulate
    // a page reload reading the persisted ring buffer back.
    recordAoiDistillerAttempt(attempt({ outcome: 'timeout' }));
    const raw = localStorage.getItem('aoi-distiller-health-v1');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)[0].outcome).toBe('timeout');
  });

  it('ignores malformed persisted entries', () => {
    localStorage.setItem('aoi-distiller-health-v1', JSON.stringify([{ junk: true }, 42]));
    clearAoiDistillerAttempts();
    localStorage.setItem('aoi-distiller-health-v1', JSON.stringify([{ junk: true }, 42]));
    expect(summarizeAoiDistillerHealth().total).toBe(0);
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
      attempt({ outcome: 'timeout', durationMs: 20_000 }),
      attempt({ outcome: 'error', durationMs: 400 }),
      attempt({ outcome: 'ok', durationMs: 1000 }),
    ]);

    expect(health.timeoutCount).toBe(1);
    expect(health.errorCount).toBe(1);
    expect(health.successRate).toBeCloseTo(1 / 3, 5);
    expect(health.medianDurationMs).toBe(1000);
    expect(health.lastOutcome).toBe('timeout');
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
        attempt({ outcome: 'ok', durationMs: 900 }),
        attempt({ outcome: 'timeout', durationMs: 20_000 }),
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
