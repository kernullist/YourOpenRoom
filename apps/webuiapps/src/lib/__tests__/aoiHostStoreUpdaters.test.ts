import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import {
  addAoiHostReadRoot,
  loadAoiHostReadRoots,
  saveAoiHostReadRoots,
  updateAoiHostReadRoots,
} from '../aoiHostFileRead';
import {
  addAoiBrowserDriveAllowlistEntry,
  loadAoiBrowserDriveAllowlist,
  saveAoiBrowserDriveAllowlist,
  updateAoiBrowserDriveAllowlist,
} from '../aoiBrowserDriveAllowlist';

function makeHome(): string {
  return fs.mkdtempSync(join(os.tmpdir(), 'aoi-store-update-'));
}

// The daemon and the dev server are separate processes over one openroomHome.
// A mutation computed from a snapshot read before the write discards whatever
// the other process wrote in between -- an atomic WRITE of a stale value is
// still a lost update. These pin that the mutator sees state read inside the
// lock, not the caller's snapshot.
describe('store updaters re-read inside the lock', () => {
  it('adds a read root without dropping one written since the caller last looked', () => {
    const home = makeHome();
    // What the caller saw when the request arrived: nothing.
    const stale = loadAoiHostReadRoots(home);
    expect(stale.roots).toHaveLength(0);

    // The other process adds one.
    saveAoiHostReadRoots(
      home,
      addAoiHostReadRoot(stale, { id: 'a', path: 'C:/work/a' }, 1_000).config,
    );

    let seen = -1;
    const { saved } = updateAoiHostReadRoots(home, (fresh) => {
      seen = fresh.roots.length;
      const added = addAoiHostReadRoot(fresh, { id: 'b', path: 'C:/work/b' }, 2_000);
      return { next: added.added ? added.config : null, result: added };
    });

    // The mutator was handed the CURRENT state, so both roots survive.
    expect(seen).toBe(1);
    expect(saved?.roots.map((root) => root.id).sort()).toEqual(['a', 'b']);
  });

  it('does not save when the mutator declines', () => {
    const home = makeHome();
    saveAoiBrowserDriveAllowlist(
      home,
      addAoiBrowserDriveAllowlistEntry(null, { domain: 'evil.com' }, 1_000).allowlist,
    );
    const { saved, result } = updateAoiBrowserDriveAllowlist(home, () => ({
      next: null,
      result: 'declined',
    }));
    expect(result).toBe('declined');
    expect(saved).toBeNull();
    // Untouched on disk.
    expect(loadAoiBrowserDriveAllowlist(home).entries).toHaveLength(1);
  });

  it('releases the lock so the next update can proceed', () => {
    const home = makeHome();
    updateAoiHostReadRoots(home, (fresh) => {
      const added = addAoiHostReadRoot(fresh, { id: 'a', path: 'C:/work/a' }, 1_000);
      return { next: added.config, result: null };
    });
    const { saved } = updateAoiHostReadRoots(home, (fresh) => {
      const added = addAoiHostReadRoot(fresh, { id: 'b', path: 'C:/work/b' }, 2_000);
      return { next: added.config, result: null };
    });
    expect(saved?.roots).toHaveLength(2);
  });
});
