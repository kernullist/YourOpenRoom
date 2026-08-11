import { describe, expect, it } from 'vitest';

import {
  selectAoiRelationshipThreadTitles,
  selectAoiRelationshipThreadToRaise,
} from '../aoiRelationshipThreads';

describe('selectAoiRelationshipThreadTitles', () => {
  it('records accepted threads and ignores blocked ones', () => {
    expect(
      selectAoiRelationshipThreadTitles({
        openThreads: ['Ship the driver telemetry patch'],
        blockedThreads: [
          'Review completed Aoi research -- too_many_active_proposals',
          'Refresh research narrowly -- too_many_active_proposals',
        ],
      }),
    ).toEqual(['Ship the driver telemetry patch']);
  });

  it('never leaks an internal blocker code into the record', () => {
    const titles = selectAoiRelationshipThreadTitles({
      openThreads: [],
      blockedThreads: ['Review completed Aoi research -- too_many_active_proposals'],
    });
    // The persona bridge frames this list as "Still unresolved between you", so a
    // policy reason reaching it becomes a question the user cannot answer.
    expect(titles).toEqual([]);
    expect(titles.join(' ')).not.toContain('too_many_active_proposals');
  });

  it('drops blank titles and caps the list', () => {
    expect(
      selectAoiRelationshipThreadTitles({
        openThreads: ['  ', '', 'kept'],
      }),
    ).toEqual(['kept']);
    expect(
      selectAoiRelationshipThreadTitles({
        openThreads: Array.from({ length: 12 }, (_, index) => `thread ${index}`),
      }),
    ).toHaveLength(8);
  });

  it('drops operator recovery action titles so greetings do not ask about them', () => {
    expect(
      selectAoiRelationshipThreadTitles({
        openThreads: ['리서치 좁혀서 재시도', 'Ship the driver telemetry patch', '범위 좁히기'],
      }),
    ).toEqual(['Ship the driver telemetry patch']);
  });

  it('treats an absent or malformed brief as nothing to record', () => {
    expect(selectAoiRelationshipThreadTitles({})).toEqual([]);
    expect(selectAoiRelationshipThreadTitles({ openThreads: null })).toEqual([]);
  });
});

function thread(id: string, noticedAt: number, lastAskedAt?: number) {
  return { id, title: id, noticedAt, ...(lastAskedAt !== undefined ? { lastAskedAt } : {}) };
}

describe('selectAoiRelationshipThreadToRaise', () => {
  it('raises the oldest never-asked thread regardless of input order', () => {
    const selected = selectAoiRelationshipThreadToRaise([
      thread('newer', 300),
      thread('oldest', 100),
      thread('middle', 200),
    ]);
    expect(selected?.id).toBe('oldest');
  });

  it('skips threads already raised, even when they are older', () => {
    const selected = selectAoiRelationshipThreadToRaise([
      thread('old-but-asked', 100, 150),
      thread('unasked', 200),
    ]);
    expect(selected?.id).toBe('unasked');
  });

  it('returns null once every thread has been raised', () => {
    expect(
      selectAoiRelationshipThreadToRaise([thread('a', 100, 150), thread('b', 200, 250)]),
    ).toBeNull();
  });

  it('returns null for an empty or absent list', () => {
    expect(selectAoiRelationshipThreadToRaise([])).toBeNull();
    expect(selectAoiRelationshipThreadToRaise(null)).toBeNull();
    expect(selectAoiRelationshipThreadToRaise(undefined)).toBeNull();
  });

  it('does not mutate the caller list while sorting', () => {
    const threads = [thread('b', 200), thread('a', 100)];
    selectAoiRelationshipThreadToRaise(threads);
    expect(threads.map((item) => item.id)).toEqual(['b', 'a']);
  });
});
