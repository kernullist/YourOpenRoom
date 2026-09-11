import { describe, expect, it } from 'vitest';
import type { AoiTurnRecord } from '../aoiTurnRecord';
import type { AoiTurnUnderstanding } from '../aoiTurnUnderstanding';
import {
  AOI_REQUEST_CAPABILITIES_TOOL_NAME,
  buildAoiRequestCapabilitiesPolicyPrompt,
  buildAoiTurnContextPromptBlock,
  decideAoiClarification,
  getAoiRequestCapabilitiesToolDefinition,
  isActionableAoiUnderstanding,
  parseAoiRequestCapabilitiesParams,
  resolveAoiTurnRoute,
  resolveAoiTurnToolFlags,
  toAoiRunLedgerUnderstanding,
} from '../aoiTurnContext';

function reading(over: Partial<AoiTurnUnderstanding> = {}): AoiTurnUnderstanding {
  return {
    kind: over.kind ?? 'action_request',
    families: over.families ?? ['file'],
    refersToTurn: over.refersToTurn ?? null,
    referent: over.referent ?? null,
    confidence: over.confidence ?? 'high',
    needsClarification: over.needsClarification ?? null,
    clarificationOptions: over.clarificationOptions ?? [],
    source: over.source ?? 'classifier',
    musicTarget: over.musicTarget ?? null,
    musicReference: over.musicReference ?? null,
  };
}

function record(over: Partial<AoiTurnRecord> = {}): AoiTurnRecord {
  return {
    version: 1,
    id: over.id ?? 'r',
    turnIndex: over.turnIndex ?? 1,
    createdAt: 1,
    userMessage: over.userMessage ?? 'u',
    assistantMessage: over.assistantMessage ?? 'a',
    route: 'main',
    routeReason: 't',
    kind: 'action_request',
    families: ['file'],
    tools: [],
    entities: [],
    offers: [],
    openQuestion: null,
    outcome: over.outcome ?? 'delivered',
  };
}

const BASE = {
  hasAttachments: false,
  outcomeFeedbackContract: false,
  dialogAvailable: true,
  regexDialog: true,
  understanding: null,
  escalation: null,
};

describe('isActionableAoiUnderstanding', () => {
  it('requires a high-confidence classifier reading with a real family', () => {
    expect(isActionableAoiUnderstanding(reading())).toBe(true);
    expect(isActionableAoiUnderstanding(reading({ confidence: 'medium' }))).toBe(false);
    expect(isActionableAoiUnderstanding(reading({ source: 'regex' }))).toBe(false);
    expect(isActionableAoiUnderstanding(reading({ families: ['none'] }))).toBe(false);
    expect(isActionableAoiUnderstanding(null)).toBe(false);
    expect(isActionableAoiUnderstanding(undefined)).toBe(false);
  });
});

describe('toAoiRunLedgerUnderstanding', () => {
  it('copies the reading into the ledger shape and drops an absent latency', () => {
    expect(toAoiRunLedgerUnderstanding(null)).toBeUndefined();
    expect(toAoiRunLedgerUnderstanding(undefined)).toBeUndefined();
    expect(toAoiRunLedgerUnderstanding(reading({ refersToTurn: 3, referent: 'a.ts' }))).toEqual({
      source: 'classifier',
      kind: 'action_request',
      families: ['file'],
      confidence: 'high',
      refersToTurn: 3,
      referent: 'a.ts',
    });
    expect(toAoiRunLedgerUnderstanding({ ...reading(), latencyMs: 42 })?.latencyMs).toBe(42);
  });
});

describe('resolveAoiTurnRoute', () => {
  it('sends image turns and contracts to main before anything else', () => {
    expect(resolveAoiTurnRoute({ ...BASE, hasAttachments: true }).layer).toBe('attachment');
    expect(resolveAoiTurnRoute({ ...BASE, outcomeFeedbackContract: true })).toMatchObject({
      route: 'main',
      layer: 'contract',
    });
  });

  it('honours an escalation with its families', () => {
    const decision = resolveAoiTurnRoute({
      ...BASE,
      escalation: { families: ['file', 'none', 'file'], reason: 'needs files' },
    });
    expect(decision).toEqual({
      route: 'main',
      reason: 'escalation: model requested file',
      layer: 'escalation',
      families: ['file'],
    });
  });

  it('goes to main when no dialog config exists', () => {
    expect(resolveAoiTurnRoute({ ...BASE, dialogAvailable: false }).layer).toBe('no_dialog_config');
  });

  it('keeps the regex main decision and records added families', () => {
    expect(resolveAoiTurnRoute({ ...BASE, regexDialog: false })).toMatchObject({
      route: 'main',
      reason: 'regex: main',
      families: [],
    });
    expect(
      resolveAoiTurnRoute({
        ...BASE,
        regexDialog: false,
        understanding: reading({ families: ['ida'] }),
      }),
    ).toMatchObject({
      route: 'main',
      reason: 'regex: main; classifier adds ida',
      families: ['ida'],
    });
  });

  it('pulls a regex-dialog turn to main on a high-confidence reading with a family', () => {
    const decision = resolveAoiTurnRoute({
      ...BASE,
      understanding: reading({ kind: 'confirmation', families: ['app'] }),
    });
    expect(decision).toEqual({
      route: 'main',
      reason: 'classifier: confirmation needs app; pulled from dialog',
      layer: 'classifier',
      families: ['app'],
    });
  });

  it('never pushes a turn to dialog and never acts on weak readings', () => {
    expect(
      resolveAoiTurnRoute({
        ...BASE,
        understanding: reading({ confidence: 'medium', families: ['file'] }),
      }),
    ).toMatchObject({ route: 'dialog', reason: 'regex: dialog; classifier action_request/medium' });
    expect(
      resolveAoiTurnRoute({
        ...BASE,
        understanding: reading({ kind: 'chitchat', families: ['none'] }),
      }),
    ).toMatchObject({ route: 'dialog' });
    expect(
      resolveAoiTurnRoute({ ...BASE, understanding: reading({ source: 'regex' }) }),
    ).toMatchObject({ route: 'dialog', reason: 'regex: dialog' });
    expect(resolveAoiTurnRoute(BASE)).toMatchObject({
      route: 'dialog',
      reason: 'regex: dialog',
      families: [],
    });
  });
});

describe('resolveAoiTurnToolFlags', () => {
  const off = { includeAppTools: false, includeIdaTools: false, includeGhidraTools: false };

  it('turns flags on for the families named and reports what was added', () => {
    expect(resolveAoiTurnToolFlags({ regex: off, families: ['file', 'ghidra'] })).toEqual({
      includeAppTools: true,
      includeIdaTools: false,
      includeGhidraTools: true,
      added: ['app', 'ghidra'],
    });
    expect(resolveAoiTurnToolFlags({ regex: off, families: ['command'] }).includeAppTools).toBe(
      true,
    );
    expect(resolveAoiTurnToolFlags({ regex: off, families: ['ida'] })).toMatchObject({
      includeIdaTools: true,
      added: ['ida'],
    });
  });

  it('never turns a regex flag off and reports nothing added when regex already had it', () => {
    const on = { includeAppTools: true, includeIdaTools: true, includeGhidraTools: true };
    expect(resolveAoiTurnToolFlags({ regex: on, families: ['none'] })).toEqual({
      ...on,
      added: [],
    });
    expect(
      resolveAoiTurnToolFlags({ regex: on, families: ['app', 'ida', 'ghidra'] }).added,
    ).toEqual([]);
    expect(
      resolveAoiTurnToolFlags({ regex: off, families: ['browser', 'host', 'research'] }),
    ).toEqual({
      ...off,
      added: [],
    });
  });
});

describe('request_capabilities', () => {
  it('defines the tool without "none" and with families required', () => {
    const def = getAoiRequestCapabilitiesToolDefinition();
    expect(def.function.name).toBe(AOI_REQUEST_CAPABILITIES_TOOL_NAME);
    expect(def.function.parameters.required).toEqual(['families']);
    const families = def.function.parameters.properties.families as { items: { enum: string[] } };
    expect(families.items.enum).not.toContain('none');
    expect(families.items.enum).toContain('browser');
  });

  it('parses and normalizes families, trims the reason, and rejects empties', () => {
    expect(
      parseAoiRequestCapabilitiesParams({
        families: ['File', 'none', 'file', 'bogus', 3],
        reason: `  needs   files ${'x'.repeat(200)}`,
      }),
    ).toMatchObject({ families: ['file'] });
    expect(parseAoiRequestCapabilitiesParams({ families: ['file'] })?.reason).toBe('');
    expect(
      parseAoiRequestCapabilitiesParams({ families: ['file'], reason: 'r'.repeat(200) })?.reason,
    ).toHaveLength(163);
    expect(parseAoiRequestCapabilitiesParams({ families: ['none'] })).toBeNull();
    expect(parseAoiRequestCapabilitiesParams({ families: 'file' })).toBeNull();
    expect(parseAoiRequestCapabilitiesParams(null)).toBeNull();
    expect(parseAoiRequestCapabilitiesParams('x')).toBeNull();
  });

  it('states the policy in terms of the tool name', () => {
    const prompt = buildAoiRequestCapabilitiesPolicyPrompt();
    expect(prompt).toContain(AOI_REQUEST_CAPABILITIES_TOOL_NAME);
    expect(prompt).toContain('Never tell the user a capability is unavailable');
  });
});

describe('decideAoiClarification', () => {
  const low = reading({
    confidence: 'low',
    kind: 'action_request',
    families: ['file'],
    needsClarification: '어느 파일?',
    clarificationOptions: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
  });

  it('asks when the reading is low, actionable, side-effectful, and has a question', () => {
    expect(decideAoiClarification({ understanding: low, previousRecord: null })).toEqual({
      ask: true,
      question: '어느 파일?',
      options: ['a.ts', 'b.ts', 'c.ts'],
    });
    expect(decideAoiClarification({ understanding: low, previousRecord: record() })).toMatchObject({
      ask: true,
    });
  });

  it('declines for every other case with a reason', () => {
    expect(decideAoiClarification({ understanding: null, previousRecord: null })).toEqual({
      ask: false,
      reason: 'no classifier reading',
    });
    expect(
      decideAoiClarification({ understanding: { ...low, source: 'regex' }, previousRecord: null })
        .ask,
    ).toBe(false);
    expect(
      decideAoiClarification({
        understanding: { ...low, confidence: 'medium' },
        previousRecord: null,
      }),
    ).toEqual({
      ask: false,
      reason: 'confidence medium',
    });
    expect(
      decideAoiClarification({ understanding: { ...low, kind: 'question' }, previousRecord: null }),
    ).toEqual({
      ask: false,
      reason: 'kind question',
    });
    expect(
      decideAoiClarification({
        understanding: { ...low, families: ['research'] },
        previousRecord: null,
      }),
    ).toEqual({
      ask: false,
      reason: 'no side-effect family',
    });
    expect(
      decideAoiClarification({
        understanding: { ...low, needsClarification: '  ' },
        previousRecord: null,
      }),
    ).toEqual({
      ask: false,
      reason: 'classifier gave no question',
    });
    expect(
      decideAoiClarification({
        understanding: low,
        previousRecord: record({ outcome: 'clarification_asked' }),
      }),
    ).toEqual({ ask: false, reason: 'previous turn already asked' });
  });
});

describe('buildAoiTurnContextPromptBlock', () => {
  const records = [record({ id: 'a', turnIndex: 7 }), record({ id: 'b', turnIndex: 8 })];

  it('returns the recent turns alone for regex, low, or absent readings', () => {
    expect(
      buildAoiTurnContextPromptBlock({ recentTurnsBlock: 'RT', understanding: null, records }),
    ).toBe('RT');
    expect(
      buildAoiTurnContextPromptBlock({
        recentTurnsBlock: 'RT',
        understanding: reading({ source: 'regex' }),
        records,
      }),
    ).toBe('RT');
    expect(
      buildAoiTurnContextPromptBlock({
        recentTurnsBlock: 'RT',
        understanding: reading({ confidence: 'low' }),
        records,
      }),
    ).toBe('RT');
  });

  it('appends the reading with the referenced turn position and kind-specific guidance', () => {
    const block = buildAoiTurnContextPromptBlock({
      recentTurnsBlock: 'RT',
      understanding: reading({ refersToTurn: 7, referent: 'src/a.ts' }),
      records,
    });
    expect(block).toContain('RT');
    expect(block).toContain('kind: action_request; needs: file; refers to T-2 ("src/a.ts").');
    expect(block).toContain('targets the thing from the referenced turn');

    const confirm = buildAoiTurnContextPromptBlock({
      recentTurnsBlock: '',
      understanding: reading({ kind: 'confirmation', families: ['none'], confidence: 'medium' }),
      records,
    });
    expect(confirm).toContain('kind: confirmation.');
    expect(confirm).toContain('saying yes to what Aoi last asked');

    const reject = buildAoiTurnContextPromptBlock({
      recentTurnsBlock: '',
      understanding: reading({ kind: 'rejection_or_correction', refersToTurn: 8 }),
      records,
    });
    expect(reject).toContain('refers to T-1.');
    expect(reject).toContain('refusing or correcting');

    const unknownTurn = buildAoiTurnContextPromptBlock({
      recentTurnsBlock: '',
      understanding: reading({ refersToTurn: 99 }),
      records,
    });
    expect(unknownTurn).not.toContain('refers to');
  });
});
