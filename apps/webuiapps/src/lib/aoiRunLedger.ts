export type AoiRunStatus = 'running' | 'completed' | 'failed';

export type AoiRunLedgerEventType =
  | 'run_started'
  | 'model_response'
  | 'assistant_delivered'
  | 'plain_text_fallback'
  | 'proposal_accepted'
  | 'proposal_execution_started'
  | 'proposal_execution_completed'
  | 'proposal_execution_failed'
  | 'proposal_execution_blocked'
  | 'kira_handoff_preview_created'
  | 'kira_handoff_execution_approved'
  | 'kira_work_item_created'
  | 'kira_handoff_policy_blocked'
  | 'mission_activated'
  | 'mission_waiting_state_changed'
  | 'mission_resumed'
  | 'mission_paused'
  | 'mission_completed'
  | 'mission_blocked'
  | 'mission_cleared'
  | 'failure_classified'
  | 'recovery_proposal_created'
  | 'recovery_suppressed_by_loop_guard'
  | 'recovery_blocked_by_policy'
  | 'background_event_observed'
  | 'attention_broker_decision'
  | 'notification_suppressed'
  | 'direct_clarification_requested'
  | 'run_completed'
  | 'run_failed';

export interface AoiRunGoal {
  summary: string;
  sourceMessage: string;
  createdAt: number;
}

export interface AoiRunLedgerEvent {
  id: string;
  type: AoiRunLedgerEventType;
  createdAt: number;
  iteration?: number;
  message?: string;
  toolNames?: string[];
}

export interface AoiRunLedgerMetrics {
  iterations: number;
  toolCallCount: number;
  deliveredToolCallCount: number;
  errorCount: number;
  lastToolNames: string[];
}

export interface AoiRunLedgerEntry {
  version: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  status: AoiRunStatus;
  goal: AoiRunGoal;
  modelRoute: 'dialog' | 'main';
  modelId?: string;
  includeAppTools: boolean;
  exposedToolNames: string[];
  events: AoiRunLedgerEvent[];
  metrics: AoiRunLedgerMetrics;
  finalMessage?: string;
}

export interface AoiRunLedgerData {
  version: 1;
  savedAt: number;
  runs: AoiRunLedgerEntry[];
}

export interface AoiRunLedgerSummary {
  total: number;
  running: number;
  completed: number;
  failed: number;
  totalToolCalls: number;
  latestRun: AoiRunLedgerEntry | null;
}

const API_PATH = '/api/session-data';
const MAX_AOI_RUN_LEDGER_ENTRIES = 30;
const MAX_AOI_RUN_LEDGER_EVENTS = 80;

function apiUrl(sessionPath: string, file: string): string {
  return `${API_PATH}?path=${encodeURIComponent(`${sessionPath}/aoi-run-ledger/${file}`)}`;
}

export function createAoiRunGoalFromMessage(message: string, createdAt = Date.now()): AoiRunGoal {
  const sourceMessage = message.trim();
  const summary = sourceMessage ? truncateSingleLine(sourceMessage, 140) : 'Continue conversation';
  return {
    summary,
    sourceMessage,
    createdAt,
  };
}

export function buildAoiRunGoalPrompt(goal: AoiRunGoal): string {
  return `\n\nAoi Run Goal:\n- Current goal: ${JSON.stringify(goal.summary)}.\n- Maintain a compact internal run ledger for this goal: note model iterations, tool-use intent, final delivery, and failures.\n- Complete the goal before responding when the requested work is actionable, and say what remains only if blocked.`;
}

export function createAoiRunLedgerEntry(params: {
  goal: AoiRunGoal;
  modelRoute: 'dialog' | 'main';
  modelId?: string;
  includeAppTools: boolean;
  exposedToolNames: string[];
  createdAt?: number;
}): AoiRunLedgerEntry {
  const createdAt = params.createdAt ?? Date.now();
  const id = `aoi-run-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedEvent: AoiRunLedgerEvent = {
    id: `${id}-started`,
    type: 'run_started',
    createdAt,
    message: params.goal.summary,
    toolNames: params.exposedToolNames,
  };

  return {
    version: 1,
    id,
    createdAt,
    updatedAt: createdAt,
    status: 'running',
    goal: params.goal,
    modelRoute: params.modelRoute,
    modelId: params.modelId,
    includeAppTools: params.includeAppTools,
    exposedToolNames: dedupeNames(params.exposedToolNames),
    events: [startedEvent],
    metrics: {
      iterations: 0,
      toolCallCount: 0,
      deliveredToolCallCount: 0,
      errorCount: 0,
      lastToolNames: [],
    },
  };
}

export function appendAoiRunLedgerEvent(
  entry: AoiRunLedgerEntry,
  event: Omit<AoiRunLedgerEvent, 'id' | 'createdAt'> & { createdAt?: number },
): AoiRunLedgerEntry {
  const createdAt = event.createdAt ?? Date.now();
  const nextEvent: AoiRunLedgerEvent = {
    ...event,
    id: `${entry.id}-${entry.events.length + 1}`,
    createdAt,
    toolNames: event.toolNames ? dedupeNames(event.toolNames) : undefined,
  };
  const events = [...entry.events, nextEvent].slice(-MAX_AOI_RUN_LEDGER_EVENTS);
  const metrics = reduceAoiRunLedgerMetrics(events);

  return {
    ...entry,
    updatedAt: createdAt,
    events,
    metrics,
  };
}

export function finalizeAoiRunLedgerEntry(
  entry: AoiRunLedgerEntry,
  status: AoiRunStatus,
  message?: string,
): AoiRunLedgerEntry {
  const type: AoiRunLedgerEventType = status === 'failed' ? 'run_failed' : 'run_completed';
  const withEvent = appendAoiRunLedgerEvent(entry, {
    type,
    message,
  });
  return {
    ...withEvent,
    status,
    finalMessage: message ? truncateSingleLine(message, 240) : withEvent.finalMessage,
  };
}

export function upsertAoiRunLedgerEntry(
  entries: AoiRunLedgerEntry[],
  entry: AoiRunLedgerEntry,
): AoiRunLedgerEntry[] {
  const withoutEntry = entries.filter((item) => item.id !== entry.id);
  return [entry, ...withoutEntry]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_AOI_RUN_LEDGER_ENTRIES);
}

export function summarizeAoiRunLedger(entries: AoiRunLedgerEntry[]): AoiRunLedgerSummary {
  const totalToolCalls = entries.reduce((sum, entry) => sum + entry.metrics.toolCallCount, 0);
  return {
    total: entries.length,
    running: entries.filter((entry) => entry.status === 'running').length,
    completed: entries.filter((entry) => entry.status === 'completed').length,
    failed: entries.filter((entry) => entry.status === 'failed').length,
    totalToolCalls,
    latestRun: entries[0] ?? null,
  };
}

export async function loadAoiRunLedger(sessionPath: string): Promise<AoiRunLedgerEntry[]> {
  try {
    const res = await fetch(apiUrl(sessionPath, 'runs.json'));
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as Partial<AoiRunLedgerData>;
    if (data.version !== 1 || !Array.isArray(data.runs)) {
      return [];
    }
    return data.runs
      .filter(isAoiRunLedgerEntry)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_AOI_RUN_LEDGER_ENTRIES);
  } catch {
    return [];
  }
}

export async function saveAoiRunLedger(
  sessionPath: string,
  entries: AoiRunLedgerEntry[],
): Promise<void> {
  const data: AoiRunLedgerData = {
    version: 1,
    savedAt: Date.now(),
    runs: entries.slice(0, MAX_AOI_RUN_LEDGER_ENTRIES),
  };

  const res = await fetch(apiUrl(sessionPath, 'runs.json'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    throw new Error(`Aoi run ledger save failed with ${res.status}`);
  }
}

function reduceAoiRunLedgerMetrics(events: AoiRunLedgerEvent[]): AoiRunLedgerMetrics {
  let iterations = 0;
  let toolCallCount = 0;
  let deliveredToolCallCount = 0;
  let errorCount = 0;
  let lastToolNames: string[] = [];

  events.forEach((event) => {
    if (typeof event.iteration === 'number') {
      iterations = Math.max(iterations, event.iteration);
    }
    if (event.type === 'model_response' && event.toolNames?.length) {
      toolCallCount += event.toolNames.length;
      lastToolNames = event.toolNames;
    }
    if (event.type === 'assistant_delivered' && event.toolNames?.length) {
      deliveredToolCallCount = event.toolNames.length;
      lastToolNames = event.toolNames;
    }
    if (
      event.type === 'run_failed' ||
      event.type === 'proposal_execution_failed' ||
      event.type === 'proposal_execution_blocked' ||
      event.type === 'kira_handoff_policy_blocked'
    ) {
      errorCount += 1;
    }
  });

  return {
    iterations,
    toolCallCount,
    deliveredToolCallCount,
    errorCount,
    lastToolNames,
  };
}

function isAoiRunLedgerEntry(value: unknown): value is AoiRunLedgerEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<AoiRunLedgerEntry>;
  return (
    record.version === 1 &&
    typeof record.id === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number' &&
    (record.status === 'running' || record.status === 'completed' || record.status === 'failed') &&
    !!record.goal &&
    Array.isArray(record.events)
  );
}

function dedupeNames(names: string[]): string[] {
  return Array.from(new Set(names.filter((name) => name.trim().length > 0)));
}

function truncateSingleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}
