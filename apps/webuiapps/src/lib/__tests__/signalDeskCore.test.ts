import { describe, expect, it } from 'vitest';
import { describeInterestMeta } from '../signalDeskShared';
import {
  buildBrief,
  buildSignals,
  computeSignalScore,
  extractCveIds,
  hashSignalId,
  normalizeSignalUrl,
  parseAtomEntries,
  parseFeedEntries,
  parseKevEntries,
  parseRssItems,
  type SignalSourceDef,
  type SourceFetchResult,
} from '../signalDeskCore';

const NOW = Date.parse('2026-08-15T00:00:00Z');
const PARSE_OPTIONS = { max: 10, fallbackNowMs: NOW };

const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Windows kernel LPE patched</title>
    <link>https://example.com/a?utm_source=rss&amp;id=7</link>
    <description><![CDATA[<p>Patch &amp; details for CVE-2026-1111.</p>]]></description>
    <pubDate>Fri, 14 Aug 2026 12:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Item without link is dropped</title>
  </item>
</channel></rss>`;

const ATOM_FIXTURE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="https://example.org/feed"/>
  <entry>
    <title>Paper on kernel anti-cheat</title>
    <link rel="alternate" href="https://arxiv.org/abs/2608.01234"/>
    <summary>We study kernel anti-cheat telemetry.</summary>
    <published>2026-08-13T00:00:00Z</published>
  </entry>
  <entry>
    <title>x64dbg v2.5</title>
    <link href="https://github.com/x64dbg/x64dbg/releases/tag/v2.5"/>
    <content type="html">&lt;b&gt;Release notes&lt;/b&gt; here</content>
    <updated>2026-08-12T10:00:00Z</updated>
  </entry>
</feed>`;

const KEV_FIXTURE = JSON.stringify({
  vulnerabilities: [
    {
      cveID: 'CVE-2026-0002',
      vulnerabilityName: 'Old bug',
      shortDescription: 'Old.',
      dateAdded: '2026-01-02',
    },
    {
      cveID: 'CVE-2026-1111',
      vulnerabilityName: 'Windows Kernel Privilege Escalation',
      shortDescription: 'LPE in win32k.',
      requiredAction: 'Apply updates',
      dateAdded: '2026-08-14',
    },
  ],
});

function source(overrides: Partial<SignalSourceDef>): SignalSourceDef {
  return {
    id: 'src',
    name: 'Source',
    url: 'https://example.com/feed',
    kind: 'rss',
    category: 'research',
    weight: 10,
    ...overrides,
  };
}

describe('parsers', () => {
  it('parses rss items, strips html, decodes entities, drops linkless items', () => {
    const entries = parseRssItems(RSS_FIXTURE, PARSE_OPTIONS);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Windows kernel LPE patched');
    expect(entries[0].summary).toBe('Patch & details for CVE-2026-1111.');
    expect(entries[0].url).toContain('https://example.com/a');
    expect(new Date(entries[0].publishedAt).toISOString()).toBe('2026-08-14T12:00:00.000Z');
  });

  it('parses atom entries preferring rel=alternate links and falling back to updated/content', () => {
    const entries = parseAtomEntries(ATOM_FIXTURE, PARSE_OPTIONS);
    expect(entries).toHaveLength(2);
    expect(entries[0].url).toBe('https://arxiv.org/abs/2608.01234');
    expect(entries[1].url).toBe('https://github.com/x64dbg/x64dbg/releases/tag/v2.5');
    expect(entries[1].summary).toBe('Release notes here');
    expect(new Date(entries[1].publishedAt).toISOString()).toBe('2026-08-12T10:00:00.000Z');
  });

  it('uses the fallback date when an entry has no parseable date', () => {
    const xml = '<rss><item><title>t</title><link>https://a.example/x</link></item></rss>';
    const entries = parseRssItems(xml, PARSE_OPTIONS);
    expect(entries[0].publishedAt).toBe(new Date(NOW).toISOString());
  });

  it('parses KEV entries newest first with the kev flag and an NVD url', () => {
    const entries = parseKevEntries(KEV_FIXTURE, PARSE_OPTIONS);
    expect(entries[0].title).toBe('CVE-2026-1111: Windows Kernel Privilege Escalation');
    expect(entries[0].url).toBe('https://nvd.nist.gov/vuln/detail/CVE-2026-1111');
    expect(entries[0].kev).toBe(true);
    expect(entries[0].summary).toContain('조치: Apply updates');
    expect(entries[1].title).toContain('CVE-2026-0002');
  });

  it('auto-detects atom content behind an rss-looking feed (Jekyll feed.xml)', () => {
    const entries = parseFeedEntries(ATOM_FIXTURE, PARSE_OPTIONS);
    expect(entries).toHaveLength(2);
    expect(entries[0].url).toBe('https://arxiv.org/abs/2608.01234');

    const rssEntries = parseFeedEntries(RSS_FIXTURE, PARSE_OPTIONS);
    expect(rssEntries).toHaveLength(1);
    expect(rssEntries[0].title).toBe('Windows kernel LPE patched');
  });

  it('throws on malformed KEV payloads instead of returning an empty list', () => {
    expect(() => parseKevEntries('not json', PARSE_OPTIONS)).toThrow('KEV JSON parse failed');
    expect(() => parseKevEntries('{"foo":1}', PARSE_OPTIONS)).toThrow('no vulnerabilities');
  });
});

describe('normalization', () => {
  it('extracts unique uppercase CVE ids', () => {
    expect(extractCveIds('CVE-2026-1111 cve-2026-1111 CVE-2025-99999 and text')).toEqual([
      'CVE-2025-99999',
      'CVE-2026-1111',
    ]);
    expect(extractCveIds('nothing here')).toEqual([]);
  });

  it('normalizes urls: tracking params, hash, host case, trailing slash', () => {
    expect(normalizeSignalUrl('https://Example.com/Post/?utm_source=x&id=7#frag')).toBe(
      'https://example.com/Post?id=7',
    );
    expect(normalizeSignalUrl('not a url')).toBe('not a url');
  });

  it('hashes ids deterministically', () => {
    expect(hashSignalId('a|b')).toBe(hashSignalId('a|b'));
    expect(hashSignalId('a|b')).not.toBe(hashSignalId('a|c'));
    expect(hashSignalId('x')).toMatch(/^sig-/);
  });
});

describe('computeSignalScore', () => {
  const base = {
    title: 'Some report',
    summary: 'details',
    publishedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    kev: false,
    duplicateCount: 0,
    sourceWeight: 10,
  };

  it('adds recency points with a reason inside 48h and none outside', () => {
    const fresh = computeSignalScore(base, { now: NOW, interestKeywords: [] });
    expect(fresh.score).toBeGreaterThan(10);
    expect(fresh.reasons.some((reason) => reason.includes('시간 내 신규'))).toBe(true);

    const stale = computeSignalScore(
      { ...base, publishedAt: new Date(NOW - 100 * 3_600_000).toISOString() },
      { now: NOW, interestKeywords: [] },
    );
    expect(stale.score).toBe(10);
    expect(stale.reasons).toEqual([]);
  });

  it('boosts KEV listings with a reason', () => {
    const scored = computeSignalScore({ ...base, kev: true }, { now: NOW, interestKeywords: [] });
    expect(scored.reasons).toContain('KEV 등재(실제 악용)');
  });

  it('matches interest keywords, word-bounded for short terms, capped at three', () => {
    const scored = computeSignalScore(
      { ...base, title: 'Windows kernel driver research on TPM and IRQL and KMDF' },
      {
        now: NOW,
        interestKeywords: [
          { term: 'kernel', weight: 1 },
          { term: 'TPM', weight: 0.5 },
          { term: 'IRQL', weight: 0.5 },
          { term: 'KMDF', weight: 0.5 },
        ],
      },
    );
    const interestReasons = scored.reasons.filter((reason) => reason.startsWith('관심사 일치'));
    expect(interestReasons).toHaveLength(3);
  });

  it('does not match a short term inside a longer word', () => {
    const scored = computeSignalScore(
      { ...base, title: 'research trends' },
      { now: NOW, interestKeywords: [{ term: 'RE', weight: 1 }] },
    );
    expect(scored.reasons.some((reason) => reason.startsWith('관심사 일치'))).toBe(false);
  });

  it('adds a duplicate-coverage boost with a reason', () => {
    const scored = computeSignalScore(
      { ...base, duplicateCount: 2 },
      { now: NOW, interestKeywords: [] },
    );
    expect(scored.reasons).toContain('3개 소스 중복 보도');
  });
});

describe('buildSignals', () => {
  it('keeps failed sources as named failures, never as zero-item successes', () => {
    const results: SourceFetchResult[] = [
      {
        source: source({ id: 'ok-empty', name: 'Quiet' }),
        ok: true,
        entries: [],
        ms: 5,
      },
      {
        source: source({ id: 'down', name: 'Down' }),
        ok: false,
        entries: [],
        error: 'HTTP 500',
        ms: 9,
      },
    ];
    const { items, outcomes } = buildSignals(results, { now: NOW, interestKeywords: [] });
    expect(items).toEqual([]);
    const quiet = outcomes.find((outcome) => outcome.sourceId === 'ok-empty');
    const down = outcomes.find((outcome) => outcome.sourceId === 'down');
    expect(quiet).toMatchObject({ ok: true, itemCount: 0 });
    expect(quiet?.error).toBeUndefined();
    expect(down).toMatchObject({ ok: false, itemCount: 0, error: 'HTTP 500' });
  });

  it('dedupes by normalized url, keeping the higher-weight source', () => {
    const entry = {
      title: 'Same story',
      url: 'https://example.com/story?utm_source=a',
      summary: '',
      publishedAt: new Date(NOW).toISOString(),
    };
    const results: SourceFetchResult[] = [
      {
        source: source({ id: 'light', name: 'Light', weight: 8 }),
        ok: true,
        entries: [{ ...entry }],
        ms: 1,
      },
      {
        source: source({ id: 'heavy', name: 'Heavy', weight: 16 }),
        ok: true,
        entries: [{ ...entry, url: 'https://example.com/story' }],
        ms: 1,
      },
    ];
    const { items } = buildSignals(results, { now: NOW, interestKeywords: [] });
    expect(items).toHaveLength(1);
    expect(items[0].sourceName).toBe('Heavy');
    expect(items[0].duplicateCount).toBe(1);
    expect(items[0].otherSources).toEqual(['Light']);
  });

  it('merges the same CVE across different urls and keeps the kev flag', () => {
    const results: SourceFetchResult[] = [
      {
        source: source({ id: 'kev', name: 'KEV', category: 'vuln', weight: 18 }),
        ok: true,
        entries: [
          {
            title: 'CVE-2026-1111: Kernel LPE',
            url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-1111',
            summary: 'LPE',
            publishedAt: new Date(NOW).toISOString(),
            kev: true,
          },
        ],
        ms: 1,
      },
      {
        source: source({ id: 'msrc', name: 'MSRC', category: 'msrc', weight: 14 }),
        ok: true,
        entries: [
          {
            title: 'August update fixes CVE-2026-1111',
            url: 'https://msrc.microsoft.com/update-guide/CVE-2026-1111',
            summary: '',
            publishedAt: new Date(NOW).toISOString(),
          },
        ],
        ms: 1,
      },
    ];
    const { items } = buildSignals(results, { now: NOW, interestKeywords: [] });
    expect(items).toHaveLength(1);
    expect(items[0].kev).toBe(true);
    expect(items[0].sourceName).toBe('KEV');
    expect(items[0].otherSources).toEqual(['MSRC']);
    expect(items[0].cveIds).toEqual(['CVE-2026-1111']);
  });

  it('sorts by score descending and respects maxItems', () => {
    const results: SourceFetchResult[] = [
      {
        source: source({ id: 'a', name: 'A', weight: 8 }),
        ok: true,
        entries: [
          {
            title: 'older low',
            url: 'https://a.example/1',
            summary: '',
            publishedAt: new Date(NOW - 90 * 3_600_000).toISOString(),
          },
          {
            title: 'fresh high',
            url: 'https://a.example/2',
            summary: '',
            publishedAt: new Date(NOW - 1 * 3_600_000).toISOString(),
          },
          {
            title: 'mid',
            url: 'https://a.example/3',
            summary: '',
            publishedAt: new Date(NOW - 40 * 3_600_000).toISOString(),
          },
        ],
        ms: 1,
      },
    ];
    const { items } = buildSignals(results, { now: NOW, interestKeywords: [], maxItems: 2 });
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('fresh high');
    expect(items[0].score).toBeGreaterThanOrEqual(items[1].score);
  });
});

describe('dedup edge cases', () => {
  it('prefers the newer publication when source weights tie', () => {
    const results: SourceFetchResult[] = [
      {
        source: source({ id: 'a', name: 'Older', weight: 10 }),
        ok: true,
        entries: [
          {
            title: 'story',
            url: 'https://example.com/story',
            summary: 'from older',
            publishedAt: new Date(NOW - 10 * 3_600_000).toISOString(),
          },
        ],
        ms: 1,
      },
      {
        source: source({ id: 'b', name: 'Newer', weight: 10 }),
        ok: true,
        entries: [
          {
            title: 'story',
            url: 'https://example.com/story',
            summary: '',
            publishedAt: new Date(NOW - 1 * 3_600_000).toISOString(),
          },
        ],
        ms: 1,
      },
    ];
    const { items } = buildSignals(results, { now: NOW, interestKeywords: [] });
    expect(items).toHaveLength(1);
    expect(items[0].sourceName).toBe('Newer');
    // The keeper had no summary, so the merged duplicate's summary survives.
    expect(items[0].summary).toBe('from older');
  });

  it('falls back to id ordering when scores tie and a date is unparseable', () => {
    const results: SourceFetchResult[] = [
      {
        source: source({ id: 'a', name: 'A', weight: 10 }),
        ok: true,
        entries: [
          { title: 'x', url: 'https://a.example/x', summary: '', publishedAt: 'garbage' },
          { title: 'y', url: 'https://a.example/y', summary: '', publishedAt: 'garbage' },
        ],
        ms: 1,
      },
    ];
    const { items } = buildSignals(results, { now: NOW, interestKeywords: [] });
    expect(items).toHaveLength(2);
    const ids = items.map((entry) => entry.id);
    expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(ids);
  });

  it('skips interest terms shorter than two characters', () => {
    const scored = computeSignalScore(
      {
        title: 'k things',
        summary: '',
        publishedAt: 'garbage',
        kev: false,
        duplicateCount: 0,
        sourceWeight: 10,
      },
      { now: NOW, interestKeywords: [{ term: ' k ', weight: 1 }] },
    );
    expect(scored.reasons).toEqual([]);
  });

  it('keeps atom entries without any link out of the result', () => {
    const xml = `<feed><entry><title>no link</title><updated>2026-08-12T10:00:00Z</updated></entry>
      <entry><title>self only</title><link rel="self" href="https://feed.example/self"/><updated>2026-08-12T10:00:00Z</updated></entry></feed>`;
    const entries = parseAtomEntries(xml, PARSE_OPTIONS);
    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://feed.example/self');
  });

  it('keeps the root path slash and non-tracking params when normalizing', () => {
    expect(normalizeSignalUrl('https://example.com/')).toBe('https://example.com/');
    expect(normalizeSignalUrl('https://example.com/p?page=2')).toBe('https://example.com/p?page=2');
  });
});

describe('describeInterestMeta', () => {
  it('labels every state distinctly, including the unexplained fallback', () => {
    expect(describeInterestMeta({ applied: true, keywordCount: 4 })).toBe(
      '관심 프로파일 적용 · 키워드 4개',
    );
    expect(
      describeInterestMeta({ applied: false, keywordCount: 0, reason: 'no-session' }),
    ).toContain('세션 미지정');
    expect(
      describeInterestMeta({ applied: false, keywordCount: 0, reason: 'no-profile' }),
    ).toContain('관심 프로파일 없음');
    expect(
      describeInterestMeta({
        applied: false,
        keywordCount: 0,
        reason: 'profile-error',
        detail: 'EACCES',
      }),
    ).toContain('EACCES');
    expect(describeInterestMeta({ applied: false, keywordCount: 0, reason: 'profile-error' })).toBe(
      '기본 우선순위 · 프로파일 읽기 실패',
    );
    expect(describeInterestMeta({ applied: false, keywordCount: 0 })).toBe('기본 우선순위');
  });
});

describe('buildBrief', () => {
  it('states failures and interest non-application as caveats, with an honest headline', () => {
    const results: SourceFetchResult[] = [
      {
        source: source({ id: 'kev', name: 'KEV', category: 'vuln', weight: 18 }),
        ok: true,
        entries: [
          {
            title: 'CVE-2026-1111: Kernel LPE',
            url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-1111',
            summary: 'LPE',
            publishedAt: new Date(NOW).toISOString(),
            kev: true,
          },
        ],
        ms: 1,
      },
      {
        source: source({ id: 'down', name: 'Down Blog' }),
        ok: false,
        entries: [],
        error: 'timeout',
        ms: 12_000,
      },
    ];
    const { items, outcomes } = buildSignals(results, { now: NOW, interestKeywords: [] });
    const brief = buildBrief(items, outcomes, {
      now: NOW,
      interest: { applied: false, keywordCount: 0, reason: 'no-profile' },
    });

    expect(brief.headline).toBe('신호 1건 · KEV 1건 · 소스 1/2 정상');
    expect(brief.caveats.some((caveat) => caveat.includes('Down Blog 수집 실패: timeout'))).toBe(
      true,
    );
    expect(brief.caveats.some((caveat) => caveat.includes('관심 가중치 미적용'))).toBe(true);
    expect(brief.sections).toHaveLength(1);
    expect(brief.sections[0].category).toBe('vuln');
    expect(brief.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('caps every section at its per-category limit', () => {
    const results: SourceFetchResult[] = [
      {
        source: source({ id: 'kev', name: 'KEV', category: 'vuln', weight: 18 }),
        ok: true,
        entries: Array.from({ length: 6 }, (_, index) => ({
          title: `CVE-2026-90${index}0: bug ${index}`,
          url: `https://nvd.example/${index}`,
          summary: '',
          publishedAt: new Date(NOW - index * 3_600_000).toISOString(),
          kev: true,
        })),
        ms: 1,
      },
    ];
    const { items, outcomes } = buildSignals(results, { now: NOW, interestKeywords: [] });
    const brief = buildBrief(items, outcomes, {
      now: NOW,
      interest: { applied: true, keywordCount: 1 },
    });
    expect(brief.sections[0].items).toHaveLength(4);
  });

  it('marks the all-ok-but-empty case explicitly', () => {
    const outcomes = buildSignals(
      [{ source: source({ id: 'quiet', name: 'Quiet' }), ok: true, entries: [], ms: 1 }],
      { now: NOW, interestKeywords: [] },
    );
    const brief = buildBrief([], outcomes.outcomes, {
      now: NOW,
      interest: { applied: true, keywordCount: 3 },
    });
    expect(brief.caveats.some((caveat) => caveat.includes('신호가 없습니다'))).toBe(true);
    expect(brief.sections).toEqual([]);
  });
});
