import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import type {
  AoiFieldShadowDecisionRecord,
  AoiFieldShadowPrivacyState,
  AoiFieldShadowRecordReport,
  AoiFieldShadowSubsystemOrigin,
} from './aoiFieldShadowDogfooding';
import type {
  AoiAutonomyRisk,
  AoiContextSourceFeedback,
  AoiProposalDecision,
} from './aoiAutonomyTypes';
import type {
  AoiShadowDecisionKind,
  AoiShadowDecisionLabel,
  AoiShadowDecisionLabelRecord,
  AoiShadowPolicyResult,
} from './aoiShadowModeEvaluation';

const DEFAULT_INBOX_NOW = 1_800_000_000_000;
const MAX_TEXT = 220;
const MAX_REFS = 24;
const MAX_INBOX_ITEMS = 80;

const LABELS: readonly AoiShadowDecisionLabel[] = [
  'useful',
  'too_much',
  'wrong_source',
  'unsafe',
  'missed_context',
  'should_have_spoken',
];

const CALIBRATION_LABELS = new Set<AoiShadowDecisionLabel>([
  'useful',
  'too_much',
  'wrong_source',
  'unsafe',
]);

const PROMOTION_LABELS = new Set<AoiShadowDecisionLabel>([
  'useful',
  'wrong_source',
  'unsafe',
  'missed_context',
  'should_have_spoken',
]);

export type AoiOperatorFeedbackReviewDimension =
  | 'usefulness'
  | 'timing'
  | 'source_selection'
  | 'safety'
  | 'context_coverage'
  | 'approval_boundary';

export type AoiOperatorFeedbackLabelState = 'unlabeled' | 'labeled' | 'unsafe_flagged';

export interface AoiOperatorFeedbackSourceKindCount {
  version: 1;
  sourceKind: string;
  count: number;
  unlabeledCount: number;
  evidenceRefs: string[];
}

export interface AoiOperatorFeedbackLabelAction {
  version: 1;
  id: string;
  sessionPath: string;
  decisionRecordId: string;
  decisionId: string;
  label: AoiShadowDecisionLabel;
  actor: 'user' | 'system';
  createdAt: number;
  sourceKinds: string[];
  evidenceRefs: string[];
  calibrationEligible: boolean;
  promotionEligible: boolean;
  safetyTightening: boolean;
  mutationCount: 0;
  note?: string;
}

export interface AoiOperatorFeedbackLabelInput {
  sessionPath: string;
  decisionRecordId: string;
  decisionId: string;
  label: AoiShadowDecisionLabel;
  sourceKinds?: string[];
  actor?: 'user' | 'system';
  note?: string;
  evidenceRefs?: string[];
  now?: number;
}

export interface AoiOperatorFeedbackInboxItem {
  version: 1;
  id: string;
  sessionPath: string;
  decisionRecordId: string;
  decisionId: string;
  decisionKind: AoiShadowDecisionKind;
  subsystemOrigin: AoiFieldShadowSubsystemOrigin;
  risk: AoiAutonomyRisk;
  policyResult: AoiShadowPolicyResult;
  privacyState: AoiFieldShadowPrivacyState;
  sourceSummary: string;
  whatAoiWouldHaveDone: string;
  whyJudgedThisWay: string;
  cannotKnowLabel: string;
  sourceRefs: string[];
  sourceKinds: string[];
  evidenceRefs: string[];
  labelState: AoiOperatorFeedbackLabelState;
  labels: AoiOperatorFeedbackLabelAction[];
  labelHistoryCount: number;
  suggestedReviewDimension: AoiOperatorFeedbackReviewDimension;
  priorityScore: number;
  calibrationEligible: boolean;
  promotionEligible: boolean;
  mutationCount: 0;
  latestLabel?: AoiShadowDecisionLabel;
  latestLabelAt?: number;
}

export interface AoiOperatorFeedbackInbox {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  inboxCount: number;
  unlabeledCount: number;
  labeledCount: number;
  unsafeLabelCount: number;
  calibrationInputCount: number;
  promotionCandidateCount: number;
  labelDistribution: Record<AoiShadowDecisionLabel, number>;
  topSourceKindsNeedingReview: AoiOperatorFeedbackSourceKindCount[];
  items: AoiOperatorFeedbackInboxItem[];
  evidenceRefs: string[];
  actionAuthority: 'label_only';
  mutationCount: 0;
}

export interface AoiOperatorFeedbackInboxInput {
  sessionPath: string;
  records?: AoiFieldShadowDecisionRecord[];
  fieldShadowReport?: AoiFieldShadowRecordReport | null;
  labelActions?: AoiOperatorFeedbackLabelAction[];
  now?: number;
  limit?: number;
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

function normalizeSessionPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.includes('..')) {
    return null;
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(normalized)) {
    return null;
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return normalized;
}

function sanitizeText(value: unknown, maxChars = MAX_TEXT): string {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value))
      .replace(
        /\b(?:do not leak|private|raw|full|secret)[^.!?\n]{0,120}\b(?:mail|email|calendar|event|note|message)?\s*body[^.!?\n]*(?:[.!?]|$)/gi,
        '[private body withheld]',
      )
      .replace(
        /\b(body|content|snippet|transcript|messageBody|rawText)\s*[:=]\s*[^.;\n]{6,}/gi,
        '$1=[private body withheld]',
      )
      .replace(/\b[A-Z]:\\[^\s'"`<>|]+/gi, '[local path]')
      .replace(/\\\\[^\s'"`<>|]+/g, '[local path]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[private email]')
      .replace(/https?:\/\/[^\s'"`<>]+/gi, '[external url]'),
  );
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function uniqueStrings(values: Array<string | undefined | null>, maxItems = MAX_REFS): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = sanitizeText(value ?? '', 180);
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

function isLabel(value: unknown): value is AoiShadowDecisionLabel {
  return LABELS.includes(value as AoiShadowDecisionLabel);
}

function sourceKindFromRef(ref: string): string {
  if (/\bpersonal-source-reality\b/i.test(ref)) {
    return 'personal_source_reality';
  }
  if (/\bpersonal-signal:calendar|\bcalendar/i.test(ref)) {
    return 'calendar_metadata';
  }
  if (/\bpersonal-signal:gmail|\bgmail/i.test(ref)) {
    return 'gmail_metadata';
  }
  if (/\bpersonal-signal:notes|\bnotes/i.test(ref)) {
    return 'notes_metadata';
  }
  if (/\bbrowser-context|\bbrowser/i.test(ref)) {
    return 'browser_context';
  }
  if (/\bworkspace.*build|\bvalidation/i.test(ref)) {
    return 'workspace_build';
  }
  if (/\bworkspace/i.test(ref)) {
    return 'workspace_git';
  }
  if (/\bhealth:/i.test(ref)) {
    return 'health';
  }
  if (/\benvironment-source:/i.test(ref)) {
    return 'environment_source';
  }
  if (/\bplaybook:/i.test(ref)) {
    return 'playbook';
  }
  if (/\bapproved-command:/i.test(ref)) {
    return 'approved_command_policy';
  }
  if (/\bproposal:/i.test(ref)) {
    return 'proposal';
  }
  if (/\bdigest:|\bapproval-inbox:/i.test(ref)) {
    return 'digest';
  }
  if (/\bmemory:/i.test(ref)) {
    return 'memory';
  }
  return 'unknown';
}

function sourceKindsForRecord(record: AoiFieldShadowDecisionRecord): string[] {
  return uniqueStrings([...record.sourceRefs, ...record.evidenceRefs].map(sourceKindFromRef), 12);
}

function actionLabel(record: AoiFieldShadowDecisionRecord): string {
  if (record.operatorMessagePreview) {
    return record.operatorMessagePreview;
  }
  if (record.suggestedAction) {
    return record.suggestedAction;
  }
  if (record.approvalBoundary) {
    return `Prepare approval: ${record.approvalBoundary}`;
  }
  if (record.silenceReason) {
    return `Stay quiet: ${record.silenceReason}`;
  }
  return `${record.decisionKind.replace(/_/g, ' ')}: ${record.sourceSummary}`;
}

function cannotKnowLabel(record: AoiFieldShadowDecisionRecord): string {
  const text = [
    record.sourceSummary,
    record.silenceReason,
    record.approvalBoundary,
    ...record.sourceRefs,
    ...record.evidenceRefs,
  ].join(' ');
  if (record.consentState !== 'allowed' && record.consentState !== 'unknown') {
    return `${record.consentState} source; absence is not evidence.`;
  }
  if (/cannot know|disconnected|disabled|revoked|stale|body disabled|metadata only/i.test(text)) {
    return sanitizeText(record.sourceSummary || text, 180);
  }
  if (record.privacyState === 'metadata_only') {
    return 'Metadata-only source; private bodies are outside scope.';
  }
  return 'No explicit cannot-know note attached.';
}

function labelStateFor(labels: AoiOperatorFeedbackLabelAction[]): AoiOperatorFeedbackLabelState {
  if (labels.some((label) => label.label === 'unsafe')) {
    return 'unsafe_flagged';
  }
  return labels.length > 0 ? 'labeled' : 'unlabeled';
}

function dimensionForLabel(label: AoiShadowDecisionLabel): AoiOperatorFeedbackReviewDimension {
  if (label === 'wrong_source') {
    return 'source_selection';
  }
  if (label === 'unsafe') {
    return 'safety';
  }
  if (label === 'missed_context') {
    return 'context_coverage';
  }
  if (label === 'too_much' || label === 'should_have_spoken') {
    return 'timing';
  }
  return 'usefulness';
}

function suggestedDimensionForRecord(
  record: AoiFieldShadowDecisionRecord,
  sourceKinds: string[],
  labels: AoiOperatorFeedbackLabelAction[],
): AoiOperatorFeedbackReviewDimension {
  const latest = labels[labels.length - 1];
  if (latest) {
    return dimensionForLabel(latest.label);
  }
  if (record.policyResult === 'approval_required' || record.policyResult === 'blocked') {
    return 'approval_boundary';
  }
  if (record.risk === 'high') {
    return 'safety';
  }
  if (sourceKinds.some((kind) => /browser|gmail|calendar|notes|unknown/i.test(kind))) {
    return 'source_selection';
  }
  if (
    record.decisionKind === 'would_mark_blind_spot' ||
    record.subsystemOrigin === 'health' ||
    record.subsystemOrigin === 'source_consent' ||
    record.subsystemOrigin === 'personal_source_reality'
  ) {
    return 'context_coverage';
  }
  if (record.decisionKind === 'would_stay_quiet') {
    return 'timing';
  }
  return 'usefulness';
}

function priorityForRecord(params: {
  record: AoiFieldShadowDecisionRecord;
  sourceKinds: string[];
  labelState: AoiOperatorFeedbackLabelState;
  dimension: AoiOperatorFeedbackReviewDimension;
}): number {
  const { record, sourceKinds, labelState, dimension } = params;
  let score = labelState === 'unlabeled' ? 100 : labelState === 'unsafe_flagged' ? 64 : 20;
  if (record.decisionKind === 'would_prepare_approval') {
    score += 36;
  } else if (record.decisionKind === 'would_speak') {
    score += 34;
  } else if (record.decisionKind === 'would_propose') {
    score += 32;
  } else if (record.decisionKind === 'would_mark_blind_spot') {
    score += 18;
  } else {
    score += 12;
  }
  if (record.risk === 'high') {
    score += 22;
  } else if (record.risk === 'medium') {
    score += 12;
  }
  if (record.policyResult === 'approval_required' || record.policyResult === 'blocked') {
    score += 18;
  }
  if (sourceKinds.some((kind) => /browser|gmail|calendar|notes|unknown/i.test(kind))) {
    score += 14;
  }
  if (
    dimension === 'context_coverage' ||
    /cannot know|stale|disconnected|disabled/i.test(record.sourceSummary)
  ) {
    score += 12;
  }
  return score;
}

function latestLabel(
  labels: AoiOperatorFeedbackLabelAction[],
): AoiOperatorFeedbackLabelAction | null {
  return [...labels].sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
}

function labelDistribution(
  labels: AoiOperatorFeedbackLabelAction[],
): Record<AoiShadowDecisionLabel, number> {
  const distribution = LABELS.reduce(
    (out, label) => {
      out[label] = 0;
      return out;
    },
    {} as Record<AoiShadowDecisionLabel, number>,
  );
  for (const label of labels) {
    distribution[label.label] += 1;
  }
  return distribution;
}

function labelsForRecord(
  labels: AoiOperatorFeedbackLabelAction[],
  record: AoiFieldShadowDecisionRecord,
): AoiOperatorFeedbackLabelAction[] {
  return labels
    .filter(
      (label) => label.decisionRecordId === record.id || label.decisionId === record.decisionId,
    )
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function makeItem(
  record: AoiFieldShadowDecisionRecord,
  labels: AoiOperatorFeedbackLabelAction[],
): AoiOperatorFeedbackInboxItem {
  const sourceKinds = sourceKindsForRecord(record);
  const latest = latestLabel(labels);
  const labelState = labelStateFor(labels);
  const suggestedReviewDimension = suggestedDimensionForRecord(record, sourceKinds, labels);
  const priorityScore = priorityForRecord({
    record,
    sourceKinds,
    labelState,
    dimension: suggestedReviewDimension,
  });
  const evidenceRefs = uniqueStrings(
    [
      `field-shadow-record:${record.id}`,
      `field-shadow-decision:${record.decisionId}`,
      ...record.evidenceRefs,
      ...labels.flatMap((label) => label.evidenceRefs),
    ],
    MAX_REFS,
  );

  return {
    version: 1,
    id: `aoi-feedback-inbox-item-${hashText(`${record.sessionPath}:${record.dedupeKey}`)}`,
    sessionPath: record.sessionPath,
    decisionRecordId: record.id,
    decisionId: record.decisionId,
    decisionKind: record.decisionKind,
    subsystemOrigin: record.subsystemOrigin,
    risk: record.risk,
    policyResult: record.policyResult,
    privacyState: record.privacyState,
    sourceSummary: sanitizeText(record.sourceSummary, 220),
    whatAoiWouldHaveDone: sanitizeText(actionLabel(record), 220),
    whyJudgedThisWay: sanitizeText(
      `${record.subsystemOrigin.replace(/_/g, ' ')} used ${sourceKinds.join(', ') || 'unknown source'}; policy=${record.policyResult}; consent=${record.consentState}.`,
      220,
    ),
    cannotKnowLabel: sanitizeText(cannotKnowLabel(record), 180),
    sourceRefs: uniqueStrings(record.sourceRefs, 12),
    sourceKinds,
    evidenceRefs,
    labelState,
    labels,
    labelHistoryCount: labels.length,
    suggestedReviewDimension,
    priorityScore,
    calibrationEligible: labels.some((label) => label.calibrationEligible),
    promotionEligible: labels.some((label) => label.promotionEligible),
    mutationCount: 0,
    ...(latest ? { latestLabel: latest.label, latestLabelAt: latest.createdAt } : {}),
  };
}

function mergeDuplicateItems(
  items: AoiOperatorFeedbackInboxItem[],
): AoiOperatorFeedbackInboxItem[] {
  const byKey = new Map<string, AoiOperatorFeedbackInboxItem>();
  for (const item of items) {
    const key = `${item.decisionId}:${item.decisionKind}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, item);
      continue;
    }
    byKey.set(key, {
      ...current,
      sourceRefs: uniqueStrings([...current.sourceRefs, ...item.sourceRefs], 12),
      sourceKinds: uniqueStrings([...current.sourceKinds, ...item.sourceKinds], 12),
      evidenceRefs: uniqueStrings([...current.evidenceRefs, ...item.evidenceRefs], MAX_REFS),
      labels: [...current.labels, ...item.labels].sort(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      ),
      labelHistoryCount: current.labelHistoryCount + item.labelHistoryCount,
      priorityScore: Math.max(current.priorityScore, item.priorityScore),
      calibrationEligible: current.calibrationEligible || item.calibrationEligible,
      promotionEligible: current.promotionEligible || item.promotionEligible,
    });
  }
  return [...byKey.values()].map(recomputeItemLabelState);
}

function recomputeItemLabelState(item: AoiOperatorFeedbackInboxItem): AoiOperatorFeedbackInboxItem {
  const labels = [...item.labels].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  const latest = latestLabel(labels);
  const labelState = labelStateFor(labels);
  const withoutLatest = { ...item };
  delete withoutLatest.latestLabel;
  delete withoutLatest.latestLabelAt;
  return {
    ...withoutLatest,
    labels,
    labelState,
    labelHistoryCount: labels.length,
    suggestedReviewDimension: latest
      ? dimensionForLabel(latest.label)
      : item.suggestedReviewDimension,
    calibrationEligible: labels.some((label) => label.calibrationEligible),
    promotionEligible: labels.some((label) => label.promotionEligible),
    priorityScore:
      labelState === 'unsafe_flagged' ? Math.max(item.priorityScore, 64) : item.priorityScore,
    ...(latest ? { latestLabel: latest.label, latestLabelAt: latest.createdAt } : {}),
  };
}

function topSourceKinds(
  items: AoiOperatorFeedbackInboxItem[],
): AoiOperatorFeedbackSourceKindCount[] {
  const counts = new Map<string, AoiOperatorFeedbackSourceKindCount>();
  for (const item of items) {
    for (const sourceKind of item.sourceKinds) {
      const current =
        counts.get(sourceKind) ??
        ({
          version: 1,
          sourceKind,
          count: 0,
          unlabeledCount: 0,
          evidenceRefs: [],
        } satisfies AoiOperatorFeedbackSourceKindCount);
      current.count += 1;
      if (item.labelState === 'unlabeled') {
        current.unlabeledCount += 1;
      }
      current.evidenceRefs = uniqueStrings([...current.evidenceRefs, ...item.evidenceRefs], 8);
      counts.set(sourceKind, current);
    }
  }
  return [...counts.values()]
    .filter(
      (item) =>
        item.unlabeledCount > 0 || /browser|gmail|calendar|notes|unknown/i.test(item.sourceKind),
    )
    .sort(
      (left, right) =>
        right.unlabeledCount - left.unlabeledCount ||
        right.count - left.count ||
        left.sourceKind.localeCompare(right.sourceKind),
    )
    .slice(0, 6);
}

export function normalizeAoiOperatorFeedbackLabelAction(
  value: unknown,
  expectedSessionPath?: string,
): AoiOperatorFeedbackLabelAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiOperatorFeedbackLabelAction>;
  const sessionPath = normalizeSessionPath(raw.sessionPath);
  if (!sessionPath || (expectedSessionPath && sessionPath !== expectedSessionPath)) {
    return null;
  }
  if (
    raw.version !== 1 ||
    typeof raw.id !== 'string' ||
    typeof raw.decisionRecordId !== 'string' ||
    typeof raw.decisionId !== 'string' ||
    !isLabel(raw.label) ||
    (raw.actor !== 'user' && raw.actor !== 'system') ||
    typeof raw.createdAt !== 'number'
  ) {
    return null;
  }
  return {
    version: 1,
    id: sanitizeText(raw.id, 127).replace(/[^a-zA-Z0-9_-]/g, '-'),
    sessionPath,
    decisionRecordId: sanitizeText(raw.decisionRecordId, 127),
    decisionId: sanitizeText(raw.decisionId, 127),
    label: raw.label,
    actor: raw.actor,
    createdAt: raw.createdAt,
    sourceKinds: uniqueStrings(raw.sourceKinds ?? [], 12),
    evidenceRefs: uniqueStrings(raw.evidenceRefs ?? [], MAX_REFS),
    calibrationEligible: CALIBRATION_LABELS.has(raw.label),
    promotionEligible: PROMOTION_LABELS.has(raw.label),
    safetyTightening: raw.label === 'unsafe',
    mutationCount: 0,
    ...(raw.note ? { note: sanitizeText(raw.note, 220) } : {}),
  };
}

export function createAoiOperatorFeedbackLabelAction(
  input: AoiOperatorFeedbackLabelInput,
): AoiOperatorFeedbackLabelAction {
  const sessionPath = normalizeSessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  if (!isLabel(input.label)) {
    throw new Error('Unsupported Aoi operator feedback label.');
  }
  const now = input.now ?? DEFAULT_INBOX_NOW;
  const decisionRecordId = sanitizeText(input.decisionRecordId, 127);
  const decisionId = sanitizeText(input.decisionId, 127);
  const evidenceRefs = uniqueStrings(
    [
      `field-shadow-record:${decisionRecordId}`,
      `field-shadow-decision:${decisionId}`,
      ...(input.evidenceRefs ?? []),
    ],
    MAX_REFS,
  );
  return {
    version: 1,
    id: `aoi-feedback-label-${hashText(
      `${sessionPath}:${decisionRecordId}:${decisionId}:${input.label}:${now}:${input.note ?? ''}`,
    )}`,
    sessionPath,
    decisionRecordId,
    decisionId,
    label: input.label,
    actor: input.actor ?? 'user',
    createdAt: now,
    sourceKinds: uniqueStrings(input.sourceKinds ?? [], 12),
    evidenceRefs,
    calibrationEligible: CALIBRATION_LABELS.has(input.label),
    promotionEligible: PROMOTION_LABELS.has(input.label),
    safetyTightening: input.label === 'unsafe',
    mutationCount: 0,
    ...(input.note ? { note: sanitizeText(input.note, 220) } : {}),
  };
}

export function appendAoiOperatorFeedbackLabelAction(
  actions: AoiOperatorFeedbackLabelAction[],
  input: AoiOperatorFeedbackLabelInput,
): AoiOperatorFeedbackLabelAction[] {
  return [...actions, createAoiOperatorFeedbackLabelAction(input)];
}

export function createAoiOperatorFeedbackLabelActionForItem(params: {
  item: AoiOperatorFeedbackInboxItem;
  label: AoiShadowDecisionLabel;
  actor?: 'user' | 'system';
  note?: string;
  evidenceRefs?: string[];
  now?: number;
}): AoiOperatorFeedbackLabelAction {
  return createAoiOperatorFeedbackLabelAction({
    sessionPath: params.item.sessionPath,
    decisionRecordId: params.item.decisionRecordId,
    decisionId: params.item.decisionId,
    label: params.label,
    actor: params.actor,
    note: params.note,
    sourceKinds: params.item.sourceKinds,
    evidenceRefs: [...params.item.evidenceRefs, ...(params.evidenceRefs ?? [])],
    now: params.now,
  });
}

export function buildAoiOperatorFeedbackInbox(
  input: AoiOperatorFeedbackInboxInput,
): AoiOperatorFeedbackInbox {
  const sessionPath = normalizeSessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? input.fieldShadowReport?.generatedAt ?? DEFAULT_INBOX_NOW;
  const records = (input.fieldShadowReport?.activeRecords ?? input.records ?? []).filter(
    (record) => record.sessionPath === sessionPath && record.expiresAt > now,
  );
  const labels = (input.labelActions ?? [])
    .map((label) => normalizeAoiOperatorFeedbackLabelAction(label, sessionPath))
    .filter((label): label is AoiOperatorFeedbackLabelAction => label !== null);
  const rawItems = records.map((record) => makeItem(record, labelsForRecord(labels, record)));
  const items = mergeDuplicateItems(rawItems)
    .sort(
      (left, right) =>
        right.priorityScore - left.priorityScore ||
        right.labelHistoryCount - left.labelHistoryCount ||
        left.id.localeCompare(right.id),
    )
    .slice(0, input.limit ?? MAX_INBOX_ITEMS);
  const matchedLabels = items.flatMap((item) => item.labels);
  const distribution = labelDistribution(matchedLabels);
  const evidenceRefs = uniqueStrings(
    [
      ...(input.fieldShadowReport?.evidenceRefs ?? []),
      ...items.flatMap((item) => item.evidenceRefs),
      ...matchedLabels.flatMap((label) => label.evidenceRefs),
    ],
    MAX_REFS,
  );

  return {
    version: 1,
    id: `aoi-feedback-inbox-${hashText(
      `${sessionPath}:${now}:${items.map((item) => item.id).join('|')}:${matchedLabels
        .map((label) => label.id)
        .join('|')}`,
    )}`,
    sessionPath,
    generatedAt: now,
    inboxCount: items.length,
    unlabeledCount: items.filter((item) => item.labelState === 'unlabeled').length,
    labeledCount: items.filter((item) => item.labelState !== 'unlabeled').length,
    unsafeLabelCount: matchedLabels.filter((label) => label.label === 'unsafe').length,
    calibrationInputCount: matchedLabels.filter((label) => label.calibrationEligible).length,
    promotionCandidateCount: matchedLabels.filter((label) => label.promotionEligible).length,
    labelDistribution: distribution,
    topSourceKindsNeedingReview: topSourceKinds(items),
    items,
    evidenceRefs,
    actionAuthority: 'label_only',
    mutationCount: 0,
  };
}

function decisionActionForLabel(label: AoiShadowDecisionLabel): AoiProposalDecision['action'] {
  if (label === 'useful') {
    return 'accept';
  }
  if (label === 'too_much') {
    return 'snooze';
  }
  return 'dismiss';
}

function nextStatusForAction(
  action: AoiProposalDecision['action'],
): AoiProposalDecision['nextStatus'] {
  if (action === 'accept') {
    return 'accepted';
  }
  if (action === 'snooze') {
    return 'snoozed';
  }
  return 'dismissed';
}

export function buildAoiOperatorFeedbackCalibrationDecisions(params: {
  sessionPath: string;
  labelActions: AoiOperatorFeedbackLabelAction[];
  records?: AoiFieldShadowDecisionRecord[];
}): AoiProposalDecision[] {
  const sessionPath = normalizeSessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const recordsById = new Map((params.records ?? []).map((record) => [record.id, record]));
  const recordsByDecisionId = new Map(
    (params.records ?? []).map((record) => [record.decisionId, record]),
  );
  const hasRecordScope = params.records !== undefined;
  return params.labelActions
    .filter(
      (label) =>
        label.sessionPath === sessionPath &&
        label.calibrationEligible &&
        (!hasRecordScope ||
          recordsById.has(label.decisionRecordId) ||
          recordsByDecisionId.has(label.decisionId)),
    )
    .map((label) => {
      const record =
        recordsById.get(label.decisionRecordId) ?? recordsByDecisionId.get(label.decisionId);
      const action = decisionActionForLabel(label.label);
      const nextStatus = nextStatusForAction(action);
      const sourceKinds =
        label.sourceKinds.length > 0
          ? label.sourceKinds
          : record
            ? sourceKindsForRecord(record)
            : [];
      return {
        version: 1,
        id: `aoi-feedback-calibration-${hashText(label.id)}`,
        proposalId: `field-shadow:${label.decisionRecordId}`,
        sessionPath,
        cooldownKey: `field-shadow:${record?.dedupeKey ?? label.decisionRecordId}`,
        action,
        actor: label.actor,
        createdAt: label.createdAt,
        previousStatus: 'active',
        nextStatus,
        feedbackCategory: label.label,
        ...(label.note ? { feedbackNote: label.note } : {}),
        proposalTrigger: `field_shadow:${record?.subsystemOrigin ?? 'unknown'}`,
        proposalRisk: record?.risk ?? 'low',
        suggestedTools: uniqueStrings(
          [
            record?.decisionKind
              ? `field_shadow_${record.decisionKind.replace(/^would_/, '')}`
              : 'field_shadow_unknown',
            record?.subsystemOrigin,
            ...sourceKinds,
          ],
          12,
        ),
        evidenceRefs: uniqueStrings(
          [
            `operator-feedback:${label.id}`,
            `field-shadow-record:${label.decisionRecordId}`,
            `field-shadow-decision:${label.decisionId}`,
            ...label.evidenceRefs,
            ...(record?.evidenceRefs ?? []),
            ...sourceKinds.map((kind) => `source-kind:${kind}`),
          ],
          MAX_REFS,
        ),
        memoryIds: [],
      } satisfies AoiProposalDecision;
    });
}

export function buildAoiOperatorFeedbackContextFeedback(params: {
  sessionPath: string;
  labelActions: AoiOperatorFeedbackLabelAction[];
}): AoiContextSourceFeedback[] {
  const sessionPath = normalizeSessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  return params.labelActions
    .filter(
      (label) =>
        label.sessionPath === sessionPath &&
        (label.label === 'wrong_source' || label.label === 'too_much'),
    )
    .flatMap((label) =>
      (label.sourceKinds.length > 0 ? label.sourceKinds : ['unknown']).map((sourceKind) => ({
        version: 1 as const,
        id: `aoi-feedback-context-${hashText(`${label.id}:${sourceKind}`)}`,
        sessionPath,
        sourceId: sourceKind.replace(/_/g, '-'),
        feedbackCategory: label.label,
        ...(label.note ? { feedbackNote: label.note } : {}),
        evidenceRefs: uniqueStrings(
          [
            `operator-feedback:${label.id}`,
            `field-shadow-record:${label.decisionRecordId}`,
            ...label.evidenceRefs,
          ],
          8,
        ),
        createdAt: label.createdAt,
      })),
    );
}

export function buildAoiOperatorFeedbackPromotionLabels(params: {
  sessionPath: string;
  labelActions: AoiOperatorFeedbackLabelAction[];
  records?: AoiFieldShadowDecisionRecord[];
}): AoiShadowDecisionLabelRecord[] {
  const sessionPath = normalizeSessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const recordsById = new Map((params.records ?? []).map((record) => [record.id, record]));
  const recordsByDecisionId = new Map(
    (params.records ?? []).map((record) => [record.decisionId, record]),
  );
  const hasRecordScope = params.records !== undefined;
  return params.labelActions
    .filter(
      (label) =>
        label.sessionPath === sessionPath &&
        label.promotionEligible &&
        (!hasRecordScope ||
          recordsById.has(label.decisionRecordId) ||
          recordsByDecisionId.has(label.decisionId)),
    )
    .map((label) => ({
      version: 1,
      id: `aoi-feedback-shadow-label-${hashText(label.id)}`,
      decisionId: label.decisionId,
      label: label.label,
      actor: label.actor,
      createdAt: label.createdAt,
      evidenceRefs: uniqueStrings(
        [
          `operator-feedback:${label.id}`,
          `field-shadow-record:${label.decisionRecordId}`,
          ...label.evidenceRefs,
        ],
        12,
      ),
      ...(label.note ? { note: label.note } : {}),
    }));
}
