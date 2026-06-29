import * as fs from 'fs';
import { hostname } from 'os';
import { join } from 'path';

// Single-instance guard for the self-initiating autonomy background loop.
//
// The in-flight guard inside startAoiAutonomyBackgroundRunner only prevents
// OVERLAPPING cycles within ONE process. It does nothing about a SECOND process
// (a second daemon, or a daemon plus the Vite dev/preview loop) ticking the
// SAME on-disk session store concurrently -- that yields double-ticks and file
// races because every loop reads/writes ~/.openroom/sessions directly. This
// lock makes loop startup REFUSE when another live process already owns the
// same session dir.
//
// Scope is deliberately the LOOP, not the HTTP routes: serving inspection
// routes from several processes is harmless; only the mutating loop must be
// single. Acquisition is synchronous so it slots into the synchronous loop
// starter without rippling async through the plugin.

const LOCK_FILE_NAME = '.aoi-autonomy-loop.lock';
const LOCK_KIND = 'aoi-autonomy-loop';

export interface AoiAutonomyLoopLockHandle {
  // Releases the lock if (and only if) this process still owns it. Idempotent
  // and best-effort: a failed unlink is swallowed (the next acquire reclaims it
  // as stale).
  release: () => void;
}

interface AoiAutonomyLoopLockRecord {
  kind: string;
  pid: number;
  host: string;
  startedAt: number;
}

export interface AoiAutonomyLoopLockDeps {
  // Identity of THIS process. Injectable so tests can simulate distinct holders
  // without spawning real processes.
  pid?: number;
  host?: string;
  now?: () => number;
  // Returns true when a pid is a live process on this host. Injectable so tests
  // can simulate a stale (dead) holder deterministically and offline.
  isPidAlive?: (pid: number) => boolean;
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0 performs error checking without delivering a signal: success or
    // EPERM means the process exists; ESRCH means it does not.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function logWarn(message: string): void {
  // ASCII-only operational logging.
  console.warn(`[aoi-autonomy-loop-lock] ${message}`);
}

function readLockRecord(lockPath: string): AoiAutonomyLoopLockRecord | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const record = parsed as Partial<AoiAutonomyLoopLockRecord>;
    if (typeof record.pid !== 'number' || typeof record.host !== 'string') {
      return null;
    }
    return {
      kind: typeof record.kind === 'string' ? record.kind : LOCK_KIND,
      pid: record.pid,
      host: record.host,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
    };
  } catch {
    return null;
  }
}

// Atomically create the lock file. 'wx' is O_CREAT | O_EXCL: it fails with
// EEXIST when the lock already exists, which is the cross-process mutual
// exclusion primitive. Returns true on create, false on EEXIST; other fs errors
// propagate so the caller can fail closed.
function writeLockFileExclusive(lockPath: string, record: AoiAutonomyLoopLockRecord): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, JSON.stringify(record));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}

// Acquire the single-instance loop lock for sessionsDir. Returns a release
// handle on success, or null when another live process already owns the dir (or
// when the lock cannot be written -- fail closed: a second loop never starts).
export function acquireAoiAutonomyLoopLock(
  sessionsDir: string,
  deps: AoiAutonomyLoopLockDeps = {},
): AoiAutonomyLoopLockHandle | null {
  const pid = deps.pid ?? process.pid;
  const host = deps.host ?? hostname();
  const now = deps.now ?? Date.now;
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const lockPath = join(sessionsDir, LOCK_FILE_NAME);

  const record: AoiAutonomyLoopLockRecord = {
    kind: LOCK_KIND,
    pid,
    host,
    startedAt: now(),
  };

  const makeHandle = (): AoiAutonomyLoopLockHandle => {
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        try {
          // Only remove the lock if we still own it -- never delete a lock a
          // different process has since taken over.
          const current = readLockRecord(lockPath);
          if (current && current.pid === pid && current.host === host) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          // best-effort: a leftover file is reclaimed as stale on next acquire.
        }
      },
    };
  };

  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
  } catch (error) {
    logWarn(`cannot create sessions dir ${sessionsDir}: ${String(error)}; not starting the loop`);
    return null;
  }

  // Fast path: atomic exclusive create when no lock exists.
  try {
    if (writeLockFileExclusive(lockPath, record)) {
      return makeHandle();
    }
  } catch (error) {
    logWarn(`cannot write lock ${lockPath}: ${String(error)}; not starting the loop`);
    return null;
  }

  // A lock file already exists: decide live-holder vs stale.
  const existing = readLockRecord(lockPath);
  if (existing && existing.host !== host) {
    // Different host: liveness cannot be probed across hosts, so refuse rather
    // than risk a concurrent loop on a shared store.
    logWarn(
      `lock held by another host (${existing.host}); cannot verify liveness, not starting a second loop`,
    );
    return null;
  }
  if (existing && isPidAlive(existing.pid)) {
    logWarn(
      `another live loop (pid ${existing.pid}) already owns ${sessionsDir}; not starting a second loop`,
    );
    return null;
  }

  // Stale (dead pid) or malformed/unreadable: reclaim and retry the exclusive
  // create exactly once. A process that reclaimed first makes the retry EEXIST.
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Someone else may have removed/replaced it; fall through to the retry.
  }
  try {
    if (writeLockFileExclusive(lockPath, record)) {
      logWarn(`reclaimed a stale lock at ${lockPath}`);
      return makeHandle();
    }
  } catch (error) {
    logWarn(`cannot reclaim lock ${lockPath}: ${String(error)}; not starting the loop`);
    return null;
  }
  logWarn(`lost a race to reclaim ${lockPath}; not starting a second loop`);
  return null;
}
