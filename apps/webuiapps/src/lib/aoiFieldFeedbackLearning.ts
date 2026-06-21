import {
  appendAoiFollowThroughEvent,
  loadAoiFieldShadowRecordReport,
  recordAoiOperatorFeedbackLabelAction,
} from './aoiAutonomyStore';
import type {
  AoiFollowThroughEvent,
  AoiFollowThroughLearningSummary,
  AoiOpportunitySourceKind,
} from './aoiAutonomyTypes';
import {
  buildAoiFollowThroughLearningSummary,
  normalizeAoiFollowThroughEvent,
  normalizeAoiFollowThroughKey,
} from './aoiFollowThroughLearning';
import {
  buildAoiFeedbackCompression,
  type AoiFeedbackCompressionResult,
} from './aoiFeedbackCompression';
import {
  appendAoiFieldEvents,
  normalizeAoiFieldEvent,
  type AoiFieldEvent,
  type AoiFieldEventPrivacyState,
} from './aoiFieldEventLedger';
import type {
  AoiFieldShadowDecisionRecord,
  AoiFieldShadowRecordReport,
} from './aoiFieldShadowDogfooding';
import {
  createAoiOperatorFeedbackLabelAction,
  type AoiOperatorFeedbackLabelAction,
  type AoiOperatorFeedbackLabelInput,
} from './aoiOperatorFeedbackInbox';
import type { AoiShadowDecisionLabel } from './aoiShadowModeEvaluation';

const DEFAULT_FIELD_FEEDBACK_NOW = 1_800_000_000_000;
const DEFAULT_FEEDBACK_EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REFS = 24;

export interface AoiFieldFeedbackLearningInput {
  sessionPath: string;
  records?: readonly AoiFieldShadowDecisionRecord[];
  fieldShadowReport?: AoiFieldShadowRecordReport | null;
  labelActions: readonly AoiOperatorFeedbackLabelAction[];
  existingFollowThroughEvents?: readonly AoiFollowThroughEvent[];
  now?: number;
}

export interface AoiFieldFeedbackLearningSummary {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  labelCount: number;
  followThroughEventCount: number;
  positiveLabelCount: number;
  negativeLabelCount: number;
  unsafeLabelCount: number;
  shouldHaveSpokenCount: number;
  topicAdjustmentLabels: string[];
  sourceAdjustmentLabels: string[];
  deliveryAdjustmentLabels: string[];
  cooldownAdjustmentLabels: string[];
  readinessWarningLabels: string[];
  executionPermissionRaised: false;
  actionAuthority: 'display_only';
  mutationCount: 0;
  evidenceRefs: string[];
}

export interface AoiFieldFeedbackLearningResult {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  labelActions: AoiOperatorFeedbackLabelAction[];
  followThroughEvents: AoiFollowThroughEvent[];
  followThroughLearning: AoiFollowThroughLearningSummary;
  fieldEvents: AoiFieldEvent[];
  summary: AoiFieldFeedbackLearningSummary;
  feedbackCompression: AoiFeedbackCompressionResult;
  executionPermissionRaised: false;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiFieldFeedbackRecordResult extends AoiFieldFeedbackLearningResult {
  labelAction: AoiOperatorFeedbackLabelAction;
  appendedFollowThroughEvents: AoiFollowThroughEvent[];
  appendedFieldEvents: AoiFieldEvent[];
}

function normalizeText(value: unknown, maxChars = 220): string {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
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
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value, 220);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function recordsFromInput(input: AoiFieldFeedbackLearningInput): AoiFieldShadowDecisionRecord[] {
  return [...(input.fieldShadowReport?.activeRecords ?? input.records ?? [])].filter(
    (record) => record.sessionPath === input.sessionPath,
  );
}

function recordForLabel(
  records: readonly AoiFieldShadowDecisionRecord[],
  label: AoiOperatorFeedbackLabelAction,
): AoiFieldShadowDecisionRecord | null {
  return (
    records.find(
      (record) => record.id === label.decisionRecordId || record.decisionId === label.decisionId,
    ) ?? null
  );
}

function positiveLabel(label: AoiShadowDecisionLabel): boolean {
  return (
    label === 'useful' ||
    label === 'show_more' ||
    label === 'pin_topic' ||
    label === 'should_have_spoken'
  );
}

function negativeLabel(label: AoiShadowDecisionLabel): boolean {
  return (
    label === 'too_much' ||
    label === 'too_frequent' ||
    label === 'wrong_source' ||
    label === 'wrong_timing' ||
    label === 'unsafe' ||
    label === 'missed_context' ||
    label === 'show_less' ||
    label === 'mute_topic'
  );
}

function actionForLabel(label: AoiShadowDecisionLabel): AoiFollowThroughEvent['action'] {
  if (label === 'unsafe') {
    return 'blocked';
  }
  if (positiveLabel(label)) {
    return 'accepted';
  }
  if (
    label === 'too_much' ||
    label === 'too_frequent' ||
    label === 'wrong_timing' ||
    label === 'show_less'
  ) {
    return 'snoozed';
  }
  return 'dismissed';
}

function resultForLabel(label: AoiShadowDecisionLabel): AoiFollowThroughEvent['result'] {
  if (label === 'unsafe') {
    return 'blocked';
  }
  if (positiveLabel(label)) {
    return 'positive';
  }
  return 'negative';
}

function deliveryModeForLabel(
  label: AoiShadowDecisionLabel,
  record: AoiFieldShadowDecisionRecord | null,
  action: AoiOperatorFeedbackLabelAction,
): AoiFollowThroughEvent['deliveryMode'] {
  if (label === 'should_have_spoken') {
    return 'direct_chat';
  }
  const delivery = action.deliveryMode ?? record?.interruptionDeliveryMode;
  if (
    delivery === 'dashboard' ||
    delivery === 'inline_card' ||
    delivery === 'quiet_notification' ||
    delivery === 'direct_chat' ||
    delivery === 'digest' ||
    delivery === 'chat_hook' ||
    delivery === 'hidden' ||
    delivery === 'blocked'
  ) {
    return delivery;
  }
  if (record?.decisionKind === 'would_speak') {
    return 'direct_chat';
  }
  if (record?.decisionKind === 'would_show_dashboard') {
    return 'dashboard';
  }
  if (record?.decisionKind === 'would_stay_quiet') {
    return 'hidden';
  }
  return 'unknown';
}

function opportunitySourceKindForLabel(
  label: AoiOperatorFeedbackLabelAction,
  record: AoiFieldShadowDecisionRecord | null,
): AoiOpportunitySourceKind {
  const haystack = [
    record?.subsystemOrigin,
    record?.dedupeKey,
    record?.sourceSummary,
    ...(record?.sourceRefs ?? []),
    ...(record?.evidenceRefs ?? []),
    ...label.sourceKinds,
    ...label.evidenceRefs,
  ]
    .join(' ')
    .toLowerCase();
  if (/\bkira\b/.test(haystack)) {
    return 'kira';
  }
  if (/\bworkspace|git|build|validation\b/.test(haystack)) {
    return 'workspace';
  }
  if (/\bresearch|browser|source|trend|brief\b/.test(haystack)) {
    return 'research';
  }
  if (/\bmemory|preference|interest\b/.test(haystack)) {
    return 'memory';
  }
  if (/\bagenda|digest|mission\b/.test(haystack)) {
    return 'agenda';
  }
  if (/\bapp[_ -]?state|interruption|action[_ -]?ladder|voice|playbook\b/.test(haystack)) {
    return 'app_state';
  }
  return 'manual';
}

function topicKeyForLabel(
  label: AoiOperatorFeedbackLabelAction,
  record: AoiFieldShadowDecisionRecord | null,
): string {
  return normalizeAoiFollowThroughKey(
    label.topicKey ?? record?.dedupeKey ?? record?.opportunityId ?? label.decisionRecordId,
  );
}

function sourceKeyForLabel(
  label: AoiOperatorFeedbackLabelAction,
  record: AoiFieldShadowDecisionRecord | null,
): string {
  return normalizeAoiFollowThroughKey(
    label.sourceKey ?? label.sourceKinds[0] ?? record?.subsystemOrigin ?? 'field_feedback',
  );
}

function feedbackEventId(label: AoiOperatorFeedbackLabelAction): string {
  return `aoi-follow-through-field-feedback-${hashText(label.id)}`;
}

function fieldEventId(label: AoiOperatorFeedbackLabelAction): string {
  return `aoi-field-event-feedback-${hashText(label.id)}`;
}

function fieldPrivacyState(record: AoiFieldShadowDecisionRecord | null): AoiFieldEventPrivacyState {
  if (record?.privacyState === 'redacted') {
    return 'redacted';
  }
  if (record?.privacyState === 'metadata_only' || record?.privacyState === 'synthetic') {
    return 'metadata_only';
  }
  if (record?.privacyState === 'unknown') {
    return 'unknown';
  }
  return 'metadata_only';
}

export function buildAoiFollowThroughEventsFromFieldFeedback(
  input: AoiFieldFeedbackLearningInput,
): AoiFollowThroughEvent[] {
  const now = input.now ?? DEFAULT_FIELD_FEEDBACK_NOW;
  const records = recordsFromInput(input);
  const events = input.labelActions
    .map((label) => {
      const record = recordForLabel(records, label);
      const event = normalizeAoiFollowThroughEvent(
        {
          id: feedbackEventId(label),
          sessionPath: input.sessionPath,
          opportunityId: label.opportunityId ?? record?.opportunityId ?? label.decisionId,
          sourceKind: opportunitySourceKindForLabel(label, record),
          topicKey: topicKeyForLabel(label, record),
          sourceKey: sourceKeyForLabel(label, record),
          deliveryMode: deliveryModeForLabel(label.label, record, label),
          action: actionForLabel(label.label),
          result: resultForLabel(label.label),
          feedbackCategory: label.label,
          learningSignalKind: 'explicit_label',
          confidence: 0.84,
          trustIncreaseEligible: true,
          timingLabel: `operator field feedback ${label.label}`,
          evidenceRefs: uniqueStrings(
            [
              `operator-feedback:${label.id}`,
              `field-shadow-record:${label.decisionRecordId}`,
              `field-shadow-decision:${label.decisionId}`,
              ...(label.fieldEventId ? [`field-event:${label.fieldEventId}`] : []),
              ...(record?.fieldEventId ? [`field-event:${record.fieldEventId}`] : []),
              ...(record?.evidenceRefs ?? []),
              ...label.evidenceRefs,
            ],
            MAX_REFS,
          ),
          createdAt: label.createdAt || now,
        },
        input.sessionPath,
        now,
      );
      return event;
    })
    .filter((event): event is AoiFollowThroughEvent => event !== null);
  return [...events].sort(
    (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
}

export function buildAoiFieldFeedbackEvents(input: AoiFieldFeedbackLearningInput): AoiFieldEvent[] {
  const now = input.now ?? DEFAULT_FIELD_FEEDBACK_NOW;
  const records = recordsFromInput(input);
  return input.labelActions.map((label) => {
    const record = recordForLabel(records, label);
    const event = normalizeAoiFieldEvent(
      {
        id: fieldEventId(label),
        sessionPath: input.sessionPath,
        category: 'feedback_recorded',
        summary: `Operator labeled ${record?.decisionKind ?? 'field decision'} as ${label.label}.`,
        sourceRefs: uniqueStrings(
          [
            `operator-feedback:${label.id}`,
            `field-shadow-record:${label.decisionRecordId}`,
            `field-shadow-decision:${label.decisionId}`,
            ...(label.fieldEventId ? [`field-event:${label.fieldEventId}`] : []),
            ...(record?.fieldEventId ? [`field-event:${record.fieldEventId}`] : []),
            ...(record?.sourceRefs ?? []),
          ],
          MAX_REFS,
        ),
        evidenceRefs: uniqueStrings(
          [`operator-feedback:${label.id}`, ...label.evidenceRefs, ...(record?.evidenceRefs ?? [])],
          MAX_REFS,
        ),
        privacyState: fieldPrivacyState(record),
        cannotKnow: uniqueStrings(
          [
            ...(record?.cannotKnow ?? []),
            label.label === 'unsafe'
              ? 'Unsafe feedback can only tighten future gates; it cannot grant execution authority.'
              : undefined,
            positiveLabel(label.label)
              ? 'Positive feedback can tune ranking only; freshness, opt-in, quiet mode, and approval gates still apply.'
              : undefined,
          ],
          12,
        ),
        createdAt: label.createdAt || now,
        expiresAt: (label.createdAt || now) + DEFAULT_FEEDBACK_EVENT_TTL_MS,
        signalIds: [label.id, label.decisionId],
        dedupeKey: `operator-feedback:${label.id}`,
      },
      input.sessionPath,
      now,
    );
    if (!event) {
      throw new Error('Invalid Aoi field feedback event.');
    }
    return event;
  });
}

function buildSummary(params: {
  input: AoiFieldFeedbackLearningInput;
  labels: readonly AoiOperatorFeedbackLabelAction[];
  followThroughEvents: readonly AoiFollowThroughEvent[];
  learning: AoiFollowThroughLearningSummary;
  fieldEvents: readonly AoiFieldEvent[];
  feedbackCompression: AoiFeedbackCompressionResult;
  now: number;
}): AoiFieldFeedbackLearningSummary {
  const readinessWarningLabels = uniqueStrings(
    [
      ...params.labels
        .filter((label) => label.label === 'wrong_source' || label.label === 'unsafe')
        .map(
          (label) =>
            `${label.label.replace(/_/g, ' ')} feedback tightens future source/action gates.`,
        ),
      ...params.labels
        .filter((label) => positiveLabel(label.label))
        .map(
          (label) =>
            `${label.label.replace(/_/g, ' ')} feedback cannot bypass quiet mode, source freshness, direct-chat opt-in, or approval gates.`,
        ),
      'Operator feedback has display-only authority and never raises execution permission.',
      ...params.feedbackCompression.trustIncreaseBlockedReasons.map(
        (reason) => `Feedback compression: ${reason}.`,
      ),
    ],
    8,
  );
  return {
    version: 1,
    sessionPath: params.input.sessionPath,
    generatedAt: params.now,
    labelCount: params.labels.length,
    followThroughEventCount: params.followThroughEvents.length,
    positiveLabelCount: params.labels.filter((label) => positiveLabel(label.label)).length,
    negativeLabelCount: params.labels.filter((label) => negativeLabel(label.label)).length,
    unsafeLabelCount: params.labels.filter((label) => label.label === 'unsafe').length,
    shouldHaveSpokenCount: params.labels.filter((label) => label.label === 'should_have_spoken')
      .length,
    topicAdjustmentLabels: uniqueStrings(
      [
        ...params.learning.topicBoosts.map((item) => item.label),
        ...params.learning.topicSuppressions.map((item) => item.label),
      ],
      8,
    ),
    sourceAdjustmentLabels: uniqueStrings(
      [
        ...params.learning.sourceBoosts.map((item) => item.label),
        ...params.learning.sourceSuppressions.map((item) => item.label),
      ],
      8,
    ),
    deliveryAdjustmentLabels: uniqueStrings(
      params.learning.deliveryModeSensitivity.map(
        (item) =>
          `${item.mode.replace(/_/g, ' ')} x${item.factor.toFixed(2)} cooldown=${item.cooldownMs}`,
      ),
      8,
    ),
    cooldownAdjustmentLabels: uniqueStrings(
      params.learning.duplicateCooldownAdjustments.map(
        (item) => `${item.key} x${item.factor.toFixed(2)}`,
      ),
      8,
    ),
    readinessWarningLabels,
    executionPermissionRaised: false,
    actionAuthority: 'display_only',
    mutationCount: 0,
    evidenceRefs: uniqueStrings(
      [
        ...params.learning.evidenceRefs,
        ...params.feedbackCompression.evidenceRefs,
        ...params.fieldEvents.flatMap((event) => [
          `field-event:${event.id}`,
          ...event.evidenceRefs,
        ]),
      ],
      MAX_REFS,
    ),
  };
}

export function buildAoiFieldFeedbackLearning(
  input: AoiFieldFeedbackLearningInput,
): AoiFieldFeedbackLearningResult {
  const now = input.now ?? DEFAULT_FIELD_FEEDBACK_NOW;
  const labels = [...input.labelActions].filter((label) => label.sessionPath === input.sessionPath);
  const followThroughEvents = [
    ...(input.existingFollowThroughEvents ?? []),
    ...buildAoiFollowThroughEventsFromFieldFeedback({ ...input, labelActions: labels, now }),
  ];
  const followThroughLearning = buildAoiFollowThroughLearningSummary({
    sessionPath: input.sessionPath,
    followThroughEvents,
    now,
  });
  const feedbackCompression = buildAoiFeedbackCompression({
    sessionPath: input.sessionPath,
    labelActions: labels,
    followThroughEvents,
    followThroughLearning,
    now,
  });
  const fieldEvents = buildAoiFieldFeedbackEvents({ ...input, labelActions: labels, now });
  const summary = buildSummary({
    input,
    labels,
    followThroughEvents,
    learning: followThroughLearning,
    fieldEvents,
    feedbackCompression,
    now,
  });
  return {
    version: 1,
    sessionPath: input.sessionPath,
    generatedAt: now,
    labelActions: labels,
    followThroughEvents,
    followThroughLearning,
    fieldEvents,
    summary,
    feedbackCompression,
    executionPermissionRaised: false,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function recordAoiFieldFeedbackLearningAction(
  sessionsDir: string,
  input: AoiOperatorFeedbackLabelInput,
): AoiFieldFeedbackRecordResult {
  const labelAction = recordAoiOperatorFeedbackLabelAction(sessionsDir, input);
  const fieldShadowReport = loadAoiFieldShadowRecordReport(
    sessionsDir,
    labelAction.sessionPath,
    labelAction.createdAt,
  );
  const result = buildAoiFieldFeedbackLearning({
    sessionPath: labelAction.sessionPath,
    fieldShadowReport,
    labelActions: [labelAction],
    now: labelAction.createdAt,
  });
  const appendedFollowThroughEvents = result.followThroughEvents.map((event) =>
    appendAoiFollowThroughEvent(sessionsDir, event, result.generatedAt),
  );
  const appendedFieldEvents = appendAoiFieldEvents(
    sessionsDir,
    result.fieldEvents,
    result.generatedAt,
  );
  return {
    ...result,
    labelAction,
    appendedFollowThroughEvents,
    appendedFieldEvents,
  };
}

export function createAoiFieldFeedbackLearningPreview(
  input: AoiOperatorFeedbackLabelInput,
  records: readonly AoiFieldShadowDecisionRecord[],
): AoiFieldFeedbackLearningResult {
  const labelAction = createAoiOperatorFeedbackLabelAction(input);
  return buildAoiFieldFeedbackLearning({
    sessionPath: labelAction.sessionPath,
    records,
    labelActions: [labelAction],
    now: labelAction.createdAt,
  });
}
