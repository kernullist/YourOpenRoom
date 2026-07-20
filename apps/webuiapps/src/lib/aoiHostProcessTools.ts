// Chat-facing host process inspection tools (HP1).
// Read-only metadata snapshot of real machine processes via host-bridge.
// Capability kill-switch (`process_activity`) + session consent (`process-activity`)
// are enforced server-side; this module only formats results for the model.

import type { ToolDef } from './llmClient';
import {
  fetchAoiHostProcesses,
  type AoiHostProcessListingView,
  type AoiHostProcessRecordView,
} from './aoiHostBridgeClient';

export const HOST_PROCESS_LIST_TOOL = 'host_process_list';

const MAX_LIST_RESULTS = 50;
const DEFAULT_LIST_RESULTS = 20;
const MAX_TOP_IMAGES = 20;
const MAX_QUERY_CHARS = 80;

export type HostProcessListMode = 'summary' | 'list';

export interface HostProcessToolContext {
  sessionPath: string;
  fetchListing?: (sessionPath: string) => Promise<AoiHostProcessListingView>;
}

export function getHostProcessToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: HOST_PROCESS_LIST_TOOL,
        description:
          'Read a metadata-only snapshot of processes currently running on the user PC ' +
          '(image name, pid, optional memory). No command lines. ' +
          'Use when the user asks what is running, whether an app/process is open, ' +
          'or wants a host process summary. Requires Host Bridge process_activity capability ' +
          'and process-activity consent. Prefer mode=summary unless a specific process filter is needed.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Optional case-insensitive filter matched against the image name ' +
                '(e.g. "chrome", "notepad", "code"). Aliases: image, name.',
            },
            mode: {
              type: 'string',
              description:
                'summary (default): total counts + top images (+ filter match counts). ' +
                'list: return matching process rows (capped).',
              enum: ['summary', 'list'],
            },
            max_results: {
              type: 'number',
              description: `Max rows when mode=list (1-${MAX_LIST_RESULTS}, default ${DEFAULT_LIST_RESULTS}).`,
            },
          },
          required: [],
        },
      },
    },
  ];
}

export function isHostProcessTool(toolName: string): boolean {
  return toolName === HOST_PROCESS_LIST_TOOL;
}

export function getHostProcessToolPendingSummary(params: Record<string, unknown>): string {
  const query = extractQuery(params);
  const mode = extractMode(params);
  if (query) {
    return `${HOST_PROCESS_LIST_TOOL}(${mode},q=${query.slice(0, 32)})`;
  }
  return `${HOST_PROCESS_LIST_TOOL}(${mode})`;
}

function extractQuery(params: Record<string, unknown>): string {
  const candidates = [params.query, params.image, params.name, params.filter];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, MAX_QUERY_CHARS);
    }
  }
  return '';
}

function extractMode(params: Record<string, unknown>): HostProcessListMode {
  return params.mode === 'list' ? 'list' : 'summary';
}

function extractMaxResults(params: Record<string, unknown>): number {
  const raw = Number(params.max_results ?? params.limit ?? DEFAULT_LIST_RESULTS);
  if (!Number.isFinite(raw)) {
    return DEFAULT_LIST_RESULTS;
  }
  return Math.min(MAX_LIST_RESULTS, Math.max(1, Math.trunc(raw)));
}

function matchesQuery(record: AoiHostProcessRecordView, query: string): boolean {
  if (!query) {
    return true;
  }
  return record.imageName.toLowerCase().includes(query.toLowerCase());
}

export function formatHostProcessListingForChat(
  listing: AoiHostProcessListingView,
  options: { query?: string; mode?: HostProcessListMode; maxResults?: number } = {},
): string {
  const query = (options.query || '').trim().slice(0, MAX_QUERY_CHARS);
  const mode: HostProcessListMode = options.mode === 'list' ? 'list' : 'summary';
  const maxResults = Math.min(
    MAX_LIST_RESULTS,
    Math.max(1, options.maxResults ?? DEFAULT_LIST_RESULTS),
  );
  const matched = query
    ? listing.records.filter((record) => matchesQuery(record, query))
    : listing.records;

  if (mode === 'list') {
    const rows = matched.slice(0, maxResults).map((record) => {
      const row: Record<string, unknown> = {
        pid: record.pid,
        imageName: record.imageName,
      };
      if (record.sessionName) {
        row.sessionName = record.sessionName;
      }
      if (typeof record.memKb === 'number') {
        row.memKb = record.memKb;
      }
      return row;
    });
    return JSON.stringify({
      ok: true,
      mode: 'list',
      sampledAt: listing.sampledAt,
      query: query || null,
      totalCount: listing.summary.totalCount,
      matchCount: matched.length,
      returnedCount: rows.length,
      truncated: matched.length > rows.length,
      records: rows,
      privacy: 'metadata_only_no_command_line',
      note:
        'Snapshot only (not a live stream). Command lines are never included. ' +
        'If gated, enable Host Bridge process_activity + process-activity consent.',
    });
  }

  const topFromMatched = (() => {
    if (!query) {
      return listing.summary.topImages.slice(0, MAX_TOP_IMAGES);
    }
    const counts = new Map<string, number>();
    for (const record of matched) {
      counts.set(record.imageName, (counts.get(record.imageName) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([imageName, count]) => ({ imageName, count }))
      .sort(
        (left, right) => right.count - left.count || left.imageName.localeCompare(right.imageName),
      )
      .slice(0, MAX_TOP_IMAGES);
  })();

  return JSON.stringify({
    ok: true,
    mode: 'summary',
    sampledAt: listing.sampledAt,
    query: query || null,
    totalCount: listing.summary.totalCount,
    distinctImageCount: listing.summary.distinctImageCount,
    matchCount: query ? matched.length : listing.summary.totalCount,
    topImages: query ? topFromMatched : listing.summary.topImages.slice(0, MAX_TOP_IMAGES),
    privacy: 'metadata_only_no_command_line',
    note:
      'Snapshot only (not a live stream). Use mode=list with query for specific pids. ' +
      'If gated, enable Host Bridge process_activity + process-activity consent.',
  });
}

function formatGateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (lowered.includes('source_not_consented') || lowered.includes('consent')) {
    return (
      `error: host process listing blocked by session consent: ${message}. ` +
      'Machine kill-switch process_activity alone is not enough. ' +
      'Open Settings → Advanced → Host Bridge, toggle Process list Off then On ' +
      '(that grants process-activity consent for the active session), then retry.'
    );
  }
  if (lowered.includes('capability_disabled')) {
    return (
      `error: host process listing blocked: capability process_activity is disabled. ` +
      'Enable Process list in Settings → Advanced → Host Bridge, then retry.'
    );
  }
  if (lowered.includes('host_bridge_panic') || lowered.includes('panic')) {
    return (
      `error: host process listing blocked by host-bridge panic: ${message}. ` +
      'Clear panic in Settings → Advanced → Host Bridge, then retry.'
    );
  }
  if (
    lowered.includes('blocked') ||
    lowered.includes('capability') ||
    lowered.includes('deny') ||
    lowered.includes('unauthorized')
  ) {
    return (
      `error: host process listing blocked: ${message}. ` +
      'Check Host Bridge process_activity kill-switch AND session process-activity consent.'
    );
  }
  if (lowered.includes('sessionpath')) {
    return `error: host process listing needs an active Aoi session: ${message}`;
  }
  return `error: host process listing failed: ${message}`;
}

export async function executeHostProcessTool(
  params: Record<string, unknown>,
  context: HostProcessToolContext,
): Promise<string> {
  const sessionPath = typeof context.sessionPath === 'string' ? context.sessionPath.trim() : '';
  if (!sessionPath) {
    return 'error: host process listing needs an active Aoi session (sessionPath missing).';
  }
  const query = extractQuery(params);
  const mode = extractMode(params);
  const maxResults = extractMaxResults(params);
  const fetchListing = context.fetchListing ?? fetchAoiHostProcesses;
  try {
    const listing = await fetchListing(sessionPath);
    return formatHostProcessListingForChat(listing, { query, mode, maxResults });
  } catch (error) {
    return formatGateError(error);
  }
}
