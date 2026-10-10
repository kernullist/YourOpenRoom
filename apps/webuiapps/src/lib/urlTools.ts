import type { ToolDef } from './llmClient';
import { defuseRoleMarkers, UNTRUSTED_PAGE_TEXT_NOTE } from './aoiUntrustedText';
import {
  buildBrowserReaderProxyUrl,
  isLikelyInteractiveHomePage,
  normalizeUrlInput,
  parseReadablePageSnapshot,
} from './readerExtraction';

export { parseReadablePageSnapshot } from './readerExtraction';

const TOOL_NAME = 'read_url';
const MAX_BLOCKS = 16;

// The proxy's refusals, in words of our own. Its message quotes the address it
// refused -- which a redirect chose -- so a known reason is said this way, and
// anything else is defused and kept short.
const REFUSAL_WORDS: Record<string, string> = {
  unsupported_scheme:
    'refused: the page, or a redirect from it, pointed at something other than http(s)',
  credentials_in_url: 'refused: the address carries a user name or password',
  private_host: 'refused: the page, or a redirect from it, points at a private or local address',
  private_address: 'refused: the page, or a redirect from it, points at a private or local address',
  unresolvable_host: 'the host name could not be resolved',
  too_many_redirects: 'the page redirected too many times',
};

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
      const data = (await res.json()) as { error?: string; reason?: string };
      const known = typeof data.reason === 'string' ? REFUSAL_WORDS[data.reason] : undefined;
      if (known) {
        return `error: ${known}`;
      }
      return `error: ${defuseRoleMarkers(truncateText(data.error || 'Failed to load URL', 300))}`;
    }
    // The body is the site's own error page: a whole HTML document, in words
    // the site chose. The status is what the model needs.
    return `error: the site answered HTTP ${res.status}`;
  }

  const html = await res.text();
  const snapshot = parseReadablePageSnapshot(html, finalUrl, { maxBlocks });
  return JSON.stringify({
    url,
    final_url: snapshot.finalUrl,
    title: defuseRoleMarkers(truncateText(snapshot.title, 200)),
    site_name: defuseRoleMarkers(truncateText(snapshot.siteName, 120)),
    excerpt: defuseRoleMarkers(truncateText(snapshot.excerpt, 240)),
    blocks: snapshot.blocks.map((block) => ({
      type: block.type,
      text: defuseRoleMarkers(truncateText(block.text, 280)),
    })),
    note: UNTRUSTED_PAGE_TEXT_NOTE,
  });
}
