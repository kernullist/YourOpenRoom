import { describe, expect, it, vi } from 'vitest';

import { buildToolCacheKey, createToolResultCache, isCacheableToolName } from '../toolResultCache';

describe('toolResultCache', () => {
  it('builds stable cache keys for reordered objects', () => {
    expect(
      buildToolCacheKey('file_read', { end_line: 10, file_path: 'a.ts', start_line: 1 }),
    ).toBe(
      buildToolCacheKey('file_read', { file_path: 'a.ts', start_line: 1, end_line: 10 }),
    );
  });

  it('stores and expires cache entries', () => {
    vi.useFakeTimers();
    const cache = createToolResultCache(1000);
    cache.set('file_read', { file_path: 'a.ts' }, 'hello');
    expect(cache.get('file_read', { file_path: 'a.ts' })).toBe('hello');
    vi.advanceTimersByTime(1001);
    expect(cache.get('file_read', { file_path: 'a.ts' })).toBeNull();
    vi.useRealTimers();
  });

  it('knows which tools are cacheable', () => {
    expect(isCacheableToolName('ide_search')).toBe(true);
    expect(isCacheableToolName('file_write')).toBe(false);
  });
});
