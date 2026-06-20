import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';
import {
  containsAoiSensitiveContent,
  redactAoiSensitiveContent,
  stripAoiSourceInstructions,
} from './aoiMemoryShared';
import {
  createAoiReplayFixtureDraftFromTraceExport,
  type AoiOperatorReplayFixtureDraftResult,
} from './aoiOperatorTimeline';
import type {
  AoiFieldShadowDecisionRecord,
  AoiFieldShadowRecordReport,
} from './aoiFieldShadowDogfooding';
import type { AoiOperatorFeedbackLabelAction } from './aoiOperatorFeedbackInbox';
import type { AoiOperatorTimelineEvent, AoiOperatorTraceExport } from './aoiAutonomyTypes';
import type { AoiShadowDecisionLabel } from './aoiShadowModeEvaluation';

const DEFAULT_CURATION_NOW = 1_800_000_000_000;
const MAX_TEXT = 220;
const MAX_REFS = 24;

const LABELS: readonly AoiShadowDecisionLabel[] = [
  'useful',
  'too_much',
  'too_frequent',
  'wrong_source',
  'wrong_timing',
  'unsafe',
  'missed_context',
  'should_have_spoken',
  'show_more',
  'show_less',
  'mute_topic',
  'pin_topic',
];

const CURATABLE_LABELS = new Set<AoiShadowDecisionLabel>([
  'useful',
  'wrong_source',
  'unsafe',
  'missed_context',
  'should_have_spoken',
  'show_more',
  'pin_topic',
]);

const FAILURE_LABELS = new Set<AoiShadowDecisionLabel>([
  'too_much',
  'too_frequent',
  'wrong_source',
  'wrong_timing',
  'unsafe',
  'missed_context',
  'should_have_spoken',
  'show_less',
  'mute_topic',
]);

export type AoiAdaptiveAcceptanceDimension =
  | 'usefulness'
  | 'timing'
  | 'source_selection'
  | 'safety'
  | 'context_coverage'
  | 'privacy'
  | 'mission_continuity';

export type AoiAdaptiveAcceptancePrivacyStatus = 'passed' | 'needs_review' | 'blocked';

export type AoiAdaptiveAcceptanceReplayDraftStatus =
  | 'draft'
  | 'blocked'
  | 'deferred'
  | 'promoted_candidate';

export type AoiAdaptiveAcceptanceReviewStatus =
  | 'needs_review'
  | 'approved'
  | 'deferred'
  | 'rejected';

export type AoiAdaptiveAcceptanceMetricName =
  | 'candidate_count'
  | 'privacy_gate'
  | 'replay_draft'
  | 'prior_failure_catch'
  | 'missing_evidence';

export type AoiAdaptiveAcceptancePolicyEffect = 'no_policy_change' | 'tighten_only';

export interface AoiAdaptiveAcceptanceReviewState {
  version: 1;
  candidateId?: string;
  decisionRecordId?: string;
  labelId?: string;
  status: AoiAdaptiveAcceptanceReviewStatus;
  reviewedAt: number;
  evidenceRefs: string[];
  reason?: string;
}

export interface AoiAdaptiveAcceptanceMissingEvidenceReason {
  version: 1;
  reason: string;
  count: number;
  evidenceRefs: string[];
}

export interface AoiAdaptiveAcceptanceMetric {
  version: 1;
  id: string;
  name: AoiAdaptiveAcceptanceMetricName;
  passed: boolean;
  value: number;
  total?: number;
  dimension?: AoiAdaptiveAcceptanceDimension;
  label?: AoiShadowDecisionLabel;
  summary: string;
  evidenceRefs: string[];
}

export interface AoiAdaptiveAcceptanceCandidate {
  version: 1;
  id: string;
  sessionPath: string;
  createdAt: number;
  sourceDecisionRecordIds: string[];
  sourceDecisionIds: string[];
  labelIds: string[];
  traceExportIds: string[];
  timelineEventIds: string[];
  labelCategory: AoiShadowDecisionLabel;
  acceptanceDimension: AoiAdaptiveAcceptanceDimension;
  privacyStatus: AoiAdaptiveAcceptancePrivacyStatus;
  privacyWarnings: string[];
  replayDraftStatus: AoiAdaptiveAcceptanceReplayDraftStatus;
  reviewStatus: AoiAdaptiveAcceptanceReviewStatus;
  sourceSummary: string;
  failureOrSuccessReason: string;
  wouldCatchPriorFailure: boolean;
  catchFailureReason: string;
  policyEffect: AoiAdaptiveAcceptancePolicyEffect;
  policyRelaxed: false;
  missingEvidenceReasons: string[];
  todoExpectations: string[];
  warnings: string[];
  evidenceRefs: string[];
  replayDraft?: AoiOperatorReplayFixtureDraftResult;
  mutationCount: 0;
}

export interface AoiAdaptiveAcceptancePack {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  candidateCount: number;
  privacyPassCount: number;
  privacyNeedsReviewCount: number;
  privacyFailCount: number;
  replayDraftCount: number;
  blockedCandidateCount: number;
  deferredCandidateCount: number;
  promotedCandidateCount: number;
  wouldCatchPriorFailureCount: number;
  countsByLabel: Record<AoiShadowDecisionLabel, number>;
  countsByDimension: Record<AoiAdaptiveAcceptanceDimension, number>;
  countsByPrivacyStatus: Record<AoiAdaptiveAcceptancePrivacyStatus, number>;
  topMissingEvidenceReasons: AoiAdaptiveAcceptanceMissingEvidenceReason[];
  metrics: AoiAdaptiveAcceptanceMetric[];
  candidates: AoiAdaptiveAcceptanceCandidate[];
  evidenceRefs: string[];
  mutationCount: 0;
}

export interface AoiAdaptiveAcceptancePackInput {
  sessionPath: string;
  records?: AoiFieldShadowDecisionRecord[];
  fieldShadowReport?: AoiFieldShadowRecordReport | null;
  labelActions: AoiOperatorFeedbackLabelAction[];
  traceExports: AoiOperatorTraceExport[];
  reviewStates?: AoiAdaptiveAcceptanceReviewState[];
  now?: number;
  limit?: number;
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 12);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars = MAX_TEXT): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function sanitizeCurationText(value: unknown, maxChars = MAX_TEXT): string {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value))
      .replace(
        /\b(?:do not leak|private|raw|full|secret)[^.!?\n]{0,120}\b(?:mail|email|calendar|event|note|message)?\s*body[^.!?\n]*(?:[.!?]|$)/gi,
        '[redacted]',
      )
      .replace(
        /\b(body|content|snippet|transcript|messageBody|rawText|calendarBody|noteContent)\s*[:=]\s*[^.;\n]{6,}/gi,
        '$1=[redacted]',
      )
      .replace(
        /\[(?:redacted-)?private-body\]|\[private body withheld\]|\[redacted-body\]/gi,
        '[redacted]',
      )
      .replace(/\b[A-Z]:\\[^\s'"`<>|]+/gi, '[local-path]')
      .replace(/\\\\[^\s'"`<>|]+/g, '[local-path]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
      .replace(/https?:\/\/[^\s'"`<>]+/gi, '[url]'),
  );
  return truncate(normalized, maxChars);
}

function uniqueStrings(values: Array<string | undefined | null>, maxItems = MAX_REFS): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = sanitizeCurationText(value ?? '', 220);
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

function makeLabelCount(): Record<AoiShadowDecisionLabel, number> {
  return LABELS.reduce(
    (out, label) => {
      out[label] = 0;
      return out;
    },
    {} as Record<AoiShadowDecisionLabel, number>,
  );
}

function makeDimensionCount(): Record<AoiAdaptiveAcceptanceDimension, number> {
  return {
    usefulness: 0,
    timing: 0,
    source_selection: 0,
    safety: 0,
    context_coverage: 0,
    privacy: 0,
    mission_continuity: 0,
  };
}

function makePrivacyCount(): Record<AoiAdaptiveAcceptancePrivacyStatus, number> {
  return {
    passed: 0,
    needs_review: 0,
    blocked: 0,
  };
}

function dimensionForLabel(
  label: AoiShadowDecisionLabel,
  record: AoiFieldShadowDecisionRecord,
): AoiAdaptiveAcceptanceDimension {
  if (label === 'wrong_source') {
    return 'source_selection';
  }
  if (label === 'unsafe') {
    return 'safety';
  }
  if (label === 'missed_context') {
    return 'context_coverage';
  }
  if (
    label === 'too_much' ||
    label === 'too_frequent' ||
    label === 'wrong_timing' ||
    label === 'show_less' ||
    label === 'mute_topic' ||
    label === 'should_have_spoken'
  ) {
    return 'timing';
  }
  if (record.subsystemOrigin === 'mission_memory') {
    return 'mission_continuity';
  }
  if (
    record.subsystemOrigin === 'source_consent' ||
    record.subsystemOrigin === 'personal_source_reality'
  ) {
    return 'privacy';
  }
  return 'usefulness';
}

function reasonForLabel(
  label: AoiShadowDecisionLabel,
  record: AoiFieldShadowDecisionRecord,
): string {
  if (label === 'useful' || label === 'show_more' || label === 'pin_topic') {
    return sanitizeCurationText(
      `Useful field example: ${record.decisionKind.replace(/_/g, ' ')} was worth preserving without turning it into a permanent preference.`,
      220,
    );
  }
  if (label === 'wrong_source') {
    return 'Wrong-source field example: replay should catch source selection that looked plausible but was not grounded enough.';
  }
  if (label === 'unsafe') {
    return 'Unsafe field example: replay should preserve approval strictness and only tighten gates.';
  }
  if (label === 'missed_context') {
    return 'Missed-context field example: replay should catch missing evidence or stale context before Aoi speaks.';
  }
  if (label === 'should_have_spoken') {
    return 'Timing field example: replay should catch an overly quiet decision when Aoi should have spoken.';
  }
  if (label === 'too_frequent' || label === 'show_less' || label === 'mute_topic') {
    return 'Timing field example: replay should lower delivery pressure without changing execution permissions.';
  }
  if (label === 'wrong_timing') {
    return 'Timing field example: replay should catch a correct idea surfaced at the wrong time.';
  }
  return 'Timing field example: replay should catch excessive interruption pressure.';
}

function isSyntheticPrivateLabel(value: string): boolean {
  return /^\[(?:email|url|path|local-path|redacted-field|personal-metadata):\d+\]$/i.test(value);
}

function inspectRawPrivateText(value: string): string[] {
  const warnings: string[] = [];
  if (/\b[A-Za-z]:(?:[\\/][^\s'"`<>|]+)+/.test(value) || /\\\\[^\s'"`<>|]+/.test(value)) {
    warnings.push('raw local path remains in candidate source');
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) {
    warnings.push('raw email remains in candidate source');
  }
  if (/\bhttps?:\/\/[^\s'"`<>]+/i.test(value)) {
    warnings.push('raw URL remains in candidate source');
  }
  if (containsAoiSensitiveContent(value)) {
    warnings.push('secret-like token remains in candidate source');
  }
  if (
    /\b(?:do not leak|private|raw|full|secret)[^.!?\n]{0,120}\b(?:mail|email|calendar|event|note|message)?\s*body/i.test(
      value,
    ) ||
    /\[(?:redacted-)?private-body\]|\[private body withheld\]|\[redacted-body\]/i.test(value) ||
    /\b(?:calendar|note|mail|email|message)\s+(?:body|content)\s*[:=]/i.test(value) ||
    /\b(?:stdout|stderr|command output)\s*[:=]/i.test(value)
  ) {
    warnings.push('body-like or raw output marker remains in candidate source');
  }
  return warnings;
}

function inspectMetadataValue(key: string, value: unknown): string[] {
  const warnings: string[] = [];
  const normalizedKey = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const bodyLikeKey = /(?:body|content|message|raw|stdout|stderr|output|commandoutput)/i.test(
    normalizedKey,
  );
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (typeof item !== 'string') {
      continue;
    }
    if (bodyLikeKey && item.trim() && !isSyntheticPrivateLabel(item.trim())) {
      warnings.push(`metadata.${sanitizeCurationText(key, 40)} contains body-like output text`);
    }
    warnings.push(...inspectRawPrivateText(item));
  }
  return warnings;
}

function hasValidRedactionSummary(traceExport: AoiOperatorTraceExport): boolean {
  const summary = traceExport.redactionSummary;
  return (
    Boolean(summary) &&
    typeof summary.totalReplacementCount === 'number' &&
    typeof summary.localPathCount === 'number' &&
    typeof summary.urlCount === 'number' &&
    typeof summary.emailCount === 'number' &&
    typeof summary.privateFieldCount === 'number' &&
    Boolean(summary.syntheticLabels) &&
    typeof summary.syntheticLabels === 'object'
  );
}

function privacyForCandidate(params: {
  record: AoiFieldShadowDecisionRecord;
  label: AoiOperatorFeedbackLabelAction;
  traces: AoiOperatorTraceExport[];
}): { status: AoiAdaptiveAcceptancePrivacyStatus; warnings: string[] } {
  const warnings: string[] = [];
  warnings.push(
    ...inspectRawPrivateText(
      [
        params.record.sourceSummary,
        params.record.operatorMessagePreview,
        params.record.silenceReason,
        params.record.suggestedAction,
        params.record.approvalBoundary,
        params.label.note,
      ]
        .filter((item): item is string => typeof item === 'string')
        .join(' '),
    ),
  );
  if (params.traces.length <= 0) {
    warnings.push('no related redacted trace export found');
  }
  for (const trace of params.traces) {
    if (!hasValidRedactionSummary(trace)) {
      warnings.push('trace export is missing a structured redaction summary');
    }
    warnings.push(...inspectRawPrivateText(JSON.stringify(trace.events)));
    if (trace.events.some((event) => event.redactionState === 'removed')) {
      warnings.push('trace export contains removed timeline events');
    }
    for (const event of trace.events) {
      for (const [key, value] of Object.entries(event.metadata ?? {})) {
        warnings.push(...inspectMetadataValue(key, value));
      }
    }
  }

  const uniqueWarnings = uniqueStrings(warnings, 12);
  if (
    uniqueWarnings.some((warning) =>
      /raw|secret|body|output|local path|email|URL|metadata\.|missing a structured redaction/i.test(
        warning,
      ),
    )
  ) {
    return {
      status: 'blocked',
      warnings: uniqueWarnings,
    };
  }
  if (uniqueWarnings.length > 0) {
    return {
      status: 'needs_review',
      warnings: uniqueWarnings,
    };
  }
  return {
    status: 'passed',
    warnings: [],
  };
}

function eventRefs(event: AoiOperatorTimelineEvent): string[] {
  return [
    event.id,
    `timeline:${event.id}`,
    event.sourceRef,
    event.sourceKind,
    event.proposalId ? `proposal:${event.proposalId}` : undefined,
    event.decisionId ? `decision:${event.decisionId}` : undefined,
    event.commandAuditId ? `approved-command:${event.commandAuditId}` : undefined,
    ...event.evidenceRefs,
    ...event.relatedRefs,
  ].filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function traceRefs(traceExport: AoiOperatorTraceExport): string[] {
  return [
    traceExport.id,
    `trace-export:${traceExport.id}`,
    ...traceExport.sourceEventIds.map((id) => `timeline:${id}`),
    ...traceExport.events.flatMap(eventRefs),
  ];
}

function traceMatchesFieldLabel(params: {
  traceExport: AoiOperatorTraceExport;
  record: AoiFieldShadowDecisionRecord;
  label: AoiOperatorFeedbackLabelAction;
}): boolean {
  const refs = new Set(traceRefs(params.traceExport));
  const needles = uniqueStrings(
    [
      params.record.id,
      params.record.decisionId,
      params.label.id,
      `field-shadow-record:${params.record.id}`,
      `field-shadow-decision:${params.record.decisionId}`,
      `shadow-decision:${params.record.decisionId}`,
      `operator-feedback:${params.label.id}`,
      ...params.record.evidenceRefs,
      ...params.record.sourceRefs,
      ...params.label.evidenceRefs,
    ],
    32,
  );
  return needles.some((needle) => refs.has(needle));
}

function relatedTraceExports(params: {
  record: AoiFieldShadowDecisionRecord;
  label: AoiOperatorFeedbackLabelAction;
  traceExports: AoiOperatorTraceExport[];
}): AoiOperatorTraceExport[] {
  return params.traceExports
    .filter(
      (traceExport) =>
        traceExport.sessionPath === params.record.sessionPath &&
        traceMatchesFieldLabel({
          traceExport,
          record: params.record,
          label: params.label,
        }),
    )
    .sort((left, right) => right.exportedAt - left.exportedAt || left.id.localeCompare(right.id));
}

function missingEvidenceReasons(params: {
  record: AoiFieldShadowDecisionRecord;
  label: AoiOperatorFeedbackLabelAction;
  traces: AoiOperatorTraceExport[];
}): string[] {
  const reasons: string[] = [];
  if (params.record.evidenceRefs.length <= 0) {
    reasons.push('field shadow record has no evidence refs');
  }
  if (params.label.evidenceRefs.length <= 0) {
    reasons.push('operator feedback label has no evidence refs');
  }
  if (params.traces.length <= 0) {
    reasons.push('no related trace export matched the field decision');
  }
  if (params.traces.some((trace) => trace.events.length <= 0)) {
    reasons.push('related trace export has no timeline events');
  }
  if (
    params.traces.some((trace) => trace.events.every((event) => event.evidenceRefs.length <= 0))
  ) {
    reasons.push('related trace export has no event evidence refs');
  }
  return uniqueStrings(reasons, 8);
}

function candidateId(params: {
  sessionPath: string;
  recordId: string;
  labelId: string;
  traceIds: string[];
  dimension: AoiAdaptiveAcceptanceDimension;
}): string {
  return `aoi-adaptive-acceptance-${hashText(
    `${params.sessionPath}:${params.recordId}:${params.labelId}:${params.traceIds.join('|')}:${params.dimension}`,
  )}`;
}

function reviewStateForCandidate(params: {
  candidateId: string;
  record: AoiFieldShadowDecisionRecord;
  label: AoiOperatorFeedbackLabelAction;
  reviewStates: AoiAdaptiveAcceptanceReviewState[];
}): AoiAdaptiveAcceptanceReviewState | undefined {
  return params.reviewStates
    .filter(
      (state) =>
        state.candidateId === params.candidateId ||
        state.labelId === params.label.id ||
        state.decisionRecordId === params.record.id,
    )
    .sort((left, right) => right.reviewedAt - left.reviewedAt)[0];
}

function buildReplayDraft(params: {
  candidateId: string;
  trace: AoiOperatorTraceExport | undefined;
  dimension: AoiAdaptiveAcceptanceDimension;
  label: AoiShadowDecisionLabel;
  privacyStatus: AoiAdaptiveAcceptancePrivacyStatus;
  missingEvidence: string[];
}): AoiOperatorReplayFixtureDraftResult | undefined {
  if (!params.trace || params.privacyStatus === 'blocked' || params.missingEvidence.length > 0) {
    return undefined;
  }
  return createAoiReplayFixtureDraftFromTraceExport(params.trace, {
    fixtureId: `adaptive-acceptance-${params.candidateId.replace(/^aoi-adaptive-acceptance-/, '')}`,
    title: `TODO ${params.dimension} ${params.label} adaptive acceptance candidate`,
    latestUserMessage:
      'TODO: write a synthetic operator prompt that recreates this field evidence without private data.',
  });
}

function replayDraftStatus(params: {
  privacyStatus: AoiAdaptiveAcceptancePrivacyStatus;
  missingEvidence: string[];
  replayDraft: AoiOperatorReplayFixtureDraftResult | undefined;
  reviewStatus: AoiAdaptiveAcceptanceReviewStatus;
}): AoiAdaptiveAcceptanceReplayDraftStatus {
  if (params.privacyStatus === 'blocked' || params.missingEvidence.length > 0) {
    return 'blocked';
  }
  if (params.reviewStatus === 'deferred' || params.reviewStatus === 'rejected') {
    return 'deferred';
  }
  if (params.reviewStatus === 'approved' && params.replayDraft) {
    return 'promoted_candidate';
  }
  return params.replayDraft ? 'draft' : 'blocked';
}

function buildCandidate(params: {
  record: AoiFieldShadowDecisionRecord;
  label: AoiOperatorFeedbackLabelAction;
  traces: AoiOperatorTraceExport[];
  reviewStates: AoiAdaptiveAcceptanceReviewState[];
  now: number;
}): AoiAdaptiveAcceptanceCandidate {
  const dimension = dimensionForLabel(params.label.label, params.record);
  const traceIds = params.traces.map((trace) => trace.id);
  const id = candidateId({
    sessionPath: params.record.sessionPath,
    recordId: params.record.id,
    labelId: params.label.id,
    traceIds,
    dimension,
  });
  const reviewState = reviewStateForCandidate({
    candidateId: id,
    record: params.record,
    label: params.label,
    reviewStates: params.reviewStates,
  });
  const reviewStatus = reviewState?.status ?? 'needs_review';
  const privacy = privacyForCandidate({
    record: params.record,
    label: params.label,
    traces: params.traces,
  });
  const missingEvidence = missingEvidenceReasons({
    record: params.record,
    label: params.label,
    traces: params.traces,
  });
  if (reviewStatus === 'approved' && (reviewState?.evidenceRefs.length ?? 0) <= 0) {
    missingEvidence.push('approved review state has no evidence refs');
  }
  const replayDraft = buildReplayDraft({
    candidateId: id,
    trace: params.traces[0],
    dimension,
    label: params.label.label,
    privacyStatus: privacy.status,
    missingEvidence,
  });
  const draftStatus = replayDraftStatus({
    privacyStatus: privacy.status,
    missingEvidence,
    replayDraft,
    reviewStatus,
  });
  const timelineEventIds = uniqueStrings(
    params.traces.flatMap((trace) => trace.events.map((event) => event.id)),
    32,
  );
  const evidenceRefs = uniqueStrings(
    [
      `field-shadow-record:${params.record.id}`,
      `field-shadow-decision:${params.record.decisionId}`,
      `operator-feedback:${params.label.id}`,
      ...params.record.evidenceRefs,
      ...params.label.evidenceRefs,
      ...params.traces.map((trace) => `trace-export:${trace.id}`),
      ...params.traces.flatMap((trace) => trace.events.flatMap((event) => event.evidenceRefs)),
      ...(reviewState?.evidenceRefs ?? []),
    ],
    MAX_REFS,
  );
  const wouldCatchPriorFailure =
    FAILURE_LABELS.has(params.label.label) && Boolean(replayDraft) && draftStatus !== 'blocked';
  const policyEffect = params.label.label === 'unsafe' ? 'tighten_only' : 'no_policy_change';

  return {
    version: 1,
    id,
    sessionPath: params.record.sessionPath,
    createdAt: params.now,
    sourceDecisionRecordIds: [params.record.id],
    sourceDecisionIds: [params.record.decisionId],
    labelIds: [params.label.id],
    traceExportIds: traceIds,
    timelineEventIds,
    labelCategory: params.label.label,
    acceptanceDimension: dimension,
    privacyStatus: privacy.status,
    privacyWarnings: privacy.warnings,
    replayDraftStatus: draftStatus,
    reviewStatus,
    sourceSummary: sanitizeCurationText(params.record.sourceSummary, 220),
    failureOrSuccessReason: reasonForLabel(params.label.label, params.record),
    wouldCatchPriorFailure,
    catchFailureReason: wouldCatchPriorFailure
      ? sanitizeCurationText(
          `Replay draft can catch the ${params.label.label.replace(
            /_/g,
            ' ',
          )} field failure once TODO expectations are replaced.`,
          220,
        )
      : 'Positive or blocked candidate; no prior failure catch is claimed.',
    policyEffect,
    policyRelaxed: false,
    missingEvidenceReasons: missingEvidence,
    todoExpectations: uniqueStrings(
      [
        `Review ${dimension} expectation for ${params.label.label}.`,
        'Replace TODO replay expectations before adding this candidate to built-in fixtures.',
        'Keep this as an adaptive candidate until operator review approves promotion.',
        ...(replayDraft?.todoExpectations ?? []),
      ],
      12,
    ),
    warnings: uniqueStrings(
      [
        ...privacy.warnings,
        ...missingEvidence,
        ...(reviewStatus === 'needs_review'
          ? ['candidate is not promoted without operator review state']
          : []),
        ...(policyEffect === 'tighten_only'
          ? ['unsafe feedback can only tighten approval gates']
          : []),
        ...(replayDraft
          ? [
              ...replayDraft.warnings,
              'Draft output is in memory only; built-in replay fixtures are not modified.',
            ]
          : []),
      ],
      16,
    ),
    evidenceRefs,
    ...(replayDraft ? { replayDraft } : {}),
    mutationCount: 0,
  };
}

function metric(params: {
  id: string;
  name: AoiAdaptiveAcceptanceMetricName;
  passed: boolean;
  value: number;
  total?: number;
  dimension?: AoiAdaptiveAcceptanceDimension;
  label?: AoiShadowDecisionLabel;
  summary: string;
  evidenceRefs: string[];
}): AoiAdaptiveAcceptanceMetric {
  return {
    version: 1,
    id: params.id,
    name: params.name,
    passed: params.passed,
    value: params.value,
    ...(typeof params.total === 'number' ? { total: params.total } : {}),
    ...(params.dimension ? { dimension: params.dimension } : {}),
    ...(params.label ? { label: params.label } : {}),
    summary: sanitizeCurationText(params.summary, 220),
    evidenceRefs: uniqueStrings(params.evidenceRefs, 12),
  };
}

function topMissingEvidenceReasons(
  candidates: AoiAdaptiveAcceptanceCandidate[],
): AoiAdaptiveAcceptanceMissingEvidenceReason[] {
  const byReason = new Map<string, AoiAdaptiveAcceptanceMissingEvidenceReason>();
  for (const candidate of candidates) {
    for (const reason of candidate.missingEvidenceReasons) {
      const current =
        byReason.get(reason) ??
        ({
          version: 1,
          reason,
          count: 0,
          evidenceRefs: [],
        } satisfies AoiAdaptiveAcceptanceMissingEvidenceReason);
      current.count += 1;
      current.evidenceRefs = uniqueStrings([...current.evidenceRefs, ...candidate.evidenceRefs], 8);
      byReason.set(reason, current);
    }
  }
  return [...byReason.values()]
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
    .slice(0, 8);
}

function buildMetrics(
  candidates: AoiAdaptiveAcceptanceCandidate[],
  evidenceRefs: string[],
): AoiAdaptiveAcceptanceMetric[] {
  const privacyFailCount = candidates.filter(
    (candidate) => candidate.privacyStatus === 'blocked',
  ).length;
  const replayDraftCount = candidates.filter(
    (candidate) =>
      candidate.replayDraftStatus === 'draft' ||
      candidate.replayDraftStatus === 'promoted_candidate',
  ).length;
  const missingEvidenceCount = candidates.filter(
    (candidate) => candidate.missingEvidenceReasons.length > 0,
  ).length;
  const wouldCatchPriorFailureCount = candidates.filter(
    (candidate) => candidate.wouldCatchPriorFailure,
  ).length;
  return [
    metric({
      id: 'adaptive-acceptance-candidate-count',
      name: 'candidate_count',
      passed: candidates.length > 0,
      value: candidates.length,
      summary: `${candidates.length} adaptive acceptance candidate(s) built from field labels.`,
      evidenceRefs,
    }),
    metric({
      id: 'adaptive-acceptance-privacy-gate',
      name: 'privacy_gate',
      passed: privacyFailCount === 0,
      value: candidates.length - privacyFailCount,
      total: candidates.length,
      summary: `${privacyFailCount} candidate(s) blocked by privacy gate.`,
      evidenceRefs,
    }),
    metric({
      id: 'adaptive-acceptance-replay-draft',
      name: 'replay_draft',
      passed: replayDraftCount > 0 || candidates.length === 0,
      value: replayDraftCount,
      total: candidates.length,
      summary: `${replayDraftCount} candidate(s) have in-memory replay drafts.`,
      evidenceRefs,
    }),
    metric({
      id: 'adaptive-acceptance-prior-failure-catch',
      name: 'prior_failure_catch',
      passed: wouldCatchPriorFailureCount > 0 || candidates.length === 0,
      value: wouldCatchPriorFailureCount,
      total: candidates.length,
      summary: `${wouldCatchPriorFailureCount} candidate(s) would catch a prior field failure after expectation review.`,
      evidenceRefs,
    }),
    metric({
      id: 'adaptive-acceptance-missing-evidence',
      name: 'missing_evidence',
      passed: missingEvidenceCount === 0,
      value: missingEvidenceCount,
      total: candidates.length,
      summary: `${missingEvidenceCount} candidate(s) are missing required evidence links.`,
      evidenceRefs,
    }),
  ];
}

export function buildAoiAdaptiveAcceptancePack(
  input: AoiAdaptiveAcceptancePackInput,
): AoiAdaptiveAcceptancePack {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const generatedAt = input.now ?? input.fieldShadowReport?.generatedAt ?? DEFAULT_CURATION_NOW;
  const records = (input.fieldShadowReport?.records ?? input.records ?? []).filter(
    (record) => record.sessionPath === sessionPath,
  );
  const recordById = new Map(records.map((record) => [record.id, record]));
  const recordByDecisionId = new Map(records.map((record) => [record.decisionId, record]));
  const labels = input.labelActions
    .filter(
      (label) =>
        label.sessionPath === sessionPath &&
        CURATABLE_LABELS.has(label.label) &&
        (recordById.has(label.decisionRecordId) || recordByDecisionId.has(label.decisionId)),
    )
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const candidates = labels
    .map((label) => {
      const record =
        recordById.get(label.decisionRecordId) ?? recordByDecisionId.get(label.decisionId);
      if (!record) {
        return null;
      }
      const traces = relatedTraceExports({
        record,
        label,
        traceExports: input.traceExports,
      });
      return buildCandidate({
        record,
        label,
        traces,
        reviewStates: input.reviewStates ?? [],
        now: generatedAt,
      });
    })
    .filter((candidate): candidate is AoiAdaptiveAcceptanceCandidate => candidate !== null)
    .sort(
      (left, right) =>
        left.replayDraftStatus.localeCompare(right.replayDraftStatus) ||
        left.acceptanceDimension.localeCompare(right.acceptanceDimension) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, input.limit ?? 80);

  const countsByLabel = makeLabelCount();
  const countsByDimension = makeDimensionCount();
  const countsByPrivacyStatus = makePrivacyCount();
  for (const candidate of candidates) {
    countsByLabel[candidate.labelCategory] += 1;
    countsByDimension[candidate.acceptanceDimension] += 1;
    countsByPrivacyStatus[candidate.privacyStatus] += 1;
  }
  const evidenceRefs = uniqueStrings(
    [
      ...(input.fieldShadowReport?.evidenceRefs ?? []),
      ...candidates.flatMap((candidate) => candidate.evidenceRefs),
    ],
    MAX_REFS,
  );
  const topReasons = topMissingEvidenceReasons(candidates);

  return {
    version: 1,
    id: `aoi-adaptive-acceptance-pack-${hashText(
      `${sessionPath}:${generatedAt}:${candidates.map((candidate) => candidate.id).join('|')}`,
    )}`,
    sessionPath,
    generatedAt,
    candidateCount: candidates.length,
    privacyPassCount: countsByPrivacyStatus.passed,
    privacyNeedsReviewCount: countsByPrivacyStatus.needs_review,
    privacyFailCount: countsByPrivacyStatus.blocked,
    replayDraftCount: candidates.filter(
      (candidate) =>
        candidate.replayDraftStatus === 'draft' ||
        candidate.replayDraftStatus === 'promoted_candidate',
    ).length,
    blockedCandidateCount: candidates.filter(
      (candidate) => candidate.replayDraftStatus === 'blocked',
    ).length,
    deferredCandidateCount: candidates.filter(
      (candidate) => candidate.replayDraftStatus === 'deferred',
    ).length,
    promotedCandidateCount: candidates.filter(
      (candidate) => candidate.replayDraftStatus === 'promoted_candidate',
    ).length,
    wouldCatchPriorFailureCount: candidates.filter((candidate) => candidate.wouldCatchPriorFailure)
      .length,
    countsByLabel,
    countsByDimension,
    countsByPrivacyStatus,
    topMissingEvidenceReasons: topReasons,
    metrics: buildMetrics(candidates, evidenceRefs),
    candidates,
    evidenceRefs,
    mutationCount: 0,
  };
}
