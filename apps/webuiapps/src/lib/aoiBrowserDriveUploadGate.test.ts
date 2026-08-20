import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildAoiBrowserDriveUploadGate,
  decideAoiBrowserDriveUpload,
} from './aoiBrowserDriveUploadGate';
import { saveAoiHostReadRoots } from './aoiHostFileRead';

// Uploading is the only browser action that moves data OUT of the machine, and
// the path is chosen inside a plan a hostile page can influence. These pin that
// the bound is the operator's registered roots and nothing weaker.
describe('decideAoiBrowserDriveUpload', () => {
  const roots = ['C:/work/uploads', 'C:/work/reports'];

  it('allows a file inside a registered root', () => {
    const decision = decideAoiBrowserDriveUpload('C:/work/uploads/invoice.pdf', roots);
    expect(decision.allowed).toBe(true);
  });

  it('refuses a file outside every root', () => {
    // The case that matters: a plausible-looking path the operator never opened up.
    const decision = decideAoiBrowserDriveUpload('C:/Users/me/.ssh/id_rsa', roots);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('outside every registered read root');
  });

  it('refuses a traversal that climbs out of a root', () => {
    const decision = decideAoiBrowserDriveUpload('C:/work/uploads/../../Windows/win.ini', roots);
    expect(decision.allowed).toBe(false);
  });

  it('refuses a relative path rather than resolving it', () => {
    // Resolving against the daemon's working directory would make the same plan
    // mean different files on different machines.
    expect(decideAoiBrowserDriveUpload('uploads/invoice.pdf', roots).allowed).toBe(false);
    expect(decideAoiBrowserDriveUpload('./secret', roots).allowed).toBe(false);
  });

  it('refuses everything when no roots are registered', () => {
    // Fail-closed: an empty allowlist means nothing, not everything.
    const decision = decideAoiBrowserDriveUpload('C:/work/uploads/invoice.pdf', []);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('no read roots are registered');
  });

  it('refuses an empty or blank path', () => {
    expect(decideAoiBrowserDriveUpload('', roots).allowed).toBe(false);
    expect(decideAoiBrowserDriveUpload('   ', roots).allowed).toBe(false);
  });

  it('does not treat a sibling directory with a shared prefix as inside', () => {
    // C:/work/uploads-private is NOT under C:/work/uploads, however similar the
    // strings look.
    const decision = decideAoiBrowserDriveUpload('C:/work/uploads-private/keys.txt', roots);
    expect(decision.allowed).toBe(false);
  });
});

// A junction planted inside a root makes any file on the machine SPELL OUT as
// if it were inside: containment is a string question, and only the last path
// component is ever stat'd. Windows lets an unprivileged user create one.
describe('buildAoiBrowserDriveUploadGate real-path containment', () => {
  it('refuses a file reached through a junction inside a root', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const base = fs.mkdtempSync(join(os.tmpdir(), 'aoi-upload-junction-'));
    const home = join(base, 'home');
    const root = join(base, 'safe');
    const secret = join(base, 'secret');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(root);
    fs.mkdirSync(secret);
    fs.writeFileSync(join(secret, 'id_rsa'), 'PRIVATE KEY');
    try {
      execFileSync('cmd', ['/c', 'mklink', '/J', join(root, 'out'), secret], { stdio: 'pipe' });
    } catch {
      // No junction support on this runner: the case cannot be exercised.
      return;
    }

    saveAoiHostReadRoots(home, {
      version: 1,
      roots: [{ id: 'safe', label: 'safe', path: root }],
      updatedAt: 1000,
    });
    const gate = buildAoiBrowserDriveUploadGate(home);

    // Spelled inside the root, is a real file, and every earlier check passes.
    const escaped = join(root, 'out', 'id_rsa');
    expect(decideAoiBrowserDriveUpload(escaped, [root]).allowed).toBe(true);
    expect(fs.lstatSync(escaped).isFile()).toBe(true);

    const verdict = gate(escaped);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('resolves to');

    // And a genuine file in the root is still uploadable, so the check bounds
    // the escape rather than the feature.
    fs.writeFileSync(join(root, 'invoice.pdf'), 'x');
    expect(gate(join(root, 'invoice.pdf')).allowed).toBe(true);
  });
});
