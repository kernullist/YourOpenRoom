import { describe, expect, it } from 'vitest';

import {
  killAoiHostProcess,
  readAoiHostProcessByPid,
  recycleAoiHostFile,
} from '../aoiHostBridgeOsImpl';

// These guard the input-validation edges of the real OS impls WITHOUT touching
// real processes or files (the effectful happy paths run only behind the pure
// runners' gate + approval + TOCTOU checks, which are tested separately with
// injected impls).
describe('aoiHostBridgeOsImpl input guards', () => {
  it('readAoiHostProcessByPid rejects a non-positive / non-integer pid', () => {
    expect(readAoiHostProcessByPid(0)).toBeNull();
    expect(readAoiHostProcessByPid(-1)).toBeNull();
    expect(readAoiHostProcessByPid(1.5)).toBeNull();
  });

  it('killAoiHostProcess refuses a non-positive pid', () => {
    expect(killAoiHostProcess(0)).toBe(false);
    expect(killAoiHostProcess(-5)).toBe(false);
  });

  it('recycleAoiHostFile refuses an empty path', () => {
    expect(recycleAoiHostFile('')).toBe(false);
  });
});
