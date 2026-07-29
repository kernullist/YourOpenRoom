// Milestone derivation (R3.3): the events a partner remembers -- the first
// meeting, the hundredth session, the day trust was raised, the first proposal
// that was accepted.
//
// Pure: this decides which milestones SHOULD exist given real counters, and the
// store's append is id-keyed, so re-deriving the same milestone is a no-op. That
// split is deliberate -- derivation can run on every session open without
// producing duplicates, and every milestone traces back to a counter rather than
// to a guess.
//
// Honesty rules:
// - Only crossings backed by a real counter are emitted. An absent input yields
//   no milestone rather than an assumed one.
// - Trust milestones are recorded per level, so a promotion is remembered once
//   and a later demotion never erases that it happened.
// - Labels are plain factual English (audit register); the companion phrasing
//   for the user lives in aoiCompanionVoice.

import type { AoiRelationshipMilestoneKind } from './aoiRelationshipState';

export interface AoiRelationshipMilestoneCandidate {
  id: string;
  kind: AoiRelationshipMilestoneKind;
  label: string;
  evidenceRefs: string[];
}

export interface DeriveAoiRelationshipMilestonesInput {
  sessionCount: number;
  // Current autonomy level, e.g. 'L3'. Absent -> no trust milestone.
  autonomyLevel?: string | null;
  // How many proposals the user has accepted. Absent -> no first-accept
  // milestone (0 is a real answer meaning "none yet").
  acceptedProposalCount?: number | null;
}

// Session counts worth remarking on. Deliberately sparse: a milestone every few
// sessions would stop meaning anything.
export const AOI_SESSION_COUNT_MILESTONES = [10, 25, 50, 100, 250, 500, 1000];

// Levels worth remembering as trust events. L1 is the default starting point, so
// it is not an achievement, and L5 is only ever reachable by an explicit human
// decision -- which makes it the most meaningful one to keep.
const TRUST_MILESTONE_LEVELS = new Set(['L2', 'L3', 'L4', 'L5']);

function sessionCountMilestone(sessionCount: number): AoiRelationshipMilestoneCandidate | null {
  if (!Number.isFinite(sessionCount)) {
    return null;
  }
  const crossed = AOI_SESSION_COUNT_MILESTONES.filter(
    (threshold) => Math.floor(sessionCount) >= threshold,
  );
  const highest = crossed[crossed.length - 1];
  if (highest === undefined) {
    return null;
  }
  return {
    id: `session_count:${highest}`,
    kind: 'session_count',
    label: `We reached ${highest} sessions together.`,
    evidenceRefs: [`relationship:session_count:${highest}`],
  };
}

function trustMilestone(
  autonomyLevel: string | null | undefined,
): AoiRelationshipMilestoneCandidate | null {
  const level = (autonomyLevel ?? '').trim().toUpperCase();
  if (!TRUST_MILESTONE_LEVELS.has(level)) {
    return null;
  }
  return {
    id: `trust_promoted:${level}`,
    kind: 'trust_promoted',
    label: `Trust was raised to ${level}.`,
    evidenceRefs: [`policy:autonomy_level:${level}`],
  };
}

function firstAcceptedProposalMilestone(
  acceptedProposalCount: number | null | undefined,
): AoiRelationshipMilestoneCandidate | null {
  if (typeof acceptedProposalCount !== 'number' || !Number.isFinite(acceptedProposalCount)) {
    return null;
  }
  if (acceptedProposalCount < 1) {
    return null;
  }
  return {
    id: 'first_accepted_proposal',
    kind: 'first_accepted_proposal',
    label: 'You accepted one of my proposals for the first time.',
    evidenceRefs: ['relationship:first_accepted_proposal'],
  };
}

// Only the highest crossed session threshold is emitted per call: catching up on
// a long history should not backfill every threshold at once, and the earlier
// ones are already recorded if they were ever live.
export function deriveAoiRelationshipMilestones(
  input: DeriveAoiRelationshipMilestonesInput,
): AoiRelationshipMilestoneCandidate[] {
  return [
    sessionCountMilestone(input.sessionCount),
    trustMilestone(input.autonomyLevel),
    firstAcceptedProposalMilestone(input.acceptedProposalCount),
  ].filter((item): item is AoiRelationshipMilestoneCandidate => item !== null);
}
