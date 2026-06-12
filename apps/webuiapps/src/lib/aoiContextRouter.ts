import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { getAppRecognitionEntries } from './appRegistry';
import {
  checkAoiEnvironmentSourceOperation,
  isAoiProposalFeedbackCategory,
} from './aoiAutonomyPolicy';
import { deriveAoiMissionState } from './aoiAutonomyMission';
import {
  loadAoiEnvironmentSourceRegistry,
  loadAoiProposalDecisions,
  normalizeAoiAutonomySessionPath,
  resolveAoiAutonomyPaths,
} from './aoiAutonomyStore';
import { loadAoiWorkspaceSnapshot } from './aoiWorkspaceSignals';
import { loadServerAoiMemories } from './aoiMemoryServerWriter';
import { listAoiResearchRunSummaries } from './aoiResearchPlugin';
import type { AoiMemoryEntry } from './aoiMemoryShared';
import type {
  AoiBrowserContextMetadata,
  AoiContextRouterResult,
  AoiContextSourceFeedback,
  AoiContextSourceKind,
  AoiContextSourceSummary,
  AoiEnvironmentSourceKind,
  AoiEnvironmentSourceRegistry,
  AoiMissionState,
  AoiProposalDecision,
  AoiProposalFeedbackCategory,
  AoiSignalFreshness,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';
import type { AoiResearchRunSummary } from './aoiResearchTypes';

const BROWSER_CONTEXT_FILE = 'browser-context.json';
const CONTEXT_FEEDBACK_FILE = 'context-feedback.json';
const MAX_BROWSER_CONTEXTS = 20;
const MAX_CONTEXT_FEEDBACK = 160;
const MAX_PROMPT_SOURCES = 3;
const MAX_PROMPT_CHARS = 1200;
const MAX_SUMMARY_CHARS = 260;
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

const SOURCE_ID_BY_KIND: Record<AoiEnvironmentSourceKind, string> = {
  workspace_git: 'workspace-git',
  workspace_build: 'workspace-build',
  kira_board: 'kira-board',
  research_runs: 'research-runs',
  app_state: 'app-state',
  browser_context: 'browser-context',
  manual_note: 'manual-note',
};

const NEGATIVE_FEEDBACK = new Set<AoiProposalFeedbackCategory>([
  'not_useful',
  'wrong_evidence',
  'stale',
  'too_frequent',
  'too_much',
  'wrong_timing',
  'unsafe',
  'already_done',
]);

const CONTEXT_FEEDBACK_CATEGORIES = new Set<AoiProposalFeedbackCategory>([
  'wrong_evidence',
  'wrong_timing',
  'stale',
  'not_useful',
  'too_much',
]);

export interface AoiContextRouterInput {
  sessionsDir: string;
  sessionPath: string;
  latestUserMessage?: string;
  registry?: AoiEnvironmentSourceRegistry | null;
  mission?: AoiMissionState | null;
  memories?: AoiMemoryEntry[];
  workspaceSnapshot?: AoiWorkspaceSnapshot | null;
  now?: number;
  maxPromptSources?: number;
  maxPromptChars?: number;
}

export interface AoiBrowserContextMetadataRecordInput {
  sessionsDir: string;
  sessionPath: string;
  pageTitle: string;
  url: string;
  purpose?: string;
  capturedAt?: number;
  now?: number;
}

export interface AoiContextSourceFeedbackInput {
  sessionsDir: string;
  sessionPath: string;
  sourceId: string;
  contextSummaryId?: string;
  feedbackCategory: AoiProposalFeedbackCategory;
  feedbackNote?: string;
  evidenceRefs?: string[];
  now?: number;
}

export interface AoiContextUrlSanitizationResult {
  urlHost: string;
  redactedUrl: string;
  redactionState: 'none' | 'redacted';
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
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

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function resolveContextFile(sessionsDir: string, sessionPath: string, fileName: string): string {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const filePath = resolve(paths.root, fileName);
  if (!isPathInsideRoot(paths.root, filePath)) {
    throw new Error('Resolved Aoi context router path escaped the autonomy directory.');
  }
  return filePath;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

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

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function dedupeStrings(values: Array<string | undefined | null>, maxItems = 12): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === 'string' ? truncateText(value, 240) : '';
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function getFreshness(
  updatedAt: number | undefined,
  now: number,
  failed = false,
): AoiSignalFreshness {
  if (failed) {
    return 'failed';
  }
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    return 'unknown';
  }
  const age = Math.max(0, now - updatedAt);
  if (age <= FRESH_MS) {
    return 'fresh';
  }
  if (age >= STALE_MS) {
    return 'stale';
  }
  return 'unknown';
}

function scoreFreshness(freshness: AoiSignalFreshness): number {
  if (freshness === 'fresh') {
    return 0.08;
  }
  if (freshness === 'stale') {
    return -0.18;
  }
  if (freshness === 'failed') {
    return -0.35;
  }
  return -0.04;
}

function tokenize(value: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = value.toLowerCase();
  for (const token of normalized.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]{1,}/gu) ?? []) {
    tokens.add(token);
  }
  return tokens;
}

function overlapScore(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let matches = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      matches += 1;
    }
  }
  return clamp(matches / Math.min(leftTokens.size, Math.max(1, rightTokens.size)), 0, 1);
}

function hasIntent(value: string, pattern: RegExp): boolean {
  return pattern.test(value.toLowerCase());
}

function sourceAllowed(
  registry: AoiEnvironmentSourceRegistry | null | undefined,
  sourceId: string,
): boolean {
  return checkAoiEnvironmentSourceOperation({
    registry,
    sourceId,
    operation: 'summarize',
  }).allowed;
}

function makeSummary(params: {
  sourceId: string;
  kind: AoiContextSourceKind;
  label: string;
  summary: string;
  evidenceRefs: string[];
  relevanceScore: number;
  confidence: number;
  freshness: AoiSignalFreshness;
  scoreReasons: string[];
  updatedAt: number;
  displayName?: string;
  redactionState?: 'none' | 'redacted' | 'withheld';
  staleReason?: string;
}): AoiContextSourceSummary {
  const evidenceRefs = dedupeStrings(params.evidenceRefs, 10);
  const id = `ctx-${stableHash(
    [
      params.sourceId,
      params.kind,
      params.displayName ?? params.label,
      evidenceRefs.join('|'),
      String(params.updatedAt),
    ].join('\n'),
  )}`;
  return {
    version: 1,
    id,
    sourceId: params.sourceId,
    kind: params.kind,
    label: truncateText(params.label, 120),
    ...(params.displayName ? { displayName: truncateText(params.displayName, 96) } : {}),
    relevanceScore: clamp(Number(params.relevanceScore.toFixed(3)), 0, 1),
    confidence: clamp(Number(params.confidence.toFixed(3)), 0, 1),
    freshness: params.freshness,
    redactionState: params.redactionState ?? 'none',
    summary: truncateText(params.summary, MAX_SUMMARY_CHARS),
    evidenceRefs,
    scoreReasons: dedupeStrings(params.scoreReasons, 8),
    updatedAt: params.updatedAt,
    ...(params.staleReason ? { staleReason: truncateText(params.staleReason, 180) } : {}),
  };
}

function hasIntersect(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function missionRefs(mission: AoiMissionState | null | undefined): string[] {
  if (!mission) {
    return [];
  }
  return dedupeStrings([
    ...mission.evidenceRefs,
    mission.lastMeaningfulEventRef,
    mission.sourceRefs.goalRef,
    mission.sourceRefs.planStepRef,
    mission.sourceRefs.proposalRef,
    mission.sourceRefs.decisionRef,
    mission.sourceRefs.observationRef,
    mission.sourceRefs.researchRunRef,
    mission.sourceRefs.kiraWorkRef,
    mission.sourceRefs.workspaceSnapshotRef,
    mission.sourceRefs.validationRef,
  ]);
}

function applyFeedbackPenalties(params: {
  summary: AoiContextSourceSummary;
  decisions: AoiProposalDecision[];
  contextFeedback: AoiContextSourceFeedback[];
}): AoiContextSourceSummary {
  let penalty = 0;
  const reasons = [...params.summary.scoreReasons];
  for (const decision of params.decisions.slice(0, 50)) {
    if (!decision.feedbackCategory || !NEGATIVE_FEEDBACK.has(decision.feedbackCategory)) {
      continue;
    }
    const decisionRefs = dedupeStrings([
      ...(decision.evidenceRefs ?? []),
      ...(decision.memoryIds ?? []).map((id) => `memory:${id}`),
      decision.cooldownKey,
      decision.proposalId ? `proposal:${decision.proposalId}` : undefined,
    ]);
    if (hasIntersect(params.summary.evidenceRefs, decisionRefs)) {
      penalty += decision.feedbackCategory === 'wrong_evidence' ? 0.24 : 0.14;
      reasons.push(`penalized by proposal feedback:${decision.feedbackCategory}`);
    }
  }
  for (const feedback of params.contextFeedback.slice(0, 80)) {
    if (feedback.sourceId !== params.summary.sourceId) {
      continue;
    }
    if (
      feedback.contextSummaryId &&
      feedback.contextSummaryId !== params.summary.id &&
      !hasIntersect(params.summary.evidenceRefs, feedback.evidenceRefs)
    ) {
      continue;
    }
    if (feedback.feedbackCategory === 'wrong_evidence') {
      penalty += 0.34;
    } else if (
      feedback.feedbackCategory === 'wrong_timing' ||
      feedback.feedbackCategory === 'stale'
    ) {
      penalty += 0.24;
    } else {
      penalty += 0.16;
    }
    reasons.push(`penalized by context feedback:${feedback.feedbackCategory}`);
  }
  if (params.summary.confidence < 0.65) {
    penalty += 0.08;
    reasons.push('penalized by low confidence');
  }
  penalty -= scoreFreshness(params.summary.freshness);
  return {
    ...params.summary,
    relevanceScore: clamp(Number((params.summary.relevanceScore - penalty).toFixed(3)), 0, 1),
    scoreReasons: dedupeStrings(reasons, 8),
  };
}

function sanitizePathSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  if (
    /(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|client[_-]?secret|private[_-]?key)/i.test(
      decoded,
    ) ||
    /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_=-]{8,}/i.test(decoded) ||
    /^[A-Za-z0-9_-]{32,}$/.test(decoded)
  ) {
    return '[redacted]';
  }
  return segment;
}

export function sanitizeAoiContextUrl(rawUrl: string): AoiContextUrlSanitizationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      urlHost: 'unknown',
      redactedUrl: '[redacted url]',
      redactionState: 'redacted',
    };
  }
  try {
    const parsed = new URL(trimmed);
    const pathSegments = parsed.pathname
      .split('/')
      .map((segment) => (segment ? sanitizePathSegment(segment) : segment));
    const path = truncateText(pathSegments.join('/'), 180);
    const redactedUrl = `${parsed.protocol}//${parsed.host}${path}`;
    const redacted =
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      Boolean(parsed.username) ||
      Boolean(parsed.password) ||
      path.includes('[redacted]');
    return {
      urlHost: parsed.host,
      redactedUrl,
      redactionState: redacted ? 'redacted' : 'none',
    };
  } catch {
    return {
      urlHost: 'unknown',
      redactedUrl: '[redacted url]',
      redactionState: 'redacted',
    };
  }
}

function normalizeBrowserContext(
  value: unknown,
  sessionPath: string,
): AoiBrowserContextMetadata | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Partial<AoiBrowserContextMetadata>;
  if (raw.version !== 1 || typeof raw.id !== 'string' || typeof raw.capturedAt !== 'number') {
    return null;
  }
  return {
    version: 1,
    id: truncateText(raw.id, 96),
    sessionPath,
    pageTitle: truncateText(String(raw.pageTitle || 'Untitled page'), 120),
    urlHost: truncateText(String(raw.urlHost || 'unknown'), 120),
    redactedUrl: truncateText(String(raw.redactedUrl || '[redacted url]'), 220),
    purpose: truncateText(String(raw.purpose || 'Explicit user-provided page context.'), 180),
    capturedAt: raw.capturedAt,
    evidenceRefs: dedupeStrings(raw.evidenceRefs ?? [], 8),
    redactionState: raw.redactionState === 'none' ? 'none' : 'redacted',
  };
}

export function loadAoiBrowserContextMetadata(
  sessionsDir: string,
  sessionPath: string,
): AoiBrowserContextMetadata[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const filePath = resolveContextFile(sessionsDir, normalizedSessionPath, BROWSER_CONTEXT_FILE);
  const parsed = readJson<unknown[]>(filePath);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map((item) => normalizeBrowserContext(item, normalizedSessionPath))
    .filter((item): item is AoiBrowserContextMetadata => item !== null)
    .sort((left, right) => right.capturedAt - left.capturedAt)
    .slice(0, MAX_BROWSER_CONTEXTS);
}

export function recordAoiBrowserContextMetadata(
  params: AoiBrowserContextMetadataRecordInput,
): AoiBrowserContextMetadata {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  const capturedAt =
    typeof params.capturedAt === 'number' && Number.isFinite(params.capturedAt)
      ? params.capturedAt
      : now;
  const sanitized = sanitizeAoiContextUrl(params.url);
  const id = `browser-${capturedAt.toString(36)}-${randomUUID().slice(0, 8)}`;
  const item: AoiBrowserContextMetadata = {
    version: 1,
    id,
    sessionPath: normalizedSessionPath,
    pageTitle: truncateText(params.pageTitle || 'Untitled page', 120),
    urlHost: sanitized.urlHost,
    redactedUrl: sanitized.redactedUrl,
    purpose: truncateText(params.purpose || 'Explicit user-provided page context.', 180),
    capturedAt,
    evidenceRefs: [`browser:${id}`],
    redactionState: sanitized.redactionState,
  };
  const existing = loadAoiBrowserContextMetadata(params.sessionsDir, normalizedSessionPath);
  const next = [item, ...existing.filter((entry) => entry.id !== item.id)].slice(
    0,
    MAX_BROWSER_CONTEXTS,
  );
  writeJsonAtomic(
    resolveContextFile(params.sessionsDir, normalizedSessionPath, BROWSER_CONTEXT_FILE),
    next,
  );
  return item;
}

function normalizeContextFeedback(
  value: unknown,
  sessionPath: string,
): AoiContextSourceFeedback | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Partial<AoiContextSourceFeedback>;
  if (
    raw.version !== 1 ||
    typeof raw.id !== 'string' ||
    typeof raw.sourceId !== 'string' ||
    typeof raw.createdAt !== 'number' ||
    !isAoiProposalFeedbackCategory(raw.feedbackCategory)
  ) {
    return null;
  }
  return {
    version: 1,
    id: truncateText(raw.id, 96),
    sessionPath,
    sourceId: truncateText(raw.sourceId, 96),
    ...(raw.contextSummaryId ? { contextSummaryId: truncateText(raw.contextSummaryId, 96) } : {}),
    feedbackCategory: raw.feedbackCategory,
    ...(raw.feedbackNote ? { feedbackNote: truncateText(raw.feedbackNote, 180) } : {}),
    evidenceRefs: dedupeStrings(raw.evidenceRefs ?? [], 8),
    createdAt: raw.createdAt,
  };
}

export function loadAoiContextSourceFeedback(
  sessionsDir: string,
  sessionPath: string,
): AoiContextSourceFeedback[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const parsed = readJson<unknown[]>(
    resolveContextFile(sessionsDir, normalizedSessionPath, CONTEXT_FEEDBACK_FILE),
  );
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map((item) => normalizeContextFeedback(item, normalizedSessionPath))
    .filter((item): item is AoiContextSourceFeedback => item !== null)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_CONTEXT_FEEDBACK);
}

export function recordAoiContextSourceFeedback(
  params: AoiContextSourceFeedbackInput,
): AoiContextSourceFeedback {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  if (!CONTEXT_FEEDBACK_CATEGORIES.has(params.feedbackCategory)) {
    throw new Error('Unsupported Aoi context feedback category.');
  }
  const sourceId = truncateText(params.sourceId, 96);
  if (!sourceId) {
    throw new Error('sourceId is required.');
  }
  const now = params.now ?? Date.now();
  const item: AoiContextSourceFeedback = {
    version: 1,
    id: `ctxfb-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
    sessionPath: normalizedSessionPath,
    sourceId,
    ...(params.contextSummaryId
      ? { contextSummaryId: truncateText(params.contextSummaryId, 96) }
      : {}),
    feedbackCategory: params.feedbackCategory,
    ...(params.feedbackNote ? { feedbackNote: truncateText(params.feedbackNote, 180) } : {}),
    evidenceRefs: dedupeStrings(params.evidenceRefs ?? [], 8),
    createdAt: now,
  };
  const existing = loadAoiContextSourceFeedback(params.sessionsDir, normalizedSessionPath);
  const next = [item, ...existing].slice(0, MAX_CONTEXT_FEEDBACK);
  writeJsonAtomic(
    resolveContextFile(params.sessionsDir, normalizedSessionPath, CONTEXT_FEEDBACK_FILE),
    next,
  );
  return item;
}

function buildMissionCandidates(
  mission: AoiMissionState | null,
  now: number,
): AoiContextSourceSummary[] {
  if (!mission || mission.status === 'none' || mission.status === 'completed') {
    return [];
  }
  const refs = missionRefs(mission);
  return [
    makeSummary({
      sourceId: 'mission-state',
      kind: 'mission_state',
      label: 'Aoi mission state',
      summary: `${mission.focusSummary}; status=${mission.status}; waiting=${mission.waitingOn}; next=${mission.nextRecommendedAction.label}`,
      evidenceRefs: refs,
      relevanceScore: 0.78,
      confidence: 0.88,
      freshness: getFreshness(mission.updatedAt, now),
      scoreReasons: ['active mission focus', 'mission truth is injected separately'],
      updatedAt: mission.updatedAt,
    }),
  ];
}

function buildAppCandidates(params: {
  latestUserMessage: string;
  registry: AoiEnvironmentSourceRegistry;
  mission: AoiMissionState | null;
  now: number;
}): AoiContextSourceSummary[] {
  const sourceId = SOURCE_ID_BY_KIND.app_state;
  if (!sourceAllowed(params.registry, sourceId)) {
    return [];
  }
  const message = params.latestUserMessage.toLowerCase();
  if (!message) {
    return [];
  }
  return getAppRecognitionEntries()
    .map((app) => {
      const aliases = [app.displayName, app.appName, app.route, ...app.aliases];
      const matchedAlias = aliases.find((alias) => alias && message.includes(alias.toLowerCase()));
      const aliasOverlap = Math.max(
        ...aliases.map((alias) => overlapScore(params.latestUserMessage, alias)),
      );
      const appWorkIntent = hasIntent(
        message,
        /(app|앱|화면|패널|window|browser|브라우저|kira|키라|research|리서치|조사|ide|editor|에디터)/i,
      );
      if (!matchedAlias && (!appWorkIntent || aliasOverlap < 0.3)) {
        return null;
      }
      const score = 0.3 + (matchedAlias ? 0.34 : 0) + aliasOverlap * 0.2;
      return makeSummary({
        sourceId,
        kind: 'app_state',
        label: `${app.displayName} app context`,
        displayName: app.displayName,
        summary: `${app.displayName} is the relevant OpenRoom app context. Use appName=${app.appName} and route=${app.route} if an approved app action is needed.`,
        evidenceRefs: [`app:${app.appName}`],
        relevanceScore: score,
        confidence: matchedAlias ? 0.85 : 0.62,
        freshness: 'fresh',
        scoreReasons: [
          matchedAlias ? `matched app alias:${matchedAlias}` : 'app work intent detected',
          'display name preserved from app registry',
        ],
        updatedAt: params.now,
      });
    })
    .filter((item): item is AoiContextSourceSummary => item !== null);
}

function buildResearchCandidates(params: {
  runs: AoiResearchRunSummary[];
  latestUserMessage: string;
  registry: AoiEnvironmentSourceRegistry;
  mission: AoiMissionState | null;
  now: number;
}): AoiContextSourceSummary[] {
  const sourceId = SOURCE_ID_BY_KIND.research_runs;
  if (!sourceAllowed(params.registry, sourceId)) {
    return [];
  }
  const missionEvidence = missionRefs(params.mission);
  const researchIntent = hasIntent(
    params.latestUserMessage,
    /(research|리서치|조사|보고서|근거|출처|source|citation|paper|논문|자료|문서|artifact)/i,
  );
  return params.runs.slice(0, 12).map((run) => {
    const evidenceRefs = [`research:${run.id}`, `research:${run.id}/manifest`];
    if (run.artifactAvailability?.report) {
      evidenceRefs.push(`research:${run.id}/report`);
    }
    const text = [run.title, run.request, run.statusMessage].filter(Boolean).join(' ');
    const overlap = overlapScore(params.latestUserMessage, text);
    const linkedToMission =
      missionEvidence.includes(`research:${run.id}`) ||
      missionEvidence.some((ref) => ref.startsWith(`research:${run.id}/`));
    const freshness = getFreshness(
      run.completedAt ?? run.updatedAt,
      params.now,
      run.status === 'failed',
    );
    const score =
      0.24 +
      (researchIntent ? 0.34 : 0) +
      overlap * 0.24 +
      (linkedToMission ? 0.28 : 0) +
      scoreFreshness(freshness);
    return makeSummary({
      sourceId,
      kind: 'research_runs',
      label: run.title || run.request || `Research run ${run.id}`,
      displayName: 'Aoi Research',
      summary: `${run.title || run.request} (${run.status}); accepted sources=${run.sourceCounts.accepted}; claims=${run.claimCount ?? 0}; warnings=${run.warningCount + run.verificationWarningCount}.`,
      evidenceRefs,
      relevanceScore: score,
      confidence: run.status === 'completed' ? 0.84 : 0.58,
      freshness,
      scoreReasons: dedupeStrings([
        researchIntent ? 'research intent detected' : undefined,
        overlap > 0 ? 'message overlaps research topic' : undefined,
        linkedToMission ? 'linked to active mission' : undefined,
      ]),
      updatedAt: run.completedAt ?? run.updatedAt,
      staleReason:
        freshness === 'stale'
          ? 'Research run is older than the default freshness window.'
          : undefined,
    });
  });
}

function buildKiraCandidates(params: {
  memories: AoiMemoryEntry[];
  latestUserMessage: string;
  registry: AoiEnvironmentSourceRegistry;
  mission: AoiMissionState | null;
  now: number;
}): AoiContextSourceSummary[] {
  const sourceId = SOURCE_ID_BY_KIND.kira_board;
  if (!sourceAllowed(params.registry, sourceId)) {
    return [];
  }
  const message = params.latestUserMessage;
  const kiraIntent = hasIntent(
    message,
    /(kira|키라|review|reviewed|리뷰|검토|구현|implementation|delegate|delegation|handoff|작업|커밋|완료)/i,
  );
  const missionEvidence = missionRefs(params.mission);
  return params.memories
    .filter((memory) => {
      const tags = new Set(memory.tags.map((tag) => tag.toLowerCase()));
      return memory.status === 'active' && tags.has('kira');
    })
    .slice(0, 12)
    .map((memory) => {
      const tags = new Set(memory.tags.map((tag) => tag.toLowerCase()));
      const reviewed = tags.has('reviewed') || tags.has('review-approved');
      const evidenceRefs = [`memory:${memory.id}`];
      const linkedToMission = missionEvidence.some((ref) => memory.content.includes(ref));
      const overlap = overlapScore(message, `${memory.content} ${memory.entities.join(' ')}`);
      const freshness = getFreshness(memory.updatedAt, params.now);
      const score =
        0.26 +
        (kiraIntent ? 0.38 : 0) +
        (reviewed ? 0.14 : 0) +
        (linkedToMission ? 0.2 : 0) +
        overlap * 0.18 +
        scoreFreshness(freshness);
      return makeSummary({
        sourceId,
        kind: 'kira_board',
        label: 'Kira reviewed work',
        displayName: 'Kira',
        summary: memory.content,
        evidenceRefs,
        relevanceScore: score,
        confidence: clamp(memory.confidence + (reviewed ? 0.06 : 0), 0, 0.92),
        freshness,
        scoreReasons: dedupeStrings([
          kiraIntent ? 'implementation or Kira follow-up intent detected' : undefined,
          reviewed ? 'reviewed Kira outcome' : undefined,
          linkedToMission ? 'linked to active mission' : undefined,
          overlap > 0 ? 'message overlaps Kira memory' : undefined,
        ]),
        updatedAt: memory.updatedAt,
      });
    });
}

function buildBrowserCandidates(params: {
  browserContexts: AoiBrowserContextMetadata[];
  latestUserMessage: string;
  registry: AoiEnvironmentSourceRegistry;
  now: number;
}): AoiContextSourceSummary[] {
  const sourceId = SOURCE_ID_BY_KIND.browser_context;
  if (!sourceAllowed(params.registry, sourceId)) {
    return [];
  }
  const browserIntent = hasIntent(
    params.latestUserMessage,
    /(browser|브라우저|page|페이지|url|link|링크|article|reader|웹|사이트|http)/i,
  );
  return params.browserContexts.slice(0, 6).map((context) => {
    const overlap = overlapScore(
      params.latestUserMessage,
      `${context.pageTitle} ${context.urlHost} ${context.purpose}`,
    );
    const freshness = getFreshness(context.capturedAt, params.now);
    const score = 0.25 + (browserIntent ? 0.34 : 0) + overlap * 0.18 + scoreFreshness(freshness);
    return makeSummary({
      sourceId,
      kind: 'browser_context',
      label: context.pageTitle,
      displayName: 'Browser',
      summary: `${context.pageTitle} at ${context.urlHost}; purpose=${context.purpose}; url=${context.redactedUrl}`,
      evidenceRefs: context.evidenceRefs,
      relevanceScore: score,
      confidence: 0.78,
      freshness,
      scoreReasons: dedupeStrings([
        browserIntent ? 'browser or URL intent detected' : undefined,
        overlap > 0 ? 'message overlaps explicit page metadata' : undefined,
        'explicit user-provided page metadata only',
      ]),
      updatedAt: context.capturedAt,
      redactionState: context.redactionState,
    });
  });
}

function buildWorkspaceCandidates(params: {
  snapshot: AoiWorkspaceSnapshot | null;
  latestUserMessage: string;
  registry: AoiEnvironmentSourceRegistry;
  mission: AoiMissionState | null;
}): AoiContextSourceSummary[] {
  if (!params.snapshot) {
    return [];
  }
  const implementationIntent = hasIntent(
    params.latestUserMessage,
    /(구현|implementation|code|코드|commit|커밋|test|테스트|build|빌드|validation|검증|workspace|작업)/i,
  );
  const missionEvidence = missionRefs(params.mission);
  const candidates: AoiContextSourceSummary[] = [];
  if (params.snapshot.git && sourceAllowed(params.registry, SOURCE_ID_BY_KIND.workspace_git)) {
    const linkedToMission = missionEvidence.includes(
      `workspace:snapshot:${params.snapshot.collectedAt}`,
    );
    candidates.push(
      makeSummary({
        sourceId: SOURCE_ID_BY_KIND.workspace_git,
        kind: 'workspace_git',
        label: 'Workspace git status',
        summary: `${params.snapshot.workspaceLabel}: branch=${params.snapshot.git.branchName}; ${params.snapshot.git.statusSummary}.`,
        evidenceRefs: params.snapshot.evidenceRefs,
        relevanceScore:
          0.22 +
          (implementationIntent ? 0.22 : 0) +
          (params.snapshot.git.isDirty ? 0.08 : 0) +
          (linkedToMission ? 0.18 : 0) +
          scoreFreshness(params.snapshot.freshness),
        confidence: params.snapshot.git.error ? 0.48 : 0.78,
        freshness: params.snapshot.freshness,
        scoreReasons: dedupeStrings([
          implementationIntent ? 'implementation intent detected' : undefined,
          params.snapshot.git.isDirty ? 'workspace has changed files' : undefined,
          linkedToMission ? 'workspace evidence linked to mission' : undefined,
        ]),
        updatedAt: params.snapshot.collectedAt,
        staleReason:
          params.snapshot.freshness === 'stale'
            ? 'Workspace signal indicates stale validation or changed files.'
            : undefined,
      }),
    );
  }
  if (sourceAllowed(params.registry, SOURCE_ID_BY_KIND.workspace_build)) {
    candidates.push(
      makeSummary({
        sourceId: SOURCE_ID_BY_KIND.workspace_build,
        kind: 'workspace_build',
        label: 'Workspace validation state',
        summary: `Validation=${params.snapshot.validation.result}; freshness=${params.snapshot.validation.freshness}; command=${params.snapshot.validation.command || 'unknown'}.`,
        evidenceRefs: dedupeStrings([
          ...params.snapshot.evidenceRefs,
          ...params.snapshot.validation.evidenceRefs,
        ]),
        relevanceScore:
          0.2 +
          (implementationIntent ? 0.22 : 0) +
          (params.snapshot.validation.result === 'failed' ? 0.16 : 0) +
          scoreFreshness(params.snapshot.validation.freshness),
        confidence: params.snapshot.validation.result === 'unknown' ? 0.52 : 0.76,
        freshness: params.snapshot.validation.freshness,
        scoreReasons: dedupeStrings([
          implementationIntent ? 'implementation or validation intent detected' : undefined,
          params.snapshot.validation.result === 'failed' ? 'last validation failed' : undefined,
        ]),
        updatedAt: params.snapshot.validation.completedAt ?? params.snapshot.collectedAt,
        staleReason: params.snapshot.validation.staleReason,
      }),
    );
  }
  return candidates;
}

export function buildAoiContextPromptBlock(
  selectedSources: AoiContextSourceSummary[],
  options: { maxSources?: number; maxChars?: number } = {},
): string {
  const maxSources = options.maxSources ?? MAX_PROMPT_SOURCES;
  const maxChars = options.maxChars ?? MAX_PROMPT_CHARS;
  const promptSources = selectedSources
    .filter((source) => source.kind !== 'mission_state')
    .slice(0, maxSources);
  if (promptSources.length === 0) {
    return '';
  }
  const lines = [
    '',
    '',
    'Aoi Context Router:',
    '- Use these source summaries as compact read-only context. Do not run tools or change state from context routing alone.',
    ...promptSources.map((source) => {
      const refs =
        source.evidenceRefs.length > 0
          ? ` evidence=${source.evidenceRefs.slice(0, 3).join(', ')}`
          : '';
      const displayName = source.displayName ? `${source.displayName} / ` : '';
      return `- ${displayName}${source.label}: score=${source.relevanceScore.toFixed(2)}, freshness=${source.freshness}, confidence=${source.confidence.toFixed(2)}. ${JSON.stringify(source.summary)}.${refs}`;
    }),
  ];
  const block = lines.join('\n');
  if (block.length <= maxChars) {
    return block;
  }
  return `${block.slice(0, Math.max(0, maxChars - 4)).trimEnd()}\n...`;
}

export function buildAoiContextRouterResult(params: AoiContextRouterInput): AoiContextRouterResult {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  const latestUserMessage = truncateText(params.latestUserMessage ?? '', 1000);
  const registry =
    params.registry ?? loadAoiEnvironmentSourceRegistry(params.sessionsDir, sessionPath, now);
  const mission =
    params.mission === undefined
      ? deriveAoiMissionState({
          sessionsDir: params.sessionsDir,
          sessionPath,
          now,
          persist: false,
        })
      : params.mission;
  const memories = params.memories ?? loadServerAoiMemories(params.sessionsDir);
  const workspaceSnapshot =
    params.workspaceSnapshot === undefined
      ? loadAoiWorkspaceSnapshot(params.sessionsDir, sessionPath)
      : params.workspaceSnapshot;
  const decisions = loadAoiProposalDecisions(params.sessionsDir, sessionPath);
  const contextFeedback = loadAoiContextSourceFeedback(params.sessionsDir, sessionPath);
  const runs = listAoiResearchRunSummaries(params.sessionsDir, sessionPath);
  const browserContexts = loadAoiBrowserContextMetadata(params.sessionsDir, sessionPath);

  const rawCandidates = [
    ...buildMissionCandidates(mission, now),
    ...buildAppCandidates({ latestUserMessage, registry, mission, now }),
    ...buildResearchCandidates({ runs, latestUserMessage, registry, mission, now }),
    ...buildKiraCandidates({ memories, latestUserMessage, registry, mission, now }),
    ...buildBrowserCandidates({ browserContexts, latestUserMessage, registry, now }),
    ...buildWorkspaceCandidates({
      snapshot: workspaceSnapshot,
      latestUserMessage,
      registry,
      mission,
    }),
  ];

  const candidateSources = rawCandidates
    .map((summary) => applyFeedbackPenalties({ summary, decisions, contextFeedback }))
    .filter((summary) => summary.relevanceScore > 0)
    .sort((left, right) => {
      if (right.relevanceScore !== left.relevanceScore) {
        return right.relevanceScore - left.relevanceScore;
      }
      return right.updatedAt - left.updatedAt;
    });
  const selectedSources = candidateSources.slice(0, 5);
  const promptBlock = buildAoiContextPromptBlock(selectedSources, {
    maxSources: params.maxPromptSources,
    maxChars: params.maxPromptChars,
  });

  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    selectedSources,
    candidateSources,
    promptBlock,
  };
}
