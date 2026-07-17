import { describe, expect, it } from 'vitest';

import {
  appendAoiRunLedgerEvent,
  buildAoiRunGoalPrompt,
  createAoiRunGoalFromMessage,
  createAoiRunLedgerEntry,
  finalizeAoiRunLedgerEntry,
  summarizeAoiRunLedger,
  upsertAoiRunLedgerEntry,
} from '../aoiRunLedger';

describe('aoiRunLedger', () => {
  it('creates a compact goal prompt from the latest user message', () => {
    const goal = createAoiRunGoalFromMessage('Implement capability registry and verify it.', 10);
    const prompt = buildAoiRunGoalPrompt(goal);

    expect(goal.summary).toBe('Implement capability registry and verify it.');
    expect(prompt).toContain('Aoi Run Goal');
    expect(prompt).toContain('Implement capability registry');
    expect(prompt).toContain('Do not append unrelated memories');
  });

  it('tracks model iterations and tool calls', () => {
    const goal = createAoiRunGoalFromMessage('Open Notes and save an item.', 100);
    let entry = createAoiRunLedgerEntry({
      goal,
      modelRoute: 'main',
      modelId: 'test-model',
      includeAppTools: true,
      exposedToolNames: ['respond_to_user', 'list_apps', 'file_write'],
      createdAt: 100,
    });

    entry = appendAoiRunLedgerEvent(entry, {
      type: 'model_response',
      iteration: 1,
      toolNames: ['list_apps', 'file_write'],
      message: 'tool batch',
      createdAt: 110,
    });
    entry = appendAoiRunLedgerEvent(entry, {
      type: 'assistant_delivered',
      iteration: 1,
      toolNames: ['list_apps', 'file_write'],
      message: 'done',
      createdAt: 120,
    });

    expect(entry.metrics.iterations).toBe(1);
    expect(entry.metrics.toolCallCount).toBe(2);
    expect(entry.metrics.deliveredToolCallCount).toBe(2);
    expect(entry.metrics.lastToolNames).toEqual(['list_apps', 'file_write']);
  });

  it('finalizes and summarizes runs', () => {
    const goal = createAoiRunGoalFromMessage('Run tests.', 200);
    const entry = finalizeAoiRunLedgerEntry(
      createAoiRunLedgerEntry({
        goal,
        modelRoute: 'dialog',
        includeAppTools: false,
        exposedToolNames: ['respond_to_user'],
        createdAt: 200,
      }),
      'completed',
      'Tests passed.',
    );
    const entries = upsertAoiRunLedgerEntry([], entry);
    const summary = summarizeAoiRunLedger(entries);

    expect(entry.status).toBe('completed');
    expect(entry.finalMessage).toBe('Tests passed.');
    expect(summary.total).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.latestRun?.id).toBe(entry.id);
  });

  it('keeps the newest version of a run entry', () => {
    const goal = createAoiRunGoalFromMessage('Do work.', 300);
    const entry = createAoiRunLedgerEntry({
      goal,
      modelRoute: 'main',
      includeAppTools: true,
      exposedToolNames: ['respond_to_user'],
      createdAt: 300,
    });
    const updated = appendAoiRunLedgerEvent(entry, {
      type: 'run_failed',
      message: 'model error',
      createdAt: 400,
    });
    const entries = upsertAoiRunLedgerEntry(upsertAoiRunLedgerEntry([], entry), updated);

    expect(entries).toHaveLength(1);
    expect(entries[0].updatedAt).toBe(400);
    expect(entries[0].metrics.errorCount).toBe(1);
  });

  it('counts tool errors and rejected postconditions as run errors', () => {
    const goal = createAoiRunGoalFromMessage('Write and verify a file.', 500);
    let entry = createAoiRunLedgerEntry({
      goal,
      modelRoute: 'main',
      includeAppTools: true,
      exposedToolNames: ['ide_write_file', 'ide_read_file', 'respond_to_user'],
      createdAt: 500,
    });
    entry = appendAoiRunLedgerEvent(entry, {
      type: 'tool_error',
      iteration: 2,
      toolNames: ['run_command'],
      message: 'command is not allowed',
      createdAt: 510,
    });
    entry = appendAoiRunLedgerEvent(entry, {
      type: 'postcondition_failed',
      iteration: 3,
      toolNames: ['respond_to_user'],
      message: 'line limit exceeded',
      createdAt: 520,
    });

    expect(entry.metrics.errorCount).toBe(2);
  });
});
