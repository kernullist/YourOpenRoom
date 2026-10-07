// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// renameSync is wrapped so a test can make Windows' "target is open in another
// process" refusal happen on demand; every other call goes to the real fs.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

import { writeFileAtomic } from '../sessionDataServer';

const dirs: string[] = [];

afterEach(() => {
  vi.mocked(fs.renameSync).mockReset();
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'aoi-atomic-'));
  dirs.push(dir);
  return dir;
}

function failRename(code: string): void {
  vi.mocked(fs.renameSync).mockImplementationOnce(() => {
    throw Object.assign(new Error(`rename refused (${code})`), { code });
  });
}

describe('writeFileAtomic when the rename is refused', () => {
  it.each(['EPERM', 'EBUSY', 'EACCES'])('falls back to a direct write on %s', (code) => {
    const dir = tempDir();
    const target = join(dir, 'chat.json');
    fs.writeFileSync(target, '{"old":true}');
    failRename(code);

    writeFileAtomic(target, '{"new":true}');

    // The save still lands, and the temp file does not pile up next to it.
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"new":true}');
    expect(fs.readdirSync(dir)).toEqual(['chat.json']);
  });

  it('rethrows any other rename error and leaves the old file alone', () => {
    const dir = tempDir();
    const target = join(dir, 'chat.json');
    fs.writeFileSync(target, '{"old":true}');
    failRename('EXDEV');

    expect(() => writeFileAtomic(target, '{"new":true}')).toThrow(/EXDEV/);
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"old":true}');
    expect(fs.readdirSync(dir)).toEqual(['chat.json']);
  });
});
