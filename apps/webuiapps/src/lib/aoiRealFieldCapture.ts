import { buildAoiFieldShadowDecisionBridge } from './aoiFieldShadowDecisionBridge';
import {
  buildAoiFieldEventFromSignal,
  buildAoiFieldLedgerSummary,
  normalizeAoiFieldEvent,
  type AoiFieldEvent,
  type AoiFieldEventCategory,
} from './aoiFieldEventLedger';
import {
  buildAoiFieldSignalPacket,
  buildAoiFieldSignalPackets,
  sanitizeAoiFieldSignalText,
  type AoiFieldSignalBodyAccess,
  type AoiFieldSignalConsentState,
  type AoiFieldSignalPacket,
  type AoiFieldSignalSourceKind,
} from './aoiFieldSignalBridge';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomySessionPath';
import type { AoiProactiveBriefScoutSourceHonestyRecord } from './aoiProactiveBriefScout';
import type { AoiSourceFreshnessContract } from './aoiSourceFreshnessContract';
import type {
  AoiActionLadderDecision,
  AoiDeliberationRun,
  AoiInterruptionGovernorDecision,
  AoiMissionState,
  AoiOperatorTimelineEvent,
  AoiOpportunity,
  AoiSignalFreshness,
} from './aoiAutonomyTypes';
import type { AoiShadowDecision } from './aoiShadowModeEvaluation';

export type AoiRealFieldSourceHonestyKind =
  | AoiFieldSignalSourceKind
  | 'source_freshness'
  | 'proactive_scout'
  | 'mission'
  | 'timeline';

export type AoiRealFieldSourceHonestyStatus =
  | 'current_claim_allowed'
  | 'blind_spot'
  | 'blocked'
  | 'metadata_only'
  | 'stale'
  | 'failed'
  | 'unknown';

export interface AoiRealFieldSourceHonestyRecord {
  version: 1;
  id: string;
  sessionPath: string;
  sourceKind: AoiRealFieldSourceHonestyKind;
  sourceId: string;
  sourceLabel: string;
  status: AoiRealFieldSourceHonestyStatus;
  freshness: AoiSignalFreshness;
  consentState: AoiFieldSignalConsentState | 'not_required';
  bodyAccess: AoiFieldSignalBodyAccess | 'not_applicable';
  currentClaimAllowed: boolean;
  currentClaimBlockedReasons: string[];
  cannotKnow: string[];
  evidenceRefs: string[];
  createdAt: number;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiRealFieldCaptureLiveOperationCounts {
  shell: number;
  network: number;
  gmail: number;
  calendar: number;
  kiraMutation: number;
}

export interface AoiRealFieldCaptureSummary {
  version: 1;
  statusLabel: string;
  signalLabels: string[];
  blindSpotLabels: string[];
  whyQuietLabels: string[];
  sourceHonestyLabels: string[];
  hardFailLabels: string[];
  evidenceRefs: string[];
}

export interface AoiRealFieldCaptureInput {
  sessionPath: string;
  now?: number;
  workspaceSnapshots?: Parameters<typeof buildAoiFieldSignalPackets>[0]['workspaceSnapshots'];
  researchSignals?: Parameters<typeof buildAoiFieldSignalPackets>[0]['researchSignals'];
  kiraOutcomes?: Parameters<typeof buildAoiFieldSignalPackets>[0]['kiraOutcomes'];
  appStateSignals?: Parameters<typeof buildAoiFieldSignalPackets>[0]['appStateSignals'];
  personalMetadataSources?: Parameters<
    typeof buildAoiFieldSignalPackets
  >[0]['personalMetadataSources'];
  memorySignals?: Parameters<typeof buildAoiFieldSignalPackets>[0]['memorySignals'];
  manualSignals?: Parameters<typeof buildAoiFieldSignalPackets>[0]['manualSignals'];
  sourceFreshnessContracts?: readonly AoiSourceFreshnessContract[];
  mission?: AoiMissionState | null;
  timelineEvents?: readonly AoiOperatorTimelineEvent[];
  opportunities?: readonly AoiOpportunity[];
  interruptionDecisions?: readonly AoiInterruptionGovernorDecision[];
  actionLadderDecisions?: readonly AoiActionLadderDecision[];
  deliberationRuns?: readonly AoiDeliberationRun[];
  scoutSourceHonestyRecords?: readonly AoiProactiveBriefScoutSourceHonestyRecord[];
  scoutFieldEvents?: readonly AoiFieldEvent[];
}

export interface AoiRealFieldCaptureResult {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  fieldSignals: AoiFieldSignalPacket[];
  fieldEvents: AoiFieldEvent[];
  timelineEvents: AoiOperatorTimelineEvent[];
  shadowDecisions: AoiShadowDecision[];
  sourceHonestyRecords: AoiRealFieldSourceHonestyRecord[];
  cannotKnow: string[];
  whyQuiet: string[];
  privateLeakCount: number;
  unauthorizedMutationCount: number;
  staleCurrentClaimCount: number;
  mutationCount: 0;
  liveOperationCounts: AoiRealFieldCaptureLiveOperationCounts;
  summary: AoiRealFieldCaptureSummary;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
}

const MAX_REFS = 32;
const LIVE_OPERATION_COUNTS_ZERO: AoiRealFieldCaptureLiveOperationCounts = {
  shell: 0,
  network: 0,
  gmail: 0,
  calendar: 0,
  kiraMutation: 0,
};

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 12);
}

function normalizeText(value: unknown, maxChars = 220): string {
  return sanitizeAoiFieldSignalText(value, maxChars);
}

function uniqueStrings(values: readonly unknown[], limit = MAX_REFS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value, 240);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function countPrivateLeaks(value: unknown): number {
  const text = (JSON.stringify(value) ?? '').replace(/\\\\/g, '\\');
  const matches = text.match(
    /\b[A-Za-z]:\\Users\\|\\\\[^"'\\]+\\[^"']+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:token|secret|api[_ -]?key|access[_ -]?token)\s*[:=]?\s*[A-Za-z0-9_=-]{16,}/gi,
  );
  return matches?.length ?? 0;
}

function isCurrentClaimAllowed(params: {
  freshness: AoiSignalFreshness;
  consentState: AoiFieldSignalConsentState | 'not_required';
  bodyAccess: AoiFieldSignalBodyAccess | 'not_applicable';
  cannotKnow: readonly string[];
}): boolean {
  return (
    params.freshness === 'fresh' &&
    params.cannotKnow.length === 0 &&
    params.consentState !== 'disabled' &&
    params.consentState !== 'revoked' &&
    params.consentState !== 'disconnected' &&
    params.consentState !== 'unknown'
  );
}

function blockedReasonsFor(params: {
  freshness: AoiSignalFreshness;
  consentState: AoiFieldSignalConsentState | 'not_required';
  bodyAccess: AoiFieldSignalBodyAccess | 'not_applicable';
  cannotKnow: readonly string[];
}): string[] {
  return uniqueStrings([
    ...(params.freshness !== 'fresh' ? [`freshness:${params.freshness}`] : []),
    ...(params.consentState === 'disabled' ||
    params.consentState === 'revoked' ||
    params.consentState === 'disconnected' ||
    params.consentState === 'unknown'
      ? [`consent:${params.consentState}`]
      : []),
    ...(params.bodyAccess === 'none' || params.bodyAccess === 'metadata_only'
      ? ['body:not_read']
      : []),
    ...params.cannotKnow,
  ]);
}

function honestyStatus(params: {
  freshness: AoiSignalFreshness;
  currentClaimAllowed: boolean;
  consentState: AoiFieldSignalConsentState | 'not_required';
  cannotKnow: readonly string[];
}): AoiRealFieldSourceHonestyStatus {
  if (params.currentClaimAllowed) {
    return 'current_claim_allowed';
  }
  if (params.freshness === 'failed') {
    return 'failed';
  }
  if (params.freshness === 'stale') {
    return 'stale';
  }
  if (
    params.consentState === 'disabled' ||
    params.consentState === 'revoked' ||
    params.consentState === 'disconnected' ||
    params.consentState === 'unknown' ||
    params.cannotKnow.length > 0
  ) {
    return 'blind_spot';
  }
  return 'unknown';
}

function makeHonestyRecord(params: {
  sessionPath: string;
  sourceKind: AoiRealFieldSourceHonestyKind;
  sourceId: string;
  sourceLabel: string;
  freshness: AoiSignalFreshness;
  consentState: AoiFieldSignalConsentState | 'not_required';
  bodyAccess: AoiFieldSignalBodyAccess | 'not_applicable';
  cannotKnow: readonly string[];
  evidenceRefs: readonly string[];
  createdAt: number;
}): AoiRealFieldSourceHonestyRecord {
  const cannotKnow = uniqueStrings(params.cannotKnow);
  const evidenceRefs = uniqueStrings(params.evidenceRefs);
  const currentClaimAllowed = isCurrentClaimAllowed({
    freshness: params.freshness,
    consentState: params.consentState,
    bodyAccess: params.bodyAccess,
    cannotKnow,
  });
  return {
    version: 1,
    id: `aoi-real-field-source-honesty-${hashText(
      `${params.sessionPath}:${params.sourceKind}:${params.sourceId}:${params.createdAt}`,
    )}`,
    sessionPath: params.sessionPath,
    sourceKind: params.sourceKind,
    sourceId: normalizeText(params.sourceId, 120) || 'source',
    sourceLabel: normalizeText(params.sourceLabel, 160) || 'Source',
    status: honestyStatus({
      freshness: params.freshness,
      currentClaimAllowed,
      consentState: params.consentState,
      cannotKnow,
    }),
    freshness: params.freshness,
    consentState: params.consentState,
    bodyAccess: params.bodyAccess,
    currentClaimAllowed,
    currentClaimBlockedReasons: currentClaimAllowed
      ? []
      : blockedReasonsFor({
          freshness: params.freshness,
          consentState: params.consentState,
          bodyAccess: params.bodyAccess,
          cannotKnow,
        }),
    cannotKnow,
    evidenceRefs,
    createdAt: params.createdAt,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function sourceKindFromContract(contract: AoiSourceFreshnessContract): AoiFieldSignalSourceKind {
  if (contract.sourceKind === 'workspace_git' || contract.sourceKind === 'workspace_build') {
    return 'workspace';
  }
  if (contract.sourceKind === 'research_runs') {
    return 'research';
  }
  if (contract.sourceKind === 'kira_board') {
    return 'kira';
  }
  if (
    contract.sourceKind === 'gmail_metadata' ||
    contract.sourceKind === 'calendar_metadata' ||
    contract.sourceKind === 'notes_metadata'
  ) {
    return 'personal_metadata';
  }
  if (contract.sourceKind === 'app_state' || contract.sourceKind === 'browser_context') {
    return 'app_state';
  }
  return 'manual';
}

function consentFromContract(contract: AoiSourceFreshnessContract): AoiFieldSignalConsentState {
  if (contract.consentState === 'revoked') {
    return 'revoked';
  }
  if (contract.consentState === 'disabled') {
    return 'disabled';
  }
  if (contract.consentState === 'disconnected') {
    return 'disconnected';
  }
  if (contract.consentState === 'missing') {
    return 'unknown';
  }
  return 'allowed';
}

function bodyAccessFromContract(contract: AoiSourceFreshnessContract): AoiFieldSignalBodyAccess {
  if (contract.bodyAccessState === 'body_disabled' || contract.bodyAccessState === 'withheld') {
    return 'none';
  }
  return 'metadata_only';
}

function signalFromContract(
  sessionPath: string,
  contract: AoiSourceFreshnessContract,
  now: number,
): AoiFieldSignalPacket {
  return buildAoiFieldSignalPacket(
    {
      id: `source-contract-${contract.id}`,
      sessionPath,
      sourceKind: sourceKindFromContract(contract),
      summary: `${contract.sourceLabel}: freshness=${contract.freshnessState}; consent=${contract.consentState}; scope=${contract.scopeState}.`,
      freshness: contract.signalFreshness,
      consentState: consentFromContract(contract),
      bodyAccess: bodyAccessFromContract(contract),
      risk:
        contract.bodyAccessState === 'withheld' ||
        (contract.consentState !== 'granted' && contract.consentState !== 'not_required')
          ? 'medium'
          : 'low',
      evidenceRefs: contract.evidenceRefs,
      cannotKnow: contract.cannotKnow.map((item) => item.statement),
      observedAt: contract.lastObservedAt ?? contract.lastSuccessfulReadAt ?? now,
      dedupeKey: `source-contract:${contract.id}`,
    },
    now,
  );
}

function signalFromMission(sessionPath: string, mission: AoiMissionState, now: number) {
  return buildAoiFieldSignalPacket(
    {
      id: `mission-${mission.activeGoalId ?? mission.status}`,
      sessionPath,
      sourceKind: 'memory',
      summary: `Mission ${mission.status}: ${mission.focusSummary}`,
      freshness: 'fresh',
      consentState: 'allowed',
      bodyAccess: 'metadata_only',
      risk: mission.status === 'blocked' ? 'medium' : 'low',
      evidenceRefs: mission.evidenceRefs,
      cannotKnow: mission.blockedReason ? [mission.blockedReason] : [],
      observedAt: mission.updatedAt,
      dedupeKey: `mission:${mission.activeGoalId ?? mission.status}`,
    },
    now,
  );
}

function fieldEventCategoryForSignal(signal: AoiFieldSignalPacket): AoiFieldEventCategory {
  if (
    signal.freshness !== 'fresh' ||
    signal.consentState === 'disabled' ||
    signal.consentState === 'revoked' ||
    signal.consentState === 'disconnected' ||
    signal.cannotKnow.length > 0
  ) {
    return 'deliberation_blocked';
  }
  return 'signal_observed';
}

function timelineEventId(seed: string): string {
  return `aoi-real-field-timeline-${hashText(seed)}`;
}

function makeTimelineEvent(params: {
  sessionPath: string;
  kind: AoiOperatorTimelineEvent['kind'];
  title: string;
  summary: string;
  createdAt: number;
  sourceRef?: string;
  sourceKind?: string;
  decisionId?: string;
  missionId?: string;
  evidenceRefs?: readonly string[];
  relatedRefs?: readonly string[];
  status?: string;
  risk?: 'low' | 'medium' | 'high';
  metrics?: Record<string, number>;
}): AoiOperatorTimelineEvent {
  const summary = normalizeText(params.summary, 360) || 'Real field capture event.';
  const title = normalizeText(params.title, 120) || 'Real field capture';
  const evidenceRefs = uniqueStrings(params.evidenceRefs ?? []);
  const relatedRefs = uniqueStrings(params.relatedRefs ?? []);
  const redactedText = `${title} ${summary} ${evidenceRefs.join(' ')} ${relatedRefs.join(' ')}`;
  const redacted =
    countPrivateLeaks({ title, summary, evidenceRefs, relatedRefs }) > 0 ||
    /\[(?:redacted|private|local path)[^\]]*\]/i.test(redactedText);
  return {
    version: 1,
    id: timelineEventId(
      `${params.sessionPath}:${params.kind}:${title}:${params.createdAt}:${params.sourceRef ?? ''}:${params.decisionId ?? ''}`,
    ),
    sessionPath: params.sessionPath,
    kind: params.kind,
    visibility: params.kind === 'source_suppressed' ? 'hidden' : 'dashboard_only',
    createdAt: params.createdAt,
    title,
    summary,
    redactionState: redacted ? 'redacted' : 'none',
    evidenceRefs,
    relatedRefs,
    ...(params.sourceRef ? { sourceRef: normalizeText(params.sourceRef, 240) } : {}),
    ...(params.sourceKind ? { sourceKind: normalizeText(params.sourceKind, 80) } : {}),
    ...(params.decisionId ? { decisionId: normalizeText(params.decisionId, 128) } : {}),
    ...(params.missionId ? { missionId: normalizeText(params.missionId, 128) } : {}),
    ...(params.status ? { status: normalizeText(params.status, 80) } : {}),
    ...(params.risk ? { risk: params.risk } : {}),
    ...(params.metrics ? { metrics: params.metrics } : {}),
  };
}

function timelineEventFromSignal(signal: AoiFieldSignalPacket): AoiOperatorTimelineEvent {
  return makeTimelineEvent({
    sessionPath: signal.sessionPath,
    kind:
      signal.freshness === 'fresh' && signal.cannotKnow.length === 0
        ? 'observation_ingested'
        : 'source_suppressed',
    title: `${signal.sourceKind.replace(/_/g, ' ')} observed`,
    summary: signal.summary,
    createdAt: signal.observedAt,
    sourceRef: `${signal.sourceKind}:${signal.id}`,
    sourceKind: signal.sourceKind,
    evidenceRefs: signal.evidenceRefs,
    relatedRefs: signal.cannotKnow,
    status: signal.freshness,
    risk: signal.risk,
  });
}

function timelineEventFromDecision(
  decision: AoiShadowDecision,
  now: number,
): AoiOperatorTimelineEvent {
  return makeTimelineEvent({
    sessionPath: decision.sessionPath,
    kind:
      decision.kind === 'would_stay_quiet' || decision.kind === 'would_mark_blind_spot'
        ? 'digest_item_hidden'
        : 'digest_item_surfaced',
    title: decision.kind.replace(/_/g, ' '),
    summary: decision.whyQuiet ?? decision.whySpeak ?? decision.sourceSummary,
    createdAt: decision.createdAt || now,
    sourceRef: decision.sourceRefs[0],
    decisionId: decision.id,
    evidenceRefs: decision.evidenceRefs,
    relatedRefs: decision.cannotKnow ?? [],
    status: decision.sourceFreshness,
    risk: decision.risk,
  });
}

function sanitizeExistingTimelineEvent(
  event: AoiOperatorTimelineEvent,
  sessionPath: string,
  now: number,
): AoiOperatorTimelineEvent {
  return makeTimelineEvent({
    sessionPath,
    kind: event.kind,
    title: event.title,
    summary: event.summary,
    createdAt: event.createdAt || now,
    sourceRef: event.sourceRef,
    sourceKind: event.sourceKind,
    decisionId: event.decisionId,
    missionId: event.missionId,
    evidenceRefs: event.evidenceRefs,
    relatedRefs: event.relatedRefs,
    status: event.status,
    risk: event.risk,
    metrics: event.metrics,
  });
}

function honestyFromSignal(signal: AoiFieldSignalPacket): AoiRealFieldSourceHonestyRecord {
  return makeHonestyRecord({
    sessionPath: signal.sessionPath,
    sourceKind: signal.sourceKind,
    sourceId: signal.id,
    sourceLabel: signal.summary,
    freshness: signal.freshness,
    consentState: signal.consentState,
    bodyAccess: signal.bodyAccess,
    cannotKnow: signal.cannotKnow,
    evidenceRefs: signal.evidenceRefs,
    createdAt: signal.observedAt,
  });
}

function honestyFromScoutRecord(
  sessionPath: string,
  record: AoiProactiveBriefScoutSourceHonestyRecord,
  now: number,
): AoiRealFieldSourceHonestyRecord {
  return makeHonestyRecord({
    sessionPath,
    sourceKind: 'proactive_scout',
    sourceId: record.topicId ? `topic-${hashText(record.topicId)}` : record.reason,
    sourceLabel: record.topicLabel ?? record.topicId ?? 'Proactive scout',
    freshness: record.currentClaimAllowed ? 'fresh' : 'unknown',
    consentState: 'not_required',
    bodyAccess: 'not_applicable',
    cannotKnow: record.cannotKnow,
    evidenceRefs: record.evidenceRefs,
    createdAt: record.createdAt || now,
  });
}

function staleCurrentClaimCountFor(params: {
  sourceHonestyRecords: readonly AoiRealFieldSourceHonestyRecord[];
  shadowDecisions: readonly AoiShadowDecision[];
}): number {
  const sourceClaims = params.sourceHonestyRecords.filter(
    (record) => record.currentClaimAllowed && record.freshness !== 'fresh',
  ).length;
  const shadowClaims = params.shadowDecisions.filter(
    (decision) =>
      decision.kind === 'would_speak' &&
      decision.sourceFreshness !== 'fresh' &&
      !(decision.cannotKnow ?? []).length,
  ).length;
  return sourceClaims + shadowClaims;
}

function buildSummary(params: {
  generatedAt: number;
  fieldSignals: readonly AoiFieldSignalPacket[];
  fieldEvents: readonly AoiFieldEvent[];
  timelineEvents: readonly AoiOperatorTimelineEvent[];
  shadowDecisions: readonly AoiShadowDecision[];
  sourceHonestyRecords: readonly AoiRealFieldSourceHonestyRecord[];
  cannotKnow: readonly string[];
  whyQuiet: readonly string[];
  privateLeakCount: number;
  unauthorizedMutationCount: number;
  staleCurrentClaimCount: number;
  evidenceRefs: readonly string[];
}): AoiRealFieldCaptureSummary {
  const blindSpotRecords = params.sourceHonestyRecords.filter(
    (record) =>
      !record.currentClaimAllowed ||
      record.status === 'blind_spot' ||
      record.status === 'stale' ||
      record.status === 'failed',
  );
  return {
    version: 1,
    statusLabel: `${params.fieldSignals.length} signal(s), ${params.shadowDecisions.length} shadow decision(s), ${params.timelineEvents.length} timeline event(s) captured`,
    signalLabels: uniqueStrings(
      params.fieldSignals.map(
        (signal) => `${signal.sourceKind}: ${signal.freshness} (${signal.id})`,
      ),
      8,
    ),
    blindSpotLabels: uniqueStrings(
      blindSpotRecords.map(
        (record) =>
          `${record.sourceLabel}: cannot claim current; ${
            record.currentClaimBlockedReasons.join(', ') || record.status
          }`,
      ),
      8,
    ),
    whyQuietLabels: uniqueStrings(params.whyQuiet, 8),
    sourceHonestyLabels: uniqueStrings(
      params.sourceHonestyRecords.map(
        (record) =>
          `${record.sourceKind}: ${record.currentClaimAllowed ? 'current claim allowed' : 'cannot claim current'} (${record.status})`,
      ),
      8,
    ),
    hardFailLabels: [
      `private leaks ${params.privateLeakCount}`,
      `unauthorized mutations ${params.unauthorizedMutationCount}`,
      `stale current claims ${params.staleCurrentClaimCount}`,
    ],
    evidenceRefs: uniqueStrings(params.evidenceRefs),
  };
}

export function buildAoiRealFieldCapture(
  input: AoiRealFieldCaptureInput,
): AoiRealFieldCaptureResult {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? Date.now();
  const fieldSignals = [
    ...buildAoiFieldSignalPackets({
      sessionPath,
      workspaceSnapshots: input.workspaceSnapshots,
      researchSignals: input.researchSignals,
      kiraOutcomes: input.kiraOutcomes,
      appStateSignals: input.appStateSignals,
      personalMetadataSources: input.personalMetadataSources,
      memorySignals: input.memorySignals,
      manualSignals: input.manualSignals,
      now,
    }),
    ...(input.sourceFreshnessContracts ?? []).map((contract) =>
      signalFromContract(sessionPath, contract, now),
    ),
    ...(input.mission ? [signalFromMission(sessionPath, input.mission, now)] : []),
  ];
  const signalEvents = fieldSignals.map((signal) =>
    buildAoiFieldEventFromSignal(signal, fieldEventCategoryForSignal(signal)),
  );
  const scoutFieldEvents = (input.scoutFieldEvents ?? [])
    .map((event) => normalizeAoiFieldEvent(event, sessionPath, now))
    .filter((event): event is AoiFieldEvent => event !== null);
  const shadow = buildAoiFieldShadowDecisionBridge({
    sessionPath,
    opportunities: input.opportunities ?? [],
    interruptionDecisions: input.interruptionDecisions,
    actionLadderDecisions: input.actionLadderDecisions,
    deliberationRuns: input.deliberationRuns,
    fieldEvents: [...signalEvents, ...scoutFieldEvents],
    missionId: input.mission?.activeGoalId,
    now,
  });
  const fieldEvents = [...signalEvents, ...scoutFieldEvents, ...shadow.fieldEvents];
  const ledger = buildAoiFieldLedgerSummary({ sessionPath, events: fieldEvents, now });
  const sourceHonestyRecords = [
    ...fieldSignals.map(honestyFromSignal),
    ...(input.scoutSourceHonestyRecords ?? []).map((record) =>
      honestyFromScoutRecord(sessionPath, record, now),
    ),
  ];
  const timelineEvents = [
    ...fieldSignals.map(timelineEventFromSignal),
    ...shadow.decisions.map((decision) => timelineEventFromDecision(decision, now)),
    ...(input.timelineEvents ?? []).map((event) =>
      sanitizeExistingTimelineEvent(event, sessionPath, now),
    ),
    ...(input.mission
      ? [
          makeTimelineEvent({
            sessionPath,
            kind: 'mission_state_changed',
            title: `Mission ${input.mission.status}`,
            summary: input.mission.focusSummary,
            createdAt: input.mission.updatedAt,
            missionId: input.mission.activeGoalId,
            evidenceRefs: input.mission.evidenceRefs,
            relatedRefs: input.mission.blockedReason ? [input.mission.blockedReason] : [],
            status: input.mission.status,
            risk: input.mission.status === 'blocked' ? 'medium' : 'low',
          }),
        ]
      : []),
  ];
  const cannotKnow = uniqueStrings([
    ...ledger.cannotKnow,
    ...sourceHonestyRecords.flatMap((record) => record.cannotKnow),
    ...shadow.decisions.flatMap((decision) => decision.cannotKnow ?? []),
  ]);
  const whyQuiet = uniqueStrings([
    ...shadow.summary.whyQuietLabels,
    ...shadow.decisions.map((decision) => decision.whyQuiet ?? decision.silenceReason),
  ]);
  const evidenceRefs = uniqueStrings([
    ...fieldEvents.flatMap((event) => event.evidenceRefs),
    ...timelineEvents.flatMap((event) => event.evidenceRefs),
    ...sourceHonestyRecords.flatMap((record) => record.evidenceRefs),
    ...shadow.summary.evidenceRefs,
  ]);
  const staleCurrentClaimCount = staleCurrentClaimCountFor({
    sourceHonestyRecords,
    shadowDecisions: shadow.decisions,
  });
  const mutationCount = 0 as const;
  const unauthorizedMutationCount = mutationCount;
  const privateLeakCount = countPrivateLeaks({
    fieldSignals,
    fieldEvents,
    timelineEvents,
    shadowDecisions: shadow.decisions,
    sourceHonestyRecords,
    cannotKnow,
    whyQuiet,
    evidenceRefs,
  });
  const summary = buildSummary({
    generatedAt: now,
    fieldSignals,
    fieldEvents,
    timelineEvents,
    shadowDecisions: shadow.decisions,
    sourceHonestyRecords,
    cannotKnow,
    whyQuiet,
    privateLeakCount,
    unauthorizedMutationCount,
    staleCurrentClaimCount,
    evidenceRefs,
  });

  return {
    version: 1,
    id: `aoi-real-field-capture-${hashText(`${sessionPath}:${now}:${fieldSignals.length}:${timelineEvents.length}`)}`,
    sessionPath,
    generatedAt: now,
    fieldSignals,
    fieldEvents,
    timelineEvents,
    shadowDecisions: shadow.decisions,
    sourceHonestyRecords,
    cannotKnow,
    whyQuiet,
    privateLeakCount,
    unauthorizedMutationCount,
    staleCurrentClaimCount,
    mutationCount,
    liveOperationCounts: { ...LIVE_OPERATION_COUNTS_ZERO },
    summary,
    evidenceRefs,
    actionAuthority: 'display_only',
  };
}
