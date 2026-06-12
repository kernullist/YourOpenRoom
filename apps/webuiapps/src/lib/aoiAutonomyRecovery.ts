import { createAoiAutonomyId } from './aoiAutonomyStore';
import type {
  AoiFailureKind,
  AoiProposal,
  AoiProposalDecision,
  AoiRecoveryActionKind,
  AoiRecoveryPreview,
  AoiRecoveryPreviewAction,
} from './aoiAutonomyTypes';
import type { AoiMemoryEntry } from './aoiMemoryShared';
import type { AoiResearchManifest, AoiResearchRunSummary } from './aoiResearchTypes';

export type AoiFailureSource = 'policy' | 'research' | 'kira' | 'execution' | 'proposal';

export interface AoiFailureClassificationInput {
  source: AoiFailureSource;
  sessionPath: string;
  sourceRef: string;
  summary?: string;
  evidenceRefs?: string[];
  reasons?: string[];
  riskSignals?: string[];
  suggestedTools?: string[];
  acceptActionKind?: string;
  researchRun?: AoiResearchRunSummary | AoiResearchManifest;
  memory?: AoiMemoryEntry;
  proposal?: AoiProposal;
}

export interface AoiClassifiedFailure {
  kind: AoiFailureKind;
  source: AoiFailureSource;
  sessionPath: string;
  sourceRef: string;
  summary: string;
  evidenceRefs: string[];
  reasons: string[];
  riskSignals: string[];
  suggestedTools: string[];
  acceptActionKind?: string;
  originalErrorText?: string;
  failureSignature: string;
  hasMutationAction: boolean;
  researchRun?: AoiResearchRunSummary | AoiResearchManifest;
  memory?: AoiMemoryEntry;
  proposal?: AoiProposal;
}

export type AoiRecoverySuppressionReason =
  | 'mutation_action_not_retriable'
  | 'user_feedback_suppressed'
  | 'duplicate_active_recovery'
  | 'retry_limit_reached'
  | 'cooldown_active';

export interface AoiRecoverySuppression {
  failure: AoiClassifiedFailure;
  reason: AoiRecoverySuppressionReason;
  retryCount: number;
  cooldownUntil?: number;
  preview: AoiRecoveryPreview;
}

export interface AoiRecoveryProposalBuildResult {
  classifiedFailures: AoiClassifiedFailure[];
  proposals: AoiProposal[];
  suppressed: AoiRecoverySuppression[];
}

export interface AoiRecoveryProposalContext {
  activeProposals: AoiProposal[];
  recentDecisions: AoiProposalDecision[];
  now: number;
  cooldownMs?: number;
  maxRetryProposalsPerSource?: number;
}

const BODY_MAX_CHARS = 320;
const TITLE_MAX_CHARS = 96;
const REASON_MAX_CHARS = 240;
const DEFAULT_RECOVERY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_RETRY_PROPOSALS_PER_SOURCE = 1;
const MUTATION_TOOL_NAMES = new Set(['file_write', 'file_patch', 'file_delete', 'run_command']);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function normalizeStringList(value: unknown, maxItems = 24): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = normalizeWhitespace(item).slice(0, 240);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function hashPart(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function safeEvidenceRefs(input: AoiFailureClassificationInput): string[] {
  const refs = normalizeStringList(input.evidenceRefs, 16);
  if (input.sourceRef) {
    refs.unshift(input.sourceRef);
  }
  if (input.proposal?.id) {
    refs.push(`proposal:${input.proposal.id}`);
  }
  return [...new Set(refs)].slice(0, 16);
}

function failureText(input: AoiFailureClassificationInput): string {
  const researchError = input.researchRun?.error
    ? [input.researchRun.error.code, input.researchRun.error.message, input.researchRun.error.phase]
        .filter(Boolean)
        .join(' ')
    : '';
  return [
    input.source,
    input.summary,
    ...(input.reasons ?? []),
    ...(input.riskSignals ?? []),
    researchError,
    input.memory?.content,
    input.proposal?.blockedReason,
  ]
    .filter(Boolean)
    .join(' | ');
}

function hasMutationAction(input: AoiFailureClassificationInput): boolean {
  const tools = [
    ...(input.suggestedTools ?? []),
    input.acceptActionKind,
    ...(input.proposal?.suggestedTools ?? []),
    input.proposal?.acceptAction?.kind,
  ].filter((tool): tool is string => Boolean(tool));
  if (tools.some((tool) => MUTATION_TOOL_NAMES.has(tool))) {
    return true;
  }
  return (input.reasons ?? []).some((reason) =>
    [...MUTATION_TOOL_NAMES].some((tool) => reason.includes(`tool_blocked:${tool}`)),
  );
}

function classifyKind(input: AoiFailureClassificationInput): AoiFailureKind {
  const text = failureText(input);
  const lower = text.toLowerCase();
  const acceptedSources = input.researchRun?.sourceCounts.accepted ?? undefined;

  if (/missing_evidence|missing evidence|evidence refs|evidence_refs/.test(lower)) {
    return 'missing_evidence';
  }
  if (/scope_too_broad|too broad|broad scope|kira_handoff_scope_too_broad/.test(lower)) {
    return 'scope_too_broad';
  }
  if (/missing_fresh_acceptance|stale confirmation|fresh acceptance/.test(lower)) {
    return 'stale_confirmation';
  }
  if (input.source === 'research') {
    if (
      acceptedSources === 0 ||
      /insufficient|no accepted|not enough sources|source budget|source_count/i.test(text)
    ) {
      return 'research_insufficient_sources';
    }
    return 'research_failed';
  }
  if (input.source === 'kira') {
    if (/validation-failed|validation failed|integration-failed|검증\s*실패/i.test(text)) {
      return 'kira_validation_failed';
    }
    if (/review-blocked|review blocked|review-feedback|review failed/i.test(text)) {
      return 'kira_review_blocked';
    }
    if (/needs-attention|needs clarification|clarification|needs_context|interrupted/i.test(text)) {
      return 'kira_needs_clarification';
    }
  }
  if (
    input.source === 'policy' ||
    /tool_blocked|autonomy_level_too_low|requires_approval|high_risk_requires_approval|autonomy_disabled/.test(
      lower,
    )
  ) {
    return 'policy_blocked';
  }
  return 'execution_exception';
}

export function classifyAoiFailure(input: AoiFailureClassificationInput): AoiClassifiedFailure {
  const kind = classifyKind(input);
  const reasons = normalizeStringList(input.reasons, 16);
  const riskSignals = normalizeStringList(input.riskSignals, 16);
  const suggestedTools = normalizeStringList(
    input.suggestedTools ?? input.proposal?.suggestedTools,
    8,
  );
  const summary = truncateText(
    input.summary ||
      input.proposal?.blockedReason ||
      input.memory?.content ||
      input.researchRun?.statusMessage ||
      `${input.source} failure from ${input.sourceRef}`,
    260,
  );
  const originalErrorText = input.researchRun?.error?.message
    ? truncateText(input.researchRun.error.message, 220)
    : reasons.find((reason) => reason.length > 0);
  const signatureSeed = [
    input.sourceRef,
    kind,
    input.researchRun?.error?.code,
    input.proposal?.acceptAction?.kind ?? input.acceptActionKind,
    reasons.slice(0, 3).join('|'),
    riskSignals.slice(0, 3).join('|'),
  ]
    .filter(Boolean)
    .join('|');

  return {
    kind,
    source: input.source,
    sessionPath: input.sessionPath,
    sourceRef: input.sourceRef,
    summary,
    evidenceRefs: safeEvidenceRefs(input),
    reasons,
    riskSignals,
    suggestedTools,
    ...(input.acceptActionKind ? { acceptActionKind: input.acceptActionKind } : {}),
    ...(originalErrorText ? { originalErrorText } : {}),
    failureSignature: `failure:${kind}:${hashPart(signatureSeed)}`,
    hasMutationAction: hasMutationAction(input),
    ...(input.researchRun ? { researchRun: input.researchRun } : {}),
    ...(input.memory ? { memory: input.memory } : {}),
    ...(input.proposal ? { proposal: input.proposal } : {}),
  };
}

function actionForFailure(kind: AoiFailureKind): AoiRecoveryPreviewAction {
  const actions: Record<AoiFailureKind, AoiRecoveryPreviewAction> = {
    policy_blocked: {
      kind: 'ask_clarification',
      label: 'Ask one clarification',
      reason: 'Policy blocked the previous action, so Aoi should ask for explicit direction.',
    },
    missing_evidence: {
      kind: 'ask_clarification',
      label: 'Ask for missing evidence',
      reason: 'The next move needs a concrete evidence reference before continuing.',
    },
    scope_too_broad: {
      kind: 'narrow_scope',
      label: 'Narrow scope',
      reason: 'A smaller target reduces ambiguity and avoids broad follow-up work.',
    },
    stale_confirmation: {
      kind: 'ask_clarification',
      label: 'Refresh confirmation',
      reason: 'The prior approval is stale for a guarded action.',
    },
    research_failed: {
      kind: 'refresh_research',
      label: 'Refresh research narrowly',
      reason: 'The failed research can be retried with a smaller source budget.',
    },
    research_insufficient_sources: {
      kind: 'refresh_research',
      label: 'Refresh research with source check',
      reason: 'The previous run did not collect enough accepted sources.',
    },
    kira_needs_clarification: {
      kind: 'ask_clarification',
      label: 'Ask Kira clarification',
      reason: 'The Kira handoff needs one missing decision before work continues.',
    },
    kira_validation_failed: {
      kind: 'prepare_kira_followup',
      label: 'Prepare Kira follow-up',
      reason: 'The follow-up should target the failed validation evidence only.',
    },
    kira_review_blocked: {
      kind: 'prepare_kira_followup',
      label: 'Prepare review follow-up',
      reason: 'The follow-up should address the blocked review item only.',
    },
    execution_exception: {
      kind: 'mark_blocked',
      label: 'Mark blocked with reason',
      reason: 'The safest next state is blocked until the user chooses a smaller move.',
    },
  };
  return actions[kind];
}

function rootCauseSummary(failure: AoiClassifiedFailure): string {
  const kindLabel = failure.kind.replace(/_/g, ' ');
  const errorText = failure.originalErrorText
    ? ` Original failure text: ${failure.originalErrorText}.`
    : '';
  return truncateText(
    `Observed ${kindLabel} signal from ${failure.sourceRef}; Aoi is treating it as an unverified failure signal, not a proven root cause.${errorText}`,
    300,
  );
}

function validationNeed(failure: AoiClassifiedFailure): string {
  const needs: Record<AoiFailureKind, string> = {
    policy_blocked: 'fresh explicit approval or a policy-safe alternative',
    missing_evidence: 'at least one concrete evidence reference',
    scope_too_broad: 'one smaller task boundary',
    stale_confirmation: 'fresh user confirmation',
    research_failed: 'a smaller source budget and a retry boundary',
    research_insufficient_sources: 'enough accepted sources to support the claim',
    kira_needs_clarification: 'one clarification before Kira continues',
    kira_validation_failed: 'validation evidence for the failed Kira task',
    kira_review_blocked: 'review evidence for the blocked Kira task',
    execution_exception: 'a smaller confirmed next step',
  };
  return needs[failure.kind];
}

function nonGoalsForAction(actionKind: AoiRecoveryActionKind): string[] {
  const common = [
    'Do not execute file writes, patches, deletes, or shell commands.',
    'Do not broaden the task beyond the cited failure source.',
  ];
  if (actionKind === 'refresh_research') {
    return [
      ...common,
      'Do not claim the failed research result is fixed without a new accepted-source pass.',
    ];
  }
  if (actionKind === 'prepare_kira_followup') {
    return [...common, 'Do not create broad Kira work that fixes everything at once.'];
  }
  if (actionKind === 'ask_clarification') {
    return [...common, 'Do not ask more than one clarification question.'];
  }
  return [...common, 'Do not retry the original action automatically.'];
}

function recoveryCooldownKey(failure: AoiClassifiedFailure): string {
  return `failure-recovery:${failure.failureSignature}`;
}

function sameFailureSource(
  item: Pick<AoiProposal, 'trigger' | 'evidenceRefs' | 'recoveryPreview'>,
  sourceRef: string,
): boolean {
  return (
    item.trigger === 'failure_recovery' &&
    (item.recoveryPreview?.sourceRef === sourceRef || item.evidenceRefs.includes(sourceRef))
  );
}

function decisionMatchesFailure(
  decision: AoiProposalDecision,
  failure: AoiClassifiedFailure,
): boolean {
  return (
    decision.cooldownKey === recoveryCooldownKey(failure) ||
    (decision.proposalTrigger === 'failure_recovery' &&
      Boolean(decision.evidenceRefs?.includes(failure.sourceRef)))
  );
}

function evaluateRecoveryGuard(params: {
  failure: AoiClassifiedFailure;
  activeProposals: AoiProposal[];
  recentDecisions: AoiProposalDecision[];
  now: number;
  cooldownMs: number;
  maxRetryProposalsPerSource: number;
}): {
  allowed: boolean;
  reason?: AoiRecoverySuppressionReason;
  retryCount: number;
  cooldownUntil?: number;
} {
  const sourceActiveCount = params.activeProposals.filter(
    (proposal) =>
      (proposal.status === 'active' ||
        proposal.status === 'accepted' ||
        proposal.status === 'snoozed') &&
      sameFailureSource(proposal, params.failure.sourceRef),
  ).length;
  const matchingDecisions = params.recentDecisions.filter((decision) =>
    decisionMatchesFailure(decision, params.failure),
  );
  const retryCount = sourceActiveCount + matchingDecisions.length;

  if (params.failure.hasMutationAction) {
    return {
      allowed: false,
      reason: 'mutation_action_not_retriable',
      retryCount,
    };
  }

  const unsafeOrFrequent = matchingDecisions.find(
    (decision) =>
      decision.feedbackCategory === 'unsafe' || decision.feedbackCategory === 'too_frequent',
  );
  if (unsafeOrFrequent) {
    return {
      allowed: false,
      reason: 'user_feedback_suppressed',
      retryCount,
    };
  }

  if (sourceActiveCount > 0) {
    return {
      allowed: false,
      reason: 'duplicate_active_recovery',
      retryCount,
    };
  }

  const cooldownDecision = matchingDecisions.find(
    (decision) =>
      (decision.action === 'dismiss' || decision.action === 'snooze') &&
      decision.createdAt + params.cooldownMs > params.now,
  );
  if (cooldownDecision) {
    return {
      allowed: false,
      reason: 'cooldown_active',
      retryCount,
      cooldownUntil: cooldownDecision.createdAt + params.cooldownMs,
    };
  }

  if (retryCount >= params.maxRetryProposalsPerSource) {
    return {
      allowed: false,
      reason: 'retry_limit_reached',
      retryCount,
    };
  }

  return {
    allowed: true,
    retryCount,
  };
}

function makePreview(params: {
  failure: AoiClassifiedFailure;
  action: AoiRecoveryPreviewAction;
  retryCount: number;
  maxRetryCount: number;
  cooldownActive: boolean;
  cooldownUntil?: number;
  blockedReason?: string;
}): AoiRecoveryPreview {
  return {
    version: 1,
    failureKind: params.failure.kind,
    rootCauseSummary: rootCauseSummary(params.failure),
    evidenceRefs: params.failure.evidenceRefs.slice(0, 12),
    proposedAction: params.action,
    whyNarrowerOrSafer: truncateText(
      `${params.action.label} is bounded to ${params.failure.sourceRef} and cannot execute mutation tools directly.`,
      240,
    ),
    retryCount: params.retryCount,
    maxRetryCount: params.maxRetryCount,
    cooldownActive: params.cooldownActive,
    sourceRef: params.failure.sourceRef,
    failureSignature: params.failure.failureSignature,
    nonGoals: nonGoalsForAction(params.action.kind),
    ...(typeof params.cooldownUntil === 'number' ? { cooldownUntil: params.cooldownUntil } : {}),
    ...(params.blockedReason ? { blockedReason: params.blockedReason } : {}),
  };
}

function makeResearchAcceptAction(failure: AoiClassifiedFailure): AoiProposal['acceptAction'] {
  const run = failure.researchRun;
  const maxSources = Math.max(4, Math.min(8, Math.ceil((run?.maxSources ?? 12) / 2)));
  return {
    kind: 'start_research',
    params: {
      sessionPath: failure.sessionPath,
      request: truncateText(run?.request || failure.summary, 220),
      mode: 'standard',
      maxSources,
      allowDuplicate: true,
    },
  };
}

function makeKiraAcceptAction(failure: AoiClassifiedFailure): AoiProposal['acceptAction'] {
  return {
    kind: 'create_kira_work',
    params: {
      projectName: 'YourOpenRoom',
      title: truncateText(`Recover ${failure.kind.replace(/_/g, ' ')}`, 90),
      objective: truncateText(
        `Prepare one bounded follow-up for ${failure.sourceRef}: ${validationNeed(failure)}.`,
        220,
      ),
      scope: [
        truncateText(`Address only ${failure.sourceRef}`, 120),
        truncateText(validationNeed(failure), 120),
      ],
      modules: ['Aoi autonomy recovery'],
      validationProfile: 'aoi-recovery',
      evidenceRefs: failure.evidenceRefs.slice(0, 8),
      nonGoals: nonGoalsForAction('prepare_kira_followup'),
    },
  };
}

function buildProposal(params: {
  failure: AoiClassifiedFailure;
  preview: AoiRecoveryPreview;
  now: number;
}): AoiProposal {
  const actionKind = params.preview.proposedAction.kind;
  const suggestedTools =
    actionKind === 'refresh_research'
      ? ['start_research']
      : actionKind === 'prepare_kira_followup'
        ? ['create_kira_work']
        : [];
  const acceptAction =
    actionKind === 'refresh_research'
      ? makeResearchAcceptAction(params.failure)
      : actionKind === 'prepare_kira_followup'
        ? makeKiraAcceptAction(params.failure)
        : undefined;
  const evidenceRefs = params.failure.evidenceRefs.slice(0, 12);
  const sourceRefs = [
    params.failure.sourceRef,
    `recovery:${params.failure.failureSignature}`,
    ...evidenceRefs.filter((ref) => ref.startsWith('goal:')),
  ];

  return {
    version: 1,
    id: createAoiAutonomyId('aoi-proposal-failure-recovery', params.now),
    sessionPath: params.failure.sessionPath,
    status: 'active',
    title: truncateText(params.preview.proposedAction.label, TITLE_MAX_CHARS),
    body: truncateText(
      `That failed because validation needs ${validationNeed(params.failure)}. I can prepare a narrower follow-up, ask one question, or stop.`,
      BODY_MAX_CHARS,
    ),
    reason: truncateText(
      `Aoi classified ${params.failure.sourceRef} as ${params.failure.kind} and found a bounded recovery action.`,
      REASON_MAX_CHARS,
    ),
    trigger: 'failure_recovery',
    createdAt: params.now,
    updatedAt: params.now,
    cooldownKey: recoveryCooldownKey(params.failure),
    confidence: actionKind === 'mark_blocked' ? 0.66 : 0.74,
    risk: suggestedTools.length > 0 ? 'medium' : 'low',
    requiredAutonomyLevel: suggestedTools.length > 0 ? 'L4' : 'L2',
    requiresUserApproval: true,
    suggestedTools,
    evidenceRefs,
    memoryIds: params.failure.memory ? [params.failure.memory.id] : [],
    artifactRefs: [...new Set(sourceRefs)].slice(0, 12),
    riskSignals: ['failure-recovery', params.failure.kind],
    recoveryPreview: params.preview,
    ...(acceptAction ? { acceptAction } : {}),
  };
}

export function buildAoiFailureRecoveryProposal(params: {
  failure: AoiClassifiedFailure;
  context: AoiRecoveryProposalContext;
}): { proposal: AoiProposal | null; suppression?: AoiRecoverySuppression } {
  const action = actionForFailure(params.failure.kind);
  const cooldownMs = params.context.cooldownMs ?? DEFAULT_RECOVERY_COOLDOWN_MS;
  const maxRetryCount =
    params.context.maxRetryProposalsPerSource ?? DEFAULT_MAX_RETRY_PROPOSALS_PER_SOURCE;
  const guard = evaluateRecoveryGuard({
    failure: params.failure,
    activeProposals: params.context.activeProposals,
    recentDecisions: params.context.recentDecisions,
    now: params.context.now,
    cooldownMs,
    maxRetryProposalsPerSource: maxRetryCount,
  });
  const preview = makePreview({
    failure: params.failure,
    action,
    retryCount: guard.retryCount,
    maxRetryCount,
    cooldownActive: Boolean(guard.cooldownUntil),
    cooldownUntil: guard.cooldownUntil,
    blockedReason: guard.reason,
  });

  if (!guard.allowed) {
    return {
      proposal: null,
      suppression: {
        failure: params.failure,
        reason: guard.reason ?? 'retry_limit_reached',
        retryCount: guard.retryCount,
        ...(guard.cooldownUntil ? { cooldownUntil: guard.cooldownUntil } : {}),
        preview,
      },
    };
  }

  return {
    proposal: buildProposal({
      failure: params.failure,
      preview,
      now: params.context.now,
    }),
  };
}

export function buildAoiFailureRecoveryProposals(params: {
  failures: AoiFailureClassificationInput[];
  context: AoiRecoveryProposalContext;
}): AoiRecoveryProposalBuildResult {
  const classifiedFailures: AoiClassifiedFailure[] = [];
  const proposals: AoiProposal[] = [];
  const suppressed: AoiRecoverySuppression[] = [];
  const seenSignatures = new Set<string>();

  for (const failureInput of params.failures) {
    const failure = classifyAoiFailure(failureInput);
    classifiedFailures.push(failure);
    if (seenSignatures.has(failure.failureSignature)) {
      suppressed.push({
        failure,
        reason: 'duplicate_active_recovery',
        retryCount: 0,
        preview: makePreview({
          failure,
          action: actionForFailure(failure.kind),
          retryCount: 0,
          maxRetryCount:
            params.context.maxRetryProposalsPerSource ?? DEFAULT_MAX_RETRY_PROPOSALS_PER_SOURCE,
          cooldownActive: false,
          blockedReason: 'duplicate_active_recovery',
        }),
      });
      continue;
    }
    seenSignatures.add(failure.failureSignature);
    const result = buildAoiFailureRecoveryProposal({
      failure,
      context: params.context,
    });
    if (result.proposal) {
      proposals.push(result.proposal);
      params.context.activeProposals.push(result.proposal);
    }
    if (result.suppression) {
      suppressed.push(result.suppression);
    }
  }

  return {
    classifiedFailures,
    proposals,
    suppressed,
  };
}
