import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';

import {
  AOI_MAX_HOST_PROCESS_RECORDS,
  listHostProcesses,
  parsePosixPsOutput,
  parseWindowsTasklistCsv,
  summarizeHostProcesses,
  type AoiHostProcessRecord,
} from '../aoiHostProcessInspect';

const TASKLIST_SAMPLE = [
  '"System Idle Process","0","Services","0","8 K"',
  '"chrome.exe","1234","Console","1","123,456 K"',
  '"chrome.exe","1240","Console","1","98,000 K"',
  '"Tavern.exe","4200","Console","1","55,120 K"',
  '"","","","",""',
].join('\r\n');

describe('parseWindowsTasklistCsv', () => {
  it('parses metadata-only records and skips blank rows', () => {
    const records = parseWindowsTasklistCsv(TASKLIST_SAMPLE);
    // pid 0 (System Idle Process) is filtered (pid <= 0), so the first real
    // record is chrome 1234 and the trailing blank row is dropped.
    expect(records.map((r) => r.pid)).toEqual([1234, 1240, 4200]);
    expect(records[0]).toEqual({
      pid: 1234,
      imageName: 'chrome.exe',
      sessionName: 'Console',
      memKb: 123456,
    });
  });

  it('never produces a command-line field (structural metadata-only)', () => {
    const records = parseWindowsTasklistCsv(TASKLIST_SAMPLE);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(expect.arrayContaining(['imageName', 'pid']));
      expect('commandLine' in record).toBe(false);
      expect('cmdline' in record).toBe(false);
    }
  });

  it('caps the record count', () => {
    const many = Array.from(
      { length: AOI_MAX_HOST_PROCESS_RECORDS + 50 },
      (_unused, index) => `"app${index}.exe","${index + 1}","Console","1","1 K"`,
    ).join('\r\n');
    expect(parseWindowsTasklistCsv(many)).toHaveLength(AOI_MAX_HOST_PROCESS_RECORDS);
  });
});

describe('parsePosixPsOutput', () => {
  it('takes pid + final path segment as the image name only', () => {
    const records = parsePosixPsOutput(
      ['  1 systemd', ' 4200 /usr/bin/Tavern', 'bad line', ' 55 node'].join('\n'),
    );
    expect(records).toEqual([
      { pid: 1, imageName: 'systemd' },
      { pid: 4200, imageName: 'Tavern' },
      { pid: 55, imageName: 'node' },
    ]);
  });
});

describe('summarizeHostProcesses', () => {
  it('ranks image names by instance count', () => {
    const records: AoiHostProcessRecord[] = [
      { pid: 1, imageName: 'chrome.exe' },
      { pid: 2, imageName: 'chrome.exe' },
      { pid: 3, imageName: 'code.exe' },
    ];
    const summary = summarizeHostProcesses(records, 1000);
    expect(summary.totalCount).toBe(3);
    expect(summary.distinctImageCount).toBe(2);
    expect(summary.topImages[0]).toEqual({ imageName: 'chrome.exe', count: 2 });
  });
});

// Minimal fake child process for the spawn orchestration test.
function makeFakeChild(
  stdout: string,
  exitCode: number,
): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  setTimeout(() => {
    child.stdout.emit('data', stdout);
    child.emit('close', exitCode);
  }, 0);
  return child;
}

describe('listHostProcesses', () => {
  it('spawns a fixed read-only command and returns a parsed listing', async () => {
    const calls: Array<{ program: string; args: string[]; shell: unknown }> = [];
    const fakeSpawn = ((program: string, args: string[], opts: { shell?: boolean }) => {
      calls.push({ program, args, shell: opts.shell });
      return makeFakeChild(TASKLIST_SAMPLE, 0);
    }) as unknown as typeof import('child_process').spawn;

    const listing = await listHostProcesses({ platform: 'win32', now: 5000, spawnImpl: fakeSpawn });

    // Fixed argv, never a shell -- cannot become an exec channel.
    expect(calls).toEqual([{ program: 'tasklist', args: ['/FO', 'CSV', '/NH'], shell: false }]);
    expect(listing.sampledAt).toBe(5000);
    expect(listing.records.map((r) => r.pid)).toEqual([1234, 1240, 4200]);
    expect(listing.summary.totalCount).toBe(3);
  });

  it('rejects on a non-zero exit', async () => {
    const fakeSpawn = (() =>
      makeFakeChild('', 1)) as unknown as typeof import('child_process').spawn;
    await expect(listHostProcesses({ platform: 'win32', spawnImpl: fakeSpawn })).rejects.toThrow(
      /exited with code 1/,
    );
  });
});
