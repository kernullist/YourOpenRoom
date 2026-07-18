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
  id: string;
  path: string;
  label?: string;
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

export async function addAoiHostRoot(
  kind: AoiHostRootKind,
  root: { id: string; path: string; label?: string },
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
