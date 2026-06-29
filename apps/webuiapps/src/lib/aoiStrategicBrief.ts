// Aoi strategic brief (P1a continuous reasoning, commit 1: deterministic loop).
//
// At the END of each autonomy tick the engine synthesizes a small continuity
// note from that tick's signals (accepted/blocked proposals + outcomes +
// observations + mission focus) and persists it. At the START of the next tick
// the engine loads it and folds its focus line into the recall focus query, so
// an otherwise-idle background tick recalls memory about what Aoi was last
// working on instead of an empty/placeholder query.
//
// Server-only (fs/crypto). Pure synthesis + focus composition are exported
// separately so they are unit-testable without the filesystem. Every text field
// is sanitized/redacted because the brief is re-injected into later recall (and,
// in commit 2, the LLM reflection prompt) and must not carry raw instructions or
// secrets sourced from observation/memory content.
import * as fs from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import type {
  AoiAutonomyBlockedProposal,
  AoiAutonomyTickReason,
  AoiKiraOutcomeEvent,
  AoiMissionState,
  AoiObservation,
  AoiProposal,
  AoiStrategicBrief,
} from './aoiAutonomyTypes';

const AUTONOMY_ROOT_DIR = 'aoi-autonomy';
const BRIEF_FILE_NAME = 'strategic-brief.json';
const FOCUS_MAX_CHARS = 180;
const THREAD_MAX_CHARS = 160;
const CONTINUITY_FOCUS_MAX_CHARS = 240;
const MAX_LIST_ITEMS = 5;
const MAX_EVIDENCE_REFS = 16;
const MISSION_PLACEHOLDER_FOCUS = 'No active mission.';

const TICK_REASONS: ReadonlySet<string> = new Set([
  'manual',
  'turn',
  'periodic',
  'research_run',
  'kira',
  'proposal',
  'memory',
  'app',
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// Redact secrets + strip source-embedded instructions BEFORE truncation, so the
// persisted/re-injected text mirrors the operator-digest sanitizer exactly.
function sanitizeText(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value)),
  );
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function clampFocus(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= CONTINUITY_FOCUS_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, CONTINUITY_FOCUS_MAX_CHARS - 1)).trimEnd()}...`;
}

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = sanitizeText(item, THREAD_MAX_CHARS);
    if (normalized) {
      out.push(normalized);
    }
    if (out.length >= MAX_LIST_ITEMS) {
      break;
    }
  }
  return out;
}

function normalizeRefList(value: unknown): string[] {
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
    if (seen.size >= MAX_EVIDENCE_REFS) {
      break;
    }
  }
  return [...seen];
}

function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

function toTickReason(value: unknown): AoiAutonomyTickReason {
  return typeof value === 'string' && TICK_REASONS.has(value)
    ? (value as AoiAutonomyTickReason)
    : 'periodic';
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function resolveBriefFile(
  sessionsDir: string,
  sessionPath: string,
): { sessionPath: string; filePath: string } {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsRoot = resolve(sessionsDir);
  const filePath = resolve(sessionsRoot, normalizedSessionPath, AUTONOMY_ROOT_DIR, BRIEF_FILE_NAME);
  if (!isPathInsideRoot(sessionsRoot, filePath)) {
    throw new Error('Resolved Aoi strategic brief path escaped the sessions directory.');
  }
  return { sessionPath: normalizedSessionPath, filePath };
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

function missionFocusOrEmpty(mission: AoiMissionState | null | undefined): string {
  if (!mission || mission.status === 'none' || mission.status === 'completed') {
    return '';
  }
  const focus = sanitizeText(mission.focusSummary || '', FOCUS_MAX_CHARS);
  return focus === MISSION_PLACEHOLDER_FOCUS ? '' : focus;
}

export interface AoiStrategicBriefSynthesisInput {
  sessionPath: string;
  now: number;
  reason: AoiAutonomyTickReason;
  acceptedProposals: AoiProposal[];
  blockedProposals: AoiAutonomyBlockedProposal[];
  observations: AoiObservation[];
  outcomes: AoiKiraOutcomeEvent[];
  mission?: AoiMissionState | null;
}

// Deterministic brief synthesis. Pure: no filesystem, no clock, no network.
export function synthesizeAoiStrategicBrief(
  input: AoiStrategicBriefSynthesisInput,
): AoiStrategicBrief {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath) || input.sessionPath;

  const openThreads = input.acceptedProposals
    .map((proposal) => sanitizeText(proposal.title, THREAD_MAX_CHARS))
    .filter((title) => title.length > 0)
    .slice(0, MAX_LIST_ITEMS);

  const blockedThreads = input.blockedProposals
    .map((proposal) => {
      const title = sanitizeText(proposal.title, 100);
      const reason = proposal.reasons[0] ? sanitizeText(proposal.reasons[0], 80) : '';
      if (!title) {
        return '';
      }
      return reason ? `${title} -- ${reason}` : title;
    })
    .filter((line) => line.length > 0)
    .slice(0, MAX_LIST_ITEMS);

  const recentOutcomes = input.outcomes
    .map((outcome) => {
      const title = sanitizeText(outcome.workTitle, 90);
      const detail = sanitizeText(outcome.validationSummary || '', 90);
      if (!title) {
        return detail;
      }
      return detail ? `${title}: ${detail}` : title;
    })
    .filter((line) => line.length > 0)
    .slice(0, MAX_LIST_ITEMS);

  // Skip the synthetic latest-user-message echo: it is the user's own input, not
  // a continuity signal, and is already the strongest recall driver on its own.
  const meaningfulObservations = input.observations.filter(
    (observation) => observation.id !== 'latest-user-message',
  );
  const observationHighlights = meaningfulObservations
    .slice(0, MAX_LIST_ITEMS * 2)
    .map((observation) => sanitizeText(observation.summary, THREAD_MAX_CHARS))
    .filter((summary) => summary.length > 0)
    .slice(0, MAX_LIST_ITEMS);

  const evidenceRefs = normalizeRefList([
    ...input.acceptedProposals.map((proposal) => `proposal:${proposal.id}`),
    ...input.blockedProposals.map((proposal) => `proposal:${proposal.proposalId}`),
    ...input.outcomes.flatMap((outcome) => outcome.evidenceRefs),
    ...meaningfulObservations.map((observation) => `observation:${observation.id}`),
  ]);

  // Focus priority: what Aoi just decided to pursue, then what is blocked, then a
  // fresh outcome, then the active mission, then a notable observation.
  const missionFocus = missionFocusOrEmpty(input.mission);
  const focusSummary = sanitizeText(
    openThreads[0]
      ? `Pursuing: ${openThreads[0]}`
      : blockedThreads[0]
        ? `Blocked: ${blockedThreads[0]}`
        : recentOutcomes[0]
          ? `Outcome: ${recentOutcomes[0]}`
          : missionFocus
            ? missionFocus
            : observationHighlights[0]
              ? observationHighlights[0]
              : 'No active threads.',
    FOCUS_MAX_CHARS,
  );

  return {
    version: 1,
    sessionPath,
    generatedAt: input.now,
    tickReason: input.reason,
    focusSummary,
    openThreads,
    blockedThreads,
    recentOutcomes,
    observationHighlights,
    evidenceRefs,
    acceptedCount: input.acceptedProposals.length,
    blockedCount: input.blockedProposals.length,
    observationCount: input.observations.length,
    synthesizedBy: 'deterministic',
  };
}

// Compose the next tick's recall focus query from the live mission, the latest
// user message, and the previous tick's brief. Pure. When no brief exists this
// reduces EXACTLY to the prior `mission.focusSummary || latestUserMessage`
// behavior, so the loop is byte-identical until a brief has been persisted.
export function buildAoiContinuityFocus(input: {
  mission?: AoiMissionState | null;
  latestUserMessage?: string;
  brief?: AoiStrategicBrief | null;
}): string {
  const missionFocus = normalizeWhitespace(input.mission?.focusSummary || '');
  const userMessage = normalizeWhitespace(input.latestUserMessage || '');
  // Prior precedence, preserved exactly for the no-brief path.
  const current = missionFocus || userMessage;
  const briefFocus = normalizeWhitespace(input.brief?.focusSummary || '');
  if (!briefFocus) {
    return current;
  }
  const missionIsIdle =
    !input.mission ||
    input.mission.status === 'none' ||
    input.mission.status === 'completed' ||
    missionFocus === '' ||
    missionFocus === MISSION_PLACEHOLDER_FOCUS;
  // Strongest real (non-placeholder) signal this tick: an active mission focus,
  // else the latest user message. The idle mission placeholder is treated as
  // empty so it never leaks ahead of the brief.
  const primary = missionIsIdle ? userMessage : missionFocus;
  if (primary) {
    // A real mission or a user message stays primary; the brief is appended as
    // continuity.
    return clampFocus(`${primary} ${briefFocus}`);
  }
  // Idle background tick with no user message: the brief leads (the P1a win --
  // the loop recalls against what it was working on, not a placeholder).
  return briefFocus;
}

export function normalizeAoiStrategicBrief(
  raw: unknown,
  sessionPath: string,
): AoiStrategicBrief | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Partial<AoiStrategicBrief>;
  return {
    version: 1,
    sessionPath,
    generatedAt:
      typeof value.generatedAt === 'number' && Number.isFinite(value.generatedAt)
        ? value.generatedAt
        : 0,
    tickReason: toTickReason(value.tickReason),
    focusSummary: sanitizeText(
      typeof value.focusSummary === 'string' ? value.focusSummary : '',
      FOCUS_MAX_CHARS,
    ),
    openThreads: normalizeTextList(value.openThreads),
    blockedThreads: normalizeTextList(value.blockedThreads),
    recentOutcomes: normalizeTextList(value.recentOutcomes),
    observationHighlights: normalizeTextList(value.observationHighlights),
    evidenceRefs: normalizeRefList(value.evidenceRefs),
    acceptedCount: toCount(value.acceptedCount),
    blockedCount: toCount(value.blockedCount),
    observationCount: toCount(value.observationCount),
    synthesizedBy: value.synthesizedBy === 'llm' ? 'llm' : 'deterministic',
  };
}

export function loadAoiStrategicBrief(
  sessionsDir: string,
  sessionPath: string,
): AoiStrategicBrief | null {
  const resolved = resolveBriefFile(sessionsDir, sessionPath);
  return normalizeAoiStrategicBrief(readJson<unknown>(resolved.filePath), resolved.sessionPath);
}

export function saveAoiStrategicBrief(
  sessionsDir: string,
  sessionPath: string,
  brief: AoiStrategicBrief,
): AoiStrategicBrief {
  const resolved = resolveBriefFile(sessionsDir, sessionPath);
  const normalized = normalizeAoiStrategicBrief(brief, resolved.sessionPath);
  if (!normalized) {
    throw new Error('Invalid Aoi strategic brief.');
  }
  writeJsonAtomic(resolved.filePath, normalized);
  return normalized;
}
