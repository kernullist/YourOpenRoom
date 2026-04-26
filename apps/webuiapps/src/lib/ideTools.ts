import type { ToolDef } from './llmClient';

const TOOL_NAME = 'ide_search';

export function getIdeToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          "Search Aoi's IDE workspace files by path and optional file content. " +
          'Use this when the user asks about code, files, symbols, or repository contents.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search text to match against workspace file paths or file content',
            },
            directory: {
              type: 'string',
              description:
                'Optional directory relative to the IDE workspace root. Defaults to the workspace root.',
            },
            mode: {
              type: 'string',
              description: 'Search mode: auto (path + content), path only, or content only',
              enum: ['auto', 'path', 'content'],
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of matches to return, between 1 and 20.',
            },
          },
          required: ['query'],
        },
      },
    },
  ];
}

export function isIdeTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executeIdeTool(params: Record<string, unknown>): Promise<string> {
  const query = String(params.query || '').trim();
  if (!query) return 'error: missing query';

  const url = new URL('/api/openvscode/search', window.location.origin);
  url.searchParams.set('query', query);
  if (typeof params.directory === 'string' && params.directory.trim()) {
    url.searchParams.set('directory', params.directory.trim());
  }
  if (params.mode === 'path' || params.mode === 'content') {
    url.searchParams.set('mode', params.mode);
  }
  if (params.max_results !== undefined) {
    url.searchParams.set('max_results', String(params.max_results));
  }

  const res = await fetch(url.toString());
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as { error?: string };
      return `error: ${data.error || `IDE search API error ${res.status}`}`;
    }
    return `error: ${await res.text()}`;
  }

  return JSON.stringify(await res.json());
}
