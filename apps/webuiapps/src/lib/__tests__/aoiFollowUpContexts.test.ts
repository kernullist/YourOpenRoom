import { beforeEach, describe, expect, it } from 'vitest';

import {
  FOLLOW_UP_CONTEXT_TTL_MS,
  MAX_FOLLOW_UP_CONTEXTS,
  loadAgendaFollowUpContexts,
  loadTrendFollowUpContexts,
  saveAgendaFollowUpContexts,
  saveTrendFollowUpContexts,
} from '../aoiFollowUpContexts';
import { parseAoiAgendaChatFollowUpContext } from '../aoiAutonomyUi';
import {
  parseAoiProactiveTrendFollowUpContext,
  type AoiProactiveTrendFollowUpContext,
} from '../aoiProactiveTrendFollowUp';

const SESSION = 'sessions/aoi/space_adventure';
const OTHER_SESSION = 'sessions/aoi/other_story';
const NOW = 1788140769921;

const TREND_KEY = 'aoi-trend-follow-up-contexts-v1';
const AGENDA_KEY = 'aoi-agenda-follow-up-contexts-v1';

function trendContext(
  overrides: Partial<AoiProactiveTrendFollowUpContext> = {},
): AoiProactiveTrendFollowUpContext {
  return {
    version: 1,
    prompt: '출처 보여줘',
    cardId: 'trend-card-1',
    snapshotId: 'snapshot-1',
    topicId: 'topic-kernel',
    topicLabel: 'Windows kernel security',
    title: 'A NEW ANTI-TAMPER BYPASS IS CIRCULATING',
    myTake: 'Worth reading before the next driver review.',
    suggestedNextAction: 'Read the advisory.',
    sourceHosts: ['example.test'],
    sources: [
      {
        title: 'The advisory',
        url: 'https://example.test/advisory',
        host: 'example.test',
        snippet: 'Details of the bypass.',
      },
    ],
    evidenceRefs: ['snapshot-1#1'],
    createdAt: NOW,
    ...overrides,
  };
}

function agendaContext(createdAt = NOW, prompt = '왜 지금이야?') {
  return {
    prompt,
    nudge: {
      dedupeKey: 'proposal-7:approval_waiting',
      reason: 'approval_waiting' as const,
      proposalId: 'proposal-7',
      chatText: '승인 대기 중인 제안이 하나 있어.',
      suggestedReplies: ['왜 지금이야?', '나중에'],
      evidenceRefs: ['proposal-7'],
    },
    createdAt,
  };
}

describe('aoiFollowUpContexts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a trend context for the session that wrote it', () => {
    saveTrendFollowUpContexts(SESSION, [trendContext()]);
    expect(loadTrendFollowUpContexts(SESSION, NOW)).toEqual([trendContext()]);
  });

  it('round-trips an agenda context for the session that wrote it', () => {
    saveAgendaFollowUpContexts(SESSION, [agendaContext()]);
    expect(loadAgendaFollowUpContexts(SESSION, NOW)).toEqual([agendaContext()]);
  });

  // One storage key serves every session, and switching sessions reloads a
  // different transcript. Its cards can carry chips with identical labels, so
  // restoring the previous session's contexts would answer about the wrong card.
  it('restores nothing for a different session', () => {
    saveTrendFollowUpContexts(SESSION, [trendContext()]);
    saveAgendaFollowUpContexts(SESSION, [agendaContext()]);
    expect(loadTrendFollowUpContexts(OTHER_SESSION, NOW)).toEqual([]);
    expect(loadAgendaFollowUpContexts(OTHER_SESSION, NOW)).toEqual([]);
  });

  it('drops contexts past the storage TTL', () => {
    saveTrendFollowUpContexts(SESSION, [trendContext()]);
    saveAgendaFollowUpContexts(SESSION, [agendaContext()]);
    expect(loadTrendFollowUpContexts(SESSION, NOW + FOLLOW_UP_CONTEXT_TTL_MS)).toHaveLength(1);
    expect(loadTrendFollowUpContexts(SESSION, NOW + FOLLOW_UP_CONTEXT_TTL_MS + 1)).toEqual([]);
    expect(loadAgendaFollowUpContexts(SESSION, NOW + FOLLOW_UP_CONTEXT_TTL_MS + 1)).toEqual([]);
  });

  it('clears the entry when the last context is consumed', () => {
    saveTrendFollowUpContexts(SESSION, [trendContext()]);
    saveTrendFollowUpContexts(SESSION, []);
    expect(localStorage.getItem(TREND_KEY)).toBeNull();
    expect(loadTrendFollowUpContexts(SESSION, NOW)).toEqual([]);
  });

  it('keeps the newest contexts when more than the cap are written', () => {
    const many = Array.from({ length: MAX_FOLLOW_UP_CONTEXTS + 5 }, (_unused, index) =>
      trendContext({ prompt: `출처 보여줘 ${index}` }),
    );
    saveTrendFollowUpContexts(SESSION, many);
    const loaded = loadTrendFollowUpContexts(SESSION, NOW);
    expect(loaded).toHaveLength(MAX_FOLLOW_UP_CONTEXTS);
    expect(loaded[loaded.length - 1].prompt).toBe(`출처 보여줘 ${MAX_FOLLOW_UP_CONTEXTS + 4}`);
  });

  it('reads against the wall clock when no time is given', () => {
    const fresh = trendContext({ createdAt: Date.now() });
    saveTrendFollowUpContexts(SESSION, [fresh]);
    saveAgendaFollowUpContexts(SESSION, [agendaContext(Date.now())]);
    expect(loadTrendFollowUpContexts(SESSION)).toEqual([fresh]);
    expect(loadAgendaFollowUpContexts(SESSION)).toHaveLength(1);

    saveTrendFollowUpContexts(SESSION, [trendContext({ createdAt: 1 })]);
    expect(loadTrendFollowUpContexts(SESSION)).toEqual([]);
  });

  it('survives malformed storage instead of throwing', () => {
    localStorage.setItem(TREND_KEY, 'not json');
    expect(loadTrendFollowUpContexts(SESSION, NOW)).toEqual([]);
    localStorage.setItem(AGENDA_KEY, JSON.stringify({ sessionPath: SESSION, contexts: 'nope' }));
    expect(loadAgendaFollowUpContexts(SESSION, NOW)).toEqual([]);
  });

  it('drops unusable entries and keeps the usable ones beside them', () => {
    localStorage.setItem(
      TREND_KEY,
      JSON.stringify({
        version: 1,
        sessionPath: SESSION,
        contexts: [{ version: 1, prompt: 'no snapshot' }, null, trendContext()],
      }),
    );
    expect(loadTrendFollowUpContexts(SESSION, NOW)).toEqual([trendContext()]);
  });
});

describe('parseAoiProactiveTrendFollowUpContext', () => {
  it('re-sanitizes a stored context rather than trusting it', () => {
    const parsed = parseAoiProactiveTrendFollowUpContext({
      ...trendContext(),
      title: '  A  SPACED   TITLE  ',
      sourceHosts: 'not an array',
      sources: [{ url: 'javascript:alert(1)', title: 'bad', host: 'x', snippet: '' }],
    });
    expect(parsed?.title).toBe('A SPACED TITLE');
    expect(parsed?.sourceHosts).toEqual([]);
    // A non-http URL is not a source Aoi may later be asked to open.
    expect(parsed?.sources).toEqual([]);
  });

  it('refuses what it cannot identify or date', () => {
    expect(parseAoiProactiveTrendFollowUpContext(null)).toBeNull();
    expect(parseAoiProactiveTrendFollowUpContext('nope')).toBeNull();
    expect(parseAoiProactiveTrendFollowUpContext({ ...trendContext(), version: 2 })).toBeNull();
    expect(parseAoiProactiveTrendFollowUpContext({ ...trendContext(), createdAt: 0 })).toBeNull();
    expect(parseAoiProactiveTrendFollowUpContext({ ...trendContext(), prompt: '  ' })).toBeNull();
    // No snapshot means the context cannot say what it is about.
    expect(parseAoiProactiveTrendFollowUpContext({ ...trendContext(), snapshotId: '' })).toBeNull();
  });
});

describe('parseAoiAgendaChatFollowUpContext', () => {
  it('keeps a well-formed context and re-sanitizes its text', () => {
    const parsed = parseAoiAgendaChatFollowUpContext({
      ...agendaContext(),
      nudge: { ...agendaContext().nudge, chatText: '  승인   대기 중  ' },
    });
    expect(parsed?.nudge.chatText).toBe('승인 대기 중');
    expect(parsed?.nudge.reason).toBe('approval_waiting');
    expect(parsed?.nudge.suggestedReplies).toEqual(['왜 지금이야?', '나중에']);
  });

  it('refuses a nudge it could not classify or act on', () => {
    const base = agendaContext();
    expect(parseAoiAgendaChatFollowUpContext(null)).toBeNull();
    expect(parseAoiAgendaChatFollowUpContext({ ...base, nudge: undefined })).toBeNull();
    expect(parseAoiAgendaChatFollowUpContext({ ...base, createdAt: 0 })).toBeNull();
    expect(parseAoiAgendaChatFollowUpContext({ ...base, prompt: '   ' })).toBeNull();
    expect(
      parseAoiAgendaChatFollowUpContext({
        ...base,
        nudge: { ...base.nudge, reason: 'made_up_reason' },
      }),
    ).toBeNull();
    expect(
      parseAoiAgendaChatFollowUpContext({ ...base, nudge: { ...base.nudge, chatText: '' } }),
    ).toBeNull();
  });
});
