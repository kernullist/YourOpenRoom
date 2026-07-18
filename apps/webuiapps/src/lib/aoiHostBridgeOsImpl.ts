// Aoi host-bridge OS implementations (wiring slice 4): the real, effectful
// process-read / kill / recycle-bin operations the daemon injects into the pure
// runners (runAoiHostKill, runAoiHostFileDelete). Kept in one thin, replaceable
// module so the runners stay pure/testable and the actual OS calls live behind
// a single boundary.
//
// Windows-first (tasklist / taskkill / PowerShell Recycle-Bin). On non-Windows
// hosts the fallbacks use ps / process.kill / fs.rmSync-to-trash-less semantics
// are NOT provided (recycle is a no-op that returns false) -- the host-bridge is
// designed for the operator's Windows PC.
//
// Server-only (child_process / fs). These are the injected seams; the gate,
// TOCTOU, and approval checks all run in the pure runners before these are ever
// reached.
import { spawnSync } from 'child_process';
import type { AoiHostLiveProcess } from './aoiHostProcessKill';

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

// Re-read a process by pid for the kill TOCTOU check. Returns { imageName,
// startTime } or null when the pid is gone. Windows: tasklist /V gives the image
// name; the CSV verbose form includes the window title but NOT a start time, so
// the TOCTOU identity here is (pid -> image). The image match already rejects a
// pid reused by a different program; a start-time source can be layered later.
export function readAoiHostProcessByPid(pid: number): AoiHostLiveProcess | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === 'win32') {
    const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      encoding: 'utf-8',
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      return null;
    }
    const line = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (!line || line.startsWith('INFO:')) {
      // tasklist prints "INFO: No tasks..." to stdout when the pid is gone.
      return null;
    }
    const fields = splitCsvLine(line);
    const imageName = (fields[0] || '').trim();
    const livePid = Number.parseInt((fields[1] || '').replace(/[^0-9]/g, ''), 10);
    if (!imageName || livePid !== pid) {
      return null;
    }
    return { imageName };
  }
  // POSIX fallback: ps -p <pid> -o comm=.
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], {
    windowsHide: true,
    encoding: 'utf-8',
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }
  const name = result.stdout.trim().split(/[\\/]/).pop();
  return name ? { imageName: name } : null;
}

// Terminate a pid. Windows: taskkill /PID <pid> /F (fixed argv, no shell).
// Returns true on a clean exit. The pure runner has already confirmed the pid is
// killable + approved + still hosts the pinned image (TOCTOU).
export function killAoiHostProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/F'], {
      windowsHide: true,
      encoding: 'utf-8',
    });
    return result.status === 0;
  }
  try {
    return process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
}

// Move a file to the Recycle Bin (the ONLY delete path). Windows: PowerShell +
// Microsoft.VisualBasic FileSystem.DeleteFile with the RecycleBin option, so the
// file is recoverable. Fixed argv; the path is passed as a single argument (no
// shell interpolation). Returns true on a clean exit.
export function recycleAoiHostFile(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) {
    return false;
  }
  if (process.platform !== 'win32') {
    // Recycle semantics are a Windows concept; refuse elsewhere rather than
    // permanently delete (the design forbids a permanent-delete path).
    return false;
  }
  // -LiteralPath avoids glob/wildcard interpretation; the VisualBasic call sends
  // the file to the Recycle Bin (OnlyErrorDialogs, DeleteToRecycleBin, DoNothing).
  const script =
    'param([string]$p)' +
    'Add-Type -AssemblyName Microsoft.VisualBasic;' +
    '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(' +
    '$p,' +
    "'OnlyErrorDialogs','SendToRecycleBin','ThrowException')";
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script, path],
    { windowsHide: true, encoding: 'utf-8' },
  );
  return result.status === 0;
}
