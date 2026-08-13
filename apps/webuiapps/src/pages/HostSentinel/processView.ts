import type {
  AoiHostProcessListingView,
  AoiHostProcessRecordView,
} from '@/lib/aoiHostBridgeClient';

// Pure shaping for the process table. Kept out of the component so the rules
// that decide what an operator is allowed to think about a row -- especially
// which rows are Aoi's own -- are testable without a DOM.

export type ProcessSort = 'memory' | 'name' | 'pid';

export type ProcessRow = AoiHostProcessRecordView;

export function memoryLabel(memKb: number | undefined): string {
  if (typeof memKb !== 'number' || !Number.isFinite(memKb) || memKb < 0) {
    // Not "0 MB": a missing sample is not a measurement of zero.
    return '-';
  }
  if (memKb < 1024) {
    return `${Math.round(memKb)} KB`;
  }
  return `${(memKb / 1024).toFixed(1)} MB`;
}

export function buildProcessRows(listing: AoiHostProcessListingView | null): ProcessRow[] {
  return listing ? [...listing.records] : [];
}

export function filterProcessRows(rows: ProcessRow[], query: string): ProcessRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return rows;
  }
  return rows.filter(
    (row) => row.imageName.toLowerCase().includes(needle) || String(row.pid).includes(needle),
  );
}

export function sortProcessRows(rows: ProcessRow[], sort: ProcessSort): ProcessRow[] {
  const copy = [...rows];
  if (sort === 'name') {
    copy.sort(
      (left, right) => left.imageName.localeCompare(right.imageName) || left.pid - right.pid,
    );
    return copy;
  }
  if (sort === 'pid') {
    copy.sort((left, right) => left.pid - right.pid);
    return copy;
  }
  // Memory descending, with unknown samples last rather than treated as zero --
  // sorting a missing measurement to the bottom of a "biggest first" list would
  // read as "this process uses nothing".
  copy.sort((left, right) => {
    const leftMem = typeof left.memKb === 'number' ? left.memKb : -1;
    const rightMem = typeof right.memKb === 'number' ? right.memKb : -1;
    return rightMem - leftMem || left.imageName.localeCompare(right.imageName);
  });
  return copy;
}

export interface ProcessOverview {
  total: number;
  distinctImages: number;
  sampledAt: number;
  topImages: Array<{ imageName: string; count: number }>;
}

export function processOverview(listing: AoiHostProcessListingView | null): ProcessOverview | null {
  if (!listing) {
    return null;
  }
  return {
    total: listing.summary.totalCount,
    distinctImages: listing.summary.distinctImageCount,
    sampledAt: listing.summary.sampledAt || listing.sampledAt,
    topImages: listing.summary.topImages,
  };
}

/**
 * How stale the sample is.
 *
 * A process list is a photograph, not a feed. Showing one without saying when it
 * was taken invites the operator to act on a process that exited minutes ago --
 * and a kill request carries the pid, so acting on a stale row is how you kill
 * the wrong thing after pid reuse.
 */
export function sampleAgeLabel(sampledAt: number, now: number): string {
  if (!Number.isFinite(sampledAt) || sampledAt <= 0) {
    return '표본 시각 불명';
  }
  const seconds = Math.max(0, Math.round((now - sampledAt) / 1000));
  if (seconds < 5) {
    return '방금 표본';
  }
  if (seconds < 60) {
    return `${seconds}초 전 표본`;
  }
  return `${Math.floor(seconds / 60)}분 전 표본`;
}

export function isSampleStale(sampledAt: number, now: number, thresholdMs = 30_000): boolean {
  if (!Number.isFinite(sampledAt) || sampledAt <= 0) {
    return true;
  }
  return now - sampledAt > thresholdMs;
}
