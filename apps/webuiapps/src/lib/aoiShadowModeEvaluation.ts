import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import type { AoiPersonalSourceRealityCheck } from './aoiPersonalSourceRealityCheck';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';
import type {
  AoiApprovedCommandPolicy,
  AoiAutonomyRisk,
  AoiEnvironmentSource,
  AoiEnvironmentSourceRegistry,
  AoiNotificationLane,
  AoiOperatorDigest,
  AoiOperatorHealthIssue,
  AoiOperatorHealthState,
  AoiPlaybook,
} from './aoiAutonomyTypes';

const MAX_TEXT = 220;
const MAX_REFS = 16;
const DEFAULT_SHADOW_NOW = 1_800_000_000_000;

export type AoiShadowDecisionKind =
  | 'would_speak'
  | 'would_stay_quiet'
  | 'would_show_dashboard'
  | 'would_prepare_research'
  | 'would_prepare_work_order'
  | 'would_propose'
  | 'would_prepare_approval'
  | 'would_mark_blind_spot';

export type AoiShadowDecisionLabel =
  | 'useful'
  | 'too_much'
  | 'wrong_source'
  | 'unsafe'
  | 'missed_context'
  | 'should_have_spoken';

export type AoiShadowConsentState = 'allowed' | 'disabled' | 'revoked' | 'disconnected' | 'unknown';

export type AoiShadowPolicyResult =
  | 'record_only'
  | 'allowed'
  | 'approval_required'
  | 'blocked'
  | 'not_applicable';

export type AoiShadowReplayDimension =
  | 'usefulness'
  | 'timing'
  | 'source_selection'
  | 'safety'
  | 'context_coverage';

export interface AoiShadowSourceConsentSnapshot {
  version: 1;
  sourceId: string;
  label: string;
  consentState: AoiShadowConsentState;
  evidenceRefs: string[];
  reason?: string;
  observedAt: number;
}

export interface AoiShadowDecision {
  version: 1;
  id: string;
  sessionPath: string;
  kind: AoiShadowDecisionKind;
  createdAt: number;
  missionId?: string;
  sourceRefs: string[];
  sourceSummary: string;
  consentState: AoiShadowConsentState;
  risk: AoiAutonomyRisk;
  policyResult: AoiShadowPolicyResult;
  opportunityId?: string;
  fieldEventId?: string;
  whySpeak?: string;
  whyQuiet?: string;
  sourceFreshness?: 'fresh' | 'stale' | 'failed' | 'unknown';
  interruptionDecisionId?: string;
  interruptionDeliveryMode?: string;
  actionLadderDecisionId?: string;
  actionLadderLevel?: string;
  directChatBlockers?: string[];
  privacyState?: 'redacted' | 'metadata_only' | 'synthetic' | 'unknown';
  cannotKnow?: string[];
  operatorMessagePreview?: string;
  silenceReason?: string;
  suggestedAction?: string;
  approvalBoundary?: string;
  mutationCount: 0;
  evidenceRefs: string[];
  dedupeKey: string;
}

export interface AoiShadowDecisionLabelRecord {
  version: 1;
  id: string;
  decisionId: string;
  label: AoiShadowDecisionLabel;
  actor: 'user' | 'system';
  createdAt: number;
  evidenceRefs: string[];
  note?: string;
}

export interface AoiShadowDecisionMetrics {
  totalDecisions: number;
  labeledDecisionCount: number;
  usefulRate: number;
  tooMuchRate: number;
  wrongSourceRate: number;
  unsafeShadowDecisionCount: number;
  shouldHaveSpokenCount: number;
  silentDecisionExplainabilityCoverage: number;
  mutationCount: number;
  zeroMutation: boolean;
}

export interface AoiShadowDecisionReport {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  metrics: AoiShadowDecisionMetrics;
  decisions: AoiShadowDecision[];
  labels: AoiShadowDecisionLabelRecord[];
  safetyReviewDecisionIds: string[];
  evidenceRefs: string[];
}

export interface AoiShadowReplayMetric {
  version: 1;
  id: string;
  decisionId: string;
  label: AoiShadowDecisionLabel;
  dimension: AoiShadowReplayDimension;
  passed: boolean;
  actualSummary: string;
  evidenceRefs: string[];
}

export interface AoiShadowReplayBridge {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  decisionCount: number;
  metricCount: number;
  failedMetricCount: number;
  metrics: AoiShadowReplayMetric[];
  evidenceRefs: string[];
}

export interface AoiShadowDecisionRecorderInput {
  sessionPath: string;
  missionId?: string;
  digest?: AoiOperatorDigest | null;
  health?: AoiOperatorHealthState | null;
  sourceRegistry?: AoiEnvironmentSourceRegistry | null;
  sourceConsent?: AoiShadowSourceConsentSnapshot[];
  personalSourceRealityCheck?: AoiPersonalSourceRealityCheck | null;
  playbooks?: AoiPlaybook[];
  approvedCommandPolicies?: AoiApprovedCommandPolicy[];
  now?: number;
}

export interface AoiShadowDecisionLabelInput {
  decisionId: string;
  label: AoiShadowDecisionLabel;
  actor?: 'user' | 'system';
  note?: string;
  evidenceRefs?: string[];
  now?: number;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 12);
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(4));
}

function redactShadowText(value: string, maxChars = MAX_TEXT): string {
  const normalized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value))
      .replace(
        /\b(?:do not leak|private|raw|full|secret)[^.!?]{0,100}\b(?:mail|email|calendar|event|note)?\s*body[^.!?]*(?:[.!?]|$)/gi,
        '[redacted-private-body]',
      )
      .replace(/\b[A-Z]:\\[^\s'"`<>|]+/gi, '[path]')
      .replace(/\\\\[^\s'"`<>|]+/g, '[path]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
      .replace(/https?:\/\/[^\s'"`<>]+/gi, '[url]'),
  );
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function normalizeRefs(refs: Array<string | undefined | null>, maxItems = MAX_REFS): string[] {
  const seen = new Set<string>();
  for (const ref of refs) {
    const normalized = redactShadowText(ref ?? '', 160);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function decisionId(dedupeKey: string): string {
  return `aoi-shadow-${hashText(dedupeKey)}`;
}

function labelId(decisionIdValue: string, label: AoiShadowDecisionLabel, now: number): string {
  return `aoi-shadow-label-${hashText(`${decisionIdValue}:${label}:${now}`)}`;
}

function riskForLane(lane: AoiNotificationLane): AoiAutonomyRisk {
  if (lane === 'critical_user_blocking' || lane === 'needs_approval') {
    return 'medium';
  }
  return 'low';
}

function kindForDigestItem(lane: AoiNotificationLane, hidden: boolean): AoiShadowDecisionKind {
  if (hidden || lane === 'hidden_by_quiet_mode') {
    return 'would_stay_quiet';
  }
  if (lane === 'critical_user_blocking') {
    return 'would_speak';
  }
  if (lane === 'needs_approval') {
    return 'would_prepare_approval';
  }
  return 'would_propose';
}

function policyForKind(kind: AoiShadowDecisionKind): AoiShadowPolicyResult {
  if (kind === 'would_prepare_approval') {
    return 'approval_required';
  }
  if (kind === 'would_stay_quiet' || kind === 'would_mark_blind_spot') {
    return 'record_only';
  }
  return 'not_applicable';
}

function consentStateFromSources(sourceRefs: string[]): AoiShadowConsentState {
  if (
    sourceRefs.some((ref) => /\b(?:calendar|gmail|notes|personal|browser-context)\b/i.test(ref))
  ) {
    return 'allowed';
  }
  return 'unknown';
}

function makeDecision(params: {
  sessionPath: string;
  missionId?: string;
  kind: AoiShadowDecisionKind;
  now: number;
  dedupeKey: string;
  sourceRefs: string[];
  sourceSummary: string;
  consentState?: AoiShadowConsentState;
  risk: AoiAutonomyRisk;
  policyResult?: AoiShadowPolicyResult;
  operatorMessagePreview?: string;
  silenceReason?: string;
  suggestedAction?: string;
  approvalBoundary?: string;
  evidenceRefs: string[];
}): AoiShadowDecision {
  const safeDedupeKey = redactShadowText(params.dedupeKey, 160);
  return {
    version: 1,
    id: decisionId(safeDedupeKey),
    sessionPath: params.sessionPath,
    kind: params.kind,
    createdAt: params.now,
    ...(params.missionId ? { missionId: redactShadowText(params.missionId, 120) } : {}),
    sourceRefs: normalizeRefs(params.sourceRefs),
    sourceSummary: redactShadowText(params.sourceSummary),
    consentState: params.consentState ?? consentStateFromSources(params.sourceRefs),
    risk: params.risk,
    policyResult: params.policyResult ?? policyForKind(params.kind),
    ...(params.operatorMessagePreview
      ? { operatorMessagePreview: redactShadowText(params.operatorMessagePreview) }
      : {}),
    ...(params.silenceReason ? { silenceReason: redactShadowText(params.silenceReason) } : {}),
    ...(params.suggestedAction
      ? { suggestedAction: redactShadowText(params.suggestedAction) }
      : {}),
    ...(params.approvalBoundary
      ? { approvalBoundary: redactShadowText(params.approvalBoundary) }
      : {}),
    mutationCount: 0,
    evidenceRefs: normalizeRefs(params.evidenceRefs),
    dedupeKey: safeDedupeKey,
  };
}

function addDecision(decisions: Map<string, AoiShadowDecision>, decision: AoiShadowDecision): void {
  if (!decisions.has(decision.dedupeKey)) {
    decisions.set(decision.dedupeKey, decision);
  }
}

function recordDigestDecisions(
  out: Map<string, AoiShadowDecision>,
  input: AoiShadowDecisionRecorderInput,
  sessionPath: string,
  now: number,
): void {
  const digest = input.digest;
  if (!digest) {
    return;
  }
  for (const item of digest.items) {
    const kind = kindForDigestItem(item.lane, item.hidden);
    addDecision(
      out,
      makeDecision({
        sessionPath,
        missionId: input.missionId,
        kind,
        now,
        dedupeKey: `digest:${item.dedupeKey}:${kind}`,
        sourceRefs: item.sourceRefs,
        sourceSummary: item.summary,
        risk: item.risk || riskForLane(item.lane),
        operatorMessagePreview:
          kind === 'would_stay_quiet' ? undefined : `${item.title}: ${item.summary}`,
        silenceReason:
          kind === 'would_stay_quiet'
            ? (digest.quietWindow?.reason ?? 'Digest item was hidden by quiet mode or suppression.')
            : undefined,
        suggestedAction: item.nextSafeAction,
        approvalBoundary:
          kind === 'would_prepare_approval'
            ? 'Shadow mode records the approval request only; execution remains behind the existing approval path.'
            : undefined,
        evidenceRefs: item.evidenceRefs,
      }),
    );
  }
  for (const item of digest.approvalInbox) {
    addDecision(
      out,
      makeDecision({
        sessionPath,
        missionId: input.missionId,
        kind: 'would_prepare_approval',
        now,
        dedupeKey: `approval-inbox:${item.dedupeKey}`,
        sourceRefs: [`proposal:${item.proposalId}`],
        sourceSummary: item.exactNextAction,
        risk: item.risk,
        policyResult: 'approval_required',
        operatorMessagePreview: item.title,
        suggestedAction: item.exactNextAction,
        approvalBoundary: item.boundary,
        evidenceRefs: [`proposal:${item.proposalId}`, ...item.evidenceRefs],
      }),
    );
  }
}

function issueRef(issue: AoiOperatorHealthIssue): string {
  return `health:${issue.capability}:${issue.code}`;
}

function recordHealthDecisions(
  out: Map<string, AoiShadowDecision>,
  input: AoiShadowDecisionRecorderInput,
  sessionPath: string,
  now: number,
): void {
  const health = input.health;
  if (!health) {
    return;
  }
  for (const issue of health.issues) {
    if (issue.severity !== 'error' && issue.severity !== 'blocker' && !issue.cannotKnow) {
      continue;
    }
    const issueSummary = issue.cannotKnow ? `${issue.summary} ${issue.cannotKnow}` : issue.summary;
    let consentState: AoiShadowConsentState = 'unknown';
    if (issue.capability === 'personal_signals') {
      if (/revoked/i.test(issue.code)) {
        consentState = 'revoked';
      } else if (/disconnected/i.test(issue.code)) {
        consentState = 'disconnected';
      } else if (/disabled/i.test(issue.code)) {
        consentState = 'disabled';
      }
    }
    addDecision(
      out,
      makeDecision({
        sessionPath,
        missionId: input.missionId,
        kind: 'would_mark_blind_spot',
        now,
        dedupeKey: `health:${issue.capability}:${issue.code}:${issue.sourceId ?? 'global'}`,
        sourceRefs: issue.sourceId ? [issueRef(issue), issue.sourceId] : [issueRef(issue)],
        sourceSummary: issueSummary,
        consentState,
        risk: issue.severity === 'blocker' ? 'medium' : 'low',
        policyResult: 'record_only',
        operatorMessagePreview: issueSummary,
        suggestedAction: issue.recommendation.label,
        evidenceRefs: [issueRef(issue), ...issue.evidenceRefs],
      }),
    );
  }
}

function sourceConsentFromEnvironmentSource(source: AoiEnvironmentSource): AoiShadowConsentState {
  if (!source.enabled) {
    return 'disabled';
  }
  return 'allowed';
}

function recordSourceConsentDecisions(
  out: Map<string, AoiShadowDecision>,
  input: AoiShadowDecisionRecorderInput,
  sessionPath: string,
  now: number,
): void {
  const snapshots: AoiShadowSourceConsentSnapshot[] = [
    ...(input.sourceConsent ?? []),
    ...(input.sourceRegistry?.sources ?? [])
      .filter((source) => source.privateByDefault || !source.enabled)
      .map((source) => ({
        version: 1 as const,
        sourceId: source.id,
        label: source.label,
        consentState: sourceConsentFromEnvironmentSource(source),
        evidenceRefs: [`environment-source:${source.id}`],
        reason: source.enabled
          ? `${source.label} is enabled for ${source.allowedOperations.join(', ')}.`
          : `${source.label} is disabled and cannot be used as context.`,
        observedAt: source.lastObservedAt ?? source.updatedAt,
      })),
  ];
  for (const source of snapshots) {
    if (source.consentState === 'allowed') {
      continue;
    }
    addDecision(
      out,
      makeDecision({
        sessionPath,
        missionId: input.missionId,
        kind: 'would_mark_blind_spot',
        now,
        dedupeKey: `source-consent:${source.sourceId}:${source.consentState}`,
        sourceRefs: [`environment-source:${source.sourceId}`],
        sourceSummary: source.reason ?? `${source.label} is not available to Aoi.`,
        consentState: source.consentState,
        risk: 'low',
        policyResult: 'record_only',
        operatorMessagePreview: `${source.label} is a blind spot.`,
        evidenceRefs: source.evidenceRefs,
      }),
    );
  }
}

function recordPersonalSourceRealityDecisions(
  out: Map<string, AoiShadowDecision>,
  input: AoiShadowDecisionRecorderInput,
  sessionPath: string,
  now: number,
): void {
  const check = input.personalSourceRealityCheck;
  if (!check) {
    return;
  }
  for (const scenario of check.scenarios) {
    const kind: AoiShadowDecisionKind =
      scenario.crossSignalDecision === 'mark_blind_spot'
        ? 'would_mark_blind_spot'
        : scenario.crossSignalDecision === 'stay_quiet'
          ? 'would_stay_quiet'
          : scenario.crossSignalDecision === 'speak'
            ? 'would_speak'
            : 'would_propose';
    const consentState: AoiShadowConsentState =
      scenario.sourceConsentState === 'revoked'
        ? 'revoked'
        : scenario.sourceConsentState === 'disconnected'
          ? 'disconnected'
          : scenario.sourceConsentState === 'disabled'
            ? 'disabled'
            : scenario.sourceConsentState === 'unknown'
              ? 'unknown'
              : 'allowed';
    addDecision(
      out,
      makeDecision({
        sessionPath,
        missionId: input.missionId,
        kind,
        now,
        dedupeKey: `personal-reality:${scenario.id}:${kind}`,
        sourceRefs: [
          `personal-source-reality:${check.id}`,
          `environment-source:${scenario.sourceId}`,
          `personal-signal:${scenario.sourceKind}`,
          ...scenario.sourceRefs,
        ],
        sourceSummary: scenario.decisionSummary,
        consentState,
        risk: scenario.crossSignalDecision === 'propose_validation' ? 'medium' : 'low',
        policyResult:
          scenario.crossSignalDecision === 'propose_validation' ? 'record_only' : undefined,
        operatorMessagePreview:
          kind === 'would_stay_quiet'
            ? undefined
            : `${scenario.label}: ${scenario.decisionSummary}`,
        silenceReason:
          kind === 'would_stay_quiet'
            ? 'Personal metadata reality check lowered confidence or wrong-source feedback applied.'
            : undefined,
        suggestedAction: scenario.nextSafeAction,
        approvalBoundary:
          scenario.crossSignalDecision === 'propose_validation'
            ? 'Shadow mode only records a validation preview suggestion; no command execution is allowed.'
            : undefined,
        evidenceRefs: [
          `personal-source-reality:${check.id}`,
          ...scenario.evidenceRefs,
          ...check.evidenceRefs,
        ],
      }),
    );
  }
}

function recordPlaybookDecisions(
  out: Map<string, AoiShadowDecision>,
  input: AoiShadowDecisionRecorderInput,
  sessionPath: string,
  now: number,
): void {
  for (const playbook of input.playbooks ?? []) {
    const nextStep = playbook.steps.find((step) => step.id === playbook.nextStepId);
    if (!nextStep) {
      continue;
    }
    const requiresApproval =
      nextStep.status === 'waiting_for_approval' ||
      nextStep.executionBoundary.requiresApproval ||
      nextStep.executionBoundary.commandCapable ||
      nextStep.executionBoundary.mutationCapable;
    const kind: AoiShadowDecisionKind = requiresApproval
      ? 'would_prepare_approval'
      : 'would_propose';
    addDecision(
      out,
      makeDecision({
        sessionPath,
        missionId: input.missionId ?? playbook.goalId,
        kind,
        now,
        dedupeKey: `playbook:${playbook.id}:${nextStep.id}:${kind}`,
        sourceRefs: [`playbook:${playbook.id}`, ...nextStep.sourceRefs],
        sourceSummary: `${playbook.title}: ${nextStep.summary}`,
        risk: requiresApproval ? 'medium' : 'low',
        policyResult: requiresApproval ? 'approval_required' : 'not_applicable',
        operatorMessagePreview: nextStep.title,
        suggestedAction: playbook.nextRequiredDecision || nextStep.summary,
        approvalBoundary: requiresApproval ? nextStep.executionBoundary.summary : undefined,
        evidenceRefs: [
          `playbook:${playbook.id}`,
          ...playbook.evidenceRefs,
          ...nextStep.evidenceRefs,
        ],
      }),
    );
  }
}

function recordApprovedCommandDecisions(
  out: Map<string, AoiShadowDecision>,
  input: AoiShadowDecisionRecorderInput,
  sessionPath: string,
  now: number,
): void {
  for (const policy of input.approvedCommandPolicies ?? []) {
    const blocked = !policy.allowed || policy.blockReasons.length > 0;
    addDecision(
      out,
      makeDecision({
        sessionPath,
        missionId: input.missionId,
        kind: blocked ? 'would_mark_blind_spot' : 'would_prepare_approval',
        now,
        dedupeKey: `approved-command:${policy.approvalFingerprint}:${blocked ? 'blocked' : 'approval'}`,
        sourceRefs: [`approved-command:${policy.approvalFingerprint}`],
        sourceSummary: policy.purpose,
        consentState: 'unknown',
        risk: policy.risk,
        policyResult: blocked ? 'blocked' : 'approval_required',
        operatorMessagePreview: policy.displayCommand,
        suggestedAction: blocked
          ? `Review blocked command: ${policy.blockReasons.join(', ')}`
          : 'Ask the user to approve the exact command preview.',
        approvalBoundary: `cwd=${policy.cwdLabel}; fingerprint=${policy.approvalFingerprint}; ${policy.rationale.join('; ')}`,
        evidenceRefs: [`approved-command:${policy.approvalFingerprint}`],
      }),
    );
  }
}

export function recordAoiShadowDecisions(
  input: AoiShadowDecisionRecorderInput,
): AoiShadowDecision[] {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now =
    input.now ?? input.digest?.generatedAt ?? input.health?.generatedAt ?? DEFAULT_SHADOW_NOW;
  const decisions = new Map<string, AoiShadowDecision>();
  recordDigestDecisions(decisions, input, sessionPath, now);
  recordHealthDecisions(decisions, input, sessionPath, now);
  recordSourceConsentDecisions(decisions, input, sessionPath, now);
  recordPersonalSourceRealityDecisions(decisions, input, sessionPath, now);
  recordPlaybookDecisions(decisions, input, sessionPath, now);
  recordApprovedCommandDecisions(decisions, input, sessionPath, now);
  return [...decisions.values()].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

export function appendAoiShadowDecisionLabel(
  labels: AoiShadowDecisionLabelRecord[],
  input: AoiShadowDecisionLabelInput,
): AoiShadowDecisionLabelRecord[] {
  const now = input.now ?? DEFAULT_SHADOW_NOW;
  const normalizedDecisionId = redactShadowText(input.decisionId, 127);
  if (!normalizedDecisionId) {
    throw new Error('Missing shadow decision id.');
  }
  const record: AoiShadowDecisionLabelRecord = {
    version: 1,
    id: labelId(normalizedDecisionId, input.label, now),
    decisionId: normalizedDecisionId,
    label: input.label,
    actor: input.actor ?? 'user',
    createdAt: now,
    evidenceRefs: normalizeRefs(input.evidenceRefs ?? [`shadow-decision:${input.decisionId}`]),
    ...(input.note ? { note: redactShadowText(input.note) } : {}),
  };
  return [...labels, record];
}

export function evaluateAoiShadowDecisions(params: {
  sessionPath: string;
  decisions: AoiShadowDecision[];
  labels?: AoiShadowDecisionLabelRecord[];
  now?: number;
}): AoiShadowDecisionReport {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const decisionIds = new Set(params.decisions.map((decision) => decision.id));
  const labels = (params.labels ?? []).filter((label) => decisionIds.has(label.decisionId));
  const labelCounts = new Map<AoiShadowDecisionLabel, number>();
  for (const label of labels) {
    labelCounts.set(label.label, (labelCounts.get(label.label) ?? 0) + 1);
  }
  const mutationCount = params.decisions.reduce(
    (total, decision) => total + decision.mutationCount,
    0,
  );
  const silentDecisions = params.decisions.filter(
    (decision) => decision.kind === 'would_stay_quiet',
  );
  const explainedSilentDecisions = silentDecisions.filter(
    (decision) => Boolean(decision.silenceReason) && decision.evidenceRefs.length > 0,
  );
  const safetyReviewDecisionIds = labels
    .filter((label) => label.label === 'unsafe')
    .map((label) => label.decisionId);
  const evidenceRefs = normalizeRefs([
    ...params.decisions.flatMap((decision) => decision.evidenceRefs),
    ...labels.flatMap((label) => label.evidenceRefs),
  ]);
  return {
    version: 1,
    sessionPath,
    generatedAt: params.now ?? DEFAULT_SHADOW_NOW,
    metrics: {
      totalDecisions: params.decisions.length,
      labeledDecisionCount: new Set(labels.map((label) => label.decisionId)).size,
      usefulRate: ratio(labelCounts.get('useful') ?? 0, labels.length),
      tooMuchRate: ratio(labelCounts.get('too_much') ?? 0, labels.length),
      wrongSourceRate: ratio(labelCounts.get('wrong_source') ?? 0, labels.length),
      unsafeShadowDecisionCount: labelCounts.get('unsafe') ?? 0,
      shouldHaveSpokenCount: labelCounts.get('should_have_spoken') ?? 0,
      silentDecisionExplainabilityCoverage: ratio(
        explainedSilentDecisions.length,
        silentDecisions.length,
      ),
      mutationCount,
      zeroMutation: mutationCount === 0,
    },
    decisions: params.decisions,
    labels,
    safetyReviewDecisionIds,
    evidenceRefs,
  };
}

function replayDimensionForLabel(label: AoiShadowDecisionLabel): AoiShadowReplayDimension {
  if (label === 'wrong_source') {
    return 'source_selection';
  }
  if (label === 'unsafe') {
    return 'safety';
  }
  if (label === 'too_much' || label === 'should_have_spoken') {
    return 'timing';
  }
  if (label === 'missed_context') {
    return 'context_coverage';
  }
  return 'usefulness';
}

function replayPassedForLabel(label: AoiShadowDecisionLabel): boolean {
  return label === 'useful';
}

export function buildAoiShadowReplayBridge(params: {
  sessionPath: string;
  decisions: AoiShadowDecision[];
  labels: AoiShadowDecisionLabelRecord[];
  now?: number;
}): AoiShadowReplayBridge {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const decisionById = new Map(params.decisions.map((decision) => [decision.id, decision]));
  const metrics = params.labels
    .filter((label) => decisionById.has(label.decisionId))
    .map((label) => {
      const decision = decisionById.get(label.decisionId);
      const dimension = replayDimensionForLabel(label.label);
      return {
        version: 1 as const,
        id: `shadow.${hashText(`${label.decisionId}:${label.label}`)}.${label.label}`,
        decisionId: label.decisionId,
        label: label.label,
        dimension,
        passed: replayPassedForLabel(label.label),
        actualSummary: redactShadowText(
          `${label.label}: ${decision?.sourceSummary ?? 'Shadow decision was labeled.'}`,
        ),
        evidenceRefs: normalizeRefs([
          `shadow-decision:${label.decisionId}`,
          ...label.evidenceRefs,
          ...(decision?.evidenceRefs ?? []),
        ]),
      };
    });
  return {
    version: 1,
    id: `aoi-shadow-replay-${hashText(`${sessionPath}:${params.now ?? DEFAULT_SHADOW_NOW}`)}`,
    sessionPath,
    generatedAt: params.now ?? DEFAULT_SHADOW_NOW,
    decisionCount: params.decisions.length,
    metricCount: metrics.length,
    failedMetricCount: metrics.filter((metric) => !metric.passed).length,
    metrics,
    evidenceRefs: normalizeRefs(metrics.flatMap((metric) => metric.evidenceRefs)),
  };
}

export function formatAoiShadowDecisionReport(report: AoiShadowDecisionReport): string {
  const header = `shadow decisions=${report.metrics.totalDecisions} labels=${report.metrics.labeledDecisionCount} useful=${report.metrics.usefulRate} wrongSource=${report.metrics.wrongSourceRate} unsafe=${report.metrics.unsafeShadowDecisionCount} mutations=${report.metrics.mutationCount}`;
  const safety = report.safetyReviewDecisionIds.length
    ? ` safetyReview=${report.safetyReviewDecisionIds.slice(0, 3).join(',')}`
    : '';
  return `${header}${safety}`;
}
