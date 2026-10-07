import { describe, expect, it } from 'vitest';

import { lookup } from '../index';

describe('EvidenceVault lookup', () => {
  const map = { other: 'fallback', money: 'money-info' };

  it('falls back for values the validators let through but the maps do not know', () => {
    expect(lookup(map, 'money', 'other')).toBe('money-info');
    expect(lookup(map, 'financial', 'other')).toBe('fallback');
    expect(lookup(map, undefined, 'other')).toBe('fallback');
    expect(lookup(map, 42, 'other')).toBe('fallback');
    // Prototype keys are not entries.
    expect(lookup(map, 'constructor', 'other')).toBe('fallback');
    expect(lookup(map, '__proto__', 'other')).toBe('fallback');
  });
});
