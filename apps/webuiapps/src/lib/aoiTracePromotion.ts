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
import type { AoiJarvisAcceptanceDimension } from './aoiJarvisAcceptanceTrial';
import type { AoiOperatorTimelineEvent, AoiOperatorTraceExport } from './aoiAutonomyTypes';
import type {
  AoiShadowDecision,
  AoiShadowDecisionLabel,
  AoiShadowDecisionLabelRecord,
  AoiShadowDecisionReport,
} from './aoiShadowModeEvaluation';

const DEFAULT_TRACE_PROMOTION_NOW = 1_800_000_000_000;
const MAX_TEXT = 220;
const MAX_REFS = 24;

export type AoiTracePromotionAction = 'promote' | 'defer' | 'reject';
export type AoiTracePromotionPrivacyStatus = 'passed' | 'blocked' | 'needs_review';
export type AoiTracePromotionAcceptanceDimension =
  | AoiJarvisAcceptanceDimension
  | 'source_selection';

export interface AoiTracePromotionCandidate {
  version: 1;
  id: string;
  sourceTraceId: string;
  sessionPath: string;
  createdAt: number;
  title: string;
  summary: string;
  selectedLabel: AoiShadowDecisionLabel;
  acceptanceDimension: AoiTracePromotionAcceptanceDimension;
  jarvisDimension: AoiJarvisAcceptanceDimension;
  shadowDecisionIds: string[];
  timelineEventIds: string[];
  groupedEventKinds: string[];
  sourceEventRefs: string[];
  digestDecisionRefs: string[];
  approvalRefs: string[];
  healthWarningRefs: string[];
  privacyStatus: AoiTracePromotionPrivacyStatus;
  privacyWarnings: string[];
  todoExpectations: string[];
  warnings: string[];
  evidenceRefs: string[];
  mutationCount: 0;
}

export interface AoiTracePromotionDecision {
  version: 1;
  id: string;
  candidateId: string;
  sourceTraceId: string;
  action: AoiTracePromotionAction;
  selectedLabel: AoiShadowDecisionLabel;
  acceptanceDimension?: AoiTracePromotionAcceptanceDimension;
  jarvisDimension?: AoiJarvisAcceptanceDimension;
  reason?: string;
  actor: 'user' | 'system';
  createdAt: number;
  evidenceRefs: string[];
  privacyStatus: AoiTracePromotionPrivacyStatus;
  mutationCount: 0;
}

export interface AoiTracePromotionFixtureDraftOutput {
  version: 1;
  candidateId: string;
  sourceTraceId: string;
  decisionId: string;
  fixtureId: string;
  acceptanceDimension: AoiTracePromotionAcceptanceDimension;
  jarvisDimension: AoiJarvisAcceptanceDimension;
  selectedLabel: AoiShadowDecisionLabel;
  fixtureDraft: AoiOperatorReplayFixtureDraftResult;
  todoExpectations: string[];
  warnings: string[];
  evidenceRefs: string[];
  mutationCount: 0;
}

export interface AoiTracePromotionReport {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  candidateCount: number;
  decisionCount: number;
  promotedDraftCount: number;
  blockedPromotionCount: number;
  candidates: AoiTracePromotionCandidate[];
  decisions: AoiTracePromotionDecision[];
  fixtureDrafts: AoiTracePromotionFixtureDraftOutput[];
  warnings: string[];
  evidenceRefs: string[];
  mutationCount: 0;
}

export interface AoiTracePromotionReportInput {
  sessionPath: string;
  traceExports: AoiOperatorTraceExport[];
  shadowReport?: AoiShadowDecisionReport | null;
  shadowDecisions?: AoiShadowDecision[];
  shadowLabels?: AoiShadowDecisionLabelRecord[];
  promotionDecisions?: AoiTracePromotionDecision[];
  now?: number;
}

export interface AoiTracePromotionDecisionInput {
  candidate: AoiTracePromotionCandidate;
  action: AoiTracePromotionAction;
  acceptanceDimension?: AoiTracePromotionAcceptanceDimension;
  reason?: string;
  actor?: 'user' | 'system';
  evidenceRefs?: string[];
  now?: number;
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

function sanitizePromotionText(value: string, maxChars = MAX_TEXT): string {
  const normalized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value))
      .replace(
        /\b(?:do not leak|private|raw|full|secret)[^.!?]{0,100}\b(?:mail|email|calendar|event|note)?\s*body[^.!?]*(?:[.!?]|$)/gi,
        '[private-body]',
      )
      .replace(/\b[A-Za-z]:(?:[\\/][^\s'"`<>|]+)+/g, '[path]')
      .replace(/\\\\[^\s'"`<>|]+(?:\\[^\s'"`<>|]+)+/g, '[path]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
      .replace(/\bhttps?:\/\/[^\s'"`<>]+/gi, '[url]'),
  );
  return truncate(normalized, maxChars);
}

function uniqueStrings(values: Array<string | undefined | null>, maxItems = MAX_REFS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = sanitizePromotionText(value ?? '', 220);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function acceptanceDimensionForLabel(
  label: AoiShadowDecisionLabel,
): AoiTracePromotionAcceptanceDimension {
  if (label === 'wrong_source') {
    return 'source_selection';
  }
  if (label === 'too_much' || label === 'should_have_spoken') {
    return 'timing_interruption_control';
  }
  if (label === 'unsafe') {
    return 'safety_approval_boundaries';
  }
  if (label === 'missed_context') {
    return 'context_awareness';
  }
  return 'replayability_privacy';
}

function jarvisDimensionForPromotion(
  dimension: AoiTracePromotionAcceptanceDimension,
): AoiJarvisAcceptanceDimension {
  if (dimension === 'source_selection') {
    return 'context_awareness';
  }
  return dimension;
}

function eventRefs(event: AoiOperatorTimelineEvent): string[] {
  return [
    event.id,
    `timeline:${event.id}`,
    event.sourceRef,
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

function labelMatchesTrace(
  traceExport: AoiOperatorTraceExport,
  label: AoiShadowDecisionLabelRecord,
  decision: AoiShadowDecision | undefined,
): boolean {
  const refs = new Set(traceRefs(traceExport));
  const needles = [
    label.decisionId,
    `shadow-decision:${label.decisionId}`,
    ...label.evidenceRefs,
    ...(decision?.evidenceRefs ?? []),
    ...(decision?.sourceRefs ?? []),
  ].filter((item) => item.length > 0);
  return needles.some((needle) => refs.has(needle));
}

function collectSourceRefs(events: AoiOperatorTimelineEvent[]): string[] {
  return uniqueStrings(
    events
      .filter((event) => event.kind === 'source_selected' || event.kind === 'source_suppressed')
      .flatMap((event) => [event.sourceRef, event.sourceKind, ...event.evidenceRefs]),
    10,
  );
}

function collectDigestRefs(events: AoiOperatorTimelineEvent[]): string[] {
  return uniqueStrings(
    events
      .filter(
        (event) => event.kind === 'digest_item_surfaced' || event.kind === 'digest_item_hidden',
      )
      .flatMap((event) => [event.digestItemId, event.sourceRef, ...event.evidenceRefs]),
    10,
  );
}

function collectApprovalRefs(events: AoiOperatorTimelineEvent[]): string[] {
  return uniqueStrings(
    events
      .filter(
        (event) =>
          event.kind === 'approved_command_previewed' ||
          event.kind === 'approved_command_recorded' ||
          event.kind === 'proposal_accepted',
      )
      .flatMap((event) => [
        event.commandAuditId ? `approved-command:${event.commandAuditId}` : undefined,
        event.proposalId ? `proposal:${event.proposalId}` : undefined,
        event.decisionId ? `decision:${event.decisionId}` : undefined,
        ...event.evidenceRefs,
      ]),
    10,
  );
}

function collectHealthRefs(events: AoiOperatorTimelineEvent[]): string[] {
  return uniqueStrings(
    events
      .filter((event) =>
        /blind|cannot know|disconnected|stale|degraded|warning|blocked|health/i.test(
          `${event.title} ${event.summary} ${event.status ?? ''}`,
        ),
      )
      .flatMap((event) => [`timeline:${event.id}`, ...event.evidenceRefs]),
    10,
  );
}

function isSyntheticLabel(value: string): boolean {
  return /^\[(?:email|url|path|local-path|redacted-field|personal-metadata):\d+\]$/i.test(value);
}

function inspectPrivateMetadataValue(key: string, value: unknown): string[] {
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
    const trimmed = item.trim();
    if (bodyLikeKey && trimmed && !isSyntheticLabel(trimmed)) {
      warnings.push(`metadata.${sanitizePromotionText(key, 40)} still contains raw body/output`);
    }
  }
  return warnings;
}

function inspectRawPrivateText(value: string): string[] {
  const warnings: string[] = [];
  if (/\b[A-Za-z]:(?:[\\/][^\s'"`<>|]+)+/.test(value) || /\\\\[^\s'"`<>|]+/.test(value)) {
    warnings.push('raw local path remains in trace text');
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) {
    warnings.push('raw email address remains in trace text');
  }
  if (/\bhttps?:\/\/[^\s'"`<>]+/i.test(value)) {
    warnings.push('raw URL remains in trace text');
  }
  if (containsAoiSensitiveContent(value)) {
    warnings.push('secret-like token remains in trace text');
  }
  if (
    /\b(?:do not leak|private|raw|full|secret)[^.!?]{0,100}\b(?:mail|email|calendar|event|note)?\s*body/i.test(
      value,
    ) ||
    /\b(?:stdout|stderr|command output)\s*[:=]/i.test(value)
  ) {
    warnings.push('body-like or raw command output text remains in trace');
  }
  return warnings;
}

function privacyWarningsForTrace(traceExport: AoiOperatorTraceExport): string[] {
  const warnings: string[] = [];
  const eventText = JSON.stringify(traceExport.events);
  warnings.push(...inspectRawPrivateText(eventText));
  for (const event of traceExport.events) {
    for (const [key, value] of Object.entries(event.metadata ?? {})) {
      warnings.push(...inspectPrivateMetadataValue(key, value));
    }
  }
  const uniqueWarnings = uniqueStrings(warnings, 10);
  if (uniqueWarnings.length > 0) {
    return uniqueWarnings;
  }
  if (traceExport.events.some((event) => event.redactionState === 'removed')) {
    return ['trace contains removed events and needs review before promotion'];
  }
  if (traceExport.redactionSummary.totalReplacementCount <= 0) {
    return [
      'trace has no redaction replacements; review before treating it as real-world evidence',
    ];
  }
  return [];
}

function privacyStatusForTrace(traceExport: AoiOperatorTraceExport): {
  status: AoiTracePromotionPrivacyStatus;
  warnings: string[];
} {
  const warnings = privacyWarningsForTrace(traceExport);
  if (
    warnings.some((warning) =>
      /raw|secret|body-like|output|local path|email address|URL|metadata\./i.test(warning),
    )
  ) {
    return {
      status: 'blocked',
      warnings,
    };
  }
  if (warnings.length > 0) {
    return {
      status: 'needs_review',
      warnings,
    };
  }
  return {
    status: 'passed',
    warnings: [],
  };
}

function candidateId(params: {
  traceId: string;
  decisionId: string;
  label: AoiShadowDecisionLabel;
  dimension: AoiTracePromotionAcceptanceDimension;
}): string {
  return `aoi-trace-promotion-${hashText(
    `${params.traceId}:${params.decisionId}:${params.label}:${params.dimension}`,
  )}`;
}

function buildCandidate(params: {
  traceExport: AoiOperatorTraceExport;
  label: AoiShadowDecisionLabelRecord;
  decision?: AoiShadowDecision;
  now: number;
}): AoiTracePromotionCandidate {
  const { traceExport, label, decision, now } = params;
  const acceptanceDimension = acceptanceDimensionForLabel(label.label);
  const jarvisDimension = jarvisDimensionForPromotion(acceptanceDimension);
  const privacy = privacyStatusForTrace(traceExport);
  const events = traceExport.events;
  const firstEvent = events[0];
  const title = sanitizePromotionText(
    `${label.label.replace(/_/g, ' ')} trace from ${traceExport.id}`,
    120,
  );
  const eventSummaries = events.slice(0, 4).map((event) => `${event.title}: ${event.summary}`);
  const summary = sanitizePromotionText(
    decision?.sourceSummary || eventSummaries.join(' / ') || 'Trace export has no events.',
    220,
  );
  const evidenceRefs = uniqueStrings(
    [
      `trace-export:${traceExport.id}`,
      `shadow-decision:${label.decisionId}`,
      ...label.evidenceRefs,
      ...(decision?.evidenceRefs ?? []),
      ...events.flatMap((event) => event.evidenceRefs),
    ],
    18,
  );
  const groupedEventKinds = uniqueStrings(
    events.map((event) => event.kind),
    12,
  );
  const sourceEventRefs = collectSourceRefs(events);
  const digestDecisionRefs = collectDigestRefs(events);
  const approvalRefs = collectApprovalRefs(events);
  const healthWarningRefs = collectHealthRefs(events);
  const warnings = uniqueStrings(
    [
      ...privacy.warnings,
      events.length <= 0 ? 'trace has no timeline events' : undefined,
      !decision ? 'shadow decision details were not available' : undefined,
      sourceEventRefs.length <= 0 ? 'no explicit source-selection timeline event found' : undefined,
      approvalRefs.length <= 0 && label.label === 'unsafe'
        ? 'unsafe label has no approval boundary event'
        : undefined,
    ],
    10,
  );

  return {
    version: 1,
    id: candidateId({
      traceId: traceExport.id,
      decisionId: label.decisionId,
      label: label.label,
      dimension: acceptanceDimension,
    }),
    sourceTraceId: traceExport.id,
    sessionPath: traceExport.sessionPath,
    createdAt: now,
    title,
    summary,
    selectedLabel: label.label,
    acceptanceDimension,
    jarvisDimension,
    shadowDecisionIds: uniqueStrings([label.decisionId, decision?.id], 8),
    timelineEventIds: uniqueStrings(
      events.map((event) => event.id),
      20,
    ),
    groupedEventKinds,
    sourceEventRefs,
    digestDecisionRefs,
    approvalRefs,
    healthWarningRefs,
    privacyStatus: privacy.status,
    privacyWarnings: privacy.warnings,
    todoExpectations: uniqueStrings(
      [
        `Review ${acceptanceDimension} expectation for ${label.label}.`,
        'Replace placeholder replay expectation before adding this candidate to built-ins.',
        firstEvent
          ? `Confirm whether ${firstEvent.kind.replace(/_/g, ' ')} is the minimal replay trigger.`
          : 'Add a minimal replay trigger event before promotion.',
      ],
      8,
    ),
    warnings,
    evidenceRefs,
    mutationCount: 0,
  };
}

export function buildAoiTracePromotionCandidates(params: {
  sessionPath: string;
  traceExports: AoiOperatorTraceExport[];
  shadowReport?: AoiShadowDecisionReport | null;
  shadowDecisions?: AoiShadowDecision[];
  shadowLabels?: AoiShadowDecisionLabelRecord[];
  now?: number;
}): AoiTracePromotionCandidate[] {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? params.shadowReport?.generatedAt ?? DEFAULT_TRACE_PROMOTION_NOW;
  const decisions = params.shadowReport?.decisions ?? params.shadowDecisions ?? [];
  const labels = params.shadowReport?.labels ?? params.shadowLabels ?? [];
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
  const candidates: AoiTracePromotionCandidate[] = [];
  for (const traceExport of params.traceExports) {
    if (traceExport.sessionPath !== sessionPath) {
      continue;
    }
    for (const label of labels) {
      const decision = decisionById.get(label.decisionId);
      if (!labelMatchesTrace(traceExport, label, decision)) {
        continue;
      }
      candidates.push(
        buildCandidate({
          traceExport,
          label,
          decision,
          now,
        }),
      );
    }
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

export function createAoiTracePromotionDecision(
  input: AoiTracePromotionDecisionInput,
): AoiTracePromotionDecision {
  const { candidate } = input;
  const now = input.now ?? DEFAULT_TRACE_PROMOTION_NOW;
  const acceptanceDimension = input.acceptanceDimension ?? candidate.acceptanceDimension;
  const jarvisDimension = jarvisDimensionForPromotion(acceptanceDimension);
  const reason = sanitizePromotionText(input.reason ?? '', 220);
  if (input.action === 'promote' && (!acceptanceDimension || !reason)) {
    throw new Error('Trace promotion requires an acceptance dimension and reason.');
  }
  if (input.action === 'reject' && !reason) {
    throw new Error('Trace promotion rejection requires a short reason.');
  }
  return {
    version: 1,
    id: `aoi-trace-promotion-decision-${hashText(
      `${candidate.id}:${input.action}:${acceptanceDimension}:${reason}:${now}`,
    )}`,
    candidateId: candidate.id,
    sourceTraceId: candidate.sourceTraceId,
    action: input.action,
    selectedLabel: candidate.selectedLabel,
    ...(input.action === 'promote' ? { acceptanceDimension, jarvisDimension } : {}),
    ...(reason ? { reason } : {}),
    actor: input.actor ?? 'user',
    createdAt: now,
    evidenceRefs: uniqueStrings(
      [
        `trace-promotion-candidate:${candidate.id}`,
        `trace-export:${candidate.sourceTraceId}`,
        ...candidate.evidenceRefs,
        ...(input.evidenceRefs ?? []),
      ],
      16,
    ),
    privacyStatus: candidate.privacyStatus,
    mutationCount: 0,
  };
}

export function createAoiTracePromotionFixtureDraft(params: {
  candidate: AoiTracePromotionCandidate;
  decision: AoiTracePromotionDecision;
  traceExport: AoiOperatorTraceExport;
}): AoiTracePromotionFixtureDraftOutput {
  const { candidate, decision, traceExport } = params;
  if (decision.action !== 'promote') {
    throw new Error('Only promoted trace candidates can create fixture drafts.');
  }
  if (candidate.privacyStatus === 'blocked') {
    throw new Error('Trace promotion is blocked by unresolved private data.');
  }
  if (traceExport.id !== candidate.sourceTraceId) {
    throw new Error('Trace export does not match the promotion candidate.');
  }
  const fixtureId = `trace-promotion-${candidate.id.replace(/^aoi-trace-promotion-/, '')}`;
  const fixtureDraft = createAoiReplayFixtureDraftFromTraceExport(traceExport, {
    fixtureId,
    title: `TODO ${candidate.acceptanceDimension} ${candidate.selectedLabel} from ${candidate.sourceTraceId}`,
    latestUserMessage:
      'TODO: write a synthetic operator prompt that exercises this promoted real trace.',
  });
  return {
    version: 1,
    candidateId: candidate.id,
    sourceTraceId: candidate.sourceTraceId,
    decisionId: decision.id,
    fixtureId,
    acceptanceDimension: decision.acceptanceDimension ?? candidate.acceptanceDimension,
    jarvisDimension: decision.jarvisDimension ?? candidate.jarvisDimension,
    selectedLabel: candidate.selectedLabel,
    fixtureDraft,
    todoExpectations: uniqueStrings(
      [
        ...candidate.todoExpectations,
        ...fixtureDraft.todoExpectations,
        `Add one reviewed ${decision.acceptanceDimension ?? candidate.acceptanceDimension} expectation before committing this fixture.`,
      ],
      12,
    ),
    warnings: uniqueStrings(
      [
        ...candidate.warnings,
        ...fixtureDraft.warnings,
        'Draft output is in memory only; built-in replay fixture arrays are not modified.',
      ],
      12,
    ),
    evidenceRefs: uniqueStrings([...candidate.evidenceRefs, ...decision.evidenceRefs], 18),
    mutationCount: 0,
  };
}

export function buildAoiTracePromotionReport(
  input: AoiTracePromotionReportInput,
): AoiTracePromotionReport {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const generatedAt = input.now ?? input.shadowReport?.generatedAt ?? DEFAULT_TRACE_PROMOTION_NOW;
  const candidates = buildAoiTracePromotionCandidates({
    sessionPath,
    traceExports: input.traceExports,
    shadowReport: input.shadowReport,
    shadowDecisions: input.shadowDecisions,
    shadowLabels: input.shadowLabels,
    now: generatedAt,
  });
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const traceById = new Map(input.traceExports.map((traceExport) => [traceExport.id, traceExport]));
  const decisions = (input.promotionDecisions ?? []).filter((decision) =>
    candidateById.has(decision.candidateId),
  );
  const fixtureDrafts: AoiTracePromotionFixtureDraftOutput[] = [];
  const reportWarnings: string[] = [];
  let blockedPromotionCount = 0;

  for (const decision of decisions) {
    if (decision.action !== 'promote') {
      continue;
    }
    const candidate = candidateById.get(decision.candidateId);
    const traceExport = traceById.get(decision.sourceTraceId);
    if (!candidate || !traceExport || candidate.privacyStatus === 'blocked') {
      blockedPromotionCount += 1;
      reportWarnings.push(
        `Promotion blocked for ${sanitizePromotionText(decision.candidateId, 120)} by privacy gate or missing trace.`,
      );
      continue;
    }
    fixtureDrafts.push(createAoiTracePromotionFixtureDraft({ candidate, decision, traceExport }));
  }

  const evidenceRefs = uniqueStrings(
    [
      ...candidates.flatMap((candidate) => candidate.evidenceRefs),
      ...decisions.flatMap((decision) => decision.evidenceRefs),
      ...fixtureDrafts.flatMap((draft) => draft.evidenceRefs),
    ],
    24,
  );

  return {
    version: 1,
    id: `aoi-trace-promotion-report-${hashText(
      `${sessionPath}:${generatedAt}:${candidates.map((candidate) => candidate.id).join('|')}:${decisions
        .map((decision) => decision.id)
        .join('|')}`,
    )}`,
    sessionPath,
    generatedAt,
    candidateCount: candidates.length,
    decisionCount: decisions.length,
    promotedDraftCount: fixtureDrafts.length,
    blockedPromotionCount,
    candidates,
    decisions,
    fixtureDrafts,
    warnings: uniqueStrings(
      [
        ...reportWarnings,
        ...candidates.flatMap((candidate) => candidate.warnings),
        ...fixtureDrafts.flatMap((draft) => draft.warnings),
      ],
      16,
    ),
    evidenceRefs,
    mutationCount: 0,
  };
}
