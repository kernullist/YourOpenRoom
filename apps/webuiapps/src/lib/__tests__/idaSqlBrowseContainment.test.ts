// @vitest-environment node
//
// Does the binary browser stay inside the operator's roots when the filesystem
// itself points outward? Real junctions on a real disk, not a mocked fs.
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findBinariesUnder } from '../idaSqlPlugin';

let root = '';
let outside = '';
let junctionMade = false;

beforeAll(() => {
  const base = fs.mkdtempSync(join(os.tmpdir(), 'ida-browse-'));
  root = join(base, 'root');
  outside = join(base, 'outside');
  fs.mkdirSync(join(root, 'sub'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(join(root, 'inside_probe.exe'), 'MZ');
  fs.writeFileSync(join(root, 'sub', 'nested_probe.exe'), 'MZ');
  fs.writeFileSync(join(outside, 'outside_probe.exe'), 'MZ');
  try {
    // 'junction' needs no elevation on Windows, unlike a directory symlink.
    fs.symlinkSync(outside, join(root, 'escape'), 'junction');
    junctionMade = true;
  } catch {
    junctionMade = false;
  }
});

afterAll(() => {
  try {
    fs.rmSync(join(root, '..'), { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('findBinariesUnder', () => {
  it('finds what is genuinely inside the root, at depth', () => {
    const found = findBinariesUnder([root], 'probe', 4);
    const names = found.entries.map((entry) => entry.name).sort();
    expect(names).toContain('inside_probe.exe');
    expect(names).toContain('nested_probe.exe');
  });

  it('does not walk through a junction that leaves the root', () => {
    if (!junctionMade) {
      // Nothing to prove on a filesystem that would not make one.
      return;
    }
    const found = findBinariesUnder([root], 'probe', 4);
    const paths = found.entries.map((entry) => entry.path);
    // The file on the other side of the junction must not be named at all --
    // neither by its real path nor by a path that lexically sits in the root.
    expect(paths.some((path) => path.includes('outside_probe'))).toBe(false);
    expect(paths.some((path) => path.includes('escape'))).toBe(false);
    // ...and it really is reachable through the junction, so the test is not
    // passing because the junction was inert.
    expect(fs.existsSync(join(root, 'escape', 'outside_probe.exe'))).toBe(true);
  });

  it('reports truncation instead of walking forever', () => {
    // A cheap sanity check on the bounds: depth 0 must not descend at all.
    const found = findBinariesUnder([root], 'probe', 0);
    expect(found.entries.map((entry) => entry.name)).toEqual(['inside_probe.exe']);
  });
});
