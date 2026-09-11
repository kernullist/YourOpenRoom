import { describe, expect, it } from 'vitest';
import { AOI_CAPABILITY_FAMILIES, AOI_TURN_KINDS } from '../aoiTurnRecord';
import { AOI_MUSIC_REFERENCES } from '../aoiTurnUnderstanding';
import {
  AOI_TURN_UNDERSTANDING_CORPUS,
  type AoiTurnCorpusCase,
} from '../__fixtures__/aoiTurnUnderstandingCorpus';
import {
  corpusTurnsToHistory,
  corpusTurnsToRecords,
  evaluateAoiTurnUnderstanding,
  formatAoiTurnEvalReport,
  predictAoiTurnWithRegex,
  type AoiTurnEvalPrediction,
} from '../aoiTurnUnderstandingEval';

// Measured 2026-09-10 over the 164-case corpus: route 72.0%, kind 81.7%, families 79.3%. These are floors, not targets:
// the point is that a router change cannot silently make them worse. The gap to
// 100% is what the classifier exists to close; see docs/aoi-turn-understanding-design.md.
const REGEX_ROUTE_FLOOR = 0.7;
const REGEX_KIND_FLOOR = 0.78;
const REGEX_FAMILIES_FLOOR = 0.75;
const REGEX_UNDER_ROUTED_CEILING = 40;

describe('corpus', () => {
  it('is well-formed: unique ids, valid enums, consistent routes, resolvable references', () => {
    const ids = new Set<string>();
    for (const testCase of AOI_TURN_UNDERSTANDING_CORPUS) {
      expect(ids.has(testCase.id), `duplicate id ${testCase.id}`).toBe(false);
      ids.add(testCase.id);
      expect(testCase.text.trim().length).toBeGreaterThan(0);
      expect(AOI_TURN_KINDS).toContain(testCase.gold.kind);
      expect(testCase.gold.kind).not.toBe('unknown');
      expect(testCase.gold.families.length).toBeGreaterThan(0);
      for (const family of testCase.gold.families) {
        expect(AOI_CAPABILITY_FAMILIES).toContain(family);
      }
      // "none" is exclusive, and a turn that needs a family cannot be served on dialog.
      if (testCase.gold.families.includes('none')) {
        expect(testCase.gold.families).toEqual(['none']);
        expect(testCase.gold.route).toBe('dialog');
      } else {
        expect(testCase.gold.route).toBe('main');
      }
      if (testCase.gold.refersToTurn !== undefined) {
        expect(testCase.turns?.length ?? 0).toBeGreaterThanOrEqual(testCase.gold.refersToTurn);
      }
      // A music target is the user's own words, so it must appear in the text.
      if (testCase.gold.music) {
        expect(AOI_MUSIC_REFERENCES).toContain(testCase.gold.music.reference);
        if (testCase.gold.music.target !== null) {
          expect(testCase.text.toLowerCase()).toContain(testCase.gold.music.target.toLowerCase());
        }
      }
      expect(testCase.tags.length).toBeGreaterThan(0);
    }
    expect(AOI_TURN_UNDERSTANDING_CORPUS.length).toBeGreaterThanOrEqual(150);
  });

  it('covers every kind and every real family', () => {
    const kinds = new Set(AOI_TURN_UNDERSTANDING_CORPUS.map((testCase) => testCase.gold.kind));
    for (const kind of AOI_TURN_KINDS.filter((entry) => entry !== 'unknown')) {
      expect(kinds.has(kind), `kind ${kind} uncovered`).toBe(true);
    }
    const families = new Set(
      AOI_TURN_UNDERSTANDING_CORPUS.flatMap((testCase) => testCase.gold.families),
    );
    for (const family of AOI_CAPABILITY_FAMILIES) {
      expect(families.has(family), `family ${family} uncovered`).toBe(true);
    }
  });
});

describe('corpusTurnsToRecords / corpusTurnsToHistory', () => {
  const turns = [
    {
      user: 'a.ts 읽어줘',
      assistant: '읽었어. 저장할까?',
      tools: [{ name: 'ide_read_file', args: 'path=a.ts', outcome: 'ok' as const }],
    },
    {
      user: '응',
      assistant: '저장했어.',
      route: 'main' as const,
      outcome: 'delivered' as const,
      offers: ['더 볼까'],
    },
  ];

  it('builds ordered records with the stated tools and derived offers', () => {
    const records = corpusTurnsToRecords(turns, 1_000_000);
    expect(records.map((record) => record.turnIndex)).toEqual([1, 2]);
    expect(records[0].tools).toEqual([{ name: 'ide_read_file', args: 'path=a.ts', outcome: 'ok' }]);
    expect(records[0].openQuestion).toBe('저장할까?');
    expect(records[0].createdAt).toBeLessThan(records[1].createdAt);
    expect(records[1].offers[0]).toBe('더 볼까');
    expect(records[1].tools).toEqual([]);
    expect(corpusTurnsToRecords(undefined)).toEqual([]);
  });

  it('builds a user/assistant history', () => {
    expect(corpusTurnsToHistory(turns).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(corpusTurnsToHistory()).toEqual([]);
  });
});

describe('evaluateAoiTurnUnderstanding', () => {
  const cases: AoiTurnCorpusCase[] = [
    {
      id: 'a',
      text: 'x',
      gold: { kind: 'chitchat', families: ['none'], route: 'dialog' },
      tags: ['t1'],
    },
    {
      id: 'b',
      text: 'y',
      gold: { kind: 'action_request', families: ['file'], route: 'main', refersToTurn: 1 },
      tags: ['t1', 't2'],
      turns: [{ user: 'u', assistant: 'a' }],
    },
    {
      id: 'c',
      text: 'z',
      gold: { kind: 'question', families: ['none'], route: 'dialog' },
      tags: ['t2'],
    },
  ];

  it('scores route, kind, families, references and buckets, listing failures', async () => {
    const answers: Record<string, AoiTurnEvalPrediction> = {
      a: {
        kind: 'chitchat',
        families: ['none'],
        route: 'dialog',
        refersToTurn: null,
        source: 'regex',
      },
      b: {
        kind: 'action_request',
        families: ['file', 'app'],
        route: 'dialog',
        refersToTurn: null,
        source: 'classifier',
        latencyMs: 200,
      },
      c: {
        kind: 'question',
        families: ['none'],
        route: 'main',
        refersToTurn: null,
        source: 'classifier',
        latencyMs: 400,
      },
    };
    const report = await evaluateAoiTurnUnderstanding(cases, (testCase) => answers[testCase.id]);
    expect(report.total).toBe(3);
    expect(report.routeAccuracy).toBe(0.333);
    expect(report.kindAccuracy).toBe(1);
    expect(report.familiesAccuracy).toBe(0.667);
    expect(report.referenceCases).toBe(1);
    expect(report.referenceCorrect).toBe(0);
    expect(report.overRoutedToMain).toBe(1);
    expect(report.underRoutedToDialog).toBe(1);
    expect(report.meanLatencyMs).toBe(300);
    expect(report.byKind.action_request).toEqual({
      total: 1,
      routeCorrect: 0,
      kindCorrect: 1,
      familiesCorrect: 0,
    });
    expect(report.byTag.t1.total).toBe(2);
    expect(report.failures.map((failure) => failure.id)).toEqual(['b', 'c']);
    expect(report.failures[0].wrong).toEqual(['route', 'families', 'reference']);

    const text = formatAoiTurnEvalReport(report, 'unit');
    expect(text).toContain('[unit] 3 cases');
    expect(text).toContain('references 0/1');
    expect(text).toContain('mean latency 300 ms');
    expect(text).toContain(
      'b: "y" expected action_request/file/main/T-1 got action_request/file+app/dialog [route,families,reference]',
    );
  });

  it('scores the playback slots only for classifier predictions', async () => {
    const musicCases: AoiTurnCorpusCase[] = [
      {
        id: 'm1',
        text: '에스파 내가 좋아하는 노래 틀어줘',
        gold: {
          kind: 'action_request',
          families: ['app'],
          route: 'main',
          music: { reference: 'taste', target: '에스파' },
        },
        tags: ['music'],
      },
      {
        id: 'm2',
        text: 'play IVE LOVE DIVE',
        gold: {
          kind: 'action_request',
          families: ['app'],
          route: 'main',
          music: { reference: 'none', target: 'IVE LOVE DIVE' },
        },
        tags: ['music'],
      },
      {
        id: 'm3',
        text: '내가 자주 듣는 노래 틀어줘',
        gold: {
          kind: 'action_request',
          families: ['app'],
          route: 'main',
          music: { reference: 'taste', target: null },
        },
        tags: ['music'],
      },
    ];
    const base = {
      kind: 'action_request' as const,
      families: ['app' as const],
      route: 'main' as const,
      refersToTurn: null,
    };
    const answers: Record<string, AoiTurnEvalPrediction> = {
      // Read as a literal title: the one failure mode this slot exists to catch.
      m1: {
        ...base,
        source: 'classifier',
        musicReference: 'none',
        musicTarget: '에스파 내가 좋아하는',
      },
      // Case and spacing of the target do not count against it.
      m2: { ...base, source: 'classifier', musicReference: null, musicTarget: 'ive  love dive' },
      // The regex reading has no slots; it is not scored on them.
      m3: { ...base, source: 'regex' },
    };
    const report = await evaluateAoiTurnUnderstanding(
      musicCases,
      (testCase) => answers[testCase.id],
    );
    expect(report.routeAccuracy).toBe(1);
    expect(report.musicCases).toBe(2);
    expect(report.musicCorrect).toBe(1);
    expect(report.failures.map((failure) => failure.id)).toEqual(['m1']);
    expect(report.failures[0].wrong).toEqual(['music']);
    expect(report.failures[0].expected.music).toEqual({ reference: 'taste', target: '에스파' });
    const text = formatAoiTurnEvalReport(report, 'music');
    expect(text).toContain('music slots 1/2');
    expect(text).toContain('[music]');
  });

  it('handles a perfect predictor and an empty corpus', async () => {
    const perfect = await evaluateAoiTurnUnderstanding(cases, (testCase) => ({
      kind: testCase.gold.kind,
      families: testCase.gold.families,
      route: testCase.gold.route,
      refersToTurn: testCase.gold.refersToTurn ?? null,
      source: 'classifier',
    }));
    expect(perfect.routeAccuracy).toBe(1);
    expect(perfect.failures).toEqual([]);
    expect(perfect.meanLatencyMs).toBeNull();
    expect(formatAoiTurnEvalReport(perfect)).not.toContain('failures');
    const empty = await evaluateAoiTurnUnderstanding([], predictAoiTurnWithRegex);
    expect(empty.routeAccuracy).toBe(0);
    expect(formatAoiTurnEvalReport(empty)).toContain('0 cases');
  });
});

describe('regex baseline over the corpus', () => {
  it('does not regress below the recorded floors', async () => {
    const report = await evaluateAoiTurnUnderstanding(
      AOI_TURN_UNDERSTANDING_CORPUS,
      predictAoiTurnWithRegex,
    );
    expect(report.routeAccuracy).toBeGreaterThanOrEqual(REGEX_ROUTE_FLOOR);
    expect(report.kindAccuracy).toBeGreaterThanOrEqual(REGEX_KIND_FLOOR);
    expect(report.familiesAccuracy).toBeGreaterThanOrEqual(REGEX_FAMILIES_FLOOR);
    expect(report.underRoutedToDialog).toBeLessThanOrEqual(REGEX_UNDER_ROUTED_CEILING);
    // Structural: the regex reading cannot resolve a reference at all, and has
    // no playback slots to score.
    expect(report.referenceCorrect).toBe(0);
    expect(report.musicCases).toBe(0);
    // Chit-chat never leaves the dialog route under the regex router.
    expect(report.byKind.chitchat.routeCorrect).toBe(report.byKind.chitchat.total);
  });
});
