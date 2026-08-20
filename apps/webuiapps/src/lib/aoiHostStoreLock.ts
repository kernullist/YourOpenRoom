// Cross-process mutual exclusion for the host-bridge stores.
//
// Every store here is read-modify-write: load the JSON, change it, save it. In
// ONE process that is safe by accident -- the whole sequence is synchronous, so
// the event loop cannot interleave it. But the daemon and the dev server are
// SEPARATE PROCESSES over one <openroomHome>, and nothing held the file between
// the load and the save. Two of them could load the same state, both decide
// against it, and both write.
//
// For a counter that costs a lost update. For a SINGLE-USE APPROVAL it costs the
// thing the approval exists for: both sides found the same approved entry, both
// consumed it, and one click authorized two actions.
//
// So: an exclusive lock file, taken with O_EXCL (atomic on Windows and POSIX
// alike), held across the whole load-modify-save, and released in a finally.
//
// Fail CLOSED. If the lock cannot be taken in time, the caller is told rather
// than allowed to proceed unprotected -- an approval consumed without the lock
// is exactly the case this exists to prevent.
//
// Server-only (fs).
import * as fs from 'fs';
import { dirname, resolve } from 'path';

const HOST_BRIDGE_DIR = 'host-bridge';

// NOTE: acquisition BLOCKS THE EVENT LOOP.
//
// The wait is synchronous because the critical sections are, and they are
// synchronous on purpose: an async body would release the lock at its first
// await while the rest of the work continued. The cost is that a caller waiting
// here serves nothing else meanwhile, so both bounds below are set by what a
// real critical section costs, not by what feels safe.
//
// How long a caller waits for the holder to finish. Every critical section here
// is a few small synchronous file operations -- microseconds -- so genuine
// contention clears on the first or second retry. A wait longer than this does
// not mean "busy", it means something is wrong, and refusing quickly beats
// stalling the process that is still healthy.
const DEFAULT_LOCK_TIMEOUT_MS = 1_000;

// A lock file older than this is assumed abandoned by a process that crashed or
// was killed between taking it and releasing it. Still four orders of magnitude
// above a real critical section, so it cannot describe a live holder -- but
// short enough that a crash does not leave every caller paying the full timeout
// for half a minute.
const STALE_LOCK_MS = 10_000;

const RETRY_INTERVAL_MS = 5;

/**
 * The same process tried to take a lock it already holds.
 *
 * O_EXCL cannot tell "someone else has it" from "I have it", so without this the
 * inner call waits on ITSELF for the whole timeout and then reports that another
 * process is holding the lock -- a confident wrong answer that points whoever is
 * debugging at the wrong machine. Nested critical sections are a design error
 * here regardless: the outer one is working from a snapshot the inner one is
 * about to invalidate.
 */
export class AoiHostStoreLockReentered extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(
      `the store lock at ${lockPath} is already held by THIS process. Store critical ` +
        'sections must not nest. Nothing was changed.',
    );
    this.name = 'AoiHostStoreLockReentered';
    this.lockPath = lockPath;
  }
}

// Locks this process is currently inside, by path.
const heldLocks = new Set<string>();

export class AoiHostStoreLockTimeout extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(
      `could not take the store lock at ${lockPath}; another process is holding it. ` +
        'Nothing was changed.',
    );
    this.name = 'AoiHostStoreLockTimeout';
    this.lockPath = lockPath;
  }
}

export function resolveAoiHostStoreLockPath(openroomHome: string, name: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, `${name}.lock`);
}

// Sleep without yielding to the event loop. The critical sections are
// synchronous by design -- making them async would reintroduce, inside one
// process, exactly the interleaving this prevents between processes.
function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

function isStale(lockPath: string, now: number, staleMs: number): boolean {
  try {
    return now - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch {
    // It vanished between the failed create and this stat: not stale, just gone.
    return false;
  }
}

/**
 * Run `fn` holding an exclusive lock named `name` under the host-bridge folder.
 *
 * `fn` must be synchronous. An async body would release the lock at its first
 * await while the rest of the work still ran, which is worse than no lock: it
 * would look protected.
 */
export function withAoiHostStoreLock<T>(
  openroomHome: string,
  name: string,
  fn: () => T,
  options: {
    timeoutMs?: number;
    staleMs?: number;
    now?: () => number;
  } = {},
): T {
  const lockPath = resolveAoiHostStoreLockPath(openroomHome, name);
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? STALE_LOCK_MS;
  const deadline = now() + timeoutMs;

  if (heldLocks.has(lockPath)) {
    throw new AoiHostStoreLockReentered(lockPath);
  }

  fs.mkdirSync(dirname(lockPath), { recursive: true });

  let handle: number | null = null;
  for (;;) {
    try {
      // 'wx' fails if the file exists. That check-and-create is one atomic
      // operation in the filesystem, which is the whole point -- doing it as
      // existsSync-then-write would have the race it is meant to remove.
      handle = fs.openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (isStale(lockPath, now(), staleMs)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Someone else reclaimed it first; go round again.
        }
        continue;
      }
      if (now() >= deadline) {
        throw new AoiHostStoreLockTimeout(lockPath);
      }
      sleepSync(RETRY_INTERVAL_MS);
    }
  }

  heldLocks.add(lockPath);
  try {
    // Who holds it, for anyone looking at a stuck lock on disk.
    fs.writeSync(handle, `${process.pid}\n`);
    return fn();
  } finally {
    heldLocks.delete(lockPath);
    try {
      fs.closeSync(handle);
    } catch {
      // best-effort
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Already reclaimed as stale by someone else.
    }
  }
}
