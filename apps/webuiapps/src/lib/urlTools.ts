import type { ToolDef } from './llmClient';
import {
  buildBrowserReaderProxyUrl,
  isLikelyInteractiveHomePage,
  normalizeUrlInput,
  parseReadablePageSnapshot,
} from './readerExtraction';

export { parseReadablePageSnapshot } from './readerExtraction';

const TOOL_NAME = 'read_url';
const MAX_BLOCKS = 16;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

export function getUrlToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Fetch a specific http or https page and extract a reader-friendly title, excerpt, and main text blocks.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The target page URL',
            },
            max_blocks: {
              type: 'number',
              description: `Optional maximum number of extracted blocks, between 1 and ${MAX_BLOCKS}`,
            },
          },
          required: ['url'],
        },
      },
    },
  ];
}

export function isUrlTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executeUrlTool(params: Record<string, unknown>): Promise<string> {
  const url = normalizeUrlInput(String(params.url || ''));
  if (!url) return 'error: missing url';

  if (isLikelyInteractiveHomePage(url)) {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return JSON.stringify({
      url,
      final_url: url,
      title: host,
      site_name: host,
      excerpt:
        'This page looks like an interactive homepage, so reader extraction may be limited. Try a specific article or result page instead.',
      blocks: [
        {
          type: 'paragraph',
          text: 'This page looks like an interactive homepage, so reader extraction may be limited. Try a specific article or result page instead.',
        },
      ],
    });
  }

  const maxBlocksRaw =
    typeof params.max_blocks === 'number'
      ? Math.floor(params.max_blocks)
      : Number.parseInt(String(params.max_blocks || ''), 10);
  const maxBlocks =
    Number.isFinite(maxBlocksRaw) && maxBlocksRaw > 0
      ? Math.min(MAX_BLOCKS, Math.max(1, maxBlocksRaw))
      : 8;

  const res = await fetch(buildBrowserReaderProxyUrl(url));
  const contentType = res.headers.get('content-type') || '';
  const finalUrl = res.headers.get('x-final-url') || url;

  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as { error?: string };
      return `error: ${data.error || 'Failed to load URL'}`;
    }
    return `error: ${await res.text()}`;
  }

  const html = await res.text();
  const snapshot = parseReadablePageSnapshot(html, finalUrl, { maxBlocks });
  return JSON.stringify({
    url,
    final_url: snapshot.finalUrl,
    title: truncateText(snapshot.title, 200),
    site_name: truncateText(snapshot.siteName, 120),
    excerpt: truncateText(snapshot.excerpt, 240),
    blocks: snapshot.blocks.map((block) => ({
      type: block.type,
      text: truncateText(block.text, 280),
    })),
  });
}
