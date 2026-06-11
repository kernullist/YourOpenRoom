import type {
  AoiAutonomyPolicy,
  AoiAutonomyStatus,
  AoiAutonomyTickReason,
  AoiAutonomyTickResult,
  AoiProposal,
  AoiProposalDecision,
  AoiProposalDecisionAction,
  AoiReflection,
} from './aoiAutonomyTypes';

const API_PREFIX = '/api/aoi-autonomy';

export interface AoiAutonomyProposalList {
  sessionPath: string;
  active: AoiProposal[];
  archived: AoiProposal[];
}

export interface AoiAutonomyReflectionList {
  sessionPath: string;
  reflections: AoiReflection[];
}

export interface AoiAutonomyPolicyUpdateResult {
  sessionPath: string;
  policy: AoiAutonomyPolicy;
}

export interface AoiAutonomyProposalDecisionResult {
  sessionPath: string;
  proposal: AoiProposal;
  decision: AoiProposalDecision;
  active: AoiProposal[];
  archived: AoiProposal[];
  executed: false;
}

export interface AoiAutonomyProposalDecisionInput {
  proposalId: string;
  action: AoiProposalDecisionAction;
  reason?: string;
  snoozeMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload) && typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error;
  }
  return fallback;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function readJsonRecord(
  response: Response,
  fallbackError: string,
): Promise<Record<string, unknown>> {
  let payload: unknown = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, fallbackError));
  }

  if (!isRecord(payload)) {
    throw new Error(fallbackError);
  }

  return payload;
}

function requireRecordField<T>(
  payload: Record<string, unknown>,
  field: string,
  fallbackError: string,
): T {
  const value = payload[field];
  if (!isRecord(value)) {
    throw new Error(fallbackError);
  }
  return value as T;
}

function sessionQuery(sessionPath: string): string {
  return `sessionPath=${encodeURIComponent(sessionPath)}`;
}

export async function fetchAoiAutonomyStatus(sessionPath: string): Promise<AoiAutonomyStatus> {
  const response = await fetch(`${API_PREFIX}/status?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi autonomy status.');
  return requireRecordField<AoiAutonomyStatus>(
    payload,
    'status',
    'Aoi autonomy status response was malformed.',
  );
}

export async function fetchAoiAutonomyProposals(
  sessionPath: string,
  includeArchived = true,
): Promise<AoiAutonomyProposalList> {
  const response = await fetch(
    `${API_PREFIX}/proposals?${sessionQuery(sessionPath)}&includeArchived=${includeArchived}`,
  );
  const payload = await readJsonRecord(response, 'Failed to load Aoi autonomy proposals.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    active: asArray<AoiProposal>(payload.active),
    archived: asArray<AoiProposal>(payload.archived),
  };
}

export async function fetchAoiAutonomyReflections(
  sessionPath: string,
): Promise<AoiAutonomyReflectionList> {
  const response = await fetch(`${API_PREFIX}/reflections?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi autonomy reflections.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    reflections: asArray<AoiReflection>(payload.reflections),
  };
}

export async function updateAoiAutonomyPolicy(
  sessionPath: string,
  policy: Partial<AoiAutonomyPolicy>,
): Promise<AoiAutonomyPolicyUpdateResult> {
  const response = await fetch(`${API_PREFIX}/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionPath, policy }),
  });
  const payload = await readJsonRecord(response, 'Failed to update Aoi autonomy policy.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    policy: requireRecordField<AoiAutonomyPolicy>(
      payload,
      'policy',
      'Aoi autonomy policy response was malformed.',
    ),
  };
}

export async function runAoiAutonomyManualTick(params: {
  sessionPath: string;
  latestUserMessage?: string;
  llmConfig?: unknown;
  reason?: AoiAutonomyTickReason;
}): Promise<AoiAutonomyTickResult> {
  const response = await fetch(`${API_PREFIX}/tick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath: params.sessionPath,
      reason: params.reason ?? 'manual',
      latestUserMessage: params.latestUserMessage,
      llmConfig: params.llmConfig,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to run Aoi autonomy check.');
  if (payload.ok !== true) {
    throw new Error(getErrorMessage(payload, 'Aoi autonomy check did not complete.'));
  }
  return payload as unknown as AoiAutonomyTickResult;
}

export async function decideAoiProposal(
  sessionPath: string,
  input: AoiAutonomyProposalDecisionInput,
): Promise<AoiAutonomyProposalDecisionResult> {
  const response = await fetch(`${API_PREFIX}/proposal/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      proposalId: input.proposalId,
      action: input.action,
      actor: 'user',
      reason: input.reason,
      snoozeMs: input.snoozeMs,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record Aoi proposal decision.');

  return {
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    proposal: requireRecordField<AoiProposal>(
      payload,
      'proposal',
      'Aoi proposal decision response was malformed.',
    ),
    decision: requireRecordField<AoiProposalDecision>(
      payload,
      'decision',
      'Aoi proposal decision response was malformed.',
    ),
    active: asArray<AoiProposal>(payload.active),
    archived: asArray<AoiProposal>(payload.archived),
    executed: false,
  };
}
