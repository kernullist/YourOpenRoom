import { describe, expect, it } from 'vitest';

import {
  classifyAoiBrowserDriveActVerdict,
  decideAoiBrowserDriveNextStep,
  describeAoiBrowserDriveVerdict,
  parseAoiBrowserDriveVerdict,
  type AoiBrowserDriveVerdict,
} from '../aoiBrowserDriveVerdict';

describe('classifyAoiBrowserDriveActVerdict', () => {
  it('confirms a write only when the value reads back', () => {
    expect(
      classifyAoiBrowserDriveActVerdict({
        kind: 'type',
        ok: true,
        readBack: { expected: 'hello', actual: 'hello' },
      }),
    ).toEqual({ effect: 'confirmed', verified: true });
  });

  it('ignores surrounding whitespace when comparing the read-back', () => {
    expect(
      classifyAoiBrowserDriveActVerdict({
        kind: 'type',
        ok: true,
        readBack: { expected: 'hello', actual: '  hello ' },
      }).verified,
    ).toBe(true);
  });

  it('calls a mismatched read-back a no-op and points at the selector', () => {
    // The strongest negative signal available: the field was written and still
    // holds something else, so the selector was probably wrong.
    const verdict = classifyAoiBrowserDriveActVerdict({
      kind: 'type',
      ok: true,
      readBack: { expected: 'hello', actual: '' },
    });
    expect(verdict.effect).toBe('suspected_noop');
    expect(verdict.verified).toBe(false);
    expect(verdict.escalation?.recommended).toBe('alternate_selector');
  });

  it('does not claim success when the read-back itself failed', () => {
    const verdict = classifyAoiBrowserDriveActVerdict({
      kind: 'type',
      ok: true,
      readBack: { expected: 'hello', actual: null },
    });
    expect(verdict.effect).toBe('unverifiable');
    expect(verdict.verified).toBe(false);
  });

  it('treats a navigation as proof of an effect, but not as verified', () => {
    // Something demonstrably happened; it does not follow that the intended
    // control is what caused it.
    expect(
      classifyAoiBrowserDriveActVerdict({
        kind: 'click',
        ok: true,
        urlBefore: 'https://example.test/a',
        urlAfter: 'https://example.test/b',
      }),
    ).toEqual({ effect: 'confirmed', verified: false });
  });

  it('leaves a click that changed nothing observable unverifiable, not failed', () => {
    // Opening a menu or focusing a field legitimately changes no URL and writes
    // no value. Calling that a failure would push the model into pointless
    // retries; calling it success is the bug this contract exists to stop.
    const verdict = classifyAoiBrowserDriveActVerdict({
      kind: 'click',
      ok: true,
      urlBefore: 'https://example.test/a',
      urlAfter: 'https://example.test/a',
    });
    expect(verdict.effect).toBe('unverifiable');
    expect(verdict.escalation?.recommended).toBe('fresh_state');
  });

  it('does not invent a navigation from a missing url sample', () => {
    expect(
      classifyAoiBrowserDriveActVerdict({ kind: 'click', ok: true, urlAfter: 'https://x.test/' })
        .effect,
    ).toBe('unverifiable');
    expect(classifyAoiBrowserDriveActVerdict({ kind: 'click', ok: true }).effect).toBe(
      'unverifiable',
    );
  });

  it('carries a stop reason through as a structured refusal that must not be retried', () => {
    const verdict = classifyAoiBrowserDriveActVerdict({
      kind: 'click',
      ok: false,
      stopReason: 'drift_to_denylist',
    });
    expect(verdict).toMatchObject({
      effect: 'suspected_noop',
      verified: false,
      code: 'drift_to_denylist',
    });
    expect(verdict.escalation?.recommended).toBe('stop');
  });

  it('handles a failure with no stop reason', () => {
    const verdict = classifyAoiBrowserDriveActVerdict({ kind: 'click', ok: false });
    expect(verdict.effect).toBe('suspected_noop');
    expect(verdict.code).toBeUndefined();
    expect(verdict.escalation?.recommended).toBe('fresh_state');
  });
});

describe('decideAoiBrowserDriveNextStep', () => {
  it('stops on a confirmed effect', () => {
    expect(decideAoiBrowserDriveNextStep({ effect: 'confirmed', verified: true }).decision).toBe(
      'done',
    );
    expect(decideAoiBrowserDriveNextStep({ effect: 'confirmed', verified: false }).decision).toBe(
      'done',
    );
  });

  it('sends an unverifiable action to fresh state, never to a repeat', () => {
    const next = decideAoiBrowserDriveNextStep({
      effect: 'unverifiable',
      verified: false,
      escalation: { recommended: 'fresh_state', reason: 'nothing changed' },
    });
    expect(next.decision).toBe('verify_fresh_state');
    // Deliberately no `recommended`: an unverifiable action must not be repeated.
    expect(next.recommended).toBeUndefined();
  });

  it('escalates a suspected no-op with the recommended rung', () => {
    expect(
      decideAoiBrowserDriveNextStep({
        effect: 'suspected_noop',
        verified: false,
        escalation: { recommended: 'alternate_selector', reason: 'mismatch' },
      }),
    ).toMatchObject({ decision: 'escalate', recommended: 'alternate_selector' });
  });

  it('lets a read-back verification override a weaker effect label', () => {
    // verified is the strongest evidence there is; it wins outright.
    expect(decideAoiBrowserDriveNextStep({ effect: 'unverifiable', verified: true }).decision).toBe(
      'done',
    );
  });
});

describe('describeAoiBrowserDriveVerdict', () => {
  it('tells the model not to repeat a confirmed action', () => {
    expect(describeAoiBrowserDriveVerdict({ effect: 'confirmed', verified: true })).toContain(
      'Do not repeat',
    );
  });

  it('forbids reporting success on an unverifiable action', () => {
    const text = describeAoiBrowserDriveVerdict({ effect: 'unverifiable', verified: false });
    expect(text).toContain('nothing proves it landed');
    expect(text).toContain('do NOT repeat');
  });

  it('forbids reporting a refused action as done, and names the code', () => {
    const text = describeAoiBrowserDriveVerdict({
      effect: 'suspected_noop',
      verified: false,
      code: 'drift_to_denylist',
      escalation: { recommended: 'stop', reason: 'the step was stopped' },
    });
    expect(text).toContain('drift_to_denylist');
    expect(text).toContain('Do NOT tell the user it happened');
  });
});

describe('parseAoiBrowserDriveVerdict', () => {
  it('accepts a well-formed verdict off the wire', () => {
    expect(
      parseAoiBrowserDriveVerdict({
        effect: 'suspected_noop',
        verified: false,
        code: 'action_failed',
        escalation: { recommended: 'alternate_selector', reason: 'mismatch' },
      }),
    ).toEqual({
      effect: 'suspected_noop',
      verified: false,
      code: 'action_failed',
      escalation: { recommended: 'alternate_selector', reason: 'mismatch' },
    });
  });

  it('never lets a non-literal-true stand in for proof', () => {
    // This value decides whether the model may say the action happened, so
    // anything truthy-but-not-true is rejected as evidence.
    for (const verified of ['true', 1, {}, 'yes']) {
      expect(
        parseAoiBrowserDriveVerdict({ effect: 'confirmed', verified })?.verified,
        JSON.stringify(verified),
      ).toBe(false);
    }
  });

  it('rejects an unrecognized or malformed verdict rather than guessing', () => {
    for (const value of [
      null,
      undefined,
      'confirmed',
      42,
      {},
      { effect: 'done' },
      { effect: '' },
    ]) {
      expect(parseAoiBrowserDriveVerdict(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('drops an escalation with an unknown rung but keeps the verdict', () => {
    const parsed = parseAoiBrowserDriveVerdict({
      effect: 'unverifiable',
      escalation: { recommended: 'foreground', reason: 'not a rung here' },
    });
    expect(parsed?.effect).toBe('unverifiable');
    expect(parsed?.escalation).toBeUndefined();
  });

  it('bounds attacker-controllable strings', () => {
    const parsed = parseAoiBrowserDriveVerdict({
      effect: 'unverifiable',
      code: 'x'.repeat(500),
      escalation: { recommended: 'stop', reason: 'y'.repeat(500) },
    });
    expect(parsed?.code?.length).toBeLessThanOrEqual(80);
    expect(parsed?.escalation?.reason.length).toBeLessThanOrEqual(200);
  });

  it('round-trips a classified verdict', () => {
    const original: AoiBrowserDriveVerdict = classifyAoiBrowserDriveActVerdict({
      kind: 'type',
      ok: true,
      readBack: { expected: 'a', actual: 'b' },
    });
    expect(parseAoiBrowserDriveVerdict(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });
});
