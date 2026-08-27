// Browser client for /api/ida-sql/*.
//
// Same-origin: the Vite dev mount trusts loopback callers, so no token is
// attached here and the browser never holds the secret (mirrors
// aoiHostBridgeClient). Every response carries the { ok, ... } envelope; a
// non-ok answer is thrown with its error code and detail intact, because the
// codes ARE the explanation the app shows ('write_capability_disabled',
// 'path_outside_roots', 'session_is_read_only').
//
// Browser-safe: no node builtins.
import type {
  IdaSqlBrowseView,
  IdaSqlConfigView,
  IdaSqlHealthView,
  IdaSqlQueryView,
  IdaSqlSessionMode,
  IdaSqlSessionPreviewView,
  IdaSqlSessionView,
  IdaSqlStandingGrantView,
  IdaSqlWritePreviewView,
} from './idaSqlTypes';

const API_PREFIX = '/api/ida-sql';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readOk(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!isRecord(payload)) {
    throw new Error(`ida-sql request failed (HTTP ${response.status})`);
  }
  if (payload.ok !== true) {
    const base =
      typeof payload.error === 'string' && payload.error
        ? payload.error
        : `request failed (HTTP ${response.status})`;
    const detail = typeof payload.detail === 'string' ? payload.detail : '';
    const reasons = Array.isArray(payload.denyReasons)
      ? payload.denyReasons.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const withReasons = reasons.length > 0 ? `${base} [${reasons.join(', ')}]` : base;
    throw new Error(detail && detail !== base ? `${withReasons}: ${detail}` : withReasons);
  }
  return payload;
}

async function getJson(
  route: string,
  search?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const query = search ? `?${new URLSearchParams(search).toString()}` : '';
  return readOk(await fetch(`${API_PREFIX}${route}${query}`));
}

async function sendJson(
  route: string,
  method: 'POST' | 'DELETE',
  body?: Record<string, unknown>,
  search?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const query = search ? `?${new URLSearchParams(search).toString()}` : '';
  return readOk(
    await fetch(`${API_PREFIX}${route}${query}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

export async function fetchIdaSqlHealth(): Promise<IdaSqlHealthView> {
  const payload = await getJson('/health');
  return payload.health as IdaSqlHealthView;
}

export async function fetchIdaSqlConfig(): Promise<IdaSqlConfigView> {
  const payload = await getJson('/config');
  return payload.config as IdaSqlConfigView;
}

export async function saveIdaSqlConfigPatch(
  patch: Partial<IdaSqlConfigView>,
): Promise<IdaSqlConfigView> {
  const payload = await sendJson('/config', 'POST', patch as Record<string, unknown>);
  return payload.config as IdaSqlConfigView;
}

export async function browseIdaSqlPath(path: string): Promise<IdaSqlBrowseView> {
  const payload = await getJson('/browse', path ? { path } : undefined);
  return payload.browse as IdaSqlBrowseView;
}

/** Bounded filename search across the roots (or inside one subtree). */
export async function findIdaSqlBinaries(params: {
  find: string;
  path?: string;
  depth?: number;
}): Promise<IdaSqlBrowseView> {
  const payload = await getJson('/browse', {
    find: params.find,
    ...(params.path ? { path: params.path } : {}),
    ...(params.depth ? { depth: String(params.depth) } : {}),
  });
  return payload.browse as IdaSqlBrowseView;
}

export async function fetchIdaSqlSessions(): Promise<IdaSqlSessionView[]> {
  const payload = await getJson('/sessions');
  return (payload.sessions as IdaSqlSessionView[]) ?? [];
}

/**
 * Where did the IDA window we launched end up?
 *
 * Answers null until the launch's hint run settles -- it waits for IDA to draw,
 * which takes about three seconds. Cheap to poll: the server returns a
 * remembered result rather than measuring again.
 */
export async function fetchIdaSqlGuiWindow(pid: number): Promise<{
  found: boolean;
  detail: string;
}> {
  const payload = await getJson('/gui-window', { pid: String(pid) });
  const window = payload.window as { found?: boolean } | null | undefined;
  return {
    found: window?.found === true,
    detail: typeof payload.detail === 'string' ? payload.detail : '',
  };
}

export async function previewIdaSqlSession(params: {
  binaryPath: string;
  mode?: IdaSqlSessionMode;
  write?: boolean;
}): Promise<{ preview: IdaSqlSessionPreviewView | null; session: IdaSqlSessionView | null }> {
  const payload = await sendJson('/sessions/preview', 'POST', {
    binaryPath: params.binaryPath,
    ...(params.mode ? { mode: params.mode } : {}),
    ...(params.write ? { write: true } : {}),
  });
  return {
    preview: (payload.preview as IdaSqlSessionPreviewView | undefined) ?? null,
    session: (payload.session as IdaSqlSessionView | undefined) ?? null,
  };
}

/** Approve + run a previewed action. Called from an operator click only. */
export async function runIdaSqlApproval(approvalFingerprint: string): Promise<{
  session: IdaSqlSessionView | null;
  query: IdaSqlQueryView | null;
  launchedPid: number | null;
  detail: string;
  /**
   * GUI mode only: the exact line to type into IDA's idasql CLI, with a port in
   * the range attach probes and a token on it. A bare `.http start` binds a
   * random port with no auth (the plugin's own default), so neither attaching nor
   * protecting the server works without naming both.
   */
  guiStartCommand: string;
  guiSuggestedPort: number;
  guiSuggestedToken: string;
}> {
  const payload = await sendJson('/approvals/run', 'POST', { approvalFingerprint });
  return {
    session: (payload.session as IdaSqlSessionView | undefined) ?? null,
    query: (payload.query as IdaSqlQueryView | undefined) ?? null,
    launchedPid: typeof payload.launchedPid === 'number' ? payload.launchedPid : null,
    detail: typeof payload.detail === 'string' ? payload.detail : '',
    guiStartCommand: typeof payload.guiStartCommand === 'string' ? payload.guiStartCommand : '',
    guiSuggestedPort: typeof payload.guiSuggestedPort === 'number' ? payload.guiSuggestedPort : 0,
    guiSuggestedToken:
      typeof payload.guiSuggestedToken === 'string' ? payload.guiSuggestedToken : '',
  };
}

export async function attachIdaSqlGuiSession(params: {
  binaryPath?: string;
  port?: number;
  /**
   * The OPERATOR confirmed this port is their IDA, so skip the identity check.
   *
   * For the case where something answers on the port but does not identify
   * itself as idasql. Only a person can look at a window and say that, so this
   * must never be set from a suggested port or from anything a model produced.
   */
  portDeclared?: boolean;
  /** Only needed if the operator started their in-IDA server with a token. */
  token?: string;
}): Promise<IdaSqlSessionView> {
  const payload = await sendJson('/sessions/attach', 'POST', {
    ...(params.binaryPath ? { binaryPath: params.binaryPath } : {}),
    ...(params.port ? { port: params.port } : {}),
    ...(params.portDeclared ? { portDeclared: true } : {}),
    ...(params.token ? { token: params.token } : {}),
  });
  return payload.session as IdaSqlSessionView;
}

export async function stopIdaSqlSession(sessionId: string): Promise<void> {
  await sendJson('/sessions', 'DELETE', undefined, { sessionId });
}

/**
 * idasql's own stdout/stderr for a session.
 *
 * This is the diagnostic for the most likely first-run failure -- wrong CLI
 * flags, a licence problem, an engine it could not find -- so it has to be
 * reachable from the UI, not just from the API.
 */
export async function fetchIdaSqlSessionOutput(sessionId: string): Promise<string> {
  const payload = await getJson('/session-output', { sessionId });
  return typeof payload.output === 'string' ? payload.output : '';
}

export interface IdaSqlQueryOutcomeView {
  query: IdaSqlQueryView | null;
  /** Present when the batch mutates: the operator has to approve it. */
  writePreview: IdaSqlWritePreviewView | null;
}

export async function runIdaSqlQuery(params: {
  sessionId: string;
  sql: string;
}): Promise<IdaSqlQueryOutcomeView> {
  const payload = await sendJson('/query', 'POST', {
    sessionId: params.sessionId,
    sql: params.sql,
  });
  if (payload.needsApproval === true) {
    return {
      query: null,
      writePreview: (payload.preview as IdaSqlWritePreviewView | undefined) ?? null,
    };
  }
  return {
    query: (payload.query as IdaSqlQueryView | undefined) ?? null,
    writePreview: null,
  };
}

export async function fetchIdaSqlGrants(): Promise<IdaSqlStandingGrantView[]> {
  const payload = await getJson('/grants');
  return (payload.grants as IdaSqlStandingGrantView[]) ?? [];
}

export async function createIdaSqlGrant(params: {
  rootId: string;
  label?: string;
  ttlMs?: number;
  maxSessions?: number;
}): Promise<IdaSqlStandingGrantView> {
  const payload = await sendJson('/grants', 'POST', { ...params });
  return payload.grant as IdaSqlStandingGrantView;
}

export async function deleteIdaSqlGrant(grantId: string): Promise<void> {
  await sendJson('/grants', 'DELETE', undefined, { grantId });
}
