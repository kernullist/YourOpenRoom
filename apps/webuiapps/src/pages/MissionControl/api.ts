import {
  AOI_DAEMON_HEALTH_ROUTE,
  parseAoiAutonomyRuntimeResponse,
} from '@/lib/aoiAutonomyRuntimePanelModel';
import {
  buildAoiOperatorSnapshotRoute,
  parseAoiOperatorSnapshotResponse,
} from '@/lib/aoiOperatorSnapshotPanelModel';
import {
  buildAoiClosedLoopMetrics,
  DEFAULT_CLOSED_LOOP_MIN_SAMPLE,
} from '@/lib/aoiClosedLoopMetrics';
import type { AoiClosedLoopMetricsReport } from '@/lib/aoiClosedLoopMetrics';
import type { AoiUnifiedOperatorSnapshotSummary } from '@/lib/aoiUnifiedOperatorModel';
import type {
  AoiAutonomySchedulerState,
  AoiAutonomyStatus,
  AoiOperatorTimelineEvent,
  AoiOutcomeSignalRecord,
  AoiProposal,
  AoiProposalDecision,
} from '@/lib/aoiAutonomyTypes';
import type {
  FlightPayload,
  PanelState,
  RuntimePayload,
  SessionChoice,
  TimelinePayload,
} from './types';

// One fetch layer for every operator route. Each wrapper returns a PanelState so
// a section can never accidentally render a failure as an empty list -- the
// distinction is made here, once, instead of in five components.

const AUTONOMY_PREFIX = '/api/aoi-autonomy';

export const MISSION_CONTROL_SESSIONS_ROUTE = `${AUTONOMY_PREFIX}/sessions`;

function nowMs(): number {
  return Date.now();
}

function ready<T>(data: T): PanelState<T> {
  return { kind: 'ready', data, fetchedAt: nowMs() };
}

function empty<T>(reason: string): PanelState<T> {
  return { kind: 'empty', reason, fetchedAt: nowMs() };
}

function failed<T>(message: string, code?: string, status?: number): PanelState<T> {
  return { kind: 'error', message, code, status, fetchedAt: nowMs() };
}

interface FetchJsonResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
  message?: string;
  code?: string;
}

/**
 * Single HTTP entry point.
 *
 * A non-2xx keeps the server's own `code` (for example `invalid_session_path`)
 * because that string is the difference between "Aoi is broken" and "you have
 * not picked a session yet". A transport throw is reported as such rather than
 * being flattened into an empty result.
 */
async function fetchJson(url: string, init?: RequestInit): Promise<FetchJsonResult> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, body: null, message: `요청 실패: ${message}` };
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed = (await response.json()) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
    const code = typeof body?.code === 'string' ? body.code : undefined;
    return { ok: false, status: response.status, body, message, code };
  }
  if (!body || body.ok !== true) {
    return {
      ok: false,
      status: response.status,
      body,
      message: '서버가 ok:true 가 아닌 응답을 반환했습니다.',
      code: 'unexpected_payload',
    };
  }
  return { ok: true, status: response.status, body };
}

function sessionQuery(sessionPath: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({ sessionPath, ...extra }).toString();
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function fetchSessions(): Promise<PanelState<SessionChoice[]>> {
  const result = await fetchJson(MISSION_CONTROL_SESSIONS_ROUTE);
  if (!result.ok) {
    return failed(result.message ?? '세션 목록을 읽지 못했습니다.', result.code, result.status);
  }
  const sessions = asArray<Record<string, unknown>>(result.body?.sessions)
    .map((entry) => ({
      sessionPath: typeof entry.sessionPath === 'string' ? entry.sessionPath : '',
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
    }))
    .filter((entry) => entry.sessionPath.length > 0);
  if (sessions.length === 0) {
    // Not an error: nothing has initialized an autonomy store yet. Saying so
    // plainly beats a red banner on a clean install.
    return empty('자율 스토어가 초기화된 세션이 아직 없습니다.');
  }
  return ready(sessions);
}

/**
 * Daemon liveness.
 *
 * Takes no sessionPath and is intentionally tolerant: parseAoiAutonomyRuntimeResponse
 * already downgrades an unparseable snapshot to 'unreachable', so even a garbage
 * body produces an honest view rather than a panel error. A transport failure,
 * on the other hand, means the probe endpoint itself is gone -- that is a real
 * error and is reported as one.
 */
export async function fetchRuntime(): Promise<PanelState<RuntimePayload>> {
  let response: Response;
  try {
    response = await fetch(AOI_DAEMON_HEALTH_ROUTE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(`데몬 상태 프로브 실패: ${message}`, 'probe_unreachable', 0);
  }
  let raw: unknown = null;
  try {
    raw = await response.json();
  } catch {
    raw = null;
  }
  return ready({ runtime: parseAoiAutonomyRuntimeResponse(raw) });
}

export async function fetchStatus(sessionPath: string): Promise<PanelState<AoiAutonomyStatus>> {
  const result = await fetchJson(`${AUTONOMY_PREFIX}/status?${sessionQuery(sessionPath)}`);
  if (!result.ok) {
    return failed(result.message ?? '자율 상태를 읽지 못했습니다.', result.code, result.status);
  }
  const status = result.body?.status;
  if (!status || typeof status !== 'object') {
    return failed('상태 페이로드가 비어 있습니다.', 'unexpected_payload', result.status);
  }
  // The policy block is dereferenced unguarded by the runtime panel, so a
  // truncated or malformed payload would take the whole app down with a
  // TypeError instead of showing a panel error. Validate the shape here, where
  // every other honesty decision is already made.
  if (!(status as { policy?: unknown }).policy) {
    return failed('상태 페이로드에 policy 가 없습니다.', 'unexpected_payload', result.status);
  }
  return ready(status as AoiAutonomyStatus);
}

export async function fetchSnapshot(
  sessionPath: string,
): Promise<PanelState<AoiUnifiedOperatorSnapshotSummary>> {
  const result = await fetchJson(buildAoiOperatorSnapshotRoute(sessionPath));
  if (!result.ok) {
    return failed(result.message ?? '통합 스냅샷을 읽지 못했습니다.', result.code, result.status);
  }
  const summary = parseAoiOperatorSnapshotResponse(result.body, sessionPath);
  if (!summary) {
    // The parser rejects a summary whose session does not match what we asked
    // for. Showing another session's readiness would be worse than showing none.
    return failed('스냅샷이 요청한 세션과 일치하지 않습니다.', 'session_mismatch', result.status);
  }
  return ready(summary);
}

export async function fetchScheduler(
  sessionPath: string,
): Promise<PanelState<AoiAutonomySchedulerState>> {
  const result = await fetchJson(`${AUTONOMY_PREFIX}/scheduler?${sessionQuery(sessionPath)}`);
  if (!result.ok) {
    return failed(result.message ?? '스케줄러 상태를 읽지 못했습니다.', result.code, result.status);
  }
  const state = result.body?.state;
  if (!state || typeof state !== 'object') {
    return empty('스케줄러 상태가 아직 기록되지 않았습니다.');
  }
  return ready(state as AoiAutonomySchedulerState);
}

export async function fetchProposals(sessionPath: string): Promise<PanelState<AoiProposal[]>> {
  const result = await fetchJson(`${AUTONOMY_PREFIX}/proposals?${sessionQuery(sessionPath)}`);
  if (!result.ok) {
    return failed(result.message ?? '제안 큐를 읽지 못했습니다.', result.code, result.status);
  }
  const active = asArray<AoiProposal>(result.body?.active);
  if (active.length === 0) {
    return empty('활성 제안이 없습니다.');
  }
  return ready(active);
}

export async function fetchTimeline(
  sessionPath: string,
  limit = 100,
): Promise<PanelState<TimelinePayload>> {
  const result = await fetchJson(
    `${AUTONOMY_PREFIX}/timeline?${sessionQuery(sessionPath, { limit: String(limit) })}`,
  );
  if (!result.ok) {
    return failed(result.message ?? '타임라인을 읽지 못했습니다.', result.code, result.status);
  }
  const events = asArray<AoiOperatorTimelineEvent>(result.body?.events);
  if (events.length === 0) {
    return empty('기록된 타임라인 이벤트가 없습니다.');
  }
  return ready({ events });
}

export async function fetchFlight(
  sessionPath: string,
  limit = 50,
): Promise<PanelState<FlightPayload>> {
  const result = await fetchJson(
    `${AUTONOMY_PREFIX}/flight-recorder?${sessionQuery(sessionPath, { limit: String(limit) })}`,
  );
  if (!result.ok) {
    return failed(
      result.message ?? '플라이트 레코더를 읽지 못했습니다.',
      result.code,
      result.status,
    );
  }
  const records = asArray<FlightPayload['records'][number]>(result.body?.records);
  const summaryRaw = result.body?.summary;
  const summary =
    summaryRaw && typeof summaryRaw === 'object' ? (summaryRaw as FlightPayload['summary']) : null;
  if (records.length === 0 && !summary) {
    return empty('기록된 플라이트 레코드가 없습니다.');
  }
  return ready({ records, summary });
}

/**
 * Closed-loop metrics, assembled client-side.
 *
 * No route serves buildAoiClosedLoopMetrics, but it is a pure function and both
 * of its inputs (decisions, outcomes) already have routes. Composing them here
 * is wiring an existing engine up to a dial -- not reimplementing the engine,
 * which would risk drifting from the numbers the gates actually use.
 *
 * Both reads must be honest independently: if either fails we report the failure
 * rather than computing a metric over half the evidence.
 */
export async function fetchMetrics(
  sessionPath: string,
): Promise<PanelState<AoiClosedLoopMetricsReport>> {
  const [decisionsResult, outcomesResult] = await Promise.all([
    fetchJson(`${AUTONOMY_PREFIX}/decisions?${sessionQuery(sessionPath, { limit: '200' })}`),
    fetchJson(`${AUTONOMY_PREFIX}/outcomes?${sessionQuery(sessionPath)}`),
  ]);

  if (!decisionsResult.ok) {
    return failed(
      decisionsResult.message ?? '결정 기록을 읽지 못했습니다.',
      decisionsResult.code,
      decisionsResult.status,
    );
  }
  if (!outcomesResult.ok) {
    return failed(
      outcomesResult.message ?? '성과 신호를 읽지 못했습니다.',
      outcomesResult.code,
      outcomesResult.status,
    );
  }

  const decisions = asArray<AoiProposalDecision>(decisionsResult.body?.decisions);
  const outcomes = asArray<AoiOutcomeSignalRecord>(outcomesResult.body?.outcomes);

  if (decisions.length === 0 && outcomes.length === 0) {
    return empty('아직 폐루프 지표를 계산할 결정/성과 기록이 없습니다.');
  }

  return ready(
    buildAoiClosedLoopMetrics({
      sessionPath,
      decisions,
      outcomes,
      minSample: DEFAULT_CLOSED_LOOP_MIN_SAMPLE,
    }),
  );
}

export type ProposalDecisionAction = 'accept' | 'dismiss' | 'snooze';

export interface MutationResult {
  ok: boolean;
  message: string;
}

/**
 * Apply an operator decision to a proposal.
 *
 * `actor: 'user'` is hard-coded and this function is reachable only from DOM
 * click handlers -- never from the agent action listener. Aoi approving its own
 * proposals through its own console would turn an observability surface into a
 * bypass of the no-self-approval invariant, so the separation is structural
 * rather than a matter of discipline. See __tests__/actionSafety.test.ts.
 */
export async function decideProposal(
  sessionPath: string,
  proposalId: string,
  action: ProposalDecisionAction,
  snoozeMs?: number,
): Promise<MutationResult> {
  const result = await fetchJson(`${AUTONOMY_PREFIX}/proposal/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      proposalId,
      action,
      actor: 'user',
      ...(typeof snoozeMs === 'number' ? { snoozeMs } : {}),
    }),
  });
  if (!result.ok) {
    return { ok: false, message: result.message ?? '결정을 적용하지 못했습니다.' };
  }
  return { ok: true, message: '결정을 적용했습니다.' };
}

/**
 * Run one autonomy tick by hand.
 *
 * Also DOM-only. A manual tick is an operator diagnostic ("does a cycle even
 * complete right now?"); exposing it as an agent action would hand Aoi a way to
 * drive its own loop on demand.
 */
export async function runManualTick(sessionPath: string): Promise<MutationResult> {
  const result = await fetchJson(`${AUTONOMY_PREFIX}/tick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionPath, reason: 'manual' }),
  });
  if (!result.ok) {
    return { ok: false, message: result.message ?? '틱을 실행하지 못했습니다.' };
  }
  // A tick can answer ok:true and still have done nothing (rate limit, another
  // tick already holding the lock). Reporting that as success would leave the
  // operator waiting for effects that are never coming.
  if (result.body?.skipped === true) {
    const skipReason =
      typeof (result.body?.tickState as Record<string, unknown> | undefined)?.lastSkippedReason ===
      'string'
        ? ((result.body?.tickState as Record<string, unknown>).lastSkippedReason as string)
        : 'unknown';
    return { ok: false, message: `틱이 건너뛰어졌습니다 (${skipReason}).` };
  }
  const created =
    typeof result.body?.newActiveProposalCount === 'number'
      ? result.body.newActiveProposalCount
      : 0;
  return { ok: true, message: `틱 완료 — 신규 제안 ${created}건.` };
}
