import { describe, expect, it } from 'vitest';

import {
  isAoiExternalPersonalSourceLive,
  liveAoiExternalPersonalSummaries,
  probeAoiExternalPersonalSource,
  probeAoiExternalPersonalSources,
  type AoiExternalPersonalMetadataFetcher,
} from '../aoiExternalPersonalConnector';

const NOW = 1_800_000_000_000;

describe('probeAoiExternalPersonalSource (P5.7)', () => {
  it('fails closed to consent_blocked without explicit metadata_allowed consent', () => {
    for (const consent of [
      'disabled',
      'revoked',
      'disconnected',
      'body_disabled',
      'unknown',
    ] as const) {
      const probe = probeAoiExternalPersonalSource({
        sourceKind: 'calendar_metadata',
        consent,
        fetcher: () => ({ itemCount: 3, recentTitles: ['x'] }),
        now: NOW,
      });
      expect(probe.liveness).toBe('consent_blocked');
      expect(probe.summary).toBeNull();
    }
  });

  it('fails closed to disconnected when no fetcher is wired (no credentials)', () => {
    const probe = probeAoiExternalPersonalSource({
      sourceKind: 'gmail_metadata',
      consent: 'metadata_allowed',
      now: NOW,
    });
    expect(probe.liveness).toBe('disconnected');
    expect(probe.reason).toBe('no_credentials');
    expect(probe.summary).toBeNull();
    expect(isAoiExternalPersonalSourceLive(probe)).toBe(false);
  });

  it('fails closed to error when the fetcher throws or returns malformed data', () => {
    const throwing: AoiExternalPersonalMetadataFetcher = () => {
      throw new Error('network down');
    };
    expect(
      probeAoiExternalPersonalSource({
        sourceKind: 'calendar_metadata',
        consent: 'metadata_allowed',
        fetcher: throwing,
        now: NOW,
      }).liveness,
    ).toBe('error');

    const malformed = probeAoiExternalPersonalSource({
      sourceKind: 'calendar_metadata',
      consent: 'metadata_allowed',
      fetcher: (() => ({ recentTitles: [] })) as unknown as AoiExternalPersonalMetadataFetcher,
      now: NOW,
    });
    expect(malformed.liveness).toBe('error');
    expect(malformed.summary).toBeNull();
  });

  it('returns a live, redacted, metadata-only summary when a consented fetch succeeds', () => {
    const probe = probeAoiExternalPersonalSource({
      sourceKind: 'calendar_metadata',
      consent: 'metadata_allowed',
      fetcher: () => ({
        itemCount: 2,
        recentTitles: ['Standup', 'Design review'],
        latestAt: NOW - 60_000,
      }),
      now: NOW,
    });
    expect(probe.liveness).toBe('live');
    expect(isAoiExternalPersonalSourceLive(probe)).toBe(true);
    expect(probe.summary).toMatchObject({
      kind: 'calendar_metadata',
      sourceId: 'calendar-external',
      redactionState: 'redacted',
      freshness: 'fresh',
    });
    expect(probe.summary?.relevanceText).toContain('Standup');
  });

  it('redacts secrets in titles and caps their count', () => {
    const probe = probeAoiExternalPersonalSource({
      sourceKind: 'gmail_metadata',
      consent: 'metadata_allowed',
      fetcher: () => ({
        itemCount: 9,
        recentTitles: [
          'key -----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----',
          't2',
          't3',
          't4',
          't5-should-be-dropped',
        ],
      }),
      now: NOW,
    });
    expect(probe.summary?.relevanceText).not.toContain('BEGIN PRIVATE KEY');
    // Capped to 4 titles.
    expect(probe.summary?.relevanceText).not.toContain('t5-should-be-dropped');
  });

  it('marks freshness stale for an old latestAt and unknown when absent', () => {
    const stale = probeAoiExternalPersonalSource({
      sourceKind: 'calendar_metadata',
      consent: 'metadata_allowed',
      fetcher: () => ({
        itemCount: 1,
        recentTitles: ['old'],
        latestAt: NOW - 40 * 24 * 60 * 60 * 1000,
      }),
      now: NOW,
    });
    expect(stale.summary?.freshness).toBe('stale');

    const unknown = probeAoiExternalPersonalSource({
      sourceKind: 'calendar_metadata',
      consent: 'metadata_allowed',
      fetcher: () => ({ itemCount: 0, recentTitles: [] }),
      now: NOW,
    });
    expect(unknown.summary?.freshness).toBe('unknown');

    // A future timestamp (clock skew) is treated as unknown, not fresh.
    const future = probeAoiExternalPersonalSource({
      sourceKind: 'calendar_metadata',
      consent: 'metadata_allowed',
      fetcher: () => ({ itemCount: 1, recentTitles: ['soon'], latestAt: NOW + 60_000 }),
      now: NOW,
    });
    expect(future.summary?.freshness).toBe('unknown');
  });
});

describe('probeAoiExternalPersonalSources + liveAoiExternalPersonalSummaries (P5.7)', () => {
  it('probes each source independently and surfaces only the live summaries', () => {
    const fetcher: AoiExternalPersonalMetadataFetcher = (kind) =>
      kind === 'calendar_metadata' ? { itemCount: 1, recentTitles: ['ok'] } : null;
    const probes = probeAoiExternalPersonalSources({
      sources: [
        { sourceKind: 'calendar_metadata', consent: 'metadata_allowed' },
        { sourceKind: 'gmail_metadata', consent: 'metadata_allowed' }, // fetcher returns null -> error
        { sourceKind: 'gmail_metadata', consent: 'disabled' }, // consent-blocked
      ],
      fetcher,
      now: NOW,
    });
    expect(probes.map((p) => p.liveness)).toEqual(['live', 'error', 'consent_blocked']);
    const summaries = liveAoiExternalPersonalSummaries(probes);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe('calendar_metadata');
  });

  it('surfaces nothing when no fetcher is wired (all disconnected)', () => {
    const probes = probeAoiExternalPersonalSources({
      sources: [
        { sourceKind: 'calendar_metadata', consent: 'metadata_allowed' },
        { sourceKind: 'gmail_metadata', consent: 'metadata_allowed' },
      ],
      now: NOW,
    });
    expect(probes.every((p) => p.liveness === 'disconnected')).toBe(true);
    expect(liveAoiExternalPersonalSummaries(probes)).toEqual([]);
  });
});
