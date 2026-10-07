// Allowlist sanitizer for markdown rendered with rehype-raw.
//
// rehype-raw turns raw HTML inside markdown into real elements. Without a
// sanitizer after it, entry text -- written by the agent (which reads web pages)
// or pasted by the user -- could carry <iframe srcdoc="<script>...">, <style>,
// <form> or event-handler attributes into the app's own origin. This keeps what
// markdown/GFM itself produces plus the custom-markup span the Diary uses, and
// removes or unwraps everything else.

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

// Removed together with their contents: active content or document plumbing.
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'noscript',
  'template',
  'link',
  'meta',
  'base',
  'head',
  'title',
  'form',
  'button',
  'textarea',
  'select',
  'option',
  'svg',
  'math',
  'video',
  'audio',
  'source',
  'track',
  'canvas',
  'portal',
]);

// Per-element attribute allowlist (hast property names).
const ALLOWED: Record<string, readonly string[]> = {
  a: ['href', 'title'],
  blockquote: [],
  br: [],
  code: ['className'],
  del: [],
  em: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  hr: [],
  img: ['src', 'alt', 'title'],
  input: ['type', 'checked', 'disabled'],
  li: ['className'],
  ol: ['start', 'className'],
  p: [],
  pre: [],
  s: [],
  section: ['className'],
  span: ['dataEffect'],
  strong: [],
  sub: [],
  sup: [],
  table: [],
  tbody: [],
  td: ['align'],
  tfoot: [],
  th: ['align'],
  thead: [],
  tr: [],
  ul: ['className'],
};

const SAFE_URL = /^(?:https?:|mailto:|#|\/(?!\/)|\.{0,2}\/)/i;
const SAFE_IMAGE_URL = /^(?:https?:|data:image\/(?:png|gif|jpe?g|webp);)/i;
const SAFE_CLASS = /^(?:language-[\w-]+|task-list-item|contains-task-list)$/;
const SAFE_EFFECT = /^(?:strike|scribble|messy)$/;

function cleanProperties(tagName: string, properties: Record<string, unknown> = {}) {
  const allowed = ALLOWED[tagName] ?? [];
  const next: Record<string, unknown> = {};
  for (const name of allowed) {
    const value = properties[name];
    if (value === undefined || value === null) continue;
    if (name === 'href' && !(typeof value === 'string' && SAFE_URL.test(value.trim()))) continue;
    if (name === 'src' && !(typeof value === 'string' && SAFE_IMAGE_URL.test(value.trim()))) {
      continue;
    }
    if (name === 'className') {
      const classes = (Array.isArray(value) ? value : [value]).filter(
        (entry): entry is string => typeof entry === 'string' && SAFE_CLASS.test(entry),
      );
      if (classes.length > 0) next.className = classes;
      continue;
    }
    if (name === 'dataEffect' && !(typeof value === 'string' && SAFE_EFFECT.test(value))) {
      continue;
    }
    if (name === 'type' && value !== 'checkbox') continue;
    next[name] = value;
  }
  if (tagName === 'input') {
    // Only GFM task-list checkboxes, and never interactive.
    if (next.type !== 'checkbox') return null;
    next.disabled = true;
  }
  return next;
}

function sanitizeChildren(children: HastNode[] | undefined): HastNode[] {
  const out: HastNode[] = [];
  for (const child of children ?? []) {
    if (child.type === 'comment' || child.type === 'doctype') {
      continue;
    }
    if (child.type !== 'element' || !child.tagName) {
      out.push(child);
      continue;
    }
    const tagName = child.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tagName)) {
      continue;
    }
    if (!(tagName in ALLOWED)) {
      // Unknown or layout-only tags: keep the text, drop the element.
      out.push(...sanitizeChildren(child.children));
      continue;
    }
    const properties = cleanProperties(tagName, child.properties);
    if (properties === null) {
      continue;
    }
    out.push({ ...child, tagName, properties, children: sanitizeChildren(child.children) });
  }
  return out;
}

/** Rehype plugin: run it AFTER rehype-raw. */
export function rehypeAllowlist() {
  return (tree: HastNode): void => {
    tree.children = sanitizeChildren(tree.children);
  };
}
