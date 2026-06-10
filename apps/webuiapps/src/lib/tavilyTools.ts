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

function clampMaxResults(value: unknown): number {
  const parsed = Number(value ?? 5);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(10, Math.max(1, Math.trunc(parsed)));
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

async function readTavilyResponse(res: Response): Promise<TavilySearchResponse> {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as TavilySearchResponse;
  } catch {
    return { error: text.slice(0, 500) };
  }
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
    topic: normalizeEnum(params.topic, ['general', 'news', 'finance'] as const, 'general'),
    search_depth: normalizeEnum(
      params.search_depth,
      ['basic', 'advanced', 'fast', 'ultra-fast'] as const,
      'basic',
    ),
    max_results: clampMaxResults(params.max_results),
    ...(params.time_range
      ? {
          time_range: normalizeEnum(
            params.time_range,
            ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'] as const,
            'day',
          ),
        }
      : {}),
  };

  if (!payload.query) return 'error: missing query';

  let res: Response;
  try {
    res = await fetch('/api/tavily-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  const data = await readTavilyResponse(res);
  if (!res.ok) return `error: ${data.error || `Tavily search failed (${res.status})`}`;

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
