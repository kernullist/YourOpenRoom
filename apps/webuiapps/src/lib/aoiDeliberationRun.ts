import * as fs from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import {
  appendAoiFollowThroughEvent,
  createAoiAutonomyId,
  loadAoiActiveOpportunities,
  loadAoiActiveProposals,
  normalizeAoiAutonomySessionPath,
  resolveAoiAutonomyPaths,
} from './aoiAutonomyStore';
import { loadAoiMissionState } from './aoiAutonomyMission';
import { buildAoiFollowThroughEventFromDeliberationRun } from './aoiFollowThroughLearning';
import type {
  AoiDeliberationEvidenceStep,
  AoiDeliberationEvidenceStepKind,
  AoiDeliberationEvidenceStepStatus,
  AoiDeliberationFinding,
  AoiDeliberationOpinion,
  AoiDeliberationPhase,
  AoiDeliberationPhaseTransition,
  AoiDeliberationRun,
  AoiMissionState,
  AoiOpportunity,
  AoiProposal,
  AoiSignalFreshness,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';
import {
  containsAoiSensitiveContent,
  redactAoiSensitiveContent,
  stripAoiSourceInstructions,
  type AoiMemoryEntry,
} from './aoiMemoryShared';
import { loadServerAoiMemories } from './aoiMemoryServerWriter';
import { listAoiResearchRunSummaries } from './aoiResearchPlugin';
import type { AoiResearchRunSummary } from './aoiResearchTypes';
import { loadAoiWorkspaceSnapshot } from './aoiWorkspaceSignals';

const DELIBERATION_DIR = 'deliberations';
const DELIBERATION_RUNS_FILE = 'runs.json';
const MAX_DELIBERATION_RUNS = 80;
const DEFAULT_RECENT_RUN_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const STALE_RESEARCH_MS = 21 * 24 * 60 * 60 * 1000;
const STALE_MEMORY_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_TEXT_CHARS = 260;

const PRIVATE_MEMORY_TAGS = new Set([
  'private',
  'private-sensitive',
  'sensitive',
  'secret',
  'credential',
  'credentials',
  'api-key',
  'access-token',
  'token',
]);

export interface AoiDeliberationRunBuildInput {
  sessionPath: string;
  opportunity: AoiOpportunity;
  now?: number;
  memories?: readonly AoiMemoryEntry[];
  researchRuns?: readonly AoiResearchRunSummary[];
  workspaceSnapshot?: AoiWorkspaceSnapshot | null;
  activeProposals?: readonly AoiProposal[];
  mission?: AoiMissionState | null;
}

export interface AoiDeliberationRunForSessionInput extends Omit<
  AoiDeliberationRunBuildInput,
  'opportunity'
> {
  sessionsDir: string;
  opportunityId?: string;
  force?: boolean;
  recentRunCooldownMs?: number;
}

export interface AoiDeliberationRunForSessionResult {
  sessionPath: string;
  run: AoiDeliberationRun | null;
  created: boolean;
  skippedReason?: string;
  runs: AoiDeliberationRun[];
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function ensureDirectory(fileOrDirectory: string, isFile = false): void {
  fs.mkdirSync(isFile ? dirname(fileOrDirectory) : fileOrDirectory, { recursive: true });
}

function writeJsonAtomic(root: string, filePath: string, value: unknown): void {
  if (!isPathInsideRoot(root, filePath)) {
    throw new Error('Resolved Aoi deliberation path escaped the autonomy directory.');
  }
  ensureDirectory(filePath, true);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeText(value: string | undefined, maxChars = MAX_TEXT_CHARS): string {
  const normalized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value ?? ''))
      .replace(/(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g, '[redacted-path]')
      .replace(
        /\b\/(?:Users|home|var|tmp|mnt|Volumes|workspace)\/[^\s'"`<>|]+/gi,
        '[redacted-path]',
      )
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]'),
  );
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1).trimEnd()}...`;
}

function normalizeIdPart(value: string): string {
  return (
    sanitizeText(value, 120)
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96) || 'item'
  );
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function uniqueStrings(values: readonly (string | null | undefined)[], limit: number): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = sanitizeText(value ?? '', 180);
    if (!normalized) {
      continue;
    }
    seen.add(normalized);
    if (seen.size >= limit) {
      break;
    }
  }
  return [...seen];
}

function resolveAoiDeliberationRunPaths(
  sessionsDir: string,
  sessionPath: string,
): {
  root: string;
  runsFile: string;
} {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const root = join(paths.root, DELIBERATION_DIR);
  return {
    root,
    runsFile: join(root, DELIBERATION_RUNS_FILE),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isDeliberationPhase(value: unknown): value is AoiDeliberationPhase {
  return (
    value === 'queued' ||
    value === 'planning' ||
    value === 'observing' ||
    value === 'summarizing' ||
    value === 'ready' ||
    value === 'blocked' ||
    value === 'failed'
  );
}

function isEvidenceStatus(value: unknown): value is AoiDeliberationEvidenceStepStatus {
  return (
    value === 'pending' ||
    value === 'observed' ||
    value === 'missing' ||
    value === 'stale' ||
    value === 'blocked'
  );
}

function isEvidenceKind(value: unknown): value is AoiDeliberationEvidenceStepKind {
  return (
    value === 'opportunity' ||
    value === 'memory' ||
    value === 'research' ||
    value === 'workspace' ||
    value === 'kira' ||
    value === 'proposal' ||
    value === 'mission' ||
    value === 'app_state' ||
    value === 'unknown'
  );
}

function isSignalFreshness(value: unknown): value is AoiSignalFreshness {
  return value === 'unknown' || value === 'fresh' || value === 'stale' || value === 'failed';
}

function normalizeEvidenceStep(value: unknown, now: number): AoiDeliberationEvidenceStep | null {
  if (!isRecord(value)) {
    return null;
  }
  const id =
    typeof value.id === 'string' && value.id.trim()
      ? value.id
      : createAoiAutonomyId('aoi-delib-step', now);
  const kind = isEvidenceKind(value.kind) ? value.kind : 'unknown';
  const status = isEvidenceStatus(value.status) ? value.status : 'missing';
  const sourceRef = sanitizeText(typeof value.sourceRef === 'string' ? value.sourceRef : id, 180);
  return {
    version: 1,
    id,
    kind,
    status,
    sourceRef: sourceRef || id,
    label: sanitizeText(typeof value.label === 'string' ? value.label : `${kind} evidence`, 120),
    summary: sanitizeText(typeof value.summary === 'string' ? value.summary : 'No summary.', 260),
    freshness: isSignalFreshness(value.freshness) ? value.freshness : 'unknown',
    evidenceRefs: uniqueStrings(Array.isArray(value.evidenceRefs) ? value.evidenceRefs : [], 16),
    cannotKnow: uniqueStrings(Array.isArray(value.cannotKnow) ? value.cannotKnow : [], 8),
    blockers: uniqueStrings(Array.isArray(value.blockers) ? value.blockers : [], 8),
    ...(typeof value.observedAt === 'number' && Number.isFinite(value.observedAt)
      ? { observedAt: value.observedAt }
      : {}),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function normalizeFinding(value: unknown, now: number): AoiDeliberationFinding | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sourceQuality =
    value.sourceQuality === 'strong' ||
    value.sourceQuality === 'acceptable' ||
    value.sourceQuality === 'weak' ||
    value.sourceQuality === 'missing'
      ? value.sourceQuality
      : 'missing';
  return {
    version: 1,
    summary: sanitizeText(typeof value.summary === 'string' ? value.summary : 'No finding.', 320),
    sourceQuality,
    freshness: isSignalFreshness(value.freshness) ? value.freshness : 'unknown',
    confidence:
      typeof value.confidence === 'number' && Number.isFinite(value.confidence)
        ? Math.max(0, Math.min(1, value.confidence))
        : 0,
    evidenceRefs: uniqueStrings(Array.isArray(value.evidenceRefs) ? value.evidenceRefs : [], 16),
    blockers: uniqueStrings(Array.isArray(value.blockers) ? value.blockers : [], 8),
    cannotKnow: uniqueStrings(Array.isArray(value.cannotKnow) ? value.cannotKnow : [], 8),
    createdAt: normalizeTimestamp(value.createdAt, now),
  };
}

function normalizeOpinion(value: unknown, now: number): AoiDeliberationOpinion | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const evidenceRefs = uniqueStrings(
    Array.isArray(value.evidenceRefs) ? value.evidenceRefs : [],
    16,
  );
  if (evidenceRefs.length === 0) {
    return undefined;
  }
  const stance =
    value.stance === 'ready_to_brief' ||
    value.stance === 'needs_more_evidence' ||
    value.stance === 'abstain'
      ? value.stance
      : 'abstain';
  return {
    version: 1,
    stance,
    summary: sanitizeText(typeof value.summary === 'string' ? value.summary : 'No opinion.', 300),
    reason: sanitizeText(
      typeof value.reason === 'string' ? value.reason : 'Evidence-backed only.',
      240,
    ),
    evidenceRefs,
    createdAt: normalizeTimestamp(value.createdAt, now),
  };
}

function normalizePhaseTransition(
  value: unknown,
  now: number,
): AoiDeliberationPhaseTransition | null {
  if (!isRecord(value) || !isDeliberationPhase(value.to)) {
    return null;
  }
  return {
    ...(isDeliberationPhase(value.from) ? { from: value.from } : {}),
    to: value.to,
    reason: sanitizeText(typeof value.reason === 'string' ? value.reason : 'Phase changed.', 220),
    createdAt: normalizeTimestamp(value.createdAt, now),
    evidenceRefs: uniqueStrings(Array.isArray(value.evidenceRefs) ? value.evidenceRefs : [], 12),
  };
}

function normalizeDeliberationRun(
  value: unknown,
  sessionPath: string,
  now = Date.now(),
): AoiDeliberationRun | null {
  if (!isRecord(value)) {
    return null;
  }
  const id =
    typeof value.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$/.test(value.id)
      ? value.id
      : createAoiAutonomyId('aoi-delib-run', now);
  const opportunityId = sanitizeText(
    typeof value.opportunityId === 'string' ? value.opportunityId : 'missing-opportunity',
    128,
  );
  const evidencePlan = (Array.isArray(value.evidencePlan) ? value.evidencePlan : [])
    .map((step) => normalizeEvidenceStep(step, now))
    .filter((step): step is AoiDeliberationEvidenceStep => step !== null)
    .slice(0, 24);
  const evidenceRefs = uniqueStrings(
    Array.isArray(value.evidenceRefs)
      ? value.evidenceRefs
      : evidencePlan.flatMap((step) => step.evidenceRefs),
    24,
  );
  const finding = normalizeFinding(value.finding, now);
  const opinion = normalizeOpinion(value.opinion, now);
  return {
    version: 1,
    id,
    sessionPath,
    opportunityId: opportunityId || 'missing-opportunity',
    opportunityDedupeKey: sanitizeText(
      typeof value.opportunityDedupeKey === 'string' ? value.opportunityDedupeKey : opportunityId,
      180,
    ),
    opportunityTitle: sanitizeText(
      typeof value.opportunityTitle === 'string' ? value.opportunityTitle : 'Untitled opportunity',
      160,
    ),
    phase: isDeliberationPhase(value.phase) ? value.phase : 'failed',
    selectedAt: normalizeTimestamp(value.selectedAt, now),
    updatedAt: normalizeTimestamp(value.updatedAt, now),
    evidencePlan,
    ...(finding ? { finding } : {}),
    ...(opinion ? { opinion } : {}),
    safeNextAction: sanitizeText(
      typeof value.safeNextAction === 'string'
        ? value.safeNextAction
        : 'Keep this display-only until evidence is available.',
      260,
    ),
    blockers: uniqueStrings(Array.isArray(value.blockers) ? value.blockers : [], 12),
    evidenceRefs,
    artifactRefs: uniqueStrings(Array.isArray(value.artifactRefs) ? value.artifactRefs : [], 16),
    phaseHistory: (Array.isArray(value.phaseHistory) ? value.phaseHistory : [])
      .map((transition) => normalizePhaseTransition(transition, now))
      .filter((transition): transition is AoiDeliberationPhaseTransition => transition !== null)
      .slice(0, 12),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function sourceRefKind(ref: string): AoiDeliberationEvidenceStepKind {
  if (ref.startsWith('memory:')) {
    return 'memory';
  }
  if (ref.startsWith('research:')) {
    return 'research';
  }
  if (
    ref.startsWith('workspace') ||
    ref.startsWith('validation:') ||
    ref.startsWith('workspace_snapshot:')
  ) {
    return 'workspace';
  }
  if (ref.startsWith('kira')) {
    return 'kira';
  }
  if (ref.startsWith('proposal:')) {
    return 'proposal';
  }
  if (ref.startsWith('mission')) {
    return 'mission';
  }
  if (ref.startsWith('trend_') || ref.startsWith('app_state:')) {
    return 'app_state';
  }
  return 'unknown';
}

function makeStep(params: {
  now: number;
  kind: AoiDeliberationEvidenceStepKind;
  sourceRef: string;
  label: string;
  summary: string;
  status: AoiDeliberationEvidenceStepStatus;
  freshness: AoiSignalFreshness;
  evidenceRefs?: readonly string[];
  cannotKnow?: readonly string[];
  blockers?: readonly string[];
}): AoiDeliberationEvidenceStep {
  return {
    version: 1,
    id: `aoi-delib-step-${normalizeIdPart(params.kind)}-${normalizeIdPart(params.sourceRef)}`.slice(
      0,
      127,
    ),
    kind: params.kind,
    status: params.status,
    sourceRef: sanitizeText(params.sourceRef, 180),
    label: sanitizeText(params.label, 120),
    summary: sanitizeText(params.summary, 260),
    freshness: params.freshness,
    evidenceRefs: uniqueStrings(params.evidenceRefs ?? [params.sourceRef], 16),
    cannotKnow: uniqueStrings(params.cannotKnow ?? [], 8),
    blockers: uniqueStrings(params.blockers ?? [], 8),
    ...(params.status === 'observed' ? { observedAt: params.now } : {}),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function memoryIsPrivate(memory: AoiMemoryEntry): boolean {
  return (
    memory.tags.some((tag) => PRIVATE_MEMORY_TAGS.has(tag.toLowerCase())) ||
    containsAoiSensitiveContent(memory.content)
  );
}

function buildMemoryStep(params: {
  ref: string;
  memory: AoiMemoryEntry | undefined;
  now: number;
}): AoiDeliberationEvidenceStep {
  const id = params.ref.replace(/^memory:/, '');
  if (!params.memory) {
    return makeStep({
      now: params.now,
      kind: 'memory',
      sourceRef: params.ref,
      label: `Memory ${id}`,
      summary: 'Referenced memory was not found in local Aoi memory metadata.',
      status: 'missing',
      freshness: 'unknown',
      blockers: ['missing memory source'],
    });
  }
  if (memoryIsPrivate(params.memory)) {
    return makeStep({
      now: params.now,
      kind: 'memory',
      sourceRef: params.ref,
      label: `Memory ${params.memory.id}`,
      summary:
        'Referenced memory exists, but the body is withheld because it is private or sensitive.',
      status: 'blocked',
      freshness: 'unknown',
      evidenceRefs: [params.ref],
      cannotKnow: ['private memory body withheld'],
      blockers: ['private source body gated'],
    });
  }
  const stale = params.now - params.memory.updatedAt > STALE_MEMORY_MS;
  return makeStep({
    now: params.now,
    kind: 'memory',
    sourceRef: params.ref,
    label: `Memory ${params.memory.type}`,
    summary: sanitizeText(params.memory.content, 220),
    status: stale ? 'stale' : 'observed',
    freshness: stale ? 'stale' : 'fresh',
    evidenceRefs: [params.ref],
    blockers: stale ? ['memory evidence is stale'] : [],
  });
}

function runArtifactsMissing(run: AoiResearchRunSummary): string[] {
  const missing: string[] = [];
  if (!run.artifactAvailability) {
    return ['research artifact availability unknown'];
  }
  if (!run.artifactAvailability.report) {
    missing.push('research report artifact missing');
  }
  if (!run.artifactAvailability.sources) {
    missing.push('research source artifact missing');
  }
  if (!run.artifactAvailability.evidence) {
    missing.push('research evidence artifact missing');
  }
  return missing;
}

function buildResearchStep(params: {
  ref: string;
  run: AoiResearchRunSummary | undefined;
  now: number;
}): AoiDeliberationEvidenceStep {
  const id = params.ref.replace(/^research:/, '').split('/')[0];
  if (!params.run) {
    return makeStep({
      now: params.now,
      kind: 'research',
      sourceRef: params.ref,
      label: `Research ${id}`,
      summary: 'Referenced Aoi Research run was not found.',
      status: 'missing',
      freshness: 'unknown',
      blockers: ['missing research run'],
    });
  }
  if (params.run.status === 'failed' || params.run.status === 'cancelled') {
    return makeStep({
      now: params.now,
      kind: 'research',
      sourceRef: params.ref,
      label: params.run.title || params.run.request,
      summary: `Research status is ${params.run.status}: ${params.run.statusMessage}`,
      status: 'blocked',
      freshness: 'failed',
      evidenceRefs: [params.ref, `research_status:${params.run.status}`],
      blockers: ['research run did not complete successfully'],
    });
  }
  const referenceTime = params.run.completedAt || params.run.updatedAt || params.run.createdAt;
  const stale = params.now - referenceTime > STALE_RESEARCH_MS;
  const missingArtifacts = runArtifactsMissing(params.run);
  const weakSources = params.run.sourceCounts.accepted < 1;
  const blockers = [
    ...(stale ? ['research evidence is stale'] : []),
    ...missingArtifacts,
    ...(weakSources ? ['research has no accepted sources'] : []),
  ];
  const status: AoiDeliberationEvidenceStepStatus =
    blockers.length > 0 ? (stale ? 'stale' : 'missing') : 'observed';
  return makeStep({
    now: params.now,
    kind: 'research',
    sourceRef: params.ref,
    label: params.run.title || params.run.request,
    summary: `Research ${params.run.status}; accepted sources=${params.run.sourceCounts.accepted}; warnings=${params.run.warningCount}.`,
    status,
    freshness: stale ? 'stale' : 'fresh',
    evidenceRefs: [
      params.ref,
      ...(params.run.artifactAvailability?.report ? [`research:${id}/report`] : []),
    ],
    cannotKnow: blockers,
    blockers,
  });
}

function buildWorkspaceStep(params: {
  ref: string;
  snapshot: AoiWorkspaceSnapshot | null | undefined;
  now: number;
}): AoiDeliberationEvidenceStep {
  if (!params.snapshot) {
    return makeStep({
      now: params.now,
      kind: 'workspace',
      sourceRef: params.ref,
      label: 'Workspace snapshot',
      summary: 'Workspace evidence was referenced, but no local snapshot exists.',
      status: 'missing',
      freshness: 'unknown',
      blockers: ['missing workspace snapshot'],
    });
  }
  const failed =
    params.snapshot.freshness === 'failed' || params.snapshot.validation.result === 'failed';
  const stale =
    params.snapshot.freshness === 'stale' || params.snapshot.validation.freshness === 'stale';
  return makeStep({
    now: params.now,
    kind: 'workspace',
    sourceRef: params.ref,
    label: params.snapshot.workspaceLabel,
    summary: `Workspace snapshot freshness=${params.snapshot.freshness}; validation=${params.snapshot.validation.result}/${params.snapshot.validation.freshness}.`,
    status: failed ? 'blocked' : stale ? 'stale' : 'observed',
    freshness: failed ? 'failed' : stale ? 'stale' : 'fresh',
    evidenceRefs: [
      params.ref,
      ...params.snapshot.evidenceRefs,
      ...params.snapshot.validation.evidenceRefs,
    ],
    cannotKnow: stale ? ['workspace snapshot is stale'] : [],
    blockers: [
      ...(failed ? ['workspace validation failed'] : []),
      ...(stale ? ['workspace evidence is stale'] : []),
    ],
  });
}

function buildProposalStep(params: {
  ref: string;
  proposal: AoiProposal | undefined;
  now: number;
}): AoiDeliberationEvidenceStep {
  const id = params.ref.replace(/^proposal:/, '');
  if (!params.proposal) {
    return makeStep({
      now: params.now,
      kind: 'proposal',
      sourceRef: params.ref,
      label: `Proposal ${id}`,
      summary: 'Referenced proposal is not active in the current local proposal list.',
      status: 'missing',
      freshness: 'unknown',
      blockers: ['missing proposal source'],
    });
  }
  return makeStep({
    now: params.now,
    kind: 'proposal',
    sourceRef: params.ref,
    label: params.proposal.title,
    summary: `Proposal status=${params.proposal.status}; risk=${params.proposal.risk}; approval=${String(params.proposal.requiresUserApproval)}.`,
    status: 'observed',
    freshness: 'fresh',
    evidenceRefs: [params.ref, ...params.proposal.evidenceRefs],
  });
}

function buildMissionStep(params: {
  ref: string;
  mission: AoiMissionState | null | undefined;
  now: number;
}): AoiDeliberationEvidenceStep {
  if (!params.mission) {
    return makeStep({
      now: params.now,
      kind: 'mission',
      sourceRef: params.ref,
      label: 'Mission state',
      summary: 'Mission evidence was referenced, but no mission state exists.',
      status: 'missing',
      freshness: 'unknown',
      blockers: ['missing mission state'],
    });
  }
  return makeStep({
    now: params.now,
    kind: 'mission',
    sourceRef: params.ref,
    label: `Mission ${params.mission.status}`,
    summary: `${params.mission.focusSummary}; next=${params.mission.nextRecommendedAction.label}.`,
    status: params.mission.status === 'blocked' ? 'blocked' : 'observed',
    freshness: params.mission.status === 'blocked' ? 'failed' : 'fresh',
    evidenceRefs: [params.ref, ...params.mission.evidenceRefs],
    blockers: params.mission.blockedReason ? [params.mission.blockedReason] : [],
  });
}

function buildGenericStep(params: {
  ref: string;
  kind: AoiDeliberationEvidenceStepKind;
  now: number;
}): AoiDeliberationEvidenceStep {
  if (
    /^(?:generated_by|curiosity_engine|curiosity:|interest_topic:|cannot_know:)/.test(params.ref)
  ) {
    return makeStep({
      now: params.now,
      kind: params.kind === 'unknown' ? 'opportunity' : params.kind,
      sourceRef: params.ref,
      label: 'Opportunity metadata',
      summary: 'Metadata explains how the opportunity was generated, but is not enough by itself.',
      status: 'observed',
      freshness: 'fresh',
      evidenceRefs: [params.ref],
      cannotKnow: params.ref.startsWith('cannot_know:')
        ? [params.ref.replace(/^cannot_know:/, '')]
        : [],
    });
  }
  if (/^(?:kira_|kira:|kira_work:|kira_outcome:)/.test(params.ref)) {
    return makeStep({
      now: params.now,
      kind: 'kira',
      sourceRef: params.ref,
      label: 'Kira outcome metadata',
      summary:
        'Kira evidence ref exists as local metadata; detailed validation logs may still be needed.',
      status: 'observed',
      freshness: 'fresh',
      evidenceRefs: [params.ref],
    });
  }
  return makeStep({
    now: params.now,
    kind: params.kind,
    sourceRef: params.ref,
    label: 'Unknown evidence ref',
    summary: 'Evidence ref could not be resolved to a local source.',
    status: 'missing',
    freshness: 'unknown',
    blockers: ['unresolved evidence ref'],
  });
}

function buildEvidencePlan(
  input: AoiDeliberationRunBuildInput & { now: number },
): AoiDeliberationEvidenceStep[] {
  const memoriesById = new Map((input.memories ?? []).map((memory) => [memory.id, memory]));
  const researchById = new Map((input.researchRuns ?? []).map((run) => [run.id, run]));
  const proposalsById = new Map(
    (input.activeProposals ?? []).map((proposal) => [proposal.id, proposal]),
  );
  const refs = uniqueStrings(input.opportunity.evidenceRefs, 24);
  const steps: AoiDeliberationEvidenceStep[] = [
    makeStep({
      now: input.now,
      kind: 'opportunity',
      sourceRef: `opportunity:${input.opportunity.id}`,
      label: input.opportunity.title,
      summary: `${input.opportunity.curiosityQuestion} Evidence need: ${input.opportunity.evidenceNeed}`,
      status: 'observed',
      freshness: input.opportunity.expiresAt > input.now ? 'fresh' : 'stale',
      evidenceRefs: [`opportunity:${input.opportunity.id}`, ...input.opportunity.evidenceRefs],
      blockers: input.opportunity.expiresAt <= input.now ? ['opportunity is expired'] : [],
    }),
  ];

  for (const ref of refs) {
    const kind = sourceRefKind(ref);
    if (kind === 'memory') {
      steps.push(
        buildMemoryStep({
          ref,
          memory: memoriesById.get(ref.replace(/^memory:/, '')),
          now: input.now,
        }),
      );
      continue;
    }
    if (kind === 'research') {
      const id = ref.replace(/^research:/, '').split('/')[0];
      steps.push(buildResearchStep({ ref, run: researchById.get(id), now: input.now }));
      continue;
    }
    if (kind === 'workspace') {
      steps.push(buildWorkspaceStep({ ref, snapshot: input.workspaceSnapshot, now: input.now }));
      continue;
    }
    if (kind === 'proposal') {
      steps.push(
        buildProposalStep({
          ref,
          proposal: proposalsById.get(ref.replace(/^proposal:/, '')),
          now: input.now,
        }),
      );
      continue;
    }
    if (kind === 'mission') {
      steps.push(buildMissionStep({ ref, mission: input.mission, now: input.now }));
      continue;
    }
    steps.push(buildGenericStep({ ref, kind, now: input.now }));
  }

  return steps;
}

function isSubstantiveEvidenceStep(step: AoiDeliberationEvidenceStep): boolean {
  return !(
    step.kind === 'opportunity' ||
    (step.kind === 'unknown' && step.status !== 'observed') ||
    step.sourceRef.startsWith('generated_by:') ||
    step.sourceRef.startsWith('curiosity_engine:')
  );
}

function buildPhaseHistory(params: {
  phase: AoiDeliberationPhase;
  now: number;
  evidenceRefs: readonly string[];
  reason: string;
}): AoiDeliberationPhaseTransition[] {
  const phases: AoiDeliberationPhase[] = [
    'queued',
    'planning',
    'observing',
    'summarizing',
    params.phase,
  ];
  const history: AoiDeliberationPhaseTransition[] = [];
  let previous: AoiDeliberationPhase | undefined;
  for (const phase of phases) {
    history.push({
      ...(previous ? { from: previous } : {}),
      to: phase,
      reason: phase === params.phase ? params.reason : `Deliberation entered ${phase}.`,
      createdAt: params.now,
      evidenceRefs: uniqueStrings(params.evidenceRefs, 8),
    });
    previous = phase;
  }
  return history;
}

function buildFinding(params: {
  phase: AoiDeliberationPhase;
  now: number;
  opportunity: AoiOpportunity;
  evidenceSteps: readonly AoiDeliberationEvidenceStep[];
  substantiveSteps: readonly AoiDeliberationEvidenceStep[];
  blockers: readonly string[];
}): AoiDeliberationFinding | undefined {
  if (params.substantiveSteps.length === 0 && params.phase === 'failed') {
    return undefined;
  }
  const observed = params.substantiveSteps.filter((step) => step.status === 'observed');
  const sourceQuality =
    observed.length >= 2
      ? 'strong'
      : observed.length === 1
        ? 'acceptable'
        : params.substantiveSteps.length > 0
          ? 'weak'
          : 'missing';
  const freshness: AoiSignalFreshness =
    params.blockers.some((item) => /failed/i.test(item)) || params.phase === 'failed'
      ? 'failed'
      : params.blockers.some((item) => /stale/i.test(item))
        ? 'stale'
        : observed.length > 0
          ? 'fresh'
          : 'unknown';
  const evidenceRefs = uniqueStrings(
    params.evidenceSteps.flatMap((step) => step.evidenceRefs),
    24,
  );
  return {
    version: 1,
    summary:
      observed.length > 0
        ? `Aoi found ${observed.length} usable local evidence source(s) for "${params.opportunity.title}".`
        : `Aoi could not establish a usable evidence base for "${params.opportunity.title}".`,
    sourceQuality,
    freshness,
    confidence: sourceQuality === 'strong' ? 0.82 : sourceQuality === 'acceptable' ? 0.68 : 0.32,
    evidenceRefs,
    blockers: uniqueStrings(params.blockers, 12),
    cannotKnow: uniqueStrings(
      params.evidenceSteps.flatMap((step) => step.cannotKnow),
      12,
    ),
    createdAt: params.now,
  };
}

function buildOpinion(params: {
  phase: AoiDeliberationPhase;
  now: number;
  opportunity: AoiOpportunity;
  finding: AoiDeliberationFinding | undefined;
}): AoiDeliberationOpinion | undefined {
  const finding = params.finding;
  if (
    params.phase === 'failed' ||
    !finding ||
    finding.evidenceRefs.length === 0 ||
    finding.sourceQuality === 'missing'
  ) {
    return undefined;
  }
  if (params.phase === 'ready') {
    return {
      version: 1,
      stance: 'ready_to_brief',
      summary: `Aoi can brief this opportunity safely as read-only evidence.`,
      reason: `The finding has ${finding.sourceQuality} source quality and no blocking freshness issue.`,
      evidenceRefs: finding.evidenceRefs,
      createdAt: params.now,
    };
  }
  return {
    version: 1,
    stance: 'abstain',
    summary: 'Aoi should abstain from recommendations beyond a dashboard note.',
    reason:
      finding.blockers[0] ||
      `Evidence for "${params.opportunity.title}" is incomplete or stale, so no action should be prepared.`,
    evidenceRefs: finding.evidenceRefs,
    createdAt: params.now,
  };
}

export function buildAoiDeliberationRun(input: AoiDeliberationRunBuildInput): AoiDeliberationRun {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? Date.now();
  const evidencePlan = buildEvidencePlan({ ...input, sessionPath, now });
  const substantiveSteps = evidencePlan.filter(isSubstantiveEvidenceStep);
  const observed = substantiveSteps.filter((step) => step.status === 'observed');
  const staleOrBlocked = substantiveSteps.filter(
    (step) => step.status === 'stale' || step.status === 'blocked',
  );
  const missing = substantiveSteps.filter((step) => step.status === 'missing');
  const blockers = uniqueStrings(
    [
      ...evidencePlan.flatMap((step) => step.blockers),
      ...(substantiveSteps.length === 0 ? ['no resolvable evidence source'] : []),
      ...(observed.length === 0 && missing.length > 0 ? ['all evidence sources are missing'] : []),
    ],
    16,
  );
  const phase: AoiDeliberationPhase =
    substantiveSteps.length === 0 || (observed.length === 0 && missing.length > 0)
      ? 'failed'
      : staleOrBlocked.length > 0 || blockers.length > 0
        ? 'blocked'
        : 'ready';
  const evidenceRefs = uniqueStrings(
    [`opportunity:${input.opportunity.id}`, ...evidencePlan.flatMap((step) => step.evidenceRefs)],
    24,
  );
  const finding = buildFinding({
    phase,
    now,
    opportunity: input.opportunity,
    evidenceSteps: evidencePlan,
    substantiveSteps,
    blockers,
  });
  const opinion = buildOpinion({ phase, now, opportunity: input.opportunity, finding });
  const phaseReason =
    phase === 'ready'
      ? 'Evidence is usable for a display-only finding.'
      : phase === 'blocked'
        ? blockers[0] || 'Evidence exists but cannot support a confident recommendation.'
        : 'No resolvable evidence source exists.';
  return {
    version: 1,
    id: createAoiAutonomyId('aoi-delib-run', now),
    sessionPath,
    opportunityId: input.opportunity.id,
    opportunityDedupeKey: input.opportunity.dedupeKey,
    opportunityTitle: input.opportunity.title,
    phase,
    selectedAt: now,
    updatedAt: now,
    evidencePlan,
    ...(finding ? { finding } : {}),
    ...(opinion ? { opinion } : {}),
    safeNextAction:
      phase === 'ready'
        ? `Show the finding in the dashboard and ask before converting it to a proposal or research run.`
        : phase === 'blocked'
          ? `Keep this display-only and refresh or supply the missing evidence before any next step.`
          : `Do not act on this opportunity; request a valid evidence source first.`,
    blockers,
    evidenceRefs,
    artifactRefs: [`deliberation_run:${input.opportunity.id}:${now}`],
    phaseHistory: buildPhaseHistory({
      phase,
      now,
      evidenceRefs,
      reason: phaseReason,
    }),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function loadAoiDeliberationRuns(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiDeliberationRun[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiDeliberationRunPaths(sessionsDir, normalizedSessionPath);
  const parsed = readJson<unknown>(paths.runsFile);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map((item) => normalizeDeliberationRun(item, normalizedSessionPath, now))
    .filter((item): item is AoiDeliberationRun => item !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_DELIBERATION_RUNS);
}

export function saveAoiDeliberationRuns(
  sessionsDir: string,
  sessionPath: string,
  runs: readonly AoiDeliberationRun[],
): AoiDeliberationRun[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiDeliberationRunPaths(sessionsDir, normalizedSessionPath);
  const normalized = runs
    .map((run) => normalizeDeliberationRun(run, normalizedSessionPath, run.updatedAt))
    .filter((run): run is AoiDeliberationRun => run !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_DELIBERATION_RUNS);
  writeJsonAtomic(paths.root, paths.runsFile, normalized);
  return normalized;
}

export function appendAoiDeliberationRun(
  sessionsDir: string,
  sessionPath: string,
  run: AoiDeliberationRun,
): AoiDeliberationRun[] {
  const existing = loadAoiDeliberationRuns(sessionsDir, sessionPath, run.updatedAt);
  const saved = saveAoiDeliberationRuns(sessionsDir, sessionPath, [run, ...existing]);
  const savedRun = saved.find((item) => item.id === run.id) ?? run;
  const followThroughEvent = buildAoiFollowThroughEventFromDeliberationRun(
    savedRun,
    savedRun.updatedAt,
  );
  if (followThroughEvent) {
    try {
      appendAoiFollowThroughEvent(sessionsDir, followThroughEvent, savedRun.updatedAt);
    } catch {
      // Follow-through learning must not block deliberation run persistence.
    }
  }
  return saved;
}

export function loadLatestAoiDeliberationRun(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiDeliberationRun | null {
  return loadAoiDeliberationRuns(sessionsDir, sessionPath, now)[0] ?? null;
}

function selectOpportunityForDeliberation(params: {
  opportunities: readonly AoiOpportunity[];
  runs: readonly AoiDeliberationRun[];
  now: number;
  opportunityId?: string;
  force?: boolean;
  recentRunCooldownMs: number;
}): AoiOpportunity | null {
  const candidates = params.opportunities
    .filter(
      (opportunity) =>
        opportunity.actionAuthority === 'display_only' &&
        (opportunity.status === 'active' || opportunity.status === 'snoozed') &&
        opportunity.expiresAt > params.now,
    )
    .sort(
      (left, right) =>
        right.urgency - left.urgency ||
        right.confidence - left.confidence ||
        right.updatedAt - left.updatedAt,
    );
  if (params.opportunityId) {
    return candidates.find((opportunity) => opportunity.id === params.opportunityId) ?? null;
  }
  for (const opportunity of candidates) {
    const recent = params.runs.find(
      (run) =>
        run.opportunityId === opportunity.id &&
        params.now - run.updatedAt < params.recentRunCooldownMs,
    );
    if (params.force || !recent) {
      return opportunity;
    }
  }
  return null;
}

export function runAoiDeliberationForSession(
  input: AoiDeliberationRunForSessionInput,
): AoiDeliberationRunForSessionResult {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? Date.now();
  const existingRuns = loadAoiDeliberationRuns(input.sessionsDir, sessionPath, now);
  const opportunities = loadAoiActiveOpportunities(input.sessionsDir, sessionPath, now);
  const opportunity = selectOpportunityForDeliberation({
    opportunities,
    runs: existingRuns,
    now,
    opportunityId: input.opportunityId,
    force: input.force,
    recentRunCooldownMs: input.recentRunCooldownMs ?? DEFAULT_RECENT_RUN_COOLDOWN_MS,
  });
  if (!opportunity) {
    return {
      sessionPath,
      run: null,
      created: false,
      skippedReason:
        opportunities.length > 0 ? 'recent_deliberation_exists' : 'no_active_opportunity',
      runs: existingRuns,
    };
  }
  const memories =
    input.memories ??
    loadServerAoiMemories(input.sessionsDir).filter(
      (memory) =>
        memory.status === 'active' && (!memory.sessionPath || memory.sessionPath === sessionPath),
    );
  const researchRuns =
    input.researchRuns ?? listAoiResearchRunSummaries(input.sessionsDir, sessionPath);
  const workspaceSnapshot =
    input.workspaceSnapshot === undefined
      ? loadAoiWorkspaceSnapshot(input.sessionsDir, sessionPath, now)
      : input.workspaceSnapshot;
  const activeProposals =
    input.activeProposals ?? loadAoiActiveProposals(input.sessionsDir, sessionPath);
  const mission =
    input.mission === undefined
      ? loadAoiMissionState(input.sessionsDir, sessionPath)
      : input.mission;
  const run = buildAoiDeliberationRun({
    sessionPath,
    opportunity,
    now,
    memories,
    researchRuns,
    workspaceSnapshot,
    activeProposals,
    mission,
  });
  const runs = appendAoiDeliberationRun(input.sessionsDir, sessionPath, run);
  return {
    sessionPath,
    run,
    created: true,
    runs,
  };
}
