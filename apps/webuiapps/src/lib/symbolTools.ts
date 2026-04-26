import type { ToolDef } from './llmClient';

const TOOL_NAME = 'open_symbol';

export function getSymbolToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Find likely symbol definitions in the OpenVSCode workspace and optionally open the best match in Aoi\'s IDE.',
        parameters: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Function, component, class, interface, or type name to find',
            },
            directory: {
              type: 'string',
              description: 'Optional directory relative to the IDE workspace root.',
            },
            open_in_ide: {
              type: 'boolean',
              description: 'When true, open the best match in Aoi\'s IDE after resolving it.',
            },
          },
          required: ['symbol'],
        },
      },
    },
  ];
}

export function isSymbolTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executeSymbolTool(params: Record<string, unknown>): Promise<string> {
  const symbol = String(params.symbol || '').trim();
  if (!symbol) return 'error: missing symbol';

  const url = new URL('/api/openvscode/symbol', window.location.origin);
  url.searchParams.set('symbol', symbol);
  if (typeof params.directory === 'string' && params.directory.trim()) {
    url.searchParams.set('directory', params.directory.trim());
  }

  const res = await fetch(url.toString());
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as { error?: string };
      return `error: ${data.error || `Symbol search API error ${res.status}`}`;
    }
    return `error: ${await res.text()}`;
  }

  return JSON.stringify(await res.json());
}
