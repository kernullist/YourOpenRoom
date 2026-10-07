import { describe, expect, it } from 'vitest';

import { safeExternalUrl, toLiveArticle } from '../liveNews';

describe('safeExternalUrl', () => {
  it('keeps http(s) links and drops script and other schemes', () => {
    expect(safeExternalUrl('https://news.example/a?b=1')).toBe('https://news.example/a?b=1');
    expect(safeExternalUrl(' http://news.example ')).toBe('http://news.example/');
    for (const value of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>1</script>',
      'vbscript:x',
      'not a url',
      '',
      undefined,
      42,
    ]) {
      expect(safeExternalUrl(value), String(value)).toBe('');
    }
  });

  it('is applied when a feed item becomes an article', () => {
    const article = toLiveArticle(
      {
        title: 'Breach',
        url: 'javascript:alert(document.cookie)',
        category: 'threat',
        summary: 's',
        publishedAt: '2026-10-01T00:00:00Z',
        sourceName: 'Feed',
      } as unknown as Parameters<typeof toLiveArticle>[0],
      '2026-10-01T00:00:00Z',
    );
    expect(article.sourceUrl).toBe('');
  });
});
