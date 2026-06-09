export type AoiMcpPluginKind = 'mcp-server' | 'plugin' | 'connector';
export type AoiMcpPluginHealthStatus = 'unknown' | 'healthy' | 'error';
export type AoiMcpPluginAuthMode = 'none' | 'bearer' | 'custom-header';

export interface AoiMcpPluginEntry {
  id: string;
  name: string;
  description: string;
  kind: AoiMcpPluginKind;
  endpointUrl: string;
  enabled: boolean;
  trusted: boolean;
  authMode: AoiMcpPluginAuthMode;
  healthStatus: AoiMcpPluginHealthStatus;
  healthMessage?: string;
  lastCheckedAt?: number;
  source: 'built-in' | 'user';
  createdAt: number;
  updatedAt: number;
}

export interface AoiMcpPluginSummary {
  total: number;
  enabled: number;
  trusted: number;
  healthy: number;
  errors: number;
  user: number;
  builtIn: number;
}

const STORAGE_KEY = 'openroom-aoi-mcp-plugin-admin-v1';
const MAX_ADMIN_ENTRIES = 24;

export const DEFAULT_AOI_MCP_PLUGIN_ENTRIES: AoiMcpPluginEntry[] = [
  {
    id: 'aoi-ide-local-bridge',
    name: "Aoi's IDE Local Bridge",
    description:
      'Built-in app bridge for IDE state, diagnostics, checkpoints, and workspace tools.',
    kind: 'plugin',
    endpointUrl: 'internal:aoi-ide',
    enabled: true,
    trusted: true,
    authMode: 'none',
    healthStatus: 'healthy',
    healthMessage: 'Built-in bridge',
    source: 'built-in',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'ida-pe-mcp-backend',
    name: 'IDA PE MCP Backend',
    description: 'Optional HTTP MCP backend used by PE Analyst when configured.',
    kind: 'mcp-server',
    endpointUrl: '',
    enabled: false,
    trusted: false,
    authMode: 'none',
    healthStatus: 'unknown',
    source: 'built-in',
    createdAt: 1,
    updatedAt: 1,
  },
];

export function loadAoiMcpPluginAdmin(): AoiMcpPluginEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_AOI_MCP_PLUGIN_ENTRIES;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return DEFAULT_AOI_MCP_PLUGIN_ENTRIES;
    }
    return normalizeAoiMcpPluginEntries(parsed.filter(isAoiMcpPluginEntry));
  } catch {
    return DEFAULT_AOI_MCP_PLUGIN_ENTRIES;
  }
}

export function saveAoiMcpPluginAdmin(entries: AoiMcpPluginEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeAoiMcpPluginEntries(entries)));
  } catch {
    // ignore persistence failures
  }
}

export function createUserAoiMcpPluginEntry(params: {
  name: string;
  endpointUrl: string;
  kind: AoiMcpPluginKind;
  description?: string;
  authMode?: AoiMcpPluginAuthMode;
  now?: number;
}): AoiMcpPluginEntry {
  const now = params.now ?? Date.now();
  const name = truncateSingleLine(params.name.trim() || 'Untitled MCP endpoint', 90);
  return {
    id: `user-${slugify(name)}-${now.toString(36)}`,
    name,
    description: truncateSingleLine(params.description?.trim() || 'User-registered endpoint.', 180),
    kind: params.kind,
    endpointUrl: params.endpointUrl.trim(),
    enabled: true,
    trusted: false,
    authMode: params.authMode ?? 'none',
    healthStatus: 'unknown',
    source: 'user',
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeAoiMcpPluginEntries(entries: AoiMcpPluginEntry[]): AoiMcpPluginEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, sanitizeAoiMcpPluginEntry(entry)]));
  DEFAULT_AOI_MCP_PLUGIN_ENTRIES.forEach((builtIn) => {
    const existing = byId.get(builtIn.id);
    byId.set(builtIn.id, {
      ...builtIn,
      endpointUrl: existing?.endpointUrl ?? builtIn.endpointUrl,
      enabled: existing?.enabled ?? builtIn.enabled,
      trusted: builtIn.trusted ? true : (existing?.trusted ?? builtIn.trusted),
      healthStatus: existing?.healthStatus ?? builtIn.healthStatus,
      healthMessage: existing?.healthMessage ?? builtIn.healthMessage,
      lastCheckedAt: existing?.lastCheckedAt,
      updatedAt: existing?.updatedAt ?? builtIn.updatedAt,
    });
  });

  return Array.from(byId.values())
    .sort((left, right) => {
      if (left.source !== right.source) {
        return left.source === 'built-in' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, MAX_ADMIN_ENTRIES);
}

export function upsertAoiMcpPluginEntry(
  entries: AoiMcpPluginEntry[],
  entry: AoiMcpPluginEntry,
): AoiMcpPluginEntry[] {
  return normalizeAoiMcpPluginEntries([entry, ...entries.filter((item) => item.id !== entry.id)]);
}

export function updateAoiMcpPluginEntry(
  entries: AoiMcpPluginEntry[],
  entryId: string,
  updates: Partial<
    Pick<
      AoiMcpPluginEntry,
      | 'enabled'
      | 'trusted'
      | 'endpointUrl'
      | 'description'
      | 'authMode'
      | 'healthStatus'
      | 'healthMessage'
      | 'lastCheckedAt'
    >
  >,
  now = Date.now(),
): AoiMcpPluginEntry[] {
  return normalizeAoiMcpPluginEntries(
    entries.map((entry) =>
      entry.id === entryId
        ? {
            ...entry,
            ...updates,
            trusted: isAoiMcpPluginTrustLocked(entry) ? true : (updates.trusted ?? entry.trusted),
            updatedAt: now,
          }
        : entry,
    ),
  );
}

export function removeAoiMcpPluginEntry(
  entries: AoiMcpPluginEntry[],
  entryId: string,
): AoiMcpPluginEntry[] {
  return normalizeAoiMcpPluginEntries(
    entries.filter((entry) => entry.id !== entryId || entry.source === 'built-in'),
  );
}

export function applyAoiMcpPluginHealthCheckResult(
  entries: AoiMcpPluginEntry[],
  checkedEntry: AoiMcpPluginEntry,
): AoiMcpPluginEntry[] {
  if (!entries.some((entry) => entry.id === checkedEntry.id)) {
    return normalizeAoiMcpPluginEntries(entries);
  }

  return updateAoiMcpPluginEntry(
    entries,
    checkedEntry.id,
    {
      healthStatus: checkedEntry.healthStatus,
      healthMessage: checkedEntry.healthMessage,
      lastCheckedAt: checkedEntry.lastCheckedAt,
    },
    checkedEntry.updatedAt,
  );
}

export function isAoiMcpPluginTrustLocked(
  entry: Pick<AoiMcpPluginEntry, 'id' | 'source'>,
): boolean {
  return (
    entry.source === 'built-in' &&
    DEFAULT_AOI_MCP_PLUGIN_ENTRIES.some((builtIn) => builtIn.id === entry.id && builtIn.trusted)
  );
}

export function summarizeAoiMcpPluginAdmin(entries: AoiMcpPluginEntry[]): AoiMcpPluginSummary {
  const normalized = normalizeAoiMcpPluginEntries(entries);
  return {
    total: normalized.length,
    enabled: normalized.filter((entry) => entry.enabled).length,
    trusted: normalized.filter((entry) => entry.trusted).length,
    healthy: normalized.filter((entry) => entry.healthStatus === 'healthy').length,
    errors: normalized.filter((entry) => entry.healthStatus === 'error').length,
    user: normalized.filter((entry) => entry.source === 'user').length,
    builtIn: normalized.filter((entry) => entry.source === 'built-in').length,
  };
}

export function buildAoiMcpPluginPrompt(entries: AoiMcpPluginEntry[]): string {
  const activeEntries = normalizeAoiMcpPluginEntries(entries).filter(
    (entry) => entry.enabled && entry.trusted,
  );
  if (activeEntries.length === 0) {
    return '';
  }

  const lines = [
    '',
    'Aoi MCP/Plugin Admin:',
    '- Treat only enabled and trusted admin entries as available integration context.',
  ];
  activeEntries.slice(0, 8).forEach((entry) => {
    lines.push(`- ${entry.name} [${entry.kind}, ${entry.healthStatus}]: ${entry.description}`);
  });
  return `\n${lines.join('\n')}`;
}

export async function probeAoiMcpPluginEndpoint(
  entry: AoiMcpPluginEntry,
  now = Date.now(),
): Promise<AoiMcpPluginEntry> {
  if (entry.endpointUrl.startsWith('internal:')) {
    return {
      ...entry,
      healthStatus: 'healthy',
      healthMessage: 'Built-in bridge',
      lastCheckedAt: now,
      updatedAt: now,
    };
  }

  if (!/^https?:\/\//i.test(entry.endpointUrl)) {
    return {
      ...entry,
      healthStatus: 'error',
      healthMessage: 'Endpoint URL must start with http:// or https://',
      lastCheckedAt: now,
      updatedAt: now,
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), 3500);
    let response: Response;
    try {
      response = await fetch(entry.endpointUrl, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      });
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
    return {
      ...entry,
      healthStatus: response.ok ? 'healthy' : 'error',
      healthMessage: `HTTP ${response.status}`,
      lastCheckedAt: now,
      updatedAt: now,
    };
  } catch (error) {
    return {
      ...entry,
      healthStatus: 'error',
      healthMessage: error instanceof Error ? error.message : String(error),
      lastCheckedAt: now,
      updatedAt: now,
    };
  }
}

function sanitizeAoiMcpPluginEntry(entry: AoiMcpPluginEntry): AoiMcpPluginEntry {
  return {
    ...entry,
    name: truncateSingleLine(entry.name, 90),
    description: truncateSingleLine(entry.description, 180),
    endpointUrl: entry.endpointUrl.trim(),
    enabled: Boolean(entry.enabled),
    trusted: Boolean(entry.trusted),
    authMode: isAoiMcpPluginAuthMode(entry.authMode) ? entry.authMode : 'none',
    healthStatus: isAoiMcpPluginHealthStatus(entry.healthStatus) ? entry.healthStatus : 'unknown',
  };
}

function isAoiMcpPluginEntry(value: unknown): value is AoiMcpPluginEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<AoiMcpPluginEntry>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.endpointUrl === 'string' &&
    (record.kind === 'mcp-server' || record.kind === 'plugin' || record.kind === 'connector') &&
    (record.source === 'built-in' || record.source === 'user')
  );
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'endpoint'
  );
}

function isAoiMcpPluginAuthMode(value: unknown): value is AoiMcpPluginAuthMode {
  return value === 'none' || value === 'bearer' || value === 'custom-header';
}

function isAoiMcpPluginHealthStatus(value: unknown): value is AoiMcpPluginHealthStatus {
  return value === 'unknown' || value === 'healthy' || value === 'error';
}

function truncateSingleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}
