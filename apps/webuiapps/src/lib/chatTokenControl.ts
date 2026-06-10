import type { ChatMessage } from './llmClient';
import { getAppRecognitionEntries } from './appRegistry';

const MAX_RECENT_HISTORY_MESSAGES = 12;
const MAX_SUMMARIZED_HISTORY_ITEMS = 8;
const MAX_HISTORY_SUMMARY_CHARS = 1400;
const MAX_HISTORY_ITEM_CHARS = 180;
const MAX_GENERIC_TOOL_RESULT_CHARS = 2200;
const MAX_FILE_TOOL_RESULT_CHARS = 3200;
const MAX_IDE_FILE_CONTENT_CHARS = 12000;
const MAX_LIST_RESULT_LINES = 60;
const MAX_SEARCH_RESULTS = 3;
const MAX_SEARCH_ANSWER_CHARS = 500;
const MAX_SEARCH_RESULT_CONTENT_CHARS = 220;
const MAX_WORKSPACE_MATCHES = 5;
const MAX_WORKSPACE_SNIPPETS = 2;
const MAX_WORKSPACE_SNIPPET_CHARS = 160;
const MAX_URL_BLOCKS = 6;
const MAX_URL_BLOCK_CHARS = 180;
const MAX_COMMAND_OUTPUT_CHARS = 700;
const MAX_APP_STATE_WINDOWS = 6;
const MAX_APP_STATE_CHARS = 900;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncateForTokenBudget(
  value: string,
  maxChars: number,
  suffix = '\n...[truncated for token budget]',
): string {
  if (value.length <= maxChars) return value;
  const budget = Math.max(0, maxChars - suffix.length);
  return `${value.slice(0, budget).trimEnd()}${suffix}`;
}

function summarizeHistoryLine(message: ChatMessage): string {
  const label =
    message.role === 'assistant'
      ? 'Aoi'
      : message.role === 'user'
        ? 'User'
        : message.role === 'tool'
          ? 'Tool'
          : 'System';
  return `- ${label}: ${truncateForTokenBudget(normalizeWhitespace(message.content), MAX_HISTORY_ITEM_CHARS, '…')}`;
}

export function condenseConversationHistory(history: ChatMessage[]): {
  summaryMessage: ChatMessage | null;
  recentHistory: ChatMessage[];
} {
  const visibleHistory = history.filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  );

  if (visibleHistory.length <= MAX_RECENT_HISTORY_MESSAGES) {
    return { summaryMessage: null, recentHistory: visibleHistory };
  }

  const recentHistory = visibleHistory.slice(-MAX_RECENT_HISTORY_MESSAGES);
  const olderHistory = visibleHistory.slice(0, -MAX_RECENT_HISTORY_MESSAGES);
  const summarySource = olderHistory.slice(-MAX_SUMMARIZED_HISTORY_ITEMS).map(summarizeHistoryLine);

  const summaryContent = truncateForTokenBudget(
    [
      `Earlier conversation summary (${olderHistory.length} older messages compressed for token budget):`,
      ...summarySource,
      'Prefer the recent messages below when resolving details.',
    ].join('\n'),
    MAX_HISTORY_SUMMARY_CHARS,
  );

  return {
    summaryMessage: { role: 'system', content: summaryContent },
    recentHistory,
  };
}

function summarizeSearchToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      query?: string;
      answer?: string;
      results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
      response_time?: number | string;
      credits?: number;
    };
    return JSON.stringify({
      query: parsed.query || '',
      answer: truncateForTokenBudget(parsed.answer || '', MAX_SEARCH_ANSWER_CHARS, '…'),
      results: (parsed.results || []).slice(0, MAX_SEARCH_RESULTS).map((item) => ({
        title: item.title || '',
        url: item.url || '',
        content: truncateForTokenBudget(item.content || '', MAX_SEARCH_RESULT_CONTENT_CHARS, '…'),
        score: item.score,
      })),
      response_time: parsed.response_time,
      credits: parsed.credits,
    });
  } catch {
    return truncateForTokenBudget(result, MAX_GENERIC_TOOL_RESULT_CHARS);
  }
}

function summarizeListLikeResult(result: string): string {
  const lines = result.split(/\r?\n/);
  if (lines.length <= MAX_LIST_RESULT_LINES) return result;
  return [
    ...lines.slice(0, MAX_LIST_RESULT_LINES),
    `...(${lines.length - MAX_LIST_RESULT_LINES} more lines truncated for token budget)`,
  ].join('\n');
}

function summarizeWorkspaceSearchResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      query?: string;
      directory?: string;
      mode?: string;
      scanned_files?: number;
      scanned_directories?: number;
      total_matches?: number;
      has_more?: boolean;
      matches?: Array<{
        path?: string;
        type?: string;
        match_type?: string;
        snippets?: Array<{ line?: number; text?: string }>;
      }>;
    };

    return JSON.stringify({
      query: parsed.query || '',
      directory: parsed.directory || '/',
      mode: parsed.mode || 'auto',
      scanned_files: parsed.scanned_files ?? 0,
      scanned_directories: parsed.scanned_directories ?? 0,
      total_matches: parsed.total_matches ?? parsed.matches?.length ?? 0,
      has_more: !!parsed.has_more,
      matches: (parsed.matches || []).slice(0, MAX_WORKSPACE_MATCHES).map((match) => ({
        path: match.path || '',
        type: match.type || 'file',
        match_type: match.match_type || 'path',
        snippets: (match.snippets || []).slice(0, MAX_WORKSPACE_SNIPPETS).map((snippet) => ({
          line: snippet.line ?? 0,
          text: truncateForTokenBudget(snippet.text || '', MAX_WORKSPACE_SNIPPET_CHARS, '…'),
        })),
      })),
    });
  } catch {
    return truncateForTokenBudget(result, MAX_GENERIC_TOOL_RESULT_CHARS);
  }
}

function summarizeIdeFileToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      path?: string;
      source?: string;
      line_count?: number;
      char_count?: number;
      range?: unknown;
      content_truncated?: boolean;
      content?: string;
      active_path?: string | null;
      active_file?: {
        path?: string;
        name?: string;
        language?: string;
        dirty?: boolean;
        cursor?: unknown;
        line_count?: number;
        char_count?: number;
        content_truncated?: boolean;
        source?: string;
        content?: string;
      } | null;
      open_tabs?: Array<Record<string, unknown>>;
      workspace_root?: string | null;
      workspace_exists?: boolean | null;
      ui?: unknown;
      updated_at?: unknown;
    };

    if (parsed.active_file) {
      return JSON.stringify({
        active_path: parsed.active_path ?? parsed.active_file.path ?? null,
        active_file: {
          ...parsed.active_file,
          content:
            typeof parsed.active_file.content === 'string'
              ? truncateForTokenBudget(parsed.active_file.content, MAX_IDE_FILE_CONTENT_CHARS, '…')
              : undefined,
        },
        open_tabs: (parsed.open_tabs || []).slice(0, 10),
        workspace_root: parsed.workspace_root ?? null,
        workspace_exists: parsed.workspace_exists ?? null,
        ui: parsed.ui ?? null,
        updated_at: parsed.updated_at ?? null,
      });
    }

    return JSON.stringify({
      path: parsed.path ?? '',
      source: parsed.source ?? null,
      line_count: parsed.line_count ?? null,
      char_count: parsed.char_count ?? null,
      range: parsed.range ?? null,
      content_truncated: !!parsed.content_truncated,
      content:
        typeof parsed.content === 'string'
          ? truncateForTokenBudget(parsed.content, MAX_IDE_FILE_CONTENT_CHARS, '…')
          : '',
    });
  } catch {
    return truncateForTokenBudget(result, MAX_IDE_FILE_CONTENT_CHARS);
  }
}

function summarizeUrlToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      url?: string;
      final_url?: string;
      title?: string;
      site_name?: string;
      excerpt?: string;
      blocks?: Array<{ type?: string; text?: string }>;
    };

    return JSON.stringify({
      url: parsed.url || '',
      final_url: parsed.final_url || parsed.url || '',
      title: parsed.title || '',
      site_name: parsed.site_name || '',
      excerpt: truncateForTokenBudget(parsed.excerpt || '', 220, '…'),
      blocks: (parsed.blocks || []).slice(0, MAX_URL_BLOCKS).map((block) => ({
        type: block.type || 'paragraph',
        text: truncateForTokenBudget(block.text || '', MAX_URL_BLOCK_CHARS, '…'),
      })),
    });
  } catch {
    return truncateForTokenBudget(result, MAX_GENERIC_TOOL_RESULT_CHARS);
  }
}

function summarizeCommandToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      command?: string;
      cwd?: string;
      exitCode?: number;
      timedOut?: boolean;
      durationMs?: number;
      stdout?: string;
      stderr?: string;
    };

    return JSON.stringify({
      command: parsed.command || '',
      cwd: parsed.cwd || '.',
      exitCode: parsed.exitCode ?? -1,
      timedOut: !!parsed.timedOut,
      durationMs: parsed.durationMs ?? 0,
      stdout: truncateForTokenBudget(parsed.stdout || '', MAX_COMMAND_OUTPUT_CHARS, '…'),
      stderr: truncateForTokenBudget(parsed.stderr || '', MAX_COMMAND_OUTPUT_CHARS, '…'),
    });
  } catch {
    return truncateForTokenBudget(result, MAX_GENERIC_TOOL_RESULT_CHARS);
  }
}

function summarizeAppStateToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      open_window_count?: number;
      active_app_name?: string | null;
      windows?: Array<Record<string, unknown>>;
      app?: Record<string, unknown>;
      state?: unknown;
      state_summary?: unknown;
      workspace?: unknown;
    };

    return JSON.stringify({
      open_window_count: parsed.open_window_count ?? parsed.windows?.length ?? 0,
      active_app_name: parsed.active_app_name ?? null,
      app: parsed.app ?? null,
      windows: (parsed.windows || []).slice(0, MAX_APP_STATE_WINDOWS),
      workspace: parsed.workspace ?? null,
      state_summary: parsed.state_summary ?? null,
      state:
        parsed.state === undefined
          ? null
          : truncateForTokenBudget(JSON.stringify(parsed.state), MAX_APP_STATE_CHARS, '…'),
    });
  } catch {
    return truncateForTokenBudget(result, MAX_GENERIC_TOOL_RESULT_CHARS);
  }
}

function summarizeAppActionToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      ok?: boolean;
      source_app?: Record<string, unknown>;
      target_app?: Record<string, unknown> | null;
      action_type?: string;
      params?: Record<string, unknown>;
      raw_result?: string;
      user_facing_name?: string;
    };

    return JSON.stringify({
      ok: parsed.ok ?? null,
      source_app: parsed.source_app ?? null,
      target_app: parsed.target_app ?? null,
      action_type: parsed.action_type ?? '',
      params: parsed.params ?? {},
      user_facing_name: parsed.user_facing_name ?? null,
      raw_result:
        typeof parsed.raw_result === 'string'
          ? truncateForTokenBudget(parsed.raw_result, MAX_APP_STATE_CHARS, '…')
          : (parsed.raw_result ?? null),
    });
  } catch {
    return truncateForTokenBudget(result, MAX_GENERIC_TOOL_RESULT_CHARS);
  }
}

function summarizeDiagnosticsToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      command?: string;
      diagnostic_count?: number;
      diagnostics?: Array<Record<string, unknown>>;
      exitCode?: number;
      timedOut?: boolean;
    };
    return JSON.stringify({
      command: parsed.command || '',
      diagnostic_count: parsed.diagnostic_count ?? parsed.diagnostics?.length ?? 0,
      exitCode: parsed.exitCode ?? -1,
      timedOut: !!parsed.timedOut,
      diagnostics: (parsed.diagnostics || []).slice(0, 8),
    });
  } catch {
    return truncateForTokenBudget(result, MAX_GENERIC_TOOL_RESULT_CHARS);
  }
}

function summarizeSymbolToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      symbol?: string;
      total_matches?: number;
      matches?: Array<Record<string, unknown>>;
    };
    return JSON.stringify({
      symbol: parsed.symbol || '',
      total_matches: parsed.total_matches ?? parsed.matches?.length ?? 0,
      matches: (parsed.matches || []).slice(0, 6),
    });
  } catch {
    return truncateForTokenBudget(result, MAX_GENERIC_TOOL_RESULT_CHARS);
  }
}

function summarizeSemanticToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (Array.isArray(parsed.references)) {
      return JSON.stringify({
        symbol: parsed.symbol || '',
        total_matches: parsed.total_matches ?? parsed.references.length,
        references: parsed.references.slice(0, 10),
      });
    }
    if (parsed.definition && typeof parsed.definition === 'object') {
      return JSON.stringify({
        symbol: parsed.symbol || '',
        definition: parsed.definition,
      });
    }
    if (Array.isArray(parsed.files)) {
      return JSON.stringify({
        symbol: parsed.symbol || '',
        newName: parsed.newName || '',
        checkpoint_id: parsed.checkpoint_id || null,
        total_references: parsed.total_references ?? 0,
        files: parsed.files.slice(0, 10),
      });
    }
    if (Array.isArray(parsed.exports)) {
      return JSON.stringify({
        directory: parsed.directory || '/',
        total_matches: parsed.total_matches ?? parsed.exports.length,
        exports: parsed.exports.slice(0, 10),
      });
    }
    return JSON.stringify(parsed);
  } catch {
    return truncateForTokenBudget(result, MAX_GENERIC_TOOL_RESULT_CHARS);
  }
}

function summarizeCheckpointToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return JSON.stringify({
      checkpoint_id: parsed.checkpoint_id ?? parsed.id ?? null,
      name: parsed.name ?? null,
      scope: parsed.scope ?? null,
      roots: parsed.roots ?? [],
      fileCount: parsed.fileCount ?? parsed.file_count ?? null,
      restored: parsed.restored ?? null,
      deleted: parsed.deleted ?? null,
      checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints.slice(0, 10) : undefined,
    });
  } catch {
    return truncateForTokenBudget(result, MAX_GENERIC_TOOL_RESULT_CHARS);
  }
}

function summarizeAutofixMacroResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      checkpoint_id?: string;
      command?: string;
      diagnostics?: unknown;
    };
    return JSON.stringify({
      checkpoint_id: parsed.checkpoint_id ?? null,
      command: parsed.command ?? '',
      diagnostics:
        parsed.diagnostics && typeof parsed.diagnostics === 'object'
          ? JSON.parse(summarizeDiagnosticsToolResult(JSON.stringify(parsed.diagnostics)))
          : (parsed.diagnostics ?? null),
    });
  } catch {
    return truncateForTokenBudget(result, MAX_GENERIC_TOOL_RESULT_CHARS);
  }
}

export function summarizeToolResultForModel(toolName: string, result: string): string {
  const trimmed = result.trim();
  if (!trimmed) return trimmed;
  if (/^error:/i.test(trimmed)) {
    return truncateForTokenBudget(trimmed, 1200);
  }

  switch (toolName) {
    case 'search_web':
      return summarizeSearchToolResult(trimmed);
    case 'workspace_search':
    case 'ide_search':
      return summarizeWorkspaceSearchResult(trimmed);
    case 'ide_current_file':
    case 'ide_read_file':
      return summarizeIdeFileToolResult(trimmed);
    case 'ide_patch_file':
    case 'ide_write_file':
      return truncateForTokenBudget(trimmed, MAX_GENERIC_TOOL_RESULT_CHARS);
    case 'get_app_schema':
      return truncateForTokenBudget(trimmed, MAX_GENERIC_TOOL_RESULT_CHARS);
    case 'read_url':
      return summarizeUrlToolResult(trimmed);
    case 'run_command':
      return summarizeCommandToolResult(trimmed);
    case 'structured_diagnostics':
      return summarizeDiagnosticsToolResult(trimmed);
    case 'open_symbol':
      return summarizeSymbolToolResult(trimmed);
    case 'find_references':
    case 'list_exports':
      return summarizeSemanticToolResult(trimmed);
    case 'workspace_checkpoint':
      return summarizeCheckpointToolResult(trimmed);
    case 'autofix_diagnostics':
      return summarizeAutofixMacroResult(trimmed);
    case 'get_app_state':
      return summarizeAppStateToolResult(trimmed);
    case 'app_action':
      return summarizeAppActionToolResult(trimmed);
    case 'file_read':
      return truncateForTokenBudget(trimmed, MAX_FILE_TOOL_RESULT_CHARS);
    case 'file_list':
    case 'list_apps':
      return summarizeListLikeResult(trimmed);
    default:
      return truncateForTokenBudget(trimmed, MAX_GENERIC_TOOL_RESULT_CHARS);
  }
}

function normalizeSearchToken(value: string): string {
  return normalizeWhitespace(value).trim();
}

function isAsciiSearchToken(value: string): boolean {
  return /^[a-z0-9][a-z0-9' -]*$/i.test(value);
}

function hasSearchToken(text: string, token: string): boolean {
  const normalizedToken = normalizeSearchToken(token);

  if (isAsciiSearchToken(normalizedToken)) {
    if (normalizedToken.length < 3) {
      return false;
    }

    const pattern = normalizedToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(^|[^a-z0-9])${pattern}(?=$|[^a-z0-9])`, 'i').test(text);
  }

  if (normalizedToken.length < 2) {
    return false;
  }

  return normalizeWhitespace(text).toLowerCase().includes(normalizedToken.toLowerCase());
}

function hasRegistryAppMention(text: string): boolean {
  return getAppRecognitionEntries().some((app) => {
    const tokens = [app.displayName, app.appName, ...app.aliases];
    return tokens.some((token) => hasSearchToken(text, token));
  });
}

function hasExplicitAppMention(text: string): boolean {
  if (hasRegistryAppMention(text)) return true;

  return [
    /\bkira\b/i,
    /\baoi'?s ide\b/i,
    /\bcode editor\b/i,
    /\bbrowser\b/i,
    /\breader\b/i,
    /\bdiary\b/i,
    /\bnotes?\b/i,
    /\bmemo\b/i,
    /\bemail\b/i,
    /\btwitter\b/i,
    /\byoutube\b/i,
    /\bcalendar\b/i,
    /\balbum\b/i,
    /\bchess\b/i,
    /\bgomoku\b/i,
    /\bfreecell\b/i,
    /\bcybernews\b/i,
    /\bevidence vault\b/i,
    /\bwallpaper\b/i,
    /키라/,
    /아오이.?ide|에디터|코드 에디터/,
    /브라우저|일기|메모|이메일|유튜브|캘린더|앨범|체스|오목|프리셀|배경화면/,
  ].some((pattern) => pattern.test(text));
}

function hasBrowserIntent(text: string): boolean {
  return [
    /\b(open|show|save|bookmark|visit)\b.*\b(url|link|page|browser|site|website)\b/i,
    /\b(url|link|page|browser|site|website)\b.*\b(open|show|save|bookmark|visit)\b/i,
    /\b(read|summarize|extract|analyze)\b.*\b(url|link|page|article|website)\b/i,
    /\b(url|link|page|article|website)\b.*\b(read|summarize|extract|analyze)\b/i,
    /\b(open|visit|read|summarize|extract|analyze)\b.*https?:\/\//i,
    /https?:\/\/\S+.*\b(open|visit|read|summarize|extract|analyze)\b/i,
    /(링크|주소|브라우저|페이지).*(열어줘|보여줘|저장해|북마크)/,
    /(열어줘|보여줘|저장해|북마크).*(링크|주소|브라우저|페이지)/,
    /(링크|주소|페이지|기사).*(읽어줘|요약해|추출해|분석해)/,
    /(읽어줘|요약해|추출해|분석해).*(링크|주소|페이지|기사)/,
  ].some((pattern) => pattern.test(text));
}

function hasAppStateIntent(text: string): boolean {
  return [
    /\b(which|what)\b.*\b(app|window)\b.*\b(open|active|focused)\b/i,
    /\b(active|focused|open)\b.*\b(app|window)\b/i,
    /\bapp state\b|\bwindow state\b|\bwhich window\b/i,
    /(어떤).*(앱|창).*(열려|활성|포커스)/,
    /(열린|활성|포커스).*(앱|창)/,
    /(앱 상태|창 상태|어느 창)/,
  ].some((pattern) => pattern.test(text));
}

function hasCodebaseIntent(text: string): boolean {
  return [
    /\b(current|active|opened?|selected|visible)\s+file\b/i,
    /\b(write|save|append|prepend|add|insert|paste|replace|update|edit)\b.*\b(current|active|opened?|visible)?\s*file\b/i,
    /\b(current|active|opened?|visible)?\s*file\b.*\b(write|save|append|prepend|add|insert|paste|replace|update|edit)\b/i,
    /\b(find|search|locate|grep|open|read|inspect|check|write|save|append|prepend|add|insert|paste|replace|update|edit)\b.*\b(code|repo|repository|workspace|file|files|function|symbol|class|component|hook)\b/i,
    /\b(code|repo|repository|workspace|file|files|function|symbol|class|component|hook)\b.*\b(find|search|locate|grep|open|read|inspect|check|write|save|append|prepend|add|insert|paste|replace|update|edit)\b/i,
    /(현재|활성|열린|보이는)\s*파일/,
    /(방금|아까|그거|이거|그 내용|위 내용|앞 내용).*(현재|활성|열린|보이는)?\s*파일.*(써줘|작성|추가|붙여|반영|저장|수정|편집)/,
    /(현재|활성|열린|보이는)?\s*파일.*(방금|아까|그거|이거|그 내용|위 내용|앞 내용).*(써줘|작성|추가|붙여|반영|저장|수정|편집)/,
    /(코드|레포|리포지토리|워크스페이스|파일|함수|심볼|클래스|컴포넌트|훅).*(찾아|검색|열어|읽어|확인|검사|써줘|작성|추가|붙여|반영|저장|수정|편집)/,
    /(찾아|검색|열어|읽어|확인|검사|써줘|작성|추가|붙여|반영|저장|수정|편집).*(코드|레포|리포지토리|워크스페이스|파일|함수|심볼|클래스|컴포넌트|훅)/,
  ].some((pattern) => pattern.test(text));
}

function hasPlaybackIntent(text: string): boolean {
  return [/\b(play|listen|put on|queue)\b/i, /(재생|틀어|들려|듣자|들어보자)/].some((pattern) =>
    pattern.test(text),
  );
}

function isShortFollowUpAction(text: string): boolean {
  return [
    /\b(open|show|save|delete|remove|play|refresh|close)\b.*\b(it|that|this|there)\b/i,
    /\b(it|that|this|there)\b.*\b(open|show|save|delete|remove|play|refresh|close)\b/i,
    /(그거|이거|저거|그 앱|이 앱).*(열어줘|보여줘|저장해|삭제해|틀어줘|재생해|새로고침)/,
    /(열어줘|보여줘|저장해|삭제해|틀어줘|재생해|새로고침).*(그거|이거|저거|그 앱|이 앱)/,
  ].some((pattern) => pattern.test(text));
}

function hasDirectOperationalIntent(text: string): boolean {
  return [
    /\b(open|launch|run|start|show|close|reload|refresh|search|play|listen|save|delete|remove|create|update|edit|bookmark|visit|read|summarize|extract|analyze|inspect|check)\b/i,
    /(열어줘|띄워줘|켜줘|보여줘|닫아줘|새로고침|검색해|찾아줘|틀어줘|재생해|저장해|삭제해|만들어줘|수정해|편집해|읽어줘|요약해|추출해|분석해|확인해|써줘|작성해|추가해|붙여넣어|반영해)/,
  ].some((pattern) => pattern.test(text));
}

export function shouldEnableAppTools(
  latestUserMessage: string,
  history: ChatMessage[] = [],
): boolean {
  const latest = normalizeWhitespace(latestUserMessage).toLowerCase();
  if (!latest) return false;
  if (latest.includes('[user performed action in')) return true;

  const recentContext = normalizeWhitespace(
    history
      .slice(-2)
      .map((m) => m.content)
      .join('\n'),
  ).toLowerCase();
  if (recentContext.includes('[user performed action in')) return true;

  if (hasExplicitAppMention(latestUserMessage)) return true;
  if (hasBrowserIntent(latestUserMessage)) return true;
  if (hasAppStateIntent(latestUserMessage)) return true;
  if (hasCodebaseIntent(latestUserMessage)) return true;
  if (
    hasPlaybackIntent(latestUserMessage) &&
    /(youtube|song|music|track|artist|유튜브|노래|음악)/i.test(latestUserMessage)
  ) {
    return true;
  }

  if (
    isShortFollowUpAction(latestUserMessage) &&
    (hasExplicitAppMention(recentContext) ||
      hasBrowserIntent(recentContext) ||
      hasPlaybackIntent(recentContext))
  ) {
    return true;
  }

  return false;
}

export function shouldUseDialogModel(
  latestUserMessage: string,
  history: ChatMessage[] = [],
): boolean {
  const latest = normalizeWhitespace(latestUserMessage);
  if (!latest) return false;
  if (latest.length > 240) return false;
  if (/\bhttps?:\/\//i.test(latest)) return false;
  if (shouldUseWebSearch(latestUserMessage)) return false;

  const heavyIntentPatterns = [
    /\b(search|look up|verify|compare|latest|current|recent|news)\b/i,
    /\b(image|draw|generate|illustration|picture|photo)\b/i,
    /\bremember\b/i,
    /\bwhy\b|\bhow\b|\bexplain\b/i,
    /(검색|찾아|검증|비교|최신|현재|최근|뉴스)/,
    /(이미지|그림|생성|사진)/,
    /(기억해|기억해줘|왜|어떻게|설명해)/,
  ];
  if (heavyIntentPatterns.some((pattern) => pattern.test(latestUserMessage))) return false;
  if (hasAppStateIntent(latestUserMessage)) return false;
  if (hasCodebaseIntent(latestUserMessage)) return false;

  const recentContext = normalizeWhitespace(
    history
      .slice(-2)
      .map((m) => m.content)
      .join('\n'),
  );

  const requiresToolingNow =
    hasDirectOperationalIntent(latestUserMessage) &&
    (hasExplicitAppMention(latestUserMessage) ||
      hasBrowserIntent(latestUserMessage) ||
      hasAppStateIntent(latestUserMessage) ||
      hasCodebaseIntent(latestUserMessage) ||
      hasPlaybackIntent(latestUserMessage) ||
      isShortFollowUpAction(latestUserMessage) ||
      shouldEnableAppTools(latestUserMessage, history));

  if (requiresToolingNow) return false;

  if (
    isShortFollowUpAction(latestUserMessage) &&
    (hasExplicitAppMention(recentContext) ||
      hasBrowserIntent(recentContext) ||
      hasAppStateIntent(recentContext) ||
      hasCodebaseIntent(recentContext) ||
      hasPlaybackIntent(recentContext))
  ) {
    return false;
  }

  return true;
}

const WEB_SEARCH_DIRECT_PATTERNS = [
  /\b(search|look up|web search|internet search|latest|recent|news|breaking)\b/i,
  /\bcurrent\b.*\b(info|information|news|price|pricing|status|version|availability|available)\b/i,
  /\b(still|currently)\b.*\b(available|supported|works|usable|accessible)\b/i,
  /\b(on the web|from the web|online)\b/i,
  /\b(check|verify|confirm|fact[- ]?check)\b.*\b(web|internet|online|fact|claim|rumor|latest|current|recent)\b/i,
  /\b(web|internet|online)\b.*\b(check|verify|confirm|fact[- ]?check)\b/i,
  /(웹\s*검색|인터넷\s*검색|구글링|검색해|검색해줘|검색해서|조사해|조사해줘|최신|최근|뉴스|속보)/,
];

const WEB_SEARCH_TRUTH_CHECK_PATTERNS = [
  /(?:\bis it true\b|\bis that true\b|\btrue\?|\breally\?|\bcan you confirm\b|\bfact[- ]?check this\b|\bdoes .* still\b|\bis .* still\b)/i,
  /(진짜야|진짜임|정말이야|사실이야|사실인가|사실인지|맞아[?？]?|맞나요|맞는지|맞는\s*거야|맞는\s*건가|맞다던데|맞다고\s*하던데|확실해|가능하다던데|라던데|라는데|다던데|한다던데|라고\s*하던데)/,
];

const WEB_SEARCH_VOLATILE_FACT_PATTERNS = [
  /\b\d{1,2}[/-]\d{1,2}\b/,
  /\b20\d{2}[-./]\d{1,2}[-./]\d{1,2}\b/,
  /\d{1,2}\s*월\s*\d{1,2}\s*일/,
  /\b(api only|model|pricing|release|availability|available|deprecated|sunset|after|since|until|only|policy|announcement|launch|access|subscription|beta)\b/i,
  /\b(openai|anthropic|claude|chatgpt|google|gemini|microsoft|github|apple|meta|tavily|fable)\b/i,
  /(api로만|모델|가격|요금|출시|릴리스|배포|사용\s*가능|사용가능|지원|종료|중단|폐지|변경|정책|발표|공지|이후|이후로|부터|까지만|만\s*사용|만\s*가능|구독|베타|접근|제공)/i,
  /(오픈ai|오픈AI|앤트로픽|클로드|챗gpt|챗GPT|구글|제미나이|마이크로소프트|깃허브|애플|메타|타빌리|페이블)/i,
];

export function shouldUseWebSearch(latestUserMessage: string): boolean {
  const latest = normalizeWhitespace(latestUserMessage);
  if (!latest) return false;

  if (WEB_SEARCH_DIRECT_PATTERNS.some((pattern) => pattern.test(latest))) return true;

  const hasTruthCheckCue = WEB_SEARCH_TRUTH_CHECK_PATTERNS.some((pattern) => pattern.test(latest));
  if (!hasTruthCheckCue) return false;

  return WEB_SEARCH_VOLATILE_FACT_PATTERNS.some((pattern) => pattern.test(latest));
}
