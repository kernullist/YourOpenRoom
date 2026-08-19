import { describe, expect, it } from 'vitest';
import {
  normalizeAoiBrowserDriveProfileConfig,
  normalizeAoiBrowserDriveProfilePath,
  selectAoiBrowserDriveUserDataDir,
} from './aoiBrowserDriveProfile';

// Chrome refuses remote debugging on its own default profile, so browser drive
// only works against a separate signed-in directory. That makes this a required
// setup step, and the failure modes are worth pinning: a setting that stores
// something unusable looks applied and then fails later describing a symptom.
describe('normalizeAoiBrowserDriveProfilePath', () => {
  const defaults = ['C:/Users/me/AppData/Local/Google/Chrome/User Data'];

  it('accepts an absolute directory', () => {
    const decision = normalizeAoiBrowserDriveProfilePath('C:/Users/me/.openroom/browser-profile');
    expect(decision.ok).toBe(true);
  });

  it('refuses the browser default profile, and says why', () => {
    // Storing this would look applied and then fail at attach time with an error
    // about a missing port file, which points somewhere else entirely.
    const decision = normalizeAoiBrowserDriveProfilePath(defaults[0], defaults);
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      return;
    }
    expect(decision.reason).toContain('refuses remote debugging');
  });

  it('refuses the default profile regardless of case or separators', () => {
    // The same directory typed differently is still the same directory.
    const decision = normalizeAoiBrowserDriveProfilePath(
      'c:/users/me/appdata/local/google/chrome/user data',
      defaults,
    );
    expect(decision.ok).toBe(false);
  });

  it('refuses a relative path rather than resolving it', () => {
    // It would resolve against the daemon's working directory, which is not what
    // anyone typing a profile path has in mind.
    expect(normalizeAoiBrowserDriveProfilePath('browser-profile').ok).toBe(false);
    expect(normalizeAoiBrowserDriveProfilePath('./profile').ok).toBe(false);
  });

  it('refuses empty input', () => {
    expect(normalizeAoiBrowserDriveProfilePath('').ok).toBe(false);
    expect(normalizeAoiBrowserDriveProfilePath('   ').ok).toBe(false);
    expect(normalizeAoiBrowserDriveProfilePath(null).ok).toBe(false);
  });
});

describe('the stored config', () => {
  it('round-trips an absolute directory', () => {
    const config = normalizeAoiBrowserDriveProfileConfig({
      version: 1,
      userDataDir: 'C:/profiles/aoi',
      updatedAt: 5,
    });
    expect(selectAoiBrowserDriveUserDataDir(config)).toBe('C:/profiles/aoi');
  });

  it('drops a relative path that reached the file by hand', () => {
    // The file is editable; a relative path in it must not become a drive target.
    const config = normalizeAoiBrowserDriveProfileConfig({
      version: 1,
      userDataDir: 'relative/profile',
      updatedAt: 5,
    });
    expect(selectAoiBrowserDriveUserDataDir(config)).toBeNull();
  });

  it('reads absent, corrupt and future versions as not configured', () => {
    // Not configured is the honest state; the caller refuses and says so rather
    // than falling back to a profile the browser will not debug.
    for (const raw of [null, 'nope', {}, { version: 2, userDataDir: 'C:/x' }]) {
      expect(
        selectAoiBrowserDriveUserDataDir(normalizeAoiBrowserDriveProfileConfig(raw)),
      ).toBeNull();
    }
  });

  it('treats an empty stored value as not configured', () => {
    expect(
      selectAoiBrowserDriveUserDataDir(
        normalizeAoiBrowserDriveProfileConfig({ version: 1, userDataDir: '   ', updatedAt: 1 }),
      ),
    ).toBeNull();
  });
});
