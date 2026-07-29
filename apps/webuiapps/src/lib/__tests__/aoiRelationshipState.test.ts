import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendAoiRelationshipMilestone,
  applyAoiRelationshipMilestones,
  createAoiRelationshipState,
  deriveAoiRelationshipThreadId,
  loadAoiRelationshipState,
  markAoiRelationshipThreadAsked,
  normalizeAoiRelationshipState,
  recordAoiRelationshipArcCompletion,
  recordAoiRelationshipMood,
  recordAoiRelationshipSessionOpen,
  recordAoiRelationshipSessionSummary,
  resolveAoiRelationshipStatePath,
  saveAoiRelationshipState,
  selectAoiRelationshipThreadToRaise,
} from '../aoiRelationshipState';
import { deriveAoiMoodState } from '../aoiMoodState';

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

describe('applyAoiRelationshipMilestones (R3.3)', () => {
  it('reports only genuinely new milestones and is idempotent on re-derivation', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    const inputs = [
      {
        kind: 'session_count' as const,
        id: 'session_count:10',
        label: 'We reached 10 sessions together.',
        evidenceRefs: ['relationship:session_count:10'],
      },
      {
        kind: 'trust_promoted' as const,
        id: 'trust_promoted:L4',
        label: 'Trust was raised to L4.',
        evidenceRefs: [],
      },
    ];

    const first = applyAoiRelationshipMilestones(root, SESSION_PATH, inputs, NOW + HOUR);
    expect(first.added.map((item) => item.id)).toEqual(['session_count:10', 'trust_promoted:L4']);
    expect(first.state?.milestones).toHaveLength(3);

    // Re-deriving the same milestones is a no-op: nothing is news twice.
    const second = applyAoiRelationshipMilestones(root, SESSION_PATH, inputs, NOW + 2 * HOUR);
    expect(second.added).toEqual([]);
    expect(second.state?.milestones).toHaveLength(3);
  });

  it('skips label-less inputs and returns the record untouched when none apply', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    const result = applyAoiRelationshipMilestones(
      root,
      SESSION_PATH,
      [{ kind: 'session_count', label: '   ' }],
      NOW + HOUR,
    );
    expect(result.added).toEqual([]);
    expect(result.state?.milestones).toHaveLength(1);
  });

  it('returns nulls when no relationship record exists yet', () => {
    const root = makeTempRoot();
    const result = applyAoiRelationshipMilestones(
      root,
      SESSION_PATH,
      [{ kind: 'first_met', label: 'x' }],
      NOW,
    );
    expect(result.state).toBeNull();
    expect(result.added).toEqual([]);
  });

  it('does not report a milestone that normalization dropped at the cap', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);
    // Fill past the 20-entry cap with older entries, then add one older still:
    // it must not be reported as added when it did not survive.
    applyAoiRelationshipMilestones(
      root,
      SESSION_PATH,
      Array.from({ length: 25 }, (_unused, index) => ({
        kind: 'session_count' as const,
        id: `session_count:${index + 1}`,
        label: `Session ${index + 1}.`,
        occurredAt: NOW + (index + 1) * HOUR,
      })),
      NOW + 100 * HOUR,
    );

    const late = applyAoiRelationshipMilestones(
      root,
      SESSION_PATH,
      [
        {
          kind: 'session_count',
          id: 'session_count:ancient',
          label: 'Ancient.',
          occurredAt: NOW - 50 * HOUR,
        },
      ],
      NOW + 200 * HOUR,
    );
    expect(late.added).toEqual([]);
    expect(late.state?.milestones).toHaveLength(20);
    expect(late.state?.milestones[0]?.kind).toBe('first_met');
  });
});

describe('relationship mood persistence (R6.2)', () => {
  it('stores a mood and carries it across loads', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    const stored = recordAoiRelationshipMood(
      root,
      SESSION_PATH,
      deriveAoiMoodState({ now: NOW, recentOutcomes: [{ result: 'positive', createdAt: NOW }] }),
      NOW + HOUR,
    );

    expect(stored?.mood?.mood).toBe('content');
    // Mood is what survives the session boundary; that is the whole point.
    expect(loadAoiRelationshipState(root, SESSION_PATH, NOW + 2 * HOUR)?.mood?.mood).toBe(
      'content',
    );
  });

  it('drops an unrecognizable stored mood rather than repairing it', () => {
    const root = makeTempRoot();
    const statePath = resolveAoiRelationshipStatePath(root, SESSION_PATH);
    fs.mkdirSync(join(statePath, '..'), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        firstMetAt: NOW,
        mood: { version: 1, mood: 'elated' },
      }),
      'utf-8',
    );

    // No stored feeling is better than a wrong one.
    expect(loadAoiRelationshipState(root, SESSION_PATH, NOW)?.mood).toBeUndefined();
  });

  it('re-asserts display-only authority on a mood written to disk', () => {
    const root = makeTempRoot();
    const statePath = resolveAoiRelationshipStatePath(root, SESSION_PATH);
    fs.mkdirSync(join(statePath, '..'), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        firstMetAt: NOW,
        mood: {
          version: 1,
          mood: 'worried',
          actionAuthority: 'execute',
          mutationCount: 5,
        },
      }),
      'utf-8',
    );

    const mood = loadAoiRelationshipState(root, SESSION_PATH, NOW)?.mood;
    expect(mood?.mood).toBe('worried');
    expect(mood?.actionAuthority).toBe('display_only');
    expect(mood?.mutationCount).toBe(0);
  });

  it('returns null when no relationship record exists to attach a mood to', () => {
    const root = makeTempRoot();
    expect(
      recordAoiRelationshipMood(root, SESSION_PATH, deriveAoiMoodState({ now: NOW }), NOW),
    ).toBeNull();
  });
});

describe('arc completion baseline (R7.1)', () => {
  it('records the baseline and an arc_completed milestone together', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    const result = recordAoiRelationshipArcCompletion(root, SESSION_PATH, {
      arcId: 'space_adventure',
      arcName: 'Bounty Hunter Fugue',
      completedStages: ['Relics and Reunion', 'Methodical Pursuit', 'Epilogue'],
      now: NOW + HOUR,
    });

    expect(result.recorded).toBe(true);
    expect(result.state?.arcBaseline?.arcId).toBe('space_adventure');
    expect(result.state?.arcBaseline?.completedStages).toEqual([
      'Relics and Reunion',
      'Methodical Pursuit',
      'Epilogue',
    ]);
    const milestone = result.state?.milestones.find((item) => item.kind === 'arc_completed');
    expect(milestone?.label).toContain('Bounty Hunter Fugue');
    expect(milestone?.evidenceRefs).toEqual(['arc:space_adventure']);
    // The baseline is what later sessions read, so it has to survive a reload.
    expect(loadAoiRelationshipState(root, SESSION_PATH, NOW + 2 * HOUR)?.arcBaseline?.arcName).toBe(
      'Bounty Hunter Fugue',
    );
  });

  it('is idempotent for the same arc but records a different one', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);
    recordAoiRelationshipArcCompletion(root, SESSION_PATH, {
      arcId: 'arc-one',
      arcName: 'First Arc',
      now: NOW + HOUR,
    });

    // Replaying the final stage must not re-record it.
    const again = recordAoiRelationshipArcCompletion(root, SESSION_PATH, {
      arcId: 'arc-one',
      arcName: 'First Arc',
      now: NOW + 2 * HOUR,
    });
    expect(again.recorded).toBe(false);
    expect(again.state?.milestones.filter((item) => item.kind === 'arc_completed')).toHaveLength(1);

    // A genuinely different arc finishing later replaces the baseline and adds
    // its own milestone -- both arcs really happened.
    const second = recordAoiRelationshipArcCompletion(root, SESSION_PATH, {
      arcId: 'arc-two',
      arcName: 'Second Arc',
      now: NOW + 3 * HOUR,
    });
    expect(second.recorded).toBe(true);
    expect(second.state?.arcBaseline?.arcId).toBe('arc-two');
    expect(second.state?.milestones.filter((item) => item.kind === 'arc_completed')).toHaveLength(
      2,
    );
  });

  it('refuses an arc with no usable identity', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    const noId = recordAoiRelationshipArcCompletion(root, SESSION_PATH, {
      arcId: '   ',
      arcName: 'Nameless',
      now: NOW + HOUR,
    });
    expect(noId.recorded).toBe(false);
    expect(noId.state?.arcBaseline).toBeUndefined();

    const noName = recordAoiRelationshipArcCompletion(root, SESSION_PATH, {
      arcId: 'arc-x',
      arcName: '',
      now: NOW + HOUR,
    });
    expect(noName.recorded).toBe(false);
  });

  it('caps the stage list and the labels', () => {
    const root = makeTempRoot();
    recordAoiRelationshipSessionOpen(root, SESSION_PATH, NOW);

    const result = recordAoiRelationshipArcCompletion(root, SESSION_PATH, {
      arcId: 'arc-long',
      arcName: 'n'.repeat(200),
      completedStages: Array.from({ length: 20 }, (_unused, index) => `stage-${index}`),
      now: NOW + HOUR,
    });

    expect(result.state?.arcBaseline?.arcName.length).toBeLessThanOrEqual(80);
    expect(result.state?.arcBaseline?.completedStages).toHaveLength(8);
  });

  it('drops a stored baseline that lost its identity', () => {
    const root = makeTempRoot();
    const statePath = resolveAoiRelationshipStatePath(root, SESSION_PATH);
    fs.mkdirSync(join(statePath, '..'), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        firstMetAt: NOW,
        arcBaseline: { completedAt: NOW, completedStages: ['x'] },
      }),
      'utf-8',
    );

    // "Some arc finished" is not something Aoi can refer back to.
    expect(loadAoiRelationshipState(root, SESSION_PATH, NOW)?.arcBaseline).toBeUndefined();
  });

  it('returns null when no relationship record exists yet', () => {
    const root = makeTempRoot();
    const result = recordAoiRelationshipArcCompletion(root, SESSION_PATH, {
      arcId: 'arc-one',
      arcName: 'First Arc',
      now: NOW,
    });
    expect(result.state).toBeNull();
    expect(result.recorded).toBe(false);
  });
});
