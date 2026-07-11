import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { runAoiProactivePushForSession } from '../aoiProactivePushSession';
import { loadAoiProactivePushQueue } from '../aoiAutonomyStore';
import type { AoiProactivePushCandidate } from '../aoiProactivePushDelivery';
import type { AoiProactivePushTransport } from '../aoiProactivePushTransport';

const NOW = 1_800_000_000_000;
const SESSION = 'aoi/default';
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'aoi-push-session-')));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function candidate(partial: Partial<AoiProactivePushCandidate> = {}): AoiProactivePushCandidate {
  return {
    id: 'card-1',
    sessionPath: SESSION,
    title: 'A trend moved',
    deliveryMode: 'direct_chat',
    directChatAllowed: true,
    risk: 'low',
    deepLinkRef: 'card-1',
    ...partial,
  };
}

const delivering: AoiProactivePushTransport = {
  async send() {
    return { delivered: true };
  },
};

describe('runAoiProactivePushForSession (P2.1 pipeline)', () => {
  it('appends nothing when push is not opted in (fail closed) and persists an empty queue', async () => {
    const root = makeRoot();
    const result = await runAoiProactivePushForSession({
      sessionsDir: root,
      sessionPath: SESSION,
      candidates: [candidate()],
      pushOptIn: false,
      budgetAllowed: true,
      transport: delivering,
      now: NOW,
    });
    expect(result.appended).toEqual([]);
    expect(result.rejected[0]?.reasons).toContain('push_not_opted_in');
    expect(loadAoiProactivePushQueue(root, SESSION)).toEqual([]);
  });

  it('appends an eligible candidate, delivers it, and persists the consumed queue', async () => {
    const root = makeRoot();
    const result = await runAoiProactivePushForSession({
      sessionsDir: root,
      sessionPath: SESSION,
      candidates: [candidate()],
      pushOptIn: true,
      budgetAllowed: true,
      transport: delivering,
      now: NOW,
    });
    expect(result.appended).toHaveLength(1);
    expect(result.delivered).toHaveLength(1);
    const persisted = loadAoiProactivePushQueue(root, SESSION);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].consumedAt).toBe(NOW);
  });

  it('keeps an appended record PENDING when the (inert) transport delivers nothing', async () => {
    const root = makeRoot();
    const result = await runAoiProactivePushForSession({
      sessionsDir: root,
      sessionPath: SESSION,
      candidates: [candidate()],
      pushOptIn: true,
      budgetAllowed: true,
      // no transport -> inert default
      now: NOW,
    });
    expect(result.appended).toHaveLength(1);
    expect(result.delivered).toEqual([]);
    const persisted = loadAoiProactivePushQueue(root, SESSION);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].consumedAt).toBeUndefined();
  });

  it('drains a previously-persisted pending record on a later run (round-trip)', async () => {
    const root = makeRoot();
    // Run 1: opt-in, inert transport -> record persisted as pending.
    await runAoiProactivePushForSession({
      sessionsDir: root,
      sessionPath: SESSION,
      candidates: [candidate({ id: 'card-9', deepLinkRef: 'card-9' })],
      pushOptIn: true,
      budgetAllowed: true,
      now: NOW,
    });
    expect(loadAoiProactivePushQueue(root, SESSION)[0].consumedAt).toBeUndefined();
    // Run 2: no new candidates, but a real transport now drains the pending record.
    const result = await runAoiProactivePushForSession({
      sessionsDir: root,
      sessionPath: SESSION,
      candidates: [],
      pushOptIn: true,
      budgetAllowed: true,
      transport: delivering,
      now: NOW + 1000,
    });
    expect(result.appended).toEqual([]);
    expect(result.delivered).toHaveLength(1);
    expect(loadAoiProactivePushQueue(root, SESSION)[0].consumedAt).toBe(NOW + 1000);
  });

  it('rejects a non-direct_chat candidate with the gate reasons', async () => {
    const root = makeRoot();
    const result = await runAoiProactivePushForSession({
      sessionsDir: root,
      sessionPath: SESSION,
      candidates: [candidate({ deliveryMode: 'inline_card' })],
      pushOptIn: true,
      budgetAllowed: true,
      transport: delivering,
      now: NOW,
    });
    expect(result.appended).toEqual([]);
    expect(result.rejected[0]?.reasons).toContain('not_direct_chat');
  });
});
