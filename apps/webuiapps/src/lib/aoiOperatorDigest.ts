import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import { applyAoiTrustCalibration } from './aoiTrustCalibration';
import type { AoiMemoryEntry } from './aoiMemoryShared';
import type {
  AoiApprovalInboxItem,
  AoiAttentionBrokerDecision,
  AoiAttentionEvent,
  AoiAutonomyBlockedProposal,
  AoiAutonomyRisk,
  AoiDigestItem,
  AoiDigestItemKind,
  AoiMissionState,
  AoiNotificationLane,
  AoiOperatorDigest,
  AoiOperatorHealthState,
  AoiProposal,
  AoiProposalAcceptActionKind,
  AoiProposalDecision,
  AoiQuietWindow,
  AoiResumeBrief,
  AoiTrustCalibrationProfile,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';

const DIGEST_SUMMARY_MAX_CHARS = 260;
const DIGEST_ITEM_MAX_CHARS = 180;
const RESUME_IDLE_THRESHOLD_MS = 15 * 60 * 1000;
const NEGATIVE_DIGEST_FEEDBACK = new Set([
  'not_useful',
  'wrong_evidence',
  'wrong_source',
  'wrong_timing',
  'too_frequent',
  'too_much',
  'unsafe',
]);

export interface AoiOperatorDigestInput {
  sessionPath: string;
  now?: number;
  mission?: AoiMissionState | null;
  activeProposals?: AoiProposal[];
  blockedProposals?: AoiAutonomyBlockedProposal[];
  attentionEvents?: AoiAttentionEvent[];
  attentionDecisions?: AoiAttentionBrokerDecision[];
  recentDecisions?: AoiProposalDecision[];
  workspaceSnapshot?: AoiWorkspaceSnapshot | null;
  memories?: AoiMemoryEntry[];
  quietMode?: boolean;
  lastSeenAt?: number | null;
  userIdleMs?: number;
  maxItems?: number;
  trustCalibrationProfile?: AoiTrustCalibrationProfile | null;
  operatorHealth?: AoiOperatorHealthState | null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value)),
  );
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

function digestId(kind: AoiDigestItemKind, dedupeKey: string): string {
  return `aoi-digest-${kind}-${hashPart(dedupeKey)}`.slice(0, 127);
}

function dedupeRefs(refs: Array<string | undefined>, maxItems = 12): string[] {
  const seen = new Set<string>();
  for (const ref of refs) {
    const normalized = truncateText(ref ?? '', 220);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function riskRank(risk: AoiAutonomyRisk): number {
  if (risk === 'high') {
    return 3;
  }
  if (risk === 'medium') {
    return 2;
  }
  return 1;
}

function clampRelevance(value: number): number {
  return Math.min(1, Math.max(0, Number(value.toFixed(3))));
}

function hasTag(memory: AoiMemoryEntry, tag: string): boolean {
  return memory.tags.includes(tag);
}

function actionKindLabel(kind: AoiProposalAcceptActionKind | undefined): string {
  if (!kind) {
    return 'Review proposal details';
  }
  return kind.replace(/_/g, ' ');
}

function proposalBoundary(proposal: AoiProposal): string {
  if (proposal.acceptAction?.kind === 'create_kira_work') {
    return 'Approval records consent first; Kira work creation still goes through the existing preview/execution path.';
  }
  if (proposal.acceptAction?.kind === 'start_research') {
    return 'Approval records consent first; research starts only through the existing proposal execution path.';
  }
  if (proposal.acceptAction?.kind === 'run_command') {
    return 'Approval records consent first; commands still require the approved-command policy and execution path.';
  }
  if (proposal.acceptAction?.kind === 'save_memory') {
    return 'Approval records consent first; memory promotion still goes through the existing proposal path.';
  }
  return 'Approval from this inbox records the decision only; it does not run tools or edit files.';
}

function proposalRefs(proposal: AoiProposal): string[] {
  return dedupeRefs([
    `proposal:${proposal.id}`,
    ...proposal.evidenceRefs,
    ...proposal.artifactRefs,
    ...proposal.memoryIds.map((id) => `memory:${id}`),
  ]);
}

function buildApprovalInbox(activeProposals: AoiProposal[]): AoiApprovalInboxItem[] {
  return activeProposals
    .filter(
      (proposal) =>
        proposal.status === 'active' &&
        (proposal.requiresUserApproval ||
          Boolean(proposal.acceptAction) ||
          proposal.risk !== 'low'),
    )
    .map((proposal) => ({
      version: 1 as const,
      proposalId: proposal.id,
      title: truncateText(proposal.title, 120),
      exactNextAction: truncateText(
        `${actionKindLabel(proposal.acceptAction?.kind)}: ${proposal.reason || proposal.body}`,
        180,
      ),
      boundary: truncateText(proposalBoundary(proposal), 220),
      risk: proposal.risk,
      status: proposal.status,
      ...(proposal.acceptAction?.kind ? { actionKind: proposal.acceptAction.kind } : {}),
      requiredAutonomyLevel: proposal.requiredAutonomyLevel,
      evidenceCount: proposal.evidenceRefs.length,
      evidenceRefs: proposal.evidenceRefs.slice(0, 8),
      dedupeKey: `approval-inbox:${proposal.cooldownKey || proposal.id}`,
      createdAt: proposal.updatedAt || proposal.createdAt,
      availableActions: ['approve', 'dismiss', 'snooze', 'details'] as Array<
        'approve' | 'dismiss' | 'snooze' | 'details'
      >,
    }))
    .sort(
      (left, right) =>
        riskRank(right.risk) - riskRank(left.risk) ||
        right.evidenceCount - left.evidenceCount ||
        right.createdAt - left.createdAt,
    )
    .slice(0, 5);
}

function makeDigestItem(params: {
  kind: AoiDigestItemKind;
  lane: AoiNotificationLane;
  title: string;
  summary: string;
  nextSafeAction: string;
  risk: AoiAutonomyRisk;
  relevance: number;
  createdAt: number;
  dedupeKey: string;
  sourceRefs: string[];
  evidenceRefs: string[];
}): AoiDigestItem {
  return {
    version: 1,
    id: digestId(params.kind, params.dedupeKey),
    kind: params.kind,
    lane: params.lane,
    title: truncateText(params.title, 110),
    summary: truncateText(params.summary, DIGEST_ITEM_MAX_CHARS),
    nextSafeAction: truncateText(params.nextSafeAction, 140),
    risk: params.risk,
    relevance: clampRelevance(params.relevance),
    createdAt: params.createdAt,
    dedupeKey: params.dedupeKey,
    sourceRefs: dedupeRefs(params.sourceRefs),
    evidenceRefs: dedupeRefs(params.evidenceRefs),
    hidden: false,
  };
}

function attentionKindToDigestKind(event: AoiAttentionEvent): AoiDigestItemKind {
  if (event.kind === 'research_completed' || event.kind === 'research_failed_or_insufficient') {
    return 'research_outcome';
  }
  if (event.kind.startsWith('kira')) {
    return 'kira_outcome';
  }
  if (event.kind === 'workspace_validation_stale') {
    return 'stale_validation';
  }
  if (event.kind === 'active_goal_waiting_too_long' || event.kind === 'user_returned_after_idle') {
    return 'mission_status';
  }
  return 'source_change';
}

function attentionLane(
  event: AoiAttentionEvent,
  decision: AoiAttentionBrokerDecision | undefined,
): AoiNotificationLane {
  if (event.kind === 'kira_needs_clarification' || decision?.kind === 'ask_direct_clarification') {
    return 'critical_user_blocking';
  }
  if (decision?.kind === 'create_proposal') {
    return 'needs_approval';
  }
  if (
    event.kind === 'active_goal_waiting_too_long' ||
    event.kind === 'workspace_validation_stale' ||
    event.kind.startsWith('kira')
  ) {
    return 'mission_update';
  }
  return event.suggestedAttentionLevel === 'silent' ? 'fyi' : 'mission_update';
}

function collectAttentionItems(params: AoiOperatorDigestInput): AoiDigestItem[] {
  const decisionsByEventId = new Map(
    (params.attentionDecisions ?? []).map((decision) => [decision.eventId, decision]),
  );
  return (params.attentionEvents ?? []).map((event) => {
    const decision = decisionsByEventId.get(event.id);
    const lane = attentionLane(event, decision);
    const relevance =
      event.suggestedAttentionLevel === 'direct'
        ? 0.88
        : event.suggestedAttentionLevel === 'inline'
          ? 0.72
          : event.suggestedAttentionLevel === 'badge'
            ? 0.56
            : 0.32;
    return makeDigestItem({
      kind: attentionKindToDigestKind(event),
      lane,
      title: event.summary,
      summary: event.summary,
      nextSafeAction:
        lane === 'critical_user_blocking'
          ? 'Answer the blocker or open the related evidence.'
          : lane === 'needs_approval'
            ? 'Review the prepared action before approving.'
            : 'Review when convenient.',
      risk: event.risk,
      relevance: decision ? Math.max(relevance, decision.score) : relevance,
      createdAt: event.createdAt,
      dedupeKey: `attention:${event.kind}:${event.sourceRef}`,
      sourceRefs: [event.sourceRef],
      evidenceRefs: event.evidenceRefs,
    });
  });
}

function collectMissionItem(mission: AoiMissionState | null | undefined): AoiDigestItem | null {
  if (!mission || mission.status === 'none' || mission.status === 'completed') {
    return null;
  }
  const lane =
    mission.status === 'blocked' || mission.status === 'waiting_on_user'
      ? 'critical_user_blocking'
      : 'mission_update';
  return makeDigestItem({
    kind: 'mission_status',
    lane,
    title: `Mission ${mission.status.replace(/_/g, ' ')}`,
    summary: `${mission.focusSummary}. Waiting on ${mission.waitingOn}.`,
    nextSafeAction: mission.nextRecommendedAction.label,
    risk: mission.status === 'blocked' ? 'medium' : 'low',
    relevance: lane === 'critical_user_blocking' ? 0.86 : 0.62,
    createdAt: mission.updatedAt,
    dedupeKey: `mission:${mission.activeGoalId || mission.sessionPath}:status`,
    sourceRefs: [
      mission.sourceRefs.goalRef,
      mission.sourceRefs.proposalRef,
      mission.sourceRefs.researchRunRef,
      mission.sourceRefs.kiraWorkRef,
      mission.sourceRefs.validationRef,
      mission.lastMeaningfulEventRef,
    ].filter((ref): ref is string => Boolean(ref)),
    evidenceRefs: mission.evidenceRefs,
  });
}

function collectWorkspaceItems(snapshot: AoiWorkspaceSnapshot | null | undefined): AoiDigestItem[] {
  if (!snapshot) {
    return [];
  }
  const items: AoiDigestItem[] = [];
  const sourceRef = snapshot.evidenceRefs[0] ?? `workspace:${snapshot.sessionPath}`;
  if (snapshot.git?.branchChanged || snapshot.git?.isDirty) {
    const branchChange = snapshot.git.branchChanged
      ? `Branch changed to ${snapshot.git.branchName}.`
      : '';
    const dirty = snapshot.git.isDirty
      ? `${snapshot.git.changedFileCount} workspace file(s) changed.`
      : '';
    items.push(
      makeDigestItem({
        kind: 'source_change',
        lane: 'fyi',
        title: 'Workspace source changed',
        summary: `${branchChange} ${dirty}`.trim(),
        nextSafeAction: 'Review workspace signals before trusting old validation.',
        risk: 'low',
        relevance: snapshot.git.branchChanged ? 0.52 : 0.38,
        createdAt: snapshot.collectedAt,
        dedupeKey: `workspace-source:${snapshot.sessionPath}:${snapshot.git.branchName}:${snapshot.git.statusSummary}`,
        sourceRefs: [sourceRef],
        evidenceRefs: snapshot.evidenceRefs,
      }),
    );
  }
  if (snapshot.validation.freshness === 'stale' || snapshot.validation.freshness === 'failed') {
    items.push(
      makeDigestItem({
        kind: 'stale_validation',
        lane: snapshot.validation.freshness === 'failed' ? 'mission_update' : 'fyi',
        title:
          snapshot.validation.freshness === 'failed' ? 'Validation failed' : 'Validation is stale',
        summary:
          snapshot.validation.staleReason ||
          `${snapshot.validation.command || 'Last validation'} is ${snapshot.validation.freshness}.`,
        nextSafeAction:
          snapshot.validation.freshness === 'failed'
            ? 'Prepare a focused validation follow-up.'
            : 'Prepare the next safe validation check.',
        risk: snapshot.validation.freshness === 'failed' ? 'medium' : 'low',
        relevance: snapshot.validation.freshness === 'failed' ? 0.7 : 0.5,
        createdAt: snapshot.collectedAt,
        dedupeKey: `workspace-validation:${snapshot.sessionPath}:${snapshot.validation.freshness}:${snapshot.validation.command || 'unknown'}`,
        sourceRefs: [sourceRef, `workspace:validation:${snapshot.validation.freshness}`],
        evidenceRefs: [...snapshot.evidenceRefs, ...snapshot.validation.evidenceRefs],
      }),
    );
  }
  return items;
}

function collectHealthItem(
  health: AoiOperatorHealthState | null | undefined,
): AoiDigestItem | null {
  if (!health || health.userBlockingIssueCount <= 0) {
    return null;
  }
  const blocker = health.issues.find((issue) => issue.severity === 'blocker');
  if (!blocker) {
    return null;
  }
  return makeDigestItem({
    kind: 'operator_health',
    lane: 'critical_user_blocking',
    title: blocker.title,
    summary: blocker.cannotKnow ?? blocker.summary,
    nextSafeAction: blocker.recommendation.label,
    risk: 'medium',
    relevance: 0.9,
    createdAt: blocker.observedAt,
    dedupeKey: `health:${blocker.code}:${blocker.sourceId ?? blocker.capability}`,
    sourceRefs: [blocker.sourceId ? `environment-source:${blocker.sourceId}` : blocker.capability],
    evidenceRefs: blocker.evidenceRefs,
  });
}

function collectMemoryOutcomeItems(memories: AoiMemoryEntry[] | undefined): AoiDigestItem[] {
  const items: AoiDigestItem[] = [];
  for (const memory of memories ?? []) {
    if (memory.status !== 'active') {
      continue;
    }
    const sourceRef = `memory:${memory.id}`;
    if (hasTag(memory, 'kira') && (hasTag(memory, 'completed') || hasTag(memory, 'reviewed'))) {
      items.push(
        makeDigestItem({
          kind: 'kira_outcome',
          lane: hasTag(memory, 'needs-attention') ? 'critical_user_blocking' : 'mission_update',
          title: 'Kira outcome',
          summary: memory.content,
          nextSafeAction: hasTag(memory, 'needs-attention')
            ? 'Open Kira details and answer the blocker.'
            : 'Review Kira work before continuing.',
          risk: hasTag(memory, 'needs-attention') ? 'medium' : 'low',
          relevance: hasTag(memory, 'needs-attention') ? 0.82 : 0.58,
          createdAt: memory.updatedAt,
          dedupeKey: `kira-memory:${memory.id}`,
          sourceRefs: [sourceRef],
          evidenceRefs: [sourceRef, ...memory.sourceEpisodeIds.map((id) => `episode:${id}`)],
        }),
      );
    }
    if (
      (hasTag(memory, 'research') || hasTag(memory, 'aoi-research')) &&
      hasTag(memory, 'completed')
    ) {
      items.push(
        makeDigestItem({
          kind: 'research_outcome',
          lane: 'fyi',
          title: 'Research outcome',
          summary: memory.content,
          nextSafeAction: 'Open the research report when it matches the current mission.',
          risk: 'low',
          relevance: 0.46,
          createdAt: memory.updatedAt,
          dedupeKey: `research-memory:${memory.id}`,
          sourceRefs: [sourceRef],
          evidenceRefs: [sourceRef, ...memory.sourceEpisodeIds.map((id) => `episode:${id}`)],
        }),
      );
    }
  }
  return items;
}

function collectBlockedItems(
  blockedProposals: AoiAutonomyBlockedProposal[] | undefined,
): AoiDigestItem[] {
  return (blockedProposals ?? []).map((proposal) =>
    makeDigestItem({
      kind: 'blocked_item',
      lane: 'critical_user_blocking',
      title: proposal.title,
      summary: proposal.reasons.join(' / ') || 'A proposal is blocked by policy.',
      nextSafeAction: proposal.safeAlternative || 'Resolve the policy or evidence gate first.',
      risk: proposal.risk ?? 'medium',
      relevance: 0.84,
      createdAt: 0,
      dedupeKey: `blocked:${proposal.proposalId}`,
      sourceRefs: [`proposal:${proposal.proposalId}`],
      evidenceRefs: proposal.evidenceRefs,
    }),
  );
}

function approvalAggregateItem(
  approvalInbox: AoiApprovalInboxItem[],
  now: number,
): AoiDigestItem | null {
  if (approvalInbox.length === 0) {
    return null;
  }
  const top = approvalInbox[0];
  return makeDigestItem({
    kind: 'pending_approval',
    lane: 'needs_approval',
    title: `${approvalInbox.length} prepared action${approvalInbox.length === 1 ? '' : 's'} awaiting approval`,
    summary: top.exactNextAction,
    nextSafeAction: 'Review the approval inbox; approving records consent before execution.',
    risk: top.risk,
    relevance: 0.82,
    createdAt: now,
    dedupeKey: 'approval-inbox:aggregate',
    sourceRefs: approvalInbox.map((item) => `proposal:${item.proposalId}`),
    evidenceRefs: approvalInbox.flatMap((item) => item.evidenceRefs).slice(0, 12),
  });
}

function activeProposalRefSet(proposals: AoiProposal[]): Set<string> {
  const refs = new Set<string>();
  for (const proposal of proposals) {
    for (const ref of proposalRefs(proposal)) {
      refs.add(ref);
    }
  }
  return refs;
}

function shouldSkipAsProposalDuplicate(item: AoiDigestItem, proposalRefsSet: Set<string>): boolean {
  if (
    item.kind === 'mission_status' ||
    item.kind === 'pending_approval' ||
    item.kind === 'blocked_item'
  ) {
    return false;
  }
  return [...item.sourceRefs, ...item.evidenceRefs].some((ref) => proposalRefsSet.has(ref));
}

function missionRefSet(mission: AoiMissionState | null | undefined): Set<string> {
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

function relatedDedupeKey(
  item: AoiDigestItem,
  missionRefs: Set<string>,
  mission: AoiMissionState | null | undefined,
): string {
  if (!mission || !mission.activeGoalId || item.kind === 'pending_approval') {
    return item.dedupeKey;
  }
  if ([...item.sourceRefs, ...item.evidenceRefs].some((ref) => missionRefs.has(ref))) {
    return `mission:${mission.activeGoalId}:ambient-progress`;
  }
  return item.dedupeKey;
}

function mergeDigestItems(left: AoiDigestItem, right: AoiDigestItem): AoiDigestItem {
  const winner =
    riskRank(right.risk) > riskRank(left.risk) ||
    (right.relevance > left.relevance && riskRank(right.risk) >= riskRank(left.risk))
      ? right
      : left;
  const other = winner === left ? right : left;
  return {
    ...winner,
    summary: truncateText(`${winner.summary} ${other.summary}`, DIGEST_ITEM_MAX_CHARS),
    nextSafeAction:
      winner.nextSafeAction.length >= other.nextSafeAction.length
        ? winner.nextSafeAction
        : other.nextSafeAction,
    relevance: Math.max(left.relevance, right.relevance),
    sourceRefs: dedupeRefs([...left.sourceRefs, ...right.sourceRefs]),
    evidenceRefs: dedupeRefs([...left.evidenceRefs, ...right.evidenceRefs]),
    createdAt: Math.max(left.createdAt, right.createdAt),
  };
}

function hasNegativeFeedback(
  item: AoiDigestItem,
  decisions: AoiProposalDecision[] | undefined,
): boolean {
  return (decisions ?? []).some((decision) => {
    if (!decision.feedbackCategory || !NEGATIVE_DIGEST_FEEDBACK.has(decision.feedbackCategory)) {
      return false;
    }
    const refs = new Set([
      item.dedupeKey,
      ...item.sourceRefs,
      ...item.evidenceRefs,
      ...item.sourceRefs.map((ref) => `attention:${item.kind}:${ref}`),
    ]);
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

function applyQuietAndFeedback(
  item: AoiDigestItem,
  params: Pick<AoiOperatorDigestInput, 'quietMode' | 'recentDecisions' | 'trustCalibrationProfile'>,
): AoiDigestItem {
  const negativeFeedback = hasNegativeFeedback(item, params.recentDecisions);
  const calibration = applyAoiTrustCalibration({
    profile: params.trustCalibrationProfile,
    triggerKind: item.kind,
    sourceKind: sourceKindFromRefs([...item.sourceRefs, ...item.evidenceRefs]),
    risk: item.risk,
    notificationLane: item.lane,
    score: item.relevance,
  });
  let relevance =
    item.relevance -
    (negativeFeedback ? 0.34 : 0) +
    calibration.rankingAdjustment +
    calibration.interruptionAdjustment -
    calibration.sourceSelectionPenalty;
  let lane = item.lane;
  let hidden = false;
  if (calibration.suppress && lane !== 'critical_user_blocking' && lane !== 'needs_approval') {
    lane = 'hidden_by_quiet_mode';
    hidden = true;
  }
  if (
    params.quietMode &&
    lane !== 'critical_user_blocking' &&
    lane !== 'needs_approval' &&
    (lane === 'fyi' || relevance < 0.6)
  ) {
    lane = 'hidden_by_quiet_mode';
    hidden = true;
  }
  relevance = clampRelevance(relevance);
  return {
    ...item,
    lane,
    relevance,
    hidden,
  };
}

function buildLaneCounts(items: AoiDigestItem[]): Record<AoiNotificationLane, number> {
  return {
    critical_user_blocking: items.filter((item) => item.lane === 'critical_user_blocking').length,
    needs_approval: items.filter((item) => item.lane === 'needs_approval').length,
    mission_update: items.filter((item) => item.lane === 'mission_update').length,
    fyi: items.filter((item) => item.lane === 'fyi').length,
    hidden_by_quiet_mode: items.filter((item) => item.lane === 'hidden_by_quiet_mode').length,
  };
}

function buildQuietWindow(params: AoiOperatorDigestInput, now: number): AoiQuietWindow | undefined {
  if (!params.quietMode) {
    return undefined;
  }
  return {
    version: 1,
    enabled: true,
    reason: 'Quiet mode hides FYI and low-value ambient updates while keeping blockers visible.',
    startedAt: now,
    hiddenLane: 'hidden_by_quiet_mode',
  };
}

function buildResumeBrief(params: {
  sessionPath: string;
  now: number;
  mission?: AoiMissionState | null;
  items: AoiDigestItem[];
  approvalInbox: AoiApprovalInboxItem[];
  lastSeenAt?: number | null;
  userIdleMs?: number;
}): AoiResumeBrief | undefined {
  const idleMs =
    typeof params.userIdleMs === 'number'
      ? params.userIdleMs
      : params.lastSeenAt
        ? params.now - params.lastSeenAt
        : 0;
  if (idleMs < RESUME_IDLE_THRESHOLD_MS) {
    return undefined;
  }
  const visibleItems = params.items.filter((item) => !item.hidden);
  const resumeCandidateItems = visibleItems.filter(
    (item) => item.lane !== 'fyi' && item.relevance >= 0.6,
  );
  const topItem = resumeCandidateItems[0];
  const topApproval = params.approvalInbox[0];
  const missionRelevant =
    params.mission && params.mission.status !== 'none' && params.mission.status !== 'completed';
  if (!topItem && !topApproval && !missionRelevant) {
    return undefined;
  }
  const evidenceRefs = dedupeRefs([
    ...(topItem?.evidenceRefs ?? []),
    ...(topApproval?.evidenceRefs ?? []),
    ...(params.mission?.evidenceRefs ?? []),
  ]);
  return {
    version: 1,
    id: `aoi-resume-brief-${hashPart(`${params.sessionPath}:${params.lastSeenAt ?? idleMs}`)}`,
    visible: true,
    title: 'Aoi resume brief',
    whatChanged: truncateText(
      topItem?.summary ||
        topApproval?.exactNextAction ||
        `Mission is ${params.mission?.status.replace(/_/g, ' ')}: ${params.mission?.focusSummary}`,
      180,
    ),
    nextSafeAction: truncateText(
      topApproval?.exactNextAction ||
        params.mission?.nextRecommendedAction.label ||
        topItem?.nextSafeAction ||
        'Review the digest before continuing.',
      160,
    ),
    safetyBoundary:
      'This brief will not approve, execute, run tools, start research, create Kira work, or edit files without explicit approval.',
    evidenceRefs,
    createdAt: params.now,
  };
}

function buildSummary(
  visibleItems: AoiDigestItem[],
  approvalInbox: AoiApprovalInboxItem[],
): string {
  const parts: string[] = [];
  if (approvalInbox.length > 0) {
    parts.push(`${approvalInbox.length} approval${approvalInbox.length === 1 ? '' : 's'} waiting`);
  }
  const blockers = visibleItems.filter((item) => item.lane === 'critical_user_blocking').length;
  if (blockers > 0) {
    parts.push(`${blockers} blocker${blockers === 1 ? '' : 's'}`);
  }
  const updates = visibleItems.filter(
    (item) => item.lane === 'mission_update' || item.lane === 'fyi',
  ).length;
  if (updates > 0) {
    parts.push(`${updates} quiet update${updates === 1 ? '' : 's'}`);
  }
  return truncateText(
    parts.length > 0 ? parts.join(', ') : 'No meaningful ambient updates.',
    DIGEST_SUMMARY_MAX_CHARS,
  );
}

export function buildAoiOperatorDigest(params: AoiOperatorDigestInput): AoiOperatorDigest {
  const now = params.now ?? Date.now();
  const activeProposals = params.activeProposals ?? [];
  const approvalInbox = buildApprovalInbox(activeProposals);
  const proposalRefsSet = activeProposalRefSet(activeProposals);
  const mission = params.mission ?? null;
  const missionRefs = missionRefSet(mission);
  const rawItems = [
    collectMissionItem(mission),
    approvalAggregateItem(approvalInbox, now),
    ...collectAttentionItems(params),
    ...collectWorkspaceItems(params.workspaceSnapshot),
    collectHealthItem(params.operatorHealth),
    ...collectMemoryOutcomeItems(params.memories),
    ...collectBlockedItems(params.blockedProposals),
  ].filter((item): item is AoiDigestItem => Boolean(item));

  const deduped = new Map<string, AoiDigestItem>();
  for (const item of rawItems) {
    if (shouldSkipAsProposalDuplicate(item, proposalRefsSet)) {
      continue;
    }
    const key = relatedDedupeKey(item, missionRefs, mission);
    const existing = deduped.get(key);
    deduped.set(key, existing ? mergeDigestItems(existing, item) : item);
  }

  const maxItems = Math.max(1, params.maxItems ?? 5);
  const items = [...deduped.values()]
    .map((item) => applyQuietAndFeedback(item, params))
    .sort(
      (left, right) =>
        Number(left.hidden) - Number(right.hidden) ||
        riskRank(right.risk) - riskRank(left.risk) ||
        right.relevance - left.relevance ||
        right.createdAt - left.createdAt,
    )
    .slice(0, maxItems);
  const visibleItems = items.filter((item) => !item.hidden);
  const evidenceRefs = dedupeRefs([
    ...visibleItems.flatMap((item) => item.evidenceRefs),
    ...approvalInbox.flatMap((item) => item.evidenceRefs),
  ]);
  const quietWindow = buildQuietWindow(params, now);
  const resumeBrief = buildResumeBrief({
    sessionPath: params.sessionPath,
    now,
    mission,
    items,
    approvalInbox,
    lastSeenAt: params.lastSeenAt,
    userIdleMs: params.userIdleMs,
  });

  return {
    version: 1,
    sessionPath: params.sessionPath,
    generatedAt: now,
    summary: buildSummary(visibleItems, approvalInbox),
    ...(quietWindow ? { quietWindow } : {}),
    items,
    approvalInbox,
    ...(resumeBrief ? { resumeBrief } : {}),
    laneCounts: buildLaneCounts(items),
    hiddenItemCount: items.filter((item) => item.hidden).length,
    evidenceRefs,
  };
}
