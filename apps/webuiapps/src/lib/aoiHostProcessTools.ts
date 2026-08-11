// Chat-facing host process tools:
// - HP1: read-only process listing (metadata-only)
// - HP2a: allowlisted process spawn (preview → operator approve → execute)
//
// Capability kill-switch + session consent are enforced server-side; this
// module only formats results for the model and resolves natural-language
// targets against the operator allowlist.

import type { ToolDef } from './llmClient';
import {
  fetchAoiHostProcesses,
  fetchAoiHostSpawnAllowlist,
  fetchAoiHostSpawnPreview,
  runAoiHostSpawnExecute,
  type AoiHostProcessListingView,
  type AoiHostProcessRecordView,
  type AoiHostSpawnAllowlistEntryView,
  type AoiHostSpawnExecuteView,
  type AoiHostSpawnPreviewView,
  type AoiHostSpawnRequestBody,
} from './aoiHostBridgeClient';

export const HOST_PROCESS_LIST_TOOL = 'host_process_list';
export const HOST_PROCESS_SPAWN_PREVIEW_TOOL = 'host_process_spawn_preview';
export const HOST_PROCESS_SPAWN_RUN_TOOL = 'host_process_spawn_run';

const MAX_LIST_RESULTS = 50;
const DEFAULT_LIST_RESULTS = 20;
const MAX_TOP_IMAGES = 20;
const MAX_QUERY_CHARS = 80;
const MAX_PATH_CHARS = 1024;
const MAX_ARGS = 24;

export type HostProcessListMode = 'summary' | 'list';

export interface HostProcessToolContext {
  sessionPath: string;
  fetchListing?: (sessionPath: string) => Promise<AoiHostProcessListingView>;
  fetchAllowlist?: () => Promise<AoiHostSpawnAllowlistEntryView[]>;
  previewSpawn?: (body: AoiHostSpawnRequestBody) => Promise<AoiHostSpawnPreviewView>;
  executeSpawn?: (body: AoiHostSpawnRequestBody) => Promise<AoiHostSpawnExecuteView>;
}

// Natural-language aliases → substrings that match allowlist paths/labels.
// Used only for resolution against the operator allowlist (never free-form spawn).
const HOST_SPAWN_QUERY_ALIASES: Record<string, string[]> = {
  메모장: ['notepad', 'notepad++'],
  notepad: ['notepad'],
  'notepad++': ['notepad++', 'notepad'],
  노트패드: ['notepad'],
  계산기: ['calc', 'calculator'],
  calc: ['calc', 'calculator'],
  calculator: ['calc', 'calculator'],
  탐색기: ['explorer'],
  explorer: ['explorer'],
  페인트: ['mspaint', 'paint'],
  paint: ['mspaint', 'paint'],
  chrome: ['chrome'],
  크롬: ['chrome'],
  edge: ['msedge', 'edge'],
  code: ['code', 'code.exe'],
  vscode: ['code', 'code.exe'],
};

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
          'and process-activity consent. Prefer mode=summary unless a specific process filter is needed. ' +
          'This tool does NOT start programs. Do not claim a launch succeeded based on list results alone.',
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
    {
      type: 'function',
      function: {
        name: HOST_PROCESS_SPAWN_PREVIEW_TOOL,
        description:
          'Propose launching an allowlisted program on the REAL operator PC (not an OpenRoom in-app window). ' +
          'Use for requests like "메모장 실행", "run notepad on my PC", "계산기 켜줘". ' +
          'NEVER use app_action OPEN_APP for host PC programs — that only opens in-room apps and will error. ' +
          'This tool does NOT start the process; it records a pending approval and the chat UI shows an ' +
          'Approve & Run popup. Tell the user the popup is open and wait — do NOT send them to Settings. ' +
          'Requires os_process_spawn capability + spawn allowlist entry.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Natural name of the program (e.g. "메모장", "notepad", "계산기"). ' +
                'Resolved against the spawn allowlist by id/label/path basename.',
            },
            allowlist_id: {
              type: 'string',
              description: 'Exact spawn-allowlist entry id when known.',
            },
            program_path: {
              type: 'string',
              description:
                'Absolute executable path when using a directory allowlist entry ' +
                '(e.g. C:\\\\Windows\\\\System32\\\\notepad.exe).',
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional argument vector (no shell metacharacters).',
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: HOST_PROCESS_SPAWN_RUN_TOOL,
        description:
          'Execute a previously previewed host PC spawn AFTER the operator approved it in ' +
          'Host Bridge Approvals. Pass the same allowlist_id / program_path / args as the preview. ' +
          'Only claim the program launched if this tool returns ok:true with a spawned_pid. ' +
          'A later host_process_list matchCount=0 may just be snapshot lag — do not undo a successful spawn claim.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Same natural name used at preview time (optional if allowlist_id set).',
            },
            allowlist_id: {
              type: 'string',
              description: 'Exact spawn-allowlist entry id from the preview.',
            },
            program_path: {
              type: 'string',
              description: 'Absolute executable path from the preview when required.',
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Same argument vector as the preview.',
            },
          },
          required: [],
        },
      },
    },
  ];
}

export function isHostProcessTool(toolName: string): boolean {
  return (
    toolName === HOST_PROCESS_LIST_TOOL ||
    toolName === HOST_PROCESS_SPAWN_PREVIEW_TOOL ||
    toolName === HOST_PROCESS_SPAWN_RUN_TOOL
  );
}

export function getHostProcessToolPendingSummary(params: Record<string, unknown>): string {
  const toolName =
    typeof params.__toolName === 'string' ? params.__toolName : HOST_PROCESS_LIST_TOOL;
  if (toolName === HOST_PROCESS_SPAWN_PREVIEW_TOOL || toolName === HOST_PROCESS_SPAWN_RUN_TOOL) {
    const target =
      extractAllowlistId(params) || extractProgramPath(params) || extractQuery(params) || 'program';
    return `${toolName}(${String(target).slice(0, 48)})`;
  }
  const query = extractQuery(params);
  const mode = extractMode(params);
  if (query) {
    return `${HOST_PROCESS_LIST_TOOL}(${mode},q=${query.slice(0, 32)})`;
  }
  return `${HOST_PROCESS_LIST_TOOL}(${mode})`;
}

function extractQuery(params: Record<string, unknown>): string {
  const candidates = [params.query, params.image, params.name, params.filter, params.program];
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

function extractAllowlistId(params: Record<string, unknown>): string {
  const candidates = [params.allowlist_id, params.allowlistId, params.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, 64);
    }
  }
  return '';
}

function extractProgramPath(params: Record<string, unknown>): string {
  const candidates = [params.program_path, params.programPath, params.path, params.exe];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, MAX_PATH_CHARS);
    }
  }
  return '';
}

function extractArgs(params: Record<string, unknown>): string[] | undefined {
  const raw = params.args ?? params.arguments;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const args = raw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, MAX_ARGS);
  return args.length > 0 ? args : undefined;
}

function matchesQuery(record: AoiHostProcessRecordView, query: string): boolean {
  if (!query) {
    return true;
  }
  return record.imageName.toLowerCase().includes(query.toLowerCase());
}

function basenameOfPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return (parts[parts.length - 1] || path).toLowerCase();
}

function queryNeedles(query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return [];
  }
  const needles = new Set<string>([trimmed]);
  const aliases = HOST_SPAWN_QUERY_ALIASES[trimmed];
  if (aliases) {
    for (const alias of aliases) {
      needles.add(alias.toLowerCase());
    }
  }
  return [...needles];
}

export function resolveHostSpawnTarget(
  params: Record<string, unknown>,
  allowlist: AoiHostSpawnAllowlistEntryView[],
): { body: AoiHostSpawnRequestBody; matchNote: string } | { error: string } {
  const allowlistId = extractAllowlistId(params);
  const programPath = extractProgramPath(params);
  const query = extractQuery(params);
  const args = extractArgs(params);

  if (allowlistId) {
    const entry = allowlist.find((item) => item.id === allowlistId);
    if (!entry) {
      return {
        error:
          `error: unknown spawn allowlist id "${allowlistId}". ` +
          'List entries via Settings → Advanced → Host PC → Spawn, or call host_process_spawn_preview with query only after registering a preset (e.g. Notepad).',
      };
    }
    if (entry.match === 'directory' && !programPath) {
      return {
        error: `error: allowlist id "${allowlistId}" is a directory match — pass program_path as the absolute .exe under that folder.`,
      };
    }
    return {
      body: {
        allowlistId,
        ...(programPath ? { programPath } : {}),
        ...(args ? { args } : {}),
      },
      matchNote: `allowlist_id=${allowlistId}`,
    };
  }

  if (programPath) {
    // Path-only: let the server match directory/file allowlist entries.
    return {
      body: {
        programPath,
        ...(args ? { args } : {}),
      },
      matchNote: `program_path=${programPath}`,
    };
  }

  if (!query) {
    return {
      error:
        'error: host_process_spawn needs query, allowlist_id, or program_path ' +
        '(e.g. query="메모장" or allowlist_id="exe-notepad").',
    };
  }

  const needles = queryNeedles(query);
  const scored = allowlist
    .map((entry) => {
      const id = entry.id.toLowerCase();
      const label = (entry.label || '').toLowerCase();
      const path = entry.path.toLowerCase();
      const base = basenameOfPath(entry.path);
      let score = 0;
      for (const needle of needles) {
        if (id === needle || label === needle || base === needle || base === `${needle}.exe`) {
          score = Math.max(score, 100);
        } else if (
          id.includes(needle) ||
          label.includes(needle) ||
          base.includes(needle) ||
          path.includes(needle)
        ) {
          score = Math.max(score, 50);
        }
      }
      return { entry, score };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return {
      error:
        `error: no spawn allowlist entry matches "${query}". ` +
        'Open Settings → Advanced → Host PC → Spawn, enable "Start process", ' +
        'add the Notepad (or other) preset / path, then retry host_process_spawn_preview. ' +
        'Do NOT fall back to app_action OPEN_APP for host programs.',
    };
  }

  const best = scored[0]!.entry;
  if (best.match === 'directory') {
    // Prefer a concrete program_path when the query implies a known basename.
    const preferredBase =
      needles.find((needle) => needle.endsWith('.exe')) ||
      (needles.includes('notepad') || needles.includes('notepad++')
        ? needles.includes('notepad++')
          ? 'notepad++.exe'
          : 'notepad.exe'
        : needles.includes('calc') || needles.includes('calculator')
          ? 'calc.exe'
          : '');
    if (!preferredBase) {
      return {
        error:
          `error: matched directory allowlist "${best.id}" (${best.path}) but could not infer program_path from "${query}". ` +
          'Pass program_path as the absolute executable under that directory.',
      };
    }
    const sep = best.path.includes('\\') ? '\\' : '/';
    const inferredPath = `${best.path.replace(/[\\/]+$/, '')}${sep}${preferredBase}`;
    return {
      body: {
        allowlistId: best.id,
        programPath: inferredPath,
        ...(args ? { args } : {}),
      },
      matchNote: `query="${query}" → allowlist_id=${best.id} program_path=${inferredPath}`,
    };
  }

  return {
    body: {
      allowlistId: best.id,
      ...(args ? { args } : {}),
    },
    matchNote: `query="${query}" → allowlist_id=${best.id} (${best.label || best.path})`,
  };
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
        'This is NOT proof that a spawn succeeded or failed. ' +
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
      'Do not claim a host program launched from this listing alone. ' +
      'If gated, enable Host Bridge process_activity + process-activity consent.',
  });
}

function formatGateError(error: unknown, surface: 'list' | 'spawn'): string {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  const noun = surface === 'spawn' ? 'host process spawn' : 'host process listing';
  if (lowered.includes('source_not_consented') || lowered.includes('consent')) {
    return (
      `error: ${noun} blocked by session consent: ${message}. ` +
      (surface === 'list'
        ? 'Open Settings → Advanced → Host Bridge, toggle Process list Off then On ' +
          '(that grants process-activity consent for the active session), then retry.'
        : 'Enable Start process in Settings → Advanced → Host Bridge and approve the pending spawn.')
    );
  }
  if (lowered.includes('capability_disabled')) {
    return (
      `error: ${noun} blocked: capability disabled. ${message}. ` +
      (surface === 'list'
        ? 'Enable Process list (process_activity) in Settings → Advanced → Host Bridge, then retry.'
        : 'Enable Start process (os_process_spawn) in Settings → Advanced → Host Bridge, then retry.')
    );
  }
  if (lowered.includes('host_bridge_panic') || lowered.includes('panic')) {
    return (
      `error: ${noun} blocked by host-bridge panic: ${message}. ` +
      'Clear panic in Settings → Advanced → Host Bridge, then retry.'
    );
  }
  if (lowered.includes('approval_missing') || lowered.includes('approval')) {
    return (
      `error: ${noun} blocked — operator approval missing or expired: ${message}. ` +
      'Call host_process_spawn_preview first, ask the user to approve in ' +
      'Settings → Advanced → Host PC → Approvals, then call host_process_spawn_run with the same params.'
    );
  }
  if (
    lowered.includes('blocked') ||
    lowered.includes('capability') ||
    lowered.includes('deny') ||
    lowered.includes('unauthorized')
  ) {
    return (
      `error: ${noun} blocked: ${message}. ` +
      (surface === 'list'
        ? 'Check Host Bridge process_activity kill-switch AND session process-activity consent.'
        : 'Check Host Bridge os_process_spawn kill-switch, spawn allowlist, and Approvals inbox.')
    );
  }
  if (lowered.includes('sessionpath')) {
    return `error: ${noun} needs an active Aoi session: ${message}`;
  }
  return `error: ${noun} failed: ${message}`;
}

async function executeHostProcessListTool(
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
    return formatGateError(error, 'list');
  }
}

async function executeHostProcessSpawnPreviewTool(
  params: Record<string, unknown>,
  context: HostProcessToolContext,
): Promise<string> {
  const fetchAllowlist = context.fetchAllowlist ?? fetchAoiHostSpawnAllowlist;
  const previewSpawn = context.previewSpawn ?? fetchAoiHostSpawnPreview;
  try {
    const allowlist = await fetchAllowlist();
    const resolved = resolveHostSpawnTarget(params, allowlist);
    if ('error' in resolved) {
      return resolved.error;
    }
    const preview = await previewSpawn(resolved.body);
    if (!preview.allowed) {
      return JSON.stringify({
        status: 'blocked',
        ok: false,
        match: resolved.matchNote,
        block_reasons: preview.blockReasons,
        program: preview.program || null,
        allowlist_id: preview.allowlistId || null,
        note:
          'Spawn policy rejected this request. Register the program on the spawn allowlist ' +
          'and enable Start process in Settings → Advanced → Host PC, then retry. ' +
          'Do NOT use app_action OPEN_APP for host PC programs.',
      });
    }
    return JSON.stringify({
      status: 'approval_required',
      ok: true,
      match: resolved.matchNote,
      allowlist_id: preview.allowlistId,
      label: preview.label,
      program: preview.program,
      args: preview.args,
      approval_fingerprint: preview.approvalFingerprint,
      expires_at: preview.expiresAt,
      note:
        'This did NOT start the program. A chat-screen approval popup is shown to the operator. ' +
        'Do NOT send the user to Settings for this. Wait for them to click Approve & Run or Deny in the popup. ' +
        'Only claim launch success after the popup Approve & Run succeeds or host_process_spawn_run returns ok:true with spawned_pid.',
    });
  } catch (error) {
    return formatGateError(error, 'spawn');
  }
}

/** Parse a spawn-preview tool JSON payload that requires operator approval. */
export function parseHostSpawnApprovalRequired(result: string): {
  approvalFingerprint: string;
  label: string;
  program: string;
  args: string[];
  allowlistId: string;
  expiresAt: number;
  match: string;
} | null {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (parsed.status !== 'approval_required' || typeof parsed.approval_fingerprint !== 'string') {
      return null;
    }
    const fingerprint = parsed.approval_fingerprint.trim();
    if (!fingerprint) {
      return null;
    }
    return {
      approvalFingerprint: fingerprint,
      label: typeof parsed.label === 'string' ? parsed.label : '',
      program: typeof parsed.program === 'string' ? parsed.program : '',
      args: Array.isArray(parsed.args)
        ? parsed.args.filter((value): value is string => typeof value === 'string')
        : [],
      allowlistId: typeof parsed.allowlist_id === 'string' ? parsed.allowlist_id : '',
      expiresAt: typeof parsed.expires_at === 'number' ? parsed.expires_at : 0,
      match: typeof parsed.match === 'string' ? parsed.match : '',
    };
  } catch {
    return null;
  }
}

async function executeHostProcessSpawnRunTool(
  params: Record<string, unknown>,
  context: HostProcessToolContext,
): Promise<string> {
  const fetchAllowlist = context.fetchAllowlist ?? fetchAoiHostSpawnAllowlist;
  const executeSpawn = context.executeSpawn ?? runAoiHostSpawnExecute;
  try {
    const allowlist = await fetchAllowlist();
    const resolved = resolveHostSpawnTarget(params, allowlist);
    if ('error' in resolved) {
      return resolved.error;
    }
    const result = await executeSpawn(resolved.body);
    if (!result.ok) {
      return JSON.stringify({
        status: 'failed',
        ok: false,
        match: resolved.matchNote,
        program: result.program || null,
        allowlist_id: result.allowlistId || null,
        spawned_pid: result.spawnedPid,
        block_reasons: result.blockReasons,
        note:
          'Spawn did not run. If block_reasons mention approval, re-run host_process_spawn_preview ' +
          'and get operator approval first. Do not claim the program is open.',
      });
    }
    return JSON.stringify({
      status: 'done',
      ok: true,
      match: resolved.matchNote,
      program: result.program,
      allowlist_id: result.allowlistId,
      spawned_pid: result.spawnedPid,
      note:
        'Host process spawn succeeded (single-use approval consumed). ' +
        'You may tell the user the program was started. ' +
        'A later host_process_list with matchCount=0 may be snapshot lag, not failure.',
    });
  } catch (error) {
    return formatGateError(error, 'spawn');
  }
}

export async function executeHostProcessTool(
  params: Record<string, unknown>,
  context: HostProcessToolContext,
  toolName: string = HOST_PROCESS_LIST_TOOL,
): Promise<string> {
  if (toolName === HOST_PROCESS_SPAWN_PREVIEW_TOOL) {
    return executeHostProcessSpawnPreviewTool(params, context);
  }
  if (toolName === HOST_PROCESS_SPAWN_RUN_TOOL) {
    return executeHostProcessSpawnRunTool(params, context);
  }
  return executeHostProcessListTool(params, context);
}
