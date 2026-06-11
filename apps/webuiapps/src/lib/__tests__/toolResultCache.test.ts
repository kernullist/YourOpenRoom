import { describe, expect, it, vi } from 'vitest';

import {
  buildToolCacheKey,
  createToolResultCache,
  isCacheableToolName,
  isCacheableToolResult,
} from '../toolResultCache';

describe('toolResultCache', () => {
  it('builds stable cache keys for reordered objects', () => {
    expect(buildToolCacheKey('file_read', { end_line: 10, file_path: 'a.ts', start_line: 1 })).toBe(
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
    expect(isCacheableToolName('get_research_status')).toBe(true);
    expect(isCacheableToolName('read_research_artifact')).toBe(true);
    expect(isCacheableToolName('start_research')).toBe(false);
    expect(isCacheableToolName('file_write')).toBe(false);
  });

  it('caches research status and artifacts only after completion', () => {
    const runningStatus = JSON.stringify({
      ok: true,
      run: { id: 'run-1', status: 'running', phase: 'reading_sources' },
    });
    const completedStatus = JSON.stringify({
      ok: true,
      run: { id: 'run-1', status: 'completed', phase: 'completed' },
    });
    const completedReport = JSON.stringify({
      ok: true,
      run: { id: 'run-1', status: 'completed', phase: 'completed' },
      artifact: 'report',
      content: '# Report',
    });
    const cache = createToolResultCache(1000);

    expect(isCacheableToolResult('get_research_status', runningStatus)).toBe(false);
    expect(isCacheableToolResult('get_research_status', completedStatus)).toBe(true);
    expect(isCacheableToolResult('read_research_artifact', completedReport)).toBe(true);

    cache.set('get_research_status', { run_id: 'run-1' }, runningStatus);
    expect(cache.get('get_research_status', { run_id: 'run-1' })).toBeNull();

    cache.set('get_research_status', { run_id: 'run-1' }, completedStatus);
    expect(cache.get('get_research_status', { run_id: 'run-1' })).toBe(completedStatus);
  });
});
