import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import { applyAoiTrustCalibration } from './aoiTrustCalibration';
import type {
  AoiDigestItem,
  AoiMissionState,
  AoiOperatorDigest,
  AoiOperatorVoiceEvent,
  AoiOperatorVoiceEventCategory,
  AoiOperatorVoicePolicy,
  AoiProposalDecision,
  AoiTrustCalibrationProfile,
  AoiVoiceInterruptionLevel,
  AoiVoiceQuietWindow,
  AoiVoiceRenderDecision,
  AoiVoiceRenderDecisionStatus,
} from './aoiAutonomyTypes';

const VOICE_SUMMARY_MAX_CHARS = 320;
const VOICE_REASON_MAX_CHARS = 160;
const VOICE_REFS_MAX_ITEMS = 12;

const VOICE_CATEGORY_ORDER: AoiOperatorVoiceEventCategory[] = [
  'session_resume',
  'critical_blocker',
  'approval_required',
  'completion_update',
  'health_degraded',
  'fyi',
];

const VOICE_LEVEL_RANK: Record<AoiVoiceInterruptionLevel, number> = {
  silent: 0,
  ambient: 1,
  mission: 2,
  blocking: 3,
};

const NEGATIVE_VOICE_FEEDBACK = new Set([
  'dismiss',
  'not_useful',
  'wrong_evidence',
  'wrong_source',
  'wrong_timing',
  'too_frequent',
  'too_much',
  'unsafe',
]);

const PERSONAL_SOURCE_REF_PATTERNS = [
  'personal-signal:',
  'calendar_metadata',
  'gmail_metadata',
  'notes_metadata',
  'calendar-metadata',
  'gmail-metadata',
  'notes-metadata',
];

export const AOI_OPERATOR_VOICE_CATEGORY_LABELS: Record<AoiOperatorVoiceEventCategory, string> = {
  session_resume: 'Session resume brief',
  critical_blocker: 'Critical blocked state',
  approval_required: 'Approval required summary',
  completion_update: 'Completed Kira or research update',
  health_degraded: 'Health degraded warning',
  fyi: 'Low-value FYI',
};

export const DEFAULT_AOI_OPERATOR_VOICE_ALLOWED_CATEGORIES: Record<
  AoiOperatorVoiceEventCategory,
  boolean
> = {
  session_resume: true,
  critical_blocker: true,
  approval_required: true,
  completion_update: true,
  health_degraded: true,
  fyi: false,
};

export interface AoiOperatorVoiceEventBuildInput {
  digest: AoiOperatorDigest;
  mission?: AoiMissionState | null;
  now?: number;
}

export interface AoiOperatorVoiceDecisionInput {
  sessionPath: string;
  event?: AoiOperatorVoiceEvent | null;
  policy?: AoiOperatorVoicePolicy | null;
  mission?: AoiMissionState | null;
  ttsEnabled: boolean;
  mutedForSession?: boolean;
  previousSpokenDedupeKeys?: Iterable<string>;
  recentDecisions?: AoiProposalDecision[];
  trustCalibrationProfile?: AoiTrustCalibrationProfile | null;
  now?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripTrailingSentencePunctuation(value: string): string {
  return value.replace(/[.!?]+$/u, '').trim();
}

function sentenceFragment(value: string, maxChars: number): string {
  return stripTrailingSentencePunctuation(sanitizeVoiceText(value, maxChars)).replace(
    /[.!?]+/g,
    ';',
  );
}

function sanitizeVoiceText(value: string, maxChars = VOICE_SUMMARY_MAX_CHARS): string {
  const sanitized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value)),
  ).replace(/\b(?:proposal|memory|research|kira|workspace|goal|episode):[A-Za-z0-9._/-]+/g, '');
  const normalized = normalizeWhitespace(sanitized);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function hashPart(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 12);
}

function voiceId(prefix: string, parts: string[], now: number): string {
  return `${prefix}-${hashPart(parts.join('|'))}-${Math.max(0, Math.round(now))}`.slice(0, 127);
}

function dedupeRefs(refs: Array<string | undefined>, maxItems = VOICE_REFS_MAX_ITEMS): string[] {
  const seen = new Set<string>();
  for (const ref of refs) {
    const normalized = sanitizeVoiceText(ref ?? '', 180);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function isVoiceCategory(value: unknown): value is AoiOperatorVoiceEventCategory {
  return typeof value === 'string' && VOICE_CATEGORY_ORDER.includes(value as never);
}

function isVoiceLevel(value: unknown): value is AoiVoiceInterruptionLevel {
  return value === 'silent' || value === 'ambient' || value === 'mission' || value === 'blocking';
}

export function getDefaultAoiOperatorVoicePolicy(): AoiOperatorVoicePolicy {
  return {
    version: 1,
    enabled: true,
    allowedCategories: { ...DEFAULT_AOI_OPERATOR_VOICE_ALLOWED_CATEGORIES },
    quietWindows: [],
    personalMetadataVoiceScope: 'redacted',
    minInterruptionLevel: 'mission',
  };
}

function normalizeQuietWindow(value: unknown): AoiVoiceQuietWindow | null {
  if (!isRecord(value)) {
    return null;
  }
  const reason = sanitizeVoiceText(
    typeof value.reason === 'string' ? value.reason : 'Quiet window is active.',
    VOICE_REASON_MAX_CHARS,
  );
  const categories = Array.isArray(value.categories)
    ? value.categories.filter(isVoiceCategory).slice(0, VOICE_CATEGORY_ORDER.length)
    : undefined;
  return {
    version: 1,
    enabled: value.enabled !== false,
    reason: reason || 'Quiet window is active.',
    ...(typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)
      ? { startedAt: value.startedAt }
      : {}),
    ...(typeof value.endsAt === 'number' && Number.isFinite(value.endsAt)
      ? { endsAt: value.endsAt }
      : {}),
    ...(categories && categories.length > 0 ? { categories } : {}),
  };
}

export function normalizeAoiOperatorVoicePolicy(
  value: Partial<AoiOperatorVoicePolicy> | null | undefined,
): AoiOperatorVoicePolicy {
  const defaults = getDefaultAoiOperatorVoicePolicy();
  if (!isRecord(value)) {
    return defaults;
  }
  const rawAllowed = isRecord(value.allowedCategories) ? value.allowedCategories : {};
  const allowedCategories = VOICE_CATEGORY_ORDER.reduce(
    (acc, category) => ({
      ...acc,
      [category]:
        typeof rawAllowed[category] === 'boolean'
          ? rawAllowed[category]
          : defaults.allowedCategories[category],
    }),
    {} as Record<AoiOperatorVoiceEventCategory, boolean>,
  );
  const quietWindows = Array.isArray(value.quietWindows)
    ? value.quietWindows
        .map(normalizeQuietWindow)
        .filter((item): item is AoiVoiceQuietWindow => Boolean(item))
    : [];

  return {
    version: 1,
    enabled: value.enabled !== false,
    allowedCategories,
    quietWindows,
    personalMetadataVoiceScope:
      value.personalMetadataVoiceScope === 'metadata' ? 'metadata' : 'redacted',
    minInterruptionLevel: isVoiceLevel(value.minInterruptionLevel)
      ? value.minInterruptionLevel
      : defaults.minInterruptionLevel,
  };
}

function hasPersonalMetadataRef(refs: string[]): boolean {
  return refs.some((ref) => {
    const normalized = ref.toLowerCase();
    return PERSONAL_SOURCE_REF_PATTERNS.some((pattern) => normalized.includes(pattern));
  });
}

function isDigestItemVisible(item: AoiDigestItem): boolean {
  return !item.hidden && item.lane !== 'hidden_by_quiet_mode';
}

function eventFromDigestItem(params: {
  digest: AoiOperatorDigest;
  item: AoiDigestItem;
  category: AoiOperatorVoiceEventCategory;
  interruptionLevel: AoiVoiceInterruptionLevel;
  now: number;
  approvalBoundary?: string;
}): AoiOperatorVoiceEvent {
  const refs = dedupeRefs([...params.item.sourceRefs, ...params.item.evidenceRefs]);
  return {
    version: 1,
    id: voiceId('aoi-voice-event', [params.item.id, params.category], params.now),
    sessionPath: params.digest.sessionPath,
    category: params.category,
    interruptionLevel: params.interruptionLevel,
    title: params.item.title,
    whatChanged: params.item.summary,
    nextSafeAction: params.item.nextSafeAction,
    ...(params.approvalBoundary ? { approvalBoundary: params.approvalBoundary } : {}),
    risk: params.item.risk,
    dedupeKey: `digest:${params.item.dedupeKey}`,
    sourceRefs: dedupeRefs(params.item.sourceRefs),
    evidenceRefs: dedupeRefs(params.item.evidenceRefs),
    createdAt: params.item.createdAt || params.now,
    privateContent: hasPersonalMetadataRef(refs),
  };
}

function missionRefs(mission: AoiMissionState | null | undefined): Set<string> {
  return new Set(
    mission
      ? [
          mission.sourceRefs.goalRef,
          mission.sourceRefs.proposalRef,
          mission.sourceRefs.kiraWorkRef,
          mission.sourceRefs.researchRunRef,
          mission.sourceRefs.validationRef,
          mission.lastMeaningfulEventRef,
          ...mission.evidenceRefs,
        ].filter((ref): ref is string => Boolean(ref))
      : [],
  );
}

function refsOverlap(left: string[], right: Set<string>): boolean {
  return left.some((ref) => right.has(ref));
}

function hasActiveMission(mission: AoiMissionState | null | undefined): boolean {
  return Boolean(
    mission &&
    mission.status !== 'none' &&
    mission.status !== 'completed' &&
    mission.status !== 'paused',
  );
}

function isEventMissionRelevant(
  event: AoiOperatorVoiceEvent,
  mission: AoiMissionState | null | undefined,
): boolean {
  if (event.interruptionLevel === 'blocking') {
    return true;
  }
  if (event.category === 'approval_required' || event.category === 'critical_blocker') {
    return true;
  }
  if (!hasActiveMission(mission)) {
    return false;
  }
  if (event.category === 'session_resume') {
    return true;
  }
  if (event.category === 'fyi') {
    return false;
  }
  const refs = missionRefs(mission);
  return (
    refs.size === 0 ||
    refsOverlap([...event.sourceRefs, ...event.evidenceRefs], refs) ||
    event.category === 'health_degraded'
  );
}

function activeQuietWindow(
  policy: AoiOperatorVoicePolicy,
  event: AoiOperatorVoiceEvent,
  now: number,
): AoiVoiceQuietWindow | null {
  for (const window of policy.quietWindows) {
    if (!window.enabled) {
      continue;
    }
    if (typeof window.startedAt === 'number' && now < window.startedAt) {
      continue;
    }
    if (typeof window.endsAt === 'number' && now > window.endsAt) {
      continue;
    }
    if (window.categories && !window.categories.includes(event.category)) {
      continue;
    }
    return window;
  }
  return null;
}

function feedbackSuppressesEvent(
  event: AoiOperatorVoiceEvent,
  recentDecisions: AoiProposalDecision[] | undefined,
): boolean {
  const refs = new Set([
    event.dedupeKey,
    event.id,
    ...event.sourceRefs,
    ...event.evidenceRefs,
    ...event.sourceRefs.map((ref) => `digest:${ref}`),
    ...event.evidenceRefs.map((ref) => `digest:${ref}`),
  ]);
  return (recentDecisions ?? []).some((decision) => {
    const feedbackKey = decision.feedbackCategory ?? decision.action;
    if (!NEGATIVE_VOICE_FEEDBACK.has(feedbackKey)) {
      return false;
    }
    return (
      refs.has(decision.cooldownKey) ||
      refs.has(`proposal:${decision.proposalId}`) ||
      (decision.evidenceRefs ?? []).some((ref) => refs.has(ref))
    );
  });
}

function sourceKindFromRefs(refs: string[]): string | undefined {
  if (refs.some((ref) => ref.startsWith('research:'))) {
    return 'research_runs';
  }
  if (refs.some((ref) => ref.startsWith('workspace:'))) {
    return refs.some((ref) => ref.includes('validation') || ref.includes('build'))
      ? 'workspace_build'
      : 'workspace_git';
  }
  if (refs.some((ref) => ref.startsWith('memory:') || ref.startsWith('kira:'))) {
    return 'kira_board';
  }
  if (refs.some((ref) => ref.startsWith('browser:') || ref.includes('browser-context'))) {
    return 'browser_context';
  }
  if (refs.some((ref) => ref.includes('calendar'))) {
    return 'calendar_metadata';
  }
  if (refs.some((ref) => ref.includes('gmail'))) {
    return 'gmail_metadata';
  }
  if (refs.some((ref) => ref.includes('notes'))) {
    return 'notes_metadata';
  }
  return undefined;
}

function decision(params: {
  sessionPath: string;
  event?: AoiOperatorVoiceEvent | null;
  status: AoiVoiceRenderDecisionStatus;
  shouldSpeak: boolean;
  silentReason: string;
  reasons: string[];
  now: number;
  spokenSummary?: string;
}): AoiVoiceRenderDecision {
  const evidenceRefs = dedupeRefs(params.event?.evidenceRefs ?? []);
  const summaryId = params.spokenSummary
    ? `aoi-voice-summary-${hashPart(params.spokenSummary)}`
    : undefined;
  return {
    version: 1,
    id: voiceId(
      'aoi-voice-decision',
      [
        params.sessionPath,
        params.event?.dedupeKey ?? 'no-event',
        params.status,
        params.silentReason,
      ],
      params.now,
    ),
    sessionPath: params.sessionPath,
    createdAt: params.now,
    status: params.status,
    shouldSpeak: params.shouldSpeak,
    silentReason: sanitizeVoiceText(params.silentReason, VOICE_REASON_MAX_CHARS),
    reasons: params.reasons.map((reason) => sanitizeVoiceText(reason, VOICE_REASON_MAX_CHARS)),
    replayable: Boolean(params.spokenSummary),
    evidenceRefs,
    ...(params.event
      ? {
          eventId: params.event.id,
          eventDedupeKey: params.event.dedupeKey,
          category: params.event.category,
        }
      : {}),
    ...(params.spokenSummary ? { spokenSummary: params.spokenSummary } : {}),
    ...(summaryId
      ? {
          summaryId,
          transcriptHash: hashAoiOperatorVoiceTranscript(params.spokenSummary),
        }
      : {}),
  };
}

export function buildAoiOperatorVoiceEventFromDigest(
  input: AoiOperatorVoiceEventBuildInput,
): AoiOperatorVoiceEvent | null {
  const { digest } = input;
  const now = input.now ?? digest.generatedAt;
  const visibleItems = digest.items.filter(isDigestItemVisible);
  const resumeBrief = digest.resumeBrief;
  if (resumeBrief?.visible) {
    return {
      version: 1,
      id: voiceId('aoi-voice-event', [resumeBrief.id, 'session_resume'], now),
      sessionPath: digest.sessionPath,
      category: 'session_resume',
      interruptionLevel: 'mission',
      title: resumeBrief.title,
      whatChanged: resumeBrief.whatChanged,
      nextSafeAction: resumeBrief.nextSafeAction,
      approvalBoundary: resumeBrief.safetyBoundary,
      risk: 'low',
      dedupeKey: `resume:${resumeBrief.id}`,
      sourceRefs: [`resume-brief:${resumeBrief.id}`],
      evidenceRefs: dedupeRefs(resumeBrief.evidenceRefs),
      createdAt: resumeBrief.createdAt,
      privateContent: hasPersonalMetadataRef(resumeBrief.evidenceRefs),
    };
  }

  const critical = visibleItems.find((item) => item.lane === 'critical_user_blocking');
  if (critical) {
    return eventFromDigestItem({
      digest,
      item: critical,
      category: 'critical_blocker',
      interruptionLevel: 'blocking',
      now,
    });
  }

  const approval = visibleItems.find((item) => item.lane === 'needs_approval');
  if (approval) {
    const topApproval = digest.approvalInbox[0];
    return eventFromDigestItem({
      digest,
      item: approval,
      category: 'approval_required',
      interruptionLevel: approval.risk === 'high' ? 'blocking' : 'mission',
      now,
      approvalBoundary: topApproval
        ? 'This is an approval summary only; Nothing runs without explicit approval.'
        : 'Review records consent only; Nothing runs without explicit approval.',
    });
  }

  const completion = visibleItems.find(
    (item) => item.kind === 'kira_outcome' || item.kind === 'research_outcome',
  );
  if (completion) {
    return eventFromDigestItem({
      digest,
      item: completion,
      category: 'completion_update',
      interruptionLevel: completion.lane === 'fyi' ? 'ambient' : 'mission',
      now,
    });
  }

  const health = visibleItems.find((item) => item.kind === 'stale_validation');
  if (health) {
    return eventFromDigestItem({
      digest,
      item: health,
      category: 'health_degraded',
      interruptionLevel: health.risk === 'low' ? 'mission' : 'blocking',
      now,
    });
  }

  const fyi = visibleItems.find((item) => item.lane === 'fyi');
  if (fyi) {
    return eventFromDigestItem({
      digest,
      item: fyi,
      category: 'fyi',
      interruptionLevel: 'ambient',
      now,
    });
  }

  return null;
}

export function hashAoiOperatorVoiceTranscript(value: string | undefined): string {
  return hashPart(sanitizeVoiceText(value ?? '', VOICE_SUMMARY_MAX_CHARS));
}

export function buildAoiOperatorVoiceSummary(
  event: AoiOperatorVoiceEvent,
  policy: AoiOperatorVoicePolicy = getDefaultAoiOperatorVoicePolicy(),
): string {
  const personalRefs = hasPersonalMetadataRef([...event.sourceRefs, ...event.evidenceRefs]);
  const redactedPersonal =
    (event.privateContent || personalRefs) && policy.personalMetadataVoiceScope !== 'metadata';
  const title = redactedPersonal ? 'Personal metadata update' : sentenceFragment(event.title, 90);
  const whatChanged = redactedPersonal
    ? 'A consented personal metadata signal changed for the current mission.'
    : sentenceFragment(event.whatChanged, 150);
  const nextSafeAction =
    event.category === 'approval_required'
      ? 'Review the approval inbox.'
      : sentenceFragment(event.nextSafeAction, 120);
  const boundary =
    event.category === 'approval_required' || event.approvalBoundary
      ? sentenceFragment(event.approvalBoundary ?? 'Nothing runs without explicit approval.', 140)
      : '';
  const boundaryText = !boundary
    ? 'Nothing runs without explicit approval.'
    : boundary.toLowerCase().includes('without explicit approval')
      ? boundary
      : `${boundary}; Nothing runs without explicit approval.`;
  const first = stripTrailingSentencePunctuation([title, whatChanged].filter(Boolean).join(': '));
  const second = stripTrailingSentencePunctuation(
    [nextSafeAction ? `Safe next action: ${nextSafeAction}` : '', boundaryText]
      .filter(Boolean)
      .join(' '),
  );
  return [first, second]
    .filter(Boolean)
    .map((sentence) => `${sentence}.`)
    .join(' ')
    .slice(0, VOICE_SUMMARY_MAX_CHARS)
    .trim();
}

export function decideAoiOperatorVoiceRender(
  input: AoiOperatorVoiceDecisionInput,
): AoiVoiceRenderDecision {
  const now = input.now ?? Date.now();
  const policy = normalizeAoiOperatorVoicePolicy(input.policy);
  const event = input.event ?? null;
  if (!event) {
    return decision({
      sessionPath: input.sessionPath,
      status: 'no_event',
      shouldSpeak: false,
      silentReason: 'No operator voice event is available.',
      reasons: ['no_event'],
      now,
    });
  }
  if (!input.ttsEnabled) {
    return decision({
      sessionPath: input.sessionPath,
      event,
      status: 'tts_disabled',
      shouldSpeak: false,
      silentReason: 'TTS is disabled.',
      reasons: ['tts_disabled'],
      now,
    });
  }
  if (!policy.enabled) {
    return decision({
      sessionPath: input.sessionPath,
      event,
      status: 'suppressed',
      shouldSpeak: false,
      silentReason: 'Operator voice policy is disabled.',
      reasons: ['operator_voice_disabled'],
      now,
    });
  }
  if (input.mutedForSession) {
    return decision({
      sessionPath: input.sessionPath,
      event,
      status: 'muted',
      shouldSpeak: false,
      silentReason: 'Operator voice is muted for this session.',
      reasons: ['muted_for_session'],
      now,
    });
  }
  if (!policy.allowedCategories[event.category]) {
    return decision({
      sessionPath: input.sessionPath,
      event,
      status: 'disabled_category',
      shouldSpeak: false,
      silentReason: `${AOI_OPERATOR_VOICE_CATEGORY_LABELS[event.category]} is disabled.`,
      reasons: ['disabled_category', event.category],
      now,
    });
  }
  const quietWindow = activeQuietWindow(policy, event, now);
  if (quietWindow) {
    return decision({
      sessionPath: input.sessionPath,
      event,
      status: 'quiet_window',
      shouldSpeak: false,
      silentReason: quietWindow.reason,
      reasons: ['quiet_window'],
      now,
    });
  }
  if (VOICE_LEVEL_RANK[event.interruptionLevel] < VOICE_LEVEL_RANK[policy.minInterruptionLevel]) {
    return decision({
      sessionPath: input.sessionPath,
      event,
      status: 'suppressed',
      shouldSpeak: false,
      silentReason: 'Event interruption level is below the operator voice threshold.',
      reasons: ['below_interruption_threshold', event.interruptionLevel],
      now,
    });
  }
  const calibration = applyAoiTrustCalibration({
    profile: input.trustCalibrationProfile,
    triggerKind: event.category,
    sourceKind: sourceKindFromRefs([...event.sourceRefs, ...event.evidenceRefs]),
    risk: event.risk,
    voiceCategory: event.category,
    score: VOICE_LEVEL_RANK[event.interruptionLevel] / 3,
  });
  if (calibration.suppress && event.interruptionLevel !== 'blocking') {
    return decision({
      sessionPath: input.sessionPath,
      event,
      status: 'suppressed',
      shouldSpeak: false,
      silentReason: 'Trust calibration suppressed a similar operator voice event.',
      reasons: ['trust_calibration_suppressed', ...calibration.reasons],
      now,
    });
  }
  if (
    [...(input.previousSpokenDedupeKeys ?? [])].some(
      (key) => key === event.dedupeKey || key === event.id,
    ) ||
    feedbackSuppressesEvent(event, input.recentDecisions)
  ) {
    return decision({
      sessionPath: input.sessionPath,
      event,
      status: 'duplicate',
      shouldSpeak: false,
      silentReason: 'A similar operator voice event was already dismissed or spoken.',
      reasons: ['duplicate_or_feedback_suppressed'],
      now,
    });
  }
  if (!isEventMissionRelevant(event, input.mission)) {
    return decision({
      sessionPath: input.sessionPath,
      event,
      status: 'not_mission_relevant',
      shouldSpeak: false,
      silentReason: 'Event is not tied to an active mission or user-blocking state.',
      reasons: ['not_mission_relevant'],
      now,
    });
  }

  const spokenSummary = buildAoiOperatorVoiceSummary(event, policy);
  return decision({
    sessionPath: input.sessionPath,
    event,
    status: 'spoken',
    shouldSpeak: true,
    silentReason: '',
    reasons: ['spoken'],
    now,
    spokenSummary,
  });
}

export function buildAoiOperatorVoicePanelSummary(
  decisionResult: AoiVoiceRenderDecision | null | undefined,
): { statusLabel: string; reasonLabel: string; canReplay: boolean } {
  if (!decisionResult) {
    return {
      statusLabel: 'No voice decision yet',
      reasonLabel: 'Aoi has not evaluated an operator voice event in this session.',
      canReplay: false,
    };
  }
  return {
    statusLabel: decisionResult.status.replace(/_/g, ' '),
    reasonLabel:
      decisionResult.status === 'spoken'
        ? 'Last operator voice summary is available for replay.'
        : decisionResult.silentReason || 'Operator voice stayed silent.',
    canReplay: Boolean(decisionResult.spokenSummary),
  };
}
