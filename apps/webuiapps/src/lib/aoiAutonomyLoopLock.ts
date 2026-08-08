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
//
// The same lock is ALSO taken by the loop-independent memory maintenance sweep,
// because the real invariant is "never two processes mutating the memory files
// at once" -- not "never two loops". That makes the holders asymmetric, so each
// records its ROLE:
//
//   - 'loop'        the always-on autonomy loop. Authoritative: its tick already
//                   performs embedding + consolidation, so it may TAKE OVER a
//                   live 'maintenance' lock. Nothing is lost by doing so.
//   - 'maintenance' the loop-independent sweep. A fallback for when no loop is
//                   running; it must NEVER displace a 'loop' holder.
//
// Without this, startup order decided who won: a dev server with the maintenance
// toggles on would grab the lock first and the 24/7 daemon's loop could never
// start at all.

const LOCK_FILE_NAME = '.aoi-autonomy-loop.lock';
const LOCK_KIND = 'aoi-autonomy-loop';

export type AoiAutonomyLoopLockRole = 'loop' | 'maintenance';

export interface AoiAutonomyLoopLockHandle {
  // Releases the lock if (and only if) this process still owns it. Idempotent
  // and best-effort: a failed unlink is swallowed (the next acquire reclaims it
  // as stale).
  release: () => void;
  // Whether this process STILL owns the lock. False once another holder has
  // taken over (a 'loop' displacing this 'maintenance' holder) or after
  // release(). Ownership is re-read from disk rather than assumed for the
  // process lifetime, so a displaced holder can stop mutating.
  isOwner: () => boolean;
}

interface AoiAutonomyLoopLockRecord {
  kind: string;
  pid: number;
  host: string;
  startedAt: number;
  role: AoiAutonomyLoopLockRole;
  // Unique per ACQUIRE, not per process. pid+host cannot tell two holders inside
  // one process apart, so a displaced holder would still recognise the new
  // owner's record as its own and delete it on release. The id makes ownership
  // exact. A record from an older build carries none, so it never matches -- the
  // safe direction: we only ever remove a lock we provably wrote.
  instance: string;
}

let acquireSequence = 0;

export interface AoiAutonomyLoopLockDeps {
  // Identity of THIS process. Injectable so tests can simulate distinct holders
  // without spawning real processes.
  pid?: number;
  host?: string;
  now?: () => number;
  // Returns true when a pid is a live process on this host. Injectable so tests
  // can simulate a stale (dead) holder deterministically and offline.
  isPidAlive?: (pid: number) => boolean;
  // What this caller is. Defaults to 'loop': a caller that does not say is
  // treated as the authoritative holder, which is the fail-safe direction (it
  // can never be displaced by a maintenance sweep).
  role?: AoiAutonomyLoopLockRole;
  // Suppress the operational warnings. Used by the keeper below, which polls on
  // every maintenance tick and logs its own state TRANSITIONS instead -- an
  // unconditional warn there would emit a line every few minutes forever.
  quiet?: boolean;
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
      // A record written by an older build carries no role. Treat it as 'loop':
      // assuming 'maintenance' would let a new loop displace a live holder whose
      // job we cannot know, which is the unsafe direction.
      role: record.role === 'maintenance' ? 'maintenance' : 'loop',
      instance: typeof record.instance === 'string' ? record.instance : '',
    };
  } catch {
    return null;
  }
}

// How long an unparseable lock file is assumed to be a holder mid-write rather
// than abandoned garbage. The exclusive create and the record write are two
// syscalls, so a reader can catch the file existing but empty; stealing it then
// would hand the dir to two owners and bypass the role rules entirely, since an
// unreadable record has no role to check.
const MALFORMED_LOCK_GRACE_MS = 5_000;

// Contention, not failure. EEXIST is the normal "someone else has it". On
// Windows a file another process still has open is unlinked as delete-pending,
// and creating over it reports EPERM/EACCES/EBUSY instead -- transient states
// that must not be mistaken for a broken filesystem, or a daemon would refuse to
// start its loop forever (the exact symptom this module exists to prevent).
const TRANSIENT_LOCK_ERROR_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);
const LOCK_RETRY_ATTEMPTS = 3;
const LOCK_RETRY_DELAY_MS = 50;

function isTransientLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && TRANSIENT_LOCK_ERROR_CODES.has(code);
}

// Acquisition is synchronous by design (it slots into the synchronous loop
// starter), so a retry gap has to block. Atomics.wait on a throwaway buffer is
// the only exact sync sleep in Node; the waits are 50ms and happen at most twice
// per acquire, and acquire runs once at startup.
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable: skip the gap rather than fail the acquire.
  }
}

// Atomically create the lock file. 'wx' is O_CREAT | O_EXCL: it fails with
// EEXIST when the lock already exists, which is the cross-process mutual
// exclusion primitive. Returns true on create, false when another holder got
// there first (or the path is transiently unavailable); other fs errors
// propagate so the caller can fail closed.
function writeLockFileExclusive(lockPath: string, record: AoiAutonomyLoopLockRecord): boolean {
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify(record));
      return true;
    } catch (error) {
      if (!isTransientLockError(error)) {
        throw error;
      }
      if (attempt === LOCK_RETRY_ATTEMPTS - 1) {
        return false;
      }
      sleepSync(LOCK_RETRY_DELAY_MS);
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
  return false;
}

// Age of the lock file itself, used only to tell "being written right now" from
// "left behind malformed". Unknown (unstattable) reads as brand new, which
// refuses rather than steals.
function lockFileAgeMs(lockPath: string, now: number): number {
  try {
    return Math.max(0, now - fs.statSync(lockPath).mtimeMs);
  } catch {
    return 0;
  }
}

// Acquire the single-instance loop lock for sessionsDir. Returns a handle on
// success, or null when the dir is already owned by a holder this caller may not
// displace (or when the lock cannot be written -- fail closed: a second mutator
// never starts).
export function acquireAoiAutonomyLoopLock(
  sessionsDir: string,
  deps: AoiAutonomyLoopLockDeps = {},
): AoiAutonomyLoopLockHandle | null {
  const pid = deps.pid ?? process.pid;
  const host = deps.host ?? hostname();
  const now = deps.now ?? Date.now;
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const role: AoiAutonomyLoopLockRole = deps.role ?? 'loop';
  const lockPath = join(sessionsDir, LOCK_FILE_NAME);
  const warn = (message: string): void => {
    if (!deps.quiet) {
      logWarn(message);
    }
  };

  acquireSequence += 1;
  const instanceId = `${host}.${pid}.${now()}.${acquireSequence}`;
  const record: AoiAutonomyLoopLockRecord = {
    kind: LOCK_KIND,
    pid,
    host,
    startedAt: now(),
    role,
    instance: instanceId,
  };

  const ownsLockFile = (): boolean => {
    return readLockRecord(lockPath)?.instance === instanceId;
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
          if (ownsLockFile()) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          // best-effort: a leftover file is reclaimed as stale on next acquire.
        }
      },
      isOwner: () => {
        if (released) {
          return false;
        }
        return ownsLockFile();
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
    if (writeLockFileExclusive(lockPath, record) && ownsLockFile()) {
      return makeHandle();
    }
  } catch (error) {
    logWarn(`cannot write lock ${lockPath}: ${String(error)}; not starting the loop`);
    return null;
  }

  // A lock file already exists: decide live-holder vs stale.
  const existing = readLockRecord(lockPath);
  if (existing && existing.host !== host) {
    // Different host: liveness cannot be probed across hosts, and a remote
    // holder cannot be told to yield, so refuse rather than risk two mutators on
    // a shared store. This applies to takeover too -- role does not help when we
    // cannot see whether the other side is alive.
    warn(
      `lock held by another host (${existing.host}); cannot verify liveness, not starting a second loop`,
    );
    return null;
  }
  // An unreadable record carries no role and no pid, so neither rule can be
  // applied to it. A fresh one is almost certainly a holder between its
  // exclusive-create and its record write, and stealing it would put two owners
  // on the dir -- so refuse, and only reclaim once it is old enough to be
  // genuine garbage.
  if (existing === null && lockFileAgeMs(lockPath, now()) < MALFORMED_LOCK_GRACE_MS) {
    warn(`lock at ${lockPath} is being written by another holder; not starting a second ${role}`);
    return null;
  }
  // The authoritative loop displaces a live maintenance sweep: the loop's own
  // cycle performs the same embedding + consolidation, so nothing is lost, and
  // the displaced sweep stops at its next ownership check. Every other live
  // combination refuses (loop-vs-loop, maintenance-vs-anything).
  //
  // A sweep already INSIDE a cycle when it is displaced finishes that cycle --
  // ownership is re-read between the halves, but an in-flight embed still lands.
  // That window is why the taking-over loop delays its own first maintenance
  // pass by a full interval instead of running one straight away.
  const takeover = existing !== null && role === 'loop' && existing.role === 'maintenance';
  if (existing && !takeover && isPidAlive(existing.pid)) {
    warn(
      `another live holder (role ${existing.role}, pid ${existing.pid}) already owns ${sessionsDir}; not starting a second ${role}`,
    );
    return null;
  }

  // Stale (dead pid), malformed/unreadable, or a maintenance lock this loop is
  // taking over: remove and retry the exclusive create exactly once. A process
  // that got there first makes the retry EEXIST, and we refuse.
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Someone else may have removed/replaced it; fall through to the retry.
  }
  try {
    if (writeLockFileExclusive(lockPath, record)) {
      // Creating the file is not proof of ownership: a racing acquire may have
      // unlinked and replaced it in between. Only the record we wrote counts.
      if (!ownsLockFile()) {
        warn(`lost ${lockPath} immediately after taking it; not starting a second ${role}`);
        return null;
      }
      warn(
        takeover
          ? `took over the maintenance lock at ${lockPath} (pid ${existing?.pid}); the autonomy loop is authoritative`
          : `reclaimed a stale lock at ${lockPath}`,
      );
      return makeHandle();
    }
  } catch (error) {
    logWarn(`cannot reclaim lock ${lockPath}: ${String(error)}; not starting the loop`);
    return null;
  }
  warn(`lost a race to reclaim ${lockPath}; not starting a second ${role}`);
  return null;
}

// A self-healing holder for the MAINTENANCE side of the lock.
//
// The maintenance sweep cannot assume it owns the store for its process
// lifetime: the autonomy loop may take the lock over at any moment (see above),
// and conversely the loop may go away, in which case maintenance should resume
// rather than stay inert until the process restarts. So ownership is a
// per-cycle question, asked at the top of every tick.
//
// ownsLock() re-reads the lock from disk; when it no longer holds it, it tries
// exactly one re-acquire. That fails (cheaply) while a live loop owns the dir,
// and succeeds once that loop releases or dies.
export interface AoiAutonomyLoopLockKeeper {
  ownsLock: () => boolean;
  release: () => void;
}

export function createAoiAutonomyLoopLockKeeper(
  sessionsDir: string,
  deps: AoiAutonomyLoopLockDeps = {},
): AoiAutonomyLoopLockKeeper {
  let handle: AoiAutonomyLoopLockHandle | null = null;
  let stopped = false;
  // null = not resolved yet, so the FIRST answer is always logged. After that
  // only transitions are, which keeps an always-on process from emitting a warn
  // line every tick forever.
  let lastReported: boolean | null = null;

  const report = (owned: boolean): boolean => {
    if (lastReported !== owned) {
      lastReported = owned;
      logWarn(
        owned
          ? `maintenance sweep owns ${sessionsDir}`
          : `maintenance sweep yielded ${sessionsDir} to the autonomy loop; skipping its cycles`,
      );
    }
    return owned;
  };

  return {
    ownsLock: () => {
      if (stopped) {
        return false;
      }
      if (handle && handle.isOwner()) {
        return report(true);
      }
      // Lost it (taken over) or never had it: drop the dead handle -- release()
      // is a no-op once another holder owns the file -- and try to take it back.
      handle?.release();
      handle = acquireAoiAutonomyLoopLock(sessionsDir, {
        ...deps,
        role: deps.role ?? 'maintenance',
        quiet: true,
      });
      return report(handle !== null);
    },
    release: () => {
      stopped = true;
      handle?.release();
      handle = null;
    },
  };
}
