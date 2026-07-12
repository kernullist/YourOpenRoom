// Aoi current-situation model (SA4.1): ONE evidence-cited fusion of "what is
// happening right now" -- mission + intent + live activity + workspace +
// calendar + conversation + research -- instead of N parallel projections.
//
// Grounding rules (load-bearing):
// - EVERY segment must carry non-empty evidenceRefs; a segment that cannot
//   cite evidence is DROPPED and surfaces as an explicit cannotKnow statement
//   (fail-closed grounding -- the situation never contains uncited claims).
// - Inputs are the already consent-gated projections; dark sources appear
//   only as cannotKnow, never as guessed content.
// - Segment text is DERIVED from validated slugs, counts, and enum labels
//   (mission focus text is already sanitized upstream and is truncated here).
// - Observation-only: display_only, mutationCount 0; persisted atomically
//   with a bounded history; fail-closed load.
import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { normalizeAoiAutonomySessionPath, resolveAoiAutonomyPaths } from './aoiAutonomyStore';
import type {
  AoiMissionState,
  AoiPersonalSignalMetadataSummary,
  AoiSignalFreshness,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';
import type { AoiResearchRunSummary } from './aoiResearchTypes';
import {
  describeAoiActivityStreamSummary,
  type AoiActivityStreamSummary,
} from './aoiActivityStream';
import type { AoiIntentHypothesis, AoiIntentState } from './aoiIntentInference';
import { scoreAoiSalience, type AoiSalienceKind } from './aoiSalienceModel';

const SITUATION_DIR = 'situation';
const SITUATION_STATE_FILE = 'current.json';
const SITUATION_HISTORY_FILE = 'history.jsonl';
const SITUATION_STALE_AFTER_MS = 30 * 60 * 1000;
const MAX_HISTORY_ENTRIES = 100;
const MAX_REFS = 16;
const MAX_FOCUS_ITEMS = 5;
const MAX_SEGMENT_SUMMARY_CHARS = 220;
const RECENT_RESEARCH_WINDOW_MS = 2 * 60 * 60 * 1000;

export type AoiCurrentSituationSegmentKind =
  | 'mission'
  | 'intent'
  | 'activity'
  | 'workspace'
  | 'calendar'
  | 'conversation'
  | 'research';

export interface AoiCurrentSituationSegment {
  version: 1;
  kind: AoiCurrentSituationSegmentKind;
  label: string;
  summary: string;
  freshness: AoiSignalFreshness;
  salienceScore: number;
  evidenceRefs: string[];
  cannotKnow: string[];
}

export interface AoiCurrentSituationFocusItem {
  version: 1;
  title: string;
  sourceKind: AoiSalienceKind;
  salienceScore: number;
  evidenceRefs: string[];
}

export interface AoiCurrentSituation {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  staleAt: number;
  headline: string;
  segments: AoiCurrentSituationSegment[];
  focusItems: AoiCurrentSituationFocusItem[];
  intent: AoiIntentHypothesis | null;
  confidence: number;
  consentedSegmentCount: number;
  evidenceRefs: string[];
  cannotKnow: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiCurrentSituationInput {
  sessionPath: string;
  now?: number;
  mission?: AoiMissionState | null;
  intentState?: AoiIntentState | null;
  activitySummary?: AoiActivityStreamSummary | null;
  workspaceSnapshot?: AoiWorkspaceSnapshot | null;
  personalMetadata?: AoiPersonalSignalMetadataSummary[];
  researchRuns?: AoiResearchRunSummary[];
  // Timestamp of the latest user chat turn, when known (metadata only --
  // never the content).
  lastUserMessageAt?: number | null;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function dedupeStrings(values: Array<string | undefined | null>, maxItems: number): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function freshnessFromAge(
  ageMs: number,
  freshWindowMs: number,
  staleWindowMs: number,
): AoiSignalFreshness {
  if (ageMs <= freshWindowMs) {
    return 'fresh';
  }
  if (ageMs <= staleWindowMs) {
    return 'stale';
  }
  return 'unknown';
}

// A segment is admitted ONLY with citable evidence; otherwise the caller
// records a cannotKnow statement instead. This is the grounding gate.
function makeSegment(params: {
  kind: AoiCurrentSituationSegmentKind;
  label: string;
  summary: string;
  freshness: AoiSignalFreshness;
  salienceKind: AoiSalienceKind;
  observedAt: number;
  baseWeight: number;
  evidenceRefs: Array<string | undefined | null>;
  cannotKnow?: string[];
  now: number;
}): AoiCurrentSituationSegment | null {
  const evidenceRefs = dedupeStrings(params.evidenceRefs, 8);
  if (evidenceRefs.length === 0) {
    return null;
  }
  const salience = scoreAoiSalience(
    { kind: params.salienceKind, observedAt: params.observedAt, baseWeight: params.baseWeight },
    params.now,
  );
  return {
    version: 1,
    kind: params.kind,
    label: params.label,
    summary: truncate(params.summary, MAX_SEGMENT_SUMMARY_CHARS),
    freshness: params.freshness,
    salienceScore: salience.score,
    evidenceRefs,
    cannotKnow: dedupeStrings(params.cannotKnow ?? [], 4),
  };
}

export function buildAoiCurrentSituation(input: AoiCurrentSituationInput): AoiCurrentSituation {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? Date.now();
  const segments: AoiCurrentSituationSegment[] = [];
  const cannotKnow: string[] = [];

  const admit = (
    segment: AoiCurrentSituationSegment | null,
    droppedStatement: string | null,
  ): void => {
    if (segment) {
      segments.push(segment);
    } else if (droppedStatement) {
      cannotKnow.push(droppedStatement);
    }
  };

  // --- Mission (what Aoi believes the ongoing objective is).
  const mission = input.mission ?? null;
  if (mission && mission.focusSummary.trim()) {
    admit(
      makeSegment({
        kind: 'mission',
        label: 'Mission',
        summary: `Mission ${mission.status}: ${mission.focusSummary}`,
        freshness: freshnessFromAge(
          now - mission.updatedAt,
          24 * 60 * 60 * 1000,
          7 * 24 * 60 * 60 * 1000,
        ),
        salienceKind: 'mission_state',
        observedAt: mission.updatedAt,
        baseWeight: 0.7,
        evidenceRefs: [
          ...mission.evidenceRefs,
          mission.activeGoalId ? `goal:${mission.activeGoalId}` : undefined,
        ],
        now,
      }),
      'Aoi cannot ground the mission segment: the mission state cites no evidence.',
    );
  }

  // --- Intent (what the user is trying to do right now).
  const intent = input.intentState?.current ?? null;
  const intentFresh = (input.intentState?.staleAt ?? 0) > now;
  if (intent && intentFresh) {
    admit(
      makeSegment({
        kind: 'intent',
        label: 'Current intent',
        summary: `${intent.label} (confidence ${intent.confidence.toFixed(2)})`,
        freshness: 'fresh',
        salienceKind: 'chat',
        observedAt: intent.observedAt,
        baseWeight: intent.confidence,
        evidenceRefs: intent.evidenceRefs,
        now,
      }),
      null,
    );
  } else if (input.intentState) {
    cannotKnow.push(...input.intentState.cannotKnow);
  }

  // --- Live activity.
  const activity = input.activitySummary ?? null;
  if (activity?.consented === true && activity.activeEventCount > 0) {
    admit(
      makeSegment({
        kind: 'activity',
        label: 'Live app activity',
        summary: describeAoiActivityStreamSummary(activity),
        freshness:
          activity.lastEventAgeMs !== null && activity.lastEventAgeMs <= 30 * 60 * 1000
            ? 'fresh'
            : 'stale',
        salienceKind: 'app_activity',
        observedAt: activity.lastEventAt ?? now,
        baseWeight: 0.6,
        evidenceRefs: activity.evidenceRefs,
        now,
      }),
      null,
    );
  } else {
    cannotKnow.push(
      activity?.consented === false
        ? 'Aoi cannot know live app activity because the app-activity source is not consented.'
        : 'Aoi cannot know live app activity because no live activity has been observed.',
    );
  }

  // --- Workspace.
  const workspace = input.workspaceSnapshot ?? null;
  if (workspace?.git) {
    const dirtyLabel = workspace.git.isDirty
      ? `dirty (${workspace.git.changedFileCount} changed files)`
      : 'clean';
    const validationLabel =
      workspace.validation.result === 'unknown'
        ? 'validation unknown'
        : `validation ${workspace.validation.result}`;
    admit(
      makeSegment({
        kind: 'workspace',
        label: 'Workspace',
        summary: `${workspace.workspaceLabel}: branch ${workspace.git.branchName}, ${dirtyLabel}, ${validationLabel}.`,
        freshness: workspace.freshness,
        salienceKind: 'workspace_git',
        observedAt: workspace.collectedAt,
        baseWeight: workspace.git.isDirty ? 0.65 : 0.4,
        evidenceRefs: workspace.evidenceRefs,
        now,
      }),
      'Aoi cannot ground the workspace segment: the snapshot cites no evidence.',
    );
  } else {
    cannotKnow.push(
      'Aoi cannot know the workspace state because no consented workspace snapshot exists.',
    );
  }

  // --- Calendar (metadata only).
  for (const summary of input.personalMetadata ?? []) {
    if (summary.kind !== 'calendar_metadata') {
      continue;
    }
    admit(
      makeSegment({
        kind: 'calendar',
        label: 'Calendar',
        summary: summary.summary,
        freshness: summary.freshness,
        salienceKind: 'calendar_metadata',
        observedAt: summary.updatedAt,
        baseWeight: clamp(summary.confidence, 0, 1),
        evidenceRefs: summary.evidenceRefs,
        now,
      }),
      'Aoi cannot ground the calendar segment: the metadata summary cites no evidence.',
    );
  }

  // --- Conversation recency (metadata only -- never the content).
  if (typeof input.lastUserMessageAt === 'number' && Number.isFinite(input.lastUserMessageAt)) {
    const ageMinutes = Math.max(0, Math.round((now - input.lastUserMessageAt) / 60_000));
    admit(
      makeSegment({
        kind: 'conversation',
        label: 'Conversation',
        summary: `Last user message ${ageMinutes}m ago.`,
        freshness: freshnessFromAge(
          now - input.lastUserMessageAt,
          30 * 60 * 1000,
          4 * 60 * 60 * 1000,
        ),
        salienceKind: 'chat',
        observedAt: input.lastUserMessageAt,
        baseWeight: 0.55,
        evidenceRefs: ['chat:latest-user-message'],
        now,
      }),
      null,
    );
  }

  // --- Research.
  const latestRun = (input.researchRuns ?? [])
    .filter(
      (run) =>
        run.status === 'running' ||
        run.status === 'queued' ||
        (run.status === 'completed' &&
          typeof run.completedAt === 'number' &&
          now - run.completedAt <= RECENT_RESEARCH_WINDOW_MS),
    )
    .sort(
      (left, right) =>
        (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt),
    )[0];
  if (latestRun) {
    admit(
      makeSegment({
        kind: 'research',
        label: 'Research',
        summary: `Research run ${latestRun.status}: ${truncate(latestRun.title ?? latestRun.request, 120)}`,
        freshness: 'fresh',
        salienceKind: 'research_runs',
        observedAt: latestRun.completedAt ?? latestRun.updatedAt,
        baseWeight: latestRun.status === 'completed' ? 0.5 : 0.65,
        evidenceRefs: [`research:${latestRun.id}`],
        now,
      }),
      null,
    );
  }

  // --- Focus items: the salience-ranked "what matters now" list. Segments
  // already carry their decayed salience score (computed at admit time), so
  // ranking is a direct sort; near-zero (faded) segments drop out.
  const focusItems: AoiCurrentSituationFocusItem[] = [...segments]
    .filter((segment) => segment.salienceScore >= 0.02)
    .sort(
      (left, right) =>
        right.salienceScore - left.salienceScore || left.kind.localeCompare(right.kind),
    )
    .slice(0, MAX_FOCUS_ITEMS)
    .map((segment) => ({
      version: 1 as const,
      title: `${segment.label}: ${truncate(segment.summary, 100)}`,
      sourceKind: segmentSalienceKind(segment.kind),
      salienceScore: segment.salienceScore,
      evidenceRefs: segment.evidenceRefs.slice(0, 6),
    }));

  const headline = buildHeadline(segments, intent && intentFresh ? intent : null);
  const confidence = clamp(
    Number(
      (
        0.15 +
        segments.length * 0.08 +
        (intent && intentFresh ? intent.confidence * 0.3 : 0)
      ).toFixed(3),
    ),
    0,
    0.95,
  );
  const evidenceRefs = dedupeStrings(
    segments.flatMap((segment) => segment.evidenceRefs),
    MAX_REFS,
  );

  return {
    version: 1,
    id: `situation-${hashText([sessionPath, String(now), evidenceRefs.join(',')].join('|'))}`,
    sessionPath,
    generatedAt: now,
    staleAt: now + SITUATION_STALE_AFTER_MS,
    headline,
    segments,
    focusItems,
    intent: intent && intentFresh ? intent : null,
    confidence,
    consentedSegmentCount: segments.length,
    evidenceRefs,
    cannotKnow: dedupeStrings(cannotKnow, MAX_REFS),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function segmentSalienceKind(kind: AoiCurrentSituationSegmentKind): AoiSalienceKind {
  if (kind === 'activity') {
    return 'app_activity';
  }
  if (kind === 'workspace') {
    return 'workspace_git';
  }
  if (kind === 'calendar') {
    return 'calendar_metadata';
  }
  if (kind === 'research') {
    return 'research_runs';
  }
  if (kind === 'mission') {
    return 'mission_state';
  }
  return 'chat';
}

function buildHeadline(
  segments: readonly AoiCurrentSituationSegment[],
  intent: AoiIntentHypothesis | null,
): string {
  const parts: string[] = [];
  if (intent) {
    parts.push(intent.label);
  }
  const activity = segments.find((segment) => segment.kind === 'activity');
  if (activity) {
    const appMatch = activity.summary.match(/active app=([a-z0-9_-]+)/);
    if (appMatch && appMatch[1] !== 'none') {
      parts.push(`active app ${appMatch[1]}`);
    }
  }
  const workspace = segments.find((segment) => segment.kind === 'workspace');
  if (workspace) {
    parts.push(workspace.summary.replace(/\.$/, ''));
  }
  if (parts.length === 0) {
    return 'No grounded live signals; situation unknown.';
  }
  return truncate(parts.join('; '), 200);
}

export function resolveAoiCurrentSituationPaths(
  sessionsDir: string,
  sessionPath: string,
): { current: string; history: string } {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const current = join(paths.root, SITUATION_DIR, SITUATION_STATE_FILE);
  const history = join(paths.root, SITUATION_DIR, SITUATION_HISTORY_FILE);
  if (!isPathInsideRoot(paths.root, current) || !isPathInsideRoot(paths.root, history)) {
    throw new Error('Resolved Aoi situation path escaped the autonomy root.');
  }
  return { current, history };
}

export function saveAoiCurrentSituation(
  sessionsDir: string,
  situation: AoiCurrentSituation,
): AoiCurrentSituation {
  const paths = resolveAoiCurrentSituationPaths(sessionsDir, situation.sessionPath);
  fs.mkdirSync(dirname(paths.current), { recursive: true });
  const tmpPath = `${paths.current}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(situation, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, paths.current);
  // Bounded history: append, then compact when past the cap.
  fs.appendFileSync(paths.history, `${JSON.stringify(situation)}\n`, 'utf-8');
  try {
    const lines = fs.readFileSync(paths.history, 'utf-8').split(/\r?\n/).filter(Boolean);
    if (lines.length > MAX_HISTORY_ENTRIES) {
      const retained = lines.slice(-MAX_HISTORY_ENTRIES);
      const historyTmp = `${paths.history}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(historyTmp, `${retained.join('\n')}\n`, 'utf-8');
      fs.renameSync(historyTmp, paths.history);
    }
  } catch {
    // History compaction is best-effort; the current state write is what matters.
  }
  return situation;
}

// How many situation briefs the bounded history holds (grounding practice
// count for the cognition-readiness scorecard). Fail-closed zero.
export function countAoiCurrentSituationHistory(sessionsDir: string, sessionPath: string): number {
  try {
    const paths = resolveAoiCurrentSituationPaths(sessionsDir, sessionPath);
    if (!fs.existsSync(paths.history)) {
      return 0;
    }
    return fs.readFileSync(paths.history, 'utf-8').split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function loadAoiCurrentSituation(
  sessionsDir: string,
  sessionPath: string,
): AoiCurrentSituation | null {
  try {
    const paths = resolveAoiCurrentSituationPaths(sessionsDir, sessionPath);
    if (!fs.existsSync(paths.current)) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(paths.current, 'utf-8')) as Partial<AoiCurrentSituation>;
    if (
      !raw ||
      raw.version !== 1 ||
      typeof raw.generatedAt !== 'number' ||
      typeof raw.staleAt !== 'number' ||
      raw.actionAuthority !== 'display_only' ||
      raw.mutationCount !== 0 ||
      !Array.isArray(raw.segments)
    ) {
      return null;
    }
    return raw as AoiCurrentSituation;
  } catch {
    // Fail closed: an unreadable situation is no situation.
    return null;
  }
}
