// Client-side wrapper for the host-bridge daemon API (/api/aoi-host/*).
//
// Same-origin: the Vite dev mount (vite.config.ts) trusts loopback callers, so no
// token is attached here -- the browser never holds the secret. Against the
// standalone daemon a caller WOULD need the x-aoi-host-bridge-token header; this
// wrapper targets the dev/same-origin mount. Mirrors aoiAutonomyClient's
// fetch + parse shape (throw on !ok, surface denyReasons).

const API_PREFIX = '/api/aoi-host';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// Parse the uniform { ok, ... } envelope, throwing a readable error (including
// gate denyReasons) on any non-ok response.
async function readOk(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!isRecord(payload)) {
    throw new Error(`host-bridge request failed (HTTP ${response.status})`);
  }
  if (payload.ok !== true) {
    const base = asString(payload.error) || `request failed (HTTP ${response.status})`;
    const reasons = Array.isArray(payload.denyReasons) ? asStringArray(payload.denyReasons) : [];
    throw new Error(reasons.length > 0 ? `${base} [${reasons.join(', ')}]` : base);
  }
  return payload;
}

async function getJson(route: string): Promise<Record<string, unknown>> {
  return readOk(await fetch(`${API_PREFIX}${route}`));
}

async function sendJson(
  route: string,
  method: 'POST' | 'DELETE',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return readOk(
    await fetch(`${API_PREFIX}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

// --- Status + kill switch ----------------------------------------------------

export interface AoiHostBridgeKillSwitchView {
  globalPanic: boolean;
  enabledCapabilities: string[];
  updatedAt: number;
}

export interface AoiHostBridgeStatus {
  tokenConfigured: boolean;
  killSwitch: AoiHostBridgeKillSwitchView;
}

function parseKillSwitch(value: unknown): AoiHostBridgeKillSwitchView {
  const record = isRecord(value) ? value : {};
  return {
    globalPanic: record.globalPanic === true,
    enabledCapabilities: asStringArray(record.enabledCapabilities),
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  };
}

export async function fetchAoiHostBridgeStatus(): Promise<AoiHostBridgeStatus> {
  const payload = await getJson('/status');
  return {
    tokenConfigured: payload.tokenConfigured === true,
    killSwitch: parseKillSwitch(payload.killSwitch),
  };
}

export type AoiHostKillSwitchAction = 'panic' | 'clear_panic' | 'set';

export async function setAoiHostBridgeKillSwitch(
  action: AoiHostKillSwitchAction,
  options: { capability?: string; enabled?: boolean } = {},
): Promise<AoiHostBridgeKillSwitchView> {
  const payload = await sendJson('/killswitch', 'POST', { action, ...options });
  return parseKillSwitch(payload.killSwitch);
}

// --- Spawn allowlist ---------------------------------------------------------

export interface AoiHostSpawnAllowlistEntryView {
  id: string;
  path: string;
  label?: string;
  match?: 'file' | 'directory';
  fixedArgs?: string[];
}

function parseSpawnEntries(value: unknown): AoiHostSpawnAllowlistEntryView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((record) => {
    const entry: AoiHostSpawnAllowlistEntryView = {
      id: asString(record.id),
      path: asString(record.path),
    };
    if (typeof record.label === 'string') {
      entry.label = record.label;
    }
    if (record.match === 'directory' || record.match === 'file') {
      entry.match = record.match;
    }
    if (Array.isArray(record.fixedArgs)) {
      entry.fixedArgs = asStringArray(record.fixedArgs);
    }
    return entry;
  });
}

export async function fetchAoiHostSpawnAllowlist(): Promise<AoiHostSpawnAllowlistEntryView[]> {
  return parseSpawnEntries((await getJson('/spawn-allowlist')).entries);
}

export async function addAoiHostSpawnAllowlistEntry(entry: {
  id?: string;
  path: string;
  label?: string;
  match?: 'file' | 'directory';
  fixedArgs?: string[];
}): Promise<AoiHostSpawnAllowlistEntryView[]> {
  return parseSpawnEntries((await sendJson('/spawn-allowlist', 'POST', { ...entry })).entries);
}

export async function removeAoiHostSpawnAllowlistEntry(
  id: string,
): Promise<AoiHostSpawnAllowlistEntryView[]> {
  return parseSpawnEntries(
    (await sendJson(`/spawn-allowlist?id=${encodeURIComponent(id)}`, 'DELETE')).entries,
  );
}

// --- Read / write roots ------------------------------------------------------

export interface AoiHostRootView {
  id: string;
  path: string;
  label?: string;
}

function parseRoots(value: unknown): AoiHostRootView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((record) => {
    const root: AoiHostRootView = { id: asString(record.id), path: asString(record.path) };
    if (typeof record.label === 'string') {
      root.label = record.label;
    }
    return root;
  });
}

export type AoiHostRootKind = 'read' | 'write';

function rootsRoute(kind: AoiHostRootKind): string {
  return kind === 'read' ? '/read-roots' : '/write-roots';
}

export async function fetchAoiHostRoots(kind: AoiHostRootKind): Promise<AoiHostRootView[]> {
  return parseRoots((await getJson(rootsRoute(kind))).roots);
}

// --- Process listing (HP1, read-only metadata) -------------------------------

export interface AoiHostProcessRecordView {
  pid: number;
  imageName: string;
  sessionName?: string;
  memKb?: number;
}

export interface AoiHostProcessSummaryView {
  version: 1;
  sampledAt: number;
  totalCount: number;
  topImages: Array<{ imageName: string; count: number }>;
  distinctImageCount: number;
}

export interface AoiHostProcessListingView {
  version: 1;
  sampledAt: number;
  records: AoiHostProcessRecordView[];
  summary: AoiHostProcessSummaryView;
}

function parseProcessRecord(value: unknown): AoiHostProcessRecordView | null {
  if (!isRecord(value)) {
    return null;
  }
  const pid = typeof value.pid === 'number' ? value.pid : Number.NaN;
  const imageName = asString(value.imageName);
  if (!Number.isFinite(pid) || pid <= 0 || !imageName) {
    return null;
  }
  const record: AoiHostProcessRecordView = { pid, imageName };
  if (typeof value.sessionName === 'string' && value.sessionName.trim()) {
    record.sessionName = value.sessionName.trim().slice(0, 32);
  }
  if (typeof value.memKb === 'number' && Number.isFinite(value.memKb)) {
    record.memKb = value.memKb;
  }
  return record;
}

function parseProcessListing(value: unknown): AoiHostProcessListingView {
  const record = isRecord(value) ? value : {};
  const summaryRaw = isRecord(record.summary) ? record.summary : {};
  const topImagesRaw = Array.isArray(summaryRaw.topImages) ? summaryRaw.topImages : [];
  const recordsRaw = Array.isArray(record.records) ? record.records : [];
  const topImages = topImagesRaw
    .filter(isRecord)
    .map((item) => ({
      imageName: asString(item.imageName),
      count: typeof item.count === 'number' ? item.count : 0,
    }))
    .filter((item) => item.imageName && item.count > 0);
  const records = recordsRaw
    .map(parseProcessRecord)
    .filter((item): item is AoiHostProcessRecordView => item !== null);
  const sampledAt =
    typeof record.sampledAt === 'number'
      ? record.sampledAt
      : typeof summaryRaw.sampledAt === 'number'
        ? summaryRaw.sampledAt
        : 0;
  return {
    version: 1,
    sampledAt,
    records,
    summary: {
      version: 1,
      sampledAt,
      totalCount:
        typeof summaryRaw.totalCount === 'number' ? summaryRaw.totalCount : records.length,
      topImages,
      distinctImageCount:
        typeof summaryRaw.distinctImageCount === 'number'
          ? summaryRaw.distinctImageCount
          : topImages.length,
    },
  };
}

export async function fetchAoiHostProcesses(
  sessionPath: string,
): Promise<AoiHostProcessListingView> {
  const path = typeof sessionPath === 'string' ? sessionPath.trim() : '';
  if (!path) {
    throw new Error('sessionPath is required for host process listing');
  }
  const payload = await getJson(`/processes?sessionPath=${encodeURIComponent(path)}`);
  return parseProcessListing(payload.listing);
}

// --- Headless browser page read (HP5) ----------------------------------------

export interface AoiHostBrowserPageView {
  url: string;
  finalUrl: string;
  title: string;
  excerpt: string;
  siteName: string;
  blocks: Array<{ type: string; text: string }>;
  text: string;
  browserPath: string;
  sampledAt: number;
  durationMs: number;
  engine: string;
}

function parseBrowserPage(value: unknown): AoiHostBrowserPageView {
  const record = isRecord(value) ? value : {};
  const blocksRaw = Array.isArray(record.blocks) ? record.blocks : [];
  return {
    url: asString(record.url),
    finalUrl: asString(record.finalUrl) || asString(record.url),
    title: asString(record.title),
    excerpt: asString(record.excerpt),
    siteName: asString(record.siteName),
    blocks: blocksRaw.filter(isRecord).map((block) => ({
      type: asString(block.type) || 'paragraph',
      text: asString(block.text),
    })),
    text: asString(record.text),
    browserPath: asString(record.browserPath),
    sampledAt: typeof record.sampledAt === 'number' ? record.sampledAt : 0,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    engine: asString(record.engine),
  };
}

export async function fetchAoiHostBrowserRead(
  sessionPath: string,
  url: string,
): Promise<AoiHostBrowserPageView> {
  const path = typeof sessionPath === 'string' ? sessionPath.trim() : '';
  if (!path) {
    throw new Error('sessionPath is required for host browser read');
  }
  const target = typeof url === 'string' ? url.trim() : '';
  if (!target) {
    throw new Error('url is required for host browser read');
  }
  const payload = await sendJson('/browser-read', 'POST', { sessionPath: path, url: target });
  return parseBrowserPage(payload.page);
}

export async function addAoiHostRoot(
  kind: AoiHostRootKind,
  root: { id?: string; path: string; label?: string },
): Promise<AoiHostRootView[]> {
  return parseRoots((await sendJson(rootsRoute(kind), 'POST', { ...root })).roots);
}

export async function removeAoiHostRoot(
  kind: AoiHostRootKind,
  id: string,
): Promise<AoiHostRootView[]> {
  return parseRoots(
    (await sendJson(`${rootsRoute(kind)}?id=${encodeURIComponent(id)}`, 'DELETE')).roots,
  );
}

// --- Approvals ---------------------------------------------------------------

export interface AoiHostBridgeApprovalView {
  id: string;
  capability: string;
  approvalFingerprint: string;
  targetSummary: string;
  state: string;
  expiresAt: number;
}

function parseApprovals(value: unknown): AoiHostBridgeApprovalView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((record) => ({
    id: asString(record.id),
    capability: asString(record.capability),
    approvalFingerprint: asString(record.approvalFingerprint),
    targetSummary: asString(record.targetSummary),
    state: asString(record.state),
    expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : 0,
  }));
}

export async function fetchAoiHostApprovals(): Promise<AoiHostBridgeApprovalView[]> {
  return parseApprovals((await getJson('/approvals')).approvals);
}

export async function approveAoiHostApproval(approvalFingerprint: string): Promise<void> {
  await sendJson('/approvals/approve', 'POST', { approvalFingerprint });
}
