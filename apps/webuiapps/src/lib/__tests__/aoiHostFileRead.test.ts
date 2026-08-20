import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  addAoiHostReadRoot,
  isAoiPathInsideRoot,
  listAoiHostDirectory,
  loadAoiHostReadRoots,
  normalizeAoiHostReadRoots,
  readAoiHostFileContent,
  removeAoiHostReadRoot,
  resolveAoiHostReadTarget,
  saveAoiHostReadRoots,
  statAoiHostPath,
  type AoiHostReadRoot,
} from '../aoiHostFileRead';

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('isAoiPathInsideRoot', () => {
  it('accepts a path at or below the root and rejects escapes', () => {
    expect(isAoiPathInsideRoot('C:\\work', 'C:\\work\\sub\\file.txt')).toBe(true);
    expect(isAoiPathInsideRoot('C:\\work', 'C:\\work')).toBe(true);
    expect(isAoiPathInsideRoot('C:\\work', 'C:\\other\\file.txt')).toBe(false);
    expect(isAoiPathInsideRoot('/home/u/work', '/home/u/work/../secret')).toBe(false);
  });
});

describe('read-roots management', () => {
  it('adds absolute roots, rejects relative ids/paths, dedupes, and removes', () => {
    const abs = makeTempDir('aoi-root-');
    let config = addAoiHostReadRoot(null, { id: 'work', label: 'Work', path: abs }, 1).config;
    expect(config.roots).toHaveLength(1);
    expect(addAoiHostReadRoot(config, { id: 'x', path: 'relative/dir' }, 2).reason).toBe(
      'invalid_path',
    );
    expect(addAoiHostReadRoot(config, { id: 'Bad Id', path: abs }, 2).reason).toBe('invalid_id');
    // Same id replaces, not duplicates.
    config = addAoiHostReadRoot(config, { id: 'work', path: abs }, 3).config;
    expect(config.roots).toHaveLength(1);
    config = removeAoiHostReadRoot(config, 'work', 4);
    expect(config.roots).toHaveLength(0);
  });

  it('normalizes away malformed roots', () => {
    const abs = makeTempDir('aoi-root-');
    const normalized = normalizeAoiHostReadRoots({
      version: 1,
      roots: [{ id: 'ok', path: abs }, { id: 'rel', path: 'x/y' }, 'garbage'],
      updatedAt: 9,
    });
    expect(normalized.roots.map((r) => r.id)).toEqual(['ok']);
  });

  it('round-trips through disk and fails closed on a corrupt file', () => {
    const home = makeTempDir('aoi-home-');
    const abs = makeTempDir('aoi-root-');
    expect(loadAoiHostReadRoots(home).roots).toEqual([]);
    saveAoiHostReadRoots(home, addAoiHostReadRoot(null, { id: 'work', path: abs }, 1).config);
    expect(loadAoiHostReadRoots(home).roots.map((r) => r.id)).toEqual(['work']);
  });
});

describe('resolveAoiHostReadTarget (realpath escape guard)', () => {
  const roots: AoiHostReadRoot[] = [{ id: 'work', label: 'Work', path: 'C:\\work' }];

  it('accepts a target whose realpath stays inside a root realpath', () => {
    // Identity realpath: lexical containment holds.
    const result = resolveAoiHostReadTarget({
      roots,
      requestedPath: 'C:\\work\\sub\\a.txt',
      realpathImpl: (target) => target,
    });
    expect(result.ok).toBe(true);
    expect(result.rootId).toBe('work');
  });

  it('rejects a symlink/junction that resolves OUTSIDE the root', () => {
    // The requested path is lexically inside the root, but realpath points it
    // out (the classic symlink escape a lexical-only check would miss).
    const result = resolveAoiHostReadTarget({
      roots,
      requestedPath: 'C:\\work\\link',
      realpathImpl: (target) => (target === 'C:\\work\\link' ? 'C:\\secret\\stolen.txt' : target),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('outside_consent_roots');
  });

  it('rejects relative, missing, and no-roots cases', () => {
    expect(resolveAoiHostReadTarget({ roots, requestedPath: 'relative\\x' }).reason).toBe(
      'path_not_absolute',
    );
    expect(resolveAoiHostReadTarget({ roots, requestedPath: '' }).reason).toBe('missing_path');
    expect(resolveAoiHostReadTarget({ roots: [], requestedPath: 'C:\\work\\a.txt' }).reason).toBe(
      'no_consent_roots',
    );
  });

  it('reports not_found when realpath throws (nonexistent target)', () => {
    const result = resolveAoiHostReadTarget({
      roots,
      requestedPath: 'C:\\work\\ghost.txt',
      realpathImpl: () => {
        throw new Error('ENOENT');
      },
    });
    expect(result.reason).toBe('not_found');
  });
});

describe('read operations over a real temp root', () => {
  function seedRoot(): { root: AoiHostReadRoot; dir: string } {
    const dir = makeTempDir('aoi-readroot-');
    fs.writeFileSync(join(dir, 'note.txt'), 'hello world', 'utf-8');
    fs.mkdirSync(join(dir, 'sub'));
    // Use the realpathed dir as the root path so containment holds on macOS/Windows
    // where the temp dir itself may be a symlink.
    const real = fs.realpathSync.native(dir);
    return { root: { id: 'r', label: 'r', path: real }, dir: real };
  }

  it('lists directory metadata (names + kind + size), never content', () => {
    const { root, dir } = seedRoot();
    const listing = listAoiHostDirectory({ roots: [root], requestedPath: dir });
    expect(listing.ok).toBe(true);
    const note = listing.entries.find((e) => e.name === 'note.txt');
    expect(note?.kind).toBe('file');
    expect(note?.size).toBe(11);
    expect(listing.entries.find((e) => e.name === 'sub')?.kind).toBe('directory');
    // A listing entry never carries file content.
    expect(note && 'content' in note).toBe(false);
  });

  it('stats a file inside a root and refuses a path outside every root', () => {
    const { root, dir } = seedRoot();
    const stat = statAoiHostPath({ roots: [root], requestedPath: join(dir, 'note.txt') });
    expect(stat.ok).toBe(true);
    expect(stat.kind).toBe('file');
    expect(stat.size).toBe(11);

    const outside = makeTempDir('aoi-outside-');
    fs.writeFileSync(join(outside, 'secret.txt'), 'nope', 'utf-8');
    const denied = statAoiHostPath({
      roots: [root],
      requestedPath: join(fs.realpathSync.native(outside), 'secret.txt'),
    });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe('outside_consent_roots');
  });

  it('reads file content inside a root and caps it', () => {
    const { root, dir } = seedRoot();
    const full = readAoiHostFileContent({ roots: [root], requestedPath: join(dir, 'note.txt') });
    expect(full.ok).toBe(true);
    expect(full.content?.content).toBe('hello world');
    expect(full.content?.truncated).toBe(false);

    const capped = readAoiHostFileContent({
      roots: [root],
      requestedPath: join(dir, 'note.txt'),
      maxBytes: 5,
    });
    expect(capped.content?.content).toBe('hello');
    expect(capped.content?.truncated).toBe(true);
    expect(capped.content?.byteLength).toBe(11);
  });

  it('refuses to read a directory as a file', () => {
    const { root, dir } = seedRoot();
    const result = readAoiHostFileContent({ roots: [root], requestedPath: join(dir, 'sub') });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_a_file');
  });
});

// Read roots bound WHICH FILES Aoi may open. A junction planted inside a root --
// creatable on Windows without administrator -- makes any file on the machine
// spell out as if it were inside. The upload gate had exactly this hole; these
// pin that the filesystem doors do not.
describe('a junction inside a read root', () => {
  function withJunction(): { root: string; secret: string } | null {
    const base = fs.mkdtempSync(join(os.tmpdir(), 'aoi-fs-junction-'));
    tempRoots.push(base);
    const root = join(base, 'safe');
    const secret = join(base, 'secret');
    fs.mkdirSync(root);
    fs.mkdirSync(secret);
    fs.writeFileSync(join(secret, 'id_rsa'), 'PRIVATE KEY');
    try {
      execFileSync('cmd', ['/c', 'mklink', '/J', join(root, 'out'), secret], { stdio: 'pipe' });
    } catch {
      return null;
    }
    return { root, secret };
  }

  it('cannot be read or listed through', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const made = withJunction();
    if (!made) {
      return;
    }
    const roots: AoiHostReadRoot[] = [{ id: 'safe', label: 'safe', path: made.root }];

    // Spelled inside the root, and a real file at the end of it.
    const escaped = join(made.root, 'out', 'id_rsa');
    expect(fs.lstatSync(escaped).isFile()).toBe(true);

    expect(readAoiHostFileContent({ roots, requestedPath: escaped }).ok).toBe(false);
    expect(listAoiHostDirectory({ roots, requestedPath: join(made.root, 'out') }).ok).toBe(false);
    expect(statAoiHostPath({ roots, requestedPath: escaped }).ok).toBe(false);

    // And a genuine file in the root still reads, so the bound is the escape
    // rather than the feature.
    fs.writeFileSync(join(made.root, 'notes.txt'), 'hello');
    expect(readAoiHostFileContent({ roots, requestedPath: join(made.root, 'notes.txt') }).ok).toBe(
      true,
    );
  });
});
