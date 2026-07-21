import { describe, expect, it } from 'vitest';
import {
  classifyAoiBrowserDriveAction,
  type AoiBrowserDriveActionKind,
} from '../aoiBrowserDriveAction';

describe('classifyAoiBrowserDriveAction - read', () => {
  it('classifies observational actions as read (no approval)', () => {
    for (const kind of ['navigate', 'extract', 'scroll', 'screenshot', 'wait', 'back'] as const) {
      const decision = classifyAoiBrowserDriveAction({ kind });
      expect(decision.category).toBe('read');
      expect(decision.requiresApproval).toBe(false);
    }
  });
});

describe('classifyAoiBrowserDriveAction - act', () => {
  it('classifies side-effecting actions as act (approval required)', () => {
    expect(classifyAoiBrowserDriveAction({ kind: 'click', targetText: 'Open settings' })).toEqual({
      category: 'act',
      requiresApproval: true,
      reason: 'side-effecting action requires per-action approval',
    });
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'type',
        text: 'hello',
        field: { type: 'text', name: 'search' },
      }).category,
    ).toBe('act');
    expect(classifyAoiBrowserDriveAction({ kind: 'select', value: 'x' }).category).toBe('act');
    expect(classifyAoiBrowserDriveAction({ kind: 'press', key: 'Enter' }).category).toBe('act');
  });
});

describe('classifyAoiBrowserDriveAction - forbidden: sensitive fields', () => {
  it('blocks typing into password/cc/cvv/otp/ssn fields', () => {
    const cases = [
      { type: 'password' },
      { type: 'text', autocomplete: 'current-password' },
      { type: 'text', autocomplete: 'one-time-code' },
      { type: 'text', name: 'cardNumber' },
      { type: 'text', id: 'cvv' },
      { type: 'text', ariaLabel: 'Social Security Number' },
      { type: 'text', name: 'otp_code' },
    ];
    for (const field of cases) {
      const decision = classifyAoiBrowserDriveAction({ kind: 'type', text: 'x', field });
      expect(decision.category).toBe('forbidden');
      expect(decision.forbidReason).toBe('sensitive_field');
    }
  });

  it('allows typing into an ordinary field', () => {
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'type',
        text: 'kernullist',
        field: { type: 'text', name: 'username' },
      }).category,
    ).toBe('act');
  });
});

describe('classifyAoiBrowserDriveAction - forbidden: financial + captcha', () => {
  it('blocks financial-commit clicks/submits', () => {
    for (const targetText of [
      'Pay now',
      'Place order',
      'Confirm payment',
      'Transfer',
      'Buy now',
      'Withdraw',
      'Trade',
    ]) {
      const decision = classifyAoiBrowserDriveAction({ kind: 'click', targetText });
      expect(decision.category).toBe('forbidden');
      expect(decision.forbidReason).toBe('financial_commit');
    }
    expect(
      classifyAoiBrowserDriveAction({ kind: 'submit', targetText: 'Complete purchase' }).category,
    ).toBe('forbidden');
  });

  it('does not block an ordinary click', () => {
    expect(classifyAoiBrowserDriveAction({ kind: 'click', targetText: 'Reply' }).category).toBe(
      'act',
    );
  });

  it('blocks any interaction with a captcha', () => {
    expect(
      classifyAoiBrowserDriveAction({ kind: 'click', targetText: "I'm not a robot" }).forbidReason,
    ).toBe('captcha');
    expect(
      classifyAoiBrowserDriveAction({ kind: 'type', selector: '#g-recaptcha-response', field: {} })
        .forbidReason,
    ).toBe('captcha');
  });
});

describe('classifyAoiBrowserDriveAction - unknown', () => {
  it('fails closed on an unknown kind', () => {
    const decision = classifyAoiBrowserDriveAction({
      kind: 'evaluate' as unknown as AoiBrowserDriveActionKind,
    });
    expect(decision.category).toBe('forbidden');
    expect(decision.forbidReason).toBe('unknown_action');
  });
});
