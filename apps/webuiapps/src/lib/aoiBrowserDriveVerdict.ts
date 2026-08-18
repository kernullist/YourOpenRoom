// Semantic verdict for a browser-drive ACT step.
//
// Ported from the hermes-agent computer-use contract, whose load-bearing line
// is: "Transport success without semantic proof is not proof of effect."
//
// The executor used to mark an ACT `ok: true` whenever the underlying call did
// not throw and the URL had not drifted onto a denylisted host, and the tool
// layer then told the model "The approved action was performed on the live
// browser". Neither statement is evidence. Playwright-style `click()` resolves
// when the click is DISPATCHED; a disabled control, an intercepted overlay, or
// a re-rendered node all resolve the same way as a click that did something.
// So the model was handed a completion claim built out of transport success --
// the same defect this codebase has been fixing on the app-action side.
//
// This splits the two apart, keeping hermes's vocabulary so the two systems
// stay legible to each other:
//   ok      -- transport succeeded (the call ran, nothing threw)
//   effect  -- what we can actually prove about the result
//   verified-- true ONLY when a value was read back off the live page
//
// Evidence available here is deliberately modest: the page interface exposes
// url(), textContent() and getAttribute(). That is enough to read a field's
// value back after typing, and to notice a navigation. It is not enough to
// prove a click hit the control the model meant, which is exactly why the
// honest answer for most clicks is `unverifiable` rather than `confirmed`.

export type AoiBrowserDriveEffect =
  // Proven: a value was read back, or the act demonstrably navigated.
  | 'confirmed'
  // Delivered, but nothing here proves it landed. NOT a failure, and NOT
  // permission to repeat the input -- get fresh state first.
  | 'unverifiable'
  // Positive evidence that nothing happened, or the transport itself failed.
  | 'suspected_noop';

export type AoiBrowserDriveEscalationRung =
  // Re-read the page before deciding anything else.
  | 'fresh_state'
  // The target was probably wrong; pick a different selector from a new snapshot.
  | 'alternate_selector'
  // Do not climb further -- a gate refused, and retrying is not the answer.
  | 'stop';

export interface AoiBrowserDriveEscalation {
  recommended: AoiBrowserDriveEscalationRung;
  reason: string;
}

export interface AoiBrowserDriveVerdict {
  effect: AoiBrowserDriveEffect;
  // True only on read-back of a live value. A navigation counts as `confirmed`
  // but NOT as `verified`: it proves an effect occurred, not that the intended
  // control was the one that produced it.
  verified: boolean;
  escalation?: AoiBrowserDriveEscalation;
  // Structured refusal, carried through from the step's stop reason.
  code?: string;
}

// What the caller managed to observe around the act.
export interface AoiBrowserDriveActEvidence {
  kind: string;
  // Transport success: the underlying call ran without throwing.
  ok: boolean;
  // Set when a gate or the page stopped the step.
  stopReason?: string;
  urlBefore?: string;
  urlAfter?: string;
  // Present only for acts that write a value we can read back (type/select).
  // `actual` is null when the read-back itself could not be performed.
  readBack?: { expected: string; actual: string | null };
}

// Acts whose result can be read straight back off the element.
const READ_BACK_KINDS: ReadonlySet<string> = new Set(['type', 'select']);

function normalizeValue(value: string): string {
  return value.trim();
}

function navigated(evidence: AoiBrowserDriveActEvidence): boolean {
  const before = (evidence.urlBefore ?? '').trim();
  const after = (evidence.urlAfter ?? '').trim();
  return before.length > 0 && after.length > 0 && before !== after;
}

/**
 * Turn what we observed into a verdict.
 *
 * Deliberately conservative in one direction: absence of evidence never becomes
 * `confirmed`. A click that changed nothing observable is `unverifiable`, not a
 * failure -- plenty of legitimate clicks (opening a menu, focusing a field)
 * change no URL and write no value. Only positive counter-evidence, or a
 * transport/gate failure, earns `suspected_noop`.
 */
export function classifyAoiBrowserDriveActVerdict(
  evidence: AoiBrowserDriveActEvidence,
): AoiBrowserDriveVerdict {
  if (!evidence.ok) {
    return {
      effect: 'suspected_noop',
      verified: false,
      ...(evidence.stopReason ? { code: evidence.stopReason } : {}),
      escalation: {
        recommended: evidence.stopReason ? 'stop' : 'fresh_state',
        reason: evidence.stopReason
          ? `the step was stopped: ${evidence.stopReason}`
          : 'the action did not complete',
      },
    };
  }

  if (READ_BACK_KINDS.has(evidence.kind) && evidence.readBack) {
    const { expected, actual } = evidence.readBack;
    if (actual === null) {
      return {
        effect: 'unverifiable',
        verified: false,
        escalation: {
          recommended: 'fresh_state',
          reason: 'the value could not be read back; confirm from a fresh snapshot',
        },
      };
    }
    if (normalizeValue(actual) === normalizeValue(expected)) {
      return { effect: 'confirmed', verified: true };
    }
    return {
      effect: 'suspected_noop',
      verified: false,
      escalation: {
        recommended: 'alternate_selector',
        reason: `read-back does not match what was written (got ${JSON.stringify(
          actual.slice(0, 40),
        )})`,
      },
    };
  }

  if (navigated(evidence)) {
    // Something demonstrably happened. Not `verified`: this does not prove the
    // intended control caused it.
    return { effect: 'confirmed', verified: false };
  }

  return {
    effect: 'unverifiable',
    verified: false,
    escalation: {
      recommended: 'fresh_state',
      reason: 'nothing observable changed; re-read the page before acting again',
    },
  };
}

const EFFECTS: ReadonlySet<string> = new Set([
  'confirmed',
  'unverifiable',
  'suspected_noop',
] satisfies AoiBrowserDriveEffect[]);

const RUNGS: ReadonlySet<string> = new Set([
  'fresh_state',
  'alternate_selector',
  'stop',
] satisfies AoiBrowserDriveEscalationRung[]);

/**
 * Validate a verdict that arrived over the wire.
 *
 * The daemon response is a trust boundary, and this value decides whether the
 * model is allowed to report an action as done. An unrecognized or malformed
 * verdict yields null, and the caller then falls back to the honest wording for
 * "delivered, unproven" -- never to "done".
 */
export function parseAoiBrowserDriveVerdict(value: unknown): AoiBrowserDriveVerdict | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.effect !== 'string' || !EFFECTS.has(raw.effect)) {
    return null;
  }
  const verdict: AoiBrowserDriveVerdict = {
    effect: raw.effect as AoiBrowserDriveEffect,
    // Anything other than a literal true is not proof.
    verified: raw.verified === true,
  };
  if (typeof raw.code === 'string' && raw.code.trim()) {
    verdict.code = raw.code.trim().slice(0, 80);
  }
  const escalation = raw.escalation;
  if (escalation && typeof escalation === 'object') {
    const entry = escalation as Record<string, unknown>;
    if (typeof entry.recommended === 'string' && RUNGS.has(entry.recommended)) {
      verdict.escalation = {
        recommended: entry.recommended as AoiBrowserDriveEscalationRung,
        reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 200) : '',
      };
    }
  }
  return verdict;
}

export type AoiBrowserDriveNextDecision = 'done' | 'verify_fresh_state' | 'escalate';

export interface AoiBrowserDriveNextStep {
  decision: AoiBrowserDriveNextDecision;
  recommended?: AoiBrowserDriveEscalationRung;
  reason?: string;
}

/**
 * Choose the next move from the verdict, in hermes's precedence order.
 *
 * An escalation recommendation is advisory: it never overrides a confirmed
 * effect, and it never turns an unverifiable action into permission to repeat
 * the input. The default arm is the whole point -- transport success with no
 * semantic proof sends you to fresh state, not to "done".
 */
export function decideAoiBrowserDriveNextStep(
  verdict: AoiBrowserDriveVerdict,
): AoiBrowserDriveNextStep {
  if (verdict.effect === 'confirmed' || verdict.verified) {
    return { decision: 'done' };
  }
  if (verdict.effect === 'unverifiable') {
    return {
      decision: 'verify_fresh_state',
      ...(verdict.escalation ? { reason: verdict.escalation.reason } : {}),
    };
  }
  return {
    decision: 'escalate',
    ...(verdict.escalation
      ? { recommended: verdict.escalation.recommended, reason: verdict.escalation.reason }
      : {}),
  };
}

/**
 * One line the model can act on, so the verdict is not just structured data it
 * has to interpret. Mirrors the ladder wording in the hermes skill.
 */
export function describeAoiBrowserDriveVerdict(verdict: AoiBrowserDriveVerdict): string {
  const next = decideAoiBrowserDriveNextStep(verdict);
  switch (next.decision) {
    case 'done':
      return verdict.verified
        ? 'Confirmed: the value was read back off the live page. Do not repeat this action.'
        : 'Confirmed: the page navigated as a result. Do not repeat this action.';
    case 'verify_fresh_state':
      return (
        'Unverifiable: the action was delivered but nothing proves it landed. ' +
        'Re-read the page before deciding anything, and do NOT repeat the action or ' +
        'tell the user it succeeded.'
      );
    default:
      return (
        `Not performed${verdict.code ? ` (${verdict.code})` : ''}: ` +
        `${next.reason ?? 'the action did not take effect'}. ` +
        'Do NOT tell the user it happened.'
      );
  }
}
