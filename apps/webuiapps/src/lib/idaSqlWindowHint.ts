// Where did the IDA window go, and how do we make the operator notice it?
//
// A GUI session launches IDA detached, which means IDA's window opens BEHIND
// whatever had focus. Measured on a real desktop, from a background process:
//
//   SetForegroundWindow      -> false, window not raised
//   SetWindowPos(HWND_TOP)   -> returns true, z-order unchanged
//   FlashWindowEx            -> true, taskbar button flashes
//
// Windows' foreground lock is doing its job: a process that does not own the
// foreground cannot take it, and the dev server never does. So this module does
// NOT try to raise or focus the window -- that would be a promise the OS refuses
// to keep. It does the two things that do work: flash the taskbar button, which
// is the sanctioned way to ask for attention, and report where the window
// actually is, because "on your second monitor at x=3594" is the whole answer
// when the operator says they cannot see it.
//
// Server-only: child_process.
import { spawn } from 'child_process';

export interface IdaWindowHint {
  /** Did we find a top-level window for that pid? */
  found: boolean;
  /** Taskbar button flashed, so the operator has something to look for. */
  flashed: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  title: string;
  /** True when the window sits outside the primary monitor's bounds. */
  offPrimaryMonitor: boolean;
  /** Why the hint is empty, when it is. */
  reason: string;
}

export type IdaWindowHintSpawn = (
  program: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => {
  onStdout(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
};

// Above the helper's own 10s window wait, so a timeout here means PowerShell
// itself is wedged rather than the window simply being slow.
const HINT_TIMEOUT_MS = 14_000;

function emptyHint(reason: string): IdaWindowHint {
  return {
    found: false,
    flashed: false,
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    title: '',
    offPrimaryMonitor: false,
    reason,
  };
}

// Kept as one literal rather than assembled from parts: this is passed to
// PowerShell -Command, and every interpolation into it would be an injection
// site. The only value that varies is the pid, which is checked to be a positive
// integer before it gets anywhere near here.
const HINT_SCRIPT = `
$ErrorActionPreference = 'Stop'
# Force UTF-8 out. Without this PowerShell writes in the console's ANSI codepage
# (CP949 on this machine), and we decode as UTF-8 -- a window title of 문자표
# arrived as ����ǥ. IDA's title carries the binary path, so any non-ASCII path
# would reach the operator mangled.
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class IdaHint
{
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO info);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  public static string Title(IntPtr h) { var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256); return sb.ToString(); }
  public static bool Flash(IntPtr h)
  {
    FLASHWINFO info = new FLASHWINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
    info.hwnd = h;
    info.dwFlags = 3 | 12;
    info.uCount = 6;
    info.dwTimeout = 0;
    return FlashWindowEx(ref info);
  }
}
'@
# Wait for the window, do not sample once.
#
# Measured: IDA gets a MainWindowHandle about 3s after spawn (its first window is
# usually the "what do I do with the existing database" prompt). Sampling
# immediately made this a race against PowerShell's own startup -- found on a
# slow start, missed on a fast one, which is how a feature comes to work only on
# the machine it was written on.
$h = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Id $env:IDA_HINT_PID -ErrorAction SilentlyContinue
  if (-not $p) { break }
  $p.Refresh()
  if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $h = $p.MainWindowHandle; break }
  Start-Sleep -Milliseconds 400
}
if ($h -eq [IntPtr]::Zero) { Write-Output '{"found":false}'; exit 0 }
$r = New-Object IdaHint+RECT
[void][IdaHint]::GetWindowRect($h, [ref]$r)
$flashed = [IdaHint]::Flash($h)
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$offPrimary = $false
if ($screen) { $offPrimary = ($r.Left -lt 0) -or ($r.Top -lt 0) -or ($r.Left -ge $screen.Bounds.Width) -or ($r.Top -ge $screen.Bounds.Height) }
@{
  found = $true
  flashed = [bool]$flashed
  left = $r.Left
  top = $r.Top
  width = ($r.Right - $r.Left)
  height = ($r.Bottom - $r.Top)
  title = [IdaHint]::Title($h)
  offPrimaryMonitor = [bool]$offPrimary
} | ConvertTo-Json -Compress
`;

function nodeHintSpawn(
  program: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) {
  const child = spawn(program, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, ...env },
  });
  return {
    onStdout(listener: (chunk: string) => void): void {
      child.stdout?.on('data', (chunk: Buffer) => listener(chunk.toString('utf-8')));
    },
    onExit(listener: (code: number | null) => void): void {
      child.on('exit', (code) => listener(code ?? null));
      child.on('error', () => listener(null));
    },
    kill(): void {
      child.kill();
    },
  };
}

// Last hint per pid, so the one PowerShell run the launch fires can be READ
// later by the UI without spawning another. Bounded two ways: by count, because a
// dev server that ran for a week would otherwise hold one entry per IDA ever
// launched, and by AGE, because the OS recycles pids -- an entry kept forever
// would eventually describe a different process's window as if it were IDA's.
// The UI only reads this in the minute after a launch, so a short life costs
// nothing.
const MAX_REMEMBERED_HINTS = 16;
const REMEMBERED_HINT_TTL_MS = 5 * 60 * 1000;
const rememberedHints = new Map<number, { hint: IdaWindowHint; at: number }>();

function rememberHint(pid: number, hint: IdaWindowHint, at: number): void {
  rememberedHints.delete(pid);
  rememberedHints.set(pid, { hint, at });
  while (rememberedHints.size > MAX_REMEMBERED_HINTS) {
    const oldest = rememberedHints.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    rememberedHints.delete(oldest);
  }
}

/** What the last describeIdaWindow for this pid found, if it has finished. */
export function recallIdaWindow(pid: number, now: number = Date.now()): IdaWindowHint | null {
  const entry = rememberedHints.get(pid);
  if (!entry) {
    return null;
  }
  // A clock that moved backwards should not resurrect an entry either, so treat
  // a future stamp as current rather than as impossibly old.
  const age = now - entry.at;
  if (age >= REMEMBERED_HINT_TTL_MS) {
    rememberedHints.delete(pid);
    return null;
  }
  return entry.hint;
}

/** Test seam. */
export function forgetIdaWindows(): void {
  rememberedHints.clear();
}

/**
 * Best-effort: flash the window belonging to `pid` and report where it is.
 *
 * Never throws and never blocks past HINT_TIMEOUT_MS. A GUI launch must not fail
 * because a cosmetic hint did, so every failure path returns an empty hint with
 * a reason rather than propagating. The result is remembered so a later read does
 * not have to spawn PowerShell again.
 */
export async function describeIdaWindow(
  pid: number,
  spawnHint: IdaWindowHintSpawn = nodeHintSpawn,
): Promise<IdaWindowHint> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return emptyHint('no_pid');
  }
  if (process.platform !== 'win32') {
    // The whole mechanism is Win32. Elsewhere there is nothing honest to say.
    return emptyHint('not_windows');
  }
  // The pid travels in this child's OWN environment, not spliced into the script
  // text (no interpolation into a shell string) and not through process.env
  // (which is shared: two GUI launches at once would overwrite each other's pid,
  // and the variable would outlive the call).
  const childEnv = { IDA_HINT_PID: String(pid) };
  return await new Promise<IdaWindowHint>((resolveHint) => {
    let output = '';
    let settled = false;
    const finish = (hint: IdaWindowHint): void => {
      if (!settled) {
        settled = true;
        rememberHint(pid, hint, Date.now());
        resolveHint(hint);
      }
    };
    let child: ReturnType<IdaWindowHintSpawn>;
    try {
      child = spawnHint(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Add-Type -AssemblyName System.Windows.Forms; ${HINT_SCRIPT}`,
        ],
        childEnv,
      );
    } catch {
      finish(emptyHint('spawn_failed'));
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish(emptyHint('timeout'));
    }, HINT_TIMEOUT_MS);
    child.onStdout((chunk) => {
      output += chunk;
    });
    child.onExit(() => {
      clearTimeout(timer);
      finish(parseIdaWindowHint(output));
    });
  });
}

/** Exported for the tests: turn the helper's JSON into a hint, or an empty one. */
export function parseIdaWindowHint(raw: string): IdaWindowHint {
  const trimmed = raw.trim();
  if (!trimmed) {
    return emptyHint('no_output');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return emptyHint('unparseable_output');
  }
  if (!parsed || typeof parsed !== 'object') {
    return emptyHint('unparseable_output');
  }
  const value = parsed as Record<string, unknown>;
  if (value.found !== true) {
    return emptyHint('no_window');
  }
  const asNumber = (field: unknown): number =>
    typeof field === 'number' && Number.isFinite(field) ? Math.round(field) : 0;
  return {
    found: true,
    flashed: value.flashed === true,
    left: asNumber(value.left),
    top: asNumber(value.top),
    width: asNumber(value.width),
    height: asNumber(value.height),
    title: typeof value.title === 'string' ? value.title.slice(0, 120) : '',
    offPrimaryMonitor: value.offPrimaryMonitor === true,
    reason: '',
  };
}

/**
 * One sentence for the operator about a window they said they cannot see.
 *
 * Deliberately never claims the window was raised or focused: measured, the OS
 * refuses both from a background process. What it can promise is the flash and
 * the coordinates.
 */
export function describeIdaWindowForOperator(hint: IdaWindowHint): string {
  if (!hint.found) {
    return hint.reason === 'no_window'
      ? 'IDA has not drawn its window yet. It usually takes a few seconds, and a database that already exists makes it ask a question first.'
      : '';
  }
  const parts: string[] = [];
  if (hint.flashed) {
    parts.push('Its taskbar button is flashing');
  } else {
    parts.push('Its window is open');
  }
  if (hint.offPrimaryMonitor) {
    parts.push(`and it opened on another monitor at ${hint.left},${hint.top}`);
  } else {
    parts.push(`at ${hint.left},${hint.top}`);
  }
  if (hint.title) {
    parts.push(`with the title "${hint.title}"`);
  }
  // Say why it is not simply in front, so the operator does not wait for it.
  return `${parts.join(' ')}. Windows does not let a background launcher take the foreground, so it will not come to the front on its own -- click the taskbar button or Alt+Tab to it.`;
}
