import { describe, expect, it } from 'vitest';
import {
  buildAoiToolBatchSignature,
  createAoiToolLoopGuardState,
  observeAoiToolLoopBatch,
} from '../aoiToolLoopGuard';

describe('aoiToolLoopGuard', () => {
  it('builds a stable signature independent of tool order', () => {
    const a = buildAoiToolBatchSignature([
      { function: { name: 'file_list', arguments: '{"path":"apps/youtube"}' } },
      { function: { name: 'file_read', arguments: '{"file_path":"apps/youtube/guide.md"}' } },
    ]);
    const b = buildAoiToolBatchSignature([
      { function: { name: 'file_read', arguments: '{"file_path":"apps/youtube/guide.md"}' } },
      { function: { name: 'file_list', arguments: '{"path":"apps/youtube"}' } },
    ]);
    expect(a).toBe(b);
  });

  it('emits a stall prompt after the same tool batch repeats', () => {
    let state = createAoiToolLoopGuardState();
    const toolCalls = [
      { function: { name: 'file_list', arguments: '{"path":"apps/youtube/data/youtube"}' } },
    ];

    const first = observeAoiToolLoopBatch({
      state,
      toolCalls,
      iterations: 3,
      iterationLimit: 10,
      deliveredAssistantContent: '',
      batchHasRespondTool: false,
    });
    expect(first.kind).toBe('none');
    state = first.state;

    const second = observeAoiToolLoopBatch({
      state,
      toolCalls,
      iterations: 4,
      iterationLimit: 10,
      deliveredAssistantContent: '',
      batchHasRespondTool: false,
    });
    expect(second.kind).toBe('stall');
    expect(second.prompt).toContain('Tool-loop guard');
    expect(second.prompt).toContain('respond_to_user');
  });

  it('emits a budget prompt near the iteration limit', () => {
    const decision = observeAoiToolLoopBatch({
      state: createAoiToolLoopGuardState(),
      toolCalls: [
        { function: { name: 'file_read', arguments: '{"file_path":"apps/youtube/guide.md"}' } },
      ],
      iterations: 9,
      iterationLimit: 10,
      deliveredAssistantContent: '',
      batchHasRespondTool: false,
    });

    expect(decision.kind).toBe('budget');
    expect(decision.prompt).toContain('final model turn');
    expect(decision.prompt).toContain('respond_to_user');
  });

  it('does not prompt when respond_to_user is already in the batch', () => {
    const decision = observeAoiToolLoopBatch({
      state: createAoiToolLoopGuardState(),
      toolCalls: [
        { function: { name: 'file_list', arguments: '{"directory":"apps/youtube"}' } },
        {
          function: {
            name: 'respond_to_user',
            arguments: '{"character_expression":{"content":"ok"}}',
          },
        },
      ],
      iterations: 9,
      iterationLimit: 10,
      deliveredAssistantContent: '',
      batchHasRespondTool: true,
    });

    expect(decision.kind).toBe('none');
    expect(decision.prompt).toBe('');
  });

  it('skips guard when an assistant reply was already delivered', () => {
    const decision = observeAoiToolLoopBatch({
      state: createAoiToolLoopGuardState(),
      toolCalls: [{ function: { name: 'file_list', arguments: '{"directory":"apps/youtube"}' } }],
      iterations: 9,
      iterationLimit: 10,
      deliveredAssistantContent: 'already answered',
      batchHasRespondTool: false,
    });
    expect(decision.kind).toBe('none');
  });

  it('handles invalid JSON arguments and nested arrays in signatures', () => {
    const signature = buildAoiToolBatchSignature([
      { function: { name: 'file_list', arguments: '{not-json' } },
      {
        function: {
          name: 'file_read',
          arguments: JSON.stringify({ tags: ['a', 'b'], nested: { z: 1, a: 2 } }),
        },
      },
    ]);
    expect(signature).toContain('file_list:');
    expect(signature).toContain('file_read:');
  });
});
