import { describe, expect, it } from 'vitest';
import type { AoiHostProcessListingView } from '@/lib/aoiHostBridgeClient';
import {
  buildProcessRows,
  filterProcessRows,
  isSampleStale,
  memoryLabel,
  processOverview,
  sampleAgeLabel,
  sortProcessRows,
  type ProcessRow,
} from '../processView';

// A process list is a photograph, and every rule here exists so the operator
// cannot mistake it for a live feed or read a missing measurement as a zero.

function listing(overrides: Partial<AoiHostProcessListingView> = {}): AoiHostProcessListingView {
  return {
    version: 1,
    sampledAt: 1000,
    records: [
      { pid: 10, imageName: 'chrome.exe', memKb: 500_000 },
      { pid: 20, imageName: 'node.exe', memKb: 120_000 },
      { pid: 30, imageName: 'idle.exe' },
    ],
    summary: {
      version: 1,
      sampledAt: 1000,
      totalCount: 3,
      distinctImageCount: 3,
      topImages: [{ imageName: 'chrome.exe', count: 1 }],
    },
    ...overrides,
  };
}

function rows(): ProcessRow[] {
  return buildProcessRows(listing());
}

describe('memoryLabel', () => {
  it('formats kilobytes and megabytes', () => {
    expect(memoryLabel(512)).toBe('512 KB');
    expect(memoryLabel(2048)).toBe('2.0 MB');
  });

  it('renders a missing sample as unknown, never as zero', () => {
    // "0 MB" would read as a measurement showing no usage.
    expect(memoryLabel(undefined)).toBe('-');
    expect(memoryLabel(Number.NaN)).toBe('-');
    expect(memoryLabel(-5)).toBe('-');
  });
});

describe('buildProcessRows', () => {
  it('copies the sampled records', () => {
    expect(rows().map((row) => row.pid)).toEqual([10, 20, 30]);
  });

  it('returns nothing for a missing listing', () => {
    expect(buildProcessRows(null)).toEqual([]);
  });

  it('does not hand back the listing array itself', () => {
    // Sorting later must not reorder the caller's sample in place.
    const source = listing();
    const built = buildProcessRows(source);

    expect(built).not.toBe(source.records);
  });
});

describe('filterProcessRows', () => {
  it('matches on image name and on pid', () => {
    expect(filterProcessRows(rows(), 'chrome')).toHaveLength(1);
    expect(filterProcessRows(rows(), '20')).toHaveLength(1);
  });

  it('is case-insensitive and ignores surrounding space', () => {
    expect(filterProcessRows(rows(), '  CHROME ')).toHaveLength(1);
  });

  it('returns everything for an empty query', () => {
    expect(filterProcessRows(rows(), '   ')).toHaveLength(3);
  });
});

describe('sortProcessRows', () => {
  it('sorts by memory descending', () => {
    const sorted = sortProcessRows(rows(), 'memory');

    expect(sorted.map((row) => row.pid)).toEqual([10, 20, 30]);
  });

  it('puts an unmeasured process last rather than treating it as zero usage', () => {
    // Sorting a missing sample into the "smallest" slot of a biggest-first list
    // silently asserts it uses nothing.
    const sorted = sortProcessRows(rows(), 'memory');

    expect(sorted[sorted.length - 1].imageName).toBe('idle.exe');
  });

  it('sorts by name and by pid', () => {
    expect(sortProcessRows(rows(), 'name').map((row) => row.imageName)).toEqual([
      'chrome.exe',
      'idle.exe',
      'node.exe',
    ]);
    expect(sortProcessRows(rows(), 'pid').map((row) => row.pid)).toEqual([10, 20, 30]);
  });

  it('does not mutate the input', () => {
    const input = rows();
    const snapshot = input.map((row) => row.pid);

    sortProcessRows(input, 'name');

    expect(input.map((row) => row.pid)).toEqual(snapshot);
  });
});

describe('processOverview', () => {
  it('summarizes the sample', () => {
    const overview = processOverview(listing());

    expect(overview?.total).toBe(3);
    expect(overview?.distinctImages).toBe(3);
    expect(overview?.topImages[0].imageName).toBe('chrome.exe');
  });

  it('is null without a listing', () => {
    expect(processOverview(null)).toBeNull();
  });
});

describe('sample freshness', () => {
  it('says how old the photograph is', () => {
    expect(sampleAgeLabel(1000, 1000)).toBe('방금 표본');
    expect(sampleAgeLabel(1000, 11_000)).toBe('10초 전 표본');
    expect(sampleAgeLabel(1000, 121_000)).toBe('2분 전 표본');
  });

  it('admits when the sample time is unknown', () => {
    expect(sampleAgeLabel(0, 1000)).toBe('표본 시각 불명');
    expect(sampleAgeLabel(Number.NaN, 1000)).toBe('표본 시각 불명');
  });

  it('flags a stale sample, because a kill carries a pid', () => {
    // Acting on a stale row is how the wrong process gets killed after pid reuse.
    expect(isSampleStale(1000, 5000)).toBe(false);
    expect(isSampleStale(1000, 40_000)).toBe(true);
  });

  it('treats an unknown sample time as stale', () => {
    expect(isSampleStale(0, 1000)).toBe(true);
  });
});
