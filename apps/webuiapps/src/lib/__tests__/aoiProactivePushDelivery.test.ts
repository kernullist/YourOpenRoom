import { describe, expect, it } from 'vitest';

import {
  appendAoiProactivePushRecord,
  buildAoiProactivePushDeepLink,
  decideAoiProactivePushDelivery,
  markAoiProactivePushRecordConsumed,
  selectPendingAoiProactivePushRecords,
  type AoiProactivePushCandidate,
  type AoiProactivePushDeliveryRecord,
} from '../aoiProactivePushDelivery';

const NOW = 1_800_000_000_000;

function candidate(partial: Partial<AoiProactivePushCandidate> = {}): AoiProactivePushCandidate {
  return {
    id: 'card-1',
    sessionPath: 'aoi/default',
    title: 'A fresh trend worth surfacing',
    deliveryMode: 'direct_chat',
    directChatAllowed: true,
    risk: 'low',
    deepLinkRef: 'trend:re-001',
    ...partial,
  };
}

describe('decideAoiProactivePushDelivery (P2.1)', () => {
  it('emits a display-only record when every gate passes', () => {
    const decision = decideAoiProactivePushDelivery({
      candidate: candidate(),
      pushOptIn: true,
      budgetAllowed: true,
      now: NOW,
    });
    expect(decision.eligible).toBe(true);
    expect(decision.blockReasons).toEqual([]);
    expect(decision.record).toMatchObject({
      id: 'card-1',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(decision.record?.deepLink).toContain('openroom://aoi/aoi/default');
  });

  it('fails closed without an explicit push opt-in', () => {
    const decision = decideAoiProactivePushDelivery({
      candidate: candidate(),
      pushOptIn: false,
      budgetAllowed: true,
      now: NOW,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.blockReasons).toContain('push_not_opted_in');
    expect(decision.record).toBeNull();
  });

  it('blocks a non-direct-chat card, a disallowed card, a high-risk card, and an exhausted budget', () => {
    expect(
      decideAoiProactivePushDelivery({
        candidate: candidate({ deliveryMode: 'dashboard' }),
        pushOptIn: true,
        budgetAllowed: true,
        now: NOW,
      }).blockReasons,
    ).toContain('not_direct_chat');

    expect(
      decideAoiProactivePushDelivery({
        candidate: candidate({ directChatAllowed: false }),
        pushOptIn: true,
        budgetAllowed: true,
        now: NOW,
      }).blockReasons,
    ).toContain('direct_chat_not_allowed');

    expect(
      decideAoiProactivePushDelivery({
        candidate: candidate({ risk: 'high' }),
        pushOptIn: true,
        budgetAllowed: true,
        now: NOW,
      }).blockReasons,
    ).toContain('high_risk');

    expect(
      decideAoiProactivePushDelivery({
        candidate: candidate(),
        pushOptIn: true,
        budgetAllowed: false,
        now: NOW,
      }).blockReasons,
    ).toContain('daily_budget_exhausted');
  });

  it('sanitizes the title (redacts secrets, strips instructions)', () => {
    const decision = decideAoiProactivePushDelivery({
      candidate: candidate({
        title: 'secret -----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY----- trend',
      }),
      pushOptIn: true,
      budgetAllowed: true,
      now: NOW,
    });
    expect(decision.record?.title).not.toContain('BEGIN PRIVATE KEY');
  });
});

describe('buildAoiProactivePushDeepLink (P2.1)', () => {
  it('slug-sanitizes the session + ref so a hostile ref cannot break the link', () => {
    const link = buildAoiProactivePushDeepLink('aoi/default', 'trend:re-001" onclick=x');
    expect(link).toBe('openroom://aoi/aoi/default?card=trend:re-001onclickx');
  });
});

describe('proactive push queue (P2.1)', () => {
  function record(id: string, consumed?: number): AoiProactivePushDeliveryRecord {
    return {
      version: 1,
      id,
      sessionPath: 'aoi/default',
      title: id,
      deepLink: buildAoiProactivePushDeepLink('aoi/default', id),
      createdAt: NOW,
      actionAuthority: 'display_only',
      mutationCount: 0,
      ...(consumed !== undefined ? { consumedAt: consumed } : {}),
    };
  }

  it('appends de-duplicated by id and caps the queue', () => {
    let queue = appendAoiProactivePushRecord([], record('a'));
    queue = appendAoiProactivePushRecord(queue, record('b'));
    queue = appendAoiProactivePushRecord(queue, record('a')); // refresh, not duplicate
    expect(queue.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('selects only unconsumed records, and marking one consumed removes it from pending', () => {
    const queue = [record('a'), record('b', NOW)];
    expect(selectPendingAoiProactivePushRecords(queue).map((r) => r.id)).toEqual(['a']);
    const afterConsume = markAoiProactivePushRecordConsumed(queue, 'a', NOW + 1);
    expect(selectPendingAoiProactivePushRecords(afterConsume)).toEqual([]);
  });
});
