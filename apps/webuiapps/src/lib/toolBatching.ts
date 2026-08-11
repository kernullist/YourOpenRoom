import type { ToolCall } from './llmClient';

const PARALLEL_SAFE_TOOLS = new Set([
  'list_apps',
  'file_read',
  'file_list',
  'workspace_search',
  'ide_search',
  'ide_current_file',
  'ide_read_file',
  'get_app_schema',
  'get_app_state',
  'get_app_intents',
  'open_symbol',
  'find_references',
  'list_exports',
  'peek_definition',
  'rename_preview',
  'read_url',
  'run_command',
  'structured_diagnostics',
  'preview_changes',
  'search_web',
  'get_research_status',
  'read_research_artifact',
  'host_process_list',
  // spawn preview/run are NOT parallel-safe: they share allowlist resolution
  // and a single-use approval fingerprint.
  'host_browser_read',
]);

export function isParallelSafeToolName(toolName: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(toolName);
}

export function canParallelizeToolBatch(toolCalls: ToolCall[]): boolean {
  return (
    toolCalls.length > 1 &&
    toolCalls.every((toolCall) => isParallelSafeToolName(toolCall.function.name))
  );
}
