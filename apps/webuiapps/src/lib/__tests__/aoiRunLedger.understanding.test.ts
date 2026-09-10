import { describe, expect, it } from 'vitest';
import {
  createAoiRunGoalFromMessage,
  createAoiRunLedgerEntry,
  escalateAoiRunLedgerEntry,
  recordAoiRunLedgerTokens,
} from '../aoiRunLedger';

function entry() {
  return createAoiRunLedgerEntry({
    goal: createAoiRunGoalFromMessage('그거 다시 읽어줘', 100),
    modelRoute: 'dialog',
    modelId: 'dialog-model',
    includeAppTools: false,
    exposedToolNames: ['respond_to_user', 'request_capabilities'],
    createdAt: 100,
    routeReason: 'regex: dialog; classifier action_request/medium',
    understanding: {
      source: 'classifier',
      kind: 'action_request',
      families: ['file'],
      confidence: 'medium',
      refersToTurn: 3,
      referent: 'src/a.ts',
      latencyMs: 420,
    },
    promptTokensEstimate: 1234.6,
  });
}

describe('run ledger understanding fields', () => {
  it('records the route reason, the reading, and the prompt estimate on creation', () => {
    const created = entry();
    expect(created.routeReason).toBe('regex: dialog; classifier action_request/medium');
    expect(created.understanding?.referent).toBe('src/a.ts');
    expect(created.promptTokensEstimate).toBe(1235);
    const bare = createAoiRunLedgerEntry({
      goal: createAoiRunGoalFromMessage('x', 1),
      modelRoute: 'main',
      includeAppTools: true,
      exposedToolNames: [],
      promptTokensEstimate: -5,
    });
    expect(bare.routeReason).toBeUndefined();
    expect(bare.understanding).toBeUndefined();
    expect(bare.promptTokensEstimate).toBeUndefined();
  });

  it('escalates a dialog entry to main in place, keeping one run per turn', () => {
    const base = entry();
    const escalated = escalateAoiRunLedgerEntry(base, {
      families: ['file', 'file', ' '],
      reason: 'the user asked to read a file',
      modelId: 'main-model',
      includeAppTools: true,
      exposedToolNames: ['respond_to_user', 'ide_read_file', 'ide_read_file'],
      routeReason: 'escalation: model requested file',
      createdAt: 200,
      promptTokensEstimate: 4321.4,
    });
    expect(escalated.promptTokensEstimate).toBe(4321);
    // One turn, one run: the escalated entry keeps the dialog attempt's id.
    expect(escalated.id).toBe(base.id);
    expect(escalated.createdAt).toBe(base.createdAt);
    expect(escalated.modelRoute).toBe('main');
    expect(escalated.modelId).toBe('main-model');
    expect(escalated.includeAppTools).toBe(true);
    expect(escalated.exposedToolNames).toEqual(['respond_to_user', 'ide_read_file']);
    expect(escalated.routeReason).toBe('escalation: model requested file');
    expect(escalated.escalation).toEqual({
      fromRoute: 'dialog',
      families: ['file'],
      reason: 'the user asked to read a file',
    });
    const event = escalated.events[escalated.events.length - 1];
    expect(event.type).toBe('capability_escalated');
    expect(event.message).toBe('dialog -> main for file: the user asked to read a file');
    expect(event.createdAt).toBe(200);
    expect(escalated.updatedAt).toBe(200);
    const noReason = escalateAoiRunLedgerEntry(entry(), {
      families: ['ida'],
      reason: '',
      includeAppTools: false,
      exposedToolNames: [],
      routeReason: 'r',
    });
    expect(noReason.modelId).toBe('dialog-model');
    expect(noReason.promptTokensEstimate).toBe(1235);
    expect(noReason.events[noReason.events.length - 1].message).toBe('dialog -> main for ida');
  });

  it('sets the prompt estimate once and accumulates provider usage', () => {
    let next = recordAoiRunLedgerTokens(entry(), {
      promptTokensEstimate: 9999,
      usageTotalTokens: 500,
    });
    expect(next.promptTokensEstimate).toBe(1235);
    expect(next.usageTotalTokens).toBe(500);
    next = recordAoiRunLedgerTokens(next, { usageTotalTokens: 250.4 });
    expect(next.usageTotalTokens).toBe(750);
    next = recordAoiRunLedgerTokens(next, { usageTotalTokens: 0 });
    expect(next.usageTotalTokens).toBe(750);
    const fresh = createAoiRunLedgerEntry({
      goal: createAoiRunGoalFromMessage('x', 1),
      modelRoute: 'main',
      includeAppTools: true,
      exposedToolNames: [],
    });
    expect(
      recordAoiRunLedgerTokens(fresh, { promptTokensEstimate: 10.2 }).promptTokensEstimate,
    ).toBe(10);
    expect(recordAoiRunLedgerTokens(fresh, {})).toEqual(fresh);
  });
});
