export type SyntaxLanguage =
  | 'plaintext'
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'markdown'
  | 'python'
  | 'html'
  | 'css'
  | 'yaml'
  | 'shell'
  | 'sql'
  | 'go'
  | 'rust';

export interface HighlightToken {
  text: string;
  className?: string;
}

const JS_KEYWORDS =
  /\b(?:const|let|var|function|return|if|else|switch|case|break|for|while|do|try|catch|finally|throw|new|class|extends|import|from|export|default|async|await|typeof|instanceof|in|of|void|delete|yield)\b/;
const TS_KEYWORDS =
  /\b(?:interface|type|implements|public|private|protected|readonly|enum|namespace|declare|satisfies|as|infer|keyof)\b/;
const COMMON_LITERAL = /\b(?:true|false|null|undefined)\b/;
const NUMBER = /\b\d+(?:\.\d+)?\b/;

function createStickyRegex(source: RegExp): RegExp {
  const flags = source.flags.replace(/g/g, '');
  return new RegExp(source.source, `${flags.includes('y') ? flags : `${flags}y`}`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function detectSyntaxLanguage(filePath: string | null | undefined): SyntaxLanguage {
  if (!filePath) return 'plaintext';
  const normalized = filePath.toLowerCase();

  if (/\.(tsx?|jsx?)$/.test(normalized))
    return /\.tsx?$/.test(normalized) ? 'typescript' : 'javascript';
  if (normalized.endsWith('.json')) return 'json';
  if (/\.(md|markdown)$/.test(normalized)) return 'markdown';
  if (normalized.endsWith('.py')) return 'python';
  if (/\.(html|htm|xml|svg)$/.test(normalized)) return 'html';
  if (/\.(css|scss|less)$/.test(normalized)) return 'css';
  if (/\.(ya?ml)$/.test(normalized)) return 'yaml';
  if (/\.(sh|bash|zsh|ps1)$/.test(normalized)) return 'shell';
  if (normalized.endsWith('.sql')) return 'sql';
  if (normalized.endsWith('.go')) return 'go';
  if (normalized.endsWith('.rs')) return 'rust';

  return 'plaintext';
}

function tokenizeWithPatterns(
  line: string,
  patterns: Array<{ className: string; regex: RegExp }>,
): HighlightToken[] {
  const stickyPatterns = patterns.map((pattern) => ({
    className: pattern.className,
    regex: createStickyRegex(pattern.regex),
  }));

  const tokens: HighlightToken[] = [];
  let cursor = 0;

  while (cursor < line.length) {
    let matched: { className: string; text: string } | null = null;

    for (const pattern of stickyPatterns) {
      pattern.regex.lastIndex = cursor;
      const result = pattern.regex.exec(line);
      if (result?.[0]) {
        matched = {
          className: pattern.className,
          text: result[0],
        };
        break;
      }
    }

    if (matched) {
      tokens.push(matched);
      cursor += matched.text.length;
      continue;
    }

    let nextCursor = cursor + 1;
    while (nextCursor < line.length) {
      const hasUpcomingToken = stickyPatterns.some((pattern) => {
        pattern.regex.lastIndex = nextCursor;
        return Boolean(pattern.regex.exec(line)?.index === nextCursor);
      });
      if (hasUpcomingToken) break;
      nextCursor += 1;
    }

    tokens.push({ text: line.slice(cursor, nextCursor) });
    cursor = nextCursor;
  }

  return tokens;
}

function highlightCodeLike(line: string, extraKeywordPattern?: RegExp): HighlightToken[] {
  const keywordPattern = extraKeywordPattern
    ? new RegExp(`${JS_KEYWORDS.source}|${extraKeywordPattern.source}`)
    : JS_KEYWORDS;

  return tokenizeWithPatterns(line, [
    { className: 'tokenComment', regex: /\/\/.*$/ },
    { className: 'tokenComment', regex: /#.*$/ },
    { className: 'tokenString', regex: /"(?:\\.|[^"\\])*"/ },
    { className: 'tokenString', regex: /'(?:\\.|[^'\\])*'/ },
    { className: 'tokenString', regex: /`(?:\\.|[^`\\])*`/ },
    { className: 'tokenDecorator', regex: /@[A-Za-z_][A-Za-z0-9_]*/ },
    { className: 'tokenKeyword', regex: keywordPattern },
    { className: 'tokenLiteral', regex: COMMON_LITERAL },
    { className: 'tokenNumber', regex: NUMBER },
    { className: 'tokenProperty', regex: /\b[A-Za-z_][A-Za-z0-9_]*(?=\s*:)/ },
    { className: 'tokenFunction', regex: /\b[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/ },
  ]);
}

function highlightJson(line: string): HighlightToken[] {
  return tokenizeWithPatterns(line, [
    { className: 'tokenString', regex: /"(?:\\.|[^"\\])*"(?=\s*:)/ },
    { className: 'tokenString', regex: /"(?:\\.|[^"\\])*"/ },
    { className: 'tokenNumber', regex: NUMBER },
    { className: 'tokenLiteral', regex: /\b(?:true|false|null)\b/ },
  ]);
}

function highlightMarkdown(line: string): HighlightToken[] {
  if (/^\s*#{1,6}\s/.test(line)) {
    return [{ text: line, className: 'tokenHeading' }];
  }
  if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) {
    return tokenizeWithPatterns(line, [
      { className: 'tokenBullet', regex: /^\s*(?:[-*+]|\d+\.)\s/ },
      { className: 'tokenInlineCode', regex: /`[^`]+`/ },
      { className: 'tokenLink', regex: /\[[^\]]+\]\([^)]+\)/ },
      { className: 'tokenEmphasis', regex: /\*\*[^*]+\*\*/ },
      { className: 'tokenEmphasis', regex: /\*[^*]+\*/ },
    ]);
  }
  return tokenizeWithPatterns(line, [
    { className: 'tokenCodeFence', regex: /^```.*$/ },
    { className: 'tokenInlineCode', regex: /`[^`]+`/ },
    { className: 'tokenLink', regex: /\[[^\]]+\]\([^)]+\)/ },
    { className: 'tokenEmphasis', regex: /\*\*[^*]+\*\*/ },
    { className: 'tokenEmphasis', regex: /\*[^*]+\*/ },
    { className: 'tokenQuote', regex: /^>\s.*$/ },
  ]);
}

function highlightYaml(line: string): HighlightToken[] {
  return tokenizeWithPatterns(line, [
    { className: 'tokenComment', regex: /#.*$/ },
    { className: 'tokenProperty', regex: /^\s*[A-Za-z0-9_.-]+(?=\s*:)/ },
    { className: 'tokenString', regex: /"(?:\\.|[^"\\])*"/ },
    { className: 'tokenString', regex: /'(?:\\.|[^'\\])*'/ },
    { className: 'tokenNumber', regex: NUMBER },
    { className: 'tokenLiteral', regex: /\b(?:true|false|null|yes|no|on|off)\b/i },
  ]);
}

function highlightHtml(line: string): HighlightToken[] {
  return tokenizeWithPatterns(line, [
    { className: 'tokenComment', regex: /<!--.*?-->/ },
    { className: 'tokenTag', regex: /<\/?[A-Za-z][^>\s]*/ },
    { className: 'tokenProperty', regex: /\b[A-Za-z_:.-]+(?==)/ },
    { className: 'tokenString', regex: /"(?:\\.|[^"\\])*"/ },
    { className: 'tokenString', regex: /'(?:\\.|[^'\\])*'/ },
  ]);
}

function highlightCss(line: string): HighlightToken[] {
  return tokenizeWithPatterns(line, [
    { className: 'tokenComment', regex: /\/\*.*?\*\// },
    { className: 'tokenProperty', regex: /\b[a-z-]+(?=\s*:)/i },
    { className: 'tokenNumber', regex: /#[0-9a-f]{3,8}\b/i },
    { className: 'tokenNumber', regex: NUMBER },
    { className: 'tokenFunction', regex: /\b[a-z-]+(?=\()/i },
    { className: 'tokenString', regex: /"(?:\\.|[^"\\])*"/ },
    { className: 'tokenString', regex: /'(?:\\.|[^'\\])*'/ },
  ]);
}

function highlightShell(line: string): HighlightToken[] {
  return tokenizeWithPatterns(line, [
    { className: 'tokenComment', regex: /#.*$/ },
    { className: 'tokenVariable', regex: /\$[A-Za-z_][A-Za-z0-9_]*/ },
    { className: 'tokenString', regex: /"(?:\\.|[^"\\])*"/ },
    { className: 'tokenString', regex: /'(?:\\.|[^'\\])*'/ },
    { className: 'tokenKeyword', regex: /\b(?:if|then|else|fi|for|do|done|case|esac|function)\b/ },
    { className: 'tokenFunction', regex: /^\s*[A-Za-z0-9_.-]+/ },
  ]);
}

function highlightSql(line: string): HighlightToken[] {
  return tokenizeWithPatterns(line, [
    { className: 'tokenComment', regex: /--.*$/ },
    {
      className: 'tokenKeyword',
      regex:
        /\b(?:select|from|where|join|inner|left|right|on|group|by|order|insert|into|update|delete|create|table|alter|drop|limit|offset|and|or|as)\b/i,
    },
    { className: 'tokenString', regex: /'(?:''|[^'])*'/ },
    { className: 'tokenNumber', regex: NUMBER },
  ]);
}

function highlightLine(line: string, language: SyntaxLanguage): HighlightToken[] {
  switch (language) {
    case 'typescript':
      return highlightCodeLike(line, TS_KEYWORDS);
    case 'javascript':
    case 'go':
    case 'rust':
      return highlightCodeLike(line);
    case 'python':
      return tokenizeWithPatterns(line, [
        { className: 'tokenComment', regex: /#.*$/ },
        { className: 'tokenDecorator', regex: /@[A-Za-z_][A-Za-z0-9_]*/ },
        {
          className: 'tokenKeyword',
          regex:
            /\b(?:def|class|return|if|elif|else|for|while|try|except|finally|with|as|import|from|lambda|yield|async|await|pass|raise|in|is|not|and|or)\b/,
        },
        { className: 'tokenLiteral', regex: /\b(?:True|False|None)\b/ },
        { className: 'tokenString', regex: /"(?:\\.|[^"\\])*"/ },
        { className: 'tokenString', regex: /'(?:\\.|[^'\\])*'/ },
        { className: 'tokenNumber', regex: NUMBER },
        { className: 'tokenFunction', regex: /\b[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/ },
      ]);
    case 'json':
      return highlightJson(line);
    case 'markdown':
      return highlightMarkdown(line);
    case 'html':
      return highlightHtml(line);
    case 'css':
      return highlightCss(line);
    case 'yaml':
      return highlightYaml(line);
    case 'shell':
      return highlightShell(line);
    case 'sql':
      return highlightSql(line);
    default:
      return [{ text: line }];
  }
}

export function highlightContentByFilePath(
  filePath: string | null | undefined,
  content: string,
): HighlightToken[][] {
  const language = detectSyntaxLanguage(filePath);
  const lines = content.split('\n');
  return lines.map((line) => highlightLine(line, language));
}

export function renderHighlightedHtml(tokens: HighlightToken[]): string {
  return tokens
    .map((token) => {
      const escaped = escapeHtml(token.text);
      return token.className ? `<span class="${token.className}">${escaped}</span>` : escaped;
    })
    .join('');
}
