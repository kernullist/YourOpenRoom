import type { ChatMessage } from './llmClient';
import { getAppRecognitionEntries } from './appRegistry';
import { shouldEnableIdaSqlTools } from './aoiIdaSqlTools';

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
const MAX_RESEARCH_REPORT_CHARS = 6000;
const MAX_RESEARCH_JSON_CONTENT_CHARS = 2200;
const MAX_RESEARCH_WARNINGS = 3;

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
  let cut = value.slice(0, budget);
  // A code-unit cut can land mid-surrogate-pair (emoji, math-bold titles). The
  // dangling high half would reach the wire as a lone \uD8xx escape, which
  // strict server-side JSON parsers reject ("unexpected end of hex escape").
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}${suffix}`;
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

function summarizeAoiResearchRun(run: unknown): Record<string, unknown> | null {
  if (!run || typeof run !== 'object') return null;
  const record = run as Record<string, unknown>;
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  const verificationWarnings = Array.isArray(record.verificationWarnings)
    ? record.verificationWarnings
    : [];
  return {
    id: record.id ?? '',
    status: record.status ?? '',
    phase: record.phase ?? '',
    statusMessage: record.statusMessage ?? '',
    reportTitle: record.reportTitle ?? undefined,
    sourceCounts: record.sourceCounts ?? undefined,
    claimCount: record.claimCount ?? undefined,
    artifactAvailability: record.artifactAvailability ?? undefined,
    completedAt: record.completedAt ?? undefined,
    warnings: warnings.slice(0, MAX_RESEARCH_WARNINGS),
    verificationWarnings: verificationWarnings.slice(0, MAX_RESEARCH_WARNINGS),
  };
}

function summarizeAoiResearchToolResult(toolName: string, result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      ok?: boolean;
      background?: boolean;
      runId?: string;
      run?: unknown;
      artifact?: string;
      contentType?: string;
      content?: unknown;
      artifactPaths?: unknown;
      aoiMainLlm?: unknown;
    };
    const run = summarizeAoiResearchRun(parsed.run);
    const summary: Record<string, unknown> = {
      ok: parsed.ok === true,
      tool: toolName,
      background: parsed.background === true,
      runId: parsed.runId || (typeof run?.id === 'string' ? run.id : ''),
      run,
    };

    if (parsed.artifact) {
      summary.artifact = parsed.artifact;
      summary.contentType = parsed.contentType || '';
      if (parsed.artifact === 'report' && typeof parsed.content === 'string') {
        summary.content = truncateForTokenBudget(parsed.content, MAX_RESEARCH_REPORT_CHARS);
      } else if (parsed.artifact === 'manifest') {
        summary.content = summarizeAoiResearchRun(parsed.content);
      } else if (parsed.content !== undefined) {
        summary.content = truncateForTokenBudget(
          JSON.stringify(parsed.content),
          MAX_RESEARCH_JSON_CONTENT_CHARS,
        );
      }
    } else {
      summary.artifactPaths = parsed.artifactPaths ?? undefined;
      summary.aoiMainLlm = parsed.aoiMainLlm ?? undefined;
    }

    return JSON.stringify(summary);
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
      byte_count?: number | null;
      modified_at?: number | null;
      sha256?: string | null;
      hash_scope?: string | null;
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
      byte_count: parsed.byte_count ?? null,
      modified_at: parsed.modified_at ?? null,
      sha256: parsed.sha256 ?? null,
      hash_scope: parsed.hash_scope ?? null,
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
      intent_contract_summary?: unknown;
      intent_contracts_preview?: unknown;
      control_surface_summary?: unknown;
      control_surfaces_preview?: unknown;
    };

    return JSON.stringify({
      open_window_count: parsed.open_window_count ?? parsed.windows?.length ?? 0,
      active_app_name: parsed.active_app_name ?? null,
      app: parsed.app ?? null,
      windows: (parsed.windows || []).slice(0, MAX_APP_STATE_WINDOWS),
      workspace: parsed.workspace ?? null,
      intent_contract_summary: parsed.intent_contract_summary ?? null,
      intent_contracts_preview: parsed.intent_contracts_preview ?? null,
      control_surface_summary: parsed.control_surface_summary ?? null,
      control_surfaces_preview: parsed.control_surfaces_preview ?? null,
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

function summarizeAppIntentToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as {
      ok?: boolean;
      error?: string;
      app?: Record<string, unknown>;
      requested_intent?: string;
      summary?: unknown;
      control_surface_summary?: unknown;
      guidance?: string[];
      next_steps?: string[];
      contract?: {
        id?: string;
        intent?: string;
        title?: string;
        execution?: unknown;
        required_tools?: unknown;
        risk?: string;
        gaps?: unknown;
      };
      contract_line?: string;
      intents?: Array<Record<string, unknown>>;
      available_intents?: Array<Record<string, unknown>>;
      contract_lines?: string[];
      control_surfaces?: Array<Record<string, unknown>>;
      control_surface_lines?: string[];
    };

    return JSON.stringify({
      ok: parsed.ok,
      error: parsed.error,
      app: parsed.app ?? null,
      requested_intent: parsed.requested_intent ?? null,
      summary: parsed.summary ?? null,
      control_surface_summary: parsed.control_surface_summary ?? null,
      guidance: (parsed.guidance || []).slice(0, 4),
      next_steps: (parsed.next_steps || []).slice(0, 4),
      contract: parsed.contract
        ? {
            id: parsed.contract.id ?? '',
            intent: parsed.contract.intent ?? '',
            title: parsed.contract.title ?? '',
            execution: parsed.contract.execution ?? null,
            required_tools: parsed.contract.required_tools ?? [],
            risk: parsed.contract.risk ?? '',
            gaps: parsed.contract.gaps ?? [],
          }
        : null,
      contract_line: parsed.contract_line ?? null,
      intents: (parsed.intents || parsed.available_intents || []).slice(0, 12),
      contract_lines: (parsed.contract_lines || []).slice(0, 12),
      control_surfaces: (parsed.control_surfaces || []).slice(0, 12),
      control_surface_lines: (parsed.control_surface_lines || []).slice(0, 12),
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
    case 'get_app_intents':
      return summarizeAppIntentToolResult(trimmed);
    case 'read_url':
      return summarizeUrlToolResult(trimmed);
    case 'start_research':
    case 'get_research_status':
    case 'read_research_artifact':
    case 'cancel_research':
      return summarizeAoiResearchToolResult(toolName, trimmed);
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
    /\b(open|show|save|bookmark|visit|access|attach|drive|control|use)\b.*\b(url|link|page|browser|site|website|chrome|edge|chromium)\b/i,
    /\b(url|link|page|browser|site|website|chrome|edge|chromium)\b.*\b(open|show|save|bookmark|visit|access|attach|drive|control|use)\b/i,
    /\b(read|summarize|extract|analyze|check)\b.*\b(url|link|page|article|website|browser|chrome|edge)\b/i,
    /\b(url|link|page|article|website|browser|chrome|edge)\b.*\b(read|summarize|extract|analyze|check)\b/i,
    /\b(open|visit|read|summarize|extract|analyze)\b.*https?:\/\//i,
    /https?:\/\/\S+.*\b(open|visit|read|summarize|extract|analyze)\b/i,
    // Host-PC browser drive / CDP attach (operator's real Chrome/Edge), not in-room apps.
    /\b(host[_\s-]?browser|browser[_\s-]?drive|browser_read_auth|host_browser_read|remote[_\s-]?debugging|cdp)\b/i,
    /\b(my|the|real|logged[-\s]?in)\b.*\b(chrome|edge|browser)\b/i,
    /\b(chrome|edge|browser)\b.*\b(my|pc|host|logged[-\s]?in|session)\b/i,
    /(링크|주소|브라우저|페이지|크롬|엣지|chrome|edge).*(열어|띄워|켜|보여|저장|북마크|접근|접속|붙여|조작|제어|읽어|요약|추출|분석|확인)/i,
    /(열어|띄워|켜|보여|저장|북마크|접근|접속|붙여|조작|제어|읽어|요약|추출|분석|확인).*(링크|주소|브라우저|페이지|크롬|엣지|chrome|edge)/i,
    /(내|제|호스트|host)\s*(pc|피씨|피시)?\s*(크롬|엣지|chrome|edge|브라우저)/i,
    /(크롬|엣지|chrome|edge|브라우저).*(host\s*pc|호스트|내\s*pc|내\s*컴퓨터|로그인)/i,
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

// What playback is ABOUT. Matched against the latest message or the turn
// before it, so a request that only points back still counts.
const MUSIC_SUBJECT_PATTERN =
  /(youtube|song|music|track|artist|playlist|유튜브|노래|음악|곡|플레이리스트)/i;

function hasPlaybackIntent(text: string): boolean {
  return [/\b(play|listen|put on|queue)\b/i, /(재생|틀어|들려|듣자|들어보자)/].some((pattern) =>
    pattern.test(text),
  );
}

function hasCommandIntent(text: string): boolean {
  return [
    /\b(commit|push|pull|merge|rebase|test|build|lint|typecheck|install|deploy|terminal|shell|command|execute|run command|rerun)\b/i,
    /(커밋|푸시|풀|머지|리베이스|테스트|빌드|린트|타입\s*체크|설치|배포|터미널|셸|쉘|명령|실행|다시\s*실행)/,
  ].some((pattern) => pattern.test(text));
}

function hasAppInformationIntent(text: string): boolean {
  return [
    /\b(what|which|where|how|show|tell me|inspect|check|review|read|list)\b.*\b(settings?|configuration|state|status|model|provider|defaults?|preferences?)\b/i,
    /\b(settings?|configuration|state|status|model|provider|defaults?|preferences?)\b.*\b(what|which|where|how|show|tell me|inspect|check|review|read|list)\b/i,
    /(설정|상태|정보|모델|프로바이더|provider|기본값|값).*(뭐|무엇|어디|어떻게|알려줘|보여줘|확인해|읽어줘|조회해|검토해)/,
    /(뭐|무엇|어디|어떻게|알려줘|보여줘|확인해|읽어줘|조회해|검토해).*(설정|상태|정보|모델|프로바이더|provider|기본값|값)/,
  ].some((pattern) => pattern.test(text));
}

function isShortFollowUpAction(text: string): boolean {
  return [
    /\b(open|show|save|delete|remove|play|refresh|close|set|configure|apply|change|use|run|execute|test|build|commit|push|continue|proceed|approve)\b.*\b(it|that|this|there|the same|your suggestion|the recommendation)\b/i,
    /\b(it|that|this|there|the same|your suggestion|the recommendation)\b.*\b(open|show|save|delete|remove|play|refresh|close|set|configure|apply|change|use|run|execute|test|build|commit|push|continue|proceed|approve)\b/i,
    /(그거|이거|저거|그 앱|이 앱|그렇게|그대로|그걸로|이걸로|위처럼|방금\s*(?:말한|추천한|보여준)?\s*(?:내용|것)?|아까\s*(?:말한|추천한|보여준)?\s*(?:내용|것)?|추천한\s*대로|여기(?:에|로)?|거기(?:에|로)?).*(열어줘|보여줘|저장해|삭제해|틀어줘|재생해|새로고침|설정해|적용해|변경해|바꿔|맞춰|사용해|실행해|테스트해|빌드해|커밋해|푸시해|진행해|이어가|계속해|처리해|승인해|써줘|작성해|추가해|붙여|반영해)/,
    /(열어줘|보여줘|저장해|삭제해|틀어줘|재생해|새로고침|설정해|적용해|변경해|바꿔|맞춰|사용해|실행해|테스트해|빌드해|커밋해|푸시해|진행해|이어가|계속해|처리해|승인해|써줘|작성해|추가해|붙여|반영해).*(그거|이거|저거|그 앱|이 앱|그렇게|그대로|그걸로|이걸로|위처럼|방금\s*(?:말한|추천한|보여준)?\s*(?:내용|것)?|아까\s*(?:말한|추천한|보여준)?\s*(?:내용|것)?|추천한\s*대로|여기(?:에|로)?|거기(?:에|로)?)/,
  ].some((pattern) => pattern.test(text));
}

function isShortAffirmativeFollowUp(text: string): boolean {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized || normalized.length > 48) return false;
  return [
    /^(yes|yep|yeah|sure|ok|okay|go ahead|do it|please do|sounds good|let'?s do it|make it so|apply it|use that|run it|ship it)$/i,
    /^(?:yes|yep|yeah|sure|ok|okay|sounds good)[,\s]+(?:go ahead|do it|please do|let'?s do it|make it so|apply it|use that|run it|ship it|proceed|continue)$/i,
    /^(응|어|엉|ㅇㅇ|ㅇㅋ|오케이|오키|그래|좋아|좋음|가자|해줘|해보자|진행해|진행해줘|진행하자|응 해줘|좋아 해줘|그렇게 해줘|그대로 해줘|그걸로 해줘|그걸로 가자|이걸로 해줘|이걸로 가자|바로 해줘|바로 진행해|바로 진행해줘|적용해줘|맞춰줘|한번 해봐|시작해|시작하자)[.!?\s]*$/u,
    /^(?:응|어|엉|ㅇㅇ|ㅇㅋ|오케이|오키|그래|좋아)[,\s]*(?:그렇게|그대로|그걸로|이걸로|추천한\s*대로|바로)?\s*(?:해줘|해보자|진행해|진행해줘|진행하자|적용해줘|맞춰줘|시작해|시작하자|가자)[.!?\s]*$/u,
    // Confirming what Aoi just asked to confirm ("응 맞아", "그거 맞아", "맞지").
    // These carry no verb at all, so none of the patterns above saw them, and the
    // confirmation turn ran with no app tools -- leaving the model able only to
    // promise the action for a later turn, which it then did on every turn.
    /^(?:응|어|엉|웅|네|넵|그래|그거|바로\s*그거)?[,\s]*(?:맞아|맞아요|맞지|맞음|맞습니다|그거야)[.!?~\s]*$/u,
    /^(?:yes|yeah|yep|yup|sure)?[,\s]*(?:that'?s\s+(?:right|it|the\s+one)|correct|exactly|confirmed)[.!?\s]*$/i,
  ].some((pattern) => pattern.test(normalized));
}

function hasDirectOperationalIntent(text: string): boolean {
  return [
    /\b(open|launch|run|start|show|close|reload|refresh|search|look up|play|listen|save|delete|remove|create|update|edit|set|configure|apply|change|enable|disable|continue|proceed|approve|bookmark|visit|access|attach|drive|control|read|summarize|extract|analyze|inspect|check|write|generate|prepare|remember|record|store|commit|push|test|build|install|deploy|execute)\b/i,
    /(?:^|[.!?]\s*)(?:please\s+)?use\b/i,
    /\b(?:can you|could you|would you|please)\s+use\b/i,
    // Include bare "해봐/해줘" imperatives (열어봐, 접근해봐, 읽어봐) — operators
    // use those forms for try/check requests, not only the soft "해줘" endings.
    /(열어줘|열어봐|띄워줘|띄워봐|켜줘|켜봐|보여줘|보여봐|닫아줘|닫아봐|새로고침|검색해|찾아줘|찾아봐|조사해|틀어줘|재생해|저장해|삭제해|만들어줘|생성해|수정해|편집해|설정해|설정하자|적용해|적용하자|변경해|바꿔|맞춰|사용해|접근해|접속해|붙여|조작해|제어해|진행해|진행하자|계속해|이어가|처리해|승인해|읽어줘|읽어봐|요약해|추출해|분석해|확인해|확인해봐|써줘|작성해|추가해|붙여넣어|반영해|기억해|기록해|커밋|푸시|테스트|빌드|설치|배포|실행)/,
  ].some((pattern) => pattern.test(text));
}

function hasActionableAppIntent(text: string): boolean {
  return (
    hasExplicitAppMention(text) &&
    (hasBrowserIntent(text) ||
      hasAppStateIntent(text) ||
      hasCodebaseIntent(text) ||
      hasCommandIntent(text) ||
      hasPlaybackIntent(text) ||
      hasAppInformationIntent(text) ||
      hasDirectOperationalIntent(text))
  );
}

function isAppOnlySocialTurn(text: string): boolean {
  if (!hasExplicitAppMention(text)) return false;
  if (hasActionableAppIntent(text) || isShortFollowUpAction(text)) return false;

  return [
    /\b(?:looks?|sounds?|seems?|feels?)\s+(?:good|nice|great|cool|neat|fine|solid)\b/i,
    /\b(?:i|we)\s+(?:like|love|enjoy|prefer|use|used)\b/i,
    /\b(?:i'?m|we'?re)\s+using\b/i,
    /(좋네|괜찮네|마음에\s*들|좋아\s*보|멋지|쓸만|유용|편하|사용하고\s*있|쓰고\s*있|쓰는\s*중|자주\s*써|매일\s*써|써왔)/,
  ].some((pattern) => pattern.test(text));
}

function hasWebOnlyActionIntent(text: string): boolean {
  return [
    /\b(web|internet|online)\b.*\b(search|look up|verify|check|research|investigate)\b/i,
    /\b(search|look up|verify|check|research|investigate)\b.*\b(web|internet|online)\b/i,
    /(웹|인터넷|온라인).*(검색|찾아|조사|확인|검증)/,
    /(검색|찾아|조사|확인|검증).*(웹|인터넷|온라인)/,
  ].some((pattern) => pattern.test(text));
}

function actionContextNeedsAppTools(text: string): boolean {
  if (hasExplicitAppMention(text)) return true;
  if (hasBrowserIntent(text)) return true;
  if (hasAppStateIntent(text)) return true;
  if (hasCodebaseIntent(text)) return true;
  if (hasCommandIntent(text)) return true;
  if (hasPlaybackIntent(text)) return true;
  if (hasWebOnlyActionIntent(text)) return false;
  if (assistantMessageOffersResearchRun(text)) return false;
  return hasDirectOperationalIntent(text);
}

function recentContextNeedsAppTools(text: string): boolean {
  return (
    hasExplicitAppMention(text) ||
    hasBrowserIntent(text) ||
    hasAppStateIntent(text) ||
    hasCodebaseIntent(text) ||
    hasCommandIntent(text) ||
    hasPlaybackIntent(text)
  );
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

  const confirmedActionRequest = resolveAoiActionConfirmationRequest(latestUserMessage, history);
  if (confirmedActionRequest && actionContextNeedsAppTools(confirmedActionRequest)) return true;

  if (isAppOnlySocialTurn(latestUserMessage)) return false;
  if (hasActionableAppIntent(latestUserMessage)) return true;
  if (hasBrowserIntent(latestUserMessage)) return true;
  if (hasAppStateIntent(latestUserMessage)) return true;
  if (hasCodebaseIntent(latestUserMessage)) return true;
  if (hasCommandIntent(latestUserMessage)) return true;
  // A deferred replay ("아까 그거 틀어줘", "다시 틀어줘") names no music at all --
  // the title lives in the turn before it. Requiring the subject in the latest
  // message alone is why those turns ran with no app tools, so the model could
  // not have played anything even when it said it had.
  if (
    hasPlaybackIntent(latestUserMessage) &&
    (MUSIC_SUBJECT_PATTERN.test(latestUserMessage) || MUSIC_SUBJECT_PATTERN.test(recentContext))
  ) {
    return true;
  }

  // A bare confirmation of a playback offer ("응 맞아" after "그거 맞지? 확인만
  // 해줘") names neither the action nor the music: both live in the turn above,
  // and that turn describes playback without ever using an imperative verb, so
  // hasDirectOperationalIntent does not see it either. That combination is why
  // the confirmation turn ran with no app tools at all -- the model could not
  // have played anything, so it promised playback for the next turn, and kept
  // promising it.
  if (
    isShortAffirmativeFollowUp(latestUserMessage) &&
    hasPlaybackIntent(recentContext) &&
    MUSIC_SUBJECT_PATTERN.test(recentContext)
  ) {
    return true;
  }

  if (
    (isShortFollowUpAction(latestUserMessage) ||
      (isShortAffirmativeFollowUp(latestUserMessage) &&
        (hasDirectOperationalIntent(latestUserMessage) ||
          hasDirectOperationalIntent(recentContext)))) &&
    recentContextNeedsAppTools(recentContext)
  ) {
    return true;
  }

  if (hasDirectOperationalIntent(latestUserMessage) && recentContextNeedsAppTools(recentContext)) {
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
  if (shouldUseAoiResearchRun(latestUserMessage, history)) return false;
  if (resolveAoiActionConfirmationRequest(latestUserMessage, history)) return false;
  if (shouldUseWebSearch(latestUserMessage)) return false;
  // The user's words alone carry no freshness cue here; the staleness lives in
  // the claim they are answering, so this has to be checked against history.
  if (isVolatileClaimChallenge(latestUserMessage, history)) return false;
  if (isAppOnlySocialTurn(latestUserMessage)) return true;

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
  // Host-browser / CDP drive requests must never ride the dialog route: that
  // path only exposes respond_to_user + finish_target, so the model honestly
  // (and wrongly) reports that browser access is not available this session.
  if (hasBrowserIntent(latestUserMessage)) return false;
  if (hasActionableAppIntent(latestUserMessage)) return false;
  // Same reason, generalized: the dialog array is respond_to_user +
  // finish_target, so ANY turn that needs app tools is unservable here. Without
  // this the two decisions could disagree -- app tools judged necessary, then
  // withheld because the route had already been downgraded -- which is exactly
  // how a playback request reached the model with nothing to play it.
  if (shouldEnableAppTools(latestUserMessage, history)) return false;
  // And the same again for IDA Lab, which was missing while browser and app
  // tools each had their own escape. A short reversing question ("ntoskrnl 함수
  // 목록 보여줘") is under every length and keyword bar above, so it routed to
  // the dialog model -- whose tool array is respond_to_user + finish_target --
  // and Aoi answered that it cannot analyze binaries, while a real session sat
  // open on the operator's PC.
  if (shouldEnableIdaSqlTools(latestUserMessage, history)) return false;

  const recentContext = normalizeWhitespace(
    history
      .slice(-2)
      .map((m) => m.content)
      .join('\n'),
  );
  const affirmativeContextNeedsTooling =
    isShortAffirmativeFollowUp(latestUserMessage) &&
    recentContextNeedsAppTools(recentContext) &&
    (hasDirectOperationalIntent(latestUserMessage) || hasDirectOperationalIntent(recentContext));
  if (affirmativeContextNeedsTooling) return false;

  const requiresToolingNow =
    hasDirectOperationalIntent(latestUserMessage) &&
    (hasActionableAppIntent(latestUserMessage) ||
      hasBrowserIntent(latestUserMessage) ||
      hasAppStateIntent(latestUserMessage) ||
      hasCodebaseIntent(latestUserMessage) ||
      hasCommandIntent(latestUserMessage) ||
      hasPlaybackIntent(latestUserMessage) ||
      isShortFollowUpAction(latestUserMessage) ||
      shouldEnableAppTools(latestUserMessage, history));

  if (requiresToolingNow) return false;

  if (isShortFollowUpAction(latestUserMessage) && recentContextNeedsAppTools(recentContext)) {
    return false;
  }

  return true;
}

const WEB_SEARCH_DIRECT_PATTERNS = [
  /\b(search|look up|web search|internet search|latest|recent|news|breaking)\b/i,
  /\bcurrent\b.*\b(info|information|news|price|pricing|status|version|availability|available)\b/i,
  /\b(?:api|sdk|platform|service)\b.*\b(?:price|pricing|cost|fee|billing|quota|rate[- ]?limit|plan|tier)\b/i,
  /\b(?:price|pricing|cost|fee|billing|quota|rate[- ]?limit|plan|tier)\b.*\b(?:api|sdk|platform|service)\b/i,
  /\b(still|currently)\b.*\b(available|supported|works|usable|accessible)\b/i,
  /\b(on the web|from the web|online)\b/i,
  /\b(check|verify|confirm|fact[- ]?check)\b.*\b(web|internet|online|fact|claim|rumor|latest|current|recent)\b/i,
  /\b(web|internet|online)\b.*\b(check|verify|confirm|fact[- ]?check)\b/i,
  /(웹\s*검색|인터넷\s*검색|구글링|검색해|검색해줘|검색해서|조사해|조사해줘|최신|최근|뉴스|속보)/,
  /(?:API|api|SDK|sdk|플랫폼|서비스|요금제|플랜|과금|쿼터|레이트\s*리밋).*(?:비용|가격|요금|과금|얼마|쿼터|제한|플랜)/u,
  /(?:비용|가격|요금|과금|얼마|쿼터|제한|플랜).*(?:API|api|SDK|sdk|플랫폼|서비스|요금제|플랜|과금|쿼터|레이트\s*리밋|트위터|Twitter|\bX\b)/u,
];

const WEB_SEARCH_TRUTH_CHECK_PATTERNS = [
  /(?:\bis it true\b|\bis that true\b|\btrue\?|\breally\?|\bcan you confirm\b|\bfact[- ]?check this\b|\bdoes .* still\b|\bis .* still\b)/i,
  /(진짜야|진짜임|정말이야|사실이야|사실인가|사실인지|맞아[?？]?|맞나요|맞는지|맞는\s*거야|맞는\s*건가|맞다던데|맞다고\s*하던데|확실해|가능하다던데|라던데|라는데|다던데|한다던데|라고\s*하던데)/,
];

// Implicit freshness questions ("is X opt-in now?", "Recall은 지금 opt-in이야?").
// These carry no explicit search verb and no fact-check phrasing, so the model
// tends to answer from stale knowledge and claim it cannot check live. A cue
// alone never triggers a search: the volatile-fact gate below must also match.
const WEB_SEARCH_FRESHNESS_CUE_PATTERNS = [
  /\b(?:is|are|does|do|has|have|can)\b[^?？]*\b(?:still|now|currently|these days|nowadays|today|as of)\b/i,
  /(지금|현재|요즘|이제|아직)[^?？]*[?？]/,
  /(지금|현재|요즘|이제|아직).*(이야|인가요?|인지|일까|일까요|한가요?|하나요|되나요?|됐어|되었어|맞아|맞나요?)\s*$/,
  // "확인해줘" alone is NOT a cue: it is the most common Korean imperative in a
  // coding session ("변경 사항 확인해줘"), and pairing it with the broad
  // volatile-fact list below sent ordinary code questions to the web. It counts
  // only alongside an explicit freshness word or a named outside product.
  /(지금|현재|요즘|최근|아직)[^\n]{0,40}(확인해\s*줘?|확인\s*해봐|알아봐\s*줘?|알아보고|찾아봐\s*줘?)/,
  /(openai|anthropic|claude|chatgpt|gemini|deepseek|windows|github|tavily|오픈ai|앤트로픽|클로드|챗gpt|제미나이|딥시크|윈도우|깃허브)[^\n]{0,40}(확인해\s*줘?|확인\s*해봐|알아봐\s*줘?|찾아봐\s*줘?)/i,
];

// Deixis that pins a question to THIS workspace -- a file, a symbol, our code,
// the thing on screen. A freshness-worded question about local code is not a
// question about the world, so the implicit path stays off. Explicit requests
// ("검색해줘", "웹에서 찾아봐") are unaffected: they match the direct patterns
// above and never reach this gate.
// A bare demonstrative. Enough to mean "the thing in front of us" when a
// question is otherwise unanchored, which is why the web-search gate counts it
// -- but it is also simply how anyone refers back to what was just said, so the
// volatile-claim challenge below deliberately does not count it.
const DEICTIC_REFERENCE_PATTERN = /(이거|그거|저거|이건|그건|이걸|그걸)/;

const WEB_SEARCH_LOCAL_CONTEXT_PATTERNS = [
  // A source artifact named anywhere in the message.
  /(파일|코드|함수|클래스|메서드|메소드|모듈|필드|변수|타입|인터페이스|테스트|스크립트|커밋|브랜치|레포|리포|저장소|디렉터리|디렉토리|폴더)/,
  /\b(file|code|function|class|method|module|field|variable|type|interface|test|script|commit|branch|diff|repo|repository|directory|folder)\b/i,
  // Pointing at something already in front of us.
  /(이|그|저|해당|우리|내|네)\s*(기능|설정|옵션|플래그|동작|로직|부분|값)/,
  DEICTIC_REFERENCE_PATTERN,
  // Work verbs that only make sense against our own code.
  /\b(refactor|implement|rewrite|debug|review)\b/i,
  /(리팩터|리팩토링|구현해|디버깅|고쳐줘|수정해|배포해도)/,
];

const WEB_SEARCH_VOLATILE_FACT_PATTERNS = [
  /\b\d{1,2}[/-]\d{1,2}\b/,
  /\b20\d{2}[-./]\d{1,2}[-./]\d{1,2}\b/,
  /\d{1,2}\s*월\s*\d{1,2}\s*일/,
  /\b(api only|model|pricing|release|availability|available|deprecated|sunset|after|since|until|only|policy|announcement|launch|access|subscription|beta)\b/i,
  /\b(opt[- ]?in|opt[- ]?out|enabled|disabled|default (?:on|off)|turned (?:on|off)|rolled? (?:out|back))\b/i,
  /\b(openai|anthropic|claude|chatgpt|google|gemini|microsoft|windows|github|apple|meta|tavily|fable|deepseek)\b/i,
  /(api로만|모델|가격|비용|요금|과금|요금제|플랜|쿼터|레이트\s*리밋|출시|릴리스|배포|사용\s*가능|사용가능|지원|종료|중단|폐지|변경|정책|발표|공지|이후|이후로|부터|까지만|만\s*사용|만\s*가능|구독|베타|접근|제공)/i,
  /(옵트인|옵트아웃|기본값|기본\s*설정|활성화|비활성화|켜져|꺼져)/,
  /(오픈ai|오픈AI|앤트로픽|클로드|챗gpt|챗GPT|구글|제미나이|마이크로소프트|윈도우|깃허브|애플|메타|타빌리|페이블|딥시크)/i,
];

const AOI_RESEARCH_RUN_INTENT_PATTERNS = [
  /\b(research|investigate|deep dive|survey|compare|analyze)\b.*\b(report|document|brief|write[- ]?up|dossier|citations?|sources?)\b/i,
  /\b(create|write|generate|prepare|produce)\b.*\b(research|investigation|cited report|cited document|source-backed document)\b/i,
  /\b(literature review|market research|technical research report|structured research document)\b/i,
  /(웹|인터넷|자료|출처|근거).*(조사|연구|리서치).*(문서|보고서|정리|작성|생성|구조화)/,
  /(조사|연구|리서치).*(자료|출처|근거).*(문서|보고서|정리|작성|생성|구조화)/,
  /(조사|연구|리서치).*(잘\s*구조화|구조화된|심층|깊게|상세).*(문서|보고서|정리)/,
  /(문서|보고서).*(조사|연구|리서치).*(작성|생성|만들어|정리)/,
];

function getPreviousAssistantMessage(history: ChatMessage[]): string {
  return (
    [...history]
      .reverse()
      .find((message) => message.role === 'assistant')
      ?.content.trim() ?? ''
  );
}

function extractQuotedResearchTopic(value: string): string | null {
  const quoted = value.match(/[“"'‘]([^“"'‘’]{8,180})[”"'’]/u);
  if (quoted?.[1]?.trim()) {
    return quoted[1].trim();
  }

  const koreanQuoted = value.match(/[「『](.{8,180})[」』]/u);
  if (koreanQuoted?.[1]?.trim()) {
    return koreanQuoted[1].trim();
  }

  return null;
}

function assistantMessageOffersResearchRun(value: string): boolean {
  return [
    /\b(?:Aoi Research|research run|start_research)\b/i,
    /\b(?:research|investigate|survey)\b.*\b(?:report|document|run|sources?|citations?)\b/i,
    /(?:웹|인터넷|자료|출처|근거).*(?:조사|연구|리서치).*(?:해볼까|할까|진행|문서|보고서|Run|기록)/u,
    /(?:조사|연구|리서치).*(?:해볼까|할까|진행|Run으로|기록해줄게|보고서|문서)/u,
  ].some((pattern) => pattern.test(value));
}

function assistantMessageOffersAction(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return false;
  if (assistantMessageOffersResearchRun(normalized)) return true;

  const hasProposalCue = [
    /\b(?:should i|shall i|want me to|do you want me to|would you like me to|can i|may i|i can|let me)\b/i,
    /\b(?:open|launch|run|start|show|close|reload|refresh|search|look up|read|summarize|extract|analyze|inspect|check|save|delete|remove|create|update|edit|write|generate|prepare|remember|record|store|commit|push|test|build|install|deploy|execute|upload|download|configure|enable|disable|use)\b.*[?？]/i,
    /(?:해줄까|해볼까|해볼까요|할까|할까요|해도\s*될까|해도\s*될까요|진행할까|진행할까요|진행해도\s*될까|시작할까|시작할까요|시작해도\s*될까|열어줄까|열어볼까|열까|켜줄까|켜볼까|보여줄까|닫을까|새로고침할까|저장할까|저장해둘까|기록할까|기록해둘까|기억해둘까|만들까|생성할까|수정할까|편집할까|작성할까|찾아볼까|검색해볼까|조사해볼까|읽어볼까|요약해줄까|실행할까|테스트할까|빌드할까|커밋할까|푸시할까|틀어줄까|재생할까|삭제할까|추가할까|반영할까|설정할까)/u,
  ].some((pattern) => pattern.test(normalized));

  if (!hasProposalCue) {
    return false;
  }

  return [
    /\b(?:open|launch|run|start|show|close|reload|refresh|search|look up|read|summarize|extract|analyze|inspect|check|save|delete|remove|create|update|edit|write|generate|prepare|remember|record|store|commit|push|test|build|install|deploy|execute|upload|download|configure|enable|disable|use)\b/i,
    /(?:열어|띄워|켜|보여|닫아|새로고침|검색|찾아|조사|연구|읽어|요약|추출|분석|확인|검증|저장|삭제|만들|생성|수정|편집|작성|기억|기록|커밋|푸시|테스트|빌드|실행|설치|배포|추가|붙여|반영|업로드|다운로드|설정|사용)/u,
  ].some((pattern) => pattern.test(normalized));
}

export function resolveAoiActionConfirmationRequest(
  latestUserMessage: string,
  history: ChatMessage[] = [],
): string | null {
  if (!isShortAffirmativeFollowUp(latestUserMessage)) {
    return null;
  }

  const previousAssistantMessage = getPreviousAssistantMessage(history);
  if (!previousAssistantMessage || !assistantMessageOffersAction(previousAssistantMessage)) {
    return null;
  }

  return truncateForTokenBudget(normalizeWhitespace(previousAssistantMessage), 320, '...');
}

export function resolveAoiResearchConfirmationRequest(
  latestUserMessage: string,
  history: ChatMessage[] = [],
): string | null {
  if (!resolveAoiActionConfirmationRequest(latestUserMessage, history)) {
    return null;
  }

  const previousAssistantMessage = getPreviousAssistantMessage(history);
  if (!assistantMessageOffersResearchRun(previousAssistantMessage)) {
    return null;
  }

  return (
    extractQuotedResearchTopic(previousAssistantMessage) ??
    truncateForTokenBudget(normalizeWhitespace(previousAssistantMessage), 220, '...')
  );
}

export function shouldUseAoiResearchRun(
  latestUserMessage: string,
  history: ChatMessage[] = [],
): boolean {
  const latest = normalizeWhitespace(latestUserMessage);
  if (!latest) return false;
  if (/\bhttps?:\/\//i.test(latest)) return false;
  if (resolveAoiResearchConfirmationRequest(latestUserMessage, history)) return true;
  return AOI_RESEARCH_RUN_INTENT_PATTERNS.some((pattern) => pattern.test(latest));
}

export function shouldUseWebSearch(latestUserMessage: string): boolean {
  const latest = normalizeWhitespace(latestUserMessage);
  if (!latest) return false;

  if (WEB_SEARCH_DIRECT_PATTERNS.some((pattern) => pattern.test(latest))) return true;

  const hasTruthCheckCue = WEB_SEARCH_TRUTH_CHECK_PATTERNS.some((pattern) => pattern.test(latest));
  const hasFreshnessCue = WEB_SEARCH_FRESHNESS_CUE_PATTERNS.some((pattern) => pattern.test(latest));
  if (!hasTruthCheckCue && !hasFreshnessCue) return false;

  // A question about code in this workspace is not a question about the world.
  // The volatile-fact list holds domain-neutral words a security engineer uses
  // constantly (모델, 정책, 접근, 지원, 변경), so without this gate "모델 클래스
  // 확인해줘" ran a live web search and fed the results back as grounding.
  if (WEB_SEARCH_LOCAL_CONTEXT_PATTERNS.some((pattern) => pattern.test(latest))) {
    return false;
  }

  return WEB_SEARCH_VOLATILE_FACT_PATTERNS.some((pattern) => pattern.test(latest));
}

// A claim about the outside world that expires: money, plan tiers, the
// release/availability lifecycle, dated announcements. Deliberately tighter
// than WEB_SEARCH_VOLATILE_FACT_PATTERNS, whose domain-neutral words (model,
// policy, support, change) appear in almost every ordinary coding turn -- reusing
// that list here would turn every "that does not work" into a web search.
// Vendor names alone are excluded for the same reason: naming Claude or GitHub
// is not by itself a claim that can go stale.
const ASSISTANT_VOLATILE_CLAIM_PATTERNS = [
  // Money and plan tiers.
  /\$\s?\d/,
  /\b\d+\s*(?:usd|dollars?)\b/i,
  /\b(?:pricing|subscription|free tier|paid plan|billing|quota)\b/i,
  /(요금제|구독|유료\s*플랜|무료\s*플랜|과금|가격|요금)/,
  // Release and availability lifecycle.
  /\b(?:released|launched|rolling out|rolled out|rollout|available now|generally available|beta|public preview|deprecated|sunset|discontinued)\b/i,
  /(출시|릴리스|릴리즈|베타|프리뷰|정식\s*공개|공개됐|공개된|단종|지원\s*종료)/,
  // A dated claim is a claim that expires.
  /\b20\d{2}[-./]\d{1,2}[-./]\d{1,2}\b/,
  /\d{1,2}\s*월\s*\d{1,2}\s*일/,
];

// The same local-context gate shouldUseWebSearch applies -- a doubt about our
// own code is not a doubt about the world -- minus the bare demonstratives.
// Pointing at what was just said ("is that really right?") is the most natural
// way to dispute a claim, and reaching this check already required the previous
// turn to look like an outside-world claim, so the deictic carries no local
// signal here.
const CLAIM_CHALLENGE_LOCAL_CONTEXT_PATTERNS = WEB_SEARCH_LOCAL_CONTEXT_PATTERNS.filter(
  (pattern) => pattern !== DEICTIC_REFERENCE_PATTERN,
);

// The user pushing back on what was just asserted -- absence from their own
// vantage point ("I don't see it") or direct doubt ("are you sure?").
const USER_CLAIM_CHALLENGE_PATTERNS = [
  /\b(?:i|we)\s+(?:don'?t|do not|can'?t|cannot|couldn'?t|never)\s+(?:see|find|get|have)\b/i,
  /\b(?:there'?s|there is|there are)\s+no\b/i,
  /\b(?:not|isn'?t|aren'?t|doesn'?t)\s+(?:showing|there|available|visible|listed|appearing)\b/i,
  /\bnothing\s+(?:like that|there|shows)\b/i,
  /\b(?:are you sure|you sure|that'?s not right|that'?s wrong|is that real)\b/i,
  /(안\s*보여|안\s*보이|안\s*떠|안\s*뜨|보이지\s*않|나오지\s*않|안\s*나와|안\s*나오|못\s*찾|찾을\s*수\s*없|없는데|없던데|그런\s*거\s*없|안\s*생겼)/u,
  /(확실해|진짜\s*맞|정말\s*맞|틀린\s*거\s*아니|잘못\s*알고|아닌\s*것\s*같은데|아닌\s*거\s*같은데)/u,
];

/**
 * The user is disputing a claim Aoi just made about the outside world
 * ("the $100 plan shipped" -> "I don't see it on my account").
 *
 * The user's own words carry no freshness cue, so shouldUseWebSearch misses the
 * turn and it fell through to the dialog model, whose tool array is only
 * respond_to_user/finish_target. With no search_web to call, Aoi answered that
 * it could not reach the web -- which reads as a permanent property of the
 * environment rather than one turn's missing tool. Routing these back to the
 * main model is the cheap direction to be wrong in: the cost is one
 * tool-capable turn, and the model still decides whether to search.
 */
export function isVolatileClaimChallenge(
  latestUserMessage: string,
  history: ChatMessage[] = [],
): boolean {
  const latest = normalizeWhitespace(latestUserMessage);
  if (!latest) return false;

  if (CLAIM_CHALLENGE_LOCAL_CONTEXT_PATTERNS.some((pattern) => pattern.test(latest))) return false;
  if (!USER_CLAIM_CHALLENGE_PATTERNS.some((pattern) => pattern.test(latest))) return false;

  const previousAssistantMessage = getPreviousAssistantMessage(history);
  if (!previousAssistantMessage) return false;

  return ASSISTANT_VOLATILE_CLAIM_PATTERNS.some((pattern) =>
    pattern.test(previousAssistantMessage),
  );
}

/**
 * The system-prompt text describing web search, derived from whether search_web
 * is actually in this turn's tools array.
 *
 * This lives next to the routing predicates on purpose. The prompt used to be
 * keyed off "a Tavily key exists" while the tools array was keyed off "the turn
 * routed to the main model", so a dialog turn was told to call search_web first
 * and handed no search_web to call. Faced with that contradiction the model
 * either fabricated a search or told the user the environment had no web
 * access -- both of which happened in production. Keeping the flag and the text
 * in one place is what stops them drifting apart again.
 */
export function buildWebSearchPolicyPromptBlock(params: {
  /** search_web is in THIS turn's tools array. */
  hasWebSearchTool: boolean;
  /** A Tavily key exists, regardless of this turn's routing. */
  webSearchConfigured: boolean;
  /** The provider can return structured tool calls at all. */
  toolCallRuntimeAvailable: boolean;
}): string {
  if (params.hasWebSearchTool) {
    return `

Web search rule:
- When the user asks you to search, look up, verify, compare current information, find recent news, or answer a fact that may have changed, use search_web first.
- Korean verification questions like "진짜야?", "사실이야?", or "맞아?" require search_web first when they mention dates, API availability, product/model changes, vendor policy, releases, or support status.
- Base current-information answers on search_web results instead of guessing.
- When helpful, mention the source site names or URLs naturally in your reply.`;
  }

  // Tool-capable turn, key configured, but search_web was not attached (the
  // dialog route ships a two-tool array). Left unexplained, the model guesses
  // why the tool is missing, and the guess it reaches for is "this environment
  // cannot reach the web" -- a claim about the deployment that is false and that
  // the user has no easy way to disprove.
  if (params.webSearchConfigured && params.toolCallRuntimeAvailable) {
    return `

Web search availability:
- Live web search IS configured for you. It is only absent from this particular turn's tools.
- Never tell the user you cannot see the web, that this environment cannot reach live pages, or that web access might arrive later. All of that is false.
- If answering well needs live verification, say plainly that you want to check it and ask the user to confirm. The next turn will carry the search tool.
- Do not claim or imply that you searched anything on this turn.`;
  }

  return '';
}
