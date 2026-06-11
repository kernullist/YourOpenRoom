import * as fs from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import { DEFAULT_AOI_AUTONOMY_POLICY, normalizeAoiAutonomyPolicy } from './aoiAutonomyPolicy';
import { recordAoiProposalDecisionRelations } from './aoiAutonomyRelations';
import type {
  AoiAutonomyPolicy,
  AoiAutonomyStatus,
  AoiObservation,
  AoiProposal,
  AoiProposalDecision,
  AoiProposalDecisionAction,
  AoiReflection,
} from './aoiAutonomyTypes';

const AUTONOMY_ROOT_DIR = 'aoi-autonomy';
const MAX_LIST_ITEMS = 200;

export interface AoiAutonomyPaths {
  root: string;
  policy: string;
  observationsDir: string;
  reflectionsDir: string;
  proposalsDir: string;
  activeProposals: string;
  archivedProposals: string;
  decisionsDir: string;
  evalDir: string;
}

export interface AoiProposalDecisionInput {
  proposalId: string;
  action: Extract<AoiProposalDecisionAction, 'accept' | 'dismiss' | 'snooze'>;
  actor?: 'user' | 'system';
  reason?: string;
  snoozeMs?: number;
  now?: number;
}

export interface AoiProposalExecutionTransitionInput {
  proposalId: string;
  nextStatus: Extract<AoiProposal['status'], 'executed' | 'blocked'>;
  actor?: 'user' | 'system';
  reason?: string;
  now?: number;
}

export interface AoiProposalDecisionResult {
  proposal: AoiProposal;
  decision: AoiProposalDecision;
  activeProposals: AoiProposal[];
  archivedProposals: AoiProposal[];
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

function writeJsonAtomic(filePath: string, value: unknown): void {
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

function listJsonFiles<T>(directory: string): T[] {
  try {
    if (!fs.existsSync(directory)) {
      return [];
    }
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readJson<T>(join(directory, entry.name)))
      .filter((item): item is T => item !== null)
      .slice(0, MAX_LIST_ITEMS);
  } catch {
    return [];
  }
}

export function normalizeAoiAutonomySessionPath(value: unknown): string | null {
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

export function isValidAoiAutonomyId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$/.test(value);
}

export function createAoiAutonomyId(prefix: string, now = Date.now()): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'aoi';
  return `${safePrefix}-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function resolveAoiAutonomyPaths(
  sessionsDir: string,
  sessionPath: string,
): AoiAutonomyPaths {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsRoot = resolve(sessionsDir);
  const root = resolve(sessionsRoot, normalizedSessionPath, AUTONOMY_ROOT_DIR);
  if (!isPathInsideRoot(sessionsRoot, root)) {
    throw new Error('Resolved Aoi autonomy path escaped the sessions directory.');
  }
  const proposalsDir = join(root, 'proposals');
  return {
    root,
    policy: join(root, 'policy.json'),
    observationsDir: join(root, 'observations'),
    reflectionsDir: join(root, 'reflections'),
    proposalsDir,
    activeProposals: join(proposalsDir, 'active.json'),
    archivedProposals: join(proposalsDir, 'archived.json'),
    decisionsDir: join(root, 'decisions'),
    evalDir: join(root, 'eval'),
  };
}

export function loadAoiAutonomyPolicy(sessionsDir: string, sessionPath: string): AoiAutonomyPolicy {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return normalizeAoiAutonomyPolicy(
    readJson<Partial<AoiAutonomyPolicy>>(paths.policy),
    DEFAULT_AOI_AUTONOMY_POLICY,
    readJson<Partial<AoiAutonomyPolicy>>(paths.policy)?.updatedAt || 0,
  );
}

export function saveAoiAutonomyPolicy(
  sessionsDir: string,
  sessionPath: string,
  policy: unknown,
  now = Date.now(),
): AoiAutonomyPolicy {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const current = loadAoiAutonomyPolicy(sessionsDir, sessionPath);
  const normalized = normalizeAoiAutonomyPolicy(policy, current, now);
  writeJsonAtomic(paths.policy, normalized);
  return normalized;
}

function normalizeRecordSessionPath<T extends { sessionPath: string }>(record: T): T {
  const sessionPath = normalizeAoiAutonomySessionPath(record.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  return {
    ...record,
    sessionPath,
  };
}

export function appendAoiObservation(
  sessionsDir: string,
  observation: AoiObservation,
): AoiObservation {
  const item = normalizeRecordSessionPath(observation);
  if (!isValidAoiAutonomyId(item.id)) {
    throw new Error('Invalid observation id.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, item.sessionPath);
  writeJsonAtomic(join(paths.observationsDir, `${item.id}.json`), item);
  return item;
}

export function loadAoiObservations(sessionsDir: string, sessionPath: string): AoiObservation[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return listJsonFiles<AoiObservation>(paths.observationsDir)
    .filter((item) => item.version === 1 && isValidAoiAutonomyId(item.id))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function appendAoiReflection(sessionsDir: string, reflection: AoiReflection): AoiReflection {
  const item = normalizeRecordSessionPath(reflection);
  if (!isValidAoiAutonomyId(item.id)) {
    throw new Error('Invalid reflection id.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, item.sessionPath);
  writeJsonAtomic(join(paths.reflectionsDir, `${item.id}.json`), item);
  return item;
}

export function loadAoiReflections(sessionsDir: string, sessionPath: string): AoiReflection[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return listJsonFiles<AoiReflection>(paths.reflectionsDir)
    .filter((item) => item.version === 1 && isValidAoiAutonomyId(item.id))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function loadProposalList(filePath: string): AoiProposal[] {
  const parsed = readJson<unknown>(filePath);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter(
      (item): item is AoiProposal =>
        item &&
        typeof item === 'object' &&
        (item as AoiProposal).version === 1 &&
        isValidAoiAutonomyId((item as AoiProposal).id),
    )
    .slice(0, MAX_LIST_ITEMS);
}

export function loadAoiActiveProposals(sessionsDir: string, sessionPath: string): AoiProposal[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return loadProposalList(paths.activeProposals);
}

export function loadAoiArchivedProposals(sessionsDir: string, sessionPath: string): AoiProposal[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return loadProposalList(paths.archivedProposals);
}

export function saveAoiActiveProposals(
  sessionsDir: string,
  sessionPath: string,
  proposals: AoiProposal[],
): AoiProposal[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const normalized = proposals.map(normalizeRecordSessionPath);
  writeJsonAtomic(paths.activeProposals, normalized);
  return normalized;
}

export function saveAoiArchivedProposals(
  sessionsDir: string,
  sessionPath: string,
  proposals: AoiProposal[],
): AoiProposal[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const normalized = proposals.map(normalizeRecordSessionPath);
  writeJsonAtomic(paths.archivedProposals, normalized);
  return normalized;
}

export function appendAoiProposalDecision(
  sessionsDir: string,
  decision: AoiProposalDecision,
): AoiProposalDecision {
  const item = normalizeRecordSessionPath(decision);
  if (!isValidAoiAutonomyId(item.id)) {
    throw new Error('Invalid decision id.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, item.sessionPath);
  writeJsonAtomic(join(paths.decisionsDir, `${item.id}.json`), item);
  return item;
}

export function loadAoiProposalDecisions(
  sessionsDir: string,
  sessionPath: string,
): AoiProposalDecision[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return listJsonFiles<AoiProposalDecision>(paths.decisionsDir)
    .filter((item) => item.version === 1 && isValidAoiAutonomyId(item.id))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function applyAoiProposalDecision(
  sessionsDir: string,
  sessionPath: string,
  input: AoiProposalDecisionInput,
): AoiProposalDecisionResult {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  if (!isValidAoiAutonomyId(input.proposalId)) {
    throw new Error('Invalid or missing proposalId.');
  }
  if (input.action !== 'accept' && input.action !== 'dismiss' && input.action !== 'snooze') {
    throw new Error('Invalid proposal decision action.');
  }
  const now = input.now ?? Date.now();
  const policy = loadAoiAutonomyPolicy(sessionsDir, normalizedSessionPath);
  const activeProposals = loadAoiActiveProposals(sessionsDir, normalizedSessionPath);
  const archivedProposals = loadAoiArchivedProposals(sessionsDir, normalizedSessionPath);
  const index = activeProposals.findIndex((proposal) => proposal.id === input.proposalId);
  if (index < 0) {
    throw new Error('Aoi proposal not found.');
  }
  const current = activeProposals[index];
  if (current.status !== 'active' && current.status !== 'snoozed') {
    throw new Error(`Cannot ${input.action} proposal while status is ${current.status}.`);
  }
  const nextStatus =
    input.action === 'accept' ? 'accepted' : input.action === 'snooze' ? 'snoozed' : 'dismissed';
  const snoozedUntil =
    input.action === 'snooze'
      ? now + (input.snoozeMs && input.snoozeMs > 0 ? input.snoozeMs : policy.defaultSnoozeMs)
      : undefined;
  const nextProposal: AoiProposal = {
    ...current,
    status: nextStatus,
    updatedAt: now,
    ...(snoozedUntil ? { snoozedUntil } : {}),
  };
  const decision: AoiProposalDecision = {
    version: 1,
    id: createAoiAutonomyId('aoi-decision', now),
    proposalId: current.id,
    sessionPath: normalizedSessionPath,
    cooldownKey: current.cooldownKey,
    action: input.action,
    actor: input.actor ?? 'user',
    createdAt: now,
    previousStatus: current.status,
    nextStatus,
    ...(typeof input.reason === 'string' && input.reason.trim()
      ? { reason: input.reason.trim().slice(0, 240) }
      : {}),
    ...(snoozedUntil ? { snoozedUntil } : {}),
  };

  let nextActive = [...activeProposals];
  let nextArchived = [...archivedProposals];
  if (nextStatus === 'dismissed') {
    nextActive = activeProposals.filter((proposal) => proposal.id !== current.id);
    nextArchived = [nextProposal, ...nextArchived.filter((proposal) => proposal.id !== current.id)];
  } else {
    nextActive[index] = nextProposal;
  }
  saveAoiActiveProposals(sessionsDir, normalizedSessionPath, nextActive);
  saveAoiArchivedProposals(sessionsDir, normalizedSessionPath, nextArchived);
  appendAoiProposalDecision(sessionsDir, decision);
  recordAoiProposalDecisionRelations(
    sessionsDir,
    normalizedSessionPath,
    nextProposal,
    decision,
    now,
  );
  return {
    proposal: nextProposal,
    decision,
    activeProposals: nextActive,
    archivedProposals: nextArchived,
  };
}

export function applyAoiProposalExecutionTransition(
  sessionsDir: string,
  sessionPath: string,
  input: AoiProposalExecutionTransitionInput,
): AoiProposalDecisionResult {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  if (!isValidAoiAutonomyId(input.proposalId)) {
    throw new Error('Invalid or missing proposalId.');
  }
  if (input.nextStatus !== 'executed' && input.nextStatus !== 'blocked') {
    throw new Error('Invalid proposal execution status.');
  }

  const now = input.now ?? Date.now();
  const activeProposals = loadAoiActiveProposals(sessionsDir, normalizedSessionPath);
  const archivedProposals = loadAoiArchivedProposals(sessionsDir, normalizedSessionPath);
  const index = activeProposals.findIndex((proposal) => proposal.id === input.proposalId);
  if (index < 0) {
    throw new Error('Aoi proposal not found.');
  }

  const current = activeProposals[index];
  const nextProposal: AoiProposal = {
    ...current,
    status: input.nextStatus,
    updatedAt: now,
    ...(input.nextStatus === 'blocked' && input.reason
      ? { blockedReason: input.reason.trim().slice(0, 240) }
      : {}),
  };
  const decision: AoiProposalDecision = {
    version: 1,
    id: createAoiAutonomyId('aoi-decision', now),
    proposalId: current.id,
    sessionPath: normalizedSessionPath,
    cooldownKey: current.cooldownKey,
    action: input.nextStatus === 'executed' ? 'execute' : 'block',
    actor: input.actor ?? 'system',
    createdAt: now,
    previousStatus: current.status,
    nextStatus: input.nextStatus,
    ...(typeof input.reason === 'string' && input.reason.trim()
      ? { reason: input.reason.trim().slice(0, 240) }
      : {}),
  };
  const nextActive = [...activeProposals];
  nextActive[index] = nextProposal;
  saveAoiActiveProposals(sessionsDir, normalizedSessionPath, nextActive);
  appendAoiProposalDecision(sessionsDir, decision);
  recordAoiProposalDecisionRelations(
    sessionsDir,
    normalizedSessionPath,
    nextProposal,
    decision,
    now,
  );

  return {
    proposal: nextProposal,
    decision,
    activeProposals: nextActive,
    archivedProposals,
  };
}

export function buildAoiAutonomyStatus(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiAutonomyStatus {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const policy = loadAoiAutonomyPolicy(sessionsDir, normalizedSessionPath);
  const activeProposals = loadAoiActiveProposals(sessionsDir, normalizedSessionPath);
  const archivedProposals = loadAoiArchivedProposals(sessionsDir, normalizedSessionPath);
  const observations = loadAoiObservations(sessionsDir, normalizedSessionPath);
  const reflections = loadAoiReflections(sessionsDir, normalizedSessionPath);
  const decisions = loadAoiProposalDecisions(sessionsDir, normalizedSessionPath);
  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    policy,
    activeProposalCount: activeProposals.filter((proposal) => proposal.status === 'active').length,
    archivedProposalCount: archivedProposals.length,
    acceptedProposalCount: activeProposals.filter((proposal) => proposal.status === 'accepted')
      .length,
    snoozedProposalCount: activeProposals.filter((proposal) => proposal.status === 'snoozed')
      .length,
    blockedProposalCount: [...activeProposals, ...archivedProposals].filter(
      (proposal) => proposal.status === 'blocked',
    ).length,
    observationCount: observations.length,
    reflectionCount: reflections.length,
    decisionCount: decisions.length,
    lastDecisionAt: decisions[0]?.createdAt,
    lastObservationAt: observations[0]?.createdAt,
    lastReflectionAt: reflections[0]?.createdAt,
    updatedAt: now,
  };
}
