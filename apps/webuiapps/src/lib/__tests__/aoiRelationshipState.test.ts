import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendAoiRelationshipMilestone,
  createAoiRelationshipState,
  deriveAoiRelationshipThreadId,
  loadAoiRelationshipState,
  markAoiRelationshipThreadAsked,
  normalizeAoiRelationshipState,
  recordAoiRelationshipSessionOpen,
  recordAoiRelationshipSessionSummary,
  resolveAoiRelationshipStatePath,
  saveAoiRelationshipState,
  selectAoiRelationshipThreadToRaise,
} from '../aoiRelationshipState';

const SESSION_PATH = 'aoi/default';
const NOW = 1_000_000_000;
const HOUR = 60 * 60 * 1000;

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-relationship-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('aoiRelationshipState store', () => {
  it('creates the record on the first ever session open', () => {
    const root = makeTempRoot();
    const state = recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    expect(state.firstMetAt).toBe(NOW);
    expect(state.sessionCount).toBe(1);
    expect(state.lastSessionSummary).toBe('');
    expect(state.openThreads).toEqual([]);
    expect(state.milestones.map((item) => item.kind)).toEqual(['first_met']);
    expect(state.actionAuthority).toBe('display_only');
    expect(state.mutationCount).toBe(0);
    expect(loadAoiRelationshipState(root, SESSION_PATH, NOW)).toEqual(state);
  });

  it('counts a genuine return but not a refresh inside the gap floor', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    const refreshed = recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW + 60_000);
    expect(refreshed.sessionCount).toBe(1);
    expect(refreshed.lastSessionAt).toBe(NOW + 60_000);

    const returned = recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW + 5 * HOUR);
    expect(returned.sessionCount).toBe(2);

    const custom = recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW + 5 * HOUR + 1000, {
      minSessionGapMs: 500,
    });
    expect(custom.sessionCount).toBe(3);
  });

  it('persists the session summary and open threads for the next open', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    const stored = recordAoiRelationshipSessionSummary(root, SESSION_PATH, {
      summary: 'Chased a flaky e2e failure in the activity capture spec.',
      openThreads: [{ title: 'Flaky activity-capture e2e' }, { title: 'Daemon restart soak' }],
      now: NOW + HOUR,
    });

    expect(stored?.lastSessionSummary).toContain('flaky e2e failure');
    expect(stored?.openThreads.map((thread) => thread.title)).toEqual([
      'Flaky activity-capture e2e',
      'Daemon restart soak',
    ]);
    expect(loadAoiRelationshipState(root, SESSION_PATH, NOW + HOUR)?.openThreads).toHaveLength(2);
  });

  it('keeps the previous summary when a later write carries none', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);
    recordAoiRelationshipSessionSummary(root, SESSION_PATH, {
      summary: 'Landed the companion voice core.',
      now: NOW + HOUR,
    });

    const later = recordAoiRelationshipSessionSummary(root, SESSION_PATH, {
      openThreads: [{ title: 'Trend advisor register' }],
      now: NOW + 2 * HOUR,
    });

    expect(later?.lastSessionSummary).toBe('Landed the companion voice core.');
  });

  it('redacts secrets and strips source instructions from stored free text', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    const stored = recordAoiRelationshipSessionSummary(root, SESSION_PATH, {
      summary: 'Rotated the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 today.',
      now: NOW + HOUR,
    });

    expect(stored?.lastSessionSummary).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  });

  it('caps the summary, the thread list, and the thread titles', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    const stored = recordAoiRelationshipSessionSummary(root, SESSION_PATH, {
      summary: 'x'.repeat(900),
      // The distinguishing part has to come first: titles are capped before the
      // id is derived, so a suffix past the cap would collapse them into one
      // thread (which the de-duplication test covers deliberately).
      openThreads: Array.from({ length: 9 }, (_unused, index) => ({
        title: `thread-${index} ${'t'.repeat(200)}`,
      })),
      now: NOW + HOUR,
    });

    expect(stored?.lastSessionSummary.length).toBeLessThanOrEqual(400);
    expect(stored?.openThreads).toHaveLength(5);
    for (const thread of stored?.openThreads ?? []) {
      expect(thread.title.length).toBeLessThanOrEqual(120);
    }
  });

  it('drops blank-titled threads and de-duplicates by derived id', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    const stored = recordAoiRelationshipSessionSummary(root, SESSION_PATH, {
      openThreads: [
        { title: '   ' },
        { title: 'Same Thread' },
        { title: 'same thread' },
        { title: 'Other' },
      ],
      now: NOW + HOUR,
    });

    expect(stored?.openThreads.map((thread) => thread.title)).toEqual(['Same Thread', 'Other']);
  });
});

describe('aoiRelationshipState threads', () => {
  it('raises the oldest never-asked thread and stops once all were asked', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);
    recordAoiRelationshipSessionSummary(root, SESSION_PATH, {
      openThreads: [
        { title: 'Older thread', noticedAt: NOW },
        { title: 'Newer thread', noticedAt: NOW + HOUR },
      ],
      now: NOW + HOUR,
    });

    const state = loadAoiRelationshipState(root, SESSION_PATH, NOW + HOUR);
    const first = selectAoiRelationshipThreadToRaise(state);
    expect(first?.title).toBe('Older thread');

    markAoiRelationshipThreadAsked(root, SESSION_PATH, first?.id ?? '', NOW + 2 * HOUR);
    const second = selectAoiRelationshipThreadToRaise(
      loadAoiRelationshipState(root, SESSION_PATH, NOW + 2 * HOUR),
    );
    expect(second?.title).toBe('Newer thread');

    markAoiRelationshipThreadAsked(root, SESSION_PATH, second?.id ?? '', NOW + 3 * HOUR);
    expect(
      selectAoiRelationshipThreadToRaise(
        loadAoiRelationshipState(root, SESSION_PATH, NOW + 3 * HOUR),
      ),
    ).toBeNull();
    expect(selectAoiRelationshipThreadToRaise(null)).toBeNull();
  });

  it('preserves the asked marker when the same thread is reported again', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);
    recordAoiRelationshipSessionSummary(root, SESSION_PATH, {
      openThreads: [{ title: 'Still open' }],
      now: NOW + HOUR,
    });
    const threadId = deriveAoiRelationshipThreadId('Still open');
    markAoiRelationshipThreadAsked(root, SESSION_PATH, threadId, NOW + 2 * HOUR);

    const reReported = recordAoiRelationshipSessionSummary(root, SESSION_PATH, {
      openThreads: [{ title: 'Still open' }],
      now: NOW + 3 * HOUR,
    });

    expect(reReported?.openThreads[0]?.lastAskedAt).toBe(NOW + 2 * HOUR);
    expect(selectAoiRelationshipThreadToRaise(reReported)).toBeNull();
  });

  it('prunes a thread the caller no longer reports as open', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);
    recordAoiRelationshipSessionSummary(root, SESSION_PATH, {
      openThreads: [{ title: 'Resolved later' }, { title: 'Still open' }],
      now: NOW + HOUR,
    });

    const pruned = recordAoiRelationshipSessionSummary(root, SESSION_PATH, {
      openThreads: [{ title: 'Still open' }],
      now: NOW + 2 * HOUR,
    });

    expect(pruned?.openThreads.map((thread) => thread.title)).toEqual(['Still open']);
  });

  it('ignores an asked marker for an unknown thread', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    const unchanged = markAoiRelationshipThreadAsked(root, SESSION_PATH, 'thread:nope', NOW + HOUR);
    expect(unchanged?.openThreads).toEqual([]);
  });

  it('derives a stable id and rejects an unusable title', () => {
    expect(deriveAoiRelationshipThreadId('Flaky E2E!')).toBe('thread:flaky-e2e');
    expect(deriveAoiRelationshipThreadId('커널 감사')).toBe('thread:커널-감사');
    expect(deriveAoiRelationshipThreadId('   ')).toBe('');
    expect(deriveAoiRelationshipThreadId('!!!')).toBe('');
  });
});

describe('aoiRelationshipState milestones', () => {
  it('appends a milestone once per id', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    appendAoiRelationshipMilestone(
      root,
      SESSION_PATH,
      { kind: 'trust_promoted', label: 'Trust reached L4.', evidenceRefs: ['promotion:l4'] },
      NOW + HOUR,
    );
    const twice = appendAoiRelationshipMilestone(
      root,
      SESSION_PATH,
      { kind: 'trust_promoted', label: 'Trust reached L4.' },
      NOW + 2 * HOUR,
    );

    expect(twice?.milestones.filter((item) => item.kind === 'trust_promoted')).toHaveLength(1);
    expect(twice?.milestones.at(-1)?.evidenceRefs).toEqual(['promotion:l4']);
  });

  it('ignores a milestone with no usable label', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    const unchanged = appendAoiRelationshipMilestone(
      root,
      SESSION_PATH,
      { kind: 'session_count', label: '   ' },
      NOW + HOUR,
    );

    expect(unchanged?.milestones).toHaveLength(1);
  });

  it('keeps the first meeting when the milestone list overflows', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);
    for (let index = 0; index < 25; index += 1) {
      appendAoiRelationshipMilestone(
        root,
        SESSION_PATH,
        { kind: 'session_count', label: `Session ${index + 2}.` },
        NOW + (index + 1) * HOUR,
      );
    }

    const state = loadAoiRelationshipState(root, SESSION_PATH, NOW + 100 * HOUR);
    expect(state?.milestones).toHaveLength(20);
    expect(state?.milestones[0]?.kind).toBe('first_met');
    expect(state?.milestones.at(-1)?.label).toBe('Session 26.');
  });

  it('returns null from every writer when no record exists yet', () => {
    const root = makeTempRoot();

    expect(recordAoiRelationshipSessionSummary(root, SESSION_PATH, { now: NOW })).toBeNull();
    expect(markAoiRelationshipThreadAsked(root, SESSION_PATH, 'thread:x', NOW)).toBeNull();
    expect(
      appendAoiRelationshipMilestone(root, SESSION_PATH, { kind: 'first_met', label: 'x' }, NOW),
    ).toBeNull();
  });
});

describe('aoiRelationshipState fail-closed reads', () => {
  it('returns null for an absent record', () => {
    expect(loadAoiRelationshipState(makeTempRoot(), SESSION_PATH, NOW)).toBeNull();
  });

  it('returns null for malformed or unversioned content', () => {
    const root = makeTempRoot();
    const statePath = resolveAoiRelationshipStatePath(root, SESSION_PATH);
    fs.mkdirSync(join(statePath, '..'), { recursive: true });

    fs.writeFileSync(statePath, 'not json at all', 'utf-8');
    expect(loadAoiRelationshipState(root, SESSION_PATH, NOW)).toBeNull();

    fs.writeFileSync(statePath, JSON.stringify({ version: 2, firstMetAt: NOW }), 'utf-8');
    expect(loadAoiRelationshipState(root, SESSION_PATH, NOW)).toBeNull();

    fs.writeFileSync(statePath, JSON.stringify({ version: 1 }), 'utf-8');
    expect(loadAoiRelationshipState(root, SESSION_PATH, NOW)).toBeNull();
  });

  it('repairs a record with implausible counters instead of trusting them', () => {
    const root = makeTempRoot();
    const statePath = resolveAoiRelationshipStatePath(root, SESSION_PATH);
    fs.mkdirSync(join(statePath, '..'), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        firstMetAt: NOW,
        sessionCount: -8,
        lastSessionAt: 'nonsense',
        openThreads: 'nope',
        milestones: [{ kind: 'unknown_kind', label: 'x' }, { kind: 'first_met' }],
        actionAuthority: 'execute',
        mutationCount: 12,
      }),
      'utf-8',
    );

    const state = loadAoiRelationshipState(root, SESSION_PATH, NOW);
    expect(state?.sessionCount).toBe(1);
    expect(state?.lastSessionAt).toBe(NOW);
    expect(state?.openThreads).toEqual([]);
    // Unknown kinds and label-less entries are dropped, and the record can
    // never claim execute authority however it was written on disk.
    expect(state?.milestones).toEqual([]);
    expect(state?.actionAuthority).toBe('display_only');
    expect(state?.mutationCount).toBe(0);
  });

  it('rejects a session path that escapes the autonomy root', () => {
    const root = makeTempRoot();
    expect(() => resolveAoiRelationshipStatePath(root, '')).toThrow(/sessionPath/);
  });

  it('round-trips a hand-built record through save and normalize', () => {
    const root = makeTempRoot();
    const created = createAoiRelationshipState(SESSION_PATH, NOW);
    saveAoiRelationshipState(root, created);

    expect(loadAoiRelationshipState(root, SESSION_PATH, NOW)).toEqual(created);
    expect(normalizeAoiRelationshipState(created, SESSION_PATH, NOW)).toEqual(created);
    expect(normalizeAoiRelationshipState(null, SESSION_PATH, NOW)).toBeNull();
  });
});
