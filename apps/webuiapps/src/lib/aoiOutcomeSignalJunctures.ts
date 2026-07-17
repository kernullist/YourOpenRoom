import type { AoiOutcomeSignalInput } from './aoiAutonomyClient';

// P1.1 (client half): build the outcome signal a real UI juncture should emit.
//
// The outcome->trust consumption path already maps each outcomeKind to a full
// learning policy (confidence, boost/suppress target, magnitude) in
// aoiOutcomeLearning.defaultPolicy. So the CLIENT only has to report the
// juncture + attribution refs; it must NOT invent confidence/signalKind. These
// builders are pure and return a stable dedup key alongside the input, so the
// UI can fire each signal at most once per subject without threading dedup logic
// through the component.
//
// The three junctures are all weak/negative engagement signals:
//   * proposal_opened      -- weak interest boost on the topic
//   * proposal_ignored     -- soft timing suppression
//   * direct_chat_dismissed -- stronger timing suppression
// None of them promotes autonomy; they only tune interest/timing. Emission is
// best-effort at the call site (a failed POST must never break the UI).

export interface AoiOutcomeJunctureSignal {
  // Stable per-subject key; the caller claims it once so a re-render or repeated
  // click cannot double-report the same juncture for the same subject.
  key: string;
  input: AoiOutcomeSignalInput;
}

// Minimal structural shapes -- kept local so this module does not couple to the
// full proposal / trend-card types (both are structurally compatible).
export interface AoiProposalJunctureSubject {
  id: string;
  cooldownKey?: string;
}

export interface AoiDirectChatJunctureSubject {
  id: string;
  topicId?: string;
  evidenceRefs?: string[];
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildAoiProposalOpenedSignal(
  proposal: AoiProposalJunctureSubject,
): AoiOutcomeJunctureSignal | null {
  const proposalId = trimmed(proposal?.id);
  if (!proposalId) {
    return null;
  }
  const topicKey = trimmed(proposal.cooldownKey);
  const key = `proposal_opened:${proposalId}`;
  return {
    key,
    input: {
      eventId: key,
      outcomeKind: 'proposal_opened',
      sourceProposalId: proposalId,
      ...(topicKey ? { topicKey } : {}),
    },
  };
}

export function buildAoiProposalIgnoredSignal(
  proposal: AoiProposalJunctureSubject,
  opts: { decisionId?: string } = {},
): AoiOutcomeJunctureSignal | null {
  const proposalId = trimmed(proposal?.id);
  if (!proposalId) {
    return null;
  }
  const topicKey = trimmed(proposal.cooldownKey);
  const decisionId = trimmed(opts.decisionId);
  const key = `proposal_ignored:${proposalId}`;
  return {
    key,
    input: {
      eventId: key,
      outcomeKind: 'proposal_ignored',
      sourceProposalId: proposalId,
      ...(decisionId ? { sourceDecisionId: decisionId } : {}),
      ...(topicKey ? { topicKey } : {}),
    },
  };
}

export function buildAoiDirectChatDismissedSignal(
  card: AoiDirectChatJunctureSubject,
): AoiOutcomeJunctureSignal | null {
  const cardId = trimmed(card?.id);
  if (!cardId) {
    return null;
  }
  const topicKey = trimmed(card.topicId);
  const evidenceRefs = Array.isArray(card.evidenceRefs)
    ? card.evidenceRefs
        .filter((ref) => typeof ref === 'string' && ref.trim().length > 0)
        .slice(0, 8)
    : [];
  const key = `direct_chat_dismissed:${cardId}`;
  return {
    key,
    input: {
      eventId: key,
      outcomeKind: 'direct_chat_dismissed',
      sourceChatRef: cardId,
      ...(topicKey ? { topicKey } : {}),
      ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    },
  };
}

export interface AoiOutcomeJunctureTracker {
  // Returns true exactly once per key (the first claim). Subsequent claims of the
  // same key return false. Used to make each juncture emit at most once.
  claim(key: string): boolean;
  has(key: string): boolean;
  size(): number;
}

export function createAoiOutcomeJunctureTracker(): AoiOutcomeJunctureTracker {
  const seen = new Set<string>();
  return {
    claim(key: string): boolean {
      if (typeof key !== 'string' || key.length === 0 || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    },
    has(key: string): boolean {
      return seen.has(key);
    },
    size(): number {
      return seen.size;
    },
  };
}
