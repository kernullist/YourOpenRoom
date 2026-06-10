import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTavilyTool, getTavilyToolDefinitions, isTavilyTool } from '../tavilyTools';
import type { TavilyConfig } from '../tavilyClient';

const TAVILY_CONFIG: TavilyConfig = {
  apiKey: 'tvly-test',
  baseUrl: 'https://api.tavily.com/search',
};

function makeJsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Tavily web search tool', () => {
  it('exposes the search_web tool definition', () => {
    const tools = getTavilyToolDefinitions();

    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe('search_web');
    expect(isTavilyTool('search_web')).toBe(true);
    expect(isTavilyTool('read_url')).toBe(false);
  });

  it('returns a configuration error without a Tavily API key', async () => {
    await expect(executeTavilyTool({ query: 'latest AI news' }, null)).resolves.toContain(
      'Tavily is not configured',
    );
  });

  it('posts a normalized search request to the local Tavily proxy', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      makeJsonResponse(200, {
        query: 'latest AI news',
        answer: 'Recent AI news summary',
        results: [
          {
            title: 'One',
            url: 'https://one.test',
            content: 'First result',
            score: 0.9,
          },
          {
            title: 'Two',
            url: 'https://two.test',
            content: 'Second result',
            score: 0.8,
          },
        ],
        response_time: '0.42',
        usage: { credits: 1 },
      }),
    );
    globalThis.fetch = mockFetch;

    const result = await executeTavilyTool(
      {
        query: '  latest AI news  ',
        topic: 'news',
        search_depth: 'advanced',
        max_results: '99',
        time_range: 'week',
      },
      TAVILY_CONFIG,
    );

    expect(mockFetch).toHaveBeenCalledWith('/api/tavily-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'latest AI news',
        topic: 'news',
        search_depth: 'advanced',
        max_results: 10,
        time_range: 'week',
      }),
    });
    expect(JSON.parse(result)).toEqual({
      query: 'latest AI news',
      answer: 'Recent AI news summary',
      results: [
        {
          title: 'One',
          url: 'https://one.test',
          content: 'First result',
          score: 0.9,
          favicon: null,
        },
        {
          title: 'Two',
          url: 'https://two.test',
          content: 'Second result',
          score: 0.8,
          favicon: null,
        },
      ],
      response_time: '0.42',
      credits: 1,
    });
  });

  it('returns a compact error string when the proxy rejects the request', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse(503, { error: 'Missing tavily.apiKey in config.json' }),
      );

    await expect(executeTavilyTool({ query: 'test' }, TAVILY_CONFIG)).resolves.toBe(
      'error: Missing tavily.apiKey in config.json',
    );
  });
});
