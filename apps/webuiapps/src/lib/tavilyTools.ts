import type { ToolDef } from './llmClient';
import type { TavilyConfig } from './tavilyClient';

const TOOL_NAME = 'search_web';

interface TavilyToolParams {
  query?: string;
  topic?: 'general' | 'news' | 'finance';
  search_depth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast';
  max_results?: number;
  time_range?: 'day' | 'week' | 'month' | 'year' | 'd' | 'w' | 'm' | 'y';
}

interface TavilyResultItem {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  favicon?: string | null;
}

interface TavilySearchResponse {
  query?: string;
  answer?: string;
  results?: TavilyResultItem[];
  response_time?: number | string;
  usage?: { credits?: number };
  error?: string;
}

export function getTavilyToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Search the live web for current information, news, or facts that may have changed recently. ' +
          'Use this when the user asks you to search, look up, verify, or find recent information.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The web search query to execute' },
            topic: {
              type: 'string',
              description: 'Search topic: general, news, or finance',
              enum: ['general', 'news', 'finance'],
            },
            search_depth: {
              type: 'string',
              description: 'Latency versus relevance tradeoff',
              enum: ['basic', 'advanced', 'fast', 'ultra-fast'],
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of results to return, between 1 and 10',
            },
            time_range: {
              type: 'string',
              description: 'Optional recency filter',
              enum: ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'],
            },
          },
          required: ['query'],
        },
      },
    },
  ];
}

export function isTavilyTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executeTavilyTool(
  params: Record<string, unknown>,
  config: TavilyConfig | null,
): Promise<string> {
  if (!config?.apiKey?.trim()) {
    return 'error: Tavily is not configured. Add tavily.apiKey to config.json first.';
  }

  const payload: TavilyToolParams = {
    query: String(params.query || '').trim(),
    topic: (params.topic as TavilyToolParams['topic']) || 'general',
    search_depth: (params.search_depth as TavilyToolParams['search_depth']) || 'basic',
    max_results: Math.min(10, Math.max(1, Number(params.max_results || 5))),
    ...(params.time_range
      ? { time_range: params.time_range as TavilyToolParams['time_range'] }
      : {}),
  };

  if (!payload.query) return 'error: missing query';

  const res = await fetch('/api/tavily-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = (await res.json()) as TavilySearchResponse;
  if (!res.ok) {
    return `error: ${data.error || 'Tavily search failed'}`;
  }

  return JSON.stringify({
    query: data.query || payload.query,
    answer: data.answer || '',
    results: (data.results || []).slice(0, payload.max_results).map((item) => ({
      title: item.title || '',
      url: item.url || '',
      content: item.content || '',
      score: item.score,
      favicon: item.favicon || null,
    })),
    response_time: data.response_time,
    credits: data.usage?.credits,
  });
}
