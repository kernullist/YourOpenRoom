import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AoiOutcomeSignalRecord } from '../aoiAutonomyTypes';
import {
  AOI_RETROSPECTIVE_WINDOW_MS,
  buildAoiWeeklyRetrospective,
} from '../aoiWeeklyRetrospective';
import {
  loadAoiWeeklyRetrospective,
  loadAoiWeeklyRetrospectiveHistory,
  resolveAoiWeeklyRetrospectivePaths,
  saveAoiWeeklyRetrospective,
} from '../aoiWeeklyRetrospectiveStore';
import { loadAoiRelationIndex } from '../aoiAutonomyRelations';

const SESSION_PATH = 'aoi/default';
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-retro-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeSignal(partial: Partial<AoiOutcomeSignalRecord>): AoiOutcomeSignalRecord {
  return {
    version: 1,
    id: partial.id ?? 'outcome-1',
    sessionPath: SESSION_PATH,
    eventId: partial.eventId ?? 'event-1',
    outcomeKind: partial.outcomeKind ?? 'commit_created',
    signalKind: partial.signalKind ?? 'passive_outcome',
    confidence: partial.confidence ?? 0.8,
    inferredAdjustment: partial.inferredAdjustment ?? {
      direction: 'neutral',
      target: 'topic',
      magnitude: 0,
    },
    result: partial.result ?? 'positive',
    evidenceRefs: partial.evidenceRefs ?? ['commit:abc1234'],
    privacyState: partial.privacyState ?? 'metadata_only',
    createdAt: partial.createdAt ?? NOW - DAY,
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...(partial.topicKey !== undefined ? { topicKey: partial.topicKey } : {}),
    ...(partial.explicitLabel !== undefined ? { explicitLabel: partial.explicitLabel } : {}),
    ...(partial.explicitCorrection !== undefined
      ? { explicitCorrection: partial.explicitCorrection }
      : {}),
    ...(partial.sourceCommitRef !== undefined ? { sourceCommitRef: partial.sourceCommitRef } : {}),
  } as AoiOutcomeSignalRecord;
}

describe('buildAoiWeeklyRetrospective', () => {
  it('separates what reached an end state from what did not', () => {
    const retro = buildAoiWeeklyRetrospective({
      sessionPath: SESSION_PATH,
      now: NOW,
      outcomeSignals: [
        makeSignal({ id: 'a', outcomeKind: 'commit_created', topicKey: 'companion voice' }),
        makeSignal({
          id: 'b',
          outcomeKind: 'validation_run',
          topicKey: 'greeting e2e',
          result: 'failed',
          explicitCorrection: 'stub order',
        }),
      ],
      sessionCount: 4,
    });

    expect(retro.shipped).toEqual(['commit created: companion voice']);
    expect(retro.stuck).toEqual(['validation run: greeting e2e (stub order)']);
    expect(retro.empty).toBe(false);
    expect(retro.narrative).toContain('4 session(s)');
    expect(retro.actionAuthority).toBe('display_only');
    expect(retro.mutationCount).toBe(0);
    expect(retro.synthesizedBy).toBe('deterministic');
  });

  it('treats attention-only signals as not part of what got done', () => {
    const retro = buildAoiWeeklyRetrospective({
      sessionPath: SESSION_PATH,
      now: NOW,
      outcomeSignals: [
        makeSignal({ id: 'c', outcomeKind: 'proposal_opened', result: 'neutral' }),
        makeSignal({ id: 'd', outcomeKind: 'direct_chat_dismissed', result: 'neutral' }),
      ],
    });

    expect(retro.shipped).toEqual([]);
    expect(retro.stuck).toEqual([]);
    expect(retro.empty).toBe(true);
    expect(retro.narrative).toBe('Nothing recorded for this period.');
  });

  it('ignores records outside the window', () => {
    const retro = buildAoiWeeklyRetrospective({
      sessionPath: SESSION_PATH,
      now: NOW,
      outcomeSignals: [
        makeSignal({ id: 'old', createdAt: NOW - 30 * DAY, topicKey: 'ancient work' }),
        makeSignal({ id: 'future', createdAt: NOW + DAY, topicKey: 'not yet' }),
        makeSignal({ id: 'in', createdAt: NOW - 2 * DAY, topicKey: 'this week' }),
      ],
      milestones: [
        {
          id: 'm-old',
          kind: 'session_count',
          label: 'Old milestone.',
          occurredAt: NOW - 30 * DAY,
          evidenceRefs: [],
        },
        {
          id: 'm-in',
          kind: 'trust_promoted',
          label: 'Trust was raised to L4.',
          occurredAt: NOW - DAY,
          evidenceRefs: ['policy:autonomy_level:L4'],
        },
      ],
      researchRuns: [
        { id: 'r-old', label: 'stale research', completedAt: NOW - 20 * DAY },
        { id: 'r-in', label: 'kernel telemetry survey', completedAt: NOW - 3 * DAY },
      ],
    });

    expect(retro.shipped).toEqual(['commit created: this week']);
    expect(retro.milestones).toEqual(['Trust was raised to L4.']);
    expect(retro.researched).toEqual(['kernel telemetry survey']);
    expect(retro.periodStart).toBe(NOW - AOI_RETROSPECTIVE_WINDOW_MS);
    expect(retro.periodEnd).toBe(NOW);
  });

  it('carries open threads forward regardless of when they started', () => {
    const retro = buildAoiWeeklyRetrospective({
      sessionPath: SESSION_PATH,
      now: NOW,
      openThreads: [
        { id: 't1', title: 'Daemon restart soak', noticedAt: NOW - 40 * DAY },
        { id: 't2', title: 'Flaky greeting e2e', noticedAt: NOW - DAY },
      ],
    });

    expect(retro.openNext).toEqual(['Daemon restart soak', 'Flaky greeting e2e']);
    expect(retro.narrative).toContain('Still open next period');
    expect(retro.empty).toBe(false);
  });

  it('collects deduped evidence refs and a reflection relation ref', () => {
    const retro = buildAoiWeeklyRetrospective({
      sessionPath: SESSION_PATH,
      now: NOW,
      outcomeSignals: [
        makeSignal({ id: 'e1', evidenceRefs: ['commit:abc'] }),
        makeSignal({ id: 'e2', evidenceRefs: ['commit:abc', 'validation:xyz'] }),
      ],
      researchRuns: [{ id: 'run-1', label: 'survey', completedAt: NOW - DAY }],
    });

    expect(retro.evidenceRefs).toEqual(['commit:abc', 'validation:xyz', 'research:run-1']);
    expect(retro.relationRef).toBe(`reflection:${retro.id}`);
  });

  it('caps each section and every line', () => {
    const retro = buildAoiWeeklyRetrospective({
      sessionPath: SESSION_PATH,
      now: NOW,
      outcomeSignals: Array.from({ length: 9 }, (_unused, index) =>
        makeSignal({ id: `s-${index}`, topicKey: `topic ${'x'.repeat(400)} ${index}` }),
      ),
    });

    expect(retro.shipped).toHaveLength(5);
    for (const line of retro.shipped) {
      expect(line.length).toBeLessThanOrEqual(160);
    }
  });

  it('handles a non-finite session count without polluting the narrative', () => {
    const retro = buildAoiWeeklyRetrospective({
      sessionPath: SESSION_PATH,
      now: NOW,
      sessionCount: Number.NaN,
    });
    expect(retro.sessionCount).toBe(0);
    expect(retro.narrative).not.toContain('NaN');
  });
});

describe('aoiWeeklyRetrospectiveStore', () => {
  it('persists the latest record and registers a reflection relation node', () => {
    const root = makeTempRoot();
    const retro = buildAoiWeeklyRetrospective({
      sessionPath: SESSION_PATH,
      now: NOW,
      outcomeSignals: [makeSignal({ topicKey: 'companion voice', evidenceRefs: ['commit:abc'] })],
      sessionCount: 3,
    });

    saveAoiWeeklyRetrospective(root, retro);

    expect(loadAoiWeeklyRetrospective(root, SESSION_PATH)).toEqual(retro);
    // The first real producer of the 'reflection' node kind.
    const relations = loadAoiRelationIndex(root, SESSION_PATH);
    const reflection = relations.nodes.find((node) => node.kind === 'reflection');
    expect(reflection?.ref).toBe(retro.relationRef);
    expect(relations.nodes.some((node) => node.ref === 'commit:abc')).toBe(true);
  });

  it('keeps a newest-first bounded history', () => {
    const root = makeTempRoot();
    for (let index = 0; index < 3; index += 1) {
      saveAoiWeeklyRetrospective(
        root,
        buildAoiWeeklyRetrospective({
          sessionPath: SESSION_PATH,
          now: NOW + index * 7 * DAY,
          sessionCount: index + 1,
        }),
      );
    }

    const history = loadAoiWeeklyRetrospectiveHistory(root, SESSION_PATH);
    expect(history).toHaveLength(3);
    expect(history[0].sessionCount).toBe(3);
    expect(history[2].sessionCount).toBe(1);
    expect(loadAoiWeeklyRetrospectiveHistory(root, SESSION_PATH, 1)).toHaveLength(1);
  });

  it('reads as absent for missing, malformed, or non-display-only records', () => {
    const root = makeTempRoot();
    expect(loadAoiWeeklyRetrospective(root, SESSION_PATH)).toBeNull();
    expect(loadAoiWeeklyRetrospectiveHistory(root, SESSION_PATH)).toEqual([]);

    const paths = resolveAoiWeeklyRetrospectivePaths(root, SESSION_PATH);
    fs.mkdirSync(join(paths.latest, '..'), { recursive: true });

    fs.writeFileSync(paths.latest, 'not json', 'utf-8');
    expect(loadAoiWeeklyRetrospective(root, SESSION_PATH)).toBeNull();

    fs.writeFileSync(
      paths.latest,
      JSON.stringify({
        version: 1,
        narrative: 'x',
        periodStart: 1,
        periodEnd: 2,
        actionAuthority: 'execute',
        mutationCount: 3,
      }),
      'utf-8',
    );
    expect(loadAoiWeeklyRetrospective(root, SESSION_PATH)).toBeNull();
  });

  it('skips a corrupt history line instead of dropping the whole history', () => {
    const root = makeTempRoot();
    const retro = buildAoiWeeklyRetrospective({
      sessionPath: SESSION_PATH,
      now: NOW,
      sessionCount: 2,
    });
    saveAoiWeeklyRetrospective(root, retro);
    const paths = resolveAoiWeeklyRetrospectivePaths(root, SESSION_PATH);
    fs.appendFileSync(paths.history, 'corrupt-line\n', 'utf-8');

    const history = loadAoiWeeklyRetrospectiveHistory(root, SESSION_PATH);
    expect(history).toHaveLength(1);
    expect(history[0].sessionCount).toBe(2);
  });

  it('rejects an unusable session path', () => {
    const root = makeTempRoot();
    expect(() => resolveAoiWeeklyRetrospectivePaths(root, '')).toThrow(/sessionPath/);
  });
});
