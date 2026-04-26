import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeUrlTool, parseReadablePageSnapshot } from '../urlTools';

describe('parseReadablePageSnapshot()', () => {
  it('extracts title, excerpt, and readable blocks from html', () => {
    const snapshot = parseReadablePageSnapshot(
      `
        <html>
          <head>
            <title>Example Article</title>
            <meta name="description" content="A concise summary of the article." />
          </head>
          <body>
            <article>
              <h1>Main Heading</h1>
              <p>This paragraph is long enough to be included in the reader output for the page snapshot.</p>
              <blockquote>This quoted text is also long enough to be included for testing purposes.</blockquote>
            </article>
          </body>
        </html>
      `,
      'https://example.com/post',
      4,
    );

    expect(snapshot.title).toBe('Example Article');
    expect(snapshot.siteName).toBe('example.com');
    expect(snapshot.excerpt).toContain('concise summary');
    expect(snapshot.blocks).toHaveLength(2);
    expect(snapshot.blocks[0].type).toBe('paragraph');
  });
});

describe('executeUrlTool()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an error when url is missing', async () => {
    await expect(executeUrlTool({})).resolves.toBe('error: missing url');
  });

  it('fetches a page and returns a parsed snapshot', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({
        'content-type': 'text/html; charset=utf-8',
        'x-final-url': 'https://example.com/final',
      }),
      text: () =>
        Promise.resolve(`
          <html>
            <head><title>Fetched Page</title></head>
            <body>
              <main>
                <p>This fetched paragraph is definitely long enough to become part of the extracted reader snapshot output.</p>
              </main>
            </body>
          </html>
        `),
    } as unknown as Response);

    const result = await executeUrlTool({ url: 'example.com/article', max_blocks: 3 });
    const parsed = JSON.parse(result) as {
      url: string;
      final_url: string;
      title: string;
      blocks: Array<{ text: string }>;
    };

    expect(parsed.url).toBe('https://example.com/article');
    expect(parsed.final_url).toBe('https://example.com/final');
    expect(parsed.title).toBe('Fetched Page');
    expect(parsed.blocks).toHaveLength(1);
  });
});
