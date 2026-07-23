import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { aoiSyncSha256Hex } from '../aoiSyncSha256';

describe('aoiSyncSha256Hex', () => {
  it('matches the standard NIST test vectors', () => {
    expect(aoiSyncSha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(aoiSyncSha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(aoiSyncSha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(aoiSyncSha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('agrees with node crypto across ASCII, unicode, long, and multi-block inputs', () => {
    const cases = [
      'a',
      'kernel anti-cheat',
      '꿀보 gloryo@naver.com',
      'C:\\Users\\Bob Smith\\secret\\keys.txt',
      'x'.repeat(1),
      'y'.repeat(55), // one byte short of a padding-block boundary
      'z'.repeat(56), // forces an extra block
      'w'.repeat(64),
      'q'.repeat(1000),
    ];
    for (const value of cases) {
      const expected = createHash('sha256').update(value, 'utf-8').digest('hex');
      expect(aoiSyncSha256Hex(value)).toBe(expected);
    }
  });

  it('is deterministic and length-stable (64 lowercase hex chars)', () => {
    const a = aoiSyncSha256Hex('same input');
    const b = aoiSyncSha256Hex('same input');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
