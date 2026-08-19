// Browser-drive profile (BU3): which Chrome/Edge user-data directory Aoi drives.
//
// This exists because of a hard constraint, not a preference. Chrome 136+ refuses
// remote debugging when the user-data directory is the browser's DEFAULT profile
// -- an anti-cookie-theft measure. Verified on Chrome 151: same executable, same
// arguments, only the directory differing, a dedicated directory answers on the
// debug port in well under a second while the default one never opens it at all.
//
// So "attach to the browser you already use" cannot work as written, and the
// workable shape is a SEPARATE profile the operator signs into once. Aoi drives
// that one. It is also a better boundary than the original design: the operator
// chooses which logins Aoi can reach by choosing what to sign into there, rather
// than handing over everything their everyday browser holds.
//
// Server-only (fs). The pure normalize/select helpers are exported so the policy
// is testable without a filesystem.
import * as fs from 'fs';
import { dirname, isAbsolute, resolve } from 'path';

const HOST_BRIDGE_DIR = 'host-bridge';
const PROFILE_FILE = 'browser-drive-profile.json';
const MAX_PATH_CHARS = 4096;

export interface AoiBrowserDriveProfileConfig {
  version: 1;
  // Absolute path to the user-data directory Aoi should drive. Empty means
  // "not configured", which is honest about the state rather than silently
  // falling back to a default that cannot work.
  userDataDir: string;
  updatedAt: number;
}

export const DEFAULT_AOI_BROWSER_DRIVE_PROFILE: AoiBrowserDriveProfileConfig = {
  version: 1,
  userDataDir: '',
  updatedAt: 0,
};

/**
 * Validate a candidate profile directory.
 *
 * Refuses a relative path: the daemon's working directory is not something the
 * operator is thinking about when they type this, and resolving against it would
 * make the same setting mean different directories on different runs.
 *
 * Refuses the browser's own default directory too, because that is precisely the
 * case the browser rejects -- accepting it here would store a setting that looks
 * applied and then fails at attach time with an error about something else.
 */
export function normalizeAoiBrowserDriveProfilePath(
  raw: unknown,
  defaultDirs: readonly string[] = [],
): { ok: true; path: string } | { ok: false; reason: string } {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    return { ok: false, reason: 'give a directory path' };
  }
  if (value.length > MAX_PATH_CHARS) {
    return { ok: false, reason: 'that path is too long' };
  }
  if (!isAbsolute(value)) {
    return { ok: false, reason: 'the path must be absolute' };
  }
  const resolved = resolve(value);
  for (const candidate of defaultDirs) {
    if (candidate && resolve(candidate).toLowerCase() === resolved.toLowerCase()) {
      return {
        ok: false,
        reason:
          'that is the browser default profile, which refuses remote debugging. Use a separate directory and sign in there.',
      };
    }
  }
  return { ok: true, path: resolved };
}

export function normalizeAoiBrowserDriveProfileConfig(raw: unknown): AoiBrowserDriveProfileConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AOI_BROWSER_DRIVE_PROFILE };
  }
  const value = raw as Partial<AoiBrowserDriveProfileConfig>;
  if (value.version !== 1) {
    return { ...DEFAULT_AOI_BROWSER_DRIVE_PROFILE };
  }
  const dir = typeof value.userDataDir === 'string' ? value.userDataDir.trim() : '';
  return {
    version: 1,
    // Stored paths are re-checked for absoluteness on the way out: a file edited
    // by hand should not be able to introduce a relative path.
    userDataDir: dir && isAbsolute(dir) ? dir : '',
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

export function resolveAoiBrowserDriveProfilePath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, PROFILE_FILE);
}

export function loadAoiBrowserDriveProfileConfig(
  openroomHome: string,
): AoiBrowserDriveProfileConfig {
  try {
    const raw = fs.readFileSync(resolveAoiBrowserDriveProfilePath(openroomHome), 'utf-8');
    return normalizeAoiBrowserDriveProfileConfig(JSON.parse(raw));
  } catch {
    // Absent or corrupt reads as "not configured", which the caller reports
    // rather than papering over with a directory that cannot work.
    return { ...DEFAULT_AOI_BROWSER_DRIVE_PROFILE };
  }
}

export function saveAoiBrowserDriveProfileConfig(
  openroomHome: string,
  config: AoiBrowserDriveProfileConfig,
): void {
  const target = resolveAoiBrowserDriveProfilePath(openroomHome);
  fs.mkdirSync(dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `${JSON.stringify(normalizeAoiBrowserDriveProfileConfig(config), null, 2)}\n`,
    'utf-8',
  );
}

/**
 * The directory a drive should actually use.
 *
 * Returns null when nothing is configured. The caller must then refuse with a
 * message that says so, rather than falling back to the browser default -- that
 * fallback is what produced an attach failure describing a missing port file
 * when the real problem was a profile the browser will not debug.
 */
export function selectAoiBrowserDriveUserDataDir(
  config: AoiBrowserDriveProfileConfig | null | undefined,
): string | null {
  const dir = config?.userDataDir?.trim() ?? '';
  return dir && isAbsolute(dir) ? dir : null;
}
