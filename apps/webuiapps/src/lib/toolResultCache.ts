export interface ToolResultCacheEntry {
  key: string;
  value: string;
  createdAt: number;
}

const CACHEABLE_TOOL_NAMES = new Set([
  'list_apps',
  'file_read',
  'file_list',
  'workspace_search',
  'ide_search',
  'get_app_schema',
  'open_symbol',
  'find_references',
  'list_exports',
  'peek_definition',
  'rename_preview',
  'get_app_state',
  'read_url',
  'run_command',
  'structured_diagnostics',
  'search_web',
]);

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`;
}

export function isCacheableToolName(toolName: string): boolean {
  return CACHEABLE_TOOL_NAMES.has(toolName);
}

export function buildToolCacheKey(toolName: string, params: Record<string, unknown>): string {
  return `${toolName}:${stableSerialize(params)}`;
}

export function createToolResultCache(ttlMs = 8_000) {
  const entries = new Map<string, ToolResultCacheEntry>();

  return {
    get(toolName: string, params: Record<string, unknown>): string | null {
      if (!isCacheableToolName(toolName)) return null;
      const key = buildToolCacheKey(toolName, params);
      const entry = entries.get(key);
      if (!entry) return null;
      if (Date.now() - entry.createdAt > ttlMs) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    set(toolName: string, params: Record<string, unknown>, value: string): void {
      if (!isCacheableToolName(toolName)) return;
      const key = buildToolCacheKey(toolName, params);
      entries.set(key, { key, value, createdAt: Date.now() });
    },
    clear(): void {
      entries.clear();
    },
    size(): number {
      return entries.size;
    },
  };
}
