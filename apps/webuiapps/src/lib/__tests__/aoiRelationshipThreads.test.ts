import { describe, expect, it } from 'vitest';

import { selectAoiRelationshipThreadToRaise } from '../aoiRelationshipThreads';

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
