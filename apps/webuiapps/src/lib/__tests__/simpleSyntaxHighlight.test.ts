import { describe, expect, it } from 'vitest';
import {
  detectSyntaxLanguage,
  highlightContentByFilePath,
  renderHighlightedHtml,
} from '../simpleSyntaxHighlight';

describe('detectSyntaxLanguage()', () => {
  it('maps common extensions to syntax families', () => {
    expect(detectSyntaxLanguage('src/app.ts')).toBe('typescript');
    expect(detectSyntaxLanguage('notes.md')).toBe('markdown');
    expect(detectSyntaxLanguage('data.json')).toBe('json');
    expect(detectSyntaxLanguage('script.py')).toBe('python');
    expect(detectSyntaxLanguage('index.html')).toBe('html');
  });
});

describe('highlightContentByFilePath()', () => {
  it('marks TypeScript keywords, strings, and numbers', () => {
    const lines = highlightContentByFilePath(
      'example.ts',
      'const answer = 42;\nconsole.log("hello");',
    );

    expect(
      lines[0].some((token) => token.className === 'tokenKeyword' && token.text === 'const'),
    ).toBe(true);
    expect(lines[0].some((token) => token.className === 'tokenNumber' && token.text === '42')).toBe(
      true,
    );
    expect(
      lines[1].some((token) => token.className === 'tokenString' && token.text.includes('"hello"')),
    ).toBe(true);
  });

  it('marks Markdown headings and inline code', () => {
    const lines = highlightContentByFilePath('README.md', '# Title\nUse `pnpm test`');
    expect(lines[0][0]).toEqual({ text: '# Title', className: 'tokenHeading' });
    expect(lines[1].some((token) => token.className === 'tokenInlineCode')).toBe(true);
  });
});

describe('renderHighlightedHtml()', () => {
  it('wraps styled tokens and escapes HTML', () => {
    const html = renderHighlightedHtml([
      { text: '<tag>' },
      { text: '"hello"', className: 'tokenString' },
    ]);

    expect(html).toContain('&lt;tag&gt;');
    expect(html).toContain('<span class="tokenString">&quot;hello&quot;</span>');
  });
});
