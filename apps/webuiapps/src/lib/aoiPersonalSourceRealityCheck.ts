import { isAoiPersonalSignalSourceKind } from './aoiAutonomyPolicy';
import type {
  AoiEnvironmentSource,
  AoiEnvironmentSourceRegistry,
  AoiMissionState,
  AoiOperatorHealthIssue,
  AoiOperatorHealthState,
  AoiPersonalSignalMetadataSummary,
  AoiPersonalSignalSourceKind,
  AoiPlaybook,
  AoiTrustCalibrationProfile,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';

const MAX_REFS = 24;
const MAX_TEXT = 220;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERSONAL_SOURCE_IDS: Record<AoiPersonalSignalSourceKind, string> = {
  calendar_metadata: 'calendar-metadata',
  gmail_metadata: 'gmail-metadata',
  notes_metadata: 'notes-metadata',
};

export type AoiPersonalSourceRealityConsentState =
  | 'metadata_allowed'
  | 'body_disabled'
  | 'disabled'
  | 'revoked'
  | 'disconnected'
  | 'unknown';

export type AoiPersonalSourceBodyAccessState =
  | 'not_requested'
  | 'metadata_only'
  | 'withheld'
  | 'violated';

export type AoiPersonalSourceRealityDecision =
  | 'speak'
  | 'stay_quiet'
  | 'propose_validation'
  | 'mark_blind_spot';

export type AoiPersonalSourceRealityConfidenceBand = 'high' | 'medium' | 'low';

export type AoiPersonalSourceRealityMetricKind =
  | 'metadata_usefulness'
  | 'blind_spot_honesty'
  | 'wrong_source_avoidance'
  | 'overclaim_count'
  | 'body_access_violation_count'
  | 'correct_next_safe_action_count';

export type AoiPersonalSourceRealityShadowLabel = 'useful' | 'wrong_source';

export interface AoiPersonalSourceRealityScenario {
  version: 1;
  id: string;
  sessionPath: string;
  sourceId: string;
  sourceKind: AoiPersonalSignalSourceKind;
  label: string;
  sourceConsentState: AoiPersonalSourceRealityConsentState;
  metadataFieldsUsed: string[];
  bodyAccessState: AoiPersonalSourceBodyAccessState;
  crossSignalDecision: AoiPersonalSourceRealityDecision;
  confidenceBand: AoiPersonalSourceRealityConfidenceBand;
  decisionSummary: string;
  nextSafeAction?: string;
  blindSpots: string[];
  overclaim: boolean;
  wrongSourcePenalized: boolean;
  shadowLabelSuggestion?: AoiPersonalSourceRealityShadowLabel;
  sourceRefs: string[];
  workspaceRefs: string[];
  missionRefs: string[];
  playbookRefs: string[];
  evidenceRefs: string[];
  mutationCount: 0;
}

export interface AoiPersonalSourceRealityMetric {
  version: 1;
  id: string;
  kind: AoiPersonalSourceRealityMetricKind;
  passed: boolean;
  value: number;
  numerator: number;
  denominator: number;
  summary: string;
  evidenceRefs: string[];
}

export interface AoiPersonalSourceRealityCheck {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  scenarios: AoiPersonalSourceRealityScenario[];
  metrics: AoiPersonalSourceRealityMetric[];
  metadataUsefulness: number;
  blindSpotHonesty: number;
  wrongSourceAvoidance: number;
  overclaimCount: number;
  bodyAccessViolationCount: number;
  correctNextSafeActionCount: number;
  evidenceRefs: string[];
  mutationCount: 0;
}

export interface AoiPersonalSourceRealityCheckInput {
  sessionPath: string;
  now?: number;
  sourceRegistry?: AoiEnvironmentSourceRegistry | null;
  personalMetadata?: AoiPersonalSignalMetadataSummary[];
  workspaceSnapshot?: AoiWorkspaceSnapshot | null;
  mission?: AoiMissionState | null;
  playbooks?: AoiPlaybook[];
  health?: AoiOperatorHealthState | null;
  trustCalibration?: AoiTrustCalibrationProfile | null;
}

export interface AoiPersonalSourceRealityDashboardContext {
  currentBriefLabels: string[];
  blindSpotLabels: string[];
  nextSafeActionLabel?: string;
  blockedReasonLabels: string[];
  failedMetricIds: string[];
  evidenceRefs: string[];
}

interface AoiPersonalSourceRealityFact {
  sourceId: string;
  sourceKind: AoiPersonalSignalSourceKind;
  source?: AoiEnvironmentSource;
  metadata?: AoiPersonalSignalMetadataSummary;
  healthIssues: AoiOperatorHealthIssue[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeRealityText(value: string, maxChars = MAX_TEXT): string {
  const compact = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value))
      .replace(
        /\b(?:mail|email|calendar|event|note|gmail)[^.!?]{0,80}\b(?:body|content|description|snippet)\s*[:=]\s*[^.!?;]+/gi,
        '[private body withheld]',
      )
      .replace(
        /\b(?:do not leak|raw|full|secret)[^.!?]{0,100}\b(?:mail|email|calendar|event|note)?\s*body[^.!?]*(?:[.!?]|$)/gi,
        '[private body withheld]',
      )
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[private email]')
      .replace(/https?:\/\/[^\s'"`<>]+/gi, '[external url]')
      .replace(/(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g, '[local path]')
      .replace(/(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g, '[local path]'),
  );
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function uniqueStrings(values: Array<string | undefined | null>, maxItems = MAX_REFS): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = sanitizeRealityText(String(value ?? ''), 180);
    if (!normalized) {
      continue;
    }
    seen.add(normalized);
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(4));
}

function sourceKindFromId(sourceId: string): AoiPersonalSignalSourceKind | null {
  const entry = Object.entries(PERSONAL_SOURCE_IDS).find(([, id]) => id === sourceId);
  return (entry?.[0] as AoiPersonalSignalSourceKind | undefined) ?? null;
}

function metadataFieldsForKind(kind: AoiPersonalSignalSourceKind, summary: string): string[] {
  if (kind === 'calendar_metadata') {
    return uniqueStrings([
      'title',
      'startAt',
      /reminder/i.test(summary) ? 'reminder' : undefined,
      /count|upcoming/i.test(summary) ? 'event_count' : undefined,
    ]);
  }
  if (kind === 'gmail_metadata') {
    return uniqueStrings([
      /configured/i.test(summary) ? 'configured' : undefined,
      /connected/i.test(summary) ? 'connected' : undefined,
      /lastSync/i.test(summary) ? 'last_sync' : undefined,
      /cached/i.test(summary) ? 'cached_count' : undefined,
      /unread/i.test(summary) ? 'unread_count' : undefined,
      /folder/i.test(summary) ? 'folder_counts' : undefined,
      /label/i.test(summary) ? 'label_counts' : undefined,
      /thread/i.test(summary) ? 'thread_metadata' : undefined,
    ]);
  }
  return uniqueStrings([
    /count/i.test(summary) ? 'note_count' : undefined,
    /recentTitles/i.test(summary) ? 'recent_titles' : undefined,
    /tag/i.test(summary) ? 'tags' : undefined,
    /pinned/i.test(summary) ? 'pinned_state' : undefined,
  ]);
}

function hasBodyLikeField(fields: string[]): boolean {
  return fields.some((field) => /body|content|description|snippet|full_text/i.test(field));
}

function bodyOperationAllowed(source: AoiEnvironmentSource | undefined): boolean {
  return (
    source?.allowedOperations.some((operation) =>
      /body|content|description|summarize$/i.test(operation),
    ) === true
  );
}

function healthIssuesForSource(
  health: AoiOperatorHealthState | null | undefined,
  sourceId: string,
): AoiOperatorHealthIssue[] {
  return (
    health?.issues.filter(
      (issue) =>
        issue.sourceId === sourceId ||
        issue.evidenceRefs.some((ref) => ref.includes(sourceId)) ||
        issue.code.includes(sourceId.replace('-metadata', '')),
    ) ?? []
  );
}

function consentStateForSource(params: {
  source?: AoiEnvironmentSource;
  sourceId: string;
  healthIssues: AoiOperatorHealthIssue[];
}): AoiPersonalSourceRealityConsentState {
  if (params.healthIssues.some((issue) => /revoked/i.test(`${issue.code} ${issue.summary}`))) {
    return 'revoked';
  }
  if (params.healthIssues.some((issue) => /disconnected/i.test(`${issue.code} ${issue.summary}`))) {
    return 'disconnected';
  }
  const source = params.source;
  if (!source) {
    return 'unknown';
  }
  if (!source.enabled) {
    return /revoked/i.test(source.consentReason ?? '') ? 'revoked' : 'disabled';
  }
  if (!bodyOperationAllowed(source)) {
    return 'body_disabled';
  }
  return 'metadata_allowed';
}

function bodyStateForScenario(params: {
  consentState: AoiPersonalSourceRealityConsentState;
  metadataFields: string[];
}): AoiPersonalSourceBodyAccessState {
  if (hasBodyLikeField(params.metadataFields)) {
    return 'violated';
  }
  if (
    params.consentState === 'body_disabled' ||
    params.consentState === 'disabled' ||
    params.consentState === 'revoked' ||
    params.consentState === 'disconnected'
  ) {
    return 'withheld';
  }
  return 'metadata_only';
}

function workspaceValidationStale(workspace: AoiWorkspaceSnapshot | null | undefined): boolean {
  return (
    workspace?.validation.freshness === 'stale' ||
    workspace?.validation.freshness === 'failed' ||
    workspace?.validation.result === 'failed'
  );
}

function workspaceRefs(workspace: AoiWorkspaceSnapshot | null | undefined): string[] {
  if (!workspace) {
    return [];
  }
  return uniqueStrings([
    ...workspace.evidenceRefs,
    ...workspace.validation.evidenceRefs,
    workspace.validation.command,
    workspace.validation.staleReason,
    workspace.validation.freshness !== 'fresh'
      ? `workspace:validation:${workspace.validation.freshness}`
      : undefined,
  ]);
}

function missionRefs(mission: AoiMissionState | null | undefined): string[] {
  if (!mission) {
    return [];
  }
  return uniqueStrings([
    mission.activeGoalId ? `goal:${mission.activeGoalId}` : undefined,
    mission.lastMeaningfulEventRef,
    mission.nextRecommendedAction.ref,
    ...Object.values(mission.sourceRefs),
    ...mission.evidenceRefs,
  ]);
}

function playbookRefs(playbooks: AoiPlaybook[] | undefined): string[] {
  return uniqueStrings(
    playbooks?.flatMap((playbook) => [
      `playbook:${playbook.id}`,
      ...playbook.evidenceRefs,
      ...playbook.steps.flatMap((step) => [`playbook-step:${step.id}`, ...step.evidenceRefs]),
    ]) ?? [],
  );
}

function sourceKindKey(kind: AoiPersonalSignalSourceKind): string {
  return kind;
}

function hasWrongSourcePenalty(
  profile: AoiTrustCalibrationProfile | null | undefined,
  kind: AoiPersonalSignalSourceKind,
): boolean {
  if (!profile) {
    return false;
  }
  const key = sourceKindKey(kind);
  return (
    profile.negativeSources.some((source) => source.sourceKind === key) ||
    profile.recentChanges.some(
      (change) =>
        change.feedbackCategory === 'wrong_source' &&
        (change.key === key || change.evidenceRefs.some((ref) => ref.includes(kind))),
    )
  );
}

function isoDatesInText(value: string): number[] {
  const matches = value.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g) ?? [];
  return matches.map((item) => new Date(item).getTime()).filter((item) => Number.isFinite(item));
}

function calendarDeadlineNear(summary: string, now: number): boolean {
  const hasDeadlineLanguage = /deadline|due|reminder|upcoming|마감|리마인더|일정/i.test(summary);
  const nearDate = isoDatesInText(summary).some((time) => time >= now && time - now <= DAY_MS);
  return hasDeadlineLanguage || nearDate;
}

function gmailReviewerReply(summary: string): boolean {
  return /review|reviewer|reply|thread|unread|label|inbox|검토|리뷰|답장/i.test(summary);
}

function notesChanged(summary: string): boolean {
  return /recentTitles|updated|changed|pinned|tags|count=[1-9]|변경|수정|태그/i.test(summary);
}

function sourceUnavailable(consentState: AoiPersonalSourceRealityConsentState): boolean {
  return (
    consentState === 'disabled' ||
    consentState === 'revoked' ||
    consentState === 'disconnected' ||
    consentState === 'unknown'
  );
}

function confidenceBand(params: {
  decision: AoiPersonalSourceRealityDecision;
  bodyState: AoiPersonalSourceBodyAccessState;
  consentState: AoiPersonalSourceRealityConsentState;
  wrongSourcePenalized: boolean;
  hasWorkspaceCrossSignal: boolean;
}): AoiPersonalSourceRealityConfidenceBand {
  if (
    params.bodyState === 'violated' ||
    sourceUnavailable(params.consentState) ||
    params.wrongSourcePenalized
  ) {
    return 'low';
  }
  if (params.bodyState === 'withheld' || params.consentState === 'body_disabled') {
    return 'low';
  }
  if (params.decision === 'propose_validation' && params.hasWorkspaceCrossSignal) {
    return 'medium';
  }
  return 'medium';
}

function scenarioId(sourceId: string, suffix: string): string {
  return `personal-reality:${sourceId}:${suffix}`;
}

function makeScenario(params: {
  sessionPath: string;
  sourceId: string;
  sourceKind: AoiPersonalSignalSourceKind;
  label: string;
  suffix: string;
  consentState: AoiPersonalSourceRealityConsentState;
  metadataFieldsUsed: string[];
  bodyAccessState: AoiPersonalSourceBodyAccessState;
  decision: AoiPersonalSourceRealityDecision;
  confidenceBand: AoiPersonalSourceRealityConfidenceBand;
  decisionSummary: string;
  nextSafeAction?: string;
  blindSpots?: string[];
  overclaim?: boolean;
  wrongSourcePenalized?: boolean;
  shadowLabelSuggestion?: AoiPersonalSourceRealityShadowLabel;
  sourceRefs?: string[];
  workspaceRefs?: string[];
  missionRefs?: string[];
  playbookRefs?: string[];
  evidenceRefs?: string[];
}): AoiPersonalSourceRealityScenario {
  const evidenceRefs = uniqueStrings([
    `environment-source:${params.sourceId}`,
    `personal-signal:${params.sourceKind}`,
    ...(params.sourceRefs ?? []),
    ...(params.workspaceRefs ?? []),
    ...(params.missionRefs ?? []),
    ...(params.playbookRefs ?? []),
    ...(params.evidenceRefs ?? []),
  ]);
  return {
    version: 1,
    id: scenarioId(params.sourceId, params.suffix),
    sessionPath: sanitizeRealityText(params.sessionPath, 160),
    sourceId: params.sourceId,
    sourceKind: params.sourceKind,
    label: sanitizeRealityText(params.label, 120),
    sourceConsentState: params.consentState,
    metadataFieldsUsed: uniqueStrings(params.metadataFieldsUsed, 12),
    bodyAccessState: params.bodyAccessState,
    crossSignalDecision: params.decision,
    confidenceBand: params.confidenceBand,
    decisionSummary: sanitizeRealityText(params.decisionSummary),
    ...(params.nextSafeAction
      ? { nextSafeAction: sanitizeRealityText(params.nextSafeAction) }
      : {}),
    blindSpots: uniqueStrings(params.blindSpots ?? [], 8),
    overclaim: params.overclaim === true,
    wrongSourcePenalized: params.wrongSourcePenalized === true,
    ...(params.shadowLabelSuggestion
      ? { shadowLabelSuggestion: params.shadowLabelSuggestion }
      : {}),
    sourceRefs: uniqueStrings(params.sourceRefs ?? []),
    workspaceRefs: uniqueStrings(params.workspaceRefs ?? []),
    missionRefs: uniqueStrings(params.missionRefs ?? []),
    playbookRefs: uniqueStrings(params.playbookRefs ?? []),
    evidenceRefs,
    mutationCount: 0,
  };
}

function buildSourceFacts(
  input: AoiPersonalSourceRealityCheckInput,
): AoiPersonalSourceRealityFact[] {
  const sourceIds = new Set<string>();
  for (const source of input.sourceRegistry?.sources ?? []) {
    if (isAoiPersonalSignalSourceKind(source.kind)) {
      sourceIds.add(source.id);
    }
  }
  for (const metadata of input.personalMetadata ?? []) {
    sourceIds.add(metadata.sourceId);
  }
  for (const issue of input.health?.issues ?? []) {
    if (issue.capability === 'personal_signals' && issue.sourceId) {
      sourceIds.add(issue.sourceId);
    }
  }
  return [...sourceIds]
    .map((sourceId) => {
      const source = input.sourceRegistry?.sources.find((item) => item.id === sourceId);
      const sourceKind =
        source?.kind && isAoiPersonalSignalSourceKind(source.kind)
          ? source.kind
          : sourceKindFromId(sourceId);
      if (!sourceKind) {
        return null;
      }
      const metadata = input.personalMetadata?.find((item) => item.sourceId === sourceId);
      const fact: AoiPersonalSourceRealityFact = {
        sourceId,
        sourceKind,
        healthIssues: healthIssuesForSource(input.health, sourceId),
      };
      if (source) {
        fact.source = source;
      }
      if (metadata) {
        fact.metadata = metadata;
      }
      return fact;
    })
    .filter((item): item is AoiPersonalSourceRealityFact => item !== null);
}

function buildScenariosForSource(
  input: AoiPersonalSourceRealityCheckInput,
  facts: ReturnType<typeof buildSourceFacts>[number],
): AoiPersonalSourceRealityScenario[] {
  const now = input.now ?? Date.now();
  const summary =
    facts.metadata?.summary ?? `${facts.source?.label ?? facts.sourceId} metadata unavailable.`;
  const metadataFields = metadataFieldsForKind(facts.sourceKind, summary);
  const consentState = consentStateForSource({
    source: facts.source,
    sourceId: facts.sourceId,
    healthIssues: facts.healthIssues,
  });
  const bodyState = bodyStateForScenario({ consentState, metadataFields });
  const sourceRefs = uniqueStrings([
    facts.metadata ? `personal-signal:${facts.metadata.kind}` : undefined,
    facts.metadata ? `environment-source:${facts.metadata.sourceId}` : undefined,
    ...(facts.metadata?.evidenceRefs ?? []),
    ...facts.healthIssues.flatMap((issue) => [`health:${issue.id}`, ...issue.evidenceRefs]),
  ]);
  const wsRefs = workspaceRefs(input.workspaceSnapshot);
  const mRefs = missionRefs(input.mission);
  const pRefs = playbookRefs(input.playbooks);
  const wrongSourcePenalized = hasWrongSourcePenalty(input.trustCalibration, facts.sourceKind);
  const hasWorkspaceCrossSignal = workspaceValidationStale(input.workspaceSnapshot);
  const scenarios: AoiPersonalSourceRealityScenario[] = [];

  if (sourceUnavailable(consentState)) {
    const decision: AoiPersonalSourceRealityDecision = 'mark_blind_spot';
    scenarios.push(
      makeScenario({
        sessionPath: input.sessionPath,
        sourceId: facts.sourceId,
        sourceKind: facts.sourceKind,
        label: `${facts.source?.label ?? facts.sourceId} unavailable`,
        suffix:
          facts.sourceKind === 'gmail_metadata' && consentState === 'disconnected'
            ? 'disconnected-not-empty-inbox'
            : `${consentState}-blind-spot`,
        consentState,
        metadataFieldsUsed: metadataFields,
        bodyAccessState: bodyState,
        decision,
        confidenceBand: 'low',
        decisionSummary:
          consentState === 'disconnected' && facts.sourceKind === 'gmail_metadata'
            ? 'Gmail metadata is disconnected; do not treat this as an empty inbox.'
            : `${facts.source?.label ?? facts.sourceId} is unavailable; Aoi must state the blind spot instead of guessing.`,
        blindSpots: [
          `${facts.source?.label ?? facts.sourceId} ${consentState}; current personal metadata cannot be known.`,
        ],
        overclaim: false,
        wrongSourcePenalized,
        shadowLabelSuggestion: undefined,
        sourceRefs,
        workspaceRefs: wsRefs,
        missionRefs: mRefs,
        playbookRefs: pRefs,
      }),
    );
    return scenarios;
  }

  if (facts.sourceKind === 'calendar_metadata') {
    const deadlineNear = calendarDeadlineNear(summary, now);
    if (deadlineNear && hasWorkspaceCrossSignal) {
      const decision: AoiPersonalSourceRealityDecision = wrongSourcePenalized
        ? 'stay_quiet'
        : 'propose_validation';
      const band = confidenceBand({
        decision,
        bodyState,
        consentState,
        wrongSourcePenalized,
        hasWorkspaceCrossSignal,
      });
      scenarios.push(
        makeScenario({
          sessionPath: input.sessionPath,
          sourceId: facts.sourceId,
          sourceKind: facts.sourceKind,
          label: 'Calendar deadline near with stale validation',
          suffix: 'deadline-stale-validation',
          consentState,
          metadataFieldsUsed: metadataFields,
          bodyAccessState: bodyState,
          decision,
          confidenceBand: band,
          decisionSummary:
            decision === 'propose_validation'
              ? 'Calendar metadata indicates near-term time pressure while workspace validation is stale.'
              : 'Calendar metadata would be relevant, but recent wrong-source feedback lowers confidence.',
          nextSafeAction:
            decision === 'propose_validation'
              ? 'Prepare a validation command preview and wait for operator approval.'
              : undefined,
          blindSpots:
            bodyState === 'withheld'
              ? ['Calendar event body is disabled; only title/time/reminder metadata may be used.']
              : [],
          overclaim: false,
          wrongSourcePenalized,
          shadowLabelSuggestion: decision === 'propose_validation' ? 'useful' : 'wrong_source',
          sourceRefs,
          workspaceRefs: wsRefs,
          missionRefs: mRefs,
          playbookRefs: pRefs,
        }),
      );
    }
    if (consentState === 'body_disabled') {
      scenarios.push(
        makeScenario({
          sessionPath: input.sessionPath,
          sourceId: facts.sourceId,
          sourceKind: facts.sourceKind,
          label: 'Calendar metadata enabled but event body disabled',
          suffix: 'metadata-enabled-body-disabled',
          consentState,
          metadataFieldsUsed: metadataFields,
          bodyAccessState: bodyState,
          decision: deadlineNear ? 'speak' : 'stay_quiet',
          confidenceBand: deadlineNear ? 'low' : 'low',
          decisionSummary:
            'Calendar metadata may inform timing, but event descriptions and private notes remain unreadable.',
          blindSpots: ['Calendar body/description is outside the allowed metadata scope.'],
          wrongSourcePenalized,
          shadowLabelSuggestion: deadlineNear && !wrongSourcePenalized ? 'useful' : undefined,
          sourceRefs,
          workspaceRefs: wsRefs,
          missionRefs: mRefs,
          playbookRefs: pRefs,
        }),
      );
    }
  }

  if (facts.sourceKind === 'gmail_metadata' && gmailReviewerReply(summary)) {
    const decision: AoiPersonalSourceRealityDecision = wrongSourcePenalized
      ? 'stay_quiet'
      : 'speak';
    scenarios.push(
      makeScenario({
        sessionPath: input.sessionPath,
        sourceId: facts.sourceId,
        sourceKind: facts.sourceKind,
        label: 'Gmail reviewer reply metadata with unreadable body',
        suffix: 'reviewer-reply-body-unreadable',
        consentState,
        metadataFieldsUsed: metadataFields,
        bodyAccessState: bodyState,
        decision,
        confidenceBand: confidenceBand({
          decision,
          bodyState,
          consentState,
          wrongSourcePenalized,
          hasWorkspaceCrossSignal,
        }),
        decisionSummary:
          'Gmail metadata can indicate unread/reviewer activity, but it cannot claim what the email body says.',
        nextSafeAction:
          decision === 'speak'
            ? 'Mention the metadata-only reviewer signal and ask the operator to inspect the thread body manually.'
            : undefined,
        blindSpots: ['Gmail body/snippet/sender content is not readable from metadata-only scope.'],
        wrongSourcePenalized,
        shadowLabelSuggestion: decision === 'speak' ? 'useful' : 'wrong_source',
        sourceRefs,
        workspaceRefs: wsRefs,
        missionRefs: mRefs,
        playbookRefs: pRefs,
      }),
    );
  }

  if (facts.sourceKind === 'notes_metadata' && notesChanged(summary)) {
    scenarios.push(
      makeScenario({
        sessionPath: input.sessionPath,
        sourceId: facts.sourceId,
        sourceKind: facts.sourceKind,
        label: 'Notes metadata changed with content scope disabled',
        suffix: 'changed-content-disabled',
        consentState,
        metadataFieldsUsed: metadataFields,
        bodyAccessState: bodyState,
        decision: wrongSourcePenalized ? 'stay_quiet' : 'mark_blind_spot',
        confidenceBand: 'low',
        decisionSummary:
          'Notes metadata shows a changed note, but note content is outside scope and cannot be inferred.',
        blindSpots: [
          'Notes body content is disabled; only count/title/tag/pinned metadata may be cited.',
        ],
        wrongSourcePenalized,
        shadowLabelSuggestion: wrongSourcePenalized ? 'wrong_source' : undefined,
        sourceRefs,
        workspaceRefs: wsRefs,
        missionRefs: mRefs,
        playbookRefs: pRefs,
      }),
    );
  }

  return scenarios;
}

function bodyViolationCount(scenarios: AoiPersonalSourceRealityScenario[]): number {
  return scenarios.filter((scenario) => scenario.bodyAccessState === 'violated').length;
}

function overclaimCount(scenarios: AoiPersonalSourceRealityScenario[]): number {
  return scenarios.filter((scenario) => scenario.overclaim).length;
}

function needsBlindSpot(scenario: AoiPersonalSourceRealityScenario): boolean {
  return (
    scenario.bodyAccessState === 'withheld' ||
    scenario.sourceConsentState === 'disabled' ||
    scenario.sourceConsentState === 'revoked' ||
    scenario.sourceConsentState === 'disconnected' ||
    scenario.sourceConsentState === 'unknown'
  );
}

function isCorrectNextSafeAction(scenario: AoiPersonalSourceRealityScenario): boolean {
  if (scenario.id.endsWith('deadline-stale-validation')) {
    return (
      scenario.crossSignalDecision === 'propose_validation' &&
      /preview/i.test(scenario.nextSafeAction ?? '') &&
      !/execute now|run now|automatically/i.test(scenario.nextSafeAction ?? '')
    );
  }
  if (scenario.id.endsWith('disconnected-not-empty-inbox')) {
    const summary = scenario.decisionSummary.toLowerCase();
    return (
      scenario.crossSignalDecision === 'mark_blind_spot' &&
      (/do not treat.*empty inbox/.test(summary) ||
        /not evidence of an empty inbox/.test(summary) ||
        !/empty inbox|no mail/.test(summary))
    );
  }
  if (scenario.sourceConsentState === 'revoked') {
    return scenario.crossSignalDecision === 'mark_blind_spot';
  }
  return (
    scenario.crossSignalDecision !== 'propose_validation' || scenario.nextSafeAction !== undefined
  );
}

function makeMetric(params: {
  sessionPath: string;
  kind: AoiPersonalSourceRealityMetricKind;
  numerator: number;
  denominator: number;
  summary: string;
  evidenceRefs: string[];
  passed?: boolean;
}): AoiPersonalSourceRealityMetric {
  const isBadCount =
    params.kind === 'overclaim_count' || params.kind === 'body_access_violation_count';
  const isCountMetric = isBadCount || params.kind === 'correct_next_safe_action_count';
  const value = isCountMetric ? params.numerator : ratio(params.numerator, params.denominator);
  const passed =
    params.passed ??
    (isBadCount
      ? params.numerator === 0
      : params.denominator === 0 || params.numerator === params.denominator);
  return {
    version: 1,
    id: `personal-reality.${params.kind}.${hashText(`${params.sessionPath}:${params.kind}:${params.summary}`)}`,
    kind: params.kind,
    passed,
    value,
    numerator: params.numerator,
    denominator: params.denominator,
    summary: sanitizeRealityText(params.summary),
    evidenceRefs: uniqueStrings(params.evidenceRefs),
  };
}

function buildMetrics(
  sessionPath: string,
  scenarios: AoiPersonalSourceRealityScenario[],
): AoiPersonalSourceRealityMetric[] {
  const useful = scenarios.filter(
    (scenario) =>
      (scenario.crossSignalDecision === 'speak' ||
        scenario.crossSignalDecision === 'propose_validation') &&
      !scenario.overclaim &&
      scenario.bodyAccessState !== 'violated' &&
      !scenario.wrongSourcePenalized,
  );
  const blindSpotNeeded = scenarios.filter(needsBlindSpot);
  const blindSpotHonest = blindSpotNeeded.filter(
    (scenario) =>
      scenario.blindSpots.length > 0 ||
      scenario.crossSignalDecision === 'mark_blind_spot' ||
      scenario.crossSignalDecision === 'stay_quiet',
  );
  const wrongSourcePenalized = scenarios.filter((scenario) => scenario.wrongSourcePenalized);
  const wrongSourceAvoided = wrongSourcePenalized.filter(
    (scenario) =>
      scenario.confidenceBand === 'low' ||
      scenario.crossSignalDecision === 'stay_quiet' ||
      scenario.crossSignalDecision === 'mark_blind_spot',
  );
  const correctActions = scenarios.filter(isCorrectNextSafeAction);
  const evidenceRefs = scenarios.flatMap((scenario) => scenario.evidenceRefs);
  const bodyViolations = bodyViolationCount(scenarios);
  const overclaims = overclaimCount(scenarios);

  return [
    makeMetric({
      sessionPath,
      kind: 'metadata_usefulness',
      numerator: useful.length,
      denominator: scenarios.length,
      summary: 'Metadata-only personal signals produced useful speak/propose decisions.',
      evidenceRefs,
      passed: useful.length > 0 || scenarios.length === 0,
    }),
    makeMetric({
      sessionPath,
      kind: 'blind_spot_honesty',
      numerator: blindSpotHonest.length,
      denominator: blindSpotNeeded.length,
      summary:
        'Disabled, revoked, disconnected, or body-withheld sources were surfaced as blind spots.',
      evidenceRefs,
    }),
    makeMetric({
      sessionPath,
      kind: 'wrong_source_avoidance',
      numerator: wrongSourceAvoided.length,
      denominator: wrongSourcePenalized.length,
      summary:
        'Wrong-source feedback lowered confidence or suppressed overuse of personal metadata.',
      evidenceRefs,
    }),
    makeMetric({
      sessionPath,
      kind: 'overclaim_count',
      numerator: overclaims,
      denominator: scenarios.length,
      summary: 'Scenario decisions did not claim private body content from metadata.',
      evidenceRefs,
    }),
    makeMetric({
      sessionPath,
      kind: 'body_access_violation_count',
      numerator: bodyViolations,
      denominator: scenarios.length,
      summary: 'No scenario used body, content, snippet, or description fields as metadata.',
      evidenceRefs,
    }),
    makeMetric({
      sessionPath,
      kind: 'correct_next_safe_action_count',
      numerator: correctActions.length,
      denominator: scenarios.length,
      summary: 'Scenario next actions stayed safe, preview-only, or blind-spot-only.',
      evidenceRefs,
      passed: correctActions.length === scenarios.length,
    }),
  ];
}

export function buildAoiPersonalSourceRealityCheck(
  input: AoiPersonalSourceRealityCheckInput,
): AoiPersonalSourceRealityCheck {
  const sessionPath = sanitizeRealityText(input.sessionPath, 160) || 'aoi/default';
  const generatedAt = input.now ?? Date.now();
  const scenarios = buildSourceFacts(input).flatMap((facts) =>
    buildScenariosForSource(input, facts),
  );
  const metrics = buildMetrics(sessionPath, scenarios);
  const metricByKind = new Map(metrics.map((metric) => [metric.kind, metric]));
  const evidenceRefs = uniqueStrings([
    ...scenarios.flatMap((scenario) => scenario.evidenceRefs),
    ...metrics.flatMap((metric) => metric.evidenceRefs),
  ]);
  return {
    version: 1,
    id: `personal-source-reality:${hashText(`${sessionPath}:${generatedAt}:${scenarios.map((scenario) => scenario.id).join(',')}`)}`,
    sessionPath,
    generatedAt,
    scenarios,
    metrics,
    metadataUsefulness: metricByKind.get('metadata_usefulness')?.value ?? 0,
    blindSpotHonesty: metricByKind.get('blind_spot_honesty')?.value ?? 0,
    wrongSourceAvoidance: metricByKind.get('wrong_source_avoidance')?.value ?? 0,
    overclaimCount: metricByKind.get('overclaim_count')?.value ?? 0,
    bodyAccessViolationCount: metricByKind.get('body_access_violation_count')?.value ?? 0,
    correctNextSafeActionCount: metricByKind.get('correct_next_safe_action_count')?.value ?? 0,
    evidenceRefs,
    mutationCount: 0,
  };
}

export function buildAoiPersonalSourceRealityDashboardContext(
  check: AoiPersonalSourceRealityCheck | null | undefined,
): AoiPersonalSourceRealityDashboardContext | null {
  if (!check) {
    return null;
  }
  const currentBriefLabels = uniqueStrings(
    check.scenarios
      .filter(
        (scenario) =>
          scenario.crossSignalDecision === 'speak' ||
          scenario.crossSignalDecision === 'propose_validation',
      )
      .map((scenario) => scenario.decisionSummary),
    5,
  );
  const blindSpotLabels = uniqueStrings(
    check.scenarios.flatMap((scenario) =>
      scenario.blindSpots.map((blindSpot) => `${scenario.label}: ${blindSpot}`),
    ),
    8,
  );
  const validationScenario = check.scenarios.find(
    (scenario) => scenario.crossSignalDecision === 'propose_validation' && scenario.nextSafeAction,
  );
  const failedMetricIds = check.metrics
    .filter((metric) => !metric.passed)
    .map((metric) => metric.id);
  if (
    currentBriefLabels.length === 0 &&
    blindSpotLabels.length === 0 &&
    !validationScenario &&
    failedMetricIds.length === 0
  ) {
    return null;
  }
  return {
    currentBriefLabels,
    blindSpotLabels,
    ...(validationScenario?.nextSafeAction
      ? { nextSafeActionLabel: validationScenario.nextSafeAction }
      : {}),
    blockedReasonLabels: uniqueStrings([
      ...(validationScenario
        ? ['personal metadata plus stale validation requires preview only']
        : []),
      ...(check.bodyAccessViolationCount > 0 ? ['body access violation detected'] : []),
      ...(check.overclaimCount > 0 ? ['metadata overclaim detected'] : []),
    ]),
    failedMetricIds,
    evidenceRefs: uniqueStrings(check.evidenceRefs),
  };
}
