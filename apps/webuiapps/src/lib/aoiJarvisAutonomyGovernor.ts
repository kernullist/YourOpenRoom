import { DEFAULT_AOI_AUTONOMY_POLICY, compareAoiAutonomyLevel } from './aoiAutonomyPolicy';
import type { AoiJarvisAcceptanceReport } from './aoiJarvisAcceptanceTrial';
import type { AoiJarvisReadinessScorecard } from './aoiJarvisReadinessScorecard';
import type { AoiMissionControlState } from './aoiMissionControlRuntime';
import type { AoiSourceFreshnessContract } from './aoiSourceFreshnessContract';
import type {
  AoiAutonomyBlockedProposal,
  AoiAutonomyPolicy,
  AoiOperatorHealthCapability,
  AoiOperatorHealthSeverity,
  AoiOperatorHealthState,
  AoiOperatorVoicePolicy,
  AoiProactiveBriefSchedulerControls,
  AoiProactiveTrendAdvisorState,
  AoiProposal,
} from './aoiAutonomyTypes';

export type AoiJarvisAutonomyMode =
  | 'observe_only'
  | 'suggest_quietly'
  | 'proactive_brief'
  | 'direct_chat'
  | 'prepare_actions'
  | 'approval_execution';

export type AoiJarvisAutonomyCapability =
  | 'observe'
  | 'mission_control'
  | 'research'
  | 'memory'
  | 'proactive_brief'
  | 'direct_chat'
  | 'voice'
  | 'prepare_action'
  | 'app_action'
  | 'command';

export type AoiJarvisAutonomyBlockerSeverity = 'info' | 'warning' | 'blocker';

export interface AoiJarvisAutonomyBlocker {
  version: 1;
  id: string;
  severity: AoiJarvisAutonomyBlockerSeverity;
  label: string;
  reason: string;
  affectedModes: AoiJarvisAutonomyMode[];
  evidenceRefs: string[];
}

export interface AoiJarvisAutonomyBand {
  version: 1;
  capability: AoiJarvisAutonomyCapability;
  allowed: boolean;
  requiredMode: AoiJarvisAutonomyMode;
  reason: string;
  evidenceRefs: string[];
}

export interface AoiJarvisAutonomyAgendaReadinessSnapshot {
  visible?: boolean;
  tone?: string;
  statusLabel?: string;
  candidateLabel?: string;
  summaryLabel?: string;
  deliveryDecisionLabels?: readonly string[];
  reasonLabels?: readonly string[];
  nextActionLabels?: readonly string[];
  evidenceRefs?: readonly string[];
}

export interface AoiJarvisAutonomyProactiveBriefSnapshot {
  visible?: boolean;
  statusLabel?: string;
  hasInlineCard?: boolean;
  hasChatHook?: boolean;
  evidenceRefs?: readonly string[];
}

export interface AoiJarvisAutonomyGovernorInput {
  sessionPath: string;
  now?: number;
  policy?: AoiAutonomyPolicy | null;
  operatorHealth?: AoiOperatorHealthState | null;
  jarvisReadinessScorecard?: AoiJarvisReadinessScorecard | null;
  jarvisAcceptanceReport?: AoiJarvisAcceptanceReport | null;
  sourceFreshnessContracts?: readonly AoiSourceFreshnessContract[] | null;
  missionControl?: AoiMissionControlState | null;
  proactiveTrendAdvisor?: AoiProactiveTrendAdvisorState | null;
  proactiveBrief?: AoiJarvisAutonomyProactiveBriefSnapshot | null;
  agendaNudgeReadiness?: AoiJarvisAutonomyAgendaReadinessSnapshot | null;
  activeProposals?: readonly AoiProposal[] | null;
  blockedProposals?: readonly AoiAutonomyBlockedProposal[] | null;
  operatorVoicePolicy?: AoiOperatorVoicePolicy | null;
  ttsEnabled?: boolean;
  operatorVoiceMuted?: boolean;
}

export interface AoiJarvisAutonomyGovernorDecision {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  overallMode: AoiJarvisAutonomyMode;
  modeRank: number;
  modeLabel: string;
  operatorSummary: string;
  allowedAutonomyBands: AoiJarvisAutonomyBand[];
  blockers: AoiJarvisAutonomyBlocker[];
  nextUpgradeAction: string;
  nextUpgradeEvidenceRefs: string[];
  whyNotJarvisYetLabels: string[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiJarvisAutonomyGovernorPanelSummary {
  visible: boolean;
  modeLabel: string;
  summaryLabel: string;
  allowedCapabilityLabels: string[];
  blockerLabels: string[];
  whyNotJarvisYetLabels: string[];
  nextUpgradeActionLabel: string;
  evidenceRefs: string[];
}

const MODE_ORDER: Record<AoiJarvisAutonomyMode, number> = {
  observe_only: 0,
  suggest_quietly: 1,
  proactive_brief: 2,
  direct_chat: 3,
  prepare_actions: 4,
  approval_execution: 5,
};

const MODE_LABELS: Record<AoiJarvisAutonomyMode, string> = {
  observe_only: 'Observe only',
  suggest_quietly: 'Suggest quietly',
  proactive_brief: 'Proactive brief',
  direct_chat: 'Direct chat',
  prepare_actions: 'Prepare actions',
  approval_execution: 'Approval execution',
};

const CAPABILITY_REQUIRED_MODE: Record<AoiJarvisAutonomyCapability, AoiJarvisAutonomyMode> = {
  observe: 'observe_only',
  mission_control: 'suggest_quietly',
  research: 'suggest_quietly',
  memory: 'suggest_quietly',
  proactive_brief: 'proactive_brief',
  direct_chat: 'direct_chat',
  voice: 'direct_chat',
  prepare_action: 'prepare_actions',
  app_action: 'approval_execution',
  command: 'approval_execution',
};

const CAPABILITY_LABELS: Record<AoiJarvisAutonomyCapability, string> = {
  observe: 'Observe sources',
  mission_control: 'Mission control',
  research: 'Research',
  memory: 'Memory',
  proactive_brief: 'Proactive brief',
  direct_chat: 'Direct chat',
  voice: 'Operator voice',
  prepare_action: 'Prepare action',
  app_action: 'Approved app action',
  command: 'Approved command',
};

const CAPABILITY_ORDER: AoiJarvisAutonomyCapability[] = [
  'observe',
  'mission_control',
  'research',
  'memory',
  'proactive_brief',
  'direct_chat',
  'voice',
  'prepare_action',
  'app_action',
  'command',
];

const HEALTH_SEVERITY_ORDER: Record<AoiOperatorHealthSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  blocker: 3,
};

const DIRECT_CHAT_SOURCE_STATES = new Set(['failed', 'disconnected', 'revoked', 'disabled']);

function modeAtMost(
  current: AoiJarvisAutonomyMode,
  cap: AoiJarvisAutonomyMode,
): AoiJarvisAutonomyMode {
  return MODE_ORDER[current] <= MODE_ORDER[cap] ? current : cap;
}

function isModeAtLeast(mode: AoiJarvisAutonomyMode, required: AoiJarvisAutonomyMode): boolean {
  return MODE_ORDER[mode] >= MODE_ORDER[required];
}

function uniqueLabels(values: Array<string | undefined | null>, maxItems = 18): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const label = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
    if (!label || seen.has(label)) {
      continue;
    }
    seen.add(label);
    labels.push(label);
    if (labels.length >= maxItems) {
      break;
    }
  }
  return labels;
}

function idPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function makeBlocker(params: {
  id: string;
  severity: AoiJarvisAutonomyBlockerSeverity;
  label: string;
  reason: string;
  affectedModes: AoiJarvisAutonomyMode[];
  evidenceRefs?: readonly string[];
}): AoiJarvisAutonomyBlocker {
  return {
    version: 1,
    id: `aoi-jarvis-governor:${idPart(params.id)}`,
    severity: params.severity,
    label: params.label,
    reason: params.reason,
    affectedModes: [...params.affectedModes],
    evidenceRefs: uniqueLabels([...(params.evidenceRefs ?? [])], 8),
  };
}

function policyBaseMode(policy: AoiAutonomyPolicy): AoiJarvisAutonomyMode {
  if (!policy.enabled && !policy.previewMode) {
    return 'observe_only';
  }
  if (compareAoiAutonomyLevel(policy.level, 'L5') >= 0) {
    return 'approval_execution';
  }
  if (compareAoiAutonomyLevel(policy.level, 'L4') >= 0) {
    return 'prepare_actions';
  }
  if (compareAoiAutonomyLevel(policy.level, 'L3') >= 0) {
    return 'proactive_brief';
  }
  if (compareAoiAutonomyLevel(policy.level, 'L2') >= 0) {
    return 'suggest_quietly';
  }
  return 'observe_only';
}

function collectHealthBlockers(
  health: AoiOperatorHealthState | null | undefined,
): AoiJarvisAutonomyBlocker[] {
  if (!health) {
    return [
      makeBlocker({
        id: 'operator-health-missing',
        severity: 'warning',
        label: 'Operator health is unavailable',
        reason:
          'Aoi cannot prove the runtime health of memory, research, voice, and command surfaces.',
        affectedModes: ['direct_chat', 'prepare_actions', 'approval_execution'],
        evidenceRefs: ['operator-health:missing'],
      }),
    ];
  }

  const blockers: AoiJarvisAutonomyBlocker[] = [];
  if (health.overallStatus === 'blocked') {
    blockers.push(
      makeBlocker({
        id: 'operator-health-blocked',
        severity: 'blocker',
        label: 'Operator health is blocked',
        reason: health.summary,
        affectedModes: [
          'suggest_quietly',
          'proactive_brief',
          'direct_chat',
          'prepare_actions',
          'approval_execution',
        ],
        evidenceRefs: health.evidenceRefs,
      }),
    );
  } else if (health.overallStatus === 'degraded') {
    blockers.push(
      makeBlocker({
        id: 'operator-health-degraded',
        severity: 'warning',
        label: 'Operator health is degraded',
        reason: health.summary,
        affectedModes: ['direct_chat', 'prepare_actions', 'approval_execution'],
        evidenceRefs: health.evidenceRefs,
      }),
    );
  }

  const strongestIssuesByCapability = new Map<AoiOperatorHealthCapability, string[]>();
  for (const issue of health.issues) {
    if (HEALTH_SEVERITY_ORDER[issue.severity] < HEALTH_SEVERITY_ORDER.error) {
      continue;
    }
    const refs = strongestIssuesByCapability.get(issue.capability) ?? [];
    strongestIssuesByCapability.set(issue.capability, [...refs, ...issue.evidenceRefs]);
  }

  for (const [capability, evidenceRefs] of strongestIssuesByCapability.entries()) {
    const affectedModes: AoiJarvisAutonomyMode[] =
      capability === 'approved_commands'
        ? ['approval_execution']
        : capability === 'voice'
          ? ['direct_chat']
          : ['proactive_brief', 'direct_chat', 'prepare_actions', 'approval_execution'];
    blockers.push(
      makeBlocker({
        id: `operator-health-${capability}`,
        severity: 'warning',
        label: `${capability.replace(/_/g, ' ')} health issue`,
        reason:
          'One or more health issues require review before Aoi can raise autonomy for this surface.',
        affectedModes,
        evidenceRefs,
      }),
    );
  }
  return blockers;
}

function collectReadinessBlockers(
  scorecard: AoiJarvisReadinessScorecard | null | undefined,
  acceptanceReport: AoiJarvisAcceptanceReport | null | undefined,
): AoiJarvisAutonomyBlocker[] {
  const blockers: AoiJarvisAutonomyBlocker[] = [];
  if (scorecard) {
    if (scorecard.gateStatus === 'blocked') {
      blockers.push(
        makeBlocker({
          id: 'jarvis-readiness-blocked',
          severity: 'blocker',
          label: 'Jarvis readiness gate is blocked',
          reason: `${scorecard.score}/100 readiness; ${scorecard.recommendations[0]?.reason ?? 'readiness gates did not pass.'}`,
          affectedModes: ['prepare_actions', 'approval_execution'],
          evidenceRefs: [...scorecard.evidenceRefs, ...scorecard.blockerRefs],
        }),
      );
    } else if (scorecard.gateStatus === 'warning') {
      blockers.push(
        makeBlocker({
          id: 'jarvis-readiness-warning',
          severity: 'warning',
          label: 'Jarvis readiness has warnings',
          reason: `${scorecard.score}/100 readiness; keep proactive behavior evidence-backed.`,
          affectedModes: ['prepare_actions', 'approval_execution'],
          evidenceRefs: scorecard.evidenceRefs,
        }),
      );
    }
  }

  if (acceptanceReport) {
    if (!acceptanceReport.passed || acceptanceReport.mutationCount > 0) {
      blockers.push(
        makeBlocker({
          id: 'jarvis-acceptance-failed',
          severity: 'blocker',
          label: 'Jarvis acceptance trial is not passing',
          reason: `${acceptanceReport.passedMetricCount}/${acceptanceReport.metricCount} metrics passed; mutations=${acceptanceReport.mutationCount}.`,
          affectedModes: ['direct_chat', 'prepare_actions', 'approval_execution'],
          evidenceRefs: acceptanceReport.evidenceRefs,
        }),
      );
    }
  }
  return blockers;
}

function collectSourceBlockers(
  contracts: readonly AoiSourceFreshnessContract[] | null | undefined,
): AoiJarvisAutonomyBlocker[] {
  const sourceContracts = [...(contracts ?? [])];
  if (sourceContracts.length === 0) {
    return [
      makeBlocker({
        id: 'source-freshness-missing',
        severity: 'warning',
        label: 'Source freshness is unproven',
        reason: 'Aoi has no current source freshness contracts to justify higher autonomy.',
        affectedModes: ['direct_chat', 'prepare_actions', 'approval_execution'],
        evidenceRefs: ['source-freshness:missing'],
      }),
    ];
  }

  const hardBlocked = sourceContracts.filter((contract) =>
    DIRECT_CHAT_SOURCE_STATES.has(contract.freshnessState),
  );
  const stale = sourceContracts.filter((contract) => contract.freshnessState === 'stale');
  const blockers: AoiJarvisAutonomyBlocker[] = [];
  if (hardBlocked.length > 0) {
    blockers.push(
      makeBlocker({
        id: 'source-freshness-hard-block',
        severity: 'blocker',
        label: 'Some sources are unavailable',
        reason: `${hardBlocked.length} source freshness contract(s) are failed, disconnected, revoked, or disabled.`,
        affectedModes: ['direct_chat', 'prepare_actions', 'approval_execution'],
        evidenceRefs: hardBlocked.flatMap((contract) => contract.evidenceRefs),
      }),
    );
  }
  if (stale.length > 0) {
    blockers.push(
      makeBlocker({
        id: 'source-freshness-stale',
        severity: 'warning',
        label: 'Some sources are stale',
        reason: `${stale.length} source freshness contract(s) are stale; direct interruptions must stay conservative.`,
        affectedModes: ['direct_chat', 'approval_execution'],
        evidenceRefs: stale.flatMap((contract) => contract.evidenceRefs),
      }),
    );
  }
  return blockers;
}

function collectMissionBlockers(
  missionControl: AoiMissionControlState | null | undefined,
): AoiJarvisAutonomyBlocker[] {
  if (!missionControl) {
    return [];
  }
  const blockers: AoiJarvisAutonomyBlocker[] = [];
  if (missionControl.health.blockedMissionCount > 0) {
    blockers.push(
      makeBlocker({
        id: 'mission-control-blocked',
        severity: 'warning',
        label: 'Mission control has blocked work',
        reason: missionControl.health.whyQuiet,
        affectedModes: ['prepare_actions', 'approval_execution'],
        evidenceRefs: missionControl.evidenceRefs,
      }),
    );
  }
  if (missionControl.health.waitingApprovalCount > 0) {
    blockers.push(
      makeBlocker({
        id: 'mission-control-waiting-approval',
        severity: 'warning',
        label: 'Mission control is waiting on approval',
        reason:
          'Aoi may prepare the next step, but execution must wait for fresh explicit approval.',
        affectedModes: ['approval_execution'],
        evidenceRefs: missionControl.evidenceRefs,
      }),
    );
  }
  return blockers;
}

function collectProactiveBlockers(params: {
  policy: AoiAutonomyPolicy;
  proactiveTrendAdvisor?: AoiProactiveTrendAdvisorState | null;
  proactiveBrief?: AoiJarvisAutonomyProactiveBriefSnapshot | null;
  agendaNudgeReadiness?: AoiJarvisAutonomyAgendaReadinessSnapshot | null;
}): AoiJarvisAutonomyBlocker[] {
  const blockers: AoiJarvisAutonomyBlocker[] = [];
  const controls: AoiProactiveBriefSchedulerControls = params.policy.proactiveBriefing;
  if (!params.policy.proactiveSuggestionsEnabled) {
    blockers.push(
      makeBlocker({
        id: 'proactive-policy-disabled',
        severity: 'warning',
        label: 'Proactive suggestions are disabled',
        reason: 'Aoi can observe and respond, but proactive surfacing is disabled in policy.',
        affectedModes: ['proactive_brief', 'direct_chat'],
        evidenceRefs: ['policy:proactiveSuggestionsEnabled:false'],
      }),
    );
  }
  if (!controls.enabled) {
    blockers.push(
      makeBlocker({
        id: 'proactive-briefing-paused',
        severity: 'warning',
        label: 'Proactive briefing is paused',
        reason: 'Current-info scouting is paused by proactive briefing controls.',
        affectedModes: ['proactive_brief', 'direct_chat'],
        evidenceRefs: ['policy:proactiveBriefing.enabled:false'],
      }),
    );
  }
  if (!controls.directChatHookOptIn) {
    blockers.push(
      makeBlocker({
        id: 'direct-chat-opt-in-missing',
        severity: 'warning',
        label: 'Direct chat opt-in is off',
        reason:
          'Aoi must keep proactive items in panels unless compact direct chat hooks are enabled.',
        affectedModes: ['direct_chat'],
        evidenceRefs: ['policy:directChatHookOptIn:false'],
      }),
    );
  }

  if (
    params.proactiveTrendAdvisor &&
    params.proactiveTrendAdvisor.readiness.directChatReady === false
  ) {
    blockers.push(
      makeBlocker({
        id: 'trend-direct-chat-not-ready',
        severity: 'warning',
        label: 'Trend direct chat is not ready',
        reason:
          params.proactiveTrendAdvisor.readiness.summary ||
          'Proactive trend advisor has not proven direct chat readiness.',
        affectedModes: ['direct_chat'],
        evidenceRefs: params.proactiveTrendAdvisor.readiness.evidenceRefs,
      }),
    );
  }

  const agenda = params.agendaNudgeReadiness;
  if (
    agenda?.visible &&
    (agenda.tone === 'blocked' ||
      agenda.tone === 'muted' ||
      agenda.statusLabel === 'blocked' ||
      agenda.statusLabel === 'muted')
  ) {
    blockers.push(
      makeBlocker({
        id: 'agenda-direct-chat-blocked',
        severity: 'warning',
        label: 'Agenda direct chat is blocked',
        reason:
          agenda.summaryLabel ||
          agenda.reasonLabels?.[0] ||
          'Agenda nudge readiness blocked direct chat delivery.',
        affectedModes: ['direct_chat'],
        evidenceRefs: agenda.evidenceRefs,
      }),
    );
  }

  if (params.proactiveBrief?.visible === false && params.proactiveBrief.statusLabel) {
    blockers.push(
      makeBlocker({
        id: 'proactive-brief-hidden',
        severity: 'info',
        label: 'No proactive brief is ready',
        reason: params.proactiveBrief.statusLabel,
        affectedModes: ['proactive_brief'],
        evidenceRefs: params.proactiveBrief.evidenceRefs,
      }),
    );
  }

  return blockers;
}

function collectVoiceBlockers(params: {
  operatorVoicePolicy?: AoiOperatorVoicePolicy | null;
  ttsEnabled?: boolean;
  operatorVoiceMuted?: boolean;
}): AoiJarvisAutonomyBlocker[] {
  const blockers: AoiJarvisAutonomyBlocker[] = [];
  if (params.ttsEnabled === false) {
    blockers.push(
      makeBlocker({
        id: 'tts-disabled',
        severity: 'info',
        label: 'TTS is disabled',
        reason: 'Operator voice cannot speak while TTS is disabled.',
        affectedModes: ['direct_chat'],
        evidenceRefs: ['voice:tts-disabled'],
      }),
    );
  }
  if (params.operatorVoicePolicy && !params.operatorVoicePolicy.enabled) {
    blockers.push(
      makeBlocker({
        id: 'operator-voice-disabled',
        severity: 'info',
        label: 'Operator voice is disabled',
        reason: 'Voice presence is disabled by operator voice policy.',
        affectedModes: ['direct_chat'],
        evidenceRefs: ['voice:policy-disabled'],
      }),
    );
  }
  if (params.operatorVoiceMuted) {
    blockers.push(
      makeBlocker({
        id: 'operator-voice-muted',
        severity: 'info',
        label: 'Operator voice is muted',
        reason: 'Voice presence is muted for this session.',
        affectedModes: ['direct_chat'],
        evidenceRefs: ['voice:session-muted'],
      }),
    );
  }
  return blockers;
}

function capModeFromBlockers(
  baseMode: AoiJarvisAutonomyMode,
  blockers: readonly AoiJarvisAutonomyBlocker[],
): AoiJarvisAutonomyMode {
  let mode = baseMode;
  for (const blocker of blockers) {
    if (blocker.severity === 'info') {
      continue;
    }
    if (blocker.affectedModes.includes('suggest_quietly')) {
      mode = modeAtMost(mode, 'observe_only');
    } else if (blocker.affectedModes.includes('proactive_brief')) {
      mode = modeAtMost(mode, 'suggest_quietly');
    } else if (blocker.affectedModes.includes('direct_chat')) {
      mode = modeAtMost(
        mode,
        blocker.severity === 'blocker' ? 'suggest_quietly' : 'proactive_brief',
      );
    } else if (blocker.affectedModes.includes('prepare_actions')) {
      mode = modeAtMost(mode, 'direct_chat');
    } else if (blocker.affectedModes.includes('approval_execution')) {
      mode = modeAtMost(mode, 'prepare_actions');
    }
  }
  return mode;
}

function buildBands(
  mode: AoiJarvisAutonomyMode,
  blockers: readonly AoiJarvisAutonomyBlocker[],
): AoiJarvisAutonomyBand[] {
  return CAPABILITY_ORDER.map((capability) => {
    const requiredMode = CAPABILITY_REQUIRED_MODE[capability];
    const modeAllows = isModeAtLeast(mode, requiredMode);
    const capabilityBlockers = blockers.filter(
      (blocker) =>
        blocker.severity !== 'info' &&
        blocker.affectedModes.some((affectedMode) =>
          isModeAtLeast(CAPABILITY_REQUIRED_MODE[capability], affectedMode),
        ),
    );
    const allowed = modeAllows && capabilityBlockers.length === 0;
    const firstBlocker = capabilityBlockers[0];
    return {
      version: 1,
      capability,
      allowed,
      requiredMode,
      reason: allowed
        ? `${CAPABILITY_LABELS[capability]} allowed at ${MODE_LABELS[mode]}.`
        : firstBlocker?.reason ||
          `${CAPABILITY_LABELS[capability]} requires ${MODE_LABELS[requiredMode]}.`,
      evidenceRefs: uniqueLabels(
        firstBlocker ? firstBlocker.evidenceRefs : [`governor-mode:${mode}`],
        8,
      ),
    };
  });
}

function nextUpgradeActionFromBlockers(blockers: readonly AoiJarvisAutonomyBlocker[]): {
  action: string;
  evidenceRefs: string[];
} {
  const actionable = blockers.find((blocker) => blocker.severity !== 'info');
  if (!actionable) {
    return {
      action:
        'Keep collecting replay, feedback, source freshness, and approval evidence before raising autonomy further.',
      evidenceRefs: ['governor:steady-state'],
    };
  }
  return {
    action: `Resolve ${actionable.label.toLowerCase()}: ${actionable.reason}`,
    evidenceRefs: actionable.evidenceRefs,
  };
}

function buildWhyNotJarvisLabels(params: {
  mode: AoiJarvisAutonomyMode;
  blockers: readonly AoiJarvisAutonomyBlocker[];
  activeProposals?: readonly AoiProposal[] | null;
  blockedProposals?: readonly AoiAutonomyBlockedProposal[] | null;
}): string[] {
  const labels = [
    params.mode !== 'approval_execution'
      ? `Current ceiling is ${MODE_LABELS[params.mode]}, so Aoi cannot act like an independent operator yet.`
      : 'Even at approval execution, every mutation still depends on existing explicit approval gates.',
    params.blockers.length > 0
      ? `${params.blockers.length} evidence-backed autonomy blocker(s) are active.`
      : 'No active blockers were found, but this governor still does not create new tool authority.',
  ];
  const blockedProposalCount = params.blockedProposals?.length ?? 0;
  if (blockedProposalCount > 0) {
    labels.push(`${blockedProposalCount} proposal(s) remain blocked by local policy.`);
  }
  const acceptedProposalCount =
    params.activeProposals?.filter((proposal) => proposal.status === 'accepted').length ?? 0;
  if (acceptedProposalCount > 0) {
    labels.push(
      `${acceptedProposalCount} accepted proposal(s) still require their existing execution gates.`,
    );
  }
  return uniqueLabels(labels, 6);
}

export function buildAoiJarvisAutonomyGovernor(
  input: AoiJarvisAutonomyGovernorInput,
): AoiJarvisAutonomyGovernorDecision {
  const now = input.now ?? Date.now();
  const policy = input.policy ?? DEFAULT_AOI_AUTONOMY_POLICY;
  const baseMode = policyBaseMode(policy);
  const blockers = [
    ...(!policy.enabled && !policy.previewMode
      ? [
          makeBlocker({
            id: 'policy-disabled',
            severity: 'blocker',
            label: 'Aoi autonomy is disabled',
            reason: 'Policy disables both autonomy and preview mode.',
            affectedModes: [
              'suggest_quietly',
              'proactive_brief',
              'direct_chat',
              'prepare_actions',
              'approval_execution',
            ],
            evidenceRefs: ['policy:enabled:false', 'policy:previewMode:false'],
          }),
        ]
      : []),
    ...collectHealthBlockers(input.operatorHealth),
    ...collectReadinessBlockers(input.jarvisReadinessScorecard, input.jarvisAcceptanceReport),
    ...collectSourceBlockers(input.sourceFreshnessContracts),
    ...collectMissionBlockers(input.missionControl),
    ...collectProactiveBlockers({
      policy,
      proactiveTrendAdvisor: input.proactiveTrendAdvisor,
      proactiveBrief: input.proactiveBrief,
      agendaNudgeReadiness: input.agendaNudgeReadiness,
    }),
    ...collectVoiceBlockers({
      operatorVoicePolicy: input.operatorVoicePolicy,
      ttsEnabled: input.ttsEnabled,
      operatorVoiceMuted: input.operatorVoiceMuted,
    }),
  ];
  const overallMode = capModeFromBlockers(baseMode, blockers);
  const bands = buildBands(overallMode, blockers);
  const nextUpgrade = nextUpgradeActionFromBlockers(blockers);
  const evidenceRefs = uniqueLabels(
    [
      `policy:level:${policy.level}`,
      `policy:preview:${policy.previewMode ? 'on' : 'off'}`,
      `governor-mode:${overallMode}`,
      ...(input.operatorHealth?.evidenceRefs ?? []),
      ...(input.jarvisReadinessScorecard?.evidenceRefs ?? []),
      ...(input.jarvisReadinessScorecard?.blockerRefs ?? []),
      ...(input.jarvisAcceptanceReport?.evidenceRefs ?? []),
      ...(input.missionControl?.evidenceRefs ?? []),
      ...(input.proactiveTrendAdvisor?.evidenceRefs ?? []),
      ...(input.proactiveBrief?.evidenceRefs ?? []),
      ...(input.agendaNudgeReadiness?.evidenceRefs ?? []),
      ...blockers.flatMap((blocker) => blocker.evidenceRefs),
    ],
    24,
  );
  return {
    version: 1,
    id: `aoi-jarvis-governor-${input.sessionPath.replace(/[^A-Za-z0-9_-]/g, '-')}-${now}`,
    sessionPath: input.sessionPath,
    generatedAt: now,
    overallMode,
    modeRank: MODE_ORDER[overallMode],
    modeLabel: MODE_LABELS[overallMode],
    operatorSummary:
      blockers.length > 0
        ? `${MODE_LABELS[overallMode]} is the safe ceiling because ${blockers[0].label.toLowerCase()}.`
        : `${MODE_LABELS[overallMode]} is allowed by current policy and evidence gates.`,
    allowedAutonomyBands: bands,
    blockers,
    nextUpgradeAction: nextUpgrade.action,
    nextUpgradeEvidenceRefs: uniqueLabels(nextUpgrade.evidenceRefs, 8),
    whyNotJarvisYetLabels: buildWhyNotJarvisLabels({
      mode: overallMode,
      blockers,
      activeProposals: input.activeProposals,
      blockedProposals: input.blockedProposals,
    }),
    evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function isAoiJarvisAutonomyModeAtLeast(
  decision: AoiJarvisAutonomyGovernorDecision | null | undefined,
  requiredMode: AoiJarvisAutonomyMode,
): boolean {
  if (!decision) {
    return false;
  }
  return isModeAtLeast(decision.overallMode, requiredMode);
}

export function canAoiJarvisAutonomyUseCapability(
  decision: AoiJarvisAutonomyGovernorDecision | null | undefined,
  capability: AoiJarvisAutonomyCapability,
): boolean {
  if (!decision) {
    return false;
  }
  return decision.allowedAutonomyBands.some(
    (band) => band.capability === capability && band.allowed,
  );
}

export function buildAoiJarvisAutonomyGovernorPanelSummary(
  decision: AoiJarvisAutonomyGovernorDecision | null | undefined,
): AoiJarvisAutonomyGovernorPanelSummary {
  if (!decision) {
    return {
      visible: false,
      modeLabel: 'Unknown',
      summaryLabel: 'Aoi autonomy governor has not evaluated the current state.',
      allowedCapabilityLabels: [],
      blockerLabels: [],
      whyNotJarvisYetLabels: [],
      nextUpgradeActionLabel: 'Refresh Aoi autonomy state.',
      evidenceRefs: [],
    };
  }
  const allowedCapabilityLabels = decision.allowedAutonomyBands
    .filter((band) => band.allowed)
    .map((band) => CAPABILITY_LABELS[band.capability])
    .slice(0, 8);
  return {
    visible: true,
    modeLabel: decision.modeLabel,
    summaryLabel: decision.operatorSummary,
    allowedCapabilityLabels,
    blockerLabels: decision.blockers
      .filter((blocker) => blocker.severity !== 'info')
      .map((blocker) => `${blocker.label}: ${blocker.reason}`)
      .slice(0, 6),
    whyNotJarvisYetLabels: decision.whyNotJarvisYetLabels,
    nextUpgradeActionLabel: decision.nextUpgradeAction,
    evidenceRefs: decision.evidenceRefs.slice(0, 8),
  };
}
