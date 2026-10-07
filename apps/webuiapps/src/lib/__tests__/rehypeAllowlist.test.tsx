import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';

import { rehypeAllowlist } from '../rehypeAllowlist';

function renderMarkdown(markdown: string): HTMLElement {
  const { container } = render(
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeAllowlist]}>
      {markdown}
    </ReactMarkdown>,
  );
  return container;
}

describe('rehypeAllowlist', () => {
  it('removes active content that rehype-raw would otherwise render live', () => {
    const container = renderMarkdown(
      [
        'Dear diary <iframe srcdoc="<script>parent.alert(1)</script>"></iframe>',
        '<script>alert(1)</script><style>body{display:none}</style>',
        '<img src="x" onerror="alert(1)"> <a href="javascript:alert(1)">click</a>',
        '<form action="/api/llm-config"><button>go</button></form>',
        '<svg><script>alert(1)</script></svg><object data="x"></object>',
        '<div onclick="alert(1)" style="position:fixed">kept text</div><!-- note -->',
      ].join('\n\n'),
    );
    const html = container.innerHTML;
    for (const fragment of [
      '<iframe',
      'srcdoc',
      '<script',
      '<style',
      'onerror',
      'javascript:',
      '<form',
      '<button',
      '<svg',
      '<object',
      'onclick',
      'position:fixed',
      '<!--',
    ]) {
      expect(html, fragment).not.toContain(fragment);
    }
    expect(container.textContent).toContain('Dear diary');
    expect(container.textContent).toContain('kept text');
    expect(container.textContent).toContain('click');
  });

  it('keeps markdown, GFM output and the diary custom-markup span', () => {
    const container = renderMarkdown(
      [
        '# Title',
        '**bold** _em_ ~~gone~~ `code`',
        '<span data-effect="strike">crossed</span> <span data-effect="evil">plain</span>',
        '- [x] done',
        '| a | b |\n| :- | -: |\n| 1 | 2 |',
        '[site](https://example.com) ![pic](https://example.com/a.png)',
        '```ts\nconst x = 1;\n```',
      ].join('\n\n'),
    );
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('del')?.textContent).toBe('gone');
    expect(container.querySelector('span[data-effect="strike"]')?.textContent).toBe('crossed');
    expect(container.querySelector('span[data-effect="evil"]')).toBeNull();
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(checkbox?.disabled).toBe(true);
    expect(container.querySelector('table td')?.textContent).toBe('1');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
    expect(container.querySelector('code.language-ts')).not.toBeNull();
  });

  it('drops a non-checkbox input and unsafe image sources', () => {
    const container = renderMarkdown(
      '<input type="text" value="x"> <img src="data:text/html,<script>1</script>" alt="a">',
    );
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src') ?? null).toBeNull();
  });
});
