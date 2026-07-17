import { describe, expect, it } from 'vitest';

import {
  buildAoiDirectChatDismissedSignal,
  buildAoiProposalIgnoredSignal,
  buildAoiProposalOpenedSignal,
  createAoiOutcomeJunctureTracker,
} from '../aoiOutcomeSignalJunctures';

describe('buildAoiProposalOpenedSignal', () => {
  it('builds a proposal_opened signal keyed by proposal id, carrying the topic', () => {
    const signal = buildAoiProposalOpenedSignal({ id: 'prop-1', cooldownKey: 'topic-a' });
    expect(signal).toEqual({
      key: 'proposal_opened:prop-1',
      input: {
        eventId: 'proposal_opened:prop-1',
        outcomeKind: 'proposal_opened',
        sourceProposalId: 'prop-1',
        topicKey: 'topic-a',
      },
    });
  });

  it('omits topicKey when the proposal has no cooldownKey', () => {
    const signal = buildAoiProposalOpenedSignal({ id: 'prop-2' });
    expect(signal?.input).toEqual({
      eventId: 'proposal_opened:prop-2',
      outcomeKind: 'proposal_opened',
      sourceProposalId: 'prop-2',
    });
  });

  it('returns null when the proposal id is missing or blank', () => {
    expect(buildAoiProposalOpenedSignal({ id: '' })).toBeNull();
    expect(buildAoiProposalOpenedSignal({ id: '   ' })).toBeNull();
  });
});

describe('buildAoiProposalIgnoredSignal', () => {
  it('builds a proposal_ignored signal with an optional decision ref', () => {
    const signal = buildAoiProposalIgnoredSignal(
      { id: 'prop-3', cooldownKey: 'topic-b' },
      { decisionId: 'dec-9' },
    );
    expect(signal).toEqual({
      key: 'proposal_ignored:prop-3',
      input: {
        eventId: 'proposal_ignored:prop-3',
        outcomeKind: 'proposal_ignored',
        sourceProposalId: 'prop-3',
        sourceDecisionId: 'dec-9',
        topicKey: 'topic-b',
      },
    });
  });

  it('omits the decision ref when not provided', () => {
    const signal = buildAoiProposalIgnoredSignal({ id: 'prop-4' });
    expect(signal?.input).toEqual({
      eventId: 'proposal_ignored:prop-4',
      outcomeKind: 'proposal_ignored',
      sourceProposalId: 'prop-4',
    });
  });

  it('returns null when the proposal id is missing', () => {
    expect(buildAoiProposalIgnoredSignal({ id: '' }, { decisionId: 'x' })).toBeNull();
  });
});

describe('buildAoiDirectChatDismissedSignal', () => {
  it('builds a direct_chat_dismissed signal keyed by card id, carrying topic + evidence', () => {
    const signal = buildAoiDirectChatDismissedSignal({
      id: 'card-1',
      topicId: 'ue5-nanite',
      evidenceRefs: ['ref-a', 'ref-b'],
    });
    expect(signal).toEqual({
      key: 'direct_chat_dismissed:card-1',
      input: {
        eventId: 'direct_chat_dismissed:card-1',
        outcomeKind: 'direct_chat_dismissed',
        sourceChatRef: 'card-1',
        topicKey: 'ue5-nanite',
        evidenceRefs: ['ref-a', 'ref-b'],
      },
    });
  });

  it('drops blank evidence refs and caps at 8', () => {
    const signal = buildAoiDirectChatDismissedSignal({
      id: 'card-2',
      evidenceRefs: ['', '  ', 'keep', ...Array.from({ length: 10 }, (_, i) => `r${i}`)],
    });
    expect(signal?.input.evidenceRefs).toHaveLength(8);
    expect(signal?.input.evidenceRefs).toContain('keep');
    expect(signal?.input.evidenceRefs).not.toContain('');
  });

  it('omits evidenceRefs entirely when none survive', () => {
    const signal = buildAoiDirectChatDismissedSignal({ id: 'card-3', evidenceRefs: ['', '  '] });
    expect(signal?.input).toEqual({
      eventId: 'direct_chat_dismissed:card-3',
      outcomeKind: 'direct_chat_dismissed',
      sourceChatRef: 'card-3',
    });
  });

  it('returns null when the card id is missing', () => {
    expect(buildAoiDirectChatDismissedSignal({ id: '' })).toBeNull();
  });
});

describe('createAoiOutcomeJunctureTracker', () => {
  it('claims a key exactly once', () => {
    const tracker = createAoiOutcomeJunctureTracker();
    expect(tracker.claim('k1')).toBe(true);
    expect(tracker.claim('k1')).toBe(false);
    expect(tracker.has('k1')).toBe(true);
    expect(tracker.size()).toBe(1);
  });

  it('claims distinct keys independently', () => {
    const tracker = createAoiOutcomeJunctureTracker();
    expect(tracker.claim('a')).toBe(true);
    expect(tracker.claim('b')).toBe(true);
    expect(tracker.size()).toBe(2);
  });

  it('never claims an empty or non-string key', () => {
    const tracker = createAoiOutcomeJunctureTracker();
    expect(tracker.claim('')).toBe(false);
    expect(tracker.claim(undefined as unknown as string)).toBe(false);
    expect(tracker.size()).toBe(0);
  });
});
