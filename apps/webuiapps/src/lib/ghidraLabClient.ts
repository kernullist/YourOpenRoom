// Browser client for /api/ghidra-lab/*.
//
// Same-origin: the Vite dev mount trusts loopback callers, so no token is
// attached here and the browser never holds the secret (mirrors idaSqlClient and
// aoiHostBridgeClient). Every response carries the { ok, ... } envelope; a non-ok
// answer is thrown with its error code intact, because the codes ARE the
// explanation the app shows ('preflight_jdk', 'path_outside_roots',
// 'headless_mode_unavailable').
//
// Browser-safe: no node builtins.
import type {
  GhidraLabBrowseView,
  GhidraLabConfigView,
  GhidraLabHealthView,
  GhidraLabSessionPreviewView,
  GhidraLabSessionView,
  GhidraQueryView,
  GhidraReportRunView,
  GhidraSweepLedger,
} from './ghidraLabTypes';

const API_PREFIX = '/api/ghidra-lab';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readOk(response: Response): Promise<Record<string, unknown>> {
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed)) {
    throw new Error(`ghidra-lab request failed (HTTP ${response.status})`);
  }
  if (parsed.ok !== true) {
    const base =
      typeof parsed.error === 'string' && parsed.error
        ? parsed.error
        : `request failed (HTTP ${response.status})`;
    const detail = typeof parsed.detail === 'string' ? parsed.detail : '';
    const reasons = Array.isArray(parsed.denyReasons)
      ? parsed.denyReasons.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const suffix = detail || (reasons.length > 1 ? reasons.join(', ') : '');
    throw new Error(suffix ? `${base}: ${suffix}` : base);
  }
  return parsed;
}

async function getJson(
  path: string,
  query: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const search = new URLSearchParams(query).toString();
  const response = await fetch(`${API_PREFIX}${path}${search ? `?${search}` : ''}`);
  return readOk(response);
}

async function sendJson(
  path: string,
  method: 'POST' | 'DELETE',
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (method === 'DELETE') {
    const search = new URLSearchParams(
      Object.fromEntries(Object.entries(body).map(([key, value]) => [key, String(value)])),
    ).toString();
    return readOk(await fetch(`${API_PREFIX}${path}${search ? `?${search}` : ''}`, { method }));
  }
  const response = await fetch(`${API_PREFIX}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readOk(response);
}

export async function fetchGhidraLabHealth(): Promise<GhidraLabHealthView> {
  return (await getJson('/health')).health as GhidraLabHealthView;
}

export async function fetchGhidraLabConfig(): Promise<GhidraLabConfigView> {
  return (await getJson('/config')).config as GhidraLabConfigView;
}

export async function saveGhidraLabConfigRemote(
  config: Partial<GhidraLabConfigView>,
): Promise<GhidraLabConfigView> {
  return (await sendJson('/config', 'POST', { config })).config as GhidraLabConfigView;
}

export async function bootstrapGhidraPython(): Promise<{
  config: GhidraLabConfigView;
  detail: string;
}> {
  const payload = await sendJson('/bootstrap-python', 'POST', {});
  return {
    config: payload.config as GhidraLabConfigView,
    detail: typeof payload.detail === 'string' ? payload.detail : '',
  };
}

export async function browseGhidraPath(path?: string): Promise<GhidraLabBrowseView> {
  return (await getJson('/browse', path ? { path } : {})).browse as GhidraLabBrowseView;
}

export async function findGhidraBinaries(params: {
  find: string;
  path?: string;
  depth?: number;
}): Promise<GhidraLabBrowseView> {
  const query: Record<string, string> = { find: params.find };
  if (params.path) {
    query.path = params.path;
  }
  if (params.depth) {
    query.depth = String(params.depth);
  }
  return (await getJson('/browse', query)).browse as GhidraLabBrowseView;
}

export async function fetchGhidraSessions(): Promise<GhidraLabSessionView[]> {
  return ((await getJson('/sessions')).sessions ?? []) as GhidraLabSessionView[];
}

export async function previewGhidraSession(
  binaryPath: string,
): Promise<GhidraLabSessionPreviewView> {
  return (await sendJson('/sessions/preview', 'POST', { binaryPath }))
    .preview as GhidraLabSessionPreviewView;
}

export async function runGhidraApproval(
  approvalFingerprint: string,
): Promise<{ session?: GhidraLabSessionView; runId?: string }> {
  const payload = await sendJson('/approvals/run', 'POST', { approvalFingerprint });
  return {
    ...(payload.session ? { session: payload.session as GhidraLabSessionView } : {}),
    ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
  };
}

export async function stopGhidraSession(sessionId: string): Promise<void> {
  await sendJson('/sessions', 'DELETE', { sessionId });
}

export async function runGhidraQuery(params: {
  sessionId: string;
  kind: string;
  args?: Record<string, unknown>;
}): Promise<GhidraQueryView> {
  const payload = await sendJson('/query', 'POST', {
    sessionId: params.sessionId,
    kind: params.kind,
    args: params.args ?? {},
  });
  return payload.query as GhidraQueryView;
}

export async function previewGhidraReport(sessionId: string): Promise<{
  allowed: boolean;
  blockReasons: string[];
  approvalFingerprint: string;
  targetSummary: string;
}> {
  const payload = await sendJson('/reports/preview', 'POST', { sessionId });
  return payload.preview as {
    allowed: boolean;
    blockReasons: string[];
    approvalFingerprint: string;
    targetSummary: string;
  };
}

export interface GhidraPendingApproval {
  approvalFingerprint: string;
  capability: string;
  targetSummary: string;
  /** The store's own field name is `state`, with values pending/approved/consumed. */
  state: string;
  expiresAt: number;
}

/**
 * Approvals waiting for the operator.
 *
 * This is what closes the loop when AOI proposes the analysis: the tool records
 * a pending approval server-side, and the window has to be able to find it
 * without having been the one that asked.
 */
export async function fetchGhidraApprovals(): Promise<GhidraPendingApproval[]> {
  const payload = await getJson('/approvals');
  const approvals = Array.isArray(payload.approvals) ? payload.approvals : [];
  return approvals
    .filter(isRecord)
    .map((entry) => ({
      approvalFingerprint: String(entry.approvalFingerprint ?? ''),
      capability: String(entry.capability ?? ''),
      targetSummary: String(entry.targetSummary ?? ''),
      state: String(entry.state ?? ''),
      expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : 0,
    }))
    .filter((entry) => entry.approvalFingerprint && entry.state === 'pending');
}

export async function fetchGhidraRuns(): Promise<GhidraReportRunView[]> {
  return ((await getJson('/reports')).runs ?? []) as GhidraReportRunView[];
}

export async function fetchGhidraReport(runId: string): Promise<string> {
  const payload = await getJson('/reports/artifact', { runId, artifact: 'report' });
  return typeof payload.report === 'string' ? payload.report : '';
}

export async function fetchGhidraLedger(runId: string): Promise<GhidraSweepLedger | null> {
  const payload = await getJson('/reports/artifact', { runId, artifact: 'ledger' });
  return (payload.ledger as GhidraSweepLedger) ?? null;
}

export async function cancelGhidraRun(runId: string): Promise<void> {
  await sendJson('/reports', 'DELETE', { runId });
}

export async function fetchGhidraSessionOutput(
  sessionId: string,
): Promise<{ output: string; engineTools: string[] }> {
  const payload = await getJson('/session-output', { sessionId });
  return {
    output: typeof payload.output === 'string' ? payload.output : '',
    engineTools: Array.isArray(payload.engineTools) ? (payload.engineTools as string[]) : [],
  };
}
