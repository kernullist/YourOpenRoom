import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatRatio,
  formatRelativeTime,
  formatTimestamp,
  humanizeKey,
  isPanelStale,
  isRatioUnavailable,
  panelFetchedAt,
  riskTone,
  runtimeStatusLabel,
  runtimeStatusTone,
  timelineKindLabel,
  timelineKindTone,
  truncate,
} from '../format';
import type { PanelState } from '../types';

describe('formatDuration', () => {
  it('formats sub-minute spans in seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('formats minutes, hours and days', () => {
    expect(formatDuration(90_000)).toBe('1m');
    expect(formatDuration(59 * 60_000)).toBe('59m');
    expect(formatDuration(3 * 3_600_000 + 12 * 60_000)).toBe('3h 12m');
    expect(formatDuration(50 * 3_600_000)).toBe('2d 2h');
  });

  it('refuses to invent a duration from nonsense input', () => {
    expect(formatDuration(-1)).toBe('-');
    expect(formatDuration(Number.NaN)).toBe('-');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('-');
  });
});

describe('formatTimestamp', () => {
  it('renders a real timestamp', () => {
    expect(formatTimestamp(1_700_000_000_000)).not.toBe('-');
  });

  it('renders missing or zero timestamps as unknown, never as the epoch', () => {
    expect(formatTimestamp(0)).toBe('-');
    expect(formatTimestamp(undefined)).toBe('-');
    expect(formatTimestamp(null)).toBe('-');
    expect(formatTimestamp(Number.NaN)).toBe('-');
  });
});

describe('formatRelativeTime', () => {
  const now = 1_700_000_000_000;

  it('collapses very recent times', () => {
    expect(formatRelativeTime(now - 1000, now)).toBe('just now');
  });

  it('formats past times with an ago suffix', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h 0m ago');
  });

  it('formats clock-skewed future times without going negative', () => {
    expect(formatRelativeTime(now + 2 * 60_000, now)).toBe('in 2m');
  });

  it('falls back to an absolute timestamp beyond a month', () => {
    expect(formatRelativeTime(now - 40 * 24 * 3_600_000, now)).not.toContain('ago');
  });

  it('returns unknown for missing values', () => {
    expect(formatRelativeTime(0, now)).toBe('-');
    expect(formatRelativeTime(undefined, now)).toBe('-');
  });
});

describe('formatRatio', () => {
  it('formats a real ratio as a percentage', () => {
    expect(formatRatio(0.8123, 10, 3)).toBe('81.2%');
    expect(formatRatio(0, 10, 3)).toBe('0.0%');
    expect(formatRatio(1, 10, 3)).toBe('100.0%');
  });

  it('never renders an unavailable ratio as zero percent', () => {
    // This is the load-bearing assertion of the whole app: buildAoiClosedLoopMetrics
    // returns null when the denominator is below minSample, and turning that into
    // "0.0%" would fabricate a failing score out of missing evidence.
    expect(formatRatio(null, 1, 3)).toBe('표본 부족 (1/3)');
    expect(formatRatio(undefined, 0, 3)).toBe('표본 부족 (0/3)');
    expect(formatRatio(null, 1, 3)).not.toContain('0.0%');
  });

  it('flags unavailability separately from a zero value', () => {
    expect(isRatioUnavailable(null)).toBe(true);
    expect(isRatioUnavailable(undefined)).toBe(true);
    expect(isRatioUnavailable(Number.NaN)).toBe(true);
    expect(isRatioUnavailable(0)).toBe(false);
  });
});

describe('runtimeStatusTone', () => {
  it('treats only a confirmed running loop as healthy', () => {
    expect(runtimeStatusTone('running')).toBe('ok');
  });

  it('never colours uncertainty as healthy', () => {
    // 'unreachable' and 'probe_failed' mean we do not know. Rendering them green
    // is precisely the lie the runtime card was built to stop.
    expect(runtimeStatusTone('unreachable')).toBe('unknown');
    expect(runtimeStatusTone('probe_failed')).toBe('unknown');
    expect(runtimeStatusTone('something-new')).toBe('unknown');
  });

  it('marks a confirmed dead daemon as danger, since it is actionable', () => {
    expect(runtimeStatusTone('not_running')).toBe('danger');
  });

  it('labels every status distinctly', () => {
    const labels = [
      runtimeStatusLabel('running'),
      runtimeStatusLabel('not_running'),
      runtimeStatusLabel('unreachable'),
      runtimeStatusLabel('probe_failed'),
    ];
    expect(new Set(labels).size).toBe(4);
    expect(runtimeStatusLabel('bogus')).toBe('UNKNOWN');
  });
});

describe('riskTone', () => {
  it('maps known risk levels', () => {
    expect(riskTone('low')).toBe('ok');
    expect(riskTone('medium')).toBe('warn');
    expect(riskTone('high')).toBe('danger');
    expect(riskTone('critical')).toBe('danger');
  });

  it('does not downgrade an unknown risk to safe', () => {
    expect(riskTone(undefined)).toBe('unknown');
    expect(riskTone('exotic')).toBe('unknown');
  });
});

describe('timelineKind helpers', () => {
  it('separates success, warning and failure kinds', () => {
    expect(timelineKindTone('proposal_executed')).toBe('ok');
    expect(timelineKindTone('proposal_blocked')).toBe('warn');
    expect(timelineKindTone('proposal_failed')).toBe('danger');
  });

  it('falls back to unknown for kinds added later', () => {
    expect(timelineKindTone('kind_from_the_future')).toBe('unknown');
  });

  it('humanizes the kind label', () => {
    expect(timelineKindLabel('proposal_created')).toBe('proposal created');
  });
});

describe('isPanelStale', () => {
  const now = 1_000_000;

  function readyAt(fetchedAt: number): PanelState<number> {
    return { kind: 'ready', data: 1, fetchedAt };
  }

  it('is false while the data is within the staleness window', () => {
    expect(isPanelStale(readyAt(now - 10_000), now, 10_000)).toBe(false);
    expect(isPanelStale(readyAt(now - 29_000), now, 10_000)).toBe(false);
  });

  it('is true once the data outlives three refresh intervals', () => {
    expect(isPanelStale(readyAt(now - 31_000), now, 10_000)).toBe(true);
  });

  it('applies to empty panels too, since an empty read also ages', () => {
    expect(
      isPanelStale({ kind: 'empty', reason: 'none', fetchedAt: now - 60_000 }, now, 10_000),
    ).toBe(true);
  });

  it('never stacks a staleness warning on a panel that is already erroring', () => {
    expect(
      isPanelStale({ kind: 'error', message: 'boom', fetchedAt: now - 999_999 }, now, 10_000),
    ).toBe(false);
    expect(isPanelStale({ kind: 'loading' }, now, 10_000)).toBe(false);
    expect(isPanelStale({ kind: 'idle' }, now, 10_000)).toBe(false);
  });

  it('clamps absurdly small intervals so a fast poll does not mark everything stale', () => {
    expect(isPanelStale(readyAt(now - 2000), now, 0)).toBe(false);
  });
});

describe('panelFetchedAt', () => {
  it('returns the timestamp for settled panels', () => {
    expect(panelFetchedAt({ kind: 'ready', data: 1, fetchedAt: 42 })).toBe(42);
    expect(panelFetchedAt({ kind: 'empty', reason: 'x', fetchedAt: 43 })).toBe(43);
    expect(panelFetchedAt({ kind: 'error', message: 'x', fetchedAt: 44 })).toBe(44);
  });

  it('returns null before a panel has ever settled', () => {
    expect(panelFetchedAt({ kind: 'idle' })).toBeNull();
    expect(panelFetchedAt({ kind: 'loading' })).toBeNull();
  });
});

describe('humanizeKey', () => {
  it('splits snake_case', () => {
    expect(humanizeKey('proposal_created')).toBe('proposal created');
    expect(humanizeKey('direct_chat')).toBe('direct chat');
  });

  it('splits camelCase, which a snake_case-only replace silently misses', () => {
    // The flight-recorder hard-fail counters are camelCase object keys; without
    // this branch "staleCurrentClaimCount" reached the screen verbatim.
    expect(humanizeKey('staleCurrentClaimCount')).toBe('stale current claim count');
    expect(humanizeKey('approvalBypassCount')).toBe('approval bypass count');
  });

  it('handles digits and already-plain words', () => {
    expect(humanizeKey('level2Count')).toBe('level2 count');
    expect(humanizeKey('workspace')).toBe('workspace');
    expect(humanizeKey('')).toBe('');
  });
});

describe('truncate', () => {
  it('leaves short strings alone', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('exactlyten', 10)).toBe('exactlyten');
  });

  it('ellipsizes longer strings to the requested length', () => {
    expect(truncate('abcdefghijk', 5)).toBe('abcd…');
    expect(truncate('abcdefghijk', 5)).toHaveLength(5);
  });

  it('handles a zero budget without throwing', () => {
    expect(truncate('abc', 0)).toBe('…');
  });
});
