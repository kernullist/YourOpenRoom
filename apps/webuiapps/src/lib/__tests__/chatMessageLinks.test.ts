import { describe, expect, it } from 'vitest';
import { parseChatMessageContent } from '../chatMessageLinks';

describe('parseChatMessageContent', () => {
  it('strips markdown/code decoration from bare source URLs', () => {
    const segments = parseChatMessageContent(
      'source: OpenRouter model page `https://openrouter.ai/z-ai/glm-4.5?` OpenRouter models API `https://openrouter.ai/api/v1/models`',
    );
    const links = segments.filter((segment) => segment.type === 'link');

    expect(links).toEqual([
      {
        type: 'link',
        label: 'https://openrouter.ai/z-ai/glm-4.5',
        url: 'https://openrouter.ai/z-ai/glm-4.5',
      },
      {
        type: 'link',
        label: 'https://openrouter.ai/api/v1/models',
        url: 'https://openrouter.ai/api/v1/models',
      },
    ]);
  });

  it('does not emit the inner URL capture from markdown links as a second link', () => {
    const segments = parseChatMessageContent(
      '[OpenRouter models API](https://openrouter.ai/api/v1/models)',
    );

    expect(segments).toEqual([
      {
        type: 'link',
        label: 'OpenRouter models API',
        url: 'https://openrouter.ai/api/v1/models',
      },
    ]);
  });

  it('keeps sentence punctuation outside the clickable URL', () => {
    const segments = parseChatMessageContent('See https://openrouter.ai/api/v1/models.');

    expect(segments).toEqual([
      { type: 'text', text: 'See ' },
      {
        type: 'link',
        label: 'https://openrouter.ai/api/v1/models',
        url: 'https://openrouter.ai/api/v1/models',
      },
      { type: 'text', text: '.' },
    ]);
  });
});
