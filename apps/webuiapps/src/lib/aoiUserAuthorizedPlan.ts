import { createHash } from 'crypto';
import * as fs from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { recordAoiProposalCreatedRelations } from './aoiAutonomyRelations';
import { buildAoiGoalProposalFromUserMessage } from './aoiAutonomyGoals';
import { createAoiObservation, ingestAoiObservation } from './aoiAutonomyObserver';
import {
  createAoiAutonomyId,
  loadAoiActiveProposals,
  loadAoiArchivedProposals,
  loadAoiObservations,
  normalizeAoiAutonomySessionPath,
  saveAoiActiveProposals,
} from './aoiAutonomyStore';
import { recordAoiProposalCreatedTimelineEvent } from './aoiOperatorTimeline';
import type { AoiObservation, AoiProposal } from './aoiAutonomyTypes';
import type { AoiResearchLanguage, AoiResearchMode, AoiResearchRecency } from './aoiResearchTypes';

const MAX_AUTHORIZED_FILE_BYTES = 256 * 1024;
const MAX_GOAL_TITLE_CHARS = 160;
const MAX_RESEARCH_REQUEST_CHARS = 2_000;

export interface AoiUserAuthorizedPlanInput {
  sessionsDir: string;
  sessionPath: string;
  workspaceRoot: string;
  goalTitle: string;
  filePath: string;
  fileContent: string;
  researchRequest: string;
  researchMode?: AoiResearchMode;
  researchLanguage?: AoiResearchLanguage;
  researchRecency?: AoiResearchRecency;
  researchMaxSources?: number;
  now?: number;
}

export interface AoiUserAuthorizedPlanProposalRef {
  id: string;
  status: AoiProposal['status'];
  created: boolean;
}

export interface AoiUserAuthorizedPlanResult {
  version: 1;
  sessionPath: string;
  observationRef: string;
  authorizationFingerprint: string;
  filePath: string;
  fileContentSha256: string;
  goal: AoiUserAuthorizedPlanProposalRef;
  file: AoiUserAuthorizedPlanProposalRef;
  research: AoiUserAuthorizedPlanProposalRef;
  warnings: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

interface NormalizedAoiUserAuthorizedPlanInput {
  sessionsDir: string;
  sessionPath: string;
  workspaceRoot: string;
  goalTitle: string;
  filePath: string;
  fileContent: string;
  fileContentSha256: string;
  expectedBeforeSha256: string | 'absent';
  researchRequest: string;
  researchMode: AoiResearchMode;
  researchLanguage: AoiResearchLanguage;
  researchRecency: AoiResearchRecency;
  researchMaxSources: number;
  now: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isPathInsideRoot(root: string, target: string): boolean {
  const diff = relative(resolve(root), resolve(target));
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function normalizeRelativeFilePath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized || isAbsolute(value) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error('filePath must be a workspace-relative path.');
  }
  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\0') ||
        segment.includes(':'),
    )
  ) {
    throw new Error('filePath contains an invalid or traversal segment.');
  }
  return segments.join('/');
}

function findNearestExistingPath(targetPath: string, rootPath: string): string {
  let current = targetPath;
  while (!fs.existsSync(current)) {
    const parent = dirname(current);
    if (parent === current || !isPathInsideRoot(rootPath, parent)) {
      throw new Error('Unable to resolve an existing parent for filePath.');
    }
    current = parent;
  }
  return current;
}

function validateCanonicalWorkspaceTarget(workspaceRoot: string, filePath: string): string {
  if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
    throw new Error('workspaceRoot must be an existing directory.');
  }
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedTarget = resolve(resolvedRoot, filePath);
  if (!isPathInsideRoot(resolvedRoot, resolvedTarget)) {
    throw new Error('Resolved filePath escaped workspaceRoot.');
  }

  const canonicalRoot = fs.realpathSync(resolvedRoot);
  const existingPath = findNearestExistingPath(resolvedTarget, resolvedRoot);
  const canonicalExistingPath = fs.realpathSync(existingPath);
  if (!isPathInsideRoot(canonicalRoot, canonicalExistingPath)) {
    throw new Error('filePath resolves through a link outside workspaceRoot.');
  }
  if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()) {
    throw new Error('filePath resolves to a directory.');
  }
  return resolvedTarget;
}

function normalizeInput(input: AoiUserAuthorizedPlanInput): NormalizedAoiUserAuthorizedPlanInput {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsDir = resolve(input.sessionsDir);
  if (!fs.existsSync(sessionsDir) || !fs.statSync(sessionsDir).isDirectory()) {
    throw new Error('sessionsDir must be an existing directory.');
  }
  const workspaceRoot = resolve(input.workspaceRoot);
  const filePath = normalizeRelativeFilePath(input.filePath);
  const resolvedTarget = validateCanonicalWorkspaceTarget(workspaceRoot, filePath);

  const goalTitle = input.goalTitle.replace(/\s+/g, ' ').trim();
  if (!goalTitle || goalTitle.length > MAX_GOAL_TITLE_CHARS) {
    throw new Error(`goalTitle must be 1-${MAX_GOAL_TITLE_CHARS} characters.`);
  }
  if (
    !input.fileContent ||
    Buffer.byteLength(input.fileContent, 'utf8') > MAX_AUTHORIZED_FILE_BYTES
  ) {
    throw new Error(`fileContent must be 1-${MAX_AUTHORIZED_FILE_BYTES} UTF-8 bytes.`);
  }
  const researchRequest = input.researchRequest.replace(/\s+/g, ' ').trim();
  if (!researchRequest || researchRequest.length > MAX_RESEARCH_REQUEST_CHARS) {
    throw new Error(`researchRequest must be 1-${MAX_RESEARCH_REQUEST_CHARS} characters.`);
  }

  return {
    sessionsDir,
    sessionPath,
    workspaceRoot,
    goalTitle,
    filePath,
    fileContent: input.fileContent,
    fileContentSha256: sha256(input.fileContent),
    expectedBeforeSha256: fs.existsSync(resolvedTarget)
      ? createHash('sha256').update(fs.readFileSync(resolvedTarget)).digest('hex')
      : 'absent',
    researchRequest,
    researchMode: input.researchMode ?? 'standard',
    researchLanguage: input.researchLanguage ?? 'ko',
    researchRecency: input.researchRecency ?? 'year',
    researchMaxSources: Math.max(1, Math.min(input.researchMaxSources ?? 8, 12)),
    now: input.now ?? Date.now(),
  };
}

function buildAuthorizationFingerprint(input: NormalizedAoiUserAuthorizedPlanInput): string {
  return sha256(
    JSON.stringify({
      sessionPath: input.sessionPath,
      workspaceRoot: input.workspaceRoot.toLowerCase(),
      goalTitle: input.goalTitle,
      filePath: input.filePath,
      fileContentSha256: input.fileContentSha256,
      expectedBeforeSha256: input.expectedBeforeSha256,
      researchRequest: input.researchRequest,
      researchMode: input.researchMode,
      researchLanguage: input.researchLanguage,
      researchRecency: input.researchRecency,
      researchMaxSources: input.researchMaxSources,
    }),
  );
}

function makeFileProposal(params: {
  input: NormalizedAoiUserAuthorizedPlanInput;
  observationRef: string;
  authorizationFingerprint: string;
}): AoiProposal {
  const shortFingerprint = params.authorizationFingerprint.slice(0, 24);
  return {
    version: 1,
    id: createAoiAutonomyId('aoi-proposal-user-file', params.input.now),
    sessionPath: params.input.sessionPath,
    status: 'active',
    title: 'Execute the exact user-authorized live-field file write',
    body: `Write the approved content to ${params.input.filePath} through the L5 file mutation runner.`,
    reason:
      'The operator explicitly authorized this exact path and content for live-field validation.',
    trigger: 'user_authorized_file_write',
    createdAt: params.input.now,
    updatedAt: params.input.now,
    cooldownKey: `user-authorized-file:${shortFingerprint}`,
    confidence: 1,
    risk: 'high',
    requiredAutonomyLevel: 'L5',
    requiresUserApproval: true,
    suggestedTools: ['file_write'],
    evidenceRefs: [params.observationRef],
    memoryIds: [],
    artifactRefs: [`workspace-file:${params.input.filePath}`],
    riskSignals: ['user-authorized', 'exact-content', 'checkpoint-required'],
    acceptAction: {
      kind: 'file_write',
      params: {
        path: params.input.filePath,
        content: params.input.fileContent,
        purpose: params.input.goalTitle,
        validationPlan: {
          version: 1,
          expectedBeforeSha256: params.input.expectedBeforeSha256,
          expectedAfterSha256: params.input.fileContentSha256,
        },
      },
    },
  };
}

function makeResearchProposal(params: {
  input: NormalizedAoiUserAuthorizedPlanInput;
  observationRef: string;
  authorizationFingerprint: string;
}): AoiProposal {
  const shortFingerprint = params.authorizationFingerprint.slice(0, 24);
  return {
    version: 1,
    id: createAoiAutonomyId('aoi-proposal-user-research', params.input.now),
    sessionPath: params.input.sessionPath,
    status: 'active',
    title: 'Run the user-authorized current non-voice agent research',
    body: 'Run one bounded research job and retain its manifest, sources, evidence, and report.',
    reason: 'The operator explicitly authorized one current research run for this live-field goal.',
    trigger: 'user_authorized_research',
    createdAt: params.input.now,
    updatedAt: params.input.now,
    cooldownKey: `user-authorized-research:${shortFingerprint}`,
    confidence: 1,
    risk: 'medium',
    requiredAutonomyLevel: 'L4',
    requiresUserApproval: true,
    suggestedTools: ['start_research'],
    evidenceRefs: [params.observationRef],
    memoryIds: [],
    artifactRefs: [],
    riskSignals: ['user-authorized', 'network-research', 'bounded-run'],
    acceptAction: {
      kind: 'start_research',
      params: {
        sessionPath: params.input.sessionPath,
        request: params.input.researchRequest,
        mode: params.input.researchMode,
        language: params.input.researchLanguage,
        recency: params.input.researchRecency,
        maxSources: params.input.researchMaxSources,
      },
    },
  };
}

function assertExistingProposalMatches(candidate: AoiProposal, existing: AoiProposal): void {
  if (candidate.acceptAction?.kind !== existing.acceptAction?.kind) {
    throw new Error(`Existing proposal cooldown collision for ${candidate.cooldownKey}.`);
  }
  if (candidate.acceptAction?.kind === 'file_write') {
    const candidateParams = candidate.acceptAction.params;
    const existingParams = existing.acceptAction?.params ?? {};
    if (
      candidateParams.path !== existingParams.path ||
      candidateParams.content !== existingParams.content
    ) {
      throw new Error(
        `Existing file proposal does not match authorization ${candidate.cooldownKey}.`,
      );
    }
  }
  if (candidate.acceptAction?.kind === 'start_research') {
    const candidateParams = candidate.acceptAction.params;
    const existingParams = existing.acceptAction?.params ?? {};
    if (
      candidateParams.request !== existingParams.request ||
      candidateParams.mode !== existingParams.mode ||
      candidateParams.sessionPath !== existingParams.sessionPath
    ) {
      throw new Error(
        `Existing research proposal does not match authorization ${candidate.cooldownKey}.`,
      );
    }
  }
}

export function authorAoiUserAuthorizedPlan(
  input: AoiUserAuthorizedPlanInput,
): AoiUserAuthorizedPlanResult {
  const normalized = normalizeInput(input);
  const authorizationFingerprint = buildAuthorizationFingerprint(normalized);
  const stableKey = `user-authorized-plan-${authorizationFingerprint.slice(0, 32)}`;
  const observationDraft = createAoiObservation({
    source: 'chat',
    sessionPath: normalized.sessionPath,
    stableKey,
    summary:
      `Operator authorized goal '${normalized.goalTitle}', exact file target ` +
      `${normalized.filePath} at sha256:${normalized.fileContentSha256}, and one bounded research run.`,
    createdAt: normalized.now,
    payloadRef: `user-authorization:${authorizationFingerprint}`,
    artifactRefs: [`workspace-file:${normalized.filePath}`],
    riskSignals: ['user-authorized', 'goal-approved', 'file-write-approved', 'research-approved'],
  });
  const observationRef = `observation:${observationDraft.id}`;
  const goalCandidate = buildAoiGoalProposalFromUserMessage({
    sessionPath: normalized.sessionPath,
    latestUserMessage: `목표: ${normalized.goalTitle}`,
    now: normalized.now,
    sourceRefs: [observationRef],
    lang: 'ko',
  });
  if (!goalCandidate) {
    throw new Error('Unable to build a goal proposal from the authorized goal title.');
  }
  const candidates = {
    goal: goalCandidate,
    file: makeFileProposal({ input: normalized, observationRef, authorizationFingerprint }),
    research: makeResearchProposal({ input: normalized, observationRef, authorizationFingerprint }),
  };

  const active = loadAoiActiveProposals(normalized.sessionsDir, normalized.sessionPath);
  const archived = loadAoiArchivedProposals(normalized.sessionsDir, normalized.sessionPath);
  const allExisting = [...active, ...archived];
  const selected: Record<keyof typeof candidates, { proposal: AoiProposal; created: boolean }> = {
    goal: { proposal: candidates.goal, created: true },
    file: { proposal: candidates.file, created: true },
    research: { proposal: candidates.research, created: true },
  };
  const newlyCreated: AoiProposal[] = [];
  for (const role of Object.keys(candidates) as Array<keyof typeof candidates>) {
    const candidate = candidates[role];
    const existing = allExisting.find((proposal) => proposal.cooldownKey === candidate.cooldownKey);
    if (existing) {
      assertExistingProposalMatches(candidate, existing);
      selected[role] = { proposal: existing, created: false };
    } else {
      newlyCreated.push(candidate);
    }
  }

  const existingObservation = loadAoiObservations(
    normalized.sessionsDir,
    normalized.sessionPath,
  ).find((observation) => observation.id === observationDraft.id);
  const observation: AoiObservation = {
    ...observationDraft,
    createdAt: existingObservation?.createdAt ?? observationDraft.createdAt,
    proposalIds: [
      selected.goal.proposal.id,
      selected.file.proposal.id,
      selected.research.proposal.id,
    ],
  };
  const observationResult = ingestAoiObservation(normalized.sessionsDir, observation, {
    now: normalized.now,
  });
  if (newlyCreated.length > 0) {
    saveAoiActiveProposals(normalized.sessionsDir, normalized.sessionPath, [
      ...active,
      ...newlyCreated,
    ]);
  }

  const warnings = [...observationResult.warnings];
  for (const proposal of newlyCreated) {
    try {
      recordAoiProposalCreatedRelations(normalized.sessionsDir, proposal, normalized.now);
    } catch {
      warnings.push(`proposal_relation_write_failed:${proposal.id}`);
    }
    try {
      recordAoiProposalCreatedTimelineEvent({
        sessionsDir: normalized.sessionsDir,
        proposal,
        now: normalized.now,
      });
    } catch {
      warnings.push(`proposal_timeline_write_failed:${proposal.id}`);
    }
  }

  const toRef = (value: {
    proposal: AoiProposal;
    created: boolean;
  }): AoiUserAuthorizedPlanProposalRef => ({
    id: value.proposal.id,
    status: value.proposal.status,
    created: value.created,
  });
  return {
    version: 1,
    sessionPath: normalized.sessionPath,
    observationRef,
    authorizationFingerprint,
    filePath: normalized.filePath,
    fileContentSha256: normalized.fileContentSha256,
    goal: toRef(selected.goal),
    file: toRef(selected.file),
    research: toRef(selected.research),
    warnings,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}
