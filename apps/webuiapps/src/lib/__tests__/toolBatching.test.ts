import { describe, expect, it } from 'vitest';

import { canParallelizeToolBatch, isParallelSafeToolName } from '../toolBatching';

describe('toolBatching', () => {
  it('recognizes safe read-only tool names', () => {
    expect(isParallelSafeToolName('file_read')).toBe(true);
    expect(isParallelSafeToolName('ide_search')).toBe(true);
    expect(isParallelSafeToolName('get_app_intents')).toBe(true);
    expect(isParallelSafeToolName('get_research_status')).toBe(true);
    expect(isParallelSafeToolName('read_research_artifact')).toBe(true);
    expect(isParallelSafeToolName('start_research')).toBe(false);
    expect(isParallelSafeToolName('cancel_research')).toBe(false);
    expect(isParallelSafeToolName('file_write')).toBe(false);
  });

  it('parallelizes only multi-call batches of safe tools', () => {
    expect(
      canParallelizeToolBatch([
        {
          id: '1',
          type: 'function',
          function: { name: 'file_read', arguments: '{}' },
        },
        {
          id: '2',
          type: 'function',
          function: { name: 'workspace_search', arguments: '{}' },
        },
      ]),
    ).toBe(true);

    expect(
      canParallelizeToolBatch([
        {
          id: '1',
          type: 'function',
          function: { name: 'file_read', arguments: '{}' },
        },
      ]),
    ).toBe(false);

    expect(
      canParallelizeToolBatch([
        {
          id: '1',
          type: 'function',
          function: { name: 'file_read', arguments: '{}' },
        },
        {
          id: '2',
          type: 'function',
          function: { name: 'app_action', arguments: '{}' },
        },
      ]),
    ).toBe(false);
  });
});
