// @vitest-environment jsdom
//
// The one line that tells the reader how much of a binary's string table they
// are looking at. It used to report the size of the list on screen twice over,
// which on a real DLL meant "160 indexed" for a binary holding 12,178.
import { describe, expect, it } from 'vitest';

import { stringScanLabel } from '../index';

describe('stringScanLabel', () => {
  it('says how much of the scan is on screen', () => {
    // Measured on C:\\Windows\\System32\\shell32.dll.
    expect(
      stringScanLabel({
        shown: 160,
        suspiciousShown: 12,
        suspiciousTotal: 26,
        total: 12178,
        truncated: true,
      }),
    ).toBe('12 of 26 suspicious shown; 160 of 12,178 strings (the rest were counted, not kept)');
  });

  it('drops the caveat when nothing was cut', () => {
    expect(
      stringScanLabel({
        shown: 40,
        suspiciousShown: 3,
        suspiciousTotal: 3,
        total: 40,
        truncated: false,
      }),
    ).toBe('3 of 3 suspicious shown; 40 of 40 strings');
  });

  it('never invents a total the source could not give', () => {
    // The IDA path asks for a bounded page per pattern, so a full page means
    // "at least this many" and there is no honest total to print.
    const label = stringScanLabel({
      shown: 96,
      suspiciousShown: 12,
      suspiciousTotal: 96,
      total: null,
      truncated: true,
    });
    expect(label).toContain('96 sampled strings');
    expect(label).not.toMatch(/of \d+ strings/);
  });
});
