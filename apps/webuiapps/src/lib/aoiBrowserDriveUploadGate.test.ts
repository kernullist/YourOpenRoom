import { describe, expect, it } from 'vitest';
import { decideAoiBrowserDriveUpload } from './aoiBrowserDriveUploadGate';

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
