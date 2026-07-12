// Aoi intent inference (SA2.1): the deterministic, evidence-cited model of
// "what is the user trying to do RIGHT NOW", derived from the live signal
// stream instead of a regex over the last message.
//
// Grounding rules (load-bearing):
// - Every hypothesis must cite evidenceRefs; a rule that cannot cite evidence
//   contributes nothing (fail-closed grounding -- no guess presented as fact).
// - Inputs are the ALREADY consent-gated projections (activity summary,
//   workspace snapshot, personal metadata); a dark source appears only as an
//   explicit cannotKnow statement and lowers what is claimable. Notably,
//   'idle' is claimable ONLY with a consented activity stream -- silence
//   without observation is not evidence of idleness.
// - Observation-only: display_only, mutationCount 0, no LLM, no side effects
//   beyond the atomic state file write.
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { normalizeAoiAutonomySessionPath, resolveAoiAutonomyPaths } from './aoiAutonomyStore';
import { checkAoiEnvironmentSourceOperation } from './aoiAutonomyPolicy';
import type {
  AoiEnvironmentSourceRegistry,
  AoiMissionState,
  AoiPersonalSignalMetadataSummary,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';
import type { AoiResearchRunSummary } from './aoiResearchTypes';
import { AOI_ACTIVITY_FRESH_WINDOW_MS, type AoiActivityStreamSummary } from './aoiActivityStream';

const INTENT_DIR = 'intent';
const INTENT_STATE_FILE = 'current.json';
const INTENT_STALE_AFTER_MS = 30 * 60 * 1000;
const RECENT_RESEARCH_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_REFS = 12;
const MAX_REASONS = 8;
const MAX_ALTERNATES = 3;
const MIN_CURRENT_CONFIDENCE = 0.3;

export type AoiIntentKind =
  | 'coding'
  | 'debugging'
  | 'researching'
  | 'writing'
  | 'communicating'
  | 'media'
  | 'planning'
  | 'meeting_prep'
  | 'idle';

export interface AoiIntentHypothesis {
  version: 1;
  kind: AoiIntentKind;
  label: string;
  confidence: number;
  scoreReasons: string[];
  evidenceRefs: string[];
  observedAt: number;
}

export interface AoiIntentState {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  staleAt: number;
  current: AoiIntentHypothesis | null;
  alternates: AoiIntentHypothesis[];
  cannotKnow: string[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiIntentInferenceInput {
  sessionPath: string;
  now?: number;
  registry?: AoiEnvironmentSourceRegistry | null;
  activitySummary?: AoiActivityStreamSummary | null;
  workspaceSnapshot?: AoiWorkspaceSnapshot | null;
  mission?: AoiMissionState | null;
  latestUserMessage?: string;
  researchRuns?: AoiResearchRunSummary[];
  personalMetadata?: AoiPersonalSignalMetadataSummary[];
}

const INTENT_LABELS: Record<AoiIntentKind, string> = {
  coding: 'Writing or changing code in the workspace',
  debugging: 'Debugging a failing validation in the workspace',
  researching: 'Researching a topic',
  writing: 'Writing notes or documents',
  communicating: 'Reading or writing messages',
  media: 'Consuming music or video',
  planning: 'Planning or organizing work',
  meeting_prep: 'Preparing for an upcoming calendar event',
  idle: 'Idle -- no live activity observed',
};

// Coarse app-slug categories for intent boosts. Membership is by substring so
// e.g. 'notesapp' and 'notes' both land in writing.
const APP_CATEGORY_PATTERNS: ReadonlyArray<{ kind: AoiIntentKind; pattern: RegExp }> = [
  { kind: 'writing', pattern: /(note|doc|write|memo)/ },
  { kind: 'communicating', pattern: /(mail|twitter|message|chat|social)/ },
  { kind: 'media', pattern: /(youtube|music|video|player|media)/ },
  { kind: 'planning', pattern: /(kira|board|todo|task|calendar|plan)/ },
  { kind: 'researching', pattern: /(research|browser|search)/ },
];

interface IntentAccumulator {
  score: number;
  reasons: string[];
  evidenceRefs: string[];
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

function addSignal(
  accumulators: Map<AoiIntentKind, IntentAccumulator>,
  kind: AoiIntentKind,
  score: number,
  reason: string,
  evidenceRefs: readonly string[],
): void {
  // Fail-closed grounding: a signal with no citable evidence contributes nothing.
  const refs = evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim().length > 0);
  if (refs.length === 0) {
    return;
  }
  const entry = accumulators.get(kind) ?? { score: 0, reasons: [], evidenceRefs: [] };
  entry.score += score;
  entry.reasons.push(reason);
  entry.evidenceRefs.push(...refs);
  accumulators.set(kind, entry);
}

function sourceEnabled(
  registry: AoiEnvironmentSourceRegistry | null | undefined,
  sourceId: string,
  operation: 'summarize' | 'summarize_counts' | 'read_metadata' | 'status',
): boolean {
  if (!registry) {
    return false;
  }
  return checkAoiEnvironmentSourceOperation({ registry, sourceId, operation }).allowed;
}

export function buildAoiIntentState(input: AoiIntentInferenceInput): AoiIntentState {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? Date.now();
  const message = (input.latestUserMessage ?? '').trim();
  const accumulators = new Map<AoiIntentKind, IntentAccumulator>();
  const cannotKnow: string[] = [];

  // --- Workspace signals -> coding / debugging.
  const workspace = input.workspaceSnapshot ?? null;
  if (workspace?.git) {
    const workspaceRefs = workspace.evidenceRefs.slice(0, 4);
    if (workspace.git.isDirty) {
      addSignal(
        accumulators,
        'coding',
        0.45,
        `workspace dirty: ${workspace.git.changedFileCount} changed files`,
        workspaceRefs,
      );
    }
    if (workspace.git.branchChanged) {
      addSignal(accumulators, 'coding', 0.1, 'workspace branch changed', workspaceRefs);
    }
    if (workspace.validation.result === 'failed') {
      addSignal(
        accumulators,
        'debugging',
        0.55,
        'workspace validation failing',
        dedupeStrings([...workspaceRefs, ...workspace.validation.evidenceRefs], 6),
      );
    }
  } else if (input.registry && !sourceEnabled(input.registry, 'workspace-git', 'status')) {
    cannotKnow.push(
      'Aoi cannot infer coding intent because the workspace-git source is not enabled.',
    );
  }

  // --- Research runs -> researching.
  for (const run of input.researchRuns ?? []) {
    if (run.status === 'running' || run.status === 'queued') {
      addSignal(accumulators, 'researching', 0.55, `research run active: ${run.id}`, [
        `research:${run.id}`,
      ]);
    } else if (
      run.status === 'completed' &&
      typeof run.completedAt === 'number' &&
      now - run.completedAt <= RECENT_RESEARCH_WINDOW_MS
    ) {
      addSignal(accumulators, 'researching', 0.3, `research run completed recently: ${run.id}`, [
        `research:${run.id}`,
      ]);
    }
  }

  // --- Live activity -> app-category intents (+ idle when silent).
  const activity = input.activitySummary ?? null;
  const activityFresh =
    activity?.consented === true &&
    activity.activeEventCount > 0 &&
    activity.lastEventAgeMs !== null &&
    activity.lastEventAgeMs <= AOI_ACTIVITY_FRESH_WINDOW_MS;
  if (activity?.consented === true) {
    if (activityFresh && activity.activeAppId) {
      const activityRefs = dedupeStrings(activity.evidenceRefs, 6);
      const category = APP_CATEGORY_PATTERNS.find((entry) =>
        entry.pattern.test(activity.activeAppId ?? ''),
      );
      if (category) {
        const interactionBoost = activity.kindCounts.app_action > 0 ? 0.1 : 0;
        addSignal(
          accumulators,
          category.kind,
          0.4 + interactionBoost,
          `live activity in ${activity.activeAppId}`,
          activityRefs,
        );
      } else {
        // Unmapped app: real engagement, unknown category. Contributes a weak
        // generic planning signal only when the user is interacting.
        if (activity.kindCounts.app_action > 0) {
          addSignal(
            accumulators,
            'planning',
            0.12,
            `live interaction in ${activity.activeAppId}`,
            activityRefs,
          );
        }
      }
    } else if (!activityFresh) {
      // Silence WITH observation is evidence of idleness.
      addSignal(accumulators, 'idle', 0.3, 'no live app activity inside the fresh window', [
        `environment-source:app-activity`,
      ]);
    }
  } else {
    cannotKnow.push(
      'Aoi cannot observe live app activity because the app-activity source is not consented; idle cannot be claimed.',
    );
  }

  // --- Calendar metadata -> meeting preparation.
  for (const summary of input.personalMetadata ?? []) {
    if (
      summary.kind === 'calendar_metadata' &&
      summary.freshness === 'fresh' &&
      /upcoming/i.test(summary.summary)
    ) {
      addSignal(
        accumulators,
        'meeting_prep',
        0.3,
        'calendar shows an upcoming event',
        dedupeStrings(summary.evidenceRefs, 4),
      );
    }
  }

  // --- Latest message intent phrases (weak boosts; message text itself is the evidence anchor).
  if (message) {
    const messageRef = 'chat:latest-user-message';
    if (/(구현|implement|code|코드|refactor|버그|bug|fix|고쳐)/i.test(message)) {
      addSignal(accumulators, 'coding', 0.25, 'message mentions implementation work', [messageRef]);
    }
    if (/(research|조사|리서치|찾아|알아봐|investigate)/i.test(message)) {
      addSignal(accumulators, 'researching', 0.25, 'message mentions research', [messageRef]);
    }
    if (/(plan|계획|일정|정리|organize|roadmap)/i.test(message)) {
      addSignal(accumulators, 'planning', 0.2, 'message mentions planning', [messageRef]);
    }
  }

  // --- Mission focus: anchor evidence for the leading hypothesis.
  const mission = input.mission ?? null;

  const hypotheses: AoiIntentHypothesis[] = [...accumulators.entries()]
    .map(([kind, entry]) => ({
      version: 1 as const,
      kind,
      label: INTENT_LABELS[kind],
      confidence: clamp(Number(entry.score.toFixed(3)), 0.05, 0.9),
      scoreReasons: dedupeStrings(entry.reasons, MAX_REASONS),
      evidenceRefs: dedupeStrings(
        [...entry.evidenceRefs, ...(mission?.activeGoalId ? [`goal:${mission.activeGoalId}`] : [])],
        MAX_REFS,
      ),
      observedAt: now,
    }))
    .sort(
      (left, right) => right.confidence - left.confidence || left.kind.localeCompare(right.kind),
    );

  const current =
    hypotheses.length > 0 && hypotheses[0].confidence >= MIN_CURRENT_CONFIDENCE
      ? hypotheses[0]
      : null;
  if (!current) {
    cannotKnow.push(
      'Aoi cannot state a current intent: no consented live signal provides sufficient evidence.',
    );
  }

  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    staleAt: now + INTENT_STALE_AFTER_MS,
    current,
    alternates: hypotheses.slice(current ? 1 : 0, (current ? 1 : 0) + MAX_ALTERNATES),
    cannotKnow: dedupeStrings(cannotKnow, MAX_REFS),
    evidenceRefs: dedupeStrings(
      hypotheses.flatMap((hypothesis) => hypothesis.evidenceRefs),
      MAX_REFS,
    ),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function resolveAoiIntentStatePath(sessionsDir: string, sessionPath: string): string {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const filePath = join(paths.root, INTENT_DIR, INTENT_STATE_FILE);
  if (!isPathInsideRoot(paths.root, filePath)) {
    throw new Error('Resolved Aoi intent path escaped the autonomy root.');
  }
  return filePath;
}

export function saveAoiIntentState(sessionsDir: string, state: AoiIntentState): AoiIntentState {
  const filePath = resolveAoiIntentStatePath(sessionsDir, state.sessionPath);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return state;
}

export function loadAoiIntentState(
  sessionsDir: string,
  sessionPath: string,
): AoiIntentState | null {
  try {
    const filePath = resolveAoiIntentStatePath(sessionsDir, sessionPath);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<AoiIntentState>;
    if (
      !raw ||
      raw.version !== 1 ||
      typeof raw.generatedAt !== 'number' ||
      typeof raw.staleAt !== 'number' ||
      raw.actionAuthority !== 'display_only' ||
      raw.mutationCount !== 0
    ) {
      return null;
    }
    return raw as AoiIntentState;
  } catch {
    // Fail closed: an unreadable intent state is no intent state.
    return null;
  }
}
