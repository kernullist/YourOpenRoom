import { describe, expect, it } from 'vitest';
import type { SignalItem, SignalSourceOutcome } from '@/lib/signalDeskShared';
import {
  briefFilePath,
  briefNameToDate,
  composeResearchRequest,
  countByCategory,
  filterSignals,
  formatCacheAge,
  formatRelativeTime,
  isBriefFileName,
  markSeen,
  parseBriefDoc,
  scoreTier,
  summarizeOutcomes,
} from '../signalView';

const NOW = Date.parse('2026-08-15T00:00:00Z');

function item(overrides: Partial<SignalItem>): SignalItem {
  return {
    id: 'sig-1',
    title: 'Kernel LPE',
    url: 'https://example.com/a',
    summary: 'details',
    sourceId: 'blog',
    sourceName: 'Blog',
    category: 'research',
    publishedAt: new Date(NOW).toISOString(),
    score: 10,
    scoreReasons: [],
    cveIds: [],
    kev: false,
    duplicateCount: 0,
    otherSources: [],
    ...overrides,
  };
}

describe('filterSignals', () => {
  it('passes everything through for all and filters otherwise', () => {
    const items = [item({ id: 'a', category: 'vuln' }), item({ id: 'b', category: 'paper' })];
    expect(filterSignals(items, 'all')).toHaveLength(2);
    expect(filterSignals(items, 'vuln').map((entry) => entry.id)).toEqual(['a']);
    expect(filterSignals(items, 'release')).toEqual([]);
  });
});

describe('scoreTier', () => {
  it('maps scores to tiers at the 35/60 boundaries', () => {
    expect(scoreTier(60)).toBe('high');
    expect(scoreTier(73)).toBe('high');
    expect(scoreTier(59)).toBe('mid');
    expect(scoreTier(35)).toBe('mid');
    expect(scoreTier(34)).toBe('low');
    expect(scoreTier(0)).toBe('low');
  });
});

describe('countByCategory', () => {
  it('counts every filter including all, with zeros for absent categories', () => {
    const counts = countByCategory([
      item({ id: 'a', category: 'vuln' }),
      item({ id: 'b', category: 'vuln' }),
      item({ id: 'c', category: 'paper' }),
    ]);
    expect(counts.all).toBe(3);
    expect(counts.vuln).toBe(2);
    expect(counts.paper).toBe(1);
    expect(counts.release).toBe(0);
    expect(counts.ai).toBe(0);
  });

  it('returns all-zero counts for an empty inbox', () => {
    const counts = countByCategory([]);
    expect(counts.all).toBe(0);
    expect(counts.research).toBe(0);
  });

  it('ignores an out-of-registry category instead of producing NaN', () => {
    const rogue = item({ id: 'x' });
    (rogue as { category: string }).category = 'bogus';
    const counts = countByCategory([rogue]);
    expect(counts.all).toBe(1);
    expect(Object.values(counts).every((count) => Number.isFinite(count))).toBe(true);
  });
});

describe('markSeen', () => {
  it('appends unseen ids and is a no-op for seen ones', () => {
    expect(markSeen([], 'a')).toEqual(['a']);
    const same = ['a', 'b'];
    expect(markSeen(same, 'a')).toBe(same);
  });

  it('drops the oldest entries past the cap', () => {
    expect(markSeen(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });
});

describe('time formatting', () => {
  it('formats relative ages and never fakes unknown as fresh', () => {
    expect(formatRelativeTime(NOW, new Date(NOW - 10_000).toISOString())).toBe('방금');
    expect(formatRelativeTime(NOW, new Date(NOW - 5 * 60_000).toISOString())).toBe('5분 전');
    expect(formatRelativeTime(NOW, new Date(NOW - 3 * 3_600_000).toISOString())).toBe('3시간 전');
    expect(formatRelativeTime(NOW, new Date(NOW - 3 * 86_400_000).toISOString())).toBe('3일 전');
    expect(formatRelativeTime(NOW, new Date(NOW - 90 * 86_400_000).toISOString())).toBe(
      '2026-05-17',
    );
    expect(formatRelativeTime(NOW, 'garbage')).toBe('시각 불명');
  });

  it('labels cached snapshots as cached', () => {
    expect(formatCacheAge(NOW, NOW - 5 * 60_000, 'cached')).toBe('수집 5분 전 · 캐시');
    expect(formatCacheAge(NOW, NOW - 5 * 60_000, 'fresh')).toBe('수집 5분 전');
  });
});

describe('summarizeOutcomes', () => {
  it('separates ok counts from named failures', () => {
    const sources: SignalSourceOutcome[] = [
      {
        sourceId: 'a',
        name: 'A',
        kind: 'rss',
        category: 'research',
        ok: true,
        itemCount: 3,
        ms: 10,
      },
      {
        sourceId: 'b',
        name: 'B',
        kind: 'atom',
        category: 'paper',
        ok: false,
        itemCount: 0,
        error: 'timeout',
        ms: 12_000,
      },
    ];
    expect(summarizeOutcomes(sources)).toEqual({ total: 2, okCount: 1, failedNames: ['B'] });
  });
});

describe('composeResearchRequest', () => {
  it('carries title, url, cves, summary, and the analysis framing', () => {
    const request = composeResearchRequest(
      item({ cveIds: ['CVE-2026-1111'], summary: 'LPE in win32k' }),
    );
    expect(request).toContain('Deep dive: Kernel LPE');
    expect(request).toContain('원문: https://example.com/a');
    expect(request).toContain('CVE: CVE-2026-1111');
    expect(request).toContain('요약: LPE in win32k');
    expect(request).toContain('탐지·대응 관점');
  });

  it('omits the cve and summary lines when absent', () => {
    const request = composeResearchRequest(item({ summary: '', cveIds: [] }));
    expect(request).not.toContain('CVE:');
    expect(request).not.toContain('요약:');
  });
});

describe('brief files', () => {
  it('builds and recognizes date-named brief files', () => {
    expect(briefFilePath('2026-08-15')).toBe('/briefs/2026-08-15.json');
    expect(isBriefFileName('2026-08-15.json')).toBe(true);
    expect(isBriefFileName('state.json')).toBe(false);
    expect(briefNameToDate('2026-08-15.json')).toBe('2026-08-15');
  });

  it('parses valid brief docs from objects and strings, rejecting malformed ones', () => {
    const doc = {
      version: 1,
      date: '2026-08-15',
      generatedAt: NOW,
      headline: 'h',
      caveats: [],
      sections: [],
      interest: { applied: false, keywordCount: 0, reason: 'no-session' },
    };
    expect(parseBriefDoc(doc)?.headline).toBe('h');
    expect(parseBriefDoc(JSON.stringify(doc))?.date).toBe('2026-08-15');

    expect(parseBriefDoc('{ not json')).toBeNull();
    expect(parseBriefDoc(null)).toBeNull();
    expect(parseBriefDoc([])).toBeNull();
    expect(parseBriefDoc({ ...doc, version: 2 })).toBeNull();
    expect(parseBriefDoc({ ...doc, sections: 'x' })).toBeNull();
    expect(parseBriefDoc({ ...doc, date: 5 })).toBeNull();
  });
});
