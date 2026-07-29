import { describe, expect, it } from 'vitest';

import {
  buildAoiRelationshipHistoryRoute,
  buildAoiRelationshipHistoryViewModel,
  parseAoiRelationshipHistoryResponse,
} from '../aoiRelationshipHistoryPanelModel';

const DAY = 24 * 60 * 60 * 1000;
const PERIOD_END = Date.UTC(2026, 6, 29);

function retrospectivePayload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: 'aoi-retro-1',
    sessionPath: 'aoi/default',
    periodStart: PERIOD_END - 7 * DAY,
    periodEnd: PERIOD_END,
    narrative: 'We worked together in 4 session(s) this period.',
    shipped: ['commit created: companion voice'],
    stuck: [],
    researched: ['kernel telemetry survey'],
    milestones: ['Trust was raised to L4.'],
    openNext: ['Daemon restart soak'],
    sessionCount: 4,
    empty: false,
    evidenceRefs: ['commit:abc'],
    synthesizedBy: 'deterministic',
    actionAuthority: 'display_only',
    mutationCount: 0,
    createdAt: PERIOD_END,
    ...overrides,
  };
}

function fullPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    sessionPath: 'aoi/default',
    retrospective: retrospectivePayload(),
    history: [retrospectivePayload()],
    milestones: [
      {
        id: 'first_met',
        kind: 'first_met',
        label: 'We started working together.',
        occurredAt: PERIOD_END - 200 * DAY,
      },
      {
        id: 'trust_promoted:L4',
        kind: 'trust_promoted',
        label: 'Trust was raised to L4.',
        occurredAt: PERIOD_END - DAY,
      },
    ],
    firstMetAt: PERIOD_END - 200 * DAY,
    sessionCount: 42,
    ...overrides,
  };
}

describe('aoiRelationshipHistoryPanelModel parsing', () => {
  it('builds a session-scoped route', () => {
    expect(buildAoiRelationshipHistoryRoute('aoi/default')).toBe(
      '/api/aoi-autonomy/relationship/retrospective?sessionPath=aoi%2Fdefault',
    );
  });

  it('parses a complete payload', () => {
    const parsed = parseAoiRelationshipHistoryResponse(fullPayload());
    expect(parsed?.retrospective?.id).toBe('aoi-retro-1');
    expect(parsed?.history).toHaveLength(1);
    expect(parsed?.milestones).toHaveLength(2);
    expect(parsed?.sessionCount).toBe(42);
  });

  it('rejects a payload that is not an ok session response', () => {
    expect(parseAoiRelationshipHistoryResponse(null)).toBeNull();
    expect(
      parseAoiRelationshipHistoryResponse({ ok: false, sessionPath: 'aoi/default' }),
    ).toBeNull();
    expect(parseAoiRelationshipHistoryResponse({ ok: true })).toBeNull();
  });

  it('refuses to render a retrospective claiming authority beyond display', () => {
    const parsed = parseAoiRelationshipHistoryResponse(
      fullPayload({
        retrospective: retrospectivePayload({ actionAuthority: 'execute' }),
        history: [retrospectivePayload({ mutationCount: 2 })],
      }),
    );
    expect(parsed?.retrospective).toBeNull();
    expect(parsed?.history).toEqual([]);
  });

  it('drops malformed records instead of rendering partial ones', () => {
    const parsed = parseAoiRelationshipHistoryResponse(
      fullPayload({
        retrospective: retrospectivePayload({ narrative: 42 }),
        history: 'nope',
        milestones: [{ id: 'x' }, null],
        firstMetAt: 'nope',
        sessionCount: null,
      }),
    );
    expect(parsed?.retrospective).toBeNull();
    expect(parsed?.history).toEqual([]);
    expect(parsed?.milestones).toEqual([]);
    expect(parsed?.firstMetAt).toBeNull();
    expect(parsed?.sessionCount).toBeNull();
  });
});

describe('aoiRelationshipHistoryPanelModel view model', () => {
  it('summarizes the relationship and formats the latest week', () => {
    const parsed = parseAoiRelationshipHistoryResponse(fullPayload());
    const view = buildAoiRelationshipHistoryViewModel(parsed!);

    expect(view.hasHistory).toBe(true);
    expect(view.summaryLabel).toContain('42 sessions together');
    expect(view.summaryLabel).toContain('2 milestones');
    expect(view.latest?.periodLabel).toBe('2026-07-22 to 2026-07-29');
    expect(view.latest?.detailLabel).toContain('1 landed');
    expect(view.latest?.detailLabel).toContain('deterministic');
  });

  it('does not repeat the latest week inside the past list', () => {
    const parsed = parseAoiRelationshipHistoryResponse(
      fullPayload({
        history: [
          retrospectivePayload(),
          retrospectivePayload({ id: 'aoi-retro-0', periodEnd: PERIOD_END - 7 * DAY }),
        ],
      }),
    );
    const view = buildAoiRelationshipHistoryViewModel(parsed!);

    expect(view.pastRows.map((row) => row.id)).toEqual(['aoi-retro-0']);
  });

  it('orders milestones newest first', () => {
    const parsed = parseAoiRelationshipHistoryResponse(fullPayload());
    const view = buildAoiRelationshipHistoryViewModel(parsed!);

    expect(view.milestoneRows.map((row) => row.id)).toEqual(['trust_promoted:L4', 'first_met']);
    expect(view.milestoneRows[1].dateLabel).toBe('2026-01-10');
  });

  it('reports an explicitly empty history when nothing is stored', () => {
    const parsed = parseAoiRelationshipHistoryResponse({
      ok: true,
      sessionPath: 'aoi/default',
      retrospective: null,
      history: [],
      milestones: [],
      firstMetAt: null,
      sessionCount: null,
    });
    const view = buildAoiRelationshipHistoryViewModel(parsed!);

    expect(view.hasHistory).toBe(false);
    expect(view.latest).toBeNull();
    expect(view.pastRows).toEqual([]);
    expect(view.summaryLabel).toBe('0 milestones');
  });
});
