// Weekly retrospective (R4.1): the first producer of a 'reflection' relation
// node, and the first "our week" narrative in the system.
//
// Before this, nothing looked back over a span of time. The operator digest
// counts a live inbox ("2 approvals waiting"), the timeline is an event log, and
// the 'reflection' node kind existed with zero producers. A partnership needs a
// story of what was done together, not a queue depth.
//
// Composition rules (load-bearing):
// - DETERMINISTIC FLOOR. Everything here is derived from records that already
//   exist; there is no LLM in this module. R4's optional polish layer may
//   rewrite the narrative later, but this text is what ships when it does not.
// - EVIDENCE OR SILENCE. Each line comes from a real outcome, milestone or
//   thread and carries its refs. An empty week produces an explicitly empty
//   retrospective rather than filler.
// - WINDOWED. Only records inside the period are considered, so a retrospective
//   is about that week and not about all history.
// - display_only / mutationCount 0, like every other observation record.
// - Text is neutral English (audit register); the companion phrasing for
//   delivery lives in aoiCompanionVoice.

import type { AoiOutcomeSignalRecord } from './aoiAutonomyTypes';
import type { AoiRelationshipMilestone, AoiRelationshipOpenThread } from './aoiRelationshipState';

export const AOI_RETROSPECTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_LINES_PER_SECTION = 5;
const MAX_LINE_CHARS = 160;
const MAX_EVIDENCE_REFS = 16;
const MAX_NARRATIVE_CHARS = 700;

// Outcomes that represent something reaching a real end state. proposal_opened /
// direct_chat_dismissed are attention signals, not work, so they are not part of
// the story of what got done.
const SHIPPED_KINDS = new Set<AoiOutcomeSignalRecord['outcomeKind']>([
  'work_order_approved',
  'validation_run',
  'commit_created',
  'proposal_executed',
]);

const STUCK_RESULTS = new Set<AoiOutcomeSignalRecord['result']>(['negative', 'blocked', 'failed']);

export interface AoiWeeklyRetrospectiveResearchRun {
  id: string;
  label: string;
  completedAt: number;
}

export interface BuildAoiWeeklyRetrospectiveInput {
  sessionPath: string;
  now: number;
  windowMs?: number;
  outcomeSignals?: AoiOutcomeSignalRecord[];
  milestones?: AoiRelationshipMilestone[];
  openThreads?: AoiRelationshipOpenThread[];
  researchRuns?: AoiWeeklyRetrospectiveResearchRun[];
  sessionCount?: number;
}

export interface AoiWeeklyRetrospective {
  version: 1;
  id: string;
  sessionPath: string;
  periodStart: number;
  periodEnd: number;
  shipped: string[];
  stuck: string[];
  researched: string[];
  milestones: string[];
  openNext: string[];
  sessionCount: number;
  narrative: string;
  empty: boolean;
  evidenceRefs: string[];
  relationRef: string;
  actionAuthority: 'display_only';
  mutationCount: 0;
  synthesizedBy: 'deterministic' | 'llm';
  createdAt: number;
}

function cap(value: string, maxChars = MAX_LINE_CHARS): string {
  const collapsed = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function inWindow(timestamp: number, start: number, end: number): boolean {
  return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
}

function describeOutcome(record: AoiOutcomeSignalRecord): string {
  const subject =
    record.topicKey ||
    record.sourceCommitRef ||
    record.sourceValidationRef ||
    record.sourceWorkOrderId ||
    record.sourceProposalId ||
    'unlabelled work';
  const kind = record.outcomeKind.replace(/_/g, ' ');
  return cap(`${kind}: ${subject}`);
}

function describeStuck(record: AoiOutcomeSignalRecord): string {
  const reason = record.explicitCorrection || record.explicitLabel || record.result;
  return cap(`${describeOutcome(record)} (${reason})`);
}

// A deterministic paragraph. Deliberately plain: it is the floor an optional
// LLM pass has to beat, and it must never imply more happened than the records
// show.
function buildNarrative(params: {
  shipped: string[];
  stuck: string[];
  researched: string[];
  milestones: string[];
  openNext: string[];
  sessionCount: number;
}): string {
  const parts: string[] = [];
  if (params.sessionCount > 0) {
    parts.push(`We worked together in ${params.sessionCount} session(s) this period.`);
  }
  if (params.shipped.length > 0) {
    parts.push(`Reached an end state: ${params.shipped.length} item(s).`);
  }
  if (params.stuck.length > 0) {
    parts.push(`Did not land: ${params.stuck.length} item(s).`);
  }
  if (params.researched.length > 0) {
    parts.push(`I looked into ${params.researched.length} topic(s) on my own.`);
  }
  if (params.milestones.length > 0) {
    parts.push(`Milestones: ${params.milestones.join('; ')}.`);
  }
  if (params.openNext.length > 0) {
    parts.push(`Still open next period: ${params.openNext.join('; ')}.`);
  }
  if (parts.length === 0) {
    return 'Nothing recorded for this period.';
  }
  return cap(parts.join(' '), MAX_NARRATIVE_CHARS);
}

export function buildAoiWeeklyRetrospective(
  input: BuildAoiWeeklyRetrospectiveInput,
): AoiWeeklyRetrospective {
  const periodEnd = input.now;
  const periodStart = periodEnd - (input.windowMs ?? AOI_RETROSPECTIVE_WINDOW_MS);
  const signals = (input.outcomeSignals ?? []).filter((record) =>
    inWindow(record.createdAt, periodStart, periodEnd),
  );

  const shippedRecords = signals.filter(
    (record) => SHIPPED_KINDS.has(record.outcomeKind) && !STUCK_RESULTS.has(record.result),
  );
  const stuckRecords = signals.filter((record) => STUCK_RESULTS.has(record.result));

  const shipped = shippedRecords.slice(0, MAX_LINES_PER_SECTION).map(describeOutcome);
  const stuck = stuckRecords.slice(0, MAX_LINES_PER_SECTION).map(describeStuck);
  const researched = (input.researchRuns ?? [])
    .filter((run) => inWindow(run.completedAt, periodStart, periodEnd))
    .slice(0, MAX_LINES_PER_SECTION)
    .map((run) => cap(run.label));
  const periodMilestones = (input.milestones ?? []).filter((milestone) =>
    inWindow(milestone.occurredAt, periodStart, periodEnd),
  );
  const milestones = periodMilestones
    .slice(0, MAX_LINES_PER_SECTION)
    .map((item) => cap(item.label));
  // Threads carry forward regardless of when they were noticed: an unresolved
  // thread is still open next period even if it started before this one.
  const openNext = (input.openThreads ?? [])
    .slice(0, MAX_LINES_PER_SECTION)
    .map((thread) => cap(thread.title));

  const sessionCount =
    typeof input.sessionCount === 'number' && Number.isFinite(input.sessionCount)
      ? Math.max(0, Math.floor(input.sessionCount))
      : 0;

  const evidenceRefs = [
    ...shippedRecords.flatMap((record) => record.evidenceRefs),
    ...stuckRecords.flatMap((record) => record.evidenceRefs),
    ...periodMilestones.flatMap((milestone) => milestone.evidenceRefs),
    ...(input.researchRuns ?? [])
      .filter((run) => inWindow(run.completedAt, periodStart, periodEnd))
      .map((run) => `research:${run.id}`),
  ];
  const dedupedEvidence = [...new Set(evidenceRefs.filter(Boolean))].slice(0, MAX_EVIDENCE_REFS);

  const empty =
    shipped.length === 0 &&
    stuck.length === 0 &&
    researched.length === 0 &&
    milestones.length === 0 &&
    openNext.length === 0;

  const id = `aoi-retro-${periodStart}-${periodEnd}`;
  return {
    version: 1,
    id,
    sessionPath: input.sessionPath,
    periodStart,
    periodEnd,
    shipped,
    stuck,
    researched,
    milestones,
    openNext,
    sessionCount,
    narrative: buildNarrative({ shipped, stuck, researched, milestones, openNext, sessionCount }),
    empty,
    evidenceRefs: dedupedEvidence,
    // The ref that makes this the first real 'reflection' relation node.
    relationRef: `reflection:${id}`,
    actionAuthority: 'display_only',
    mutationCount: 0,
    synthesizedBy: 'deterministic',
    createdAt: input.now,
  };
}
