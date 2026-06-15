import type { AoiRelationIndex } from './aoiAutonomyRelations';
import type {
  AoiApprovedCommandPolicy,
  AoiGoal,
  AoiMissionState,
  AoiOperatorHealthIssue,
  AoiOperatorHealthState,
  AoiOperatorTimelineEvent,
  AoiPlaybook,
  AoiTrustCalibrationProfile,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import type { AoiShadowDecisionReport } from './aoiShadowModeEvaluation';

const DEFAULT_MISSION_MEMORY_TTL_MS = 36 * 60 * 60 * 1000;
const MAX_TEXT = 220;
const MAX_REFS = 24;
const WINDOWS_PRIVATE_PATH_PATTERN = /(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g;
const UNIX_PRIVATE_PATH_PATTERN =
  /(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g;

export type AoiMissionMemorySignalKind =
  | 'last_known_state'
  | 'pending_external_event'
  | 'stale_validation'
  | 'next_approval'
  | 'preference_drift'
  | 'blind_spot'
  | 'replay_trace_evidence'
  | 'needs_refresh';

export type AoiMissionMemoryFreshness = 'fresh' | 'stale' | 'expired' | 'unknown';

export interface AoiMissionMemorySignal {
  version: 1;
  id: string;
  missionId: string;
  sessionPath: string;
  kind: AoiMissionMemorySignalKind;
  label: string;
  summary: string;
  refs: string[];
  evidenceRefs: string[];
  observedAt: number;
  freshness: AoiMissionMemoryFreshness;
  mutationCount: 0;
}

export interface AoiMissionMemorySnapshot {
  version: 1;
  id: string;
  missionId: string;
  sessionPath: string;
  lastKnownState: string;
  pendingExternalRefs: string[];
  staleValidationRefs: string[];
  nextApprovalRefs: string[];
  preferenceDriftRefs: string[];
  blindSpotRefs: string[];
  replayTraceRefs: string[];
  evidenceRefs: string[];
  signals: AoiMissionMemorySignal[];
  updatedAt: number;
  expiresAt?: number;
  freshness: AoiMissionMemoryFreshness;
  needsRefresh: boolean;
  mutationCount: 0;
}

export interface AoiMissionMemoryReport {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  snapshots: AoiMissionMemorySnapshot[];
  activeSnapshot?: AoiMissionMemorySnapshot;
  staleSnapshotCount: number;
  expiredSnapshotCount: number;
  evidenceRefs: string[];
  warnings: string[];
  mutationCount: 0;
}

export interface AoiMissionMemorySnapshotInput {
  sessionPath: string;
  mission?: AoiMissionState | null;
  goals?: AoiGoal[];
  relationIndex?: AoiRelationIndex | null;
  timelineEvents?: AoiOperatorTimelineEvent[];
  workspaceSnapshot?: AoiWorkspaceSnapshot | null;
  playbooks?: AoiPlaybook[];
  approvedCommandPolicies?: AoiApprovedCommandPolicy[];
  health?: AoiOperatorHealthState | null;
  trustCalibration?: AoiTrustCalibrationProfile | null;
  shadowReport?: AoiShadowDecisionReport | null;
  traceExportRefs?: string[];
  previousSnapshot?: AoiMissionMemorySnapshot | null;
  now?: number;
  ttlMs?: number;
}

export interface AoiMissionMemoryReportInput {
  sessionPath: string;
  snapshots: AoiMissionMemorySnapshot[];
  now?: number;
}

export interface AoiMissionMemoryDashboardContext {
  currentBriefLabel: string;
  freshnessLabel: string;
  nextSafeActionLabel: string;
  boundaryLabel: string;
  blindSpotLabels: string[];
  pendingApprovalLabels: string[];
  blockedReasonLabels: string[];
  evidenceRefs: string[];
}

export interface AoiMissionMemoryEvaluationMetric {
  version: 1;
  id: 'resume_after_session_gap' | 'stale_validation_detected' | 'pending_external_preserved';
  passed: boolean;
  summary: string;
  evidenceRefs: string[];
}

export interface AoiMissionMemoryEvaluationReport {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  passed: boolean;
  metrics: AoiMissionMemoryEvaluationMetric[];
  evidenceRefs: string[];
  mutationCount: 0;
}

export interface AoiMissionMemoryEvaluationInput {
  sessionPath: string;
  beforeSnapshot?: AoiMissionMemorySnapshot | null;
  afterSnapshot: AoiMissionMemorySnapshot;
  now?: number;
}

interface SignalDraft {
  kind: AoiMissionMemorySignalKind;
  label: string;
  summary: string;
  refs: string[];
  evidenceRefs: string[];
  freshness?: AoiMissionMemoryFreshness;
}

interface DerivedMissionMemoryRefs {
  stateEvidenceRefs: string[];
  pendingExternalRefs: string[];
  staleValidationRefs: string[];
  nextApprovalRefs: string[];
  preferenceDriftRefs: string[];
  blindSpotRefs: string[];
  replayTraceRefs: string[];
  evidenceRefs: string[];
  hasValidationRefreshEvidence: boolean;
  hasBlindSpotRefreshEvidence: boolean;
  hasPreferenceRefreshEvidence: boolean;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeMemoryText(value: string, maxLength = MAX_TEXT): string {
  const compact = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value))
      .replace(WINDOWS_PRIVATE_PATH_PATTERN, '[local path]')
      .replace(UNIX_PRIVATE_PATH_PATTERN, '[local path]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[private email]')
      .replace(/https?:\/\/[^\s'"`<>]+/gi, '[external url]'),
  );
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function normalizeSessionPath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (
    normalized &&
    !normalized.includes('..') &&
    /^[a-zA-Z0-9._/-]+$/.test(normalized) &&
    normalized.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
  ) {
    return normalized;
  }
  const safe = sanitizeMemoryText(value, 160)
    .replace(/[^A-Za-z0-9._/-]/g, '_')
    .replace(/^\/+|\/+$/g, '');
  return safe || 'default';
}

function hashValues(values: string[]): string {
  const joined = values.join('\n');
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < joined.length; index += 1) {
    const code = joined.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193) >>> 0;
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function uniqueRefs(values: Array<string | undefined | null>, maxItems = MAX_REFS): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const sanitized = sanitizeMemoryText(String(value ?? ''), 180);
    if (!sanitized || seen.has(sanitized)) {
      continue;
    }
    seen.add(sanitized);
    refs.push(sanitized);
    if (refs.length >= maxItems) {
      break;
    }
  }
  return refs;
}

function collectMissionSourceRefs(mission: AoiMissionState | null | undefined): string[] {
  if (!mission) {
    return [];
  }
  return uniqueRefs([
    mission.activeGoalId ? `goal:${mission.activeGoalId}` : undefined,
    mission.lastMeaningfulEventRef,
    mission.nextRecommendedAction.ref,
    ...Object.values(mission.sourceRefs),
    ...mission.transitions.flatMap((transition) => transition.evidenceRefs),
    ...mission.evidenceRefs,
  ]);
}

function collectRelationRefs(
  index: AoiRelationIndex | null | undefined,
  missionId: string,
): string[] {
  if (!index) {
    return [];
  }
  const missionNodes = index.nodes.filter(
    (node) =>
      node.ref === missionId ||
      node.ref === `mission:${missionId}` ||
      node.ref === `goal:${missionId}` ||
      node.id === missionId,
  );
  const nodeIds = new Set(missionNodes.map((node) => node.id));
  const edgeRefs = index.edges
    .filter((edge) => nodeIds.has(edge.from) || nodeIds.has(edge.to))
    .flatMap((edge) => edge.evidenceRefs);
  return uniqueRefs([...missionNodes.map((node) => node.ref), ...edgeRefs]);
}

function deriveMissionId(input: AoiMissionMemorySnapshotInput, sessionPath: string): string {
  if (input.mission?.activeGoalId) {
    return `goal:${input.mission.activeGoalId}`;
  }
  if (input.previousSnapshot?.missionId) {
    return input.previousSnapshot.missionId;
  }
  const activeGoal = input.goals?.find((goal) => goal.status === 'active');
  if (activeGoal) {
    return `goal:${activeGoal.id}`;
  }
  const firstGoal = input.goals?.[0];
  if (firstGoal) {
    return `goal:${firstGoal.id}`;
  }
  return `mission:${hashValues([sessionPath])}`;
}

function deriveLastKnownState(
  input: AoiMissionMemorySnapshotInput,
  stateEvidenceRefs: string[],
): string {
  if (input.mission && stateEvidenceRefs.length > 0) {
    const next = input.mission.nextRecommendedAction.label || 'no recommended action';
    return sanitizeMemoryText(
      `${input.mission.status}: ${input.mission.focusSummary}; next ${next}`,
    );
  }
  if (input.previousSnapshot?.lastKnownState) {
    return sanitizeMemoryText(input.previousSnapshot.lastKnownState);
  }
  return 'Mission state unknown; refresh required before action.';
}

function collectPendingExternalRefs(
  mission: AoiMissionState | null | undefined,
  playbooks: AoiPlaybook[] | undefined,
  timelineEvents: AoiOperatorTimelineEvent[] | undefined,
): string[] {
  const missionRefs =
    mission && (mission.waitingOn === 'kira' || mission.waitingOn === 'research')
      ? [
          mission.lastMeaningfulEventRef,
          mission.sourceRefs.kiraWorkRef,
          mission.sourceRefs.researchRunRef,
          mission.sourceRefs.validationRef,
          mission.activeGoalId ? `goal:${mission.activeGoalId}` : undefined,
        ]
      : [];
  const playbookRefs =
    playbooks?.flatMap((playbook) =>
      playbook.steps
        .filter((step) => step.status === 'waiting_for_external_event')
        .flatMap((step) => [
          `playbook:${playbook.id}`,
          `playbook-step:${step.id}`,
          step.refs.kiraWorkRef,
          step.refs.researchRunRef,
          step.refs.researchArtifactRef,
          step.refs.timelineEventRef,
          ...step.evidenceRefs,
        ]),
    ) ?? [];
  const timelineRefs =
    timelineEvents
      ?.filter(
        (event) =>
          event.kind === 'mission_state_changed' ||
          /waiting|external|kira|research/i.test(`${event.title} ${event.summary}`),
      )
      .filter((event) => /waiting|external|kira|research/i.test(`${event.title} ${event.summary}`))
      .flatMap((event) => [`timeline:${event.id}`, ...event.evidenceRefs, ...event.relatedRefs]) ??
    [];
  return uniqueRefs([...missionRefs, ...playbookRefs, ...timelineRefs]);
}

function collectStaleValidationRefs(
  workspaceSnapshot: AoiWorkspaceSnapshot | null | undefined,
  mission: AoiMissionState | null | undefined,
  health: AoiOperatorHealthState | null | undefined,
  timelineEvents: AoiOperatorTimelineEvent[] | undefined,
): string[] {
  const workspaceValidationFresh =
    workspaceSnapshot?.validation.freshness === 'fresh' &&
    workspaceSnapshot.validation.result === 'passed';
  const workspaceRefs =
    workspaceSnapshot &&
    (workspaceSnapshot.validation.freshness === 'stale' ||
      workspaceSnapshot.validation.freshness === 'failed' ||
      workspaceSnapshot.validation.result === 'failed')
      ? [
          'workspace-validation',
          workspaceSnapshot.validation.command,
          workspaceSnapshot.validation.staleReason,
          ...workspaceSnapshot.validation.evidenceRefs,
          ...workspaceSnapshot.evidenceRefs,
        ]
      : [];
  const missionValidationLooksStale =
    mission &&
    /stale|refresh|validation/i.test(
      `${mission.nextRecommendedAction.kind} ${mission.nextRecommendedAction.label} ${mission.nextRecommendedAction.reason}`,
    );
  const missionRefs =
    !workspaceValidationFresh && mission?.sourceRefs.validationRef && missionValidationLooksStale
      ? [mission.sourceRefs.validationRef]
      : [];
  const issueRefs =
    health?.issues
      .filter((issue) => /validation|stale|failed/i.test(`${issue.code} ${issue.summary}`))
      .flatMap((issue) => [`health:${issue.id}`, ...issue.evidenceRefs]) ?? [];
  const timelineRefs =
    timelineEvents
      ?.filter((event) => /validation|stale|failed/i.test(`${event.title} ${event.summary}`))
      .flatMap((event) => [`timeline:${event.id}`, ...event.evidenceRefs]) ?? [];
  return uniqueRefs([...workspaceRefs, ...missionRefs, ...issueRefs, ...timelineRefs]);
}

function collectNextApprovalRefs(
  policies: AoiApprovedCommandPolicy[] | undefined,
  playbooks: AoiPlaybook[] | undefined,
  now: number,
): string[] {
  const policyRefs =
    policies
      ?.filter((policy) => policy.expiresAt > now)
      .flatMap((policy) => [
        `command-approval:${policy.approvalFingerprint}`,
        policy.allowed ? `approved-command:${policy.approvalFingerprint}` : undefined,
        policy.cwdLabel,
      ]) ?? [];
  const playbookRefs =
    playbooks?.flatMap((playbook) =>
      playbook.steps
        .filter(
          (step) =>
            step.status === 'waiting_for_approval' || step.executionBoundary.requiresApproval,
        )
        .flatMap((step) => [
          `playbook:${playbook.id}`,
          `playbook-step:${step.id}`,
          step.executionBoundary.approvalRef,
          ...step.evidenceRefs,
        ]),
    ) ?? [];
  return uniqueRefs([...policyRefs, ...playbookRefs]);
}

function collectPreferenceDriftRefs(
  profile: AoiTrustCalibrationProfile | null | undefined,
): string[] {
  if (!profile) {
    return [];
  }
  return uniqueRefs([
    ...profile.recentChanges
      .filter((change) => change.direction === 'negative' || change.direction === 'safety')
      .flatMap((change) => [
        `trust-calibration:${change.id}`,
        `${change.dimension}:${change.key}`,
        ...change.evidenceRefs,
      ]),
    ...profile.topSuppressedCategories.flatMap((evidence) => [
      `trust-calibration:${evidence.id}`,
      `${evidence.dimension}:${evidence.key}`,
      ...evidence.evidenceRefs,
    ]),
    ...profile.negativeSources.flatMap((source) => [
      `source-calibration:${source.sourceKind}`,
      ...source.evidenceRefs,
    ]),
  ]);
}

function isBlindSpotIssue(issue: AoiOperatorHealthIssue): boolean {
  return (
    issue.severity !== 'info' ||
    Boolean(issue.cannotKnow) ||
    /disabled|disconnected|revoked|stale|degraded|missing|unknown/i.test(issue.code)
  );
}

function collectBlindSpotRefs(
  health: AoiOperatorHealthState | null | undefined,
  timelineEvents: AoiOperatorTimelineEvent[] | undefined,
): string[] {
  const issueRefs =
    health?.issues
      .filter(isBlindSpotIssue)
      .flatMap((issue) => [`health:${issue.id}`, ...issue.evidenceRefs]) ?? [];
  const timelineRefs =
    timelineEvents
      ?.filter((event) =>
        /blind|disabled|disconnected|revoked|stale|degraded|cannot know|unknown/i.test(
          `${event.title} ${event.summary}`,
        ),
      )
      .flatMap((event) => [`timeline:${event.id}`, ...event.evidenceRefs]) ?? [];
  return uniqueRefs([...issueRefs, ...timelineRefs]);
}

function collectReplayTraceRefs(
  shadowReport: AoiShadowDecisionReport | null | undefined,
  traceExportRefs: string[] | undefined,
  timelineEvents: AoiOperatorTimelineEvent[] | undefined,
): string[] {
  const shadowRefs = shadowReport
    ? [
        'shadow-report',
        ...shadowReport.evidenceRefs,
        ...shadowReport.decisions.flatMap((decision) => [
          `shadow-decision:${decision.id}`,
          ...decision.evidenceRefs,
        ]),
        ...shadowReport.labels.flatMap((label) => [
          `shadow-label:${label.id}`,
          ...label.evidenceRefs,
        ]),
      ]
    : [];
  const timelineRefs =
    timelineEvents
      ?.filter((event) => /trace|replay|shadow|fixture/i.test(`${event.title} ${event.summary}`))
      .flatMap((event) => [`timeline:${event.id}`, ...event.evidenceRefs]) ?? [];
  return uniqueRefs([...(traceExportRefs ?? []), ...shadowRefs, ...timelineRefs]);
}

function deriveRefs(
  input: AoiMissionMemorySnapshotInput,
  missionId: string,
  now: number,
): DerivedMissionMemoryRefs {
  const stateEvidenceRefs = uniqueRefs([
    ...collectMissionSourceRefs(input.mission),
    ...collectRelationRefs(input.relationIndex, missionId),
    ...(input.goals?.flatMap((goal) =>
      goal.id === input.mission?.activeGoalId
        ? [`goal:${goal.id}`, ...goal.sourceRefs, ...goal.plan.sourceRefs]
        : [],
    ) ?? []),
  ]);
  const pendingExternalRefs = collectPendingExternalRefs(
    input.mission,
    input.playbooks,
    input.timelineEvents,
  );
  const staleValidationRefs = collectStaleValidationRefs(
    input.workspaceSnapshot,
    input.mission,
    input.health,
    input.timelineEvents,
  );
  const nextApprovalRefs = collectNextApprovalRefs(
    input.approvedCommandPolicies,
    input.playbooks,
    now,
  );
  const preferenceDriftRefs = collectPreferenceDriftRefs(input.trustCalibration);
  const blindSpotRefs = collectBlindSpotRefs(input.health, input.timelineEvents);
  const replayTraceRefs = collectReplayTraceRefs(
    input.shadowReport,
    input.traceExportRefs,
    input.timelineEvents,
  );
  const workspaceEvidence = input.workspaceSnapshot
    ? [...input.workspaceSnapshot.evidenceRefs, ...input.workspaceSnapshot.validation.evidenceRefs]
    : [];
  const healthEvidence = input.health ? input.health.evidenceRefs : [];
  const calibrationEvidence = input.trustCalibration
    ? input.trustCalibration.recentChanges.flatMap((change) => change.evidenceRefs)
    : [];

  return {
    stateEvidenceRefs,
    pendingExternalRefs,
    staleValidationRefs,
    nextApprovalRefs,
    preferenceDriftRefs,
    blindSpotRefs,
    replayTraceRefs,
    evidenceRefs: uniqueRefs([
      ...stateEvidenceRefs,
      ...pendingExternalRefs,
      ...staleValidationRefs,
      ...nextApprovalRefs,
      ...preferenceDriftRefs,
      ...blindSpotRefs,
      ...replayTraceRefs,
      ...workspaceEvidence,
      ...healthEvidence,
      ...calibrationEvidence,
    ]),
    hasValidationRefreshEvidence: workspaceEvidence.length > 0,
    hasBlindSpotRefreshEvidence: Boolean(input.health) || Boolean(input.timelineEvents?.length),
    hasPreferenceRefreshEvidence: Boolean(input.trustCalibration),
  };
}

function preserveRefs(
  currentRefs: string[],
  previousRefs: string[] | undefined,
  hasRefreshEvidence: boolean,
  previousExpired: boolean,
): string[] {
  if (currentRefs.length > 0) {
    return currentRefs;
  }
  if (hasRefreshEvidence && !previousExpired) {
    return [];
  }
  return uniqueRefs(previousRefs ?? []);
}

function buildSignal(
  draft: SignalDraft,
  missionId: string,
  sessionPath: string,
  observedAt: number,
  snapshotFreshness: AoiMissionMemoryFreshness,
): AoiMissionMemorySignal {
  const refs = uniqueRefs(draft.refs);
  const evidenceRefs = uniqueRefs(draft.evidenceRefs.length > 0 ? draft.evidenceRefs : refs);
  return {
    version: 1,
    id: `mission-memory-signal:${hashValues([
      missionId,
      draft.kind,
      draft.label,
      ...refs,
      ...evidenceRefs,
    ])}`,
    missionId,
    sessionPath,
    kind: draft.kind,
    label: sanitizeMemoryText(draft.label, 140),
    summary: sanitizeMemoryText(draft.summary, MAX_TEXT),
    refs,
    evidenceRefs,
    observedAt,
    freshness: draft.freshness ?? snapshotFreshness,
    mutationCount: 0,
  };
}

function buildSignals(params: {
  snapshot: Omit<AoiMissionMemorySnapshot, 'signals'>;
  stateEvidenceRefs: string[];
  now: number;
}): AoiMissionMemorySignal[] {
  const { snapshot, stateEvidenceRefs, now } = params;
  const drafts: SignalDraft[] = [];
  drafts.push({
    kind: 'last_known_state',
    label: 'Last known mission state',
    summary: snapshot.lastKnownState,
    refs: stateEvidenceRefs.length > 0 ? stateEvidenceRefs : snapshot.evidenceRefs,
    evidenceRefs: stateEvidenceRefs.length > 0 ? stateEvidenceRefs : snapshot.evidenceRefs,
  });
  if (snapshot.pendingExternalRefs.length > 0) {
    drafts.push({
      kind: 'pending_external_event',
      label: 'Waiting for external mission evidence',
      summary: 'External Kira, research, or trace evidence is pending; do not infer completion.',
      refs: snapshot.pendingExternalRefs,
      evidenceRefs: snapshot.pendingExternalRefs,
    });
  }
  if (snapshot.staleValidationRefs.length > 0) {
    drafts.push({
      kind: 'stale_validation',
      label: 'Validation is stale or failed',
      summary: 'Workspace validation must be refreshed before action confidence can increase.',
      refs: snapshot.staleValidationRefs,
      evidenceRefs: snapshot.staleValidationRefs,
      freshness: 'stale',
    });
  }
  if (snapshot.nextApprovalRefs.length > 0) {
    drafts.push({
      kind: 'next_approval',
      label: 'User approval is required or pending',
      summary:
        'Approval state is remembered across session gaps but still requires fresh user authority.',
      refs: snapshot.nextApprovalRefs,
      evidenceRefs: snapshot.nextApprovalRefs,
    });
  }
  if (snapshot.preferenceDriftRefs.length > 0) {
    drafts.push({
      kind: 'preference_drift',
      label: 'Recent preference drift observed',
      summary:
        'Calibration signal only; safety rules and project instructions remain higher priority.',
      refs: snapshot.preferenceDriftRefs,
      evidenceRefs: snapshot.preferenceDriftRefs,
    });
  }
  if (snapshot.blindSpotRefs.length > 0) {
    drafts.push({
      kind: 'blind_spot',
      label: 'Mission blind spot needs operator attention',
      summary:
        'Some source, health, or consent evidence is missing, stale, disabled, or unknowable.',
      refs: snapshot.blindSpotRefs,
      evidenceRefs: snapshot.blindSpotRefs,
    });
  }
  if (snapshot.replayTraceRefs.length > 0) {
    drafts.push({
      kind: 'replay_trace_evidence',
      label: 'Replay or shadow trace evidence linked',
      summary: 'Mission memory can be evaluated against replay, trace, or shadow-mode evidence.',
      refs: snapshot.replayTraceRefs,
      evidenceRefs: snapshot.replayTraceRefs,
    });
  }
  if (snapshot.needsRefresh) {
    drafts.push({
      kind: 'needs_refresh',
      label: 'Mission memory needs refresh',
      summary: 'Snapshot is stale or expired; preserve it as context, not as execution authority.',
      refs: snapshot.evidenceRefs,
      evidenceRefs: snapshot.evidenceRefs,
      freshness: snapshot.freshness,
    });
  }
  return drafts.map((draft) =>
    buildSignal(draft, snapshot.missionId, snapshot.sessionPath, now, snapshot.freshness),
  );
}

export function buildAoiMissionMemorySnapshot(
  input: AoiMissionMemorySnapshotInput,
): AoiMissionMemorySnapshot {
  const now = input.now ?? Date.now();
  const sessionPath = normalizeSessionPath(input.sessionPath);
  const missionId = deriveMissionId(input, sessionPath);
  const ttlMs = Math.max(1, input.ttlMs ?? DEFAULT_MISSION_MEMORY_TTL_MS);
  const previous = input.previousSnapshot;
  const previousExpired = Boolean(previous?.expiresAt && now > previous.expiresAt);
  const derived = deriveRefs(input, missionId, now);
  const hasStateEvidence = derived.stateEvidenceRefs.length > 0;
  const hasAnyNewEvidence = derived.evidenceRefs.length > 0;
  const pendingExternalRefs = preserveRefs(
    derived.pendingExternalRefs,
    previous?.pendingExternalRefs,
    derived.pendingExternalRefs.length > 0,
    previousExpired,
  );
  const staleValidationRefs = preserveRefs(
    derived.staleValidationRefs,
    previous?.staleValidationRefs,
    derived.hasValidationRefreshEvidence,
    previousExpired,
  );
  const nextApprovalRefs = preserveRefs(
    derived.nextApprovalRefs,
    previous?.nextApprovalRefs,
    derived.nextApprovalRefs.length > 0,
    previousExpired,
  );
  const preferenceDriftRefs = preserveRefs(
    derived.preferenceDriftRefs,
    previous?.preferenceDriftRefs,
    derived.hasPreferenceRefreshEvidence,
    previousExpired,
  );
  const blindSpotRefs = preserveRefs(
    derived.blindSpotRefs,
    previous?.blindSpotRefs,
    derived.hasBlindSpotRefreshEvidence,
    previousExpired,
  );
  const replayTraceRefs = preserveRefs(
    derived.replayTraceRefs,
    previous?.replayTraceRefs,
    derived.replayTraceRefs.length > 0,
    previousExpired,
  );
  const evidenceRefs = uniqueRefs([
    ...derived.evidenceRefs,
    ...(hasAnyNewEvidence ? [] : (previous?.evidenceRefs ?? [])),
    ...(previousExpired ? [`expired-at:${previous?.expiresAt ?? now}`] : []),
  ]);
  const lastKnownState = deriveLastKnownState(input, derived.stateEvidenceRefs);
  const freshness: AoiMissionMemoryFreshness = previousExpired
    ? 'expired'
    : !hasAnyNewEvidence && previous
      ? 'stale'
      : staleValidationRefs.length > 0
        ? 'stale'
        : hasStateEvidence || hasAnyNewEvidence
          ? 'fresh'
          : 'unknown';
  const needsRefresh =
    freshness === 'expired' ||
    freshness === 'unknown' ||
    (!hasAnyNewEvidence && Boolean(previous)) ||
    staleValidationRefs.length > 0;
  const expiresAt = hasAnyNewEvidence ? now + ttlMs : previous?.expiresAt;
  const snapshotBase: Omit<AoiMissionMemorySnapshot, 'signals'> = {
    version: 1,
    id: `mission-memory:${hashValues([sessionPath, missionId])}`,
    missionId,
    sessionPath,
    lastKnownState,
    pendingExternalRefs,
    staleValidationRefs,
    nextApprovalRefs,
    preferenceDriftRefs,
    blindSpotRefs,
    replayTraceRefs,
    evidenceRefs,
    updatedAt: now,
    freshness,
    needsRefresh,
    mutationCount: 0,
  };
  if (expiresAt !== undefined) {
    snapshotBase.expiresAt = expiresAt;
  }

  return {
    ...snapshotBase,
    signals: buildSignals({
      snapshot: snapshotBase,
      stateEvidenceRefs: derived.stateEvidenceRefs,
      now,
    }),
  };
}

export function buildAoiMissionMemoryReport(
  input: AoiMissionMemoryReportInput,
): AoiMissionMemoryReport {
  const now = input.now ?? Date.now();
  const sessionPath = normalizeSessionPath(input.sessionPath);
  const snapshots = [...input.snapshots].sort((left, right) => right.updatedAt - left.updatedAt);
  const activeSnapshot =
    snapshots.find((snapshot) => snapshot.freshness !== 'expired') ?? snapshots[0];
  const staleSnapshotCount = snapshots.filter((snapshot) => snapshot.freshness === 'stale').length;
  const expiredSnapshotCount = snapshots.filter(
    (snapshot) => snapshot.freshness === 'expired',
  ).length;
  const warnings = uniqueRefs(
    snapshots
      .filter((snapshot) => snapshot.needsRefresh)
      .map(
        (snapshot) =>
          `${snapshot.missionId}: ${snapshot.freshness} mission memory needs evidence refresh`,
      ),
    8,
  );
  const report: AoiMissionMemoryReport = {
    version: 1,
    id: `mission-memory-report:${hashValues([
      sessionPath,
      String(now),
      ...snapshots.map((item) => item.id),
    ])}`,
    sessionPath,
    generatedAt: now,
    snapshots,
    staleSnapshotCount,
    expiredSnapshotCount,
    evidenceRefs: uniqueRefs(snapshots.flatMap((snapshot) => snapshot.evidenceRefs)),
    warnings,
    mutationCount: 0,
  };
  if (activeSnapshot) {
    report.activeSnapshot = activeSnapshot;
  }
  return report;
}

export function buildAoiMissionMemoryDashboardContext(
  snapshot: AoiMissionMemorySnapshot | null | undefined,
): AoiMissionMemoryDashboardContext | null {
  if (!snapshot) {
    return null;
  }
  const pendingExternal = snapshot.signals.filter(
    (signal) => signal.kind === 'pending_external_event',
  );
  const staleValidation = snapshot.signals.filter((signal) => signal.kind === 'stale_validation');
  const blindSpots = snapshot.signals.filter(
    (signal) =>
      signal.kind === 'blind_spot' ||
      signal.kind === 'stale_validation' ||
      signal.kind === 'needs_refresh',
  );
  const approvals = snapshot.signals.filter((signal) => signal.kind === 'next_approval');
  const nextSafeActionLabel =
    pendingExternal.length > 0
      ? 'Wait for external evidence before proposing execution.'
      : staleValidation.length > 0
        ? 'Refresh validation evidence before raising mission confidence.'
        : approvals.length > 0
          ? 'Ask the user to renew or confirm the pending approval.'
          : snapshot.needsRefresh
            ? 'Refresh mission evidence before making a new recommendation.'
            : 'Continue from the last known mission state.';
  const blockedReasonLabels = uniqueRefs(
    [
      ...(pendingExternal.length > 0 ? ['pending external evidence'] : []),
      ...(staleValidation.length > 0 ? ['stale validation evidence'] : []),
      ...(snapshot.freshness === 'expired' ? ['mission memory expired'] : []),
      ...(snapshot.needsRefresh ? ['needs refresh before execution authority'] : []),
    ],
    8,
  );

  return {
    currentBriefLabel: sanitizeMemoryText(snapshot.lastKnownState, 180),
    freshnessLabel: snapshot.needsRefresh
      ? `${snapshot.freshness}; refresh required`
      : snapshot.freshness,
    nextSafeActionLabel,
    boundaryLabel:
      'Mission memory is display-only context; pending or stale refs cannot authorize execution.',
    blindSpotLabels: uniqueRefs(
      blindSpots.map((signal) => `${signal.label}: ${signal.summary}`),
      8,
    ),
    pendingApprovalLabels: uniqueRefs(
      approvals.flatMap((signal) => [
        `${signal.label}: ${signal.summary}`,
        ...signal.refs.map((ref) => `approval ref ${ref}`),
      ]),
      8,
    ),
    blockedReasonLabels,
    evidenceRefs: uniqueRefs(snapshot.evidenceRefs),
  };
}

export function buildAoiMissionMemoryEvaluationReport(
  input: AoiMissionMemoryEvaluationInput,
): AoiMissionMemoryEvaluationReport {
  const now = input.now ?? Date.now();
  const sessionPath = normalizeSessionPath(input.sessionPath);
  const before = input.beforeSnapshot;
  const after = input.afterSnapshot;
  const resumeAfterGapPassed = before
    ? after.missionId === before.missionId &&
      after.lastKnownState === before.lastKnownState &&
      after.evidenceRefs.length > 0
    : after.evidenceRefs.length > 0;
  const staleValidationPassed =
    after.staleValidationRefs.length > 0 || after.freshness === 'expired' || after.needsRefresh;
  const pendingExternalPassed = before?.pendingExternalRefs.length
    ? before.pendingExternalRefs.every((ref) => after.pendingExternalRefs.includes(ref))
    : after.pendingExternalRefs.length > 0;
  const metrics: AoiMissionMemoryEvaluationMetric[] = [
    {
      version: 1,
      id: 'resume_after_session_gap',
      passed: resumeAfterGapPassed,
      summary: resumeAfterGapPassed
        ? 'Mission state survived the session gap with evidence refs.'
        : 'Mission state did not preserve enough evidence after the session gap.',
      evidenceRefs: uniqueRefs([...(before?.evidenceRefs ?? []), ...after.evidenceRefs]),
    },
    {
      version: 1,
      id: 'stale_validation_detected',
      passed: staleValidationPassed,
      summary: staleValidationPassed
        ? 'Stale, expired, or refresh-required validation state is visible.'
        : 'Mission memory did not surface stale validation risk.',
      evidenceRefs: uniqueRefs(after.staleValidationRefs),
    },
    {
      version: 1,
      id: 'pending_external_preserved',
      passed: pendingExternalPassed,
      summary: pendingExternalPassed
        ? 'Pending external event evidence is preserved.'
        : 'Pending external event evidence was lost.',
      evidenceRefs: uniqueRefs(after.pendingExternalRefs),
    },
  ];

  return {
    version: 1,
    id: `mission-memory-eval:${hashValues([sessionPath, after.id, String(now)])}`,
    sessionPath,
    generatedAt: now,
    passed: metrics.every((metric) => metric.passed),
    metrics,
    evidenceRefs: uniqueRefs(metrics.flatMap((metric) => metric.evidenceRefs)),
    mutationCount: 0,
  };
}
