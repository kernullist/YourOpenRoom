// Pure helpers for the report table of contents. Extracting headings from the
// markdown and slugifying them are kept here (and unit-tested) so the component
// only has to render the list and scroll to an id. The heading render override
// slugifies the same text with slugifyHeading, so ids and TOC links agree.

export interface AoiResearchTocEntry {
  level: 2 | 3;
  text: string;
  slug: string;
}

// Slugify heading text into an element id. Keeps unicode letters/numbers so
// Korean/CJK headings still get a usable id; collapses everything else to '-'.
export function slugifyHeading(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

// Extract level-2/3 headings from report markdown, skipping the H1 title and
// anything inside fenced code blocks (so a '#' inside a ```mermaid block or a
// code sample is never mistaken for a heading).
export function extractReportToc(markdown: string): AoiResearchTocEntry[] {
  if (!markdown) {
    return [];
  }
  const entries: AoiResearchTocEntry[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const text = match[2].trim();
    if (!text) {
      continue;
    }
    entries.push({
      level: match[1].length as 2 | 3,
      text,
      slug: slugifyHeading(text),
    });
  }
  return entries;
}
