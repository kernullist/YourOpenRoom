import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import type {
  AoiApprovedCommandPolicy,
  AoiEnvironmentSourceRegistry,
  AoiGoal,
  AoiGoalOwner,
  AoiMissionState,
  AoiOperatorHealthState,
  AoiPlaybook,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';
import type { AoiSourceFreshnessContract } from './aoiSourceFreshnessContract';
import type { AoiMissionMemoryReport, AoiMissionMemorySnapshot } from './aoiMissionMemory';
import type {
  AoiFieldShadowDecisionRecord,
  AoiFieldShadowRecordReport,
} from './aoiFieldShadowDogfooding';
import type {
  AoiAdaptiveAcceptanceCandidate,
  AoiAdaptiveAcceptancePack,
} from './aoiAdaptiveAcceptanceCuration';

const MAX_TEXT = 240;
const MAX_REFS = 28;
const MAX_ITEMS = 24;
const WINDOWS_PRIVATE_PATH_PATTERN = /(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g;
const UNIX_PRIVATE_PATH_PATTERN =
  /(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g;

export type AoiMissionControlStatus =
  | 'active'
  | 'paused'
  | 'waiting_on_external'
  | 'waiting_on_approval'
  | 'stale'
  | 'needs_validation_preview'
  | 'blocked'
  | 'needs_operator_input'
  | 'completed'
  | 'archived';

export type AoiMissionControlPriority = 'critical' | 'high' | 'medium' | 'low' | 'archival';

export type AoiMissionControlOwner = AoiGoalOwner | 'external' | 'unknown';

export type AoiMissionControlNextSafeActionKind =
  | 'brief'
  | 'stay_quiet'
  | 'ask'
  | 'prepare_preview'
  | 'wait'
  | 'archive'
  | 'none';

export interface AoiMissionControlNextSafeAction {
  version: 1;
  kind: AoiMissionControlNextSafeActionKind;
  label: string;
  reason: string;
  boundaryLabel: string;
  requiresApproval: boolean;
  executionAllowed: false;
  ref?: string;
}

export interface AoiMissionControlTransition {
  version: 1;
  missionId: string;
  from: AoiMissionControlStatus;
  to: AoiMissionControlStatus;
  createdAt: number;
  reason: string;
  evidenceRefs: string[];
}

export interface AoiMissionControlItem {
  version: 1;
  id: string;
  sessionPath: string;
  missionId: string;
  status: AoiMissionControlStatus;
  priority: AoiMissionControlPriority;
  owner: AoiMissionControlOwner;
  confidence: number;
  lastKnownState: string;
  lastKnownWorkspaceState: string;
  staleAgeMs: number;
  staleReasonLabels: string[];
  pendingExternalRefs: string[];
  nextSafeAction: AoiMissionControlNextSafeAction;
  approvalRefs: string[];
  sourceFreshnessRefs: string[];
  relatedShadowDecisionRefs: string[];
  traceCandidateRefs: string[];
  playbookRefs: string[];
  validationRefs: string[];
  healthRefs: string[];
  evidenceRefs: string[];
  transitions: AoiMissionControlTransition[];
  updatedAt: number;
  mutationCount: 0;
}

export interface AoiMissionControlHealth {
  version: 1;
  activeMissionCount: number;
  staleMissionCount: number;
  waitingExternalCount: number;
  waitingApprovalCount: number;
  blockedMissionCount: number;
  pausedMissionCount: number;
  completedMissionCount: number;
  archivedMissionCount: number;
  topMissionId?: string;
  whyQuiet: string;
  warnings: string[];
  evidenceRefs: string[];
}

export interface AoiMissionControlDashboardSummary {
  version: 1;
  visible: boolean;
  statusLabel: string;
  activeMissionCountLabel: string;
  staleMissionCountLabel: string;
  waitingExternalCountLabel: string;
  waitingApprovalCountLabel: string;
  blockedMissionCountLabel: string;
  topMissionLabel: string;
  nextSafeActionLabel: string;
  whyQuietLabel: string;
  itemLabels: string[];
  evidenceRefs: string[];
}

export interface AoiMissionControlState {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  items: AoiMissionControlItem[];
  topMission?: AoiMissionControlItem;
  health: AoiMissionControlHealth;
  dashboardSummary: AoiMissionControlDashboardSummary;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiMissionControlRuntimeInput {
  sessionPath: string;
  now?: number;
  mission?: AoiMissionState | null;
  missions?: AoiMissionState[];
  goals?: AoiGoal[];
  missionMemory?: AoiMissionMemorySnapshot | null;
  missionMemoryReport?: AoiMissionMemoryReport | null;
  playbooks?: AoiPlaybook[];
  workspaceSnapshot?: AoiWorkspaceSnapshot | null;
  workspaceSnapshots?: AoiWorkspaceSnapshot[];
  health?: AoiOperatorHealthState | null;
  approvedCommandPolicies?: AoiApprovedCommandPolicy[];
  fieldShadowReport?: AoiFieldShadowRecordReport | null;
  shadowRecords?: AoiFieldShadowDecisionRecord[];
  adaptiveAcceptancePack?: AoiAdaptiveAcceptancePack | null;
  traceCandidates?: AoiAdaptiveAcceptanceCandidate[];
  sourceRegistry?: AoiEnvironmentSourceRegistry | null;
  sourceFreshnessContracts?: AoiSourceFreshnessContract[];
  previousState?: AoiMissionControlState | null;
  limit?: number;
}

interface MissionSeed {
  missionId: string;
  sessionPath: string;
  missions: AoiMissionState[];
  goals: AoiGoal[];
  snapshots: AoiMissionMemorySnapshot[];
  playbooks: AoiPlaybook[];
  workspaceSnapshots: AoiWorkspaceSnapshot[];
  shadowRecords: AoiFieldShadowDecisionRecord[];
  traceCandidates: AoiAdaptiveAcceptanceCandidate[];
  evidenceRefs: string[];
}

interface RuntimeSourceSet {
  sessionPath: string;
  now: number;
  goals: AoiGoal[];
  missions: AoiMissionState[];
  snapshots: AoiMissionMemorySnapshot[];
  playbooks: AoiPlaybook[];
  workspaceSnapshots: AoiWorkspaceSnapshot[];
  shadowRecords: AoiFieldShadowDecisionRecord[];
  traceCandidates: AoiAdaptiveAcceptanceCandidate[];
  approvedCommandPolicies: AoiApprovedCommandPolicy[];
  health: AoiOperatorHealthState | null;
  sourceRegistry: AoiEnvironmentSourceRegistry | null;
  sourceFreshnessContracts: AoiSourceFreshnessContract[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeMissionControlText(value: unknown, maxChars = MAX_TEXT): string {
  if (typeof value !== 'string') {
    return '';
  }
  const compact = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value))
      .replace(WINDOWS_PRIVATE_PATH_PATTERN, '[local path]')
      .replace(UNIX_PRIVATE_PATH_PATTERN, '[local path]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[private email]')
      .replace(/https?:\/\/[^\s'"`<>]+/gi, '[external url]'),
  );
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function normalizeRefs(values: Array<string | undefined | null>, maxItems = MAX_REFS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const sanitized = sanitizeMissionControlText(value, 180);
    if (!sanitized || seen.has(sanitized)) {
      continue;
    }
    seen.add(sanitized);
    out.push(sanitized);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function hashValues(values: string[]): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const value of values) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      first ^= code;
      first = Math.imul(first, 0x01000193) >>> 0;
      second ^= code + index;
      second = Math.imul(second, 0x85ebca6b) >>> 0;
    }
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function normalizeSessionPath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (
    normalized &&
    !normalized.includes('..') &&
    /^[a-zA-Z0-9._/-]+$/.test(normalized) &&
    normalized.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
  ) {
    return normalized;
  }
  return 'aoi/default';
}

function canonicalMissionId(value: string | undefined | null, fallbackSessionPath: string): string {
  const raw = sanitizeMissionControlText(value, 180);
  if (!raw) {
    return `mission:${fallbackSessionPath}`;
  }
  if (raw.startsWith('goal:')) {
    return raw;
  }
  if (raw.startsWith('mission:goal:')) {
    return raw.slice('mission:'.length);
  }
  if (raw.startsWith('mission:')) {
    const inner = raw.slice('mission:'.length);
    if (/^(aoi-)?goal[-:]/i.test(inner)) {
      return `goal:${inner}`;
    }
    return raw;
  }
  if (/^(aoi-)?goal[-:]/i.test(raw)) {
    return `goal:${raw}`;
  }
  return `mission:${raw}`;
}

function missionIdFromMission(mission: AoiMissionState, sessionPath: string): string {
  if (mission.activeGoalId) {
    return canonicalMissionId(`goal:${mission.activeGoalId}`, sessionPath);
  }
  return canonicalMissionId(mission.lastMeaningfulEventRef, sessionPath);
}

function missionIdFromPlaybook(playbook: AoiPlaybook, sessionPath: string): string {
  if (playbook.goalId) {
    return canonicalMissionId(`goal:${playbook.goalId}`, sessionPath);
  }
  if (playbook.missionRef) {
    return canonicalMissionId(playbook.missionRef, sessionPath);
  }
  return canonicalMissionId(`playbook:${playbook.id}`, sessionPath);
}

function missionIdFromShadowRecord(
  record: AoiFieldShadowDecisionRecord,
  sessionPath: string,
): string {
  return canonicalMissionId(record.missionId, sessionPath);
}

function missionIdFromTraceCandidate(
  candidate: AoiAdaptiveAcceptanceCandidate,
  sessionPath: string,
): string {
  const explicit = candidate.evidenceRefs.find(
    (ref) => ref.startsWith('goal:') || ref.startsWith('mission:'),
  );
  return canonicalMissionId(explicit, sessionPath);
}

function getSeed(
  seeds: Map<string, MissionSeed>,
  missionId: string,
  sessionPath: string,
): MissionSeed {
  const existing = seeds.get(missionId);
  if (existing) {
    return existing;
  }
  const seed: MissionSeed = {
    missionId,
    sessionPath,
    missions: [],
    goals: [],
    snapshots: [],
    playbooks: [],
    workspaceSnapshots: [],
    shadowRecords: [],
    traceCandidates: [],
    evidenceRefs: [missionId],
  };
  seeds.set(missionId, seed);
  return seed;
}

function newestByUpdatedAt<T>(items: T[], getUpdatedAt: (item: T) => number): T | undefined {
  return [...items].sort((left, right) => getUpdatedAt(right) - getUpdatedAt(left))[0];
}

function collectSources(input: AoiMissionControlRuntimeInput): RuntimeSourceSet {
  const sessionPath = normalizeSessionPath(input.sessionPath);
  const now = input.now ?? Date.now();
  const explicitMissions = [
    ...(input.missions ?? []),
    ...(input.mission ? [input.mission] : []),
  ].filter((mission) => mission.sessionPath === sessionPath && mission.status !== 'none');
  const snapshots = [
    ...(input.missionMemoryReport?.snapshots ?? []),
    ...(input.missionMemory ? [input.missionMemory] : []),
  ].filter((snapshot) => snapshot.sessionPath === sessionPath);
  const workspaceSnapshots = [
    ...(input.workspaceSnapshots ?? []),
    ...(input.workspaceSnapshot ? [input.workspaceSnapshot] : []),
  ].filter((snapshot) => snapshot.sessionPath === sessionPath);
  const shadowRecords = [
    ...(input.fieldShadowReport?.activeRecords ?? input.fieldShadowReport?.records ?? []),
    ...(input.shadowRecords ?? []),
  ].filter((record) => record.sessionPath === sessionPath);
  const traceCandidates = [
    ...(input.adaptiveAcceptancePack?.candidates ?? []),
    ...(input.traceCandidates ?? []),
  ].filter((candidate) => candidate.sessionPath === sessionPath);

  return {
    sessionPath,
    now,
    goals: (input.goals ?? []).filter((goal) => goal.sessionPath === sessionPath),
    missions: explicitMissions,
    snapshots,
    playbooks: (input.playbooks ?? []).filter((playbook) => playbook.sessionPath === sessionPath),
    workspaceSnapshots,
    shadowRecords,
    traceCandidates,
    approvedCommandPolicies: input.approvedCommandPolicies ?? [],
    health: input.health?.sessionPath === sessionPath ? input.health : null,
    sourceRegistry: input.sourceRegistry?.sessionPath === sessionPath ? input.sourceRegistry : null,
    sourceFreshnessContracts: input.sourceFreshnessContracts ?? [],
  };
}

function addSeedRefs(seed: MissionSeed, refs: Array<string | undefined | null>): void {
  seed.evidenceRefs = normalizeRefs([...seed.evidenceRefs, ...refs]);
}

function buildSeeds(sources: RuntimeSourceSet): MissionSeed[] {
  const seeds = new Map<string, MissionSeed>();
  for (const goal of sources.goals) {
    if (goal.status === 'abandoned') {
      continue;
    }
    const missionId = canonicalMissionId(`goal:${goal.id}`, sources.sessionPath);
    const seed = getSeed(seeds, missionId, sources.sessionPath);
    seed.goals.push(goal);
    addSeedRefs(seed, [`goal:${goal.id}`, ...goal.sourceRefs, ...goal.plan.sourceRefs]);
  }
  for (const mission of sources.missions) {
    const missionId = missionIdFromMission(mission, sources.sessionPath);
    const seed = getSeed(seeds, missionId, sources.sessionPath);
    seed.missions.push(mission);
    addSeedRefs(seed, [
      missionId,
      mission.lastMeaningfulEventRef,
      mission.nextRecommendedAction.ref,
      ...Object.values(mission.sourceRefs),
      ...mission.evidenceRefs,
    ]);
  }
  for (const snapshot of sources.snapshots) {
    const missionId = canonicalMissionId(snapshot.missionId, sources.sessionPath);
    const seed = getSeed(seeds, missionId, sources.sessionPath);
    seed.snapshots.push(snapshot);
    addSeedRefs(seed, [
      snapshot.id,
      snapshot.missionId,
      ...snapshot.evidenceRefs,
      ...snapshot.pendingExternalRefs,
      ...snapshot.staleValidationRefs,
      ...snapshot.nextApprovalRefs,
    ]);
  }
  for (const playbook of sources.playbooks) {
    const missionId = missionIdFromPlaybook(playbook, sources.sessionPath);
    const seed = getSeed(seeds, missionId, sources.sessionPath);
    seed.playbooks.push(playbook);
    addSeedRefs(seed, [
      `playbook:${playbook.id}`,
      playbook.missionRef,
      playbook.goalId ? `goal:${playbook.goalId}` : undefined,
      ...playbook.evidenceRefs,
      ...playbook.sourceRefs,
    ]);
  }
  for (const record of sources.shadowRecords) {
    const missionId = missionIdFromShadowRecord(record, sources.sessionPath);
    const seed = getSeed(seeds, missionId, sources.sessionPath);
    seed.shadowRecords.push(record);
    addSeedRefs(seed, [
      `field-shadow-record:${record.id}`,
      `shadow-decision:${record.decisionId}`,
      record.missionId,
      ...record.evidenceRefs,
      ...record.sourceRefs,
    ]);
  }
  for (const candidate of sources.traceCandidates) {
    const matchingSeed = [...seeds.values()].find((seed) =>
      seed.shadowRecords.some((record) => candidate.sourceDecisionRecordIds.includes(record.id)),
    );
    const missionId = matchingSeed
      ? matchingSeed.missionId
      : missionIdFromTraceCandidate(candidate, sources.sessionPath);
    const seed = getSeed(seeds, missionId, sources.sessionPath);
    seed.traceCandidates.push(candidate);
    addSeedRefs(seed, [
      `adaptive-acceptance:${candidate.id}`,
      ...candidate.sourceDecisionRecordIds.map((id) => `field-shadow-record:${id}`),
      ...candidate.evidenceRefs,
    ]);
  }

  const workspaceSnapshots = sources.workspaceSnapshots;
  for (const seed of seeds.values()) {
    seed.workspaceSnapshots = workspaceSnapshots;
    addSeedRefs(
      seed,
      workspaceSnapshots.flatMap((snapshot) => [
        `workspace:${snapshot.workspaceLabel}`,
        ...snapshot.evidenceRefs,
        ...snapshot.validation.evidenceRefs,
      ]),
    );
  }

  return [...seeds.values()];
}

function collectPendingExternalRefs(seed: MissionSeed): string[] {
  return normalizeRefs([
    ...seed.missions.flatMap((mission) =>
      mission.waitingOn === 'kira' || mission.waitingOn === 'research'
        ? [
            mission.sourceRefs.kiraWorkRef,
            mission.sourceRefs.researchRunRef,
            mission.lastMeaningfulEventRef,
          ]
        : [],
    ),
    ...seed.snapshots.flatMap((snapshot) => snapshot.pendingExternalRefs),
    ...seed.playbooks.flatMap((playbook) =>
      playbook.steps
        .filter((step) => step.status === 'waiting_for_external_event')
        .flatMap((step) => [
          `playbook:${playbook.id}`,
          `playbook-step:${step.id}`,
          step.refs.kiraWorkRef,
          step.refs.researchRunRef,
          step.refs.researchArtifactRef,
          step.refs.timelineEventRef,
          ...step.evidenceRefs,
        ]),
    ),
  ]);
}

function collectApprovalRefs(
  seed: MissionSeed,
  approvedCommandPolicies: AoiApprovedCommandPolicy[],
  now: number,
): string[] {
  const policyRefs = approvedCommandPolicies
    .filter((policy) => policy.expiresAt > now || policy.allowed)
    .flatMap((policy) => [
      `command-approval:${policy.approvalFingerprint}`,
      policy.cwdLabel,
      policy.allowed ? 'approved-command-policy:allowed' : 'approved-command-policy:blocked',
    ]);
  const playbookRefs = seed.playbooks.flatMap((playbook) =>
    playbook.steps
      .filter(
        (step) =>
          step.status === 'waiting_for_approval' ||
          (step.kind !== 'wait_for_external_event' && step.executionBoundary.requiresApproval),
      )
      .flatMap((step) => [
        `playbook:${playbook.id}`,
        `playbook-step:${step.id}`,
        step.executionBoundary.approvalRef,
        ...step.evidenceRefs,
      ]),
  );
  const missionRefs = seed.missions.flatMap((mission) =>
    mission.waitingOn === 'user'
      ? [
          mission.sourceRefs.proposalRef,
          mission.sourceRefs.decisionRef,
          mission.lastMeaningfulEventRef,
        ]
      : [],
  );
  const memoryRefs = seed.snapshots.flatMap((snapshot) => snapshot.nextApprovalRefs);
  return normalizeRefs([...policyRefs, ...playbookRefs, ...missionRefs, ...memoryRefs]);
}

function collectValidationRefs(seed: MissionSeed): string[] {
  return normalizeRefs([
    ...seed.missions.flatMap((mission) => [
      mission.sourceRefs.validationRef,
      mission.sourceRefs.workspaceSnapshotRef,
    ]),
    ...seed.snapshots.flatMap((snapshot) => snapshot.staleValidationRefs),
    ...seed.workspaceSnapshots.flatMap((snapshot) => [
      snapshot.validation.command,
      snapshot.validation.staleReason,
      ...snapshot.validation.evidenceRefs,
      ...snapshot.evidenceRefs,
    ]),
    ...seed.playbooks.flatMap((playbook) =>
      playbook.steps.flatMap((step) =>
        step.validationNotes.length > 0 || /validation/i.test(`${step.title} ${step.summary}`)
          ? [`playbook:${playbook.id}`, `playbook-step:${step.id}`, ...step.evidenceRefs]
          : [],
      ),
    ),
  ]);
}

function collectStaleReasonLabels(seed: MissionSeed): string[] {
  return normalizeRefs(
    [
      ...seed.snapshots.flatMap((snapshot) =>
        snapshot.needsRefresh || snapshot.freshness === 'stale' || snapshot.freshness === 'expired'
          ? [
              `${snapshot.missionId}: ${snapshot.freshness} mission memory`,
              ...snapshot.staleValidationRefs.map((ref) => `stale validation ${ref}`),
            ]
          : [],
      ),
      ...seed.workspaceSnapshots.flatMap((snapshot) =>
        snapshot.validation.freshness === 'stale' ||
        snapshot.validation.freshness === 'failed' ||
        snapshot.validation.result === 'failed'
          ? [
              snapshot.validation.staleReason || 'workspace validation is stale',
              `workspace validation ${snapshot.validation.freshness}`,
            ]
          : [],
      ),
      ...seed.missions.flatMap((mission) =>
        /stale|refresh|validation/i.test(
          `${mission.nextRecommendedAction.kind} ${mission.nextRecommendedAction.label} ${mission.nextRecommendedAction.reason}`,
        )
          ? [mission.nextRecommendedAction.reason]
          : [],
      ),
    ],
    8,
  );
}

function collectSourceFreshnessRefs(
  seed: MissionSeed,
  sourceRegistry: AoiEnvironmentSourceRegistry | null,
  sourceFreshnessContracts: AoiSourceFreshnessContract[],
  now: number,
): string[] {
  const contractRefs = sourceFreshnessContracts.flatMap((contract) => [
    `source-freshness:${contract.sourceId}:${contract.freshnessState}`,
    contract.consentState === 'revoked' || contract.consentState === 'missing'
      ? `source-consent:${contract.sourceId}:${contract.consentState}`
      : undefined,
    contract.bodyAccessState === 'body_disabled' || contract.bodyAccessState === 'metadata_only'
      ? `source-boundary:${contract.sourceId}:${contract.bodyAccessState}`
      : undefined,
    ...contract.cannotKnow.map((item) => `cannot-know:${contract.sourceId}:${item.code}`),
  ]);
  const sourceRefs =
    sourceFreshnessContracts.length > 0
      ? []
      : (sourceRegistry?.sources.flatMap((source) => {
          const ageMs = source.lastObservedAt
            ? now - source.lastObservedAt
            : Number.POSITIVE_INFINITY;
          const stale = source.enabled && ageMs > 24 * 60 * 60 * 1000;
          if (!source.enabled) {
            return [`environment-source:${source.id}:disabled`];
          }
          if (stale) {
            return [`environment-source:${source.id}:stale`];
          }
          return [`environment-source:${source.id}:freshness-known`];
        }) ?? []);
  return normalizeRefs([
    ...contractRefs,
    ...sourceRefs,
    ...seed.workspaceSnapshots.flatMap((snapshot) => [
      `workspace:${snapshot.freshness}`,
      `workspace-validation:${snapshot.validation.freshness}`,
    ]),
    ...seed.snapshots.map((snapshot) => `mission-memory:${snapshot.freshness}`),
  ]);
}

function collectHealthRefs(seed: MissionSeed, health: AoiOperatorHealthState | null): string[] {
  if (!health) {
    return [];
  }
  const missionText = `${seed.missionId} ${seed.evidenceRefs.join(' ')}`.toLowerCase();
  return normalizeRefs(
    health.issues
      .filter(
        (issue) =>
          issue.severity === 'blocker' ||
          issue.severity === 'error' ||
          missionText.includes(issue.capability),
      )
      .flatMap((issue) => [`health:${issue.id}`, issue.code, ...issue.evidenceRefs]),
  );
}

function collectShadowRefs(seed: MissionSeed): string[] {
  return normalizeRefs(
    seed.shadowRecords.flatMap((record) => [
      `field-shadow-record:${record.id}`,
      `shadow-decision:${record.decisionId}`,
      ...record.evidenceRefs,
    ]),
  );
}

function collectTraceCandidateRefs(seed: MissionSeed): string[] {
  return normalizeRefs(
    seed.traceCandidates.flatMap((candidate) => [
      `adaptive-acceptance:${candidate.id}`,
      ...candidate.traceExportIds.map((id) => `trace-export:${id}`),
      ...candidate.evidenceRefs,
    ]),
  );
}

function collectPlaybookRefs(seed: MissionSeed): string[] {
  return normalizeRefs(
    seed.playbooks.flatMap((playbook) => [
      `playbook:${playbook.id}`,
      playbook.missionRef,
      playbook.goalId ? `goal:${playbook.goalId}` : undefined,
      ...playbook.evidenceRefs,
    ]),
  );
}

function deriveOwner(seed: MissionSeed): AoiMissionControlOwner {
  const goal = newestByUpdatedAt(seed.goals, (item) => item.updatedAt);
  if (goal) {
    return goal.owner;
  }
  if (
    seed.missions.some(
      (mission) => mission.waitingOn === 'kira' || mission.waitingOn === 'research',
    ) ||
    seed.playbooks.some((playbook) =>
      playbook.steps.some((step) => step.status === 'waiting_for_external_event'),
    )
  ) {
    return 'external';
  }
  return 'unknown';
}

function deriveBaseStatus(seed: MissionSeed): AoiMissionControlStatus {
  const mission = newestByUpdatedAt(seed.missions, (item) => item.updatedAt);
  if (mission) {
    if (mission.status === 'paused') {
      return 'paused';
    }
    if (mission.status === 'completed') {
      return 'completed';
    }
    if (mission.status === 'blocked') {
      return 'blocked';
    }
    if (mission.status === 'waiting_on_kira' || mission.status === 'waiting_on_research') {
      return 'waiting_on_external';
    }
    if (mission.status === 'waiting_on_user') {
      return 'waiting_on_approval';
    }
    return 'active';
  }
  if (seed.playbooks.some((playbook) => playbook.status === 'archived')) {
    return 'archived';
  }
  if (seed.playbooks.some((playbook) => playbook.status === 'completed')) {
    return 'completed';
  }
  if (seed.playbooks.some((playbook) => playbook.status === 'blocked')) {
    return 'blocked';
  }
  if (seed.playbooks.some((playbook) => playbook.status === 'waiting')) {
    return 'waiting_on_external';
  }
  const goal = newestByUpdatedAt(seed.goals, (item) => item.updatedAt);
  if (goal?.status === 'paused') {
    return 'paused';
  }
  if (goal?.status === 'completed') {
    return 'completed';
  }
  if (goal?.status === 'blocked') {
    return 'blocked';
  }
  return 'active';
}

function hasBlockedEvidence(seed: MissionSeed, healthRefs: string[]): boolean {
  return (
    seed.missions.some(
      (mission) => mission.status === 'blocked' || Boolean(mission.blockedReason),
    ) ||
    seed.goals.some((goal) => goal.status === 'blocked') ||
    seed.playbooks.some(
      (playbook) => playbook.status === 'blocked' || playbook.blockedReasons.length > 0,
    ) ||
    healthRefs.some((ref) => /blocker|blocked|error/i.test(ref))
  );
}

function deriveStatus(params: {
  baseStatus: AoiMissionControlStatus;
  pendingExternalRefs: string[];
  approvalRefs: string[];
  staleReasonLabels: string[];
  healthRefs: string[];
  seed: MissionSeed;
}): AoiMissionControlStatus {
  if (
    params.baseStatus === 'completed' &&
    params.seed.playbooks.some((playbook) => playbook.status === 'archived')
  ) {
    return 'archived';
  }
  if (params.baseStatus === 'archived' || params.baseStatus === 'completed') {
    return params.baseStatus;
  }
  if (params.baseStatus === 'paused') {
    return 'paused';
  }
  if (hasBlockedEvidence(params.seed, params.healthRefs)) {
    return 'needs_operator_input';
  }
  if (params.approvalRefs.length > 0) {
    return 'waiting_on_approval';
  }
  if (params.pendingExternalRefs.length > 0) {
    return 'waiting_on_external';
  }
  if (params.staleReasonLabels.length > 0) {
    return 'needs_validation_preview';
  }
  return 'active';
}

function transition(
  missionId: string,
  from: AoiMissionControlStatus,
  to: AoiMissionControlStatus,
  reason: string,
  now: number,
  evidenceRefs: string[],
): AoiMissionControlTransition {
  return {
    version: 1,
    missionId,
    from,
    to,
    createdAt: now,
    reason: sanitizeMissionControlText(reason, 180),
    evidenceRefs: normalizeRefs(evidenceRefs, 12),
  };
}

function deriveTransitions(params: {
  missionId: string;
  baseStatus: AoiMissionControlStatus;
  status: AoiMissionControlStatus;
  previous?: AoiMissionControlItem;
  evidenceRefs: string[];
  staleReasonLabels: string[];
  now: number;
}): AoiMissionControlTransition[] {
  const transitions: AoiMissionControlTransition[] = [];
  if (params.previous && params.previous.status !== params.status) {
    transitions.push(
      transition(
        params.missionId,
        params.previous.status,
        params.status,
        `Mission control resumed from ${params.previous.status} to ${params.status}.`,
        params.now,
        params.evidenceRefs,
      ),
    );
  }
  if (params.baseStatus === 'completed' && params.status === 'archived') {
    transitions.push(
      transition(
        params.missionId,
        'completed',
        'archived',
        'Completed mission is ready for archival.',
        params.now,
        params.evidenceRefs,
      ),
    );
  }
  if (params.baseStatus === 'active' && params.status === 'waiting_on_external') {
    transitions.push(
      transition(
        params.missionId,
        'active',
        'waiting_on_external',
        'External Kira, research, or trace evidence is pending.',
        params.now,
        params.evidenceRefs,
      ),
    );
  }
  if (params.baseStatus === 'active' && params.status === 'waiting_on_approval') {
    transitions.push(
      transition(
        params.missionId,
        'active',
        'waiting_on_approval',
        'A fresh approval ref is required before execution.',
        params.now,
        params.evidenceRefs,
      ),
    );
  }
  if (params.baseStatus === 'active' && params.status === 'needs_operator_input') {
    transitions.push(
      transition(
        params.missionId,
        'active',
        'blocked',
        'Blocked evidence requires operator input.',
        params.now,
        params.evidenceRefs,
      ),
    );
  }
  if (params.status === 'needs_operator_input') {
    transitions.push(
      transition(
        params.missionId,
        'blocked',
        'needs_operator_input',
        'Blocked mission cannot advance without operator input.',
        params.now,
        params.evidenceRefs,
      ),
    );
  }
  if (params.status === 'needs_validation_preview') {
    transitions.push(
      transition(
        params.missionId,
        'active',
        'stale',
        params.staleReasonLabels[0] || 'Mission evidence is stale.',
        params.now,
        params.evidenceRefs,
      ),
    );
    transitions.push(
      transition(
        params.missionId,
        'stale',
        'needs_validation_preview',
        'Stale facts can only prepare a validation preview.',
        params.now,
        params.evidenceRefs,
      ),
    );
  }
  return transitions;
}

function derivePriority(status: AoiMissionControlStatus): AoiMissionControlPriority {
  if (status === 'needs_operator_input' || status === 'blocked') {
    return 'critical';
  }
  if (
    status === 'waiting_on_approval' ||
    status === 'needs_validation_preview' ||
    status === 'stale'
  ) {
    return 'high';
  }
  if (status === 'active' || status === 'waiting_on_external') {
    return 'medium';
  }
  if (status === 'archived') {
    return 'archival';
  }
  return 'low';
}

function priorityScore(priority: AoiMissionControlPriority): number {
  if (priority === 'critical') {
    return 5;
  }
  if (priority === 'high') {
    return 4;
  }
  if (priority === 'medium') {
    return 3;
  }
  if (priority === 'low') {
    return 2;
  }
  return 1;
}

function statusSortScore(status: AoiMissionControlStatus): number {
  if (status === 'needs_operator_input' || status === 'blocked') {
    return 90;
  }
  if (status === 'waiting_on_approval') {
    return 80;
  }
  if (status === 'needs_validation_preview' || status === 'stale') {
    return 70;
  }
  if (status === 'active') {
    return 60;
  }
  if (status === 'waiting_on_external') {
    return 50;
  }
  if (status === 'paused') {
    return 20;
  }
  if (status === 'completed') {
    return 10;
  }
  return 0;
}

function isTopMissionEligible(item: AoiMissionControlItem): boolean {
  return item.status !== 'completed' && item.status !== 'archived' && item.status !== 'paused';
}

function deriveConfidence(status: AoiMissionControlStatus): number {
  if (status === 'needs_operator_input' || status === 'blocked') {
    return 0.24;
  }
  if (status === 'needs_validation_preview' || status === 'stale') {
    return 0.38;
  }
  if (status === 'waiting_on_approval' || status === 'waiting_on_external') {
    return 0.56;
  }
  if (status === 'active') {
    return 0.74;
  }
  if (status === 'completed' || status === 'archived') {
    return 0.68;
  }
  return 0.5;
}

function deriveLastKnownState(seed: MissionSeed, status: AoiMissionControlStatus): string {
  const snapshot = newestByUpdatedAt(seed.snapshots, (item) => item.updatedAt);
  const mission = newestByUpdatedAt(seed.missions, (item) => item.updatedAt);
  const goal = newestByUpdatedAt(seed.goals, (item) => item.updatedAt);
  const playbook = newestByUpdatedAt(seed.playbooks, (item) => item.updatedAt);
  const base =
    snapshot?.lastKnownState ??
    (mission ? `${mission.status}: ${mission.focusSummary}` : undefined) ??
    (goal ? `${goal.status}: ${goal.title}` : undefined) ??
    (playbook ? `${playbook.status}: ${playbook.title}` : undefined) ??
    'Mission state unknown; refresh required before action.';
  const sanitized = sanitizeMissionControlText(base, 220);
  if (status === 'needs_validation_preview' || status === 'stale') {
    return `STALE: ${sanitized}`;
  }
  return sanitized;
}

function deriveWorkspaceState(seed: MissionSeed): string {
  const workspace = newestByUpdatedAt(seed.workspaceSnapshots, (item) => item.collectedAt);
  if (!workspace) {
    return 'Workspace state unknown.';
  }
  return sanitizeMissionControlText(
    `${workspace.workspaceLabel}; ${workspace.freshness}; validation ${workspace.validation.freshness}`,
    180,
  );
}

function deriveStaleAgeMs(seed: MissionSeed, staleReasonLabels: string[], now: number): number {
  if (staleReasonLabels.length <= 0) {
    return 0;
  }
  const workspace = newestByUpdatedAt(seed.workspaceSnapshots, (item) => item.collectedAt);
  const snapshot = newestByUpdatedAt(seed.snapshots, (item) => item.updatedAt);
  const mission = newestByUpdatedAt(seed.missions, (item) => item.updatedAt);
  const observedAt =
    workspace?.validation.completedAt ??
    workspace?.collectedAt ??
    snapshot?.updatedAt ??
    mission?.updatedAt;
  return Math.max(0, now - (observedAt ?? now));
}

function deriveUpdatedAt(seed: MissionSeed, now: number): number {
  const values = [
    ...seed.missions.map((mission) => mission.updatedAt),
    ...seed.goals.map((goal) => goal.updatedAt),
    ...seed.snapshots.map((snapshot) => snapshot.updatedAt),
    ...seed.playbooks.map((playbook) => playbook.updatedAt),
    ...seed.workspaceSnapshots.map((snapshot) => snapshot.collectedAt),
    ...seed.shadowRecords.map((record) => record.recordedAt),
    ...seed.traceCandidates.map((candidate) => candidate.createdAt),
  ];
  if (values.length <= 0) {
    return now;
  }
  return Math.max(...values);
}

function deriveNextSafeAction(params: {
  status: AoiMissionControlStatus;
  seed: MissionSeed;
  pendingExternalRefs: string[];
  approvalRefs: string[];
  staleReasonLabels: string[];
  validationRefs: string[];
}): AoiMissionControlNextSafeAction {
  const mission = newestByUpdatedAt(params.seed.missions, (item) => item.updatedAt);
  const firstRef =
    params.approvalRefs[0] ??
    params.pendingExternalRefs[0] ??
    params.validationRefs[0] ??
    mission?.nextRecommendedAction.ref;
  if (params.status === 'needs_operator_input' || params.status === 'blocked') {
    return {
      version: 1,
      kind: 'ask',
      label: 'Ask the operator for the missing decision or narrowed continuation.',
      reason: 'Blocked mission state cannot be advanced by Aoi alone.',
      boundaryLabel: 'No playbook step, command, or source mutation may run from mission control.',
      requiresApproval: true,
      executionAllowed: false,
      ...(firstRef ? { ref: firstRef } : {}),
    };
  }
  if (params.status === 'waiting_on_approval') {
    return {
      version: 1,
      kind: 'ask',
      label: 'Ask the user to renew or confirm the pending approval.',
      reason: 'Approval refs are remembered as blockers, not execution authority.',
      boundaryLabel: 'Existing approval gates remain required before any command or mutation.',
      requiresApproval: true,
      executionAllowed: false,
      ...(firstRef ? { ref: firstRef } : {}),
    };
  }
  if (params.status === 'waiting_on_external') {
    return {
      version: 1,
      kind: 'wait',
      label: 'Wait for external evidence before changing mission confidence.',
      reason: 'External waiting is not a failure and must not be inferred as completion.',
      boundaryLabel: 'Aoi may brief the wait state, but cannot fabricate external results.',
      requiresApproval: false,
      executionAllowed: false,
      ...(firstRef ? { ref: firstRef } : {}),
    };
  }
  if (params.status === 'needs_validation_preview' || params.status === 'stale') {
    return {
      version: 1,
      kind: 'prepare_preview',
      label: 'Prepare a validation preview before trusting stale facts.',
      reason: params.staleReasonLabels[0] || 'Mission evidence is stale.',
      boundaryLabel: 'Preview only; running validation still requires the existing command gate.',
      requiresApproval: false,
      executionAllowed: false,
      ...(firstRef ? { ref: firstRef } : {}),
    };
  }
  if (params.status === 'paused') {
    return {
      version: 1,
      kind: 'stay_quiet',
      label: 'Stay quiet until the mission is resumed.',
      reason: 'Paused missions preserve context without creating pressure.',
      boundaryLabel: 'Mission control can display paused state only.',
      requiresApproval: false,
      executionAllowed: false,
      ...(firstRef ? { ref: firstRef } : {}),
    };
  }
  if (params.status === 'completed') {
    return {
      version: 1,
      kind: 'archive',
      label: 'Archive or leave the completed mission out of active focus.',
      reason: 'Completed missions are evidence history, not active work.',
      boundaryLabel: 'Archival is a bookkeeping recommendation only.',
      requiresApproval: false,
      executionAllowed: false,
      ...(firstRef ? { ref: firstRef } : {}),
    };
  }
  if (params.status === 'archived') {
    return {
      version: 1,
      kind: 'none',
      label: 'No active action for archived mission.',
      reason: 'Archived missions are not eligible for active focus.',
      boundaryLabel: 'Display-only archive context.',
      requiresApproval: false,
      executionAllowed: false,
      ...(firstRef ? { ref: firstRef } : {}),
    };
  }
  return {
    version: 1,
    kind: 'brief',
    label: sanitizeMissionControlText(
      mission?.nextRecommendedAction.label || 'Brief the current mission state.',
      160,
    ),
    reason: sanitizeMissionControlText(
      mission?.nextRecommendedAction.reason || 'Mission is active with no blocked gate.',
      180,
    ),
    boundaryLabel: 'Mission control may brief or prepare previews only; it never executes tasks.',
    requiresApproval: false,
    executionAllowed: false,
    ...(firstRef ? { ref: firstRef } : {}),
  };
}

function buildItem(params: {
  seed: MissionSeed;
  sources: RuntimeSourceSet;
  previous?: AoiMissionControlItem;
}): AoiMissionControlItem {
  const healthRefs = collectHealthRefs(params.seed, params.sources.health);
  const pendingExternalRefs = collectPendingExternalRefs(params.seed);
  const approvalRefs = collectApprovalRefs(
    params.seed,
    params.sources.approvedCommandPolicies,
    params.sources.now,
  );
  const staleReasonLabels = collectStaleReasonLabels(params.seed);
  const validationRefs = collectValidationRefs(params.seed);
  const sourceFreshnessRefs = collectSourceFreshnessRefs(
    params.seed,
    params.sources.sourceRegistry,
    params.sources.sourceFreshnessContracts,
    params.sources.now,
  );
  const baseStatus = deriveBaseStatus(params.seed);
  const status = deriveStatus({
    baseStatus,
    pendingExternalRefs,
    approvalRefs,
    staleReasonLabels,
    healthRefs,
    seed: params.seed,
  });
  const priority = derivePriority(status);
  const evidenceRefs = normalizeRefs([
    ...params.seed.evidenceRefs,
    ...pendingExternalRefs,
    ...approvalRefs,
    ...validationRefs,
    ...sourceFreshnessRefs,
    ...healthRefs,
  ]);
  const nextSafeAction = deriveNextSafeAction({
    status,
    seed: params.seed,
    pendingExternalRefs,
    approvalRefs,
    staleReasonLabels,
    validationRefs,
  });
  const transitions = deriveTransitions({
    missionId: params.seed.missionId,
    baseStatus,
    status,
    previous: params.previous,
    evidenceRefs,
    staleReasonLabels,
    now: params.sources.now,
  });

  return {
    version: 1,
    id: `mission-control-item:${hashValues([params.seed.sessionPath, params.seed.missionId])}`,
    sessionPath: params.seed.sessionPath,
    missionId: params.seed.missionId,
    status,
    priority,
    owner: deriveOwner(params.seed),
    confidence: deriveConfidence(status),
    lastKnownState: deriveLastKnownState(params.seed, status),
    lastKnownWorkspaceState: deriveWorkspaceState(params.seed),
    staleAgeMs: deriveStaleAgeMs(params.seed, staleReasonLabels, params.sources.now),
    staleReasonLabels,
    pendingExternalRefs,
    nextSafeAction,
    approvalRefs,
    sourceFreshnessRefs,
    relatedShadowDecisionRefs: collectShadowRefs(params.seed),
    traceCandidateRefs: collectTraceCandidateRefs(params.seed),
    playbookRefs: collectPlaybookRefs(params.seed),
    validationRefs,
    healthRefs,
    evidenceRefs,
    transitions,
    updatedAt: deriveUpdatedAt(params.seed, params.sources.now),
    mutationCount: 0,
  };
}

function sortItems(items: AoiMissionControlItem[]): AoiMissionControlItem[] {
  return [...items].sort((left, right) => {
    const statusDiff = statusSortScore(right.status) - statusSortScore(left.status);
    if (statusDiff !== 0) {
      return statusDiff;
    }
    const priorityDiff = priorityScore(right.priority) - priorityScore(left.priority);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    const updatedDiff = right.updatedAt - left.updatedAt;
    if (updatedDiff !== 0) {
      return updatedDiff;
    }
    return left.missionId.localeCompare(right.missionId);
  });
}

function isStaleStatus(status: AoiMissionControlStatus): boolean {
  return status === 'stale' || status === 'needs_validation_preview';
}

function isBlockedStatus(status: AoiMissionControlStatus): boolean {
  return status === 'blocked' || status === 'needs_operator_input';
}

function buildWhyQuiet(items: AoiMissionControlItem[], topMission?: AoiMissionControlItem): string {
  if (!topMission) {
    return 'No mission requires speech; keep monitoring display-only evidence.';
  }
  if (topMission.status === 'waiting_on_external') {
    return 'Aoi should stay quiet unless the operator asks; the top mission is waiting on external evidence.';
  }
  if (topMission.status === 'paused') {
    return 'Aoi should stay quiet because the top mission is paused.';
  }
  if (topMission.status === 'completed' || topMission.status === 'archived') {
    return 'Aoi should stay quiet because completed or archived missions are not active work.';
  }
  if (items.every((item) => item.status === 'waiting_on_external' || item.status === 'paused')) {
    return 'Aoi should stay quiet because every mission is waiting or paused.';
  }
  return 'Aoi may brief the top mission, but mission control still has no execution authority.';
}

function buildHealth(
  items: AoiMissionControlItem[],
  topMission: AoiMissionControlItem | undefined,
): AoiMissionControlHealth {
  const warnings = normalizeRefs(
    items.flatMap((item) => [
      ...item.staleReasonLabels.map((label) => `${item.missionId}: ${label}`),
      ...(isBlockedStatus(item.status) ? [`${item.missionId}: blocked`] : []),
      ...(item.approvalRefs.length > 0 ? [`${item.missionId}: approval pending`] : []),
    ]),
    10,
  );
  return {
    version: 1,
    activeMissionCount: items.filter((item) => item.status === 'active').length,
    staleMissionCount: items.filter((item) => isStaleStatus(item.status)).length,
    waitingExternalCount: items.filter((item) => item.status === 'waiting_on_external').length,
    waitingApprovalCount: items.filter((item) => item.status === 'waiting_on_approval').length,
    blockedMissionCount: items.filter((item) => isBlockedStatus(item.status)).length,
    pausedMissionCount: items.filter((item) => item.status === 'paused').length,
    completedMissionCount: items.filter((item) => item.status === 'completed').length,
    archivedMissionCount: items.filter((item) => item.status === 'archived').length,
    ...(topMission ? { topMissionId: topMission.missionId } : {}),
    whyQuiet: buildWhyQuiet(items, topMission),
    warnings,
    evidenceRefs: normalizeRefs(items.flatMap((item) => item.evidenceRefs)),
  };
}

function countLabel(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

export function buildAoiMissionControlDashboardSummary(
  state: AoiMissionControlState | null | undefined,
): AoiMissionControlDashboardSummary {
  if (!state) {
    return {
      version: 1,
      visible: false,
      statusLabel: 'No mission control runtime',
      activeMissionCountLabel: '0 active missions',
      staleMissionCountLabel: '0 stale missions',
      waitingExternalCountLabel: '0 waiting external',
      waitingApprovalCountLabel: '0 waiting approval',
      blockedMissionCountLabel: '0 blocked missions',
      topMissionLabel: 'No mission focus yet',
      nextSafeActionLabel: 'No safe next action',
      whyQuietLabel: 'No mission control evidence is available.',
      itemLabels: [],
      evidenceRefs: [],
    };
  }
  const top = state.topMission;
  const health = state.health;
  return {
    version: 1,
    visible: state.items.length > 0,
    statusLabel: sanitizeMissionControlText(
      `Mission control: ${state.items.length} tracked; ${health.blockedMissionCount} blocked; ${health.staleMissionCount} stale`,
      140,
    ),
    activeMissionCountLabel: countLabel(health.activeMissionCount, 'active mission'),
    staleMissionCountLabel: countLabel(health.staleMissionCount, 'stale mission'),
    waitingExternalCountLabel: countLabel(health.waitingExternalCount, 'waiting external'),
    waitingApprovalCountLabel: countLabel(health.waitingApprovalCount, 'waiting approval'),
    blockedMissionCountLabel: countLabel(health.blockedMissionCount, 'blocked mission'),
    topMissionLabel: top
      ? sanitizeMissionControlText(`${top.missionId}: ${top.status}; ${top.lastKnownState}`, 220)
      : 'No mission focus yet',
    nextSafeActionLabel: top
      ? sanitizeMissionControlText(top.nextSafeAction.label, 180)
      : 'No safe next action',
    whyQuietLabel: sanitizeMissionControlText(health.whyQuiet, 220),
    itemLabels: state.items
      .slice(0, 8)
      .map((item) =>
        sanitizeMissionControlText(
          `${item.missionId}: ${item.status}; next ${item.nextSafeAction.label}`,
          220,
        ),
      ),
    evidenceRefs: normalizeRefs([
      ...state.evidenceRefs,
      ...(top?.evidenceRefs ?? []),
      ...(top ? [`mission-control:${top.missionId}`] : []),
    ]),
  };
}

export function buildAoiMissionControlState(
  input: AoiMissionControlRuntimeInput,
): AoiMissionControlState {
  const sources = collectSources(input);
  const previousByMissionId = new Map(
    input.previousState?.items.map((item) => [item.missionId, item]) ?? [],
  );
  const seeds = buildSeeds(sources);
  const limit = Math.max(1, Math.min(input.limit ?? MAX_ITEMS, MAX_ITEMS));
  const items = sortItems(
    seeds.map((seed) =>
      buildItem({
        seed,
        sources,
        previous: previousByMissionId.get(seed.missionId),
      }),
    ),
  ).slice(0, limit);
  const topMission = items.find(isTopMissionEligible);
  const health = buildHealth(items, topMission);
  const evidenceRefs = normalizeRefs([
    ...items.flatMap((item) => item.evidenceRefs),
    ...health.evidenceRefs,
  ]);
  const stateBase: Omit<AoiMissionControlState, 'dashboardSummary'> = {
    version: 1,
    id: `mission-control:${hashValues([
      sources.sessionPath,
      String(sources.now),
      ...items.map((item) => `${item.missionId}:${item.status}:${item.updatedAt}`),
    ])}`,
    sessionPath: sources.sessionPath,
    generatedAt: sources.now,
    items,
    ...(topMission ? { topMission } : {}),
    health,
    evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
  const state: AoiMissionControlState = {
    ...stateBase,
    dashboardSummary: buildAoiMissionControlDashboardSummary(null),
  };
  return {
    ...state,
    dashboardSummary: buildAoiMissionControlDashboardSummary(state),
  };
}
