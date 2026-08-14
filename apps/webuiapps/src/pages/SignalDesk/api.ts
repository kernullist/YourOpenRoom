import type { SignalBriefResponse, SignalsResponse } from '@/lib/signalDeskShared';
import type { PanelState } from './types';

// One fetch layer for the desk's two local routes. The transport distinction
// is made here, once: a missing plugin route can never render as an error,
// and a failure can never render as an empty inbox.

export const SIGNAL_DESK_SIGNALS_ROUTE = '/api/signal-desk/signals';
export const SIGNAL_DESK_BRIEF_ROUTE = '/api/signal-desk/brief';

export function buildSignalDeskUrl(route: string, sessionPath: string, force: boolean): string {
  const params = new URLSearchParams();
  const trimmed = sessionPath.trim();
  if (trimmed) {
    params.set('sessionPath', trimmed);
  }
  if (force) {
    params.set('refresh', '1');
  }
  const query = params.toString();
  return query ? `${route}?${query}` : route;
}

/**
 * - transport throw -> error (the request never arrived)
 * - 404 -> unconfigured (the dev-server plugin is not mounted: off, not broken)
 * - other non-2xx -> error carrying the server's message
 * - 2xx with a non-JSON / non-object body -> unconfigured (the SPA fallback
 *   answered instead of the plugin)
 * - 2xx JSON without ok:true -> error
 */
async function fetchPanel<T extends { ok: true }>(url: string): Promise<PanelState<T>> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `요청 실패: ${message}`, fetchedAt: Date.now() };
  }

  if (response.status === 404) {
    return { kind: 'unconfigured', fetchedAt: Date.now() };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const record = body as Record<string, unknown> | null;
    const message =
      record && typeof record.error === 'string' ? record.error : `HTTP ${response.status}`;
    return { kind: 'error', message, fetchedAt: Date.now() };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'unconfigured', fetchedAt: Date.now() };
  }
  if ((body as Record<string, unknown>).ok !== true) {
    const record = body as Record<string, unknown>;
    const message =
      typeof record.error === 'string'
        ? record.error
        : '서버가 ok:true 가 아닌 응답을 반환했습니다.';
    return { kind: 'error', message, fetchedAt: Date.now() };
  }
  return { kind: 'ready', data: body as T, fetchedAt: Date.now() };
}

export function fetchSignals(
  sessionPath: string,
  force: boolean,
): Promise<PanelState<SignalsResponse>> {
  return fetchPanel<SignalsResponse>(
    buildSignalDeskUrl(SIGNAL_DESK_SIGNALS_ROUTE, sessionPath, force),
  );
}

export function fetchBrief(
  sessionPath: string,
  force: boolean,
): Promise<PanelState<SignalBriefResponse>> {
  return fetchPanel<SignalBriefResponse>(
    buildSignalDeskUrl(SIGNAL_DESK_BRIEF_ROUTE, sessionPath, force),
  );
}
