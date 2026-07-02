import { describe, expect, it } from 'vitest';
import { extractReportToc, slugifyHeading } from '../researchToc';

describe('slugifyHeading', () => {
  it('lowercases and hyphenates words', () => {
    expect(slugifyHeading('Executive Summary')).toBe('executive-summary');
    expect(slugifyHeading('Scope and Assumptions')).toBe('scope-and-assumptions');
  });

  it('collapses punctuation and trims stray hyphens', () => {
    expect(slugifyHeading('Key Findings:')).toBe('key-findings');
    expect(slugifyHeading('  Sources & Notes  ')).toBe('sources-notes');
    expect(slugifyHeading('A — B (C)')).toBe('a-b-c');
  });

  it('keeps unicode letters so CJK headings get a usable slug', () => {
    expect(slugifyHeading('핵심 요약')).toBe('핵심-요약');
  });

  it('falls back to "section" when nothing usable remains', () => {
    expect(slugifyHeading('---')).toBe('section');
    expect(slugifyHeading('   ')).toBe('section');
  });
});

describe('extractReportToc', () => {
  it('returns an empty list for empty input', () => {
    expect(extractReportToc('')).toEqual([]);
  });

  it('extracts level-2 and level-3 headings, skipping the H1 title', () => {
    const md = [
      '# Report Title',
      '',
      '## Executive Summary',
      'text',
      '### Detail',
      '## Sources',
    ].join('\n');
    expect(extractReportToc(md)).toEqual([
      { level: 2, text: 'Executive Summary', slug: 'executive-summary' },
      { level: 3, text: 'Detail', slug: 'detail' },
      { level: 2, text: 'Sources', slug: 'sources' },
    ]);
  });

  it('ignores headings inside fenced code / mermaid blocks', () => {
    const md = [
      '## Real Heading',
      '```mermaid',
      'graph TD',
      '## not a heading',
      '```',
      '## Another Heading',
    ].join('\n');
    expect(extractReportToc(md).map((e) => e.text)).toEqual(['Real Heading', 'Another Heading']);
  });

  it('ignores level-1 and level-4+ headings', () => {
    const md = ['# H1', '#### H4', '##### H5', '## H2'].join('\n');
    expect(extractReportToc(md).map((e) => e.text)).toEqual(['H2']);
  });

  it('strips trailing closing hashes and blank headings', () => {
    const md = ['## Closed Heading ##', '##   '].join('\n');
    expect(extractReportToc(md)).toEqual([
      { level: 2, text: 'Closed Heading', slug: 'closed-heading' },
    ]);
  });
});
