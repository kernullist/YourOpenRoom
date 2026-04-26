export interface ReaderBlock {
  type: 'heading' | 'paragraph' | 'quote' | 'list';
  text: string;
}

export interface ReadablePageSnapshot {
  finalUrl: string;
  title: string;
  excerpt: string;
  siteName: string;
  blocks: ReaderBlock[];
}

export function normalizeUrlInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function buildBrowserReaderProxyUrl(url: string): string {
  return `/api/browser-reader?url=${encodeURIComponent(url)}`;
}

export function isLikelyInteractiveHomePage(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const search = parsed.search.trim();
    if (/(\.|^)google\./.test(host) && pathname === '/' && !search) return true;
    if ((host === 'www.youtube.com' || host === 'youtube.com') && pathname === '/' && !search) {
      return true;
    }
    if (
      (host === 'x.com' ||
        host === 'www.x.com' ||
        host === 'twitter.com' ||
        host === 'www.twitter.com') &&
      pathname === '/' &&
      !search
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function stripCollapsedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

export function parseReadablePageSnapshot(
  html: string,
  sourceUrl: string,
  options: { maxBlocks?: number; minBlockLength?: number } = {},
): ReadablePageSnapshot {
  const maxBlocks = Math.max(1, Math.min(32, options.maxBlocks ?? 30));
  const minBlockLength = Math.max(1, options.minBlockLength ?? 30);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, iframe, svg, canvas').forEach((node) =>
    node.remove(),
  );

  const title =
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
    doc.title?.trim() ||
    sourceUrl;

  const siteName =
    doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim() ||
    new URL(sourceUrl).hostname.replace(/^www\./, '');

  const excerpt =
    doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ||
    doc.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() ||
    '';

  const root =
    doc.querySelector('article') ||
    doc.querySelector('main') ||
    doc.querySelector('[role="main"]') ||
    doc.querySelector('.article') ||
    doc.querySelector('.post') ||
    doc.querySelector('.entry-content') ||
    doc.querySelector('.content') ||
    doc.body;

  const nodes = Array.from(root.querySelectorAll('h1, h2, h3, p, li, blockquote'));
  const blocks: ReaderBlock[] = [];
  for (const node of nodes) {
    const text = stripCollapsedText(node.textContent || '');
    if (text.length < minBlockLength) continue;
    const type =
      node.tagName === 'BLOCKQUOTE'
        ? 'quote'
        : node.tagName === 'LI'
          ? 'list'
          : /^H[1-3]$/.test(node.tagName)
            ? 'heading'
            : 'paragraph';
    blocks.push({ type, text: truncateText(text, 320) });
    if (blocks.length >= maxBlocks) break;
  }

  const fallbackExcerpt = excerpt || blocks.find((block) => block.type === 'paragraph')?.text || title;
  return {
    finalUrl: sourceUrl,
    title: truncateText(title, 240),
    excerpt: truncateText(fallbackExcerpt, 260),
    siteName: truncateText(siteName, 120),
    blocks,
  };
}
