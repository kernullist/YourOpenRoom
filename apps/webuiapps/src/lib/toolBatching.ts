import type { ToolCall } from './llmClient';

const PARALLEL_SAFE_TOOLS = new Set([
  'list_apps',
  'file_read',
  'file_list',
  'workspace_search',
  'ide_search',
  'get_app_schema',
  'get_app_state',
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
]);

export function isParallelSafeToolName(toolName: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(toolName);
}

export function canParallelizeToolBatch(toolCalls: ToolCall[]): boolean {
  return toolCalls.length > 1 && toolCalls.every((toolCall) => isParallelSafeToolName(toolCall.function.name));
}
