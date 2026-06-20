import {
  buildAoiFieldShadowRecordReport,
  type AoiFieldShadowRecordReport,
  type AoiFieldShadowSubsystemOrigin,
} from './aoiFieldShadowDogfooding';
import {
  appendAoiFieldEvents,
  normalizeAoiFieldEvent,
  type AoiFieldEvent,
  type AoiFieldEventCategory,
} from './aoiFieldEventLedger';
import { sanitizeAoiFieldSignalText } from './aoiFieldSignalBridge';
import { normalizeAoiAutonomySessionPath, recordAoiFieldShadowDecisions } from './aoiAutonomyStore';
import type {
  AoiActionLadderBlockedAction,
  AoiActionLadderDecision,
  AoiActionLadderLevel,
  AoiAutonomyRisk,
  AoiDeliberationRun,
  AoiInterruptionBlockedReason,
  AoiInterruptionGovernorDecision,
  AoiOpportunity,
  AoiSignalFreshness,
} from './aoiAutonomyTypes';
import type {
  AoiShadowConsentState,
  AoiShadowDecision,
  AoiShadowDecisionKind,
  AoiShadowPolicyResult,
} from './aoiShadowModeEvaluation';

const DEFAULT_BRIDGE_NOW = 1_800_000_000_000;
const DEFAULT_EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REFS = 24;
const MAX_LABELS = 12;

export interface AoiFieldShadowDecisionBridgeInput {
  sessionPath: string;
  opportunities: readonly AoiOpportunity[];
  interruptionDecisions?: readonly AoiInterruptionGovernorDecision[];
  actionLadderDecisions?: readonly AoiActionLadderDecision[];
  deliberationRuns?: readonly AoiDeliberationRun[];
  fieldEvents?: readonly AoiFieldEvent[];
  missionId?: string;
  now?: number;
  retentionMs?: number;
}

export interface AoiFieldShadowDecisionBridgeSummary {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  decisionCount: number;
  speakCount: number;
  quietCount: number;
  dashboardCount: number;
  researchPrepareCount: number;
  workOrderPrepareCount: number;
  blindSpotCount: number;
  blockedDecisionCount: number;
  directChatBlockedCount: number;
  whyQuietLabels: string[];
  directChatBlockerLabels: string[];
  staleUnsafeDuplicateLabels: string[];
  fieldEventRefs: string[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
  zeroMutation: true;
}

export interface AoiFieldShadowDecisionBridgeResult {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  decisions: AoiShadowDecision[];
  fieldEvents: AoiFieldEvent[];
  fieldShadowReport: AoiFieldShadowRecordReport;
  subsystemOriginByDecisionId: Record<string, AoiFieldShadowSubsystemOrigin>;
  summary: AoiFieldShadowDecisionBridgeSummary;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiFieldShadowDecisionIntegrationRecordResult extends AoiFieldShadowDecisionBridgeResult {
  persistedFieldShadowReport: AoiFieldShadowRecordReport;
  appendedFieldEvents: AoiFieldEvent[];
}

function normalizeText(value: unknown, maxChars = 220): string {
  return sanitizeAoiFieldSignalText(value, maxChars);
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 12);
}

function uniqueStrings(values: readonly unknown[], limit = MAX_REFS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value, 220);
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

function riskForOpportunity(opportunity: AoiOpportunity): AoiAutonomyRisk {
  return opportunity.risk === 'high' ? 'high' : opportunity.risk === 'medium' ? 'medium' : 'low';
}

function latestRunForOpportunity(
  runs: readonly AoiDeliberationRun[] | undefined,
  opportunityId: string,
): AoiDeliberationRun | null {
  return (
    (runs ?? [])
      .filter((run) => run.opportunityId === opportunityId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null
  );
}

function fieldEventForOpportunity(
  events: readonly AoiFieldEvent[] | undefined,
  opportunity: AoiOpportunity,
): AoiFieldEvent | null {
  const refs = new Set([opportunity.id, `opportunity:${opportunity.id}`, opportunity.dedupeKey]);
  return (
    (events ?? [])
      .filter((event) =>
        [...event.sourceRefs, ...event.evidenceRefs, ...event.signalIds].some((ref) =>
          refs.has(ref),
        ),
      )
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  );
}

function sourceFreshness(params: {
  interruption?: AoiInterruptionGovernorDecision | null;
  run?: AoiDeliberationRun | null;
}): AoiSignalFreshness {
  if (
    params.interruption?.directChatBlockedReasons.includes('failed_evidence') ||
    params.run?.finding?.freshness === 'failed'
  ) {
    return 'failed';
  }
  if (
    params.interruption?.directChatBlockedReasons.includes('stale_source') ||
    params.run?.finding?.freshness === 'stale' ||
    params.run?.evidencePlan.some((step) => step.freshness === 'stale' || step.status === 'stale')
  ) {
    return 'stale';
  }
  if (
    params.interruption?.directChatBlockedReasons.includes('missing_evidence') ||
    params.run?.finding?.sourceQuality === 'missing'
  ) {
    return 'unknown';
  }
  if (
    params.interruption?.directChatAllowed &&
    params.interruption.directChatBlockedReasons.length === 0
  ) {
    return 'fresh';
  }
  if (params.run?.finding?.freshness === 'fresh') {
    return 'fresh';
  }
  return 'unknown';
}

function hasUnsafeBlockedAction(ladder?: AoiActionLadderDecision | null): boolean {
  return Boolean(
    ladder?.blockedActions.some((action) =>
      /unsafe|blocked|approved-command|command policy|follow_through_learning/i.test(
        `${action.kind} ${action.reason} ${action.label}`,
      ),
    ),
  );
}

function cannotKnowFor(params: {
  freshness: AoiSignalFreshness;
  interruption?: AoiInterruptionGovernorDecision | null;
  ladder?: AoiActionLadderDecision | null;
  run?: AoiDeliberationRun | null;
}): string[] {
  const statements: string[] = [];
  if (params.freshness === 'stale') {
    statements.push('Current state cannot be claimed from stale field evidence.');
  }
  if (params.freshness === 'failed') {
    statements.push('Current state cannot be claimed because evidence validation failed.');
  }
  if (params.freshness === 'unknown') {
    statements.push(
      'Current state cannot be claimed because required source evidence is missing or unknown.',
    );
  }
  if (params.interruption?.directChatBlockedReasons.includes('missing_evidence')) {
    statements.push('Direct chat cannot infer missing evidence.');
  }
  if (hasUnsafeBlockedAction(params.ladder)) {
    statements.push('Unsafe or blocked follow-through evidence prevents work-order preparation.');
  }
  for (const item of params.run?.finding?.cannotKnow ?? []) {
    statements.push(item);
  }
  for (const step of params.run?.evidencePlan ?? []) {
    statements.push(...step.cannotKnow);
  }
  return uniqueStrings(statements, 12);
}

function hasDuplicateOrCooldown(interruption?: AoiInterruptionGovernorDecision | null): boolean {
  return Boolean(
    interruption?.directChatBlockedReasons.some(
      (reason) =>
        reason === 'duplicate_or_cooldown' ||
        reason === 'recent_interruption_budget' ||
        reason === 'too_frequent_feedback',
    ),
  );
}

function hasQuietBlocker(interruption?: AoiInterruptionGovernorDecision | null): boolean {
  return Boolean(interruption?.directChatBlockedReasons.includes('quiet_mode'));
}

function prepareActionForLevel(
  ladder: AoiActionLadderDecision | null | undefined,
  level: AoiActionLadderLevel,
): boolean {
  return Boolean(ladder?.allowedActions.some((action) => action.level === level));
}

function researchReady(ladder: AoiActionLadderDecision | null | undefined): boolean {
  return Boolean(
    ladder?.allowedActions.some(
      (action) => action.level === 'L3' && /research/i.test(`${action.kind} ${action.label}`),
    ),
  );
}

function chooseKind(params: {
  opportunity: AoiOpportunity;
  interruption?: AoiInterruptionGovernorDecision | null;
  ladder?: AoiActionLadderDecision | null;
  run?: AoiDeliberationRun | null;
  freshness: AoiSignalFreshness;
}): AoiShadowDecisionKind {
  if (params.freshness === 'stale' || params.freshness === 'failed') {
    return 'would_mark_blind_spot';
  }
  if (hasUnsafeBlockedAction(params.ladder)) {
    return 'would_mark_blind_spot';
  }
  if (hasQuietBlocker(params.interruption) || hasDuplicateOrCooldown(params.interruption)) {
    return 'would_stay_quiet';
  }
  if (prepareActionForLevel(params.ladder, 'L4')) {
    return 'would_prepare_work_order';
  }
  if (researchReady(params.ladder)) {
    return 'would_prepare_research';
  }
  if (
    params.interruption?.deliveryMode === 'direct_chat' &&
    params.interruption.directChatAllowed
  ) {
    return 'would_speak';
  }
  if (
    params.interruption?.deliveryMode === 'dashboard' ||
    params.interruption?.deliveryMode === 'inline_card' ||
    params.interruption?.deliveryMode === 'quiet_notification'
  ) {
    return 'would_show_dashboard';
  }
  if (params.interruption?.deliveryMode === 'hidden') {
    return 'would_stay_quiet';
  }
  return params.opportunity.deliveryRecommendation === 'direct_chat'
    ? 'would_show_dashboard'
    : 'would_stay_quiet';
}

function policyForKind(
  kind: AoiShadowDecisionKind,
  ladder?: AoiActionLadderDecision | null,
): AoiShadowPolicyResult {
  if (kind === 'would_prepare_work_order') {
    return ladder?.approvalNeeds.length ? 'approval_required' : 'record_only';
  }
  if (kind === 'would_mark_blind_spot') {
    return hasUnsafeBlockedAction(ladder) ? 'blocked' : 'record_only';
  }
  if (kind === 'would_speak' || kind === 'would_show_dashboard') {
    return 'allowed';
  }
  return 'record_only';
}

function eventCategoryForKind(
  kind: AoiShadowDecisionKind,
  ladder?: AoiActionLadderDecision | null,
): AoiFieldEventCategory {
  if (kind === 'would_speak') {
    return 'delivery_direct_chat_candidate';
  }
  if (kind === 'would_show_dashboard') {
    return 'delivery_dashboard';
  }
  if (kind === 'would_prepare_work_order') {
    return 'work_order_prepared';
  }
  if (kind === 'would_prepare_research') {
    return 'deliberation_ready';
  }
  if (kind === 'would_mark_blind_spot') {
    return hasUnsafeBlockedAction(ladder) ? 'action_ladder_blocked' : 'deliberation_blocked';
  }
  return 'delivery_hidden';
}

function sourceRefsFor(params: {
  opportunity: AoiOpportunity;
  interruption?: AoiInterruptionGovernorDecision | null;
  ladder?: AoiActionLadderDecision | null;
  fieldEvent?: AoiFieldEvent | null;
}): string[] {
  return uniqueStrings([
    `opportunity:${params.opportunity.id}`,
    `opportunity-dedupe:${params.opportunity.dedupeKey}`,
    params.interruption ? `interruption-governor:${params.interruption.id}` : undefined,
    params.ladder ? `action-ladder:${params.ladder.id}` : undefined,
    params.fieldEvent ? `field-event:${params.fieldEvent.id}` : undefined,
    ...params.opportunity.evidenceRefs,
    ...(params.interruption?.evidenceRefs ?? []),
    ...(params.ladder?.evidenceRefs ?? []),
  ]);
}

function evidenceRefsFor(params: {
  opportunity: AoiOpportunity;
  interruption?: AoiInterruptionGovernorDecision | null;
  ladder?: AoiActionLadderDecision | null;
  run?: AoiDeliberationRun | null;
  fieldEvent?: AoiFieldEvent | null;
}): string[] {
  return uniqueStrings([
    `opportunity:${params.opportunity.id}`,
    ...(params.opportunity.evidenceRefs ?? []),
    ...(params.interruption?.evidenceRefs ?? []),
    ...(params.ladder?.evidenceRefs ?? []),
    ...(params.run?.evidenceRefs ?? []),
    ...(params.run?.finding?.evidenceRefs ?? []),
    ...(params.fieldEvent?.evidenceRefs ?? []),
  ]);
}

function directChatBlockerLabels(reasons: readonly AoiInterruptionBlockedReason[]): string[] {
  return reasons.map((reason) => reason.replace(/_/g, ' ')).slice(0, MAX_LABELS);
}

function firstBlockedAction(
  ladder?: AoiActionLadderDecision | null,
): AoiActionLadderBlockedAction | null {
  return ladder?.blockedActions[0] ?? null;
}

function messageForKind(params: {
  kind: AoiShadowDecisionKind;
  opportunity: AoiOpportunity;
  interruption?: AoiInterruptionGovernorDecision | null;
  ladder?: AoiActionLadderDecision | null;
  blockedAction?: AoiActionLadderBlockedAction | null;
}): string {
  if (params.kind === 'would_speak') {
    return `Aoi would directly mention: ${params.opportunity.title}. ${params.opportunity.suggestedNextAction}`;
  }
  if (params.kind === 'would_show_dashboard') {
    return `Aoi would keep this on the dashboard: ${params.opportunity.title}.`;
  }
  if (params.kind === 'would_prepare_research') {
    return `Aoi would prepare a research follow-up for ${params.opportunity.title}.`;
  }
  if (params.kind === 'would_prepare_work_order') {
    return `Aoi would prepare a bounded work order for ${params.opportunity.title}.`;
  }
  if (params.kind === 'would_mark_blind_spot') {
    return `Aoi would mark a blind spot or blocked ladder state: ${params.blockedAction?.reason ?? params.interruption?.summaryLabel ?? params.opportunity.evidenceNeed}`;
  }
  return `Aoi would stay quiet about ${params.opportunity.title}.`;
}

function whySpeakFor(params: {
  kind: AoiShadowDecisionKind;
  interruption?: AoiInterruptionGovernorDecision | null;
  ladder?: AoiActionLadderDecision | null;
  run?: AoiDeliberationRun | null;
}): string | undefined {
  if (params.kind !== 'would_speak' && params.kind !== 'would_show_dashboard') {
    return undefined;
  }
  return normalizeText(
    params.interruption?.summaryLabel ??
      params.run?.opinion?.reason ??
      params.ladder?.summaryLabel ??
      'Fresh evidence and delivery gates allow a visible operator-facing update.',
  );
}

function whyQuietFor(params: {
  kind: AoiShadowDecisionKind;
  interruption?: AoiInterruptionGovernorDecision | null;
  ladder?: AoiActionLadderDecision | null;
  freshness: AoiSignalFreshness;
  blockedAction?: AoiActionLadderBlockedAction | null;
}): string | undefined {
  if (
    params.kind !== 'would_stay_quiet' &&
    params.kind !== 'would_mark_blind_spot' &&
    params.kind !== 'would_prepare_research'
  ) {
    return undefined;
  }
  const blockers = directChatBlockerLabels(params.interruption?.directChatBlockedReasons ?? []);
  if (blockers.length > 0) {
    return normalizeText(`Direct chat blocked by ${blockers.join(', ')}.`);
  }
  if (params.blockedAction) {
    return normalizeText(`Action ladder blocked: ${params.blockedAction.reason}`);
  }
  if (params.freshness !== 'fresh') {
    return normalizeText(
      `Source freshness is ${params.freshness}; Aoi should avoid a current claim.`,
    );
  }
  return 'Shadow mode records this as quiet until stronger evidence exists.';
}

function decisionEventId(dedupeKey: string): string {
  return `aoi-field-event-shadow-${hashText(dedupeKey)}`;
}

function decisionId(dedupeKey: string): string {
  return `aoi-shadow-field-${hashText(dedupeKey)}`;
}

function makeDecision(params: {
  sessionPath: string;
  opportunity: AoiOpportunity;
  kind: AoiShadowDecisionKind;
  fieldEventId: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  freshness: AoiSignalFreshness;
  policyResult: AoiShadowPolicyResult;
  interruption?: AoiInterruptionGovernorDecision | null;
  ladder?: AoiActionLadderDecision | null;
  run?: AoiDeliberationRun | null;
  cannotKnow: string[];
  now: number;
  missionId?: string;
}): AoiShadowDecision {
  const blockedAction = firstBlockedAction(params.ladder);
  const dedupeKey = normalizeText(
    `field-shadow:${params.opportunity.id}:${params.kind}:${params.interruption?.id ?? 'no-interruption'}:${params.ladder?.id ?? 'no-ladder'}`,
    180,
  );
  const operatorMessagePreview = messageForKind({
    kind: params.kind,
    opportunity: params.opportunity,
    interruption: params.interruption,
    ladder: params.ladder,
    blockedAction,
  });
  const directChatBlockers = uniqueStrings(params.interruption?.directChatBlockedReasons ?? [], 12);
  return {
    version: 1,
    id: decisionId(dedupeKey),
    sessionPath: params.sessionPath,
    kind: params.kind,
    createdAt: params.now,
    ...(params.missionId ? { missionId: normalizeText(params.missionId, 120) } : {}),
    sourceRefs: params.sourceRefs,
    sourceSummary: normalizeText(
      `${params.opportunity.title}: ${params.interruption?.summaryLabel ?? params.ladder?.summaryLabel ?? params.opportunity.whyNow}`,
    ),
    consentState: 'allowed' satisfies AoiShadowConsentState,
    risk: riskForOpportunity(params.opportunity),
    policyResult: params.policyResult,
    opportunityId: params.opportunity.id,
    fieldEventId: params.fieldEventId,
    ...(whySpeakFor({
      kind: params.kind,
      interruption: params.interruption,
      ladder: params.ladder,
      run: params.run,
    })
      ? {
          whySpeak: whySpeakFor({
            kind: params.kind,
            interruption: params.interruption,
            ladder: params.ladder,
            run: params.run,
          }),
        }
      : {}),
    ...(whyQuietFor({
      kind: params.kind,
      interruption: params.interruption,
      ladder: params.ladder,
      freshness: params.freshness,
      blockedAction,
    })
      ? {
          whyQuiet: whyQuietFor({
            kind: params.kind,
            interruption: params.interruption,
            ladder: params.ladder,
            freshness: params.freshness,
            blockedAction,
          }),
          silenceReason: whyQuietFor({
            kind: params.kind,
            interruption: params.interruption,
            ladder: params.ladder,
            freshness: params.freshness,
            blockedAction,
          }),
        }
      : {}),
    sourceFreshness: params.freshness,
    ...(params.interruption
      ? {
          interruptionDecisionId: params.interruption.id,
          interruptionDeliveryMode: params.interruption.deliveryMode,
        }
      : {}),
    ...(params.ladder
      ? {
          actionLadderDecisionId: params.ladder.id,
          actionLadderLevel: params.ladder.currentLevel,
        }
      : {}),
    ...(directChatBlockers.length ? { directChatBlockers } : {}),
    privacyState: 'metadata_only',
    ...(params.cannotKnow.length ? { cannotKnow: params.cannotKnow } : {}),
    operatorMessagePreview,
    suggestedAction: params.ladder?.safeFallback ?? params.opportunity.suggestedNextAction,
    ...(params.kind === 'would_prepare_work_order' || params.policyResult === 'approval_required'
      ? {
          approvalBoundary:
            params.ladder?.approvalNeeds[0]?.reason ??
            'Shadow mode prepares a record only; execution remains behind existing approval gates.',
        }
      : {}),
    mutationCount: 0,
    evidenceRefs: params.evidenceRefs,
    dedupeKey,
  };
}

function makeEventForDecision(
  decision: AoiShadowDecision,
  ladder: AoiActionLadderDecision | null | undefined,
  now: number,
): AoiFieldEvent {
  const normalized = normalizeAoiFieldEvent(
    {
      id: decision.fieldEventId,
      sessionPath: decision.sessionPath,
      category: eventCategoryForKind(decision.kind, ladder),
      summary: `${decision.kind.replace(/_/g, ' ')}: ${decision.operatorMessagePreview ?? decision.sourceSummary}`,
      sourceRefs: [`shadow-decision:${decision.id}`, ...decision.sourceRefs],
      evidenceRefs: decision.evidenceRefs,
      privacyState: decision.privacyState ?? 'metadata_only',
      cannotKnow: decision.cannotKnow ?? [],
      createdAt: decision.createdAt,
      expiresAt: decision.createdAt + DEFAULT_EVENT_TTL_MS,
      signalIds: [decision.id],
      dedupeKey: `shadow-decision:${decision.id}`,
    },
    decision.sessionPath,
    now,
  );
  if (!normalized) {
    throw new Error('Invalid Aoi field shadow decision event.');
  }
  return normalized;
}

function originForDecision(decision: AoiShadowDecision): AoiFieldShadowSubsystemOrigin {
  if (decision.actionLadderDecisionId) {
    return 'action_ladder';
  }
  if (decision.interruptionDecisionId) {
    return 'interruption_governor';
  }
  return 'unknown';
}

function buildSummary(params: {
  sessionPath: string;
  decisions: readonly AoiShadowDecision[];
  fieldEvents: readonly AoiFieldEvent[];
  now: number;
}): AoiFieldShadowDecisionBridgeSummary {
  const evidenceRefs = uniqueStrings([
    ...params.decisions.flatMap((decision) => decision.evidenceRefs),
    ...params.fieldEvents.flatMap((event) => event.evidenceRefs),
  ]);
  const whyQuietLabels = uniqueStrings(
    params.decisions
      .filter(
        (decision) =>
          decision.kind === 'would_stay_quiet' || decision.kind === 'would_mark_blind_spot',
      )
      .map((decision) => decision.whyQuiet ?? decision.silenceReason ?? decision.sourceSummary),
    MAX_LABELS,
  );
  const directChatBlockerLabels = uniqueStrings(
    params.decisions.flatMap((decision) => decision.directChatBlockers ?? []),
    MAX_LABELS,
  );
  const staleUnsafeDuplicateLabels = uniqueStrings(
    params.decisions.flatMap((decision) => [
      ...(decision.sourceFreshness === 'stale' ? ['stale_source'] : []),
      ...(decision.sourceFreshness === 'failed' ? ['failed_evidence'] : []),
      ...((decision.directChatBlockers ?? []).filter((blocker) =>
        /duplicate|cooldown|unsafe|too_frequent|stale|failed/i.test(blocker),
      ) ?? []),
      ...((decision.cannotKnow ?? []).filter((item) => /stale|unsafe|missing|failed/i.test(item)) ??
        []),
    ]),
    MAX_LABELS,
  );
  return {
    version: 1,
    sessionPath: params.sessionPath,
    generatedAt: params.now,
    decisionCount: params.decisions.length,
    speakCount: params.decisions.filter((decision) => decision.kind === 'would_speak').length,
    quietCount: params.decisions.filter((decision) => decision.kind === 'would_stay_quiet').length,
    dashboardCount: params.decisions.filter((decision) => decision.kind === 'would_show_dashboard')
      .length,
    researchPrepareCount: params.decisions.filter(
      (decision) => decision.kind === 'would_prepare_research',
    ).length,
    workOrderPrepareCount: params.decisions.filter(
      (decision) => decision.kind === 'would_prepare_work_order',
    ).length,
    blindSpotCount: params.decisions.filter((decision) => decision.kind === 'would_mark_blind_spot')
      .length,
    blockedDecisionCount: params.decisions.filter((decision) => decision.policyResult === 'blocked')
      .length,
    directChatBlockedCount: params.decisions.filter(
      (decision) => (decision.directChatBlockers ?? []).length > 0,
    ).length,
    whyQuietLabels,
    directChatBlockerLabels,
    staleUnsafeDuplicateLabels,
    fieldEventRefs: params.fieldEvents.map((event) => `field-event:${event.id}`),
    evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
    zeroMutation: true,
  };
}

export function buildAoiFieldShadowDecisionBridge(
  input: AoiFieldShadowDecisionBridgeInput,
): AoiFieldShadowDecisionBridgeResult {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? DEFAULT_BRIDGE_NOW;
  const interruptionByOpportunityId = new Map(
    (input.interruptionDecisions ?? []).map((decision) => [decision.opportunityId, decision]),
  );
  const ladderByOpportunityId = new Map(
    (input.actionLadderDecisions ?? []).map((decision) => [decision.opportunityId, decision]),
  );
  const decisions: AoiShadowDecision[] = [];
  const events: AoiFieldEvent[] = [];
  const subsystemOriginByDecisionId: Record<string, AoiFieldShadowSubsystemOrigin> = {};

  for (const opportunity of input.opportunities) {
    const interruption = interruptionByOpportunityId.get(opportunity.id) ?? null;
    const ladder = ladderByOpportunityId.get(opportunity.id) ?? null;
    const run = latestRunForOpportunity(input.deliberationRuns, opportunity.id);
    const linkedFieldEvent = fieldEventForOpportunity(input.fieldEvents, opportunity);
    const freshness = sourceFreshness({ interruption, run });
    const kind = chooseKind({
      opportunity,
      interruption,
      ladder,
      run,
      freshness,
    });
    const dedupeProbe = `${sessionPath}:${opportunity.id}:${kind}:${interruption?.id ?? 'none'}:${ladder?.id ?? 'none'}:${freshness}`;
    const fieldEventId = decisionEventId(dedupeProbe);
    const sourceRefs = sourceRefsFor({
      opportunity,
      interruption,
      ladder,
      fieldEvent: linkedFieldEvent,
    });
    const evidenceRefs = evidenceRefsFor({
      opportunity,
      interruption,
      ladder,
      run,
      fieldEvent: linkedFieldEvent,
    });
    const decision = makeDecision({
      sessionPath,
      opportunity,
      kind,
      fieldEventId,
      sourceRefs,
      evidenceRefs,
      freshness,
      policyResult: policyForKind(kind, ladder),
      interruption,
      ladder,
      run,
      cannotKnow: cannotKnowFor({
        freshness,
        interruption,
        ladder,
        run,
      }),
      now,
      missionId: input.missionId,
    });
    decisions.push(decision);
    events.push(makeEventForDecision(decision, ladder, now));
    subsystemOriginByDecisionId[decision.id] = originForDecision(decision);
  }

  const fieldShadowReport = buildAoiFieldShadowRecordReport({
    sessionPath,
    decisions,
    now,
    retentionMs: input.retentionMs,
    subsystemOriginByDecisionId,
    evidenceRefs: events.map((event) => `field-event:${event.id}`),
  });
  const summary = buildSummary({
    sessionPath,
    decisions,
    fieldEvents: events,
    now,
  });

  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    decisions,
    fieldEvents: events,
    fieldShadowReport,
    subsystemOriginByDecisionId,
    summary,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function buildAoiFieldShadowDecisionBridgeSummary(
  input: AoiFieldShadowDecisionBridgeInput,
): AoiFieldShadowDecisionBridgeSummary {
  return buildAoiFieldShadowDecisionBridge(input).summary;
}

export function recordAoiFieldShadowDecisionIntegration(
  sessionsDir: string,
  input: AoiFieldShadowDecisionBridgeInput,
): AoiFieldShadowDecisionIntegrationRecordResult {
  const result = buildAoiFieldShadowDecisionBridge(input);
  const persistedFieldShadowReport = recordAoiFieldShadowDecisions(sessionsDir, {
    sessionPath: result.sessionPath,
    decisions: result.decisions,
    now: result.generatedAt,
    retentionMs: input.retentionMs,
    subsystemOriginByDecisionId: result.subsystemOriginByDecisionId,
    evidenceRefs: result.fieldEvents.map((event) => `field-event:${event.id}`),
  });
  const appendedFieldEvents = appendAoiFieldEvents(
    sessionsDir,
    result.fieldEvents,
    result.generatedAt,
  );
  return {
    ...result,
    persistedFieldShadowReport,
    appendedFieldEvents,
  };
}
