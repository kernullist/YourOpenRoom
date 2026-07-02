import { describe, expect, it } from 'vitest';
import type { AoiResearchEvidenceClaim, AoiResearchSource } from '@/lib/aoiResearchTypes';
import {
  parseResearchEvidence,
  parseResearchSources,
  researchConfidencePercent,
  researchSourceDomain,
} from '../researchArtifacts';

function source(over: Partial<AoiResearchSource>): AoiResearchSource {
  return {
    version: 1,
    id: 'src-1',
    url: 'https://example.com/a',
    title: 'A',
    blocks: [],
    status: 'accepted',
    ...over,
  } as AoiResearchSource;
}

function claim(over: Partial<AoiResearchEvidenceClaim>): AoiResearchEvidenceClaim {
  return {
    version: 1,
    id: 'claim-1',
    sourceId: 'src-1',
    claim: 'A claim',
    supportText: 'support',
    topicTags: [],
    confidence: 0.5,
    caveats: [],
    createdAt: 0,
    ...over,
  } as AoiResearchEvidenceClaim;
}

describe('parseResearchSources', () => {
  it('parses an array value and a JSON string identically', () => {
    const arr = [source({ id: 'a' }), source({ id: 'b' })];
    expect(parseResearchSources(arr).map((s) => s.id)).toEqual(['a', 'b']);
    expect(parseResearchSources(JSON.stringify(arr)).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('returns an empty list for malformed json, non-arrays, and blank input', () => {
    expect(parseResearchSources('{not json')).toEqual([]);
    expect(parseResearchSources('   ')).toEqual([]);
    expect(parseResearchSources('{"id":"x"}')).toEqual([]);
    expect(parseResearchSources(null)).toEqual([]);
    expect(parseResearchSources(42)).toEqual([]);
  });

  it('drops entries missing an id or url', () => {
    const parsed = parseResearchSources([
      source({ id: 'ok' }),
      { id: 'no-url' },
      { url: 'https://x.com' },
      'nope',
    ]);
    expect(parsed.map((s) => s.id)).toEqual(['ok']);
  });

  it('orders accepted sources first, then by descending search score', () => {
    const parsed = parseResearchSources([
      source({ id: 'failed', status: 'failed', searchScore: 9 }),
      source({ id: 'accepted-low', status: 'accepted', searchScore: 1 }),
      source({ id: 'accepted-high', status: 'accepted', searchScore: 8 }),
      source({ id: 'pending', status: 'pending', searchScore: 5 }),
    ]);
    expect(parsed.map((s) => s.id)).toEqual(['accepted-high', 'accepted-low', 'pending', 'failed']);
  });
});

describe('parseResearchEvidence', () => {
  it('parses arrays and JSON strings, dropping invalid entries', () => {
    const arr = [claim({ id: 'a' }), { id: 'no-claim' }, claim({ id: 'b' })];
    expect(parseResearchEvidence(arr).map((c) => c.id)).toEqual(['a', 'b']);
    expect(parseResearchEvidence(JSON.stringify(arr)).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('returns an empty list for malformed input', () => {
    expect(parseResearchEvidence('{bad')).toEqual([]);
    expect(parseResearchEvidence(null)).toEqual([]);
  });

  it('orders claims by descending confidence', () => {
    const parsed = parseResearchEvidence([
      claim({ id: 'low', confidence: 0.2 }),
      claim({ id: 'high', confidence: 0.9 }),
      claim({ id: 'mid', confidence: 0.5 }),
    ]);
    expect(parsed.map((c) => c.id)).toEqual(['high', 'mid', 'low']);
  });

  it('treats a non-finite confidence as zero when sorting', () => {
    const parsed = parseResearchEvidence([
      claim({ id: 'nan', confidence: Number.NaN }),
      claim({ id: 'ok', confidence: 0.3 }),
    ]);
    expect(parsed.map((c) => c.id)).toEqual(['ok', 'nan']);
  });

  it('treats a missing/non-number confidence as zero when sorting', () => {
    const parsed = parseResearchEvidence([
      claim({ id: 'none', confidence: undefined as unknown as number }),
      claim({ id: 'ok', confidence: 0.3 }),
    ]);
    expect(parsed.map((c) => c.id)).toEqual(['ok', 'none']);
  });
});

describe('researchSourceDomain', () => {
  it('prefers an explicit site name', () => {
    expect(researchSourceDomain({ siteName: 'The Hacker News', url: 'https://x.com' })).toBe(
      'The Hacker News',
    );
  });

  it('falls back to the URL host without the www prefix', () => {
    expect(researchSourceDomain({ siteName: undefined, url: 'https://www.example.com/a' })).toBe(
      'example.com',
    );
    expect(researchSourceDomain({ siteName: '  ', url: 'https://sub.example.org/x' })).toBe(
      'sub.example.org',
    );
  });

  it('falls back to the raw url when it cannot be parsed', () => {
    expect(researchSourceDomain({ url: 'not a url' })).toBe('not a url');
  });
});

describe('researchConfidencePercent', () => {
  it('scales a 0..1 fraction to a percentage', () => {
    expect(researchConfidencePercent(0.75)).toBe(75);
    expect(researchConfidencePercent(1)).toBe(100);
    expect(researchConfidencePercent(0)).toBe(0);
  });

  it('passes through a value already on the 0..100 scale', () => {
    expect(researchConfidencePercent(82)).toBe(82);
  });

  it('clamps out-of-range values and treats non-numbers as zero', () => {
    expect(researchConfidencePercent(150)).toBe(100);
    expect(researchConfidencePercent(-5)).toBe(0);
    expect(researchConfidencePercent(Number.NaN)).toBe(0);
    expect(researchConfidencePercent(undefined)).toBe(0);
  });
});
